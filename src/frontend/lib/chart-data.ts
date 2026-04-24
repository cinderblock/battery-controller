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

const LIVE_COLOR = '#ffffff';

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

// ── Merge logic ────────────────────────────────────────────────────

/**
 * Merge multiple runs into a single uPlot-aligned dataset.
 *
 * @param runs Historical runs (already loaded from DB)
 * @param livePoints Current live test data (from WebSocket)
 * @param visibleRuns Set of run IDs to include (null = all)
 * @param visibleMetrics Which metrics to include as series
 * @param isTestActive Whether a live test is currently running
 * @param desaturateHistory When true, historical runs use lower alpha
 */
export function mergeRunsForChart(
  runs: ChartRun[],
  livePoints: LivePoint[],
  visibleRuns: Set<number> | null,
  visibleMetrics: Set<MetricKey>,
  isTestActive: boolean,
): MergedChartData {
  // Filter to visible runs
  const activeRuns = visibleRuns
    ? runs.filter(r => visibleRuns.has(r.id))
    : runs;

  const hasLive = isTestActive && livePoints.length > 0;
  const live = hasLive ? livePointsToArrays(livePoints) : null;

  // Collect all unique time points
  const timeSet = new Set<number>();
  for (const run of activeRuns) {
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
  const desatAlpha = isTestActive ? 0.35 : 1.0;

  // Add series for each historical run
  for (let ri = 0; ri < activeRuns.length; ri++) {
    const run = activeRuns[ri];
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
