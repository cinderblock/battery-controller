/**
 * Protocol constants shared across all components
 *
 * ZKETech EB Tester serial protocol: 9600 8E1 binary framed packets
 * See protocol.md for full documentation.
 */

// Frame markers
export const StartToken = 0xfa;
export const EndToken = 0xf8;

// Full packet lengths (including start, end, and checksum bytes)
export const RxPacketLength = 19; // device -> host: START + 16 data + checksum + END
export const TxPacketLength = 10; // host -> device: START + 7 data + checksum + END

// Payload lengths (data bytes only, excluding start/end/checksum)
export const RxPayloadLength = 16;
export const TxPayloadLength = 7;

// Base-240 encoding modulus — all payload bytes must be < 0xF0 (240)
// to avoid colliding with frame markers 0xFA and 0xF8
export const Base240Modulus = 240;

// Base-240 divisors for decoding/encoding multi-byte numeric fields.
// Divisors are MODEL-DEPENDENT — see protocol.md for details.
export const Divisors = {
  current: 10_000, // 0.1 mA resolution (EBD-USB+)
  voltage: 1_000, // 1 mV resolution (all models)
  cutoffVoltage: 100, // 10 mV resolution (all models)
  dpDmVoltage: 1_000, // 1 mV resolution (EBD-USB+ only)
} as const;

// EBC charger/discharger divisors (confirmed on EBC-A40L via serial capture)
export const EbcDivisors = {
  current: 100, // 10 mA resolution — GUI format "00.00"
  voltage: 1_000, // 1 mV resolution — GUI format "00.000" (same as EBD)
  setpointVoltage: 100, // 10 mV resolution — target voltage / UVC cutoff
  cutoffCurrent: 100, // 10 mA resolution — min current to end CV charge
  capacity: 1, // 1 mAh — raw base-240 value IS mAh (device-computed)
} as const;

// Known state byte values
//
// Info-packet rule: info state = normal state + 0x64 (100 decimal), mod 240.
// Confirmed on EBD-USB+ (0x00↔0x64, 0x0A↔0x6E) and EBC-A40L (0x02↔0x66,
// 0x0A↔0x6E, 0x0B↔0x6F, 0x0C↔0x70, 0x14↔0x78, 0x15↔0x79, 0x16↔0x7A).
//
// Running states come in two variants per mode (X and X+10 decimal) — the
// EB Tester UI treats both as "test running in this mode". The second variant
// is likely a transition/terminal phase (e.g. CC→CV for charge). See
// protocol.md §"EBC Charger States" for April-2026 fake-device probe details.
export const RxState = {
  // EBD-USB+ states (from sigrok)
  EBD_IDLE: 0x00, // Measuring, load OFF
  EBD_IDLE_INFO: 0x64, // Info packet (load OFF alternate)
  EBD_ACTIVE: 0x0a, // Measuring, load ON (= EBC_DCC_RUN; shared byte)
  EBD_ACTIVE_INFO: 0x6e, // Info packet (load ON alternate)

  // EBC charger states (confirmed on EBC-A40L via capture + fake-device probe)
  EBC_IDLE: 0x02, // Idle / monitoring, test not running
  EBC_IDLE_INFO: 0x66, // Info packet (idle alternate, = 0x02 + 0x64)

  // Phase-1 running states: device entered the mode, actively regulating
  EBC_DCC_RUN: 0x0a, // D-CC discharging (same byte as EBD_ACTIVE)
  EBC_DCP_RUN: 0x0b, // D-CP discharging (constant power)
  EBC_CCV_RUN: 0x0c, // C-CV charging (CC phase)

  // Phase-2 running states: "second half" of the mode (CV for charge, final for discharge)
  EBC_DCC_RUN2: 0x14, // D-CC phase 2 (terminal/cutoff approach)
  EBC_DCP_RUN2: 0x15, // D-CP phase 2
  EBC_CCV_RUN2: 0x16, // C-CV phase 2 (CV regulation / charge complete)

  /** @deprecated Use {@link EBC_CCV_RUN} (active CC phase). */
  EBC_CHARGING: 0x0c,
  /** @deprecated Use {@link EBC_CCV_RUN2} — identical UI behavior to EBC_CCV_RUN; the old "charge complete" label was imprecise. */
  EBC_CHARGE_COMPLETE: 0x16,
} as const;

// Info packet state offset — info state = normal state + INFO_OFFSET
export const INFO_STATE_OFFSET = 0x64;

// ── Device Type Table ────────────────────────────────────────────────
//
// Extracted from eb.exe (v1.8.9en, Jul 2025) at binary offset 0x1E634.
// The main table has 51 entries (indices 0-50). Seven additional variant
// models appear at offset 0x1F64C — these are assigned indices 51-57 here
// for completeness, but their on-wire type codes are unknown.
//
// The info packet's byte 14 ("device type") does NOT directly index this
// table — the mapping from on-wire type codes to table indices is still
// unknown.  Auto-detection currently uses the idle state byte instead
// (0x00 = EBD, 0x02 = EBC).

export interface DeviceInfo {
  /** Device model name as shown in EB Tester GUI */
  name: string;
  /** Device family: 'ebc' = charger/discharger, 'ebd' = electronic load */
  family: 'ebc' | 'ebd';
}

