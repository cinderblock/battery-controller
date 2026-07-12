/**
 * Cycle runner — server-side multi-step test orchestrator.
 *
 * Accepts a sequence of steps (discharge, charge, wait, loop) and
 * executes them in order by sending commands to the DeviceSession.
 * Watches for step completion (device returns to idle/complete) and
 * automatically starts the next step.
 *
 * Cycle state persists to SQLite so it can resume after Pi reboots.
 */

import { type FieldBindings, resolveSteps, type SequenceVariable } from '../shared/sequence-vars.ts';
import { logger } from '../utils/logger.ts';
import {
  type CycleProgram,
  createCycleProgram,
  getActiveCycleProgram,
  getCellById,
  getCellGroup,
  getCycleStepRun,
  getRunsForCycleProgram,
  parseUtcTimestamp,
  setRunExcludeFromCapacity,
  updateCycleProgram,
} from './db.ts';
import type { DeviceMode, DeviceSession, SessionEvent } from './device-session.ts';
import type { TestRecorder } from './test-recorder.ts';

// ── Step types (mirror frontend sequence-types.ts) ─────────────────

export interface StepDCC {
  type: 'd-cc';
  currentA: number;
  cutoffV: number;
  maxTimeMin?: number;
  useCRate?: boolean;
  excludeFromCount?: boolean;
  bind?: FieldBindings;
  /** Retry at half current (down to minA) when the cutoff trips instantly */
  backoff?: { minA: number };
}

export interface StepDCP {
  type: 'd-cp';
  powerW: number;
  cutoffV: number;
  maxTimeMin?: number;
  excludeFromCount?: boolean;
  bind?: FieldBindings;
}

export interface StepCCV {
  type: 'c-cv';
  currentA: number;
  targetV: number;
  cutoffCurrentA: number;
  maxTimeMin?: number;
  useCRate?: boolean;
  excludeFromCount?: boolean;
  bind?: FieldBindings;
}

export interface StepWait {
  type: 'wait';
  durationS: number;
  excludeFromCount?: boolean;
}

export interface StepLoop {
  type: 'loop';
  count: number;
  children: CycleStep[];
}

export type CycleStep = StepDCC | StepDCP | StepCCV | StepWait | StepLoop;

// ── Discharge auto-backoff ─────────────────────────────────────────

/** A run this short with this little capacity is an IR-sag trip, not a real discharge */
const BACKOFF_TRIP_MAX_S = 30;
const BACKOFF_TRIP_MAX_MAH = 100;
/**
 * End reasons a device-side voltage cutoff can produce. The EBC reports
 * a cutoff trip by returning to idle, which the recorder logs as
 * 'manual_stop' (confirmed on real trip runs); 'complete' covers devices
 * that signal completion. Host-initiated stops (time_limit, temp_alert,
 * step_ended_early) must NOT trigger a retry.
 */
const BACKOFF_END_REASONS = new Set(['manual_stop', 'complete']);

/**
 * Decide the reduced current for a backoff retry, or null when the step
 * should advance normally (real discharge, host-initiated stop, or the
 * current is already at/below the floor). Halves the current per retry,
 * floored at minA.
 */
export function nextBackoffCurrentA(
  run: { end_reason: string | null; duration_s: number | null; final_capacity_mah: number | null } | null,
  currentA: number,
  minA: number
): number | null {
  if (!run || run.end_reason === null || !BACKOFF_END_REASONS.has(run.end_reason)) return null;
  if ((run.duration_s ?? Number.POSITIVE_INFINITY) >= BACKOFF_TRIP_MAX_S) return null;
  if ((run.final_capacity_mah ?? Number.POSITIVE_INFINITY) >= BACKOFF_TRIP_MAX_MAH) return null;
  if (!(minA > 0) || currentA <= minA + 1e-9) return null;
  return Math.max(minA, currentA / 2);
}

