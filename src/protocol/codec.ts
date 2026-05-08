/**
 * Protocol codec: checksum, base-240 encoding, frame building/parsing/scanning
 *
 * Extracted from src/server/serial.ts and enriched with base-240 codec
 * from protocol.md. This module has zero dependencies on Node.js APIs
 * so it can run on both the Pi (server) and Windows (proxy/analyzer).
 */

import {
  Base240Modulus,
  Divisors,
  EbcDivisors,
  EndToken,
  INFO_STATE_OFFSET,
  RxPacketLength,
  StartToken,
  TxPacketLength,
  TxPayloadLength,
} from './constants.ts';
import type { DecodedRxFrame, DecodedTxFrame, DeviceFamily, FrameDirection, ParsedFrame, ScanResult } from './types.ts';

// ── Checksum ──────────────────────────────────────────────────────────

/** XOR of all bytes in the given data (raw, before base-240 wrapping) */
function rawXor(data: Uint8Array | Buffer): number {
  let acc = 0;
  for (let i = 0; i < data.length; i++) {
    acc ^= data[i];
  }
  return acc;
}

/**
 * Compute the wire-safe checksum for a payload.
 *
 * The XOR result is reduced modulo 240 (Base240Modulus) so the checksum
 * byte stays below 0xF0, avoiding collision with the frame start (0xFA)
 * and end (0xF8) tokens.  The device firmware applies the same reduction.
 */
export function checksum(data: Uint8Array | Buffer): number {
  return rawXor(data) % Base240Modulus;
}

// ── Base-240 Encoding ─────────────────────────────────────────────────

/**
 * Encode a floating-point value into two base-240 bytes.
 * @param value  The value to encode (e.g. 1.5 for 1.5A)
 * @param divisor  The divisor for this field type (e.g. 10000 for current)
 * @returns [hi, lo] byte pair
 */
export function encodeBase240(value: number, divisor: number): [hi: number, lo: number] {
  const intVal = Math.round(value * divisor);
  const hi = Math.floor(intVal / Base240Modulus);
  const lo = intVal % Base240Modulus;
  return [hi, lo];
}

/**
 * Decode two base-240 bytes back to a floating-point value.
 * @param hi  High byte
 * @param lo  Low byte
 * @param divisor  The divisor for this field type
 * @returns Decoded value
 */
export function decodeBase240(hi: number, lo: number, divisor: number): number {
  return (hi * Base240Modulus + lo) / divisor;
}

// ── Frame Building ────────────────────────────────────────────────────

/**
 * Build a complete TX frame (host -> device) from a 7-byte payload.
 * Adds StartToken, XOR checksum, and EndToken.
 */
export function buildTxFrame(payload: Uint8Array): Uint8Array {
  if (payload.length !== TxPayloadLength) {
    throw new Error(`TX payload must be exactly ${TxPayloadLength} bytes, got ${payload.length}`);
  }
  const frame = new Uint8Array(TxPacketLength);
  frame[0] = StartToken;
  frame.set(payload, 1);
  frame[TxPacketLength - 2] = checksum(payload);
  frame[TxPacketLength - 1] = EndToken;
  return frame;
}

// ── Frame Parsing ─────────────────────────────────────────────────────

/**
 * Parse a raw byte array into a ParsedFrame, validating start/end tokens
 * and checksum. Returns null if the bytes don't form a valid frame.
 *
 * @param raw  The raw bytes (must be exactly RxPacketLength or TxPacketLength)
 * @param direction  Whether this is a tx or rx frame
 */
export function parseFrame(raw: Uint8Array, direction: FrameDirection): ParsedFrame | null {
  const len = raw.length;
  if (len !== RxPacketLength && len !== TxPacketLength) return null;
  if (raw[0] !== StartToken) return null;
  if (raw[len - 1] !== EndToken) return null;

  const checksumIndex = len - 2;
  // The checksum covers bytes 1..N-2 (data bytes, excluding start, checksum, and end)
  const dataBytes = raw.slice(1, checksumIndex);
  const checksumByte = raw[checksumIndex];
  const checksumValid = checksum(dataBytes) === checksumByte;

  return {
    raw: new Uint8Array(raw),
    direction,
    command: raw[1],
    payload: new Uint8Array(dataBytes),
    checksum: checksumByte,
    checksumValid,
  };
}

