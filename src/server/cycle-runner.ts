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

import type { DeviceSession, DeviceMode, SessionEvent } from './device-session.ts';
import type { TestRecorder } from './test-recorder.ts';
import {
  createCycleProgram,
  updateCycleProgram,
  getActiveCycleProgram,
  getCellById,
  getCellGroup,
  type CycleProgram,
} from './db.ts';
import { logger } from '../utils/logger.ts';

// ── Step types (mirror frontend sequence-types.ts) ─────────────────

export interface StepDCC {
  type: 'd-cc';
  currentA: number;
  cutoffV: number;
  maxTimeMin?: number;
  useCRate?: boolean;
}

export interface StepDCP {
  type: 'd-cp';
  powerW: number;
  cutoffV: number;
  maxTimeMin?: number;
}

export interface StepCCV {
  type: 'c-cv';
  currentA: number;
  targetV: number;
  cutoffCurrentA: number;
  maxTimeMin?: number;
  useCRate?: boolean;
}

export interface StepWait {
  type: 'wait';
  durationS: number;
}

export interface StepLoop {
  type: 'loop';
  count: number;
  children: CycleStep[];
}

export type CycleStep = StepDCC | StepDCP | StepCCV | StepWait | StepLoop;

// ── V1 migration ──────────────────────────────────────────────────

interface V1Loop { type: 'loop'; count: number; startIndex: number; endIndex: number; }

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

  return [
    ...before,
    { type: 'loop', count: loop.count, children: inside },
    ...after,
  ];
}

// ── CycleState ─────────────────────────────────────────────────────

export type CycleStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'aborted' | 'error';

export interface CycleState {
  status: CycleStatus;
  programId: number | null;
  programName: string | null;
  /** Flat execution index (position in the expanded step list) */
  currentExecIndex: number;
  totalExecSteps: number;
  /** Current cycle number for display (which loop iteration) */
  currentCycle: number;
  totalCycles: number;
  /** Wait timer info */
  waitEndTime: number | null;
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

  // Wait timer
  private waitTimer: Timer | null = null;
  private waitEndTime: number | null = null;

  constructor(
    private session: DeviceSession,
    private recorder: TestRecorder,
  ) {}

  /** Start listening for device state changes */
  start(): void {
    this.unsubSession = this.session.on(event => this.onSessionEvent(event));

    // Check for an active cycle program from a previous session
    const active = getActiveCycleProgram();
    if (active) {
      logger.info(`Found active cycle program #${active.id} from previous session. Resuming...`);
      this.resumeProgram(active);
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
      currentExecIndex: this.execIndex,
      totalExecSteps: this.execPlan.length,
      currentCycle: this.execPlan[this.execIndex]?.cycleNum ?? 0,
      totalCycles: this.totalCycles,
      waitEndTime: this.waitEndTime,
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); }
      catch (e) { logger.error('Cycle listener error:', e); }
    }
  }

  // ── Public commands ──────────────────────────────────────────

  /** Start running a sequence */
  async startSequence(
    name: string,
    steps: CycleStep[],
    cellId: number | null = null,
  ): Promise<void> {
    if (this.status === 'running' || this.status === 'waiting') {
      throw new Error('A cycle is already running');
    }

    if (this.session.isRunning()) {
      throw new Error('Device is already running a test');
    }

    // Migrate V1 format if needed
    const migratedSteps = migrateV1Steps(steps);

    // Look up cell capacity for C-rate resolution
    this.resolveCapacity(cellId);

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

    logger.info(`Starting cycle "${name}" with ${this.execPlan.length} steps`);
    this.emit();

    // Start first step
    await this.executeCurrentStep(cellId);
  }

  /** Abort the running cycle */
  async abort(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'waiting') return;

    this.clearWaitTimer();

    if (this.session.isRunning()) {
      await this.session.stop();
    }

    this.status = 'aborted';
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

  // ── Internal ─────────────────────────────────────────────────

  /** Resolve cell capacity for C-rate steps */
  private resolveCapacity(cellId: number | null): void {
    if (cellId) {
      const cell = getCellById(cellId);
      if (cell) {
        // Use cell's own capacity, or look up from cell group
        if (cell.nominal_capacity_mah) {
          this.capacityAh = cell.nominal_capacity_mah / 1000;
        } else if (cell.cell_group_id) {
          const group = getCellGroup(cell.cell_group_id);
          if (group) this.capacityAh = group.nominal_capacity_mah / 1000;
        }
      }
    }
    logger.info(`C-rate resolution capacity: ${this.capacityAh} Ah`);
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

    if (step.type === 'wait') {
      // Wait step: set a timer
      this.status = 'waiting';
      this.waitEndTime = Date.now() + step.durationS * 1000;
      logger.info(`Cycle step ${this.execIndex + 1}: waiting ${step.durationS}s`);
      this.emit();

      this.waitTimer = setTimeout(() => {
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

    if (this.programId) {
      this.recorder.setCycleContext(this.programId, this.execIndex);
    }

    logger.info(`Cycle step ${this.execIndex + 1}: ${step.type} (cycle ${cycleNum})`);

    switch (step.type) {
      case 'd-cc': {
        const actualCurrentA = this.resolveCurrentA(step);
        this.recorder.setSetpoints({
          currentA: actualCurrentA,
          cutoffV: step.cutoffV,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startDCC(actualCurrentA, step.cutoffV);
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
        await this.session.startCCV(actualCurrentA, step.targetV, step.cutoffCurrentA);
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
      if (currentStep.type !== 'wait') {
        // Test step completed — advance to next
        logger.info(`Cycle step ${this.execIndex + 1} completed (device → ${to})`);
        this.recorder.clearCycleContext();
        this.execIndex++;
        // Small delay before starting next step to let device settle
        setTimeout(() => this.executeCurrentStep(), 2000);
      }
    }
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

      // If device is running, we're mid-step — wait for completion
      if (this.session.isRunning()) {
        this.status = 'running';
        logger.info(`Cycle resumed mid-step at ${this.execIndex + 1}/${this.execPlan.length}`);
      } else {
        // Device is idle — advance to next step
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
    this.programId = null;
    this.programName = null;
    this.execPlan = [];
    this.execIndex = 0;
    this.totalCycles = 1;
    this.clearWaitTimer();
  }
}
