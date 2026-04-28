/**
 * Chart data utilities — prepares run data for uPlot.
 *
 * uPlot requires a single aligned dataset: [xValues, y1, y2, ...].
 * Each historical run and the live run contribute series to this dataset.
 * Since all runs start at elapsed_s = 0, they share the same X domain.
 *
 * Strategy: merge all visible runs' time points into one sorted X array.
 * For each run's visible metrics, fill values at matching time indices
 * and undefined elsewhere. uPlot skips undefined gaps in series.
 */

import type { DataPoint, TestRun } from '../api-client.ts';
import type { LivePoint } from '../hooks/useDeviceSession.ts';
import { ocvToSoc, type ReferenceCurve } from './lfp-reference-curves.ts';

// ── Types ──────────────────────────────────────────────────────────

export type MetricKey = 'voltage' | 'current' | 'power' | 'capacity';

export interface ChartRun {
  id: number;
  meta: TestRun;
  /** Cell label or barcode for display */
  label: string;
  /** Pre-parsed data arrays, aligned to run's own time axis */
  elapsed: number[];
  voltage: number[];
  current: number[];
  power: number[];
  capacity: number[];
}

export interface ChartSeriesInfo {
  /** Which run this series belongs to */
  runId: number;
  /** Which metric */
  metric: MetricKey;
  /** Display label */
  label: string;
  /** CSS color */
  color: string;
  /** Whether this is the live run */
  isLive: boolean;
}

/** Horizontal threshold line drawn on the chart (cutoff voltage, target current, etc.) */
export interface ThresholdLine {
  value: number;
  /** uPlot scale key: 'V', 'A', 'W', 'Ah' */
  scale: string;
  label: string;
  color: string;
}

export interface MergedChartData {
  /** Aligned data for uPlot: [xValues, ...seriesValues] */
  data: (number | null | undefined)[][];
  /** Metadata for each series (index 0 = X, so seriesInfo[0] = series at data[1]) */
  seriesInfo: ChartSeriesInfo[];
}

// ── Color palette ──────────────────────────────────────────────────

const RUN_COLORS = [
  '#4fc3f7', // light blue
  '#81c784', // green
  '#ffb74d', // orange
  '#e57373', // red
  '#ba68c8', // purple
  '#4db6ac', // teal
  '#fff176', // yellow
  '#f06292', // pink
  '#90a4ae', // blue-grey
  '#aed581', // light green
];

export function getRunColor(index: number): string {
  return RUN_COLORS[index % RUN_COLORS.length];
}

const LIVE_COLOR = '#00e676'; // bright green — clearly distinct from historical palette

const METRIC_ALPHA: Record<MetricKey, number> = {
  voltage: 1.0,
  current: 0.7,
  power: 0.5,
  capacity: 0.6,
};

function colorWithAlpha(hex: string, alpha: number): string {
  // Convert hex to rgba
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Data conversion ────────────────────────────────────────────────

export function dataPointsToChartRun(
  meta: TestRun,
  points: DataPoint[],
  label: string,
): ChartRun {
  const n = points.length;
  const elapsed = new Array<number>(n);
  const voltage = new Array<number>(n);
  const current = new Array<number>(n);
  const power = new Array<number>(n);
  const capacity = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    elapsed[i] = p.elapsed_s;
    voltage[i] = p.voltage_v;
    current[i] = p.current_a;
    power[i] = p.power_w;
    capacity[i] = p.capacity_mah / 1000; // Show as Ah
  }

  return { id: meta.id, meta, label, elapsed, voltage, current, power, capacity };
}

/** Parse compact data rows: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh] */
export function compactDataToChartRun(
  meta: TestRun,
  rows: number[][],
  label: string,
): ChartRun {
  const n = rows.length;
  const elapsed = new Array<number>(n);
  const voltage = new Array<number>(n);
  const current = new Array<number>(n);
  const power = new Array<number>(n);
  const capacity = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    elapsed[i] = r[0];
    voltage[i] = r[1];
    current[i] = r[2];
    power[i] = r[3];
    capacity[i] = r[4] / 1000; // mAh → Ah
  }

  return { id: meta.id, meta, label, elapsed, voltage, current, power, capacity };
}

