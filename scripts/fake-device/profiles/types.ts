/**
 * Profile types for the fake device.
 *
 * A Profile captures everything we currently think we know about how a
 * particular family of ZKETech devices speaks the protocol: framing
 * divisors, state byte values, info-packet identity bytes, and the
 * default response cadence.
 *
 * Anything still unknown lives as a TODO in a specific profile (see
 * ebc-a40l.ts) — it should NOT silently fall back to defaults, because
 * then we'd never know we were guessing.
 */

import type { DeviceFamily } from '../../../src/protocol/types.ts';

export interface Divisors {
  /** current encoding divisor (EBC: 100, EBD: 10000) */
  current: number;
  /** voltage encoding divisor (universal: 1000) */
  voltage: number;
  /** setpoint voltage encoding divisor (EBC: 100, EBD: 100) */
  setpointVoltage: number;
  /** charge cutoff current divisor (EBC: 100) */
  cutoffCurrent: number;
  /**
   * capacity encoding divisor — on EBC this is 1 (raw value = mAh).
   * On EBD the host integrates current × time, so the wire has no
   * capacity field; this is 0 to flag "not applicable".
   */
  capacity: number;
}

export interface Profile {
  /** Short profile id, e.g. "ebc-a40l" */
  name: string;

  /** Family — determines field layout of the RX payload */
  family: DeviceFamily;

  // ── State bytes ───────────────────────────────────────────────────
  /** State byte when idle (EBC: 0x02, EBD: 0x00) */
  idleState: number;
  /** State byte while actively charging, or null if charger-only model */
  chargingState: number | null;
  /** State byte while actively discharging, or null */
  dischargingState: number | null;
  /** Transient state byte when a charge cycle completes */
  chargeCompleteState: number | null;

  // ── Info packet identity ─────────────────────────────────────────
  /** Byte 14 of RX payload when state = idle + 0x64 (info packet) */
  deviceTypeByte: number;
  /** Byte 15 of RX payload in info packets — subtype / revision */
  deviceSubtypeByte: number;
  /** Byte 16 of RX payload — constant across all packets (0x0A on A40L) */
  deviceConstantByte: number;
  /**
   * Info packet field8 value (max current capability, ÷100 → A).
   * Observed 40.00 on EBC-A40L.
   */
  infoMaxCurrent: number;
  /** Info packet field9 value (max voltage capability, ÷100 → V) */
  infoMaxVoltage: number;

  // ── Divisors ──────────────────────────────────────────────────────
  divisors: Divisors;

  // ── Electrical model ─────────────────────────────────────────────
  /**
   * Simulated cell DC internal resistance (mΩ). The emitted terminal
   * voltage sags by I·R while discharging and rises by I·R while
   * charging, so host-side IR estimation (R = ΔV/ΔI at current steps)
   * sees realistic behavior. 0/undefined = ideal cell, no sag.
   */
  irMohm?: number;

  // ── Timing ────────────────────────────────────────────────────────
  /** How often to emit a periodic RX packet (ms). Real devices: ~500ms. */
  responseCadenceMs: number;

  // ── Defaults for DeviceState on reset ────────────────────────────
  defaults: {
    /** Starting voltage shown by the device when idle (V) */
    voltage: number;
    /** Starting current (A) */
    current: number;
  };
}
