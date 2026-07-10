/**
 * Type definitions for the battery controller API.
 *
 * These mirror the server-side types from device-session.ts and db.ts.
 * WebSocket messages use the WsMessage discriminated union.
 * REST responses use the entity interfaces directly.
 */

// ── Device types ───────────────────────────────────────────────────

export type DeviceMode = 'idle' | 'd-cc' | 'd-cp' | 'c-cv' | 'complete' | 'fault';

export interface DecodedReading {
  mode: DeviceMode;
  stateByte: number;
  voltage: number;
  current: number;
  power: number;
  capacityMah: number;
  capacityAh: number;
  energyMwh: number;
  energyWh: number;
  elapsedS: number;
  timestamp: number;
  isInfoPacket: boolean;
  rawField7: number;
  setpointEcho: number;
  cutoffEcho: number;
  maxTimeEcho: number;
}

export interface DeviceInfo {
  typeByte: number;
  subtypeByte: number;
  constByte: number;
}

export interface PendingCommand {
  command: string;
  sentAt: number;
  expectedMode: DeviceMode | null;
}

// ── WebSocket messages ─────────────────────────────────────────────

export interface WsSnapshot {
  type: 'snapshot';
  data: {
    buildId: string;
    mode: DeviceMode;
    reading: DecodedReading;
    stats: TestStats;
    deviceInfo: DeviceInfo | null;
    activeRunId: number | null;
    activeRunMaxTimeMin: number | null;
    serialConnected: boolean;
    deviceResponsive: boolean;
    locked: boolean;
    bridgeActive?: boolean;
    cycleState?: CycleState;
    temperature?: {
      channels: TempChannelConfig[];
      readings: TempChannelReading[];
    };
  };
}

export interface WsReading {
  type: 'reading';
  data: DecodedReading;
}

export interface WsState {
  type: 'state';
  data: {
    mode: DeviceMode;
    previousMode: DeviceMode;
    activeRunId: number | null;
    timestamp: number;
  };
}

export interface WsConnected {
  type: 'connected';
  data: { timestamp: number };
}

export interface WsDisconnected {
  type: 'disconnected';
  data: { timestamp: number };
}

export interface WsDeviceInfo {
  type: 'deviceInfo';
  data: DeviceInfo;
}

export interface WsCommandPending {
  type: 'commandPending';
  data: PendingCommand;
}

export interface WsCommandConfirmed {
  type: 'commandConfirmed';
  data: { command: string; mode: DeviceMode };
}

export interface WsCommandTimeout {
  type: 'commandTimeout';
  data: { command: string };
}

export interface WsLockState {
  type: 'lockState';
  data: { locked: boolean };
}

export interface WsBridgeState {
  type: 'bridgeState';
  data: { active: boolean };
}

export type CycleStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'aborted' | 'error';

export interface CycleState {
  status: CycleStatus;
  programId: number | null;
  programName: string | null;
  currentExecIndex: number;
  totalExecSteps: number;
  currentCycle: number;
  totalCycles: number;
  waitEndTime: number | null;
  execStepTypes: string[];
  stepCapacities: (number | null)[];
  stepDurations: (number | null)[];
  stepExpectedS: number[];
  stepLabels?: string[];
}

export interface WsCycleState {
  type: 'cycleState';
  data: CycleState;
}

export interface WsDeviceResponsive {
  type: 'deviceResponsive';
  data: { responsive: boolean };
}

// ── Temperature types ─────────────────────────────────────────────

export interface TempChannelReading {
  channelId: string;
  channelDbId: number;
  name: string | null;
  tempC: number;
  /** Kalman-filtered temperature rate (°C/min); null until the filter warms up */
  dTdtCPerMin: number | null;
  alertMaxC: number | null;
}

export interface TempChannelConfig {
  id: string;
  name: string | null;
  sourceType: 'w1' | 'http';
  enabled: boolean;
  alertMaxC: number | null;
  firstSeenAt: string;
  lastSeenAt?: string | null;
  unpluggedAt?: string | null;
  // w1-specific
  deviceId?: string;
  // http-specific
  entityId?: string;
}

export interface WsTemperature {
  type: 'temperature';
  data: { readings: TempChannelReading[] };
}