export function livePointsToArrays(points: LivePoint[]): {
  elapsed: number[];
  voltage: number[];
  current: number[];
  power: number[];
  capacity: number[];
} {
  const n = points.length;
  const elapsed = new Array<number>(n);
  const voltage = new Array<number>(n);
  const current = new Array<number>(n);
  const power = new Array<number>(n);
  const capacity = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    elapsed[i] = p.t;
    voltage[i] = p.v;
    current[i] = p.i;
    power[i] = p.p;
    capacity[i] = p.ah / 1000; // Ah
  }

  return { elapsed, voltage, current, power, capacity };
}

// ── Active run + live point merging ──────────────────────────────────

/**
 * Merge a run's REST-loaded data with live WebSocket points into one
 * contiguous dataset. Takes all REST points before the first live point's
 * timestamp, then appends all live points — so the boundary is seamless.
 */
function mergeActiveRunAndLivePoints(
  run: ChartRun,
  livePoints: LivePoint[],
): { elapsed: number[]; voltage: number[]; current: number[]; power: number[]; capacity: number[] } {
  const liveData = livePointsToArrays(livePoints);
  const firstLiveT = liveData.elapsed[0] ?? Infinity;

  // Find cutoff: last REST point before the first live point
  let cutoff = run.elapsed.length;
  for (let i = 0; i < run.elapsed.length; i++) {
    if (run.elapsed[i] >= firstLiveT) {
      cutoff = i;
      break;
    }
  }

  return {
    elapsed: [...run.elapsed.slice(0, cutoff), ...liveData.elapsed],
    voltage: [...run.voltage.slice(0, cutoff), ...liveData.voltage],
    current: [...run.current.slice(0, cutoff), ...liveData.current],
    power: [...run.power.slice(0, cutoff), ...liveData.power],
    capacity: [...run.capacity.slice(0, cutoff), ...liveData.capacity],
  };
}

/**
 * Return a copy of `runs` where the active run (if present) has live
 * WS points merged in.  Useful for charts that don't distinguish
 * live vs historical styling but still need up-to-date data.
 */
export function mergeActiveRunWithLive(
  runs: ChartRun[],
  activeRunId: number | null | undefined,
  livePoints: LivePoint[],
): ChartRun[] {
  if (!activeRunId || livePoints.length === 0) return runs;
  return runs.map(run => {
    if (run.id !== activeRunId) return run;
    const merged = mergeActiveRunAndLivePoints(run, livePoints);
    return { ...run, ...merged };
  });
}

// ── Merge logic ────────────────────────────────────────────────────

/**
 * Merge multiple runs into a single uPlot-aligned dataset.
 *
 * @param runs Historical runs (already loaded from DB)
 * @param livePoints Current live test data (from WebSocket)
 * @param visibleRuns Set of run IDs to include (null = all)
 * @param visibleMetrics Which metrics to include as series
 * @param isTestActive Whether a live test is currently running
 * @param activeRunId The currently-running test's run ID (so its REST
 *   data merges with live WS points into a single live series)
 */
