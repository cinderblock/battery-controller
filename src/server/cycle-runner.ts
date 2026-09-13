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

import { RxState } from '../protocol/constants.ts';
import { MIN_STEP_A } from '../shared/ir-estimate.ts';
import { type FieldBindings, resolveSteps, type SequenceVariable } from '../shared/sequence-vars.ts';
import { logger } from '../utils/logger.ts';
import {
  type CycleProgram,
  createCycleProgram,
  getActiveCycleProgram,
  getCellById,
  getCycleStepRun,
  getRunsForCycleProgram,
  parseUtcTimestamp,
  resolveCellCapacityAh,
  setRunExcludeFromCapacity,
  updateCycleProgram,
} from './db.ts';
import type { DeviceMode, DeviceSession, SessionEvent } from './device-session.ts';
import type { TestRecorder } from './test-recorder.ts';

// ── Step types (mirror frontend sequence-types.ts) ─────────────────

/** Periodic in-run IR probe: dip the current to lowA for holdS every periodS */
export interface IrProbeConfig {
  /** Seconds between probes */
  periodS: number;
  /** Reduced current during the dip (A) — non-zero keeps the cell loaded */
  lowA: number;
  /** How long to hold the reduced current (s) — needs ≥2–3 readings at ~2s cadence */
  holdS: number;
}

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
  /** Periodic IR probe — gives the estimator a clean large-ΔI step every periodS */
  probe?: IrProbeConfig;
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
  /** Periodic IR probe — fires only during the CC phase (CV taper owns the current) */
  probe?: IrProbeConfig;
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

// ── In-run IR probe ────────────────────────────────────────────────

/** Floor on probe period — probing more often than this adds noise, not signal */
const PROBE_MIN_PERIOD_S = 60;
/** Hold bounds: long enough for ≥2–3 readings at ~2s cadence, short enough to stay a "dip" */
const PROBE_MIN_HOLD_S = 6;
const PROBE_MAX_HOLD_S = 30;
/** Restore attempts per dip — the device occasionally drops an adjust frame */
const PROBE_RESTORE_MAX_ATTEMPTS = 3;

/**
 * Validate and clamp a step's probe config against its resolved current.
 * Returns the sanitized config, or null when probing can't produce a usable
 * sample (ΔI below the estimator's acceptance threshold, or nonsense values).
 */
export function sanitizeProbe(probe: IrProbeConfig | undefined, setpointA: number): IrProbeConfig | null {
  if (!probe) return null;
  if (!(probe.lowA > 0)) return null;
  // The estimator rejects steps under MIN_STEP_A — a smaller dip is pure disturbance
  if (setpointA - probe.lowA < MIN_STEP_A) return null;
  if (!(probe.periodS > 0) || !(probe.holdS > 0)) return null;

  const holdS = Math.min(Math.max(probe.holdS, PROBE_MIN_HOLD_S), PROBE_MAX_HOLD_S);
  // Keep the dip a small fraction of the period so the run stays a discharge
  const periodS = Math.max(probe.periodS, PROBE_MIN_PERIOD_S, holdS * 4);
  return { periodS, lowA: probe.lowA, holdS };
}

/** Short parameter summary for a step, for timeline labels */
/** "0.5C→100A" for a C-rate step, plain "40A" otherwise. */
function currentLabel(step: StepDCC | StepCCV, capacityAh: number | null): string {
  if (!step.useCRate) return `${step.currentA}A`;
  const amps = capacityAh === null ? '?' : (step.currentA * capacityAh).toFixed(1);
  return `${step.currentA}C→${amps}A`;
}

