/**
 * High-level device session manager
 *
 * Wraps SerialManager to provide:
 * - Decoded readings (V, I, P, Ah, Wh) from every RX packet
 * - State machine tracking (idle, d-cc, d-cp, c-cv, complete)
 * - Typed command methods with proper payload encoding
 * - Heartbeat management
 * - Mid-test recovery on startup
 * - Optimistic command tracking
 */

import { decodeBase240, encodeBase240, isInfoPacket } from '../protocol/codec.ts';
import { EbcDivisors, INFO_STATE_OFFSET, RxState } from '../protocol/constants.ts';
import { logger } from '../utils/logger.ts';
import { type CapacityState, CapacityTracker } from './capacity-tracker.ts';
import type { SerialManager } from './serial.ts';

// ── Types ──────────────────────────────────────────────────────────

export type DeviceMode = 'idle' | 'd-cc' | 'd-cp' | 'c-cv' | 'complete' | 'fault';

export interface DecodedReading {
  /** Current device mode */
  mode: DeviceMode;
  /** Raw state byte from device */
  stateByte: number;
  /** Voltage in volts */
  voltage: number;
  /** Current in amps (always positive) */
  current: number;
  /** Power in watts (V × I) */
  power: number;
  /** Capacity in mAh (device-reported, with wrap compensation) */
  capacityMah: number;
  /** Capacity in Ah */
  capacityAh: number;
  /** Energy in mWh (host-computed ∫P·dt) */
  energyMwh: number;
  /** Energy in Wh */
  energyWh: number;
  /** Elapsed time in seconds since test start */
  elapsedS: number;
  /** Timestamp of this reading */
  timestamp: number;
  /** Whether this is an info packet (device ID, not a data reading) */
  isInfoPacket: boolean;
  /** Raw payload bytes 7-8 (field7 — unknown, suspected high capacity word) */
  rawField7: number;
  /** Decoded setpoint echo (bytes 10-11) */
  setpointEcho: number;
  /** Decoded cutoff voltage echo (bytes 12-13, ÷100 → V) */
  cutoffEcho: number;
  /** Max time or cutoff current echo (bytes 14-15, base-240) */
  maxTimeEcho: number;
}

export interface DeviceInfo {
  /** Device type byte (from info packet byte 13) */
  typeByte: number;
  /** Device subtype byte (from info packet byte 14) */
  subtypeByte: number;
  /** Device constant byte (byte 15, typically 0x0A for EBC-A40L) */
  constByte: number;
}

export interface PendingCommand {
  command: string;
  sentAt: number;
  expectedMode: DeviceMode | null;
}

export type SessionEvent =
  | { type: 'reading'; data: DecodedReading }
  | { type: 'stateChange'; from: DeviceMode; to: DeviceMode }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'deviceInfo'; data: DeviceInfo }
  | { type: 'commandPending'; data: PendingCommand }
  | { type: 'commandConfirmed'; data: { command: string; mode: DeviceMode } }
  | { type: 'commandTimeout'; data: { command: string } }
  | { type: 'deviceUnresponsive' }
  | { type: 'deviceResponsive' };

type SessionListener = (event: SessionEvent) => void;

// ── State byte → mode mapping ──────────────────────────────────────

export function stateByteToMode(state: number): DeviceMode {
  // Strip info offset if present
  const normalState = state >= INFO_STATE_OFFSET ? state - INFO_STATE_OFFSET : state;

  switch (normalState) {
    case RxState.EBC_DCC_RUN:
    case RxState.EBC_DCC_RUN2:
      return 'd-cc';
    case RxState.EBC_DCP_RUN:
    case RxState.EBC_DCP_RUN2:
      return 'd-cp';
    case RxState.EBC_CCV_RUN:
    case RxState.EBC_CCV_RUN2:
      return 'c-cv';
    case RxState.EBC_IDLE:
    case 0x01: // post-test idle
    case 0x00: // EBD idle (shouldn't happen but handle gracefully)
      return 'idle';
    default:
      return 'idle';
  }
}