export function mergeRunsForChart(
  runs: ChartRun[],
  livePoints: LivePoint[],
  visibleRuns: Set<number> | null,
  visibleMetrics: Set<MetricKey>,
  isTestActive: boolean,
  activeRunId?: number | null,
): MergedChartData {
  // Filter to visible runs
  const allVisible = visibleRuns
    ? runs.filter(r => visibleRuns.has(r.id))
    : runs;

  // Separate the active run from historical runs so it gets live styling
  let historicalRuns = allVisible;
  let activeRun: ChartRun | null = null;
  if (activeRunId != null) {
    activeRun = allVisible.find(r => r.id === activeRunId) ?? null;
    if (activeRun) {
      historicalRuns = allVisible.filter(r => r.id !== activeRunId);
    }
  }

  // Build the live dataset: merge active run's stored data with WS live points
  const hasLive = isTestActive && (livePoints.length > 0 || activeRun != null);
  let live: ReturnType<typeof livePointsToArrays> | null = null;

  if (hasLive) {
    if (activeRun && livePoints.length > 0) {
      // Merge REST data + WS points, deduplicating at the boundary
      live = mergeActiveRunAndLivePoints(activeRun, livePoints);
    } else if (activeRun) {
      // WS hasn't sent points yet — show REST data with live styling
      live = {
        elapsed: activeRun.elapsed,
        voltage: activeRun.voltage,
        current: activeRun.current,
        power: activeRun.power,
        capacity: activeRun.capacity,
      };
    } else {
      // No REST data for the active run — just WS points
      live = livePointsToArrays(livePoints);
    }
  }

  // Collect all unique time points
  const timeSet = new Set<number>();
  for (const run of historicalRuns) {
    for (const t of run.elapsed) timeSet.add(t);
  }
  if (live) {
    for (const t of live.elapsed) timeSet.add(t);
  }

  const xValues = Array.from(timeSet).sort((a, b) => a - b);
  const n = xValues.length;

  if (n === 0) {
    return { data: [[]], seriesInfo: [] };
  }

  // Build a time→index map for O(1) lookup
  const timeIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    timeIndex.set(xValues[i], i);
  }

  const data: (number | null | undefined)[][] = [xValues];
  const seriesInfo: ChartSeriesInfo[] = [];
  const metricsArr = Array.from(visibleMetrics);
  const desatAlpha = isTestActive ? 0.20 : 1.0;

  // Add series for each historical run
  for (let ri = 0; ri < historicalRuns.length; ri++) {
    const run = historicalRuns[ri];
    const baseColor = getRunColor(ri);

    for (const metric of metricsArr) {
      const values = new Array<number | null | undefined>(n).fill(undefined);
      const srcArr = run[metric];
      const srcTime = run.elapsed;

      for (let j = 0; j < srcArr.length; j++) {
        const idx = timeIndex.get(srcTime[j]);
        if (idx !== undefined) {
          values[idx] = srcArr[j];
        }
      }

      const alpha = METRIC_ALPHA[metric] * desatAlpha;
      data.push(values);
      seriesInfo.push({
        runId: run.id,
        metric,
        label: `${run.label} ${metric}`,
        color: colorWithAlpha(baseColor, alpha),
        isLive: false,
      });
    }
  }

  // Add series for live run
  if (live) {
    for (const metric of metricsArr) {
      const values = new Array<number | null | undefined>(n).fill(undefined);
      const srcArr = live[metric];
      const srcTime = live.elapsed;

      for (let j = 0; j < srcArr.length; j++) {
        const idx = timeIndex.get(srcTime[j]);
        if (idx !== undefined) {
          values[idx] = srcArr[j];
        }
      }

      const alpha = METRIC_ALPHA[metric];
      data.push(values);
      seriesInfo.push({
        runId: -1,
        metric,
        label: `Live ${metric}`,
        color: colorWithAlpha(LIVE_COLOR, alpha),
        isLive: true,
      });
    }
  }

  return { data, seriesInfo };
}

