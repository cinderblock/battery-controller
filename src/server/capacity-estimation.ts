/**
 * Capacity estimation — statistical analysis of discharge test data.
 *
 * Computes per-cell and fleet-level capacity statistics from completed
 * D-CC discharge runs. Includes Peukert normalization for comparing
 * runs at different discharge rates, and linear trend detection for
 * tracking cell degradation over time.
 *
 * All capacities are in mAh internally, converted to Ah for API output.
 */

import {
  type Cell,
  getAllCompletedDischargeRuns,
  getCellById,
  getCellGroup,
  getCellsInGroup,
  getCompletedDischargeRuns,
  getIrHistoryForCell,
  type TestRun,
} from './db.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface CellCapacityStats {
  cellId: number;
  barcode: string;
  label: string | null;
  /** Number of completed discharge runs */
  runCount: number;
  /** Most recent capacity in Ah */
  latestAh: number | null;
  /** Mean capacity in Ah */
  meanAh: number | null;
  /** Median capacity in Ah */
  medianAh: number | null;
  /** Standard deviation in Ah */
  stddevAh: number | null;
  /** Minimum capacity in Ah */
  minAh: number | null;
  /** Maximum capacity in Ah */
  maxAh: number | null;
  /** Trend: Ah change per cycle (negative = degradation) */
  trendAhPerCycle: number | null;
  /** Trend: percentage change per cycle */
  trendPctPerCycle: number | null;
  /** Health: latest capacity as % of nominal */
  healthPct: number | null;
  /** Nominal capacity of the cell in Ah */
  nominalAh: number;
  /** Most recent DC internal-resistance estimate (mΩ) */
  latestIrMohm: number | null;
  /** Median IR across all runs with an estimate (mΩ) */
  medianIrMohm: number | null;
  /** Number of runs contributing IR estimates */
  irRunCount: number;
  /** Runs used for stats (id, date, capacity, discharge rate) */
  runs: RunSummary[];
}

export interface RunSummary {
  id: number;
  date: string;
  capacityAh: number;
  currentA: number;
  durationS: number | null;
  /** Peukert-normalized capacity at reference rate (Ah) */
  normalizedAh: number | null;
}

export interface GroupFleetSummary {
  groupId: number;
  groupName: string;
  nominalAh: number;
  /** Number of cells with at least one completed discharge run */
  cellsTested: number;
  /** Total cells in the group */
  cellsTotal: number;
  /** Average latest capacity across cells (Ah) */
  avgLatestAh: number | null;
  /** Min latest capacity across cells (Ah) */
  minLatestAh: number | null;
  /** Max latest capacity across cells (Ah) */
  maxLatestAh: number | null;
  /** Weakest cell (lowest latest capacity) */
  weakestCell: { cellId: number; barcode: string; capacityAh: number } | null;
  /** Strongest cell (highest latest capacity) */
  strongestCell: { cellId: number; barcode: string; capacityAh: number } | null;
  /** Fleet health: average health% across cells */
  avgHealthPct: number | null;
  /** Per-cell summaries (sorted by latest capacity ascending) */
  cells: CellCapacityStats[];
}

// ── Peukert correction ────────────────────────────────────────────────

/**
 * Peukert exponent for LiFePO4 cells.
 * LiFePO4 has very flat discharge curves, so the Peukert effect is
 * minimal (~1.02-1.05). We use 1.03 as a conservative default.
 */
const PEUKERT_EXPONENT = 1.03;

/**
 * Reference discharge rate for normalization (amps).
 * C/5 for a 200Ah cell = 40A (which is also the device max).
 */
const REFERENCE_RATE_A = 40;

/**
 * Normalize a measured capacity to a reference discharge rate using
 * the Peukert equation: C_ref = C_meas × (I_meas / I_ref)^(k-1)
 *
 * where k is the Peukert exponent.
 */
function peukertNormalize(
  measuredAh: number,
  measuredCurrentA: number,
  referenceCurrentA: number = REFERENCE_RATE_A,
  exponent: number = PEUKERT_EXPONENT
): number {
  if (measuredCurrentA <= 0 || referenceCurrentA <= 0) return measuredAh;
  return measuredAh * (measuredCurrentA / referenceCurrentA) ** (exponent - 1);
}

// ── Statistics helpers ────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Simple linear regression: y = slope * x + intercept.
 * Returns slope. x is 0-indexed cycle number.
 */
