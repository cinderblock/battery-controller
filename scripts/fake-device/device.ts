/**
 * FakeDevice — synthetic ZKETech device.
 *
 * Owns the mutable state, interprets incoming TX frames from the VB6 app,
 * and produces RX frames according to the active profile. Consumes raw
 * bytes (from whatever transport — virtual COM, TCP, unit test) and emits
 * raw bytes for the transport to send back.
 *
 * This file has ZERO transport concerns. The caller owns the wire.
 *
 * Key design choice: the device maintains a periodic response timer. Real
 * ZKETech devices emit a fresh RX packet every ~500ms regardless of
 * whether the host just sent a command — the fake mirrors this so timing-
 * sensitive VB6 behavior surfaces.
 *
 * TX-triggered responses (immediate reply to a command) are merged with
 * the next periodic packet rather than sent as extra packets, unless the
 * command is `init` (0x05), which sets `pendingInfo=true` so the next
 * emission is an info packet.
 */

import {
  buildTxFrame,
  checksum,
  decodeBase240,
  decodeTxFrame,
  encodeBase240,
  fromHex,
  parseFrame,
  scanForFrames,
  toHex,
} from '../../src/protocol/codec.ts';
import {
  Base240Modulus,
  EndToken,
  INFO_STATE_OFFSET,
  RxPacketLength,
  RxPayloadLength,
  StartToken,
  TxPacketLength,
} from '../../src/protocol/constants.ts';
import type { Profile } from './profiles/index.ts';
import type { DeviceMode, DeviceState, LogEntry, LogSubscriber } from './types.ts';

// ── TX command bytes we care about ────────────────────────────────────
// Taken from protocol.md and src/protocol/codec.ts. Action = cmd & 0x0F,
// mode = cmd & 0xF0. Only Action values matter for state transitions;
// the mode offset determines which DeviceMode we enter.

const ACTION_START = 0x01;
const ACTION_TOGGLE = 0x02;
const ACTION_CALIBRATE = 0x04;
const ACTION_INIT = 0x05;
const ACTION_STOP = 0x06;
const ACTION_CONFIGURE = 0x07;
const ACTION_CONTINUE = 0x08;
const ACTION_RESISTANCE = 0x09;
const ACTION_HEARTBEAT = 0x0a;

const MODE_DISCHARGE_CC = 0x00;
const MODE_DISCHARGE_CP = 0x10;
const MODE_CHARGE_CV = 0x20;
const MODE_CHARGE_NIMH = 0x30;
const MODE_CHARGE_NICD = 0x40;
const MODE_CHARGE_LIPO = 0x50;
const MODE_CHARGE_LIFE = 0x60;
const MODE_CHARGE_VRLA = 0x70;

const CHARGE_MODES = new Set([
  MODE_CHARGE_CV,
  MODE_CHARGE_NIMH,
  MODE_CHARGE_NICD,
  MODE_CHARGE_LIPO,
  MODE_CHARGE_LIFE,
  MODE_CHARGE_VRLA,
]);

const DISCHARGE_MODES = new Set([MODE_DISCHARGE_CC, MODE_DISCHARGE_CP]);

// ── Log ring buffer size ──────────────────────────────────────────────
const LOG_CAPACITY = 1000;

export interface FakeDeviceOptions {
  profile: Profile;
  /** Called with raw bytes the device wants to transmit (RX frames). */
  onTransmit: (bytes: Uint8Array) => void;
}

export class FakeDevice {
  readonly profile: Profile;
  private state: DeviceState;
  private readonly onTransmit: (bytes: Uint8Array) => void;

  // Frame reassembly from byte stream
  private rxByteBuffer = new Uint8Array(0);

  // Timers
  private cadenceTimer: ReturnType<typeof setInterval> | null = null;
  private simLastMs = 0;

  // Log ring + subscribers
  private log: LogEntry[] = [];
  private subscribers = new Set<LogSubscriber>();