/** Short parameter summary for a step, for timeline labels */
function stepParamLabel(step: StepDCC | StepDCP | StepCCV | StepWait): string {
  switch (step.type) {
    case 'd-cc':
      return `${step.currentA}A ${step.cutoffV}V`;
    case 'd-cp':
      return `${step.powerW}W ${step.cutoffV}V`;
    case 'c-cv':
      return `${step.currentA}A ${step.targetV}V ${step.cutoffCurrentA}A`;
    case 'wait': {
      const s = step.durationS;
      if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return m > 0 ? `${h}h${m}m` : `${h}h`;
      }
      return `${Math.floor(s / 60)}m`;
    }
  }
}

// ── V1 migration ──────────────────────────────────────────────────

interface V1Loop {
  type: 'loop';
  count: number;
  startIndex: number;
  endIndex: number;
}

function isV1Loop(step: any): step is V1Loop {
  return step?.type === 'loop' && 'startIndex' in step && !('children' in step);
}

function migrateV1Steps(steps: any[]): CycleStep[] {
  const hasV1Loops = steps.some(isV1Loop);
  if (!hasV1Loops) return steps as CycleStep[];

  const execSteps: CycleStep[] = [];
  const loops: V1Loop[] = [];

  for (const step of steps) {
    if (isV1Loop(step)) {
      loops.push(step);
    } else {
      execSteps.push(step as CycleStep);
    }
  }

  if (loops.length === 0) return execSteps;

  const loop = loops[0];
  const before = execSteps.slice(0, loop.startIndex);
  const inside = execSteps.slice(loop.startIndex, loop.endIndex + 1);
  const after = execSteps.slice(loop.endIndex + 1);

  return [...before, { type: 'loop', count: loop.count, children: inside }, ...after];
}

// ── CycleState ─────────────────────────────────────────────────────

export type CycleStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'aborted' | 'error';

export interface CycleState {
  status: CycleStatus;
  programId: number | null;
  programName: string | null;
  /** Display name (label or barcode/serial) of the cell under test */
  cellName: string | null;
  /** Flat execution index (position in the expanded step list) */
  currentExecIndex: number;
  totalExecSteps: number;
  /** Current cycle number for display (which loop iteration) */
  currentCycle: number;
  totalCycles: number;
  /** Wait timer info */
  waitEndTime: number | null;
  /** Step types in the flattened exec plan, for UI timeline rendering */
  execStepTypes: string[];
  /** Final capacity (mAh) for each completed step, null if not yet done or n/a */
  stepCapacities: (number | null)[];
  /** Actual wall-clock duration (seconds) for completed steps */
  stepDurations: (number | null)[];
  /** Expected duration (seconds) per step, for proportional timeline widths */
  stepExpectedS: number[];
  /** Short parameter summary per step (e.g. "40A 2.8V", "3.8V 2A", "30m") */
  stepLabels: string[];
}

type CycleListener = (state: CycleState) => void;

// ── CycleRunner ────────────────────────────────────────────────────

export class CycleRunner {
  private listeners = new Set<CycleListener>();
  private unsubSession: (() => void) | null = null;

  // State
  private status: CycleStatus = 'idle';
  private programId: number | null = null;
  private programName: string | null = null;

  // Execution plan: steps expanded with loops flattened
  private execPlan: { step: StepDCC | StepDCP | StepCCV | StepWait; cycleNum: number }[] = [];
  private execIndex = 0;
  private totalCycles = 1;

  // Cell capacity for C-rate resolution
  private capacityAh = 200; // default

  // Display name (label or barcode) of the cell under test
  private cellName: string | null = null;

  // Wait timer
  private waitTimer: Timer | null = null;
  private waitEndTime: number | null = null;

  // True between a step completing and the deferred advance/backoff decision
  private advancePending = false;

  // Cached per-step metadata (updated as steps complete)
  private stepCapacities: (number | null)[] = [];
  private stepDurations: (number | null)[] = [];
  private stepExpectedS: number[] = [];

  constructor(
    private session: DeviceSession,
    private recorder: TestRecorder
  ) {}