function linearTrendSlope(values: number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

// ── Core analysis ─────────────────────────────────────────────────────

function runToSummary(run: TestRun): RunSummary {
  const capacityAh = (run.final_capacity_mah ?? 0) / 1000;
  const currentA = run.setpoint_current_a ?? 0;
  return {
    id: run.id,
    date: run.started_at,
    capacityAh,
    currentA,
    durationS: run.duration_s,
    normalizedAh: currentA > 0 ? peukertNormalize(capacityAh, currentA) : null,
  };
}

/**
 * Compute capacity statistics for a single cell.
 */
export function getCellCapacityStats(cellId: number): CellCapacityStats | null {
  const cell = getCellById(cellId);
  if (!cell) return null;

  const runs = getCompletedDischargeRuns(cellId);
  const nominalAh = cell.nominal_capacity_mah / 1000;

  const runSummaries = runs.map(runToSummary);
  const capacities = runSummaries.map(r => r.capacityAh);

  // IR history spans charge and discharge runs alike (unlike capacity stats)
  const irValues = getIrHistoryForCell(cellId).map(r => r.ir_mohm);
  const latestIrMohm = irValues.length > 0 ? round2(irValues[irValues.length - 1]) : null;
  const medianIrMohm = irValues.length > 0 ? round2(median(irValues)) : null;

  if (capacities.length === 0) {
    return {
      cellId,
      barcode: cell.barcode,
      label: cell.label,
      runCount: 0,
      latestAh: null,
      meanAh: null,
      medianAh: null,
      stddevAh: null,
      minAh: null,
      maxAh: null,
      trendAhPerCycle: null,
      trendPctPerCycle: null,
      healthPct: null,
      nominalAh,
      latestIrMohm,
      medianIrMohm,
      irRunCount: irValues.length,
      runs: [],
    };
  }

  const latest = capacities[capacities.length - 1];
  const m = mean(capacities);
  const trend = linearTrendSlope(capacities);

  return {
    cellId,
    barcode: cell.barcode,
    label: cell.label,
    runCount: capacities.length,
    latestAh: round2(latest),
    meanAh: round2(m),
    medianAh: round2(median(capacities)),
    stddevAh: round2(stddev(capacities)),
    minAh: round2(Math.min(...capacities)),
    maxAh: round2(Math.max(...capacities)),
    trendAhPerCycle: trend !== null ? round3(trend) : null,
    trendPctPerCycle: trend !== null && m > 0 ? round3((trend / m) * 100) : null,
    healthPct: nominalAh > 0 ? round1((latest / nominalAh) * 100) : null,
    nominalAh,
    latestIrMohm,
    medianIrMohm,
    irRunCount: irValues.length,
    runs: runSummaries,
  };
}

/**
 * Compute fleet summary for a cell group.
 */
export function getGroupFleetSummary(groupId: number): GroupFleetSummary | null {
  const group = getCellGroup(groupId);
  if (!group) return null;

  const cells = getCellsInGroup(groupId);
  const nominalAh = group.nominal_capacity_mah / 1000;

  const cellStats: CellCapacityStats[] = [];
  for (const cell of cells) {
    const stats = getCellCapacityStats(cell.id);
    if (stats) cellStats.push(stats);
  }

  const testedCells = cellStats.filter(c => c.runCount > 0);
  const latestValues = testedCells.map(c => c.latestAh).filter((v): v is number => v !== null);

  // Sort by latest capacity ascending (weakest first)
  testedCells.sort((a, b) => (a.latestAh ?? 0) - (b.latestAh ?? 0));

  const weakest = testedCells.length > 0 ? testedCells[0] : null;
  const strongest = testedCells.length > 0 ? testedCells[testedCells.length - 1] : null;

  return {
    groupId,
    groupName: group.name,
    nominalAh,
    cellsTested: testedCells.length,
    cellsTotal: cells.length,
    avgLatestAh: latestValues.length > 0 ? round2(mean(latestValues)) : null,
    minLatestAh: latestValues.length > 0 ? round2(Math.min(...latestValues)) : null,
    maxLatestAh: latestValues.length > 0 ? round2(Math.max(...latestValues)) : null,
    weakestCell:
      weakest?.latestAh != null
        ? { cellId: weakest.cellId, barcode: weakest.barcode, capacityAh: weakest.latestAh }
        : null,
    strongestCell:
      strongest?.latestAh != null
        ? { cellId: strongest.cellId, barcode: strongest.barcode, capacityAh: strongest.latestAh }
        : null,
    avgHealthPct:
      testedCells.length > 0 ? round1(mean(testedCells.map(c => c.healthPct ?? 0).filter(v => v > 0))) : null,
    cells: cellStats,
  };
}

/**
 * Quick summary of all cells that have test data, regardless of group.
 * Useful when cells haven't been assigned to groups yet.
 */
export function getAllCellStats(): CellCapacityStats[] {
  const allRuns = getAllCompletedDischargeRuns();

  // Group runs by cell_id
  const runsByCell = new Map<number, TestRun[]>();
  for (const run of allRuns) {
    if (run.cell_id === null) continue;
    const list = runsByCell.get(run.cell_id) ?? [];
    list.push(run);
    runsByCell.set(run.cell_id, list);
  }

  const results: CellCapacityStats[] = [];
  for (const cellId of runsByCell.keys()) {
    const stats = getCellCapacityStats(cellId);
    if (stats) results.push(stats);
  }

  // Sort by latest capacity ascending
  results.sort((a, b) => (a.latestAh ?? 0) - (b.latestAh ?? 0));
  return results;
}

// ── Rounding helpers ──────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
