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
  /** Capacity in mAh (device-reported) */
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
  | { type: 'commandTimeout'; data: { command: string } };

type SessionListener = (event: SessionEvent) => void;

// ── State byte → mode mapping ──────────────────────────────────────

function stateByteToMode(state: number): DeviceMode {
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

  // Test timing
  private testStartTime = 0;
  private lastEnergyUpdateTime = 0;

  // Heartbeat
  private heartbeatTimer: Timer | null = null;
  private heartbeatCounter = 0;
  private readonly HEARTBEAT_INTERVAL_MS = 55_000;

  // Command tracking
  private pendingCommand: PendingCommand | null = null;
  private commandTimeoutTimer: Timer | null = null;
  private readonly COMMAND_TIMEOUT_MS = 5_000;

  // Track peak/min for test run stats
  private peakVoltage = 0;
  private minVoltage = Infinity;
  private peakCurrent = 0;

  constructor(private serial: SerialManager) {}

  /** Start listening to serial packets and managing the session */
  start(): void {
    this.unsubPacket = this.serial.addPacketListener(packet => this.onPacket(packet));
    this.unsubConnection = this.serial.addConnectionListener(connected => {
      if (connected) {
        this.emit({ type: 'connected' });
      } else {
        this.emit({ type: 'disconnected' });
        this.stopHeartbeat();
      }
    });
  }

  /** Stop listening and clean up timers */
  destroy(): void {
    this.unsubPacket?.();
    this.unsubConnection?.();
    this.stopHeartbeat();
    this.clearCommandTimeout();
  }

  /** Subscribe to session events */
  on(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (e) { logger.error('Session listener error:', e); }
    }
  }

  // ── Getters ────────────────────────────────────────────────────

  getMode(): DeviceMode { return this.mode; }
  getDeviceInfo(): DeviceInfo | null { return this.deviceInfo; }

  getReading(): DecodedReading {
    const elapsedS = this.mode !== 'idle' && this.testStartTime > 0
      ? (Date.now() - this.testStartTime) / 1000
      : 0;
    return {
      mode: this.mode,
      stateByte: 0,
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

  getPendingCommand(): PendingCommand | null { return this.pendingCommand; }

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

    // First packet: decide whether to send init
    if (!this.firstPacketReceived) {
      this.firstPacketReceived = true;
      const mode = stateByteToMode(stateByte);
      if (mode !== 'idle') {
        // Device is mid-test — pick up state without sending init
        logger.info(`Device is mid-test (state=0x${stateByte.toString(16)}, mode=${mode}). Recovering.`);
        this.setMode(mode);
        this.testStartTime = now;
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
      return;
    }

    // Update readings
    this.voltage = voltage;
    this.current = currentRaw;
    this.capacityMah = capacityMah;
    this.lastReadingTimestamp = now;

    // Host-side energy integration (device bytes 7-8 are always 0 on A40L)
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
    const elapsedS = this.testStartTime > 0 && this.isRunning()
      ? (now - this.testStartTime) / 1000
      : 0;

    const reading: DecodedReading = {
      mode: this.mode,
      stateByte,
      voltage,
      current: currentRaw,
      power: voltage * currentRaw,
      capacityMah,
      capacityAh: capacityMah / 1000,
      energyMwh: this.energyMwh,
      energyWh: this.energyMwh / 1000,
      elapsedS,
      timestamp: now,
      isInfoPacket: false,
    };

    this.emit({ type: 'reading', data: reading });
    this.resetHeartbeat();
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
        this.peakVoltage = 0;
        this.minVoltage = Infinity;
        this.peakCurrent = 0;
      }

      // Leaving a running state
      if ((newMode === 'idle' || newMode === 'complete') &&
          (oldMode === 'd-cc' || oldMode === 'd-cp' || oldMode === 'c-cv')) {
        // Test completed or stopped
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

  /** Send stop command (0x02 load toggle) to halt a running test */
  async stop(): Promise<void> {
    this.setPending('stop', 'idle');
    await this.sendPayload([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    logger.info('Sent stop (0x02)');
  }

  /**
   * Start D-CC discharge
   * @param currentA Discharge current in amps (0.01–40.00)
   * @param cutoffV  Under-voltage cutoff in volts
   */
  async startDCC(currentA: number, cutoffV: number): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    this.setPending('startDCC', 'd-cc');
    await this.sendPayload([0x01, iHi, iLo, vHi, vLo, 0x00, 0x00]);
    logger.info(`Sent D-CC start: ${currentA}A, cutoff ${cutoffV}V`);
  }

  /**
   * Continue D-CC discharge with (optionally updated) setpoints
   */
  async continueDCC(currentA: number, cutoffV: number): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
    await this.sendPayload([0x08, iHi, iLo, vHi, vLo, 0x00, 0x00]);
    logger.info(`Sent D-CC continue: ${currentA}A, cutoff ${cutoffV}V`);
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
    await this.sendPayload([0x18, pHi, pLo, vHi, vLo, tHi, tLo]);
    logger.info(`Sent D-CP continue: ${powerW}W, cutoff ${cutoffV}V, max ${maxTimeMin}min`);
  }

  /**
   * Start C-CV charge
   * @param currentA     Max charge current in amps
   * @param targetV      Target voltage (CV setpoint)
   * @param cutoffCurrentA  Minimum current to end charge
   */
  async startCCV(currentA: number, targetV: number, cutoffCurrentA: number): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(targetV, EbcDivisors.setpointVoltage);
    const [cHi, cLo] = encodeBase240(cutoffCurrentA, EbcDivisors.cutoffCurrent);
    this.setPending('startCCV', 'c-cv');
    await this.sendPayload([0x21, iHi, iLo, vHi, vLo, cHi, cLo]);
    logger.info(`Sent C-CV start: ${currentA}A, target ${targetV}V, cutoff ${cutoffCurrentA}A`);
  }

  /**
   * Continue C-CV charge with (optionally updated) setpoints
   */
  async continueCCV(currentA: number, targetV: number, cutoffCurrentA: number): Promise<void> {
    const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
    const [vHi, vLo] = encodeBase240(targetV, EbcDivisors.setpointVoltage);
    const [cHi, cLo] = encodeBase240(cutoffCurrentA, EbcDivisors.cutoffCurrent);
    await this.sendPayload([0x28, iHi, iLo, vHi, vLo, cHi, cLo]);
    logger.info(`Sent C-CV continue: ${currentA}A, target ${targetV}V, cutoff ${cutoffCurrentA}A`);
  }

  /** Send heartbeat (0x0A) with incrementing counter */
  async sendHeartbeat(): Promise<void> {
    this.heartbeatCounter = (this.heartbeatCounter + 1) % 240;
    const [cHi, cLo] = encodeBase240(this.heartbeatCounter, 1);
    await this.sendPayload([0x0A, 0x00, cLo, 0x00, 0x00, 0x00, 0x00]);
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
}