  /** Start listening for device state changes */
  start(): void {
    this.unsubSession = this.session.on(event => this.onSessionEvent(event));

    // Check for an active cycle program from a previous session.
    // We must wait for the first device reading before resuming, so we
    // know the actual device state (isRunning). Without this, mode defaults
    // to 'idle' and we'd incorrectly skip/re-schedule steps.
    const active = getActiveCycleProgram();
    if (active) {
      logger.info(`Found active cycle program #${active.id} from previous session. Waiting for device state...`);

      // If device is already responsive (unlikely but possible), resume now
      if (this.session.isDeviceResponsive()) {
        this.resumeProgram(active);
      } else {
        // Wait for first reading event, then resume
        const unsub = this.session.on(event => {
          if (event.type === 'reading' || event.type === 'deviceResponsive') {
            unsub();
            logger.info(`Device state confirmed. Resuming cycle program #${active.id}...`);
            this.resumeProgram(active);
          }
        });
        // Safety timeout: if no reading arrives in 10s, resume anyway
        setTimeout(() => {
          unsub();
          if (this.status === 'idle' && this.programId === null) {
            logger.warn(`No device reading after 10s. Resuming cycle program #${active.id} anyway.`);
            this.resumeProgram(active);
          }
        }, 10_000);
      }
    }
  }

  /** Stop and clean up */
  stop(): void {
    this.unsubSession?.();
    this.clearWaitTimer();
  }