/**
 * All 58 supported device models, in the order they appear in the
 * EB Tester v1.8.9 binary's string table.
 */
export const DeviceTable: DeviceInfo[] = [
  // ── Main table (binary offset 0x1E634, indices 0-50) ──
  /* 0  */ { name: 'EBC-A', family: 'ebc' },
  /* 1  */ { name: 'EBC-AH', family: 'ebc' },
  /* 2  */ { name: 'EBC-B', family: 'ebc' },
  /* 3  */ { name: 'EBC-BH', family: 'ebc' },
  /* 4  */ { name: 'EBC-A10', family: 'ebc' },
  /* 5  */ { name: 'EBC-B10', family: 'ebc' },
  /* 6  */ { name: 'EBD-A', family: 'ebd' },
  /* 7  */ { name: 'EBD-AH', family: 'ebd' },
  /* 8  */ { name: 'EBD-B', family: 'ebd' },
  /* 9  */ { name: 'EBD-BH', family: 'ebd' },
  /* 10 */ { name: 'EBD-A10', family: 'ebd' },
  /* 11 */ { name: 'EBD-A15', family: 'ebd' },
  /* 12 */ { name: 'EBD-A2S', family: 'ebd' },
  /* 13 */ { name: 'EBD-A5S', family: 'ebd' },
  /* 14 */ { name: 'EBD-A20H', family: 'ebd' },
  /* 15 */ { name: 'EBD-P10', family: 'ebd' },
  /* 16 */ { name: 'EBD-P15', family: 'ebd' },
  /* 17 */ { name: 'EBD-B10H', family: 'ebd' },
  /* 18 */ { name: 'EBD-M02', family: 'ebd' },
  /* 19 */ { name: 'EBD-USB+', family: 'ebd' },
  /* 20 */ { name: 'EBD-USB', family: 'ebd' },
  /* 21 */ { name: 'EBD-B20H', family: 'ebd' },
  /* 22 */ { name: 'EBC-B20H', family: 'ebc' },
  /* 23 */ { name: 'EBC-B50', family: 'ebc' },
  /* 24 */ { name: 'EBD-B40H', family: 'ebd' },
  /* 25 */ { name: 'EBD-A50H', family: 'ebd' },
  /* 26 */ { name: 'EBD-A40L', family: 'ebd' },
  /* 27 */ { name: 'EBD-A30H', family: 'ebd' },
  /* 28 */ { name: 'EBD-P30H', family: 'ebd' },
  /* 29 */ { name: 'EBD-A01', family: 'ebd' },
  /* 30 */ { name: 'EBC-A01', family: 'ebc' },
  /* 31 */ { name: 'EBC-A100L', family: 'ebc' },
  /* 32 */ { name: 'EBD-B30H', family: 'ebd' },
  /* 33 */ { name: 'EBC-A5M', family: 'ebc' },
  /* 34 */ { name: 'EBD-A5D', family: 'ebd' },
  /* 35 */ { name: 'EBD-M', family: 'ebd' },
  /* 36 */ { name: 'EBC-A05+', family: 'ebc' },
  /* 37 */ { name: 'EBC-A05', family: 'ebc' },
  /* 38 */ { name: 'EBC-A20+', family: 'ebc' },
  /* 39 */ { name: 'EBC-A20', family: 'ebc' },
  /* 40 */ { name: 'EBC-A50L', family: 'ebc' },
  /* 41 */ { name: 'EBC-A40L', family: 'ebc' },
  /* 42 */ { name: 'EBD-M03+', family: 'ebd' },
  /* 43 */ { name: 'EBD-M05', family: 'ebd' },
  /* 44 */ { name: 'EBD-M03', family: 'ebd' },
  /* 45 */ { name: 'EBD-M10', family: 'ebd' },
  /* 46 */ { name: 'EBD-A10H', family: 'ebd' },
  /* 47 */ { name: 'EBC-A10+', family: 'ebc' },
  /* 48 */ { name: 'EBC-A10H', family: 'ebc' },
  /* 49 */ { name: 'EBD-A100L', family: 'ebd' },
  /* 50 */ { name: 'EBD-A100', family: 'ebd' },
  // ── Extended variants (binary offset 0x1F64C, indices 51-57) ──
  /* 51 */ { name: 'EBC-A40L-40A', family: 'ebc' },
  /* 52 */ { name: 'EBD-A20H-200W', family: 'ebd' },
  /* 53 */ { name: 'EBD-B20H-72V3', family: 'ebd' },
  /* 54 */ { name: 'EBC-B20H-72V3', family: 'ebc' },
  /* 55 */ { name: 'EBC-B20H-108V3', family: 'ebc' },
  /* 56 */ { name: 'EBD-B30H-72V3', family: 'ebd' },
  /* 57 */ { name: 'EBD-B10H-V3', family: 'ebd' },
];

/** Quick lookup: device name → DeviceInfo */
export const DeviceByName: Map<string, DeviceInfo> = new Map(
  DeviceTable.map(d => [d.name, d]),
);

// Serial port settings
export const BaudRate = 9600;
export const DataBits = 8;
export const Parity = 'even' as const;
export const StopBits = 1;
