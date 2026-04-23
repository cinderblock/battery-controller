/**
 * EBC-A40L profile.
 *
 * This is the model we have the best characterization of (protocol.md,
 * confirmed April 2026 via serial capture). Divisors, state bytes, info
 * identity bytes, and response cadence are all observed.
 *
 * Unknowns (keep tracked here so we don't forget):
 *   - Byte 7-8 of RX payload ("field7"): always 0 on A40L captures. Purpose
 *     unknown — possibly temperature, internal resistance, or energy on
 *     other models.
 *   - Error / protection flags: no observed byte carries these yet.
 *   - Step / cycle test response layout: unconfirmed.
 *   - Calibration (CMD 0x04) response: unconfirmed.
 */

import { RxState } from '../../../src/protocol/constants.ts';
import type { Profile } from './types.ts';

export const ebcA40LProfile: Profile = {
  name: 'ebc-a40l',
  family: 'ebc',

  idleState: RxState.EBC_IDLE, // 0x02
  chargingState: RxState.EBC_CCV_RUN, // 0x0c — C-CV phase 1 (CC)
  // EBC-A40L is a charger+discharger combo; 0x0a is D-CC running phase 1
  // (same byte as EBD_ACTIVE; confirmed by capture and fake-device probe).
  dischargingState: RxState.EBC_DCC_RUN, // 0x0a
  // Phase 2 / terminal state for C-CV (CV regulation, approaching cutoff).
  // Originally labelled "charge complete" but the EB Tester UI treats it
  // identically to EBC_CCV_RUN — see protocol.md for probe details.
  chargeCompleteState: RxState.EBC_CCV_RUN2, // 0x16

  deviceTypeByte: 0x11, // 17 — observed
  deviceSubtypeByte: 0x86, // 134 — observed
  deviceConstantByte: 0x0a, // 10 — observed constant across all packets

  // Info packet field8 / field9 = device capability (raw observation):
  // EBC-A40L advertises ~40 A, 30 V.
  infoMaxCurrent: 40.0,
  infoMaxVoltage: 30.0,

  divisors: {
    current: 100, // EBC: 10 mA steps
    voltage: 1_000, // 1 mV steps
    setpointVoltage: 100, // setpoint encoded at ÷100
    cutoffCurrent: 100, // ÷100
    capacity: 1, // raw base-240 value = mAh
  },

  responseCadenceMs: 500,

  defaults: {
    voltage: 3.8, // plausible resting voltage of a partly-charged Li cell
    current: 0.0,
  },
};