// ── Stream Frame Scanner ──────────────────────────────────────────────

/**
 * Scan a byte buffer for complete frames delimited by StartToken..EndToken.
 * Handles arbitrary byte boundaries — call repeatedly as new bytes arrive.
 *
 * @param buffer  The accumulated byte buffer
 * @param expectedLength  Expected frame length (RxPacketLength or TxPacketLength)
 * @returns Object with found frames and remaining bytes
 */
export function scanForFrames(buffer: Uint8Array, expectedLength: number): ScanResult {
  const frames: Uint8Array[] = [];
  let offset = 0;

  while (offset <= buffer.length - expectedLength) {
    if (buffer[offset] !== StartToken) {
      offset++;
      continue;
    }

    // Check if the end token is at the expected position
    const endPos = offset + expectedLength - 1;
    if (buffer[endPos] !== EndToken) {
      offset++;
      continue;
    }

    // Found a candidate frame
    frames.push(new Uint8Array(buffer.slice(offset, offset + expectedLength)));
    offset += expectedLength;
  }

  const remainder = new Uint8Array(buffer.slice(offset));
  return { frames, remainder };
}

// ── Known TX Command Names ────────────────────────────────────────────
// Command byte = mode_offset + action.
// Mode offsets: 0x00=D-CC, 0x10=D-CP, 0x20=C-CV, 0x30=C-NiMh,
//               0x40=C-NiCD, 0x50=C-LiPo, 0x60=C-LiFe, 0x70=C-VRLA
// Actions: 0x01=start, 0x02=toggle, 0x04=calibrate, 0x05=init,
//          0x06=stop, 0x07=QC, 0x08=continue, 0x09=resistance, 0x0A=heartbeat

const TxCommandNames: Record<number, string> = {
  0x01: 'start (D-CC)',
  0x02: 'load toggle',
  0x04: 'calibrate',
  0x05: 'init',
  0x06: 'stop',
  0x07: 'configure/QC',
  0x08: 'continue (D-CC)',
  0x09: 'resistance test',
  0x0a: 'heartbeat',
  0x11: 'start (D-CP)',
  0x18: 'continue (D-CP)',
  0x21: 'start (C-CV)',
  0x28: 'continue (C-CV)',
  0x31: 'start (C-NiMh)',
  0x38: 'continue (C-NiMh)',
  0x41: 'start (C-NiCD)',
  0x48: 'continue (C-NiCD)',
  0x51: 'start (C-LiPo)',
  0x58: 'continue (C-LiPo)',
  0x61: 'start (C-LiFe)',
  0x68: 'continue (C-LiFe)',
  0x71: 'start (C-VRLA)',
  0x78: 'continue (C-VRLA)',
};

/** Charge mode command offsets — commands whose byte 6-7 carry cutoff current */
const ChargeModeOffsets = [0x20, 0x30, 0x40, 0x50, 0x60, 0x70];

/** Returns true if the command byte is a charge-mode start or continue */
function isChargeMode(cmd: number): boolean {
  const modeOffset = cmd & 0xf0;
  return ChargeModeOffsets.includes(modeOffset);
}

// ── Known RX State Names ─────────────────────────────────────────────

const RxStateNames: Record<number, string> = {
  0x00: 'idle (load off)',
  0x02: 'idle (EBC)',
  0x0a: 'active (load on)',
  0x0c: 'charging (EBC)',
  0x16: 'charge complete (EBC)',
  0x64: 'info (load off)',
  0x66: 'info (EBC idle)',
  0x6e: 'info (load on)',
};

/** Get a human-readable name for a state byte, or format as hex */
export function stateName(state: number): string {
  return RxStateNames[state] ?? `0x${state.toString(16).padStart(2, '0')}`;
}

/** Returns true if this is an info/identification packet (state + 0x64) */
export function isInfoPacket(state: number): boolean {
  // Check the name map for known states, fall back to heuristic for unknown states
  const name = RxStateNames[state];
  if (name !== undefined) return name.includes('info');
  return state >= INFO_STATE_OFFSET;
}

// ── Frame Decoding ────────────────────────────────────────────────────

/**
 * Decode a parsed RX frame (device -> host) into human-readable field values.
 *
 * @param frame  The parsed frame to decode
 * @param family Device family — determines divisors and field interpretation.
 *               Default `'ebd'` for backward compatibility.
 */