export interface WsTempAlert {
  type: 'tempAlert';
  data: {
    channelId: string;
    name: string | null;
    tempC: number;
    alertMaxC: number;
  };
}

export interface WsTempChannelDiscovery {
  type: 'tempChannelDiscovered' | 'tempChannelUnplugged' | 'tempChannelReconnected';
  data: {
    channelId: string;
    deviceId?: string;
    name: string | null;
  };
}

export interface HaEntity {
  entityId: string;
  name: string;
  state: string;
  unit: string | null;
  deviceClass: string | null;
}

export type WsMessage =
  | WsSnapshot
  | WsReading
  | WsState
  | WsConnected
  | WsDisconnected
  | WsDeviceInfo
  | WsCommandPending
  | WsCommandConfirmed
  | WsCommandTimeout
  | WsLockState
  | WsBridgeState
  | WsDeviceResponsive
  | WsCycleState
  | WsTemperature
  | WsTempAlert
  | WsTempChannelDiscovery;

// ── REST entity types ──────────────────────────────────────────────

export interface TestStats {
  peakVoltage: number;
  minVoltage: number;
  peakCurrent: number;
  elapsedS: number;
}

export interface Cell {
  id: number;
  barcode: string;
  label: string | null;
  nominal_capacity_mah: number;
  chemistry: string;
  notes: string | null;
  cell_group_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CellGroup {
  id: number;
  name: string;
  nominal_capacity_mah: number;
  chemistry: string;
  charge_voltage_v: number | null;
  discharge_cutoff_v: number | null;
  charge_cutoff_current_a: number | null;
  created_at: string;
}

export interface TestRun {
  id: number;
  cell_id: number | null;
  cycle_program_id: number | null;
  cycle_step_index: number | null;
  mode: string;
  setpoint_current_a: number | null;
  setpoint_voltage_v: number | null;
  setpoint_power_w: number | null;
  setpoint_cutoff_v: number | null;
  setpoint_cutoff_current_a: number | null;
  setpoint_max_time_min: number | null;
  started_at: string;
  ended_at: string | null;
  start_reason: string;
  end_reason: string | null;
  final_capacity_mah: number | null;
  final_energy_mwh: number | null;
  peak_voltage_v: number | null;
  min_voltage_v: number | null;
  peak_current_a: number | null;
  duration_s: number | null;
  data_point_count: number;
}

/**
 * Compact format:
 * - Full-res: d = [[elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh], ...]
 * - Downsampled: d = [[elapsed_s, v_min, v_max, i_min, i_max, p_min, p_max, capacity_mah, energy_mwh], ...]
 *   with downsampled = true
 */
export interface TestRunWithData extends TestRun {
  d: number[][];
  downsampled?: boolean;
}

export interface DataPoint {
  id: number;
  run_id: number;
  elapsed_s: number;
  voltage_v: number;
  current_a: number;
  power_w: number;
  capacity_mah: number;
  energy_mwh: number;
  state_byte: number;
  recorded_at: string;
}

export interface Sequence {
  id: number;
  name: string;
  cell_group_id: number | null;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

// ── Capacity & fleet stats ────────────────────────────────────────

export interface RunCapacitySummary {
  id: number;
  date: string;
  capacityAh: number;
  currentA: number;
  durationS: number | null;
  normalizedAh: number | null;
}

export interface CellCapacityStats {
  cellId: number;
  barcode: string;
  label: string | null;
  runCount: number;
  latestAh: number | null;
  meanAh: number | null;
  medianAh: number | null;
  stddevAh: number | null;
  minAh: number | null;
  maxAh: number | null;
  trendAhPerCycle: number | null;
  trendPctPerCycle: number | null;
  healthPct: number | null;
  nominalAh: number;
  runs: RunCapacitySummary[];
}

export interface GroupFleetSummary {
  groupId: number;
  groupName: string;
  nominalAh: number;
  cellsTested: number;
  cellsTotal: number;
  avgLatestAh: number | null;
  minLatestAh: number | null;
  maxLatestAh: number | null;
  weakestCell: { cellId: number; barcode: string; capacityAh: number } | null;
  strongestCell: { cellId: number; barcode: string; capacityAh: number } | null;
  avgHealthPct: number | null;
  cells: CellCapacityStats[];
}

// ── REST API helper ────────────────────────────────────────────────

const BASE = '';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
