/**
 * Shared runtime types for the fake-device harness.
 */

export type DeviceMode = 'idle' | 'charging' | 'discharging' | 'complete' | 'fault';

/**
 * The fake device's mutable state. This is what the control API reads
 * and writes. The periodic response generator turns this into RX frames.
 */
export interface DeviceState {
  mode: DeviceMode;
  /** Instantaneous current in A (magnitude — sign is informational) */
  current: number;
  /** Instantaneous voltage in V */
  voltage: number;
  /** Accumulated capacity in mAh (EBC family device-computed) */
  capacity: number;
  /** Current setpoint — echoed back in RX bytes 10-11 */
  currentSetpoint: number;
  /** Voltage setpoint / cutoff — echoed in RX bytes 12-13 */
  voltageSetpoint: number;
  /**
   * Cutoff current (A) for charge modes, OR max time (minutes) for discharge.
   * Echoed in RX bytes 14-15 as a base-240 pair.
   * - D-CC/D-CP: max run time in minutes (0 = unlimited)
   * - C-CV: cutoff current in A (encoded as raw * divisors.cutoffCurrent)
   */
  cutoffCurrent: number;
  /** Max run time in minutes — echoed in RX bytes 14-15 for discharge modes */
  maxTime: number;
  /**
   * Placeholder for future error/protection flag bytes. Real byte layout
   * is unknown — nothing writes to this yet.
   */
  errors: number;
  /**
   * If true, simulate() evolves voltage/current/capacity over time.
   * Default false — external driver controls state explicitly.
   */
  auto: boolean;
  /** Rate of voltage change per minute when auto=true and charging/discharging */
  autoRateVPerMin: number;
  /** Cadence of periodic RX frames in ms */
  cadenceMs: number;
}

/**
 * One entry in the fake device's frame log / event stream.
 * Used by the HTTP `/log` endpoint and the SSE `/log/stream` endpoint.
 */
export interface LogEntry {
  t: string;
  mono: number;
  dir: 'tx' | 'rx' | 'note' | 'state';
  hex?: string;
  summary: string;
  decoded?: Record<string, unknown>;
  checksumValid?: boolean;
  /** For dir='note' and dir='state' */
  note?: string;
}

export type LogSubscriber = (entry: LogEntry) => void;