export function decodeRxFrame(frame: ParsedFrame, family: DeviceFamily = 'ebd'): DecodedRxFrame {
  const p = frame.payload;

  if (family === 'ebc') {
    return {
      ...frame,
      direction: 'rx',
      state: p[0],
      current: decodeBase240(p[1], p[2], EbcDivisors.current),           // ÷100 → A
      voltage: decodeBase240(p[3], p[4], EbcDivisors.voltage),           // ÷1000 → V
      field6: decodeBase240(p[5], p[6], EbcDivisors.capacity),           // raw = mAh
      field7: decodeBase240(p[7], p[8], EbcDivisors.capacity),           // unknown, always 0 on A40L
      field8: decodeBase240(p[9], p[10], EbcDivisors.current),           // current setpoint echo ÷100
      field9: decodeBase240(p[11], p[12], EbcDivisors.setpointVoltage),  // voltage setpoint echo ÷100
      field10: p[13],  // base-240 hi byte of time/cutoff | info: device type
      field11: p[14],  // base-240 lo byte of time/cutoff | info: subtype
      maxTimeOrCutoff: p[13] * Base240Modulus + p[14],  // base-240 pair: max time (min) or cutoff current (raw)
      field12: p[15],  // device constant (0x0A on A40L)
    };
  }

  // EBD-USB+ (default, from sigrok)
  return {
    ...frame,
    direction: 'rx',
    state: p[0],
    current: decodeBase240(p[1], p[2], Divisors.current),           // ÷10000 → A
    voltage: decodeBase240(p[3], p[4], Divisors.voltage),           // ÷1000 → V
    field6: decodeBase240(p[5], p[6], Divisors.dpDmVoltage),        // D+ voltage ÷1000
    field7: decodeBase240(p[7], p[8], Divisors.dpDmVoltage),        // D- voltage ÷1000
    field8: decodeBase240(p[9], p[10], Divisors.current),           // current limit setting
    field9: decodeBase240(p[11], p[12], Divisors.cutoffVoltage),    // UVC threshold ÷100
    field10: p[13],
    field11: p[14],
    maxTimeOrCutoff: p[13] * Base240Modulus + p[14],
    field12: p[15],
  };
}

/**
 * Decode a parsed TX frame (host -> device) into human-readable field values.
 *
 * @param frame  The parsed frame to decode
 * @param family Device family — determines current divisor. Default `'ebd'`.
 */
export function decodeTxFrame(frame: ParsedFrame, family: DeviceFamily = 'ebd'): DecodedTxFrame {
  const p = frame.payload;
  const commandName = TxCommandNames[p[0]] ?? `unknown (0x${p[0].toString(16).padStart(2, '0')})`;
  const currentDiv = family === 'ebc' ? EbcDivisors.current : Divisors.current;
  const voltageDiv = family === 'ebc' ? EbcDivisors.setpointVoltage : Divisors.cutoffVoltage;

  const result: DecodedTxFrame = {
    ...frame,
    direction: 'tx',
    commandName,
  };

  // Commands that carry current setpoint + cutoff/target voltage in the payload
  const hasSetpointCmds = [
    0x01, 0x07, 0x08, 0x11, 0x18, 0x21, 0x28, 0x31, 0x38, 0x41, 0x48, 0x51, 0x58, 0x61, 0x68, 0x71, 0x78,
  ];
  if (hasSetpointCmds.includes(p[0])) {
    result.currentSetpoint = decodeBase240(p[1], p[2], currentDiv);
    result.cutoffVoltage = decodeBase240(p[3], p[4], voltageDiv);

    if (isChargeMode(p[0])) {
      // Charge mode: bytes 6-7 = cutoff current (charging stops when current drops below)
      result.cutoffCurrent = decodeBase240(p[5], p[6], voltageDiv);
    } else {
      // Discharge mode: bytes 6-7 = max run time in minutes (base-240, raw)
      result.maxTime = p[5] * Base240Modulus + p[6];
    }
  }

  return result;
}

// ── Hex Formatting Helpers ────────────────────────────────────────────

/** Convert a byte array to a hex string like "fa 05 00 ..." */
export function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** Convert a hex string (with or without spaces) back to bytes */
export function fromHex(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
