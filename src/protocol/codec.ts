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
  EndToken,
  RxPacketLength,
  StartToken,
  TxPacketLength,
  TxPayloadLength,
} from './constants.ts';
import type { DecodedRxFrame, DecodedTxFrame, FrameDirection, ParsedFrame, ScanResult } from './types.ts';

// ── Checksum ──────────────────────────────────────────────────────────

/** XOR checksum of all bytes in the given data */
export function checksum(data: Uint8Array | Buffer): number {
  let acc = 0;
  for (let i = 0; i < data.length; i++) {
    acc ^= data[i];
  }
  return acc;
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

const TxCommandNames: Record<number, string> = {
  1: 'load start (D-CC)',
  2: 'load toggle',
  4: 'calibrate',
  5: 'init',
  6: 'stop',
  7: 'configure/QC',
  8: 'continue (D-CC)',
  9: 'resistance test',
  10: 'heartbeat',
  17: 'start (D-CP)',
  24: 'continue (D-CP)',
  33: 'start (C-CV)',
  40: 'continue (C-CV)',
  49: 'start (C-NiMh)',
  56: 'continue (C-NiMh)',
  65: 'start (C-NiCD)',
  72: 'continue (C-NiCD)',
  81: 'start (C-LiPo)',
  88: 'continue (C-LiPo)',
  97: 'start (C-LiFe)',
  104: 'continue (C-LiFe)',
  113: 'start (C-VRLA)',
  120: 'continue (C-VRLA)',
};

// ── Frame Decoding ────────────────────────────────────────────────────

/**
 * Decode a parsed RX frame (device -> host) into human-readable field values.
 */
export function decodeRxFrame(frame: ParsedFrame): DecodedRxFrame {
  const p = frame.payload;
  return {
    ...frame,
    direction: 'rx',
    state: p[0],
    current: decodeBase240(p[1], p[2], Divisors.current),
    voltage: decodeBase240(p[3], p[4], Divisors.voltage),
    field6: decodeBase240(p[5], p[6], Divisors.voltage), // D+ or temp depending on model
    field7: decodeBase240(p[7], p[8], Divisors.voltage), // D- or unknown
    field8: decodeBase240(p[9], p[10], Divisors.current), // current limit setting
    field9: decodeBase240(p[11], p[12], Divisors.cutoffVoltage), // UVC threshold
    field10: p[13],
    field11: p[14],
    field12: p[15],
  };
}

/**
 * Decode a parsed TX frame (host -> device) into human-readable field values.
 */
export function decodeTxFrame(frame: ParsedFrame): DecodedTxFrame {
  const p = frame.payload;
  const commandName = TxCommandNames[p[0]] ?? `unknown (0x${p[0].toString(16).padStart(2, '0')})`;

  const result: DecodedTxFrame = {
    ...frame,
    direction: 'tx',
    commandName,
  };

  // Commands that carry current setpoint + cutoff voltage in the payload
  const hasSetpointCmds = [
    0x01, 0x07, 0x08, 0x11, 0x18, 0x21, 0x28, 0x31, 0x38, 0x41, 0x48, 0x51, 0x58, 0x61, 0x68, 0x71, 0x78,
  ];
  if (hasSetpointCmds.includes(p[0])) {
    result.currentSetpoint = decodeBase240(p[1], p[2], Divisors.current);
    result.cutoffVoltage = decodeBase240(p[3], p[4], Divisors.cutoffVoltage);
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
