/**
 * Protocol type definitions shared across all components
 */

/** Direction of a serial frame */
export type FrameDirection = 'tx' | 'rx';

/**
 * Device family — determines divisors and field layout for decoding.
 * - `'ebd'`: EBD-USB/EBD-USB+ electronic loads (sigrok-documented)
 * - `'ebc'`: EBC-* charger/dischargers (EBC-A40L confirmed)
 */
export type DeviceFamily = 'ebd' | 'ebc';

/** A parsed but not yet decoded frame */
export interface ParsedFrame {
  /** Raw bytes of the entire frame (start through end) */
  raw: Uint8Array;
  /** Direction: tx = host->device, rx = device->host */
  direction: FrameDirection;
  /** Command/state byte (byte 1 of packet) */
  command: number;
  /** Data payload bytes (between start/end, excluding checksum) */
  payload: Uint8Array;
  /** Checksum byte as received */
  checksum: number;
  /** Whether the checksum validates */
  checksumValid: boolean;
}

/** Result of scanning a byte stream for frames */
export interface ScanResult {
  /** Complete frames found in the buffer */
  frames: Uint8Array[];
  /** Leftover bytes that don't form a complete frame yet */
  remainder: Uint8Array;
}

/** Decoded RX (device -> host) frame with field values */
export interface DecodedRxFrame extends ParsedFrame {
  direction: 'rx';
  /** Device state byte (see RxState constants) */
  state: number;
  /**
   * Measured current in amps (bytes 2-3, base-240).
   * **Divisor is model-dependent:** EBD-USB+ uses ÷10000, EBC uses ÷100.
   * Currently decoded with EBD-USB+ divisor (10000).
   */
  current: number;
  /** Measured voltage in volts (bytes 4-5, base-240, ÷1000) */
  voltage: number;
  /**
   * Bytes 6-7 decoded as base-240 (÷1000 currently).
   * - **EBD-USB+:** D+ voltage (÷1000 → V)
   * - **EBC chargers:** Accumulated capacity — raw base-240 value = mAh.
   *   The ÷1000 divisor gives Ah; multiply by 1000 to get mAh,
   *   or use the raw value directly.
   */
  field6: number;
  /**
   * Bytes 8-9 decoded as base-240 (÷1000 currently).
   * - **EBD-USB+:** D- voltage (÷1000 → V)
   * - **EBC chargers:** Always 0 on EBC-A40L. Unknown purpose.
   */
  field7: number;
  /**
   * Bytes 10-11 decoded as base-240 (÷10000 currently).
   * - **EBD-USB+:** Current limit setting
   * - **EBC chargers:** Current setpoint echo (÷100 → A).
   *   In **info packets** (state + 0x64): device capability (max current?).
   */
  field8: number;
  /**
   * Bytes 12-13 decoded as base-240 (÷100 currently).
   * - **EBD-USB+:** UVC threshold setting
   * - **EBC chargers:** Voltage setpoint echo (÷100 → V).
   *   In **info packets** (state + 0x64): device capability (max voltage?).
   */
  field9: number;
  /**
   * Byte 14 (raw value) — high byte of the bytes 14-15 base-240 pair.
   * - **Normal packets:** Hi byte of max time (minutes) or cutoff current (raw)
   * - **Info packets:** Device type index (0x11 = 17 on EBC-A40L)
   */
  field10: number;
  /**
   * Byte 15 (raw value) — low byte of the bytes 14-15 base-240 pair.
   * - **Normal packets:** Lo byte of max time (minutes) or cutoff current (raw)
   * - **Info packets:** Device subtype/revision (0x86 = 134 on EBC-A40L)
   */
  field11: number;
  /**
   * Bytes 14-15 decoded as a base-240 pair (raw integer).
   * - **D-CC/D-CP:** Max run time in minutes (0 = unlimited)
   * - **C-CV:** Cutoff current (÷100 → A)
   * - **Info packets:** Not meaningful (use field10/field11 individually)
   *
   * Confirmed via real hardware: time=300 produces byte14=0x01, byte15=0x3c.
   */
  maxTimeOrCutoff: number;
  /**
   * Byte 16 (raw value).
   * Constant 0x0A (10) on EBC-A40L across all packet types.
   * Possibly firmware version or device family identifier.
   */
  field12: number;
}

/** Decoded TX (host -> device) frame with field values */
export interface DecodedTxFrame extends ParsedFrame {
  direction: 'tx';
  /** Human-readable command name */
  commandName: string;
  /**
   * Current setpoint in amps (if applicable).
   * **Divisor is model-dependent:** EBD-USB+ uses ÷10000, EBC uses ÷100.
   * Currently decoded with EBD-USB+ divisor (10000).
   */
  currentSetpoint?: number;
  /**
   * Cutoff/target voltage in volts (if applicable, ÷100).
   * - **D-CC/D-CP:** UVC cutoff voltage
   * - **C-CV:** Target charge voltage
   */
  cutoffVoltage?: number;
  /**
   * Cutoff current in amps (bytes 6-7, ÷100).
   * Only present in charge mode commands (C-CV, C-NiMh, etc.).
   * Charging stops when current drops below this threshold.
   */
  cutoffCurrent?: number;
  /**
   * Max run time in minutes (bytes 6-7, base-240 raw).
   * Only present in discharge mode commands (D-CC, D-CP). 0 = unlimited.
   */
  maxTime?: number;
}