  // TX -> response overrides (by command byte)
  private responseOverrides = new Map<number, Uint8Array>();

  // Flags affecting next emission
  private pendingInfo = false;

  // Counters (exposed via /status)
  private rxFrameCount = 0; // frames we emitted
  private txFrameCount = 0; // frames we received
  private startedAt = 0;

  constructor(opts: FakeDeviceOptions) {
    this.profile = opts.profile;
    this.onTransmit = opts.onTransmit;
    this.state = this.makeDefaultState();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Start the periodic response loop. */
  start(): void {
    this.startedAt = performance.now();
    this.simLastMs = this.startedAt;
    this.scheduleCadence();
    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'note',
      summary: `FakeDevice started (profile=${this.profile.name})`,
    });
  }

  /** Stop the cadence timer. Transport cleanup is the caller's job. */
  stop(): void {
    if (this.cadenceTimer) {
      clearInterval(this.cadenceTimer);
      this.cadenceTimer = null;
    }
  }

  // ── State access ────────────────────────────────────────────────────

  getState(): DeviceState {
    return { ...this.state };
  }

  /**
   * Merge an update into state. Unknown keys are rejected (strict mode so
   * typos in the control API surface as errors).
   *
   * If `cadenceMs` changes, the timer is rescheduled.
   */
  patchState(patch: Partial<DeviceState>): DeviceState {
    const allowed: (keyof DeviceState)[] = [
      'mode',
      'current',
      'voltage',
      'capacity',
      'currentSetpoint',
      'voltageSetpoint',
      'cutoffCurrent',
      'step',
      'errors',
      'auto',
      'autoRateVPerMin',
      'cadenceMs',
    ];
    for (const key of Object.keys(patch)) {
      if (!(allowed as string[]).includes(key)) {
        throw new Error(`Unknown state key '${key}'. Allowed: ${allowed.join(', ')}`);
      }
    }

    const prevCadence = this.state.cadenceMs;
    this.state = { ...this.state, ...patch };
    if (this.state.cadenceMs !== prevCadence) {
      this.scheduleCadence();
    }

    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'state',
      summary: `state patch: ${Object.keys(patch).join(', ')}`,
      decoded: patch as Record<string, unknown>,
    });
    return this.getState();
  }

  reset(): DeviceState {
    this.state = this.makeDefaultState();
    this.pendingInfo = false;
    this.scheduleCadence();
    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'state',
      summary: 'state reset',
    });
    return this.getState();
  }

  // ── Log access ──────────────────────────────────────────────────────

  getLog(limit = 50): LogEntry[] {
    if (limit >= this.log.length) return [...this.log];
    return this.log.slice(this.log.length - limit);
  }

  subscribe(cb: LogSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  note(text: string): void {
    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'note',
      summary: `note: ${text}`,
      note: text,
    });
  }

  // ── Overrides ───────────────────────────────────────────────────────

  setResponseOverride(cmd: number, bytes: Uint8Array): void {
    if (bytes.length !== RxPacketLength) {
      throw new Error(`Override must be exactly ${RxPacketLength} bytes, got ${bytes.length}`);
    }
    if (bytes[0] !== StartToken || bytes[bytes.length - 1] !== EndToken) {
      throw new Error(`Override must start with 0x${StartToken.toString(16)} and end with 0x${EndToken.toString(16)}`);
    }
    this.responseOverrides.set(cmd, new Uint8Array(bytes));
  }

  clearResponseOverride(cmd: number): boolean {
    return this.responseOverrides.delete(cmd);
  }

  listOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [cmd, bytes] of this.responseOverrides) {
      out[`0x${cmd.toString(16).padStart(2, '0')}`] = toHex(bytes);
    }
    return out;
  }

  // ── Identity (info-packet bytes 14/15/16 + advertised max I/V) ─────
  //
  // Hot-patches the live profile so we can sweep the EB Tester's device
  // recognition without restarting the fake device. Mutates profile in
  // place — restart to restore defaults. Used by /identity PATCH.

  setIdentity(patch: {
    deviceTypeByte?: number;
    deviceSubtypeByte?: number;
    deviceConstantByte?: number;
    infoMaxCurrent?: number;
    infoMaxVoltage?: number;
  }): void {
    // Type check: all byte fields must be 0..0xEF so they survive the
    // base-240 clamp. Silently clamping would hide bad probes.
    const byteFields = ['deviceTypeByte', 'deviceSubtypeByte', 'deviceConstantByte'] as const;
    for (const k of byteFields) {
      const v = patch[k];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 0 || v > 0xef) {
          throw new Error(`${k} must be 0..0xEF (got ${v})`);
        }
      }
    }
    if (patch.deviceTypeByte !== undefined) this.profile.deviceTypeByte = patch.deviceTypeByte;
    if (patch.deviceSubtypeByte !== undefined) this.profile.deviceSubtypeByte = patch.deviceSubtypeByte;
    if (patch.deviceConstantByte !== undefined) this.profile.deviceConstantByte = patch.deviceConstantByte;
    if (patch.infoMaxCurrent !== undefined) this.profile.infoMaxCurrent = patch.infoMaxCurrent;
    if (patch.infoMaxVoltage !== undefined) this.profile.infoMaxVoltage = patch.infoMaxVoltage;
  }

  /**
   * Mark the next periodic emission as an info packet (state byte offset
   * +0x64). Normally this only happens in response to CMD 0x05 (init);
   * exposed here for the identity-sweep probe, which needs to force the
   * UI to re-read bytes 14/15/16.
   */
  triggerInfo(): void {
    this.pendingInfo = true;
  }

  getIdentity(): {
    deviceTypeByte: number;
    deviceSubtypeByte: number;
    deviceConstantByte: number;
    infoMaxCurrent: number;
    infoMaxVoltage: number;
  } {
    return {
      deviceTypeByte: this.profile.deviceTypeByte,
      deviceSubtypeByte: this.profile.deviceSubtypeByte,
      deviceConstantByte: this.profile.deviceConstantByte,
      infoMaxCurrent: this.profile.infoMaxCurrent,
      infoMaxVoltage: this.profile.infoMaxVoltage,
    };
  }

  // ── Status ──────────────────────────────────────────────────────────

  getStatus(): Record<string, unknown> {
    return {
      profile: this.profile.name,
      uptimeMs: performance.now() - this.startedAt,
      txFramesReceived: this.txFrameCount,
      rxFramesEmitted: this.rxFrameCount,
      overrides: this.listOverrides(),
      pendingInfo: this.pendingInfo,
      identity: this.getIdentity(),
      state: this.getState(),
    };
  }

  // ── Byte ingestion (called by transport) ────────────────────────────

  /**
   * Feed bytes received from the host (VB6 app) into the device. Scans
   * for complete TX frames and dispatches each one.
   */
  ingestBytes(bytes: Uint8Array): void {
    // Append to reassembly buffer
    const combined = new Uint8Array(this.rxByteBuffer.length + bytes.length);
    combined.set(this.rxByteBuffer);
    combined.set(bytes, this.rxByteBuffer.length);
    const scan = scanForFrames(combined, TxPacketLength);
    this.rxByteBuffer = scan.remainder;
    for (const raw of scan.frames) {
      this.handleTxFrame(raw);
    }
  }

  /**
   * Inject a raw RX frame onto the wire immediately. Bypasses state
   * generation entirely — use this to probe "what does the UI do if the
   * device sends exactly these bytes?"
   */
  injectRx(bytes: Uint8Array): void {
    this.emitRaw(bytes, 'injected');
  }

  // ── Internals ───────────────────────────────────────────────────────

  private makeDefaultState(): DeviceState {
    return {
      mode: 'idle',
      current: this.profile.defaults.current,
      voltage: this.profile.defaults.voltage,
      capacity: 0,
      currentSetpoint: 0,
      voltageSetpoint: 0,
      cutoffCurrent: 0,
      step: 0,
      errors: 0,
      auto: false,
      autoRateVPerMin: 0.1,
      cadenceMs: this.profile.responseCadenceMs,
    };
  }

  private scheduleCadence(): void {
    if (this.cadenceTimer) clearInterval(this.cadenceTimer);
    this.cadenceTimer = setInterval(() => this.onCadenceTick(), this.state.cadenceMs);
  }

  private onCadenceTick(): void {
    this.simulateTick();
    const isInfo = this.pendingInfo;
    const frame = isInfo ? this.buildInfoFrame() : this.buildCurrentFrame();
    this.pendingInfo = false;
    this.emitRaw(frame, isInfo ? 'info' : 'periodic');
  }

  /** Evolve state if auto=true. No-op otherwise. */
  private simulateTick(): void {
    const now = performance.now();
    const dtMin = (now - this.simLastMs) / 60_000;
    this.simLastMs = now;

    if (!this.state.auto) return;

    if (this.state.mode === 'charging') {
      const rate = this.state.autoRateVPerMin;
      this.state.voltage = Math.min(this.state.voltage + rate * dtMin, this.state.voltageSetpoint);
      // Current stays at setpoint until CV phase; simple model keeps it flat.
      this.state.current = this.state.currentSetpoint;
      this.state.capacity += this.state.current * 1000 * (dtMin / 60);
      // Crude completion: voltage reached setpoint and cutoffCurrent > 0
      if (this.state.voltage >= this.state.voltageSetpoint - 1e-6 && this.state.current <= this.state.cutoffCurrent) {
        this.state.mode = 'complete';
      }
    } else if (this.state.mode === 'discharging') {
      const rate = this.state.autoRateVPerMin;
      this.state.voltage = Math.max(this.state.voltage - rate * dtMin, this.state.voltageSetpoint);
      this.state.current = this.state.currentSetpoint;
      this.state.capacity += this.state.current * 1000 * (dtMin / 60);
      if (this.state.voltage <= this.state.voltageSetpoint + 1e-6) {
        this.state.mode = 'idle';
      }
    }
  }

  // ── Frame handlers ──────────────────────────────────────────────────

  private handleTxFrame(raw: Uint8Array): void {
    this.txFrameCount++;
    const parsed = parseFrame(raw, 'tx');
    if (!parsed) {
      this.pushLog({
        t: new Date().toISOString(),
        mono: performance.now(),
        dir: 'tx',
        hex: toHex(raw),
        summary: 'TX (unparseable)',
      });
      return;
    }

    const decoded = decodeTxFrame(parsed, this.profile.family);
    const cmd = parsed.command;
    const action = cmd & 0x0f;
    const modeOffset = cmd & 0xf0;

    // Log the incoming TX before we mutate anything.
    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'tx',
      hex: toHex(raw),
      summary: `TX ${decoded.commandName}`,
      decoded: {
        command: `0x${cmd.toString(16).padStart(2, '0')}`,
        commandName: decoded.commandName,
        currentSetpoint: decoded.currentSetpoint,
        cutoffVoltage: decoded.cutoffVoltage,
        cutoffCurrent: decoded.cutoffCurrent,
      },
      checksumValid: parsed.checksumValid,
    });

    // Apply state changes based on the action.
    switch (action) {
      case ACTION_INIT:
        // Host is asking "who are you?" — next emission is the info packet.
        this.pendingInfo = true;
        break;

      case ACTION_STOP:
        this.state.mode = 'idle';
        this.state.current = 0;
        this.state.currentSetpoint = 0;
        this.state.voltageSetpoint = 0;
        this.state.cutoffCurrent = 0;
        break;

      case ACTION_START:
      case ACTION_CONTINUE:
        if (decoded.currentSetpoint !== undefined) this.state.currentSetpoint = decoded.currentSetpoint;
        if (decoded.cutoffVoltage !== undefined) this.state.voltageSetpoint = decoded.cutoffVoltage;
        if (decoded.cutoffCurrent !== undefined) this.state.cutoffCurrent = decoded.cutoffCurrent;
        if (CHARGE_MODES.has(modeOffset)) {
          this.state.mode = 'charging';
          this.state.current = this.state.currentSetpoint;
        } else if (DISCHARGE_MODES.has(modeOffset)) {
          this.state.mode = 'discharging';
          this.state.current = this.state.currentSetpoint;
        }
        break;

      case ACTION_TOGGLE:
        // Observed behavior: toggles "load on" during active test. Unclear
        // exactly how it interacts with mode — flip between idle and the
        // previous active mode for now.
        this.state.mode = this.state.mode === 'idle' ? 'discharging' : 'idle';
        if (this.state.mode === 'idle') this.state.current = 0;
        break;

      case ACTION_HEARTBEAT:
      case ACTION_CONFIGURE:
      case ACTION_CALIBRATE:
      case ACTION_RESISTANCE:
        // No confirmed state change for these yet. Keep a placeholder so
        // we can observe app behavior.
        break;

      default:
        // Unknown action — don't mutate state, just log it. The response
        // will reflect current state unchanged.
        break;
    }

    // Send the override response if one is registered, else let the
    // normal cadence do its thing.
    const override = this.responseOverrides.get(cmd);
    if (override) {
      this.emitRaw(override, `override for 0x${cmd.toString(16)}`);
    }
  }

  // ── Frame generation ────────────────────────────────────────────────

  /** Build the normal periodic RX frame from current state. */
  private buildCurrentFrame(): Uint8Array {
    const stateByte = this.stateByteForMode(this.state.mode);
    return this.buildRxFrame({
      stateByte,
      current: this.state.current,
      voltage: this.state.voltage,
      field6_7: this.state.capacity, // capacity on EBC family
      field8_9: 0, // unknown slot — always 0 on A40L captures
      field10_11: this.state.currentSetpoint,
      field12_13: this.state.voltageSetpoint,
      byte14: this.state.step,
      byte15: Math.round(this.state.cutoffCurrent * this.profile.divisors.cutoffCurrent),
      byte16: this.profile.deviceConstantByte,
    });
  }

  /** Build the info (identify) RX frame — triggered by TX init. */
  private buildInfoFrame(): Uint8Array {
    // Info packet state = idleState + INFO_STATE_OFFSET
    const stateByte = (this.profile.idleState + INFO_STATE_OFFSET) % Base240Modulus;
    return this.buildRxFrame({
      stateByte,
      current: 0,
      voltage: 0,
      field6_7: 0,
      field8_9: 0,
      field10_11: this.profile.infoMaxCurrent,
      field12_13: this.profile.infoMaxVoltage,
      byte14: this.profile.deviceTypeByte,
      byte15: this.profile.deviceSubtypeByte,
      byte16: this.profile.deviceConstantByte,
    });
  }

  private stateByteForMode(mode: DeviceMode): number {
    switch (mode) {
      case 'idle':
        return this.profile.idleState;
      case 'charging':
        return this.profile.chargingState ?? this.profile.idleState;
      case 'discharging':
        return this.profile.dischargingState ?? this.profile.idleState;
      case 'complete':
        return this.profile.chargeCompleteState ?? this.profile.idleState;
      case 'fault':
        // No confirmed fault state byte. 0xFF wouldn't fit base-240, so
        // use 0xEE as an obvious-looking "something's wrong" marker until
        // we learn the real value.
        return 0xee;
    }
  }

  /**
   * Build a 19-byte RX frame. Takes numeric field values and a profile
   * for divisors; writes them as base-240 pairs and appends checksum+end.
   *
   * Fields whose raw byte meaning is "single byte" are passed directly as
   * bytes (byte14/15/16). Fields whose meaning is a number are encoded
   * with their natural divisor.
   */
  private buildRxFrame(fields: {
    stateByte: number;
    current: number;
    voltage: number;
    field6_7: number;
    field8_9: number;
    field10_11: number;
    field12_13: number;
    byte14: number;
    byte15: number;
    byte16: number;
  }): Uint8Array {
    const d = this.profile.divisors;
    const payload = new Uint8Array(RxPayloadLength);
    payload[0] = fields.stateByte;
    [payload[1], payload[2]] = encodeBase240(fields.current, d.current);
    [payload[3], payload[4]] = encodeBase240(fields.voltage, d.voltage);
    // field6_7: EBC = capacity raw mAh (divisor 1). Guard against
    // divisor=0 ("not applicable") to keep the math sane.
    const capDiv = d.capacity === 0 ? 1 : d.capacity;
    [payload[5], payload[6]] = encodeBase240(fields.field6_7, capDiv);
    [payload[7], payload[8]] = encodeBase240(fields.field8_9, capDiv);
    [payload[9], payload[10]] = encodeBase240(fields.field10_11, d.current);
    [payload[11], payload[12]] = encodeBase240(fields.field12_13, d.setpointVoltage);
    payload[13] = fields.byte14 & 0xff;
    payload[14] = fields.byte15 & 0xff;
    payload[15] = fields.byte16 & 0xff;

    // Enforce base-240 constraint: any payload byte >= 0xF0 would collide
    // with frame markers. Clamp with a warning so the transport doesn't
    // corrupt the stream.
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] >= 0xf0) {
        this.note(`payload byte ${i} clamped: ${payload[i]} -> ${Base240Modulus - 1}`);
        payload[i] = Base240Modulus - 1;
      }
    }

    const frame = new Uint8Array(RxPacketLength);
    frame[0] = StartToken;
    frame.set(payload, 1);
    frame[RxPacketLength - 2] = checksum(payload);
    frame[RxPacketLength - 1] = EndToken;
    return frame;
  }

  /** Send raw bytes and log them as RX. */
  private emitRaw(bytes: Uint8Array, label: string): void {
    this.onTransmit(bytes);
    this.rxFrameCount++;
    const parsed = parseFrame(bytes, 'rx');
    const summary = `RX ${label}`;
    this.pushLog({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'rx',
      hex: toHex(bytes),
      summary,
      decoded: parsed
        ? {
            state: `0x${parsed.command.toString(16).padStart(2, '0')}`,
            checksumValid: parsed.checksumValid,
          }
        : undefined,
      checksumValid: parsed?.checksumValid,
    });
  }

  private pushLog(entry: LogEntry): void {
    this.log.push(entry);
    if (this.log.length > LOG_CAPACITY) {
      this.log.splice(0, this.log.length - LOG_CAPACITY);
    }
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        // Swallow — a bad subscriber shouldn't break the device.
      }
    }
  }
}

// ── Helpers for consumers (e.g. control API) ─────────────────────────

/**
 * Build a raw RX frame with an arbitrary base-240 payload. Useful for
 * the /inject endpoint when exploring unknown bytes.
 *
 * The caller supplies the 16-byte payload. This function just wraps it
 * with start, checksum, end. It does NOT validate that all bytes < 0xF0
 * — that's intentional, since exploring what happens with 0xF? bytes
 * (which would collide with frame markers) is exactly the kind of
 * unexpected input we want to probe.
 */
export function wrapRawPayload(payload: Uint8Array): Uint8Array {
  if (payload.length !== RxPayloadLength) {
    throw new Error(`Payload must be ${RxPayloadLength} bytes, got ${payload.length}`);
  }
  const frame = new Uint8Array(RxPacketLength);
  frame[0] = StartToken;
  frame.set(payload, 1);
  frame[RxPacketLength - 2] = checksum(payload);
  frame[RxPacketLength - 1] = EndToken;
  return frame;
}

/** Re-export for control API convenience. */
export { buildTxFrame, decodeBase240, decodeTxFrame, encodeBase240, fromHex, parseFrame, toHex };