  /** Subscribe to cycle state changes */
  onStateChange(listener: CycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get current cycle state */
  getState(): CycleState {
    return {
      status: this.status,
      programId: this.programId,
      programName: this.programName,
      cellName: this.cellName,
      currentExecIndex: this.execIndex,
      totalExecSteps: this.execPlan.length,
      currentCycle: this.execPlan[this.execIndex]?.cycleNum ?? 0,
      totalCycles: this.totalCycles,
      waitEndTime: this.status === 'waiting' ? this.waitEndTime : null,
      execStepTypes: this.execPlan.map(e => e.step.type),
      stepCapacities: this.stepCapacities,
      stepDurations: this.stepDurations,
      stepExpectedS: this.stepExpectedS,
      stepLabels: this.execPlan.map(e => stepParamLabel(e.step)),
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (e) {
        logger.error('Cycle listener error:', e);
      }
    }
  }

  // ── Public commands ──────────────────────────────────────────

  /** Start running a sequence */
  async startSequence(
    name: string,
    steps: CycleStep[],
    cellId: number | null = null,
    variables: SequenceVariable[] = []
  ): Promise<void> {
    if (this.status === 'running' || this.status === 'waiting') {
      throw new Error('A cycle is already running');
    }

    if (this.session.isRunning()) {
      throw new Error('Device is already running a test');
    }

    // Migrate V1 format if needed, then bake variable values into the
    // steps — the program stores resolved numbers so resume and the
    // timeline endpoint never need to know about variables
    const migratedSteps = resolveSteps(migrateV1Steps(steps), variables);

    // Look up cell capacity for C-rate resolution
    this.resolveCapacity(cellId);

    // Point the recorder at this cell — otherwise runs are created with a
    // stale pendingCellId from a previous scan/program (runs 109-110 were
    // attributed to the prior cell this way)
    this.recorder.setCellId(cellId);

    // Flatten loops into a linear execution plan
    this.execPlan = this.flattenSteps(migratedSteps);
    if (this.execPlan.length === 0) {
      throw new Error('Sequence has no executable steps');
    }

    // Compute total cycles from loop steps
    this.totalCycles = this.computeTotalCycles(migratedSteps);

    // Create DB record
    const program = createCycleProgram(cellId, name, JSON.stringify(migratedSteps));
    updateCycleProgram(program.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    this.programId = program.id;
    this.programName = name;
    this.execIndex = 0;
    this.status = 'running';
    this.stepCapacities = new Array(this.execPlan.length).fill(null);
    this.stepDurations = new Array(this.execPlan.length).fill(null);
    this.stepExpectedS = this.computeExpectedDurations();

    logger.info(`Starting cycle "${name}" with ${this.execPlan.length} steps`);
    this.emit();

    // Start first step
    await this.executeCurrentStep(cellId);
  }

  /** Abort the running cycle */
  async abort(reason: string = 'manual'): Promise<void> {
    if (this.status !== 'running' && this.status !== 'waiting') return;

    // Set status first to prevent onSessionEvent from advancing
    this.status = 'aborted';

    this.clearWaitTimer();
    this.recorder.stopWaitRun(); // no-op if no wait run active

    if (this.session.isRunning()) {
      await this.session.stop(reason);
    }
    if (this.programId) {
      updateCycleProgram(this.programId, {
        status: 'aborted',
        ended_at: new Date().toISOString(),
        current_step: this.execIndex,
      });
    }

    logger.info(`Cycle aborted at step ${this.execIndex + 1}/${this.execPlan.length}`);
    this.emit();
    this.reset();
  }

  /**
   * End the current step early and advance to the next one.
   *
   * - Wait step: cancel the timer, finalize the wait run, advance now.
   * - Running test step: send stop; when the device idles, onSessionEvent
   *   advances exactly as it does for a natural step completion.
   *
   * Throws when the cycle is between steps (device settling) — skipping
   * mid-transition would race the queued executeCurrentStep call.
   */
  async endCurrentStep(): Promise<void> {
    if (this.status === 'waiting') {
      const { step } = this.execPlan[this.execIndex];
      const remainingS = this.waitEndTime ? Math.max(0, (this.waitEndTime - Date.now()) / 1000) : 0;
      const elapsedS = (step as StepWait).durationS - remainingS;

      this.clearWaitTimer();
      this.recorder.stopWaitRun();
      this.stepDurations[this.execIndex] = Math.round(elapsedS);
      logger.info(`Cycle step ${this.execIndex + 1} (wait) ended early after ${Math.round(elapsedS)}s`);

      this.execIndex++;
      this.status = 'running';
      this.emit();
      await this.executeCurrentStep();
      return;
    }

    if (this.status === 'running' && this.session.isRunning()) {
      logger.info(`Cycle step ${this.execIndex + 1} ending early (user request) — sending stop`);
      await this.session.stop('step_ended_early');
      return;
    }

    throw new Error('No step is currently running (cycle may be between steps)');
  }

  // ── Internal ─────────────────────────────────────────────────

  /** Resolve cell capacity for C-rate steps and cache the cell's display name */
  private resolveCapacity(cellId: number | null): void {
    this.cellName = null;
    if (cellId) {
      const cell = getCellById(cellId);
      if (cell) {
        this.cellName = cell.label || cell.barcode;
        // Use cell's own capacity, or look up from cell group
        if (cell.nominal_capacity_mah) {
          this.capacityAh = cell.nominal_capacity_mah / 1000;
        } else if (cell.cell_group_id) {
          const group = getCellGroup(cell.cell_group_id);
          if (group) this.capacityAh = group.nominal_capacity_mah / 1000;
        }
      }
    }
    logger.info(`C-rate resolution capacity: ${this.capacityAh} Ah (cell: ${this.cellName ?? 'none'})`);
  }

  /** Resolve a step's currentA to actual amps, handling C-rate */
  private resolveCurrentA(step: StepDCC | StepCCV): number {
    return step.useCRate ? step.currentA * this.capacityAh : step.currentA;
  }

  /** Compute max loop count for display */
  private computeTotalCycles(steps: CycleStep[]): number {
    let max = 1;
    for (const s of steps) {
      if (s.type === 'loop') {
        max = Math.max(max, s.count);
        // Check nested loops too (though unlikely)
        const nested = this.computeTotalCycles(s.children);
        max = Math.max(max, nested);
      }
    }
    return max;
  }

  /** Recursively flatten steps, expanding loops into linear execution plan */
  private flattenSteps(steps: CycleStep[]): { step: StepDCC | StepDCP | StepCCV | StepWait; cycleNum: number }[] {
    const plan: { step: StepDCC | StepDCP | StepCCV | StepWait; cycleNum: number }[] = [];

    for (const s of steps) {
      if (s.type === 'loop') {
        for (let cycle = 1; cycle <= s.count; cycle++) {
          // Recursively flatten children (handles nested loops)
          const childPlan = this.flattenSteps(s.children);
          for (const entry of childPlan) {
            plan.push({ step: entry.step, cycleNum: cycle });
          }
        }
      } else {
        plan.push({ step: s, cycleNum: 1 });
      }
    }

    return plan;
  }

  /** Compute expected duration (seconds) for each step in the exec plan */
  private computeExpectedDurations(): number[] {
    return this.execPlan.map(({ step }) => {
      if (step.type === 'wait') return step.durationS;
      // Use maxTimeMin if set, otherwise default estimate of 1 hour
      const maxMin = (step as { maxTimeMin?: number }).maxTimeMin;
      return maxMin ? maxMin * 60 : 3600;
    });
  }

  private async executeCurrentStep(cellId: number | null = null): Promise<void> {
    if (this.execIndex >= this.execPlan.length) {
      this.completeProgram();
      return;
    }

    const { step, cycleNum } = this.execPlan[this.execIndex];

    // Update DB progress
    if (this.programId) {
      updateCycleProgram(this.programId, {
        current_step: this.execIndex,
        current_cycle: cycleNum,
      });
    }

    // Set cycle metadata on the recorder for this step
    if (this.programId) {
      this.recorder.setCycleContext(this.programId, this.execIndex);
    }
    this.recorder.setExcludeFromCapacity(step.excludeFromCount ?? false);
    this.recorder.setCycleIteration(cycleNum);

    if (step.type === 'wait') {
      // Wait step: start recording readings, then set a timer
      this.status = 'waiting';
      this.waitEndTime = Date.now() + step.durationS * 1000;
      this.recorder.startWaitRun(step.durationS);
      logger.info(`Cycle step ${this.execIndex + 1}: waiting ${step.durationS}s`);
      this.emit();

      this.waitTimer = setTimeout(() => {
        this.recorder.stopWaitRun();
        this.stepDurations[this.execIndex] = step.durationS;
        this.waitEndTime = null;
        this.execIndex++;
        this.status = 'running';
        this.emit();
        this.executeCurrentStep(cellId);
      }, step.durationS * 1000);
      return;
    }

    // Executable step: set up recorder and send command
    this.status = 'running';
    this.emit();

    logger.info(`Cycle step ${this.execIndex + 1}: ${step.type} (cycle ${cycleNum})`);

    // Max-time enforcement happens inside DeviceSession (host-side watchdog,
    // restart-safe) — the start commands below just carry the limit through.
    switch (step.type) {
      case 'd-cc': {
        const actualCurrentA = this.resolveCurrentA(step);
        this.recorder.setSetpoints({
          currentA: actualCurrentA,
          cutoffV: step.cutoffV,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startDCC(actualCurrentA, step.cutoffV, step.maxTimeMin ?? 0);
        break;
      }
      case 'd-cp':
        this.recorder.setSetpoints({
          powerW: step.powerW,
          cutoffV: step.cutoffV,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startDCP(step.powerW, step.cutoffV, step.maxTimeMin ?? 0);
        break;
      case 'c-cv': {
        const actualCurrentA = this.resolveCurrentA(step);
        this.recorder.setSetpoints({
          currentA: actualCurrentA,
          voltageV: step.targetV,
          cutoffCurrentA: step.cutoffCurrentA,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startCCV(actualCurrentA, step.targetV, step.cutoffCurrentA, step.maxTimeMin ?? 0);
        break;
      }
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    if (this.status !== 'running') return;
    if (event.type !== 'stateChange') return;

    const { to } = event;
    const isIdle = to === 'idle' || to === 'complete';

    if (isIdle && this.execIndex < this.execPlan.length) {
      const currentStep = this.execPlan[this.execIndex].step;
      if (currentStep.type !== 'wait' && !this.advancePending) {
        this.advancePending = true;

        // Capture final capacity and duration from device before advancing
        const reading = this.session.getReading();
        if (reading.capacityMah > 0 && this.stepCapacities[this.execIndex] === null) {
          this.stepCapacities[this.execIndex] = reading.capacityMah;
        }
        if (reading.elapsedS > 0) {
          this.stepDurations[this.execIndex] = Math.round(reading.elapsedS);
        }

        logger.info(`Cycle step ${this.execIndex + 1} completed (device → ${to})`);
        this.emit(); // push updated capacities to frontend

        // Small delay before advancing: lets the device settle, and the
        // recorder (which subscribed after us, so it runs after this
        // handler) has finalized the run row by then — advanceAfterStep
        // needs it to decide whether to back off.
        setTimeout(() => this.advanceAfterStep(), 2000);
      }
    }
  }

  /** Advance past a completed test step, or retry it at reduced current */
  private advanceAfterStep(): void {
    this.advancePending = false;
    if (this.status !== 'running') return;

    if (this.tryBackoff()) return;

    this.recorder.clearCycleContext();
    this.execIndex++;
    this.emit();
    this.executeCurrentStep();
  }

  /**
   * When a backoff-enabled d-cc step tripped its cutoff instantly (voltage
   * sag from internal resistance at high current, not a truly empty cell),
   * exclude the junk run from capacity stats and retry the step at reduced
   * current. Returns true when a retry was started.
   */
  private tryBackoff(): boolean {
    const entry = this.execPlan[this.execIndex];
    const step = entry?.step;
    if (!step || step.type !== 'd-cc' || !step.backoff) return false;

    const run = this.programId !== null ? getCycleStepRun(this.programId, this.execIndex) : null;
    const currentA = this.resolveCurrentA(step);
    const nextA = nextBackoffCurrentA(run, currentA, step.backoff.minA);
    if (nextA === null) return false;

    if (run) setRunExcludeFromCapacity(run.id, true);
    this.stepCapacities[this.execIndex] = null;
    this.stepDurations[this.execIndex] = null;

    // Replace only this exec-plan entry — loop iterations share step
    // objects, and the next iteration should start back at the
    // programmed current (re-tripping costs only seconds)
    this.execPlan[this.execIndex] = {
      step: { ...step, currentA: nextA, useCRate: false },
      cycleNum: entry.cycleNum,
    };

    logger.info(
      `Cycle step ${this.execIndex + 1}: cutoff tripped instantly at ${currentA}A ` +
        `(run #${run?.id}, ${run?.duration_s?.toFixed(1)}s, ${run?.final_capacity_mah ?? 0} mAh) — retrying at ${nextA}A`
    );
    this.emit();
    this.executeCurrentStep();
    return true;
  }

  private completeProgram(): void {
    this.status = 'completed';
    if (this.programId) {
      updateCycleProgram(this.programId, {
        status: 'completed',
        ended_at: new Date().toISOString(),
        current_step: this.execPlan.length,
      });
    }
    logger.info(`Cycle "${this.programName}" completed (${this.execPlan.length} steps)`);
    this.emit();
    this.reset();
  }

  private resumeProgram(program: CycleProgram): void {
    try {
      const rawSteps = JSON.parse(program.steps_json);
      const steps = migrateV1Steps(rawSteps);
      this.execPlan = this.flattenSteps(steps);
      this.programId = program.id;
      this.programName = program.name;
      this.execIndex = program.current_step;

      // Resolve capacity for C-rate steps
      this.resolveCapacity(program.cell_id);

      this.totalCycles = this.computeTotalCycles(steps);

      // Restore step metadata from completed runs
      this.stepCapacities = new Array(this.execPlan.length).fill(null);
      this.stepDurations = new Array(this.execPlan.length).fill(null);
      this.stepExpectedS = this.computeExpectedDurations();
      const completedRuns = getRunsForCycleProgram(program.id);
      for (const run of completedRuns) {
        if (run.cycle_step_index != null) {
          if (run.final_capacity_mah != null && run.final_capacity_mah > 0) {
            this.stepCapacities[run.cycle_step_index] = run.final_capacity_mah;
          }
          if (run.duration_s != null) {
            this.stepDurations[run.cycle_step_index] = run.duration_s;
          }
        }
      }

      // Restore recorder state so any recovered run gets linked
      if (program.cell_id != null) {
        this.recorder.setCellId(program.cell_id);
      }
      this.recorder.setCycleContext(program.id, this.execIndex);

      // If device is running, we're mid-step — wait for completion
      if (this.session.isRunning()) {
        this.status = 'running';
        logger.info(`Cycle resumed mid-step at ${this.execIndex + 1}/${this.execPlan.length}`);
      } else if (this.execIndex < this.execPlan.length && this.execPlan[this.execIndex].step.type === 'wait') {
        // Device is idle and current step is a wait — check if the wait
        // period has elapsed or if we need to resume the remaining time.
        const waitStep = this.execPlan[this.execIndex].step as StepWait;
        const waitRun = getCycleStepRun(program.id, this.execIndex);
        const waitStartedAt = waitRun?.started_at ? parseUtcTimestamp(waitRun.started_at) : null;

        if (waitStartedAt) {
          const elapsedS = (Date.now() - waitStartedAt) / 1000;
          const remainingS = waitStep.durationS - elapsedS;

          // Sanity check: if remainingS > step duration (e.g., clock skew after
          // reboot before NTP sync), cap to the full step duration
          const cappedRemainingS =
            remainingS > waitStep.durationS
              ? (logger.warn(
                  `Wait remainingS (${Math.round(remainingS)}s) exceeds durationS (${waitStep.durationS}s) — clock skew? Capping.`
                ),
                waitStep.durationS)
              : remainingS;

          if (cappedRemainingS > 1) {
            // Resume the wait with remaining time
            this.status = 'waiting';
            this.waitEndTime = Date.now() + cappedRemainingS * 1000;
            logger.info(
              `Cycle resuming wait step ${this.execIndex + 1} with ${Math.round(cappedRemainingS)}s remaining (elapsed=${Math.round(elapsedS)}s, duration=${waitStep.durationS}s)`
            );

            this.waitTimer = setTimeout(() => {
              this.recorder.stopWaitRun();
              this.waitEndTime = null;
              this.execIndex++;
              this.status = 'running';
              this.emit();
              this.executeCurrentStep();
            }, cappedRemainingS * 1000);
          } else {
            // Wait already elapsed — advance to next step
            this.recorder.stopWaitRun();
            logger.info(`Cycle wait step ${this.execIndex + 1} already elapsed, advancing`);
            this.status = 'running';
            this.execIndex++;
            if (this.execIndex < this.execPlan.length) {
              setTimeout(() => this.executeCurrentStep(), 3000);
            } else {
              this.completeProgram();
            }
          }
        } else {
          // No wait run found — restart the full wait
          logger.info(`Cycle resuming wait step ${this.execIndex + 1} (no prior run found, restarting)`);
          this.status = 'running';
          setTimeout(() => this.executeCurrentStep(), 3000);
        }
      } else {
        // Device is idle, non-wait step — advance to next step
        this.status = 'running';
        this.execIndex++;
        if (this.execIndex < this.execPlan.length) {
          logger.info(`Cycle resuming from step ${this.execIndex + 1}/${this.execPlan.length}`);
          setTimeout(() => this.executeCurrentStep(), 3000);
        } else {
          this.completeProgram();
        }
      }
      this.emit();
    } catch (e) {
      logger.error('Failed to resume cycle program:', e);
      updateCycleProgram(program.id, { status: 'aborted', ended_at: new Date().toISOString() });
    }
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
      this.waitEndTime = null;
    }
  }

  private reset(): void {
    this.status = 'idle';
    this.advancePending = false;
    this.programId = null;
    this.programName = null;
    this.cellName = null;
    this.execPlan = [];
    this.execIndex = 0;
    this.totalCycles = 1;
    this.stepCapacities = [];
    this.stepDurations = [];
    this.stepExpectedS = [];
    this.clearWaitTimer();
  }
}