// ── Recovery types ─────────────────────────────────────────────────

export interface RecoveryState {
  runId: number;
  testStartTime: number;
  energyMwh: number;
  capState: CapacityState;
  peakVoltage: number;
  minVoltage: number;
  peakCurrent: number;
  /** Host-enforced max run time (minutes) from the recovered run's setpoints */
  maxTimeMin: number | null;
}

/**
 * Called when the device is detected mid-test on the first packet after restart.
 * Receives the device mode and raw (unwrapped) capacity from the first packet.
 * Returns recovery state from the DB, or null if no recovery is possible.
 */
export type RecoveryProvider = (mode: DeviceMode, rawCapacityMah: number) => RecoveryState | null;

// ── DeviceSession ──────────────────────────────────────────────────

export class DeviceSession {
  private listeners = new Set<SessionListener>();
  private unsubPacket: (() => void) | null = null;
  private unsubConnection: (() => void) | null = null;

  // State
  private mode: DeviceMode = 'idle';
  private deviceInfo: DeviceInfo | null = null;
  private firstPacketReceived = false;
  private initSent = false;

  // Current readings
  private voltage = 0;
  private current = 0;
  private capacityMah = 0;
  private energyMwh = 0;
  private lastReadingTimestamp = 0;
  private rawField7 = 0;
  private setpointEcho = 0;
  private cutoffEcho = 0;
  private maxTimeEcho = 0;
  private lastStateByte = 0;

  // Capacity tracking with high-capacity encoding correction
  private capTracker = new CapacityTracker();

  // Test timing
  private testStartTime = 0;
  private lastEnergyUpdateTime = 0;

  // Host-side max-time enforcement.
  // The C-CV charge frame has no time field — EB Tester enforces charge time
  // limits with a host-side timer and a 0x02 load toggle, and so must we.
  // For D-CC/D-CP the device enforces the limit itself; the host acts as a
  // backstop one minute later in case the device fails to stop.
  private hostMaxTimeMin = 0;
  private lastTimeLimitStopAt = 0;
  private readonly TIME_LIMIT_RETRY_MS = 10_000;

  // Reason for the most recent host-initiated stop ('manual', 'time_limit', ...).
  // Consumed by TestRecorder to record an accurate end_reason.
  private lastStopReason: string | null = null;

  // Heartbeat
  private heartbeatTimer: Timer | null = null;
  private heartbeatCounter = 0;
  private readonly HEARTBEAT_INTERVAL_MS = 55_000;

  // Startup init timer — sends init if no packets arrive within timeout
  private initTimer: Timer | null = null;
  private readonly INIT_WAIT_MS = 2_000;

  // Command tracking
  private pendingCommand: PendingCommand | null = null;
  private commandTimeoutTimer: Timer | null = null;
  private readonly COMMAND_TIMEOUT_MS = 5_000;

  // Device-responsive watchdog — fires if no packet within threshold
  private watchdogTimer: Timer | null = null;
  private deviceResponsive = false;
  private readonly WATCHDOG_TIMEOUT_MS = 10_000; // 10s ≈ 5 missed packets

  // Track peak/min for test run stats
  private peakVoltage = 0;
  private minVoltage = Infinity;
  private peakCurrent = 0;

  // Recovery: run ID from a reopened service_restart run
  private recoveredRunId: number | null = null;

  constructor(
    private serial: SerialManager,
    private recoveryProvider?: RecoveryProvider
  ) {}

  /** Start listening to serial packets and managing the session */
  start(): void {
    this.unsubPacket = this.serial.addPacketListener(packet => this.onPacket(packet));
    this.unsubConnection = this.serial.addConnectionListener(connected => {
      if (connected) {
        this.emit({ type: 'connected' });
      } else {
        this.emit({ type: 'disconnected' });
        this.stopHeartbeat();
        this.stopWatchdog();
        this.deviceResponsive = false;
      }
    });

    // Wait for device to send data; if nothing arrives, send init to start streaming
    this.scheduleInitProbe();
  }