// ── Time formatting ────────────────────────────────────────────────

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatElapsedShort(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ══════════════════════════════════════════════════════════════════
// Capacity-domain chart data
// ══════════════════════════════════════════════════════════════════

/**
 * A run converted to the capacity domain: voltage vs capacity%.
 * Downsampled to a fixed grid for efficient chart alignment.
 */
export interface CapacityRun {
  id: number;
  meta: TestRun;
  label: string;
  /** Whether this is a charge or discharge run */
  direction: 'charge' | 'discharge';
  /** Capacity % values on the fixed grid */
  capacityPct: number[];
  /** Voltage at each grid point (null where no data) */
  voltage: (number | null)[];
  /** Current at each grid point (null where no data) */
  current: (number | null)[];
  /** Whether the start offset was estimated from OCV */
  offsetEstimated: boolean;
  /** Estimated SoC offset in % (0 if run started at full/empty) */
  offsetPct: number;
}

export interface CapacityChartData {
  /** Aligned data for uPlot: [xValues, ...seriesValues] */
  data: (number | null | undefined)[][];
  /** Metadata for each series */
  seriesInfo: CapacitySeriesInfo[];
}

export interface CapacitySeriesInfo {
  /** Which run this series belongs to (-1 for reference curves) */
  runId: number;
  /** Display label */
  label: string;
  /** CSS color */
  color: string;
  /** Which metric this series shows */
  metric: 'voltage' | 'current';
  /** Whether this is a reference curve */
  isReference: boolean;
  /** Reference curve style (for dash patterns) */
  refStyle?: 'datasheet' | 'computed';
  /** Charge or discharge */
  direction: 'charge' | 'discharge';
}

// ── Fixed capacity grid ───────────────────────────────────────────
// All runs are interpolated onto this grid for alignment.
// 0.5% steps = 201 points — plenty for smooth curves.

const CAPACITY_GRID_STEP = 0.5;
const CAPACITY_GRID: number[] = [];
for (let p = 0; p <= 100; p += CAPACITY_GRID_STEP) {
  CAPACITY_GRID.push(Math.round(p * 10) / 10); // avoid float drift
}

/**
 * Linearly interpolate a value from parallel x/y arrays at target x.
 * Returns null if target is outside the data range.
 */
function lerpAt(xs: number[], ys: number[], target: number): number | null {
  if (xs.length === 0) return null;
  if (target < xs[0] || target > xs[xs.length - 1]) return null;

  // Binary search for the bracketing interval
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= target) lo = mid;
    else hi = mid;
  }

  if (xs[lo] === target) return ys[lo];
  if (lo === hi) return ys[lo];

  const t = (target - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/**
 * Convert a time-domain ChartRun to a capacity-domain CapacityRun.
 *
 * @param run The time-domain run data
 * @param nominalCapacityMah Nominal cell capacity in mAh
 */
export function runToCapacityDomain(
  run: ChartRun,
  nominalCapacityMah: number,
): CapacityRun {
  const isCharge = run.meta.mode === 'c-cv';
  const direction: 'charge' | 'discharge' = isCharge ? 'charge' : 'discharge';

  // Convert cumulative capacity (Ah, already divided by 1000) to % of nominal
  const nominalAh = nominalCapacityMah / 1000;
  const rawPct = run.capacity.map(ah => (ah / nominalAh) * 100);

  // Estimate SoC offset from initial voltage
  const initialV = run.voltage[0];
  let offsetPct = 0;
  let offsetEstimated = false;

  if (initialV !== undefined) {
    const estimatedSoc = ocvToSoc(initialV);

    if (isCharge && estimatedSoc > 8) {
      // Charge didn't start at empty — offset the capacity axis
      offsetPct = estimatedSoc;
      offsetEstimated = true;
    } else if (!isCharge && estimatedSoc < 92) {
      // Discharge didn't start at full — offset from 100%
      offsetPct = 100 - estimatedSoc;
      offsetEstimated = true;
    }
  }

  // Apply offset: capacity% = offset + raw%
  const adjustedPct = rawPct.map(p => offsetPct + p);

  // Interpolate onto fixed grid
  const voltage: (number | null)[] = CAPACITY_GRID.map(gridPct =>
    lerpAt(adjustedPct, run.voltage, gridPct)
  );
  const current: (number | null)[] = CAPACITY_GRID.map(gridPct =>
    lerpAt(adjustedPct, run.current, gridPct)
  );

  return {
    id: run.id,
    meta: run.meta,
    label: run.label,
    direction,
    capacityPct: CAPACITY_GRID,
    voltage,
    current,
    offsetEstimated,
    offsetPct,
  };
}

// ── Merge capacity runs for uPlot ─────────────────────────────────

const REF_COLORS: Record<string, string> = {
  'datasheet-discharge': 'rgba(255, 152, 0, 0.50)',
  'datasheet-charge': 'rgba(79, 195, 247, 0.50)',
  'computed-discharge': 'rgba(255, 183, 77, 0.65)',
  'computed-charge': 'rgba(129, 212, 250, 0.65)',
};

const DISCHARGE_COLORS = [
  '#ff9800', // orange
  '#ffb74d', // light orange
  '#ff7043', // deep orange
  '#ffa726', // amber
  '#e65100', // dark orange
  '#ef6c00', // orange variant
  '#f57c00', // orange 700
  '#fb8c00', // orange 600
  '#ff6e40', // deep orange accent
  '#ffab40', // orange accent
];

const CHARGE_COLORS = [
  '#4fc3f7', // light blue
  '#29b6f6', // blue
  '#03a9f4', // blue
  '#0288d1', // dark blue
  '#81d4fa', // lighter blue
  '#4dd0e1', // cyan
  '#26c6da', // cyan
  '#00bcd4', // cyan
  '#0097a7', // dark cyan
  '#80deea', // light cyan
];

/** Reduce alpha for current series so they don't overpower voltage */
const CURRENT_ALPHA = 0.45;

function applyAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Merge capacity-domain runs and reference curves into a uPlot-ready dataset.
 */
export function mergeCapacityChart(
  runs: CapacityRun[],
  referenceCurves: ReferenceCurve[],
  visibleRuns: Set<number> | null,
): CapacityChartData {
  const xValues = CAPACITY_GRID;

  const data: (number | null | undefined)[][] = [[...xValues]];
  const seriesInfo: CapacitySeriesInfo[] = [];

  // Add reference curves first (drawn behind data) — voltage only
  for (const ref of referenceCurves) {
    const isDischarge = ref.label.toLowerCase().includes('discharge');
    const colorKey = `${ref.style}-${isDischarge ? 'discharge' : 'charge'}`;

    const values: (number | null | undefined)[] = xValues.map(pct =>
      lerpAt(ref.capacityPct, ref.voltage, pct) ?? undefined
    );

    data.push(values);
    seriesInfo.push({
      runId: -1,
      label: ref.label,
      color: REF_COLORS[colorKey] ?? 'rgba(255,255,255,0.25)',
      metric: 'voltage',
      isReference: true,
      refStyle: ref.style,
      direction: isDischarge ? 'discharge' : 'charge',
    });
  }

  // Add visible runs — both voltage and current series per run
  const activeRuns = visibleRuns
    ? runs.filter(r => visibleRuns.has(r.id))
    : runs;

  let dischargeIdx = 0;
  let chargeIdx = 0;

  for (const run of activeRuns) {
    const colors = run.direction === 'discharge' ? DISCHARGE_COLORS : CHARGE_COLORS;
    const idx = run.direction === 'discharge' ? dischargeIdx++ : chargeIdx++;
    const color = colors[idx % colors.length];

    // Voltage series
    const vValues: (number | null | undefined)[] = run.voltage.map(v => v ?? undefined);
    data.push(vValues);
    seriesInfo.push({
      runId: run.id,
      label: `${run.label} V`,
      color,
      metric: 'voltage',
      isReference: false,
      direction: run.direction,
    });

    // Current series (reduced alpha)
    const iValues: (number | null | undefined)[] = run.current.map(v => v ?? undefined);
    data.push(iValues);
    seriesInfo.push({
      runId: run.id,
      label: `${run.label} A`,
      color: applyAlpha(color, CURRENT_ALPHA),
      metric: 'current',
      isReference: false,
      direction: run.direction,
    });
  }

  return { data, seriesInfo };
}