function stepParamLabel(step: StepDCC | StepDCP | StepCCV | StepWait, capacityAh: number | null): string {
  switch (step.type) {
    case 'd-cc':
      return `${currentLabel(step, capacityAh)} ${step.cutoffV}V`;
    case 'd-cp':
      return `${step.powerW}W ${step.cutoffV}V`;
    case 'c-cv':
      return `${currentLabel(step, capacityAh)} ${step.targetV}V ${step.cutoffCurrentA}A`;
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

/**
 * Rich per-step summary for a completed test step, surfaced in the timeline's
 * step detail popover. Derived from the finalized test_runs row. Null fields
 * mean the device/recorder didn't provide that metric (older runs, wait steps).
 */
export interface StepDetail {
  /** Energy throughput (Wh) */
  energyWh: number | null;
  /** Mean current (A), from capacity ÷ duration */
  avgCurrentA: number | null;
  /** Peak current seen (A) */
  peakCurrentA: number | null;
  /** Voltage extremes over the step (V) */
  minVoltageV: number | null;
  peakVoltageV: number | null;
  /** DC internal resistance estimate for this step (mΩ) */
  irMohm: number | null;
  /** Estimated ohmic heat (Wh) */
  heatWh: number | null;
  /** Raw end reason from the recorder (e.g. 'complete', 'time_limit', 'manual') */
  endReason: string | null;
  /**
   * True when the step ended by hitting its host-enforced max-time limit
   * rather than reaching its cutoff — the cell was not driven to the target
   * endpoint, so the following step starts from an unknown state.
   */
  timedOut: boolean;
}

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
  /** Rich detail per completed test step (null until done / n/a for waits) */
  stepDetails: (StepDetail | null)[];
  /** test_runs.id backing each completed step, so the UI can cross-highlight
   *  the matching chart trace on hover/select (null until done / n/a). */
  stepRunIds: (number | null)[];
}

/** Map a finalized test-run row to a timeline StepDetail. */
function runToStepDetail(run: {
  final_energy_mwh: number | null;
  final_capacity_mah: number | null;
  peak_current_a: number | null;
  min_voltage_v: number | null;
  peak_voltage_v: number | null;
  ir_mohm: number | null;
  heat_mwh: number | null;
  duration_s: number | null;
  end_reason: string | null;
}): StepDetail {
  const capMah = run.final_capacity_mah;
  const durS = run.duration_s;
  const avgCurrentA = capMah != null && durS != null && durS > 0 ? capMah / 1000 / (durS / 3600) : null;
  return {
    energyWh: run.final_energy_mwh != null ? run.final_energy_mwh / 1000 : null,
    avgCurrentA,
    peakCurrentA: run.peak_current_a,
    minVoltageV: run.min_voltage_v,
    peakVoltageV: run.peak_voltage_v,
    irMohm: run.ir_mohm,
    heatWh: run.heat_mwh != null ? run.heat_mwh / 1000 : null,
    endReason: run.end_reason,
    timedOut: run.end_reason === 'time_limit',
  };
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

  // Cell capacity for C-rate resolution — from the cell's type, baked into the
  // program at start. null means "unknown", and a C-rate step must never run
  // against unknown: startSequence refuses up front, resolveCurrentA guards.
  private capacityAh: number | null = null;

  // Display name (label or barcode) of the cell under test
  private cellName: string | null = null;

  // Wait timer
  private waitTimer: Timer | null = null;
  private waitEndTime: number | null = null;

  // True between a step completing and the deferred advance/backoff decision
  private advancePending = false;

  // In-run IR probe: periodic dip timer + the pending restore for an in-flight dip
  private probeTimer: Timer | null = null;
  private probeRestoreTimer: Timer | null = null;

  // Step-start confirmation watchdog: verifies the device actually enters the
  // step's running mode after a start command, and re-sends if it doesn't.
  // Guards against a lost/ignored start frame silently hanging the whole
  // sequence (device stays idle, runner waits forever for a completion that
  // can never come).
  private startConfirmTimer: Timer | null = null;
  private startAttempt = 0;
  private readonly START_CONFIRM_MS = 8_000;
  private readonly START_MAX_ATTEMPTS = 3;

  // Cached per-step metadata (updated as steps complete)
  private stepCapacities: (number | null)[] = [];
  private stepDurations: (number | null)[] = [];
  private stepExpectedS: number[] = [];
  private stepDetails: (StepDetail | null)[] = [];
  private stepRunIds: (number | null)[] = [];

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
    this.clearProbeTimers();
    this.clearStartConfirm();
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
      stepLabels: this.execPlan.map(e => stepParamLabel(e.step, this.capacityAh)),
      stepDetails: this.stepDetails,
      stepRunIds: this.stepRunIds,
    };
  }

  /** Pull the finalized run row for a completed step into stepDetails. */
  private captureStepDetail(execIndex: number): void {
    if (this.programId === null) return;
    const run = getCycleStepRun(this.programId, execIndex);
    if (run) {
      this.stepDetails[execIndex] = runToStepDetail(run);
      this.stepRunIds[execIndex] = run.id;
    }
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

    // Flatten loops into a linear execution plan
    const execPlan = this.flattenSteps(migratedSteps);
    if (execPlan.length === 0) {
      throw new Error('Sequence has no executable steps');
    }

    // Look up cell capacity for C-rate resolution. Refuse — before anything
    // is written or pointed at the device — if a C-rate step has nothing to
    // multiply by. There is no fallback capacity on purpose.
    this.resolveCapacity(cellId);
    if (CycleRunner.needsCapacity(execPlan) && this.capacityAh === null) {
      this.cellName = null;
      throw new Error(
        cellId === null
          ? 'This sequence has C-rate steps, so it needs a scanned cell with a cell type'
          : `This sequence has C-rate steps, but ${this.cellName ?? 'the cell'} has no cell type — assign one first`
      );
    }
    this.execPlan = execPlan;

    // Point the recorder at this cell — otherwise runs are created with a
    // stale pendingCellId from a previous scan/program (runs 109-110 were
    // attributed to the prior cell this way)
    this.recorder.setCellId(cellId);

    // Compute total cycles from loop steps
    this.totalCycles = this.computeTotalCycles(migratedSteps);

    // Create DB record, baking in the capacity so resume can't drift
    const program = createCycleProgram(cellId, name, JSON.stringify(migratedSteps), this.capacityAh);
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
    this.stepDetails = new Array(this.execPlan.length).fill(null);
    this.stepRunIds = new Array(this.execPlan.length).fill(null);
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
    this.clearProbeTimers();
    this.clearStartConfirm();
    // Without this, the next manual run inherits this program's cycle
    // context (run #168 was mislabeled start_reason='cycle' this way)
    this.recorder.clearCycleContext();
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

    // Stuck or errored: the runner thinks a step is active but the device is
    // idle (a start command never took, or the cycle errored). Rather than
    // dead-ending "End Step" with the "no step is running" error the user hit,
    // let them force-advance to the next step. Guard the brief 2 s settle
    // window (advancePending) where a natural completion is already advancing.
    if ((this.status === 'running' || this.status === 'error') && !this.advancePending) {
      logger.warn(
        `Cycle step ${this.execIndex + 1}: End Step requested with device idle ` +
          `(status=${this.status}) — force-advancing to the next step`
      );
      this.clearStartConfirm();
      this.recorder.clearCycleContext();
      this.execIndex++;
      this.status = 'running';
      this.emit();
      await this.executeCurrentStep();
      return;
    }

    throw new Error('No step is currently running (cycle may be between steps)');
  }

  // ── Internal ─────────────────────────────────────────────────

  /**
   * Cache the cell's display name and its type's capacity for C-rate steps.
   * `bakedAh` (from a resumed program) wins over a fresh lookup so a cell
   * re-typed mid-run keeps the amps it started with.
   */
  private resolveCapacity(cellId: number | null, bakedAh: number | null = null): void {
    this.cellName = null;
    if (cellId) {
      const cell = getCellById(cellId);
      if (cell) this.cellName = cell.label || cell.barcode;
    }
    this.capacityAh = bakedAh ?? resolveCellCapacityAh(cellId);
    logger.info(`C-rate resolution capacity: ${this.capacityAh ?? 'unknown'} Ah (cell: ${this.cellName ?? 'none'})`);
  }

  /** Does any step in the plan need a capacity to turn C into amps? */
  private static needsCapacity(plan: { step: StepDCC | StepDCP | StepCCV | StepWait }[]): boolean {
    return plan.some(e => (e.step.type === 'd-cc' || e.step.type === 'c-cv') && e.step.useCRate);
  }

  /** Resolve a step's currentA to actual amps, handling C-rate */
  private resolveCurrentA(step: StepDCC | StepCCV): number {
    if (!step.useCRate) return step.currentA;
    if (this.capacityAh === null) {
      // startSequence refuses before we get here; this is the backstop.
      throw new Error('Cannot run a C-rate step: the cell has no type, so its capacity is unknown');
    }
    return step.currentA * this.capacityAh;
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

  /**
   * Handle an unexpected throw from a fire-and-forget executeCurrentStep().
   * These calls run from timer callbacks (wait completion, resume, backoff),
   * so an unhandled rejection would silently stall the sequence — surface it
   * as an error state instead.
   */
  private onExecuteError(e: unknown): void {
    logger.error('Cycle step execution failed unexpectedly:', e);
    this.status = 'error';
    this.emit();
  }

  private async executeCurrentStep(cellId: number | null = null): Promise<void> {
    // Never let a previous step's probe / start-confirm timers fire into this one
    this.clearProbeTimers();
    this.clearStartConfirm();

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
        this.executeCurrentStep(cellId).catch(e => this.onExecuteError(e));
      }, step.durationS * 1000);
      return;
    }

    // Executable step: set up recorder and send command
    this.status = 'running';
    this.emit();

    logger.info(`Cycle step ${this.execIndex + 1}: ${step.type} (cycle ${cycleNum})`);

    // A start command the device never acts on (lost/ignored frame, or a
    // transient serial error on send) must not hang the sequence — the
    // start-confirm watchdog re-sends if the device never enters the running
    // mode. So swallow a send error here and let the watchdog drive recovery.
    this.startAttempt = 0;
    try {
      await this.sendStartCommand(step);
    } catch (e) {
      logger.error(`Cycle step ${this.execIndex + 1}: start command send failed — confirm watchdog will retry`, e);
    }

    this.armStartConfirm(step);
    this.armProbe(step);
  }

  /**
   * Send the mode-appropriate start command for a running step, carrying the
   * step's setpoints into the recorder. Max-time enforcement happens inside
   * DeviceSession (host-side watchdog, restart-safe) — these frames just carry
   * the limit through. Split out so the start-confirm watchdog can re-send.
   */
  private async sendStartCommand(step: StepDCC | StepDCP | StepCCV): Promise<void> {
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

  // ── Step-start confirmation watchdog ──────────────────────────

  /**
   * Arm a watchdog that verifies the device actually entered the step's
   * running mode after a start command, re-sending if it didn't. Without this,
   * a start frame the device never acts on leaves the runner waiting forever
   * for a completion that can't come — the sequence silently stalls mid-run
   * (the "stuck on step N, System Idle, End Step does nothing" failure).
   */
  private armStartConfirm(step: StepDCC | StepDCP | StepCCV): void {
    this.clearStartConfirm();
    this.startConfirmTimer = setTimeout(() => void this.checkStartConfirm(step), this.START_CONFIRM_MS);
  }

  private clearStartConfirm(): void {
    if (this.startConfirmTimer) {
      clearTimeout(this.startConfirmTimer);
      this.startConfirmTimer = null;
    }
  }

  /** Re-send the start command if the device hasn't entered the running mode. */
  private async checkStartConfirm(step: StepDCC | StepDCP | StepCCV): Promise<void> {
    this.startConfirmTimer = null;
    // Step already advancing/ended, or the cycle was stopped — nothing to confirm.
    if (this.status !== 'running' || this.advancePending) return;
    // Device is in the expected running mode — the start took. (A step that
    // already ran to completion is caught by the advancePending guard above.)
    if (this.session.getMode() === step.type) {
      this.startAttempt = 0;
      return;
    }

    this.startAttempt++;
    if (this.startAttempt >= this.START_MAX_ATTEMPTS) {
      // Leave the DB program 'running' (current_step points here) so a service
      // restart re-attempts this step via resume, but surface the error live.
      logger.error(
        `Cycle step ${this.execIndex + 1}: device did not enter ${step.type} after ` +
          `${this.startAttempt} attempts — marking cycle errored`
      );
      this.status = 'error';
      this.emit();
      return;
    }

    logger.warn(
      `Cycle step ${this.execIndex + 1}: device not in ${step.type} yet ` +
        `(attempt ${this.startAttempt}/${this.START_MAX_ATTEMPTS}) — re-sending start`
    );
    try {
      await this.sendStartCommand(step);
    } catch (e) {
      logger.error(`Cycle step ${this.execIndex + 1}: start re-send failed`, e);
    }
    this.armStartConfirm(step);
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
        this.clearProbeTimers(); // step is over — no dip/restore may fire into the gap
        this.clearStartConfirm(); // the step ran; no need to confirm its start

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

    // The recorder has finalized the run row by now (2s delay in caller) — pull
    // its rich detail for the step-detail popover before moving on.
    this.captureStepDetail(this.execIndex);
    this.recorder.clearCycleContext();
    this.execIndex++;
    this.emit();
    this.executeCurrentStep().catch(e => this.onExecuteError(e));
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
    this.stepDetails[this.execIndex] = null;
    this.stepRunIds[this.execIndex] = null;

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
    this.executeCurrentStep().catch(e => this.onExecuteError(e));
    return true;
  }

  // ── In-run IR probe ───────────────────────────────────────────

  /**
   * Arm the periodic IR probe for a just-started step. d-cc and c-cv only —
   * CMD 0x07 Adjust is real-hardware verified for both (c-cv during the CC
   * phase; the dip guard handles phase gating). No-op (after clearing any
   * previous timers) for other step types or unusable probe configs.
   */
  private armProbe(step: StepDCC | StepDCP | StepCCV | StepWait): void {
    this.clearProbeTimers();
    if (step.type !== 'd-cc' && step.type !== 'c-cv') return;
    if (!step.probe) return;
    const setpointA = this.resolveCurrentA(step);
    const probe = sanitizeProbe(step.probe, setpointA);
    if (!probe) return;

    this.probeTimer = setInterval(() => void this.fireProbe(step, probe, setpointA), probe.periodS * 1000);
    logger.info(
      `IR probe armed (${step.type}): ${setpointA}A → ${probe.lowA}A for ${probe.holdS}s every ${Math.round(probe.periodS / 60)}min`
    );
  }

  private clearProbeTimers(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.probeRestoreTimer) {
      clearTimeout(this.probeRestoreTimer);
      this.probeRestoreTimer = null;
    }
  }

  /**
   * True only while it's safe to send a 0x07 adjust for this step: the
   * cycle is mid-step and the device is in the step's own running mode.
   * Adjust from any other state is uncharacterized on real hardware, and
   * the device can hit its cutoff (or the user can stop it) at any moment,
   * including mid-dip — so both the dip and the restore re-check this
   * right before sending.
   */
  private canAdjust(step: StepDCC | StepCCV): boolean {
    return (
      this.status === 'running' &&
      !this.advancePending &&
      this.session.getMode() === step.type &&
      this.session.getPendingCommand() === null
    );
  }

  /** Send the mode-appropriate 0x07 adjust frame with a new current */
  private async sendAdjust(step: StepDCC | StepCCV, currentA: number): Promise<void> {
    if (step.type === 'd-cc') {
      await this.session.adjustDCC(currentA, step.cutoffV, step.maxTimeMin ?? 0);
    } else {
      await this.session.adjustCCV(currentA, step.targetV, step.cutoffCurrentA, step.maxTimeMin ?? 0);
    }
  }

  /** One probe cycle: dip to lowA, hold, restore the step's setpoint. */
  private async fireProbe(step: StepDCC | StepCCV, probe: IrProbeConfig, setpointA: number): Promise<void> {
    if (this.probeRestoreTimer) return; // previous dip still in flight
    if (!this.canAdjust(step)) return;

    const reading = this.session.getReading();
    // Charge probing is only meaningful during the CC phase — once the CV
    // taper owns the current (state 0x16), a commanded ΔI is undefined.
    if (step.type === 'c-cv' && reading.stateByte !== RxState.EBC_CCV_RUN) return;
    // The dip must produce a step the estimator accepts from the ACTUAL
    // current, which can sit below the setpoint (late CC phase, backoff)
    if (reading.current - probe.lowA < MIN_STEP_A) return;

    try {
      await this.sendAdjust(step, probe.lowA);
      logger.info(`IR probe: dip ${reading.current.toFixed(1)}A → ${probe.lowA}A (${probe.holdS}s)`);
    } catch (e) {
      logger.error('IR probe dip failed:', e);
      return;
    }

    this.probeRestoreTimer = setTimeout(() => void this.restoreProbe(step, probe, setpointA, 1), probe.holdS * 1000);
  }

  /**
   * Restore the step's setpoint after a dip, then VERIFY the device took it
   * and retry if not. The device occasionally drops an adjust frame
   * (observed live 2026-07-16: dips that stayed stuck at lowA until the
   * next probe period) — without the retry the run crawls at reduced
   * current for up to a full probe period.
   *
   * For c-cv this restore intentionally fires even if the charger slipped
   * into the CV phase mid-dip: the dip lowered the current LIMIT, and
   * leaving it at lowA would cap the entire CV tail.
   */
  private async restoreProbe(
    step: StepDCC | StepCCV,
    probe: IrProbeConfig,
    setpointA: number,
    attempt: number
  ): Promise<void> {
    this.probeRestoreTimer = null;
    if (!this.canAdjust(step)) {
      // Step ended mid-dip (cutoff/stop) — the next step starts fresh via
      // its own start command, so there is nothing to restore.
      logger.info('IR probe: step ended during dip — skipping restore');
      return;
    }

    try {
      await this.sendAdjust(step, setpointA);
      logger.info(`IR probe: restore ${probe.lowA}A → ${setpointA}A${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    } catch (e) {
      logger.error('IR probe restore send failed:', e);
    }

    if (attempt >= PROBE_RESTORE_MAX_ATTEMPTS) {
      // Last try went unverified — next probe period's restore recovers it
      return;
    }

    // Verify a couple of readings later; reuse probeRestoreTimer so
    // clearProbeTimers() cancels the pending check and fireProbe won't
    // overlap a verification in flight. Short-hold configs (tests) verify
    // proportionally sooner. "Still stuck at the dip level" is the retry
    // signal — a c-cv current tapering below the setpoint is normal and
    // must not trigger resends.
    const verifyMs = Math.min(4000, probe.holdS * 1000);
    this.probeRestoreTimer = setTimeout(() => {
      this.probeRestoreTimer = null;
      if (!this.canAdjust(step)) return;
      const currentA = this.session.getReading().current;
      if (Math.abs(currentA - probe.lowA) > Math.max(0.5, probe.lowA * 0.1)) return; // moved off the dip — took
      logger.warn(
        `IR probe: restore didn't take (I=${currentA.toFixed(1)}A, want ${setpointA}A) — retrying (${attempt + 1}/${PROBE_RESTORE_MAX_ATTEMPTS})`
      );
      void this.restoreProbe(step, probe, setpointA, attempt + 1);
    }, verifyMs);
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

      // Restore the capacity the program started with (pre-v9 programs have
      // none baked in; fall through to the cell's current type)
      this.resolveCapacity(program.cell_id, program.capacity_ah);

      this.totalCycles = this.computeTotalCycles(steps);

      // Restore step metadata from completed runs
      this.stepCapacities = new Array(this.execPlan.length).fill(null);
      this.stepDurations = new Array(this.execPlan.length).fill(null);
      this.stepDetails = new Array(this.execPlan.length).fill(null);
      this.stepRunIds = new Array(this.execPlan.length).fill(null);
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
          this.stepDetails[run.cycle_step_index] = runToStepDetail(run);
          this.stepRunIds[run.cycle_step_index] = run.id;
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
              this.executeCurrentStep().catch(e => this.onExecuteError(e));
            }, cappedRemainingS * 1000);
          } else {
            // Wait already elapsed — advance to next step
            this.recorder.stopWaitRun();
            logger.info(`Cycle wait step ${this.execIndex + 1} already elapsed, advancing`);
            this.status = 'running';
            this.execIndex++;
            if (this.execIndex < this.execPlan.length) {
              setTimeout(() => this.executeCurrentStep().catch(e => this.onExecuteError(e)), 3000);
            } else {
              this.completeProgram();
            }
          }
        } else {
          // No wait run found — restart the full wait
          logger.info(`Cycle resuming wait step ${this.execIndex + 1} (no prior run found, restarting)`);
          this.status = 'running';
          setTimeout(() => this.executeCurrentStep().catch(e => this.onExecuteError(e)), 3000);
        }
      } else {
        // Device is idle on a non-wait step. If this step already produced a
        // finalized run it completed → advance. If it has NO run it never
        // actually executed (a start frame lost/ignored, or the service
        // restarted mid-start) → RE-RUN it rather than silently skipping it.
        // Skipping is exactly what stranded program #31: the step-5 charge was
        // skipped, so the cell sat discharged and later discharges ran on empty.
        this.status = 'running';
        this.advancePending = false; // clear any stale advance flag from crash
        const hasRun = this.stepRunIds[this.execIndex] != null;
        if (!hasRun) {
          logger.warn(
            `Cycle resume: step ${this.execIndex + 1}/${this.execPlan.length} ` +
              `(${this.execPlan[this.execIndex].step.type}) has no recorded run — ` +
              `it never executed; re-running it instead of skipping`
          );
          setTimeout(() => this.executeCurrentStep().catch(e => this.onExecuteError(e)), 3000);
        } else {
          this.execIndex++;
          if (this.execIndex < this.execPlan.length) {
            logger.info(`Cycle resuming from step ${this.execIndex + 1}/${this.execPlan.length}`);
            setTimeout(() => this.executeCurrentStep().catch(e => this.onExecuteError(e)), 3000);
          } else {
            this.completeProgram();
          }
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
    this.stepDetails = [];
    this.stepRunIds = [];
    this.stepExpectedS = [];
    this.startAttempt = 0;
    this.clearWaitTimer();
    this.clearProbeTimers();
    this.clearStartConfirm();
  }
}