  /** Stop listening and clean up timers. Resets state so start() reinitializes cleanly. */
  destroy(): void {
    this.unsubPacket?.();
    this.unsubConnection?.();
    this.stopHeartbeat();
    this.stopWatchdog();
    this.clearCommandTimeout();
    this.clearInitTimer();

    // Reset state machine so start() will send init and detect mid-test recovery
    this.firstPacketReceived = false;
    this.initSent = false;
    this.deviceResponsive = false;
  }

  /** Subscribe to session events */
  on(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        logger.error('Session listener error:', e);
      }
    }
  }

  // ── Getters ────────────────────────────────────────────────────

  getMode(): DeviceMode {
    return this.mode;
  }
  getDeviceInfo(): DeviceInfo | null {
    return this.deviceInfo;
  }
  isDeviceResponsive(): boolean {
    return this.deviceResponsive;
  }
  getRecoveredRunId(): number | null {
    return this.recoveredRunId;
  }

  getReading(): DecodedReading {
    const elapsedS = this.mode !== 'idle' && this.testStartTime > 0 ? (Date.now() - this.testStartTime) / 1000 : 0;
    return {
      mode: this.mode,
      stateByte: this.lastStateByte,
      voltage: this.voltage,
      current: this.current,
      power: this.voltage * this.current,
      capacityMah: this.capacityMah,
      capacityAh: this.capacityMah / 1000,
      energyMwh: this.energyMwh,
      energyWh: this.energyMwh / 1000,
      elapsedS,
      timestamp: this.lastReadingTimestamp,
      isInfoPacket: false,
      rawField7: this.rawField7,
      setpointEcho: this.setpointEcho,
      cutoffEcho: this.cutoffEcho,
      maxTimeEcho: this.maxTimeEcho,
    };
  }

  getTestStats() {
    return {
      peakVoltage: this.peakVoltage,
      minVoltage: this.minVoltage === Infinity ? 0 : this.minVoltage,
      peakCurrent: this.peakCurrent,
      elapsedS: this.testStartTime > 0 ? (Date.now() - this.testStartTime) / 1000 : 0,
    };
  }

  getPendingCommand(): PendingCommand | null {
    return this.pendingCommand;
  }

  isRunning(): boolean {
    return this.mode === 'd-cc' || this.mode === 'd-cp' || this.mode === 'c-cv';
  }

  // ── Packet handling ────────────────────────────────────────────

  private onPacket(payload: Buffer): void {
    // payload is the 16-byte payload (no start/end/checksum tokens)
    if (payload.length < 16) return;

    const stateByte = payload[0];
    const isInfo = isInfoPacket(stateByte);
    const now = Date.now();

    // Decode base-240 fields
    const currentRaw = decodeBase240(payload[1], payload[2], EbcDivisors.current);
    const voltage = decodeBase240(payload[3], payload[4], EbcDivisors.voltage);
    const capacityMah = decodeBase240(payload[5], payload[6], EbcDivisors.capacity);
    const field7raw = decodeBase240(payload[7], payload[8], 1);
    const setpointEcho = decodeBase240(payload[9], payload[10], EbcDivisors.current);
    const cutoffEcho = decodeBase240(payload[11], payload[12], EbcDivisors.setpointVoltage);
    const maxTimeEcho = decodeBase240(payload[13], payload[14], 1);

    // Log field7 when non-zero to understand what it carries on high-capacity tests
    if (field7raw !== 0 && !isInfoPacket(payload[0])) {
      logger.info(
        `Field7 non-zero: raw=${field7raw}, bytes=[0x${payload[7].toString(16)}, 0x${payload[8].toString(16)}], capLow=${capacityMah}`
      );
    }

    // First packet: cancel init probe timer, decide whether to send init
    if (!this.firstPacketReceived) {
      this.firstPacketReceived = true;
      this.clearInitTimer();
      const mode = stateByteToMode(stateByte);
      if (mode !== 'idle') {
        // Device is mid-test — try to recover state from the previous run
        let recovery: RecoveryState | null = null;
        if (this.recoveryProvider) {
          recovery = this.recoveryProvider(mode, capacityMah);
          if (recovery) {
            this.recoveredRunId = recovery.runId;
            logger.info(`Recovery state found: run #${recovery.runId}, restoring elapsed/energy/capacity`);
          }
        }

        logger.info(
          `Device is mid-test (state=0x${stateByte.toString(16)}, mode=${mode}). ${recovery ? 'Resuming' : 'Recovering'}.`
        );
        this.setMode(mode); // resets state + emits stateChange

        // Override the reset values with recovered state
        if (recovery) {
          this.testStartTime = recovery.testStartTime;
          this.energyMwh = recovery.energyMwh;
          this.capTracker.restore(recovery.capState, capacityMah);
          this.peakVoltage = recovery.peakVoltage;
          this.minVoltage = recovery.minVoltage;
          this.peakCurrent = recovery.peakCurrent;
          // Restore host-side time-limit enforcement across restarts.
          // Charge limits are host-enforced only, so give the recovered
          // C-CV run the exact limit; discharge keeps the +1 min backstop.
          if (recovery.maxTimeMin != null && recovery.maxTimeMin > 0) {
            this.hostMaxTimeMin = mode === 'c-cv' ? recovery.maxTimeMin : recovery.maxTimeMin + 1;
          }
        }
        this.lastEnergyUpdateTime = now;
      } else if (!this.initSent) {
        // Device is idle — send init to start measurement stream
        this.sendInit();
      }
    }

    // Handle info packets (device identification)
    if (isInfo) {
      this.deviceInfo = {
        typeByte: payload[13],
        subtypeByte: payload[14],
        constByte: payload[15],
      };
      this.emit({ type: 'deviceInfo', data: this.deviceInfo });
      // Still update voltage from info packets (it's valid)
      this.voltage = voltage;
      this.resetHeartbeat();
      this.resetWatchdog();
      return;
    }

    // Update readings
    this.voltage = voltage;
    this.current = currentRaw;
    this.lastReadingTimestamp = now;
    this.rawField7 = field7raw;
    this.setpointEcho = setpointEcho;
    this.cutoffEcho = cutoffEcho;
    this.maxTimeEcho = maxTimeEcho;
    this.lastStateByte = stateByte;

    // Apply high-capacity encoding correction (see capacity-tracker.ts)
    // Only update capacity when running — idle packets contain stale device register values
    if (this.isRunning()) {
      const prevCorrected = this.capacityMah;
      this.capacityMah = this.capTracker.update(capacityMah, true);
      if (this.capTracker.highCapMode && prevCorrected < this.capacityMah - 5000 && prevCorrected > 0) {
        logger.info(`High-cap transition: rawJump=${capacityMah}, trueCap=${this.capacityMah} (10 mAh/unit mode)`);
      }
    }

    // Host-side energy integration (device bytes 8-9 are always 0 on A40L)
    if (this.isRunning() && this.lastEnergyUpdateTime > 0) {
      const dtHours = (now - this.lastEnergyUpdateTime) / 3_600_000;
      const powerW = voltage * currentRaw;
      this.energyMwh += powerW * dtHours * 1000; // mWh
    }
    this.lastEnergyUpdateTime = now;

    // Track peaks
    if (this.isRunning()) {
      if (voltage > this.peakVoltage) this.peakVoltage = voltage;
      if (voltage < this.minVoltage) this.minVoltage = voltage;
      if (currentRaw > this.peakCurrent) this.peakCurrent = currentRaw;
    }

    // Detect mode transitions
    const newMode = stateByteToMode(stateByte);
    if (newMode !== this.mode) {
      this.setMode(newMode);
    }

    // Check if pending command was confirmed
    if (this.pendingCommand) {
      const expected = this.pendingCommand.expectedMode;
      if (expected === null || newMode === expected) {
        this.clearCommandTimeout();
        this.emit({
          type: 'commandConfirmed',
          data: { command: this.pendingCommand.command, mode: newMode },
        });
        this.pendingCommand = null;
      }
    }

    // Build reading
    const elapsedS = this.testStartTime > 0 && this.isRunning() ? (now - this.testStartTime) / 1000 : 0;

    // Host-side max-time enforcement (re-sends stop every TIME_LIMIT_RETRY_MS
    // until the device actually goes idle, in case a stop frame is lost)
    if (
      this.isRunning() &&
      this.hostMaxTimeMin > 0 &&
      elapsedS >= this.hostMaxTimeMin * 60 &&
      now - this.lastTimeLimitStopAt >= this.TIME_LIMIT_RETRY_MS
    ) {
      this.lastTimeLimitStopAt = now;
      logger.warn(
        `Max time reached (${(elapsedS / 60).toFixed(1)} min >= ${this.hostMaxTimeMin} min limit) — sending stop`
      );
      this.stop('time_limit').catch(e => logger.error('Time-limit stop failed:', e));
    }

    const reading: DecodedReading = {
      mode: this.mode,
      stateByte,
      voltage,
      current: currentRaw,
      power: voltage * currentRaw,
      capacityMah: this.capacityMah,
      capacityAh: this.capacityMah / 1000,
      energyMwh: this.energyMwh,
      energyWh: this.energyMwh / 1000,
      elapsedS,
      timestamp: now,
      isInfoPacket: false,
      rawField7: this.rawField7,
      setpointEcho: this.setpointEcho,
      cutoffEcho: this.cutoffEcho,
      maxTimeEcho: this.maxTimeEcho,
    };

    this.emit({ type: 'reading', data: reading });
    this.resetHeartbeat();
    this.resetWatchdog();
  }

  private setMode(newMode: DeviceMode): void {
    const oldMode = this.mode;
    this.mode = newMode;

    if (oldMode !== newMode) {
      // Entering a running state
      if (this.isRunning() && (oldMode === 'idle' || oldMode === 'complete')) {
        this.testStartTime = Date.now();
        this.lastEnergyUpdateTime = Date.now();
        this.energyMwh = 0;
        this.capTracker.reset();
        this.capacityMah = 0;
        this.peakVoltage = 0;
        this.minVoltage = Infinity;
        this.peakCurrent = 0;
      }

      // Leaving a running state
      if (
        (newMode === 'idle' || newMode === 'complete') &&
        (oldMode === 'd-cc' || oldMode === 'd-cp' || oldMode === 'c-cv')
      ) {
        // Test completed or stopped — disarm host-side time limit
        this.hostMaxTimeMin = 0;
        this.lastTimeLimitStopAt = 0;
      }

      this.emit({ type: 'stateChange', from: oldMode, to: newMode });
    }
  }

  // ── Commands ───────────────────────────────────────────────────

  private async sendPayload(payload: number[]): Promise<void> {
    await this.serial.sendPacket(Buffer.from(payload));
  }

  private setPending(command: string, expectedMode: DeviceMode | null): void {
    this.pendingCommand = { command, sentAt: Date.now(), expectedMode };
    this.emit({ type: 'commandPending', data: this.pendingCommand });

    this.clearCommandTimeout();
    this.commandTimeoutTimer = setTimeout(() => {
      if (this.pendingCommand?.command === command) {
        this.emit({ type: 'commandTimeout', data: { command } });
        this.pendingCommand = null;
      }
    }, this.COMMAND_TIMEOUT_MS);
  }

  private clearCommandTimeout(): void {
    if (this.commandTimeoutTimer) {
      clearTimeout(this.commandTimeoutTimer);
      this.commandTimeoutTimer = null;
    }
  }

  /** Send init command (0x05) to start measurement stream */
  async sendInit(): Promise<void> {
    this.initSent = true;
    await this.sendPayload([0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    logger.info('Sent init (0x05)');
  }

  /**
   * Send stop command (0x02 load toggle) to halt a running test.
   * @param reason Why the host is stopping ('manual', 'time_limit', 'temp_alert', ...) —
   *               recorded by TestRecorder as the run's end_reason.
   */
  async stop(reason: string = 'manual'): Promise<void> {
    this.lastStopReason = reason;
    this.setPending('stop', 'idle');
    await this.sendPayload([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    logger.info(`Sent stop (0x02, reason=${reason})`);
  }

  /**
   * Return and clear the reason for the most recent host-initiated stop.
   * Used by TestRecorder when the device transitions to idle so the run's
   * end_reason distinguishes 'time_limit' from a manual stop.
   */
  consumeStopReason(): string | null {
    const reason = this.lastStopReason;
    this.lastStopReason = null;
    return reason;
  }

  /**
   * Arm host-side max-time enforcement for the test being started.
   * @param maxTimeMin The step's time limit (0 = no limit)
   * @param deviceEnforced True when the limit was also sent to the device
   *        (D-CC/D-CP) — the host then only acts as a +1 min backstop.
   */
  private armTimeLimit(maxTimeMin: number, deviceEnforced: boolean): void {
    this.hostMaxTimeMin = maxTimeMin > 0 ? maxTimeMin + (deviceEnforced ? 1 : 0) : 0;
    this.lastTimeLimitStopAt = 0;
    this.lastStopReason = null;
  }

  /**
   * Start D-CC discharge
   * @param currentA Discharge current in amps (0.01–40.00)
   * @param cutoffV  Under-voltage cutoff in volts
   * @param maxTimeMin Maximum time in minutes (0 = no limit)
   */
  async startDCC(currentA: number, cutoffV: number, maxTimeMin: number = 0): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    const [tHi, tLo] = encodeBase240(maxTimeMin, 1);
    this.armTimeLimit(maxTimeMin, true);
    this.setPending('startDCC', 'd-cc');
    await this.sendPayload([0x01, iHi, iLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CC start: ${currentA}A, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Continue D-CC discharge with (optionally updated) setpoints.
   *
   * CAUTION (real-hardware capture 2026-07-16, EBC-A40L): a 0x08 sent
   * while a test is RUNNING is silently ignored — it does NOT update
   * setpoints. EB Tester uses it to resume after pausing. For mid-run
   * setpoint changes use adjustDCC (CMD 0x07) instead.
   */
  async continueDCC(currentA: number, cutoffV: number, maxTimeMin: number = 0): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    const [tHi, tLo] = encodeBase240(maxTimeMin, 1);
    this.armTimeLimit(maxTimeMin, true);
    await this.sendPayload([0x08, iHi, iLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CC continue: ${currentA}A, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Adjust D-CC setpoints MID-RUN via CMD 0x07 (EB Tester's "Adjust"
   * button, enabled only during D-CC). Confirmed on real hardware
   * (2026-07-16, EBC-A40L): current follows within ~1 frame and the
   * device's capacity accumulator keeps counting — unlike 0x08/0x01,
   * which are ignored while a test runs. Only send while the device is
   * actually in d-cc; the effect from other states is uncharacterized.
   */
  async adjustDCC(currentA: number, cutoffV: number, maxTimeMin: number = 0): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    const [tHi, tLo] = encodeBase240(maxTimeMin, 1);
    this.armTimeLimit(maxTimeMin, true);
    await this.sendPayload([0x07, iHi, iLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CC adjust (0x07): ${currentA}A, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Start D-CP discharge (constant power)
   * @param powerW   Power in watts (raw, no divisor)
   * @param cutoffV  Under-voltage cutoff in volts
   * @param maxTimeMin Maximum time in minutes (0 = no limit)
   */
  async startDCP(powerW: number, cutoffV: number, maxTimeMin: number = 0): Promise<void> {
    const [pHi, pLo] = encodeBase240(powerW, 1); // raw watts, no divisor
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    const [tHi, tLo] = encodeBase240(maxTimeMin, 1); // raw minutes
    this.armTimeLimit(maxTimeMin, true);
    this.setPending('startDCP', 'd-cp');
    await this.sendPayload([0x11, pHi, pLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CP start: ${powerW}W, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Continue D-CP discharge with (optionally updated) setpoints
   */
  async continueDCP(powerW: number, cutoffV: number, maxTimeMin: number = 0): Promise<void> {
    const [pHi, pLo] = encodeBase240(powerW, 1);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    const [tHi, tLo] = encodeBase240(maxTimeMin, 1);
    this.armTimeLimit(maxTimeMin, true);
    await this.sendPayload([0x18, pHi, pLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CP continue: ${powerW}W, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Start C-CV charge
   * @param currentA     Max charge current in amps
   * @param targetV      Target voltage (CV setpoint)
   * @param cutoffCurrentA  Minimum current to end charge
   * @param maxTimeMin   Maximum time in minutes (0 = no limit). The C-CV frame
   *                     has no time field, so this is enforced host-side only
   *                     (matching EB Tester's client-side timer behavior).
   */
  async startCCV(currentA: number, targetV: number, cutoffCurrentA: number, maxTimeMin: number = 0): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(targetV, EbcDivisors.setpointVoltage);
    const [cHi, cLo] = encodeBase240(cutoffCurrentA, EbcDivisors.cutoffCurrent);
    this.armTimeLimit(maxTimeMin, false);
    this.setPending('startCCV', 'c-cv');
    await this.sendPayload([0x21, iHi, iLo, vHi, vLo, cHi, cLo]);
    logger.info(
      `Sent C-CV start: ${currentA}A, target ${targetV}V, cutoff ${cutoffCurrentA}A, max ${maxTimeMin}min (host-enforced)`
    );
  }

  /**
   * Continue C-CV charge with (optionally updated) setpoints
   */
  async continueCCV(currentA: number, targetV: number, cutoffCurrentA: number, maxTimeMin: number = 0): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(targetV, EbcDivisors.setpointVoltage);
    const [cHi, cLo] = encodeBase240(cutoffCurrentA, EbcDivisors.cutoffCurrent);
    this.armTimeLimit(maxTimeMin, false);
    await this.sendPayload([0x28, iHi, iLo, vHi, vLo, cHi, cLo]);
    logger.info(
      `Sent C-CV continue: ${currentA}A, target ${targetV}V, cutoff ${cutoffCurrentA}A, max ${maxTimeMin}min (host-enforced)`
    );
  }

  /** Send heartbeat (0x0A) with incrementing counter */
  async sendHeartbeat(): Promise<void> {
    this.heartbeatCounter = (this.heartbeatCounter + 1) % 240;
    const [cHi, cLo] = encodeBase240(this.heartbeatCounter, 1);
    await this.sendPayload([0x0a, 0x00, cLo, 0x00, 0x00, 0x00, 0x00]);
  }

  // ── Heartbeat management ──────────────────────────────────────

  private resetHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(async () => {
      try {
        await this.sendHeartbeat();
      } catch (e) {
        logger.error('Heartbeat send failed:', e);
      }
      this.resetHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Device-responsive watchdog ─────────────────────────────────

  private resetWatchdog(): void {
    this.stopWatchdog();
    if (!this.deviceResponsive) {
      this.deviceResponsive = true;
      this.emit({ type: 'deviceResponsive' });
    }
    this.watchdogTimer = setTimeout(() => {
      if (this.deviceResponsive) {
        this.deviceResponsive = false;
        logger.warn(
          'Device watchdog: no packets received in ' + `${this.WATCHDOG_TIMEOUT_MS / 1000}s — marking unresponsive`
        );
        this.emit({ type: 'deviceUnresponsive' });
      }
    }, this.WATCHDOG_TIMEOUT_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ── Init probe ────────────────────────────────────────────────

  /**
   * Schedule an init probe: if no packets arrive within INIT_WAIT_MS,
   * send init (0x05) to wake the device and start its data stream.
   */
  private scheduleInitProbe(): void {
    this.clearInitTimer();
    this.initTimer = setTimeout(async () => {
      if (!this.firstPacketReceived && !this.initSent) {
        logger.info(`No packets received after ${this.INIT_WAIT_MS}ms — sending init to start data stream`);
        try {
          await this.sendInit();
        } catch (e) {
          logger.error('Init probe failed:', e);
        }
      }
    }, this.INIT_WAIT_MS);
  }

  private clearInitTimer(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
  }
}
