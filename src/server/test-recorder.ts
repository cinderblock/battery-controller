/**
 * Test recorder — bridges DeviceSession events to SQLite persistence.
 *
 * Listens to device-session events and:
 * - Creates a test_run row when the device enters a running state
 * - Inserts data_point rows on each reading during a running test
 * - Finalizes the test run with stats when it ends
 * - Handles mid-test recovery (start_reason = 'recovered')
 */

import { logger } from '../utils/logger.ts';
import {
  type CreateTestRunParams,
  createTestRun,
  finalizeTestRun,
  getDataPointCount,
  getDataPointsForRun,
  insertDataPoint,
  reopenRun,
  setRunIrMohm,
} from './db.ts';
import type { DecodedReading, DeviceMode, DeviceSession, SessionEvent } from './device-session.ts';
import { estimateIrMohm, modeSupportsIr } from './ir-estimate.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface TestSetpoints {
  currentA?: number;
  voltageV?: number;
  powerW?: number;
  cutoffV?: number;
  cutoffCurrentA?: number;
  maxTimeMin?: number;
}

// ── TestRecorder ───────────────────────────────────────────────────

export class TestRecorder {
  private unsubscribe: (() => void) | null = null;

  // Active run state
  private activeRunId: number | null = null;
  private activeRunMode: DeviceMode | null = null;
  private activeRunMaxTimeMin: number | null = null;
  private runStartTime: number | null = null;
  private dataPointCount = 0;

  // Pending association: set before or during a test
  private pendingCellId: number | null = null;
  private pendingSetpoints: TestSetpoints | null = null;
  private pendingCycleProgramId: number | null = null;
  private pendingCycleStepIndex: number | null = null;
  private pendingStartReason: string = 'manual';
  private pendingExcludeFromCapacity = false;
  private pendingCycleIteration: number | null = null;

  // Wait run tracking (wall-clock elapsed, since device reports 0 when idle)
  private waitStartTime: number | null = null;

  // Track whether we've seen the initial state transition (for recovery detection)
  private hasSeenFirstTransition = false;

  constructor(private session: DeviceSession) {}

  /** Start listening to device session events */
  start(): void {
    this.unsubscribe = this.session.on(event => this.onEvent(event));

    // If the session is already in a running state (e.g. mid-test recovery
    // happened before we subscribed), start recording immediately
    if (this.session.isRunning() && this.activeRunId === null) {
      this.startRecoveredRun(this.session.getMode());
    }
  }

