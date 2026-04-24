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
  type CycleProgram,
} from './db.ts';
import { logger } from '../utils/logger.ts';

// ── Step types (mirror frontend sequence-types.ts) ─────────────────

export interface StepDCC {
  type: 'd-cc';
  currentA: number;
  cutoffV: number;
  maxTimeMin?: number;
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
}

export interface StepWait {
  type: 'wait';
  durationS: number;
}

export interface StepLoop {
  type: 'loop';
  count: number;
  startIndex: number;
  endIndex: number;
}

export type CycleStep = StepDCC | StepDCP | StepCCV | StepWait | StepLoop;

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

    // Flatten loops into a linear execution plan
    this.execPlan = this.flattenSteps(steps);
    if (this.execPlan.length === 0) {
      throw new Error('Sequence has no executable steps');
    }

    // Compute total cycles from loop steps
    this.totalCycles = 1;
    for (const s of steps) {
      if (s.type === 'loop') this.totalCycles = Math.max(this.totalCycles, s.count);
    }

    // Create DB record
    const program = createCycleProgram(cellId, name, JSON.stringify(steps));
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

  private flattenSteps(steps: CycleStep[]): { step: StepDCC | StepDCP | StepCCV | StepWait; cycleNum: number }[] {
    const plan: { step: StepDCC | StepDCP | StepCCV | StepWait; cycleNum: number }[] = [];

    // First, identify which steps are covered by loops
    const loopSteps = steps.filter((s): s is StepLoop => s.type === 'loop');

    // If no loops, just add all executable steps once
    if (loopSteps.length === 0) {
      for (const s of steps) {
        if (s.type !== 'loop') plan.push({ step: s, cycleNum: 1 });
      }
      return plan;
    }

    // With loops: expand. For simplicity, handle the most common case:
    // one loop that wraps some contiguous range of steps.
    // The loop repeats those steps N times.
    const loop = loopSteps[0]; // Use the first loop
    const loopedIndices = new Set<number>();
    for (let i = loop.startIndex; i <= loop.endIndex; i++) {
      loopedIndices.add(i);
    }

    // Steps before the loop
    for (let i = 0; i < loop.startIndex; i++) {
      const s = steps[i];
      if (s.type !== 'loop') plan.push({ step: s, cycleNum: 1 });
    }

    // Looped steps × N
    for (let cycle = 1; cycle <= loop.count; cycle++) {
      for (let i = loop.startIndex; i <= loop.endIndex && i < steps.length; i++) {
        const s = steps[i];
        if (s.type !== 'loop') plan.push({ step: s, cycleNum: cycle });
      }
    }

    // Steps after the loop
    for (let i = loop.endIndex + 1; i < steps.length; i++) {
      const s = steps[i];
      if (s.type !== 'loop') plan.push({ step: s, cycleNum: 1 });
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
      case 'd-cc':
        this.recorder.setSetpoints({
          currentA: step.currentA,
          cutoffV: step.cutoffV,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startDCC(step.currentA, step.cutoffV);
        break;
      case 'd-cp':
        this.recorder.setSetpoints({
          powerW: step.powerW,
          cutoffV: step.cutoffV,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startDCP(step.powerW, step.cutoffV, step.maxTimeMin ?? 0);
        break;
      case 'c-cv':
        this.recorder.setSetpoints({
          currentA: step.currentA,
          voltageV: step.targetV,
          cutoffCurrentA: step.cutoffCurrentA,
          maxTimeMin: step.maxTimeMin,
        });
        await this.session.startCCV(step.currentA, step.targetV, step.cutoffCurrentA);
        break;
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
      const steps = JSON.parse(program.steps_json) as CycleStep[];
      this.execPlan = this.flattenSteps(steps);
      this.programId = program.id;
      this.programName = program.name;
      this.execIndex = program.current_step;

      this.totalCycles = 1;
      for (const s of steps) {
        if (s.type === 'loop') this.totalCycles = Math.max(this.totalCycles, s.count);
      }

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

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); }
      catch (e) { logger.error('Cycle listener error:', e); }
    }
  }
}
