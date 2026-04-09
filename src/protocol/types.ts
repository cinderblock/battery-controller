/**
 * Protocol type definitions shared across all components
 */

/** Direction of a serial frame */
export type FrameDirection = 'tx' | 'rx';

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
  /** Device state byte */
  state: number;
  /** Measured current in amps */
  current: number;
  /** Measured voltage in volts */
  voltage: number;
  /**
   * Bytes 6-7 decoded as base-240.
   * EBD-USB+: D+ voltage. EBC chargers: temperature or other model-dependent data.
   */
  field6: number;
  /**
   * Bytes 8-9 decoded as base-240.
   * EBD-USB+: D- voltage. EBC chargers: unknown/model-dependent.
   */
  field7: number;
  /** Bytes 10-11 decoded as base-240 (often current limit setting) */
  field8: number;
  /** Bytes 12-13 decoded as base-240 (often UVC threshold setting) */
  field9: number;
  /** Bytes 14-16 raw values (3 bytes, model-dependent / reserved) */
  field10: number;
  field11: number;
  field12: number;
}

/** Decoded TX (host -> device) frame with field values */
export interface DecodedTxFrame extends ParsedFrame {
  direction: 'tx';
  /** Human-readable command name */
  commandName: string;
  /** Current setpoint in amps (if applicable) */
  currentSetpoint?: number;
  /** Cutoff voltage in volts (if applicable) */
  cutoffVoltage?: number;
}