  /** Stop listening and finalize any active run */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.activeRunId !== null) {
      if (this.activeRunMode === ('wait' as DeviceMode)) {
        this.stopWaitRun();
      } else {
        this.finalizeRun('service_shutdown');
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────

  /** Set the cell ID to associate with the next (or current) test run */
  setCellId(cellId: number | null): void {
    this.pendingCellId = cellId;
  }

  /** Set the test setpoints for the next run */
  setSetpoints(setpoints: TestSetpoints): void {
    this.pendingSetpoints = setpoints;
  }

  /** Set cycle program context for the next run */
  setCycleContext(programId: number, stepIndex: number): void {
    this.pendingCycleProgramId = programId;
    this.pendingCycleStepIndex = stepIndex;
    this.pendingStartReason = 'cycle';
  }

  /** Clear cycle context (when not running as part of a cycle) */
  clearCycleContext(): void {
    this.pendingCycleProgramId = null;
    this.pendingCycleStepIndex = null;
    this.pendingStartReason = 'manual';
  }

  /** Get the active run ID, if any */
  getActiveRunId(): number | null {
    return this.activeRunId;
  }

  /** Get the data point count for the active run */
  getActiveDataPointCount(): number {
    return this.dataPointCount;
  }

  /** Get the active run's max time limit (minutes), if any */
  getActiveRunMaxTimeMin(): number | null {
    return this.activeRunMaxTimeMin;
  }

  /** Get the start time of the active run (ms since epoch), or null if no run */
  getRunStartTime(): number | null {
    return this.runStartTime;
  }

  /**
   * Elapsed seconds within the active run, on the same clock as data points:
   * device elapsed for test runs (correct across recovery, where
   * runStartTime resets to the reopen time), wall clock for wait runs.
   */
  getActiveRunElapsedS(): number | null {
    if (this.activeRunId === null) return null;
    if (this.activeRunMode === ('wait' as DeviceMode)) {
      return this.waitStartTime ? (Date.now() - this.waitStartTime) / 1000 : null;
    }
    return this.session.getReading().elapsedS;
  }

  /** Set whether the next run should be excluded from capacity calculations */
  setExcludeFromCapacity(exclude: boolean): void {
    this.pendingExcludeFromCapacity = exclude;
  }

  /** Set the cycle iteration number for the next run */
  setCycleIteration(iteration: number | null): void {
    this.pendingCycleIteration = iteration;
  }

  /**
   * Start recording a wait run. Device is idle but still sending readings;
   * we use wall-clock time for elapsed_s since the device reports 0.
   */
  startWaitRun(durationS: number): void {
    if (this.activeRunId !== null) {
      logger.warn('startWaitRun called while a run is already active — ignoring');
      return;
    }

    const params: CreateTestRunParams = {
      cellId: this.pendingCellId,
      cycleProgramId: this.pendingCycleProgramId,
      cycleStepIndex: this.pendingCycleStepIndex,
      mode: 'wait',
      setpointMaxTimeMin: Math.round(durationS / 60),
      startReason: this.pendingStartReason,
      excludeFromCapacity: this.pendingExcludeFromCapacity,
      cycleIteration: this.pendingCycleIteration,
    };

    const run = createTestRun(params);
    this.activeRunId = run.id;
    this.activeRunMode = 'wait' as DeviceMode;
    this.activeRunMaxTimeMin = null;
    this.waitStartTime = Date.now();
    this.runStartTime = Date.now();
    this.dataPointCount = 0;

    logger.info(`Started wait run #${run.id} (${durationS}s, cell=${this.pendingCellId ?? 'none'})`);
  }

  /** Stop and finalize the active wait run */
  stopWaitRun(): void {
    if (this.activeRunId === null || this.activeRunMode !== ('wait' as DeviceMode)) return;

    const durationS = this.waitStartTime ? (Date.now() - this.waitStartTime) / 1000 : 0;
    const reading = this.session.getReading();

    finalizeTestRun(
      this.activeRunId,
      'complete',
      0, // no capacity during wait
      0, // no energy during wait
      reading.voltage,
      reading.voltage,
      0, // no current during wait
      durationS,
      this.dataPointCount
    );

    logger.info(`Finalized wait run #${this.activeRunId}: ${durationS.toFixed(0)}s, ${this.dataPointCount} points`);

    this.activeRunId = null;
    this.activeRunMode = null;
    this.activeRunMaxTimeMin = null;
    this.waitStartTime = null;
    this.runStartTime = null;
    this.dataPointCount = 0;
  }

  // ── Event handling ────────────────────────────────────────────

  private onEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'stateChange':
        this.onStateChange(event.from, event.to);
        break;
      case 'reading':
        this.onReading(event.data);
        break;
    }
  }

  private onStateChange(from: DeviceMode, to: DeviceMode): void {
    const wasRunning = from === 'd-cc' || from === 'd-cp' || from === 'c-cv';
    const isRunning = to === 'd-cc' || to === 'd-cp' || to === 'c-cv';

    // Recovery detection: first transition from idle to running where
    // we didn't initiate the test (no pending setpoints)
    if (!this.hasSeenFirstTransition && isRunning && !wasRunning) {
      this.hasSeenFirstTransition = true;
      // If there's no pending reason set, this is a recovery
      if (this.pendingStartReason === 'manual' && this.pendingSetpoints === null) {
        // Try to reopen the previous run instead of creating a new one
        const recoveredRunId = this.session.getRecoveredRunId();
        if (recoveredRunId) {
          this.reopenPreviousRun(recoveredRunId, to);
        } else {
          this.startRecoveredRun(to);
        }
        return;
      }
    }
    this.hasSeenFirstTransition = true;

    if (isRunning && !wasRunning && this.activeRunId === null) {
      // Starting a new test
      this.startRun(to);
    } else if (!isRunning && wasRunning && this.activeRunId !== null) {
      // Test ended
      const endReason = this.inferEndReason(to);
      this.finalizeRun(endReason);
    } else if (isRunning && wasRunning && from !== to && this.activeRunId !== null) {
      // Mode changed mid-test (e.g. phase-2 transition within a charge).
      // Don't start a new run — just log it. The data points keep flowing
      // into the same run.
      logger.info(`Mode changed mid-test: ${from} → ${to} (run #${this.activeRunId})`);
    }
  }

  private onReading(reading: DecodedReading): void {
    if (this.activeRunId === null) return;
    if (reading.isInfoPacket) return;

    // For wait runs, use wall-clock elapsed (device reports 0 when idle)
    const elapsedS =
      this.activeRunMode === ('wait' as DeviceMode) && this.waitStartTime
        ? (Date.now() - this.waitStartTime) / 1000
        : reading.elapsedS;

    insertDataPoint(
      this.activeRunId,
      elapsedS,
      reading.voltage,
      reading.current,
      reading.power,
      reading.capacityMah,
      reading.energyMwh,
      reading.stateByte
    );
    this.dataPointCount++;
  }

  // ── Run lifecycle ─────────────────────────────────────────────

  private startRun(mode: DeviceMode): void {
    const params: CreateTestRunParams = {
      cellId: this.pendingCellId,
      cycleProgramId: this.pendingCycleProgramId,
      cycleStepIndex: this.pendingCycleStepIndex,
      mode,
      setpointCurrentA: this.pendingSetpoints?.currentA,
      setpointVoltageV: this.pendingSetpoints?.voltageV,
      setpointPowerW: this.pendingSetpoints?.powerW,
      setpointCutoffV: this.pendingSetpoints?.cutoffV,
      setpointCutoffCurrentA: this.pendingSetpoints?.cutoffCurrentA,
      setpointMaxTimeMin: this.pendingSetpoints?.maxTimeMin,
      startReason: this.pendingStartReason,
      excludeFromCapacity: this.pendingExcludeFromCapacity,
      cycleIteration: this.pendingCycleIteration,
    };

    const run = createTestRun(params);
    this.activeRunId = run.id;
    this.activeRunMode = mode;
    this.activeRunMaxTimeMin = this.pendingSetpoints?.maxTimeMin ?? null;
    this.runStartTime = Date.now();
    this.dataPointCount = 0;

    // Clear pending setpoints after use (cell ID persists for
    // subsequent runs until explicitly changed)
    this.pendingSetpoints = null;

    logger.info(
      `Started recording test run #${run.id} (mode=${mode}, cell=${this.pendingCellId ?? 'none'}, reason=${params.startReason})`
    );
  }

  private reopenPreviousRun(runId: number, mode: DeviceMode): void {
    reopenRun(runId);
    this.activeRunId = runId;
    this.activeRunMode = mode;
    this.activeRunMaxTimeMin = null;
    this.runStartTime = Date.now(); // approximate — gap is already elapsed
    this.dataPointCount = getDataPointCount(runId);

    logger.info(
      `Reopened test run #${runId} (mode=${mode}, ${this.dataPointCount} existing points). Continuing recording.`
    );
  }

  private startRecoveredRun(mode: DeviceMode): void {
    const params: CreateTestRunParams = {
      cellId: this.pendingCellId,
      cycleProgramId: this.pendingCycleProgramId,
      cycleStepIndex: this.pendingCycleStepIndex,
      mode,
      startReason: 'recovered',
      excludeFromCapacity: this.pendingExcludeFromCapacity,
      cycleIteration: this.pendingCycleIteration,
    };

    const run = createTestRun(params);
    this.activeRunId = run.id;
    this.activeRunMode = mode;
    this.runStartTime = Date.now();
    this.dataPointCount = 0;

    logger.info(
      `Started recording RECOVERED test run #${run.id} (mode=${mode}). Earlier data points from before restart are missing.`
    );
  }

  private finalizeRun(endReason: string): void {
    if (this.activeRunId === null) return;

    const stats = this.session.getTestStats();
    const reading = this.session.getReading();

    finalizeTestRun(
      this.activeRunId,
      endReason,
      reading.capacityMah,
      reading.energyMwh,
      stats.peakVoltage,
      stats.minVoltage,
      stats.peakCurrent,
      stats.elapsedS,
      this.dataPointCount
    );

    if (this.activeRunMode !== null && modeSupportsIr(this.activeRunMode)) {
      const ir = estimateIrMohm(getDataPointsForRun(this.activeRunId), this.activeRunMode);
      setRunIrMohm(this.activeRunId, ir?.mohm ?? 0);
      if (ir) {
        logger.info(`Run #${this.activeRunId} IR estimate: ${ir.mohm.toFixed(2)} mΩ (${ir.samples} samples)`);
      }
    }

    logger.info(
      `Finalized test run #${this.activeRunId}: ${endReason}, ` +
        `${reading.capacityAh.toFixed(3)} Ah, ${reading.energyWh.toFixed(1)} Wh, ` +
        `${stats.elapsedS.toFixed(0)}s, ${this.dataPointCount} points`
    );

    this.activeRunId = null;
    this.activeRunMode = null;
    this.activeRunMaxTimeMin = null;
    this.runStartTime = null;
    this.dataPointCount = 0;
  }

  private inferEndReason(toMode: DeviceMode): string {
    switch (toMode) {
      case 'complete':
        // Device signals test completion — could be cutoff voltage,
        // cutoff current, or time limit. We can't distinguish from the
        // state byte alone, but 'complete' is semantically accurate.
        return 'complete';
      case 'idle': {
        // Returned to idle without going through 'complete' — a host stop.
        // The session knows why it sent the stop (time limit, temp alert,
        // user request); fall back to 'manual_stop' for device-initiated idles.
        const hostReason = this.session.consumeStopReason();
        if (hostReason === 'time_limit') return 'time_limit';
        if (hostReason === 'temp_alert') return 'temp_alert';
        if (hostReason === 'step_ended_early') return 'step_ended_early';
        return 'manual_stop';
      }
      case 'fault':
        return 'fault';
      default:
        return 'unknown';
    }
  }
}
