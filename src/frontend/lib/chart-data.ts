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

import type { IrSample } from '../../shared/ir-estimate.ts';
import type { DataPoint, TestRun } from '../api-client.ts';
import type { LivePoint, LiveTempPoint } from '../hooks/useDeviceSession.ts';
import { ocvToSoc, type ReferenceCurve } from './lfp-reference-curves.ts';

// ── Types ──────────────────────────────────────────────────────────

export type MetricKey = 'voltage' | 'current' | 'power' | 'capacity' | 'temperature' | 'ir';

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
  /** True when this run has downsampled min/max range data */
  downsampled?: boolean;
  /** Min/max ranges — only present for downsampled runs */
  voltageMin?: number[];
  voltageMax?: number[];
  currentMin?: number[];
  currentMax?: number[];
  powerMin?: number[];
  powerMax?: number[];
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
  /** Undimmed (vivid) color — used to brighten this trace when its step is
   *  highlighted from the timeline, even when `color` is alpha-dimmed. */
  baseColor?: string;
  /** Whether this is the live run */
  isLive: boolean;
  /** Temperature channel ID (only for temperature series) */
  channelId?: string;
}

/** Horizontal threshold line drawn on the chart (cutoff voltage, target current, etc.) */
export interface ThresholdLine {
  value: number;
  /** uPlot scale key: 'V', 'A', 'W', 'Ah' */
  scale: string;
  label: string;
  color: string;
}

/** Band fill between two series (for downsampled min/max ranges) */
export interface BandDef {
  /** Series index of the min bound (1-based, matching uPlot series) */
  minIdx: number;
  /** Series index of the max bound */
  maxIdx: number;
  /** Fill color */
  fill: string;
}

export interface MergedChartData {
  /** Aligned data for uPlot: [xValues, ...seriesValues] */
  data: (number | null | undefined)[][];
  /** Metadata for each series (index 0 = X, so seriesInfo[0] = series at data[1]) */
  seriesInfo: ChartSeriesInfo[];
  /** Band fills for downsampled min/max ranges */
  bands?: BandDef[];
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

// ── Run color assignment ───────────────────────────────────────────

export type ColorBy = 'run' | 'mode' | 'cell';

const NO_CELL_COLOR = '#90a4ae'; // blue-grey for runs without a cell

/**
 * Assign a stable color per run over the FULL run list (not just visible
 * runs), so chart series and legend swatches always agree regardless of
 * filtering.
 *
 * - 'run':  distinct palette color per run
 * - 'mode': charge runs in blues, discharge runs in oranges
 * - 'cell': one color per cell, grey for runs without a cell
 */
export function buildRunColorMap(runs: ChartRun[], colorBy: ColorBy): Map<number, string> {
  const map = new Map<number, string>();

  if (colorBy === 'mode') {
    let chargeIdx = 0;
    let dischargeIdx = 0;
    for (const run of runs) {
      const isCharge = run.meta.mode === 'c-cv';
      const palette = isCharge ? CHARGE_COLORS : DISCHARGE_COLORS;
      const idx = isCharge ? chargeIdx++ : dischargeIdx++;
      map.set(run.id, palette[idx % palette.length]);
    }
  } else if (colorBy === 'cell') {
    const cellOrder = new Map<number, number>();
    for (const run of runs) {
      const cellId = run.meta.cell_id;
      if (cellId == null) {
        map.set(run.id, NO_CELL_COLOR);
        continue;
      }
      let idx = cellOrder.get(cellId);
      if (idx === undefined) {
        idx = cellOrder.size;
        cellOrder.set(cellId, idx);
      }
      map.set(run.id, getRunColor(idx));
    }
  } else {
    runs.forEach((run, i) => map.set(run.id, getRunColor(i)));
  }

  return map;
}

/**
 * Live-trace colors per metric: a brighter variant of the matching y-axis
 * color (V axis #4fc3f7, A axis #81c784, W axis #ffb74d, Ah axis #ba68c8),
 * so the live voltage trace reads as "the blue axis" and live current as
 * "the green axis" at a glance.
 */
const LIVE_COLORS: Record<MetricKey, string> = {
  voltage: '#40c4ff', // bright blue
  current: '#00e676', // bright green
  power: '#ffab40', // bright amber
  capacity: '#e040fb', // bright purple
  temperature: '#ff5252', // bright red (unused — temp chart colors per channel)
  ir: '#26c6da', // cyan (unused — IR series built in buildTempChartData)
};

const METRIC_ALPHA: Record<MetricKey, number> = {
  voltage: 1.0,
  current: 0.7,
  power: 0.5,
  capacity: 0.6,
  temperature: 0.9,
  ir: 0.9,
};

/** DC-IR trace color — cyan, distinct from the warm temperature palette */
const IR_COLOR = '#26c6da';

function colorWithAlpha(hex: string, alpha: number): string {
  // Convert hex to rgba
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Data conversion ────────────────────────────────────────────────

export function dataPointsToChartRun(meta: TestRun, points: DataPoint[], label: string): ChartRun {
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

/**
 * Parse compact data rows.
 * Full-res: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh]
 * Downsampled: [elapsed_s, v_min, v_max, i_min, i_max, p_min, p_max, capacity_mah, energy_mwh]
 */
export function compactDataToChartRun(meta: TestRun, rows: number[][], label: string, downsampled?: boolean): ChartRun {
  const n = rows.length;
  const elapsed = new Array<number>(n);
  const capacity = new Array<number>(n);

  if (downsampled) {
    // Downsampled: use midpoint of min/max as the main line, keep min/max for bands
    const voltage = new Array<number>(n);
    const current = new Array<number>(n);
    const power = new Array<number>(n);
    const voltageMin = new Array<number>(n);
    const voltageMax = new Array<number>(n);
    const currentMin = new Array<number>(n);
    const currentMax = new Array<number>(n);
    const powerMin = new Array<number>(n);
    const powerMax = new Array<number>(n);

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      // [t, vMin, vMax, iMin, iMax, pMin, pMax, cap, energy]
      elapsed[i] = r[0];
      voltageMin[i] = r[1];
      voltageMax[i] = r[2];
      currentMin[i] = r[3];
      currentMax[i] = r[4];
      powerMin[i] = r[5];
      powerMax[i] = r[6];
      voltage[i] = (r[1] + r[2]) / 2;
      current[i] = (r[3] + r[4]) / 2;
      power[i] = (r[5] + r[6]) / 2;
      capacity[i] = r[7] / 1000; // mAh → Ah
    }

    return {
      id: meta.id,
      meta,
      label,
      elapsed,
      voltage,
      current,
      power,
      capacity,
      downsampled: true,
      voltageMin,
      voltageMax,
      currentMin,
      currentMax,
      powerMin,
      powerMax,
    };
  }

  // Full resolution
  const voltage = new Array<number>(n);
  const current = new Array<number>(n);
  const power = new Array<number>(n);

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
  livePoints: LivePoint[]
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
  livePoints: LivePoint[]
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
 * @param runColors Stable per-run color assignment (from buildRunColorMap);
 *   falls back to palette-by-visible-index when omitted
 */
export function mergeRunsForChart(
  runs: ChartRun[],
  livePoints: LivePoint[],
  visibleRuns: Set<number> | null,
  visibleMetrics: Set<MetricKey>,
  isTestActive: boolean,
  activeRunId?: number | null,
  runColors?: Map<number, string>
): MergedChartData {
  // Filter to visible runs
  const allVisible = visibleRuns ? runs.filter(r => visibleRuns.has(r.id)) : runs;

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
  const bands: BandDef[] = [];
  // Temperature and IR live on their own chart (buildTempChartData) — exclude here
  const metricsArr = Array.from(visibleMetrics).filter(
    (m): m is 'voltage' | 'current' | 'power' | 'capacity' => m !== 'temperature' && m !== 'ir'
  );
  const desatAlpha = isTestActive ? 0.2 : 1.0;

  // Min/max range arrays for downsampled runs — only V and I (power/capacity don't need bands)
  const RANGE_KEYS: Record<string, { min: keyof ChartRun; max: keyof ChartRun }> = {
    voltage: { min: 'voltageMin', max: 'voltageMax' },
    current: { min: 'currentMin', max: 'currentMax' },
  };

  // Add series for each historical run
  for (let ri = 0; ri < historicalRuns.length; ri++) {
    const run = historicalRuns[ri];
    const baseColor = runColors?.get(run.id) ?? getRunColor(ri);

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
        baseColor: colorWithAlpha(baseColor, METRIC_ALPHA[metric]),
        isLive: false,
      });

      // TODO: re-enable band series once basic rendering is confirmed
      // For downsampled runs, bands would add min/max fill areas
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
        color: colorWithAlpha(LIVE_COLORS[metric], alpha),
        baseColor: colorWithAlpha(LIVE_COLORS[metric], alpha),
        isLive: true,
      });
    }
  }

  return { data, seriesInfo, bands: bands.length > 0 ? bands : undefined };
}

// ── Temperature series ─────────────────────────────────────────────

const TEMP_COLORS = [
  '#f44336', // red (battery)
  '#ff9800', // orange (charger)
  '#4fc3f7', // blue (ambient)
  '#66bb6a', // green (weather)
  '#ab47bc', // purple
  '#26c6da', // cyan
];

export interface TempDataPoint {
  channel_key: string;
  channel_name: string | null;
  elapsed_s: number;
  temp_c: number;
}

/**
 * Build the dataset for the standalone temperature chart.
 *
 * Each (run, channel) pair becomes its own series — every run has its own
 * elapsed-time axis, so merging a channel's points ACROSS runs into one
 * series (as the old in-chart merge did) drew lines connecting unrelated
 * runs and made the timebase look wrong. Channel identity is conveyed by
 * color; runs are distinguished per series (dimmed while a test is live,
 * matching the main chart's treatment of historical runs).
 */
export function buildTempChartData(
  runs: ChartRun[],
  visibleRuns: Set<number> | null,
  tempDataByRun: Map<number, TempDataPoint[]>,
  liveTempPoints: LiveTempPoint[],
  activeRunId: number | null | undefined,
  isTestActive: boolean,
  /** Per-run DC-IR samples — rendered on the right-hand mΩ scale of this chart */
  irSamplesByRun?: Map<number, IrSample[]>
): MergedChartData {
  // Collect per-(run, channel) point lists
  interface SeriesBucket {
    runId: number;
    runLabel: string;
    channelKey: string;
    channelName: string | null;
    isLive: boolean;
    points: { t: number; v: number }[];
  }
  const buckets = new Map<string, SeriesBucket>();
  const channelOrder = new Map<string, number>(); // channelKey → color index

  const channelIdx = (key: string): number => {
    let idx = channelOrder.get(key);
    if (idx === undefined) {
      idx = channelOrder.size;
      channelOrder.set(key, idx);
    }
    return idx;
  };

  for (const run of runs) {
    if (visibleRuns && !visibleRuns.has(run.id)) continue;
    const tempPoints = tempDataByRun.get(run.id);
    if (!tempPoints || tempPoints.length === 0) continue;

    for (const p of tempPoints) {
      channelIdx(p.channel_key);
      const key = `${run.id}|${p.channel_key}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          runId: run.id,
          runLabel: run.label,
          channelKey: p.channel_key,
          channelName: p.channel_name,
          isLive: isTestActive && run.id === activeRunId,
          points: [],
        };
        buckets.set(key, bucket);
      }
      bucket.points.push({ t: p.elapsed_s, v: p.temp_c });
    }
  }

  // Live accumulated points extend (or create) the active run's series
  if (isTestActive) {
    for (const p of liveTempPoints) {
      channelIdx(p.channelId);
      const key = `${activeRunId ?? -1}|${p.channelId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          runId: activeRunId ?? -1,
          runLabel: 'Live',
          channelKey: p.channelId,
          channelName: p.name,
          isLive: true,
          points: [],
        };
        buckets.set(key, bucket);
      }
      bucket.points.push({ t: p.t, v: p.v });
    }
  }

  // IR sample series — one per run with usable current steps. They share
  // this chart's x axis but render on the right-hand mΩ scale.
  interface IrBucket {
    runId: number;
    runLabel: string;
    isLive: boolean;
    points: { t: number; v: number }[];
  }
  const irBuckets: IrBucket[] = [];
  if (irSamplesByRun) {
    for (const run of runs) {
      if (visibleRuns && !visibleRuns.has(run.id)) continue;
      const samples = irSamplesByRun.get(run.id);
      if (!samples || samples.length === 0) continue;
      irBuckets.push({
        runId: run.id,
        runLabel: run.label,
        isLive: isTestActive && run.id === activeRunId,
        points: samples.map(s => ({ t: s.t, v: s.mohm })),
      });
    }
  }

  if (buckets.size === 0 && irBuckets.length === 0) {
    return { data: [[]], seriesInfo: [] };
  }

  // Union time axis
  const timeSet = new Set<number>();
  for (const b of buckets.values()) {
    for (const p of b.points) timeSet.add(p.t);
  }
  for (const b of irBuckets) {
    for (const p of b.points) timeSet.add(p.t);
  }
  const xValues = Array.from(timeSet).sort((a, b) => a - b);
  const timeIndex = new Map<number, number>();
  for (let i = 0; i < xValues.length; i++) timeIndex.set(xValues[i], i);

  // Do run labels matter? Only when a channel appears in more than one run.
  const runsPerChannel = new Map<string, Set<number>>();
  for (const b of buckets.values()) {
    let set = runsPerChannel.get(b.channelKey);
    if (!set) {
      set = new Set();
      runsPerChannel.set(b.channelKey, set);
    }
    set.add(b.runId);
  }

  const data: (number | null | undefined)[][] = [xValues];
  const seriesInfo: ChartSeriesInfo[] = [];

  for (const b of buckets.values()) {
    const values = new Array<number | null | undefined>(xValues.length).fill(undefined);
    for (const p of b.points) {
      const idx = timeIndex.get(p.t);
      if (idx !== undefined) values[idx] = p.v;
    }
    data.push(values);

    const channelLabel = b.channelName ?? b.channelKey.slice(-6);
    const multiRun = (runsPerChannel.get(b.channelKey)?.size ?? 1) > 1;
    const baseColor = TEMP_COLORS[(channelOrder.get(b.channelKey) ?? 0) % TEMP_COLORS.length];
    // Match the main chart's dimming of historical runs during a live test,
    // so a long-past run doesn't visually dominate the temperature panel
    const alpha = isTestActive && !b.isLive ? 0.15 : 0.9;

    seriesInfo.push({
      runId: b.runId,
      metric: 'temperature',
      label: multiRun ? `${channelLabel} · ${b.runLabel}` : channelLabel,
      color: colorWithAlpha(baseColor, alpha),
      baseColor: colorWithAlpha(baseColor, 0.9),
      isLive: b.isLive,
      channelId: b.channelKey,
    });
  }

  for (const b of irBuckets) {
    const values = new Array<number | null | undefined>(xValues.length).fill(undefined);
    for (const p of b.points) {
      const idx = timeIndex.get(p.t);
      if (idx !== undefined) values[idx] = p.v;
    }
    data.push(values);

    const alpha = isTestActive && !b.isLive ? 0.15 : 0.9;
    seriesInfo.push({
      runId: b.runId,
      metric: 'ir',
      label: irBuckets.length > 1 ? `IR · ${b.runLabel}` : 'IR',
      color: colorWithAlpha(IR_COLOR, alpha),
      baseColor: colorWithAlpha(IR_COLOR, 0.9),
      isLive: b.isLive,
    });
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
export function runToCapacityDomain(run: ChartRun, nominalCapacityMah: number): CapacityRun {
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
  const voltage: (number | null)[] = CAPACITY_GRID.map(gridPct => lerpAt(adjustedPct, run.voltage, gridPct));
  const current: (number | null)[] = CAPACITY_GRID.map(gridPct => lerpAt(adjustedPct, run.current, gridPct));

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
  visibleRuns: Set<number> | null
): CapacityChartData {
  const xValues = CAPACITY_GRID;

  const data: (number | null | undefined)[][] = [[...xValues]];
  const seriesInfo: CapacitySeriesInfo[] = [];

  // Add reference curves first (drawn behind data) — voltage only
  for (const ref of referenceCurves) {
    const isDischarge = ref.label.toLowerCase().includes('discharge');
    const colorKey = `${ref.style}-${isDischarge ? 'discharge' : 'charge'}`;

    const values: (number | null | undefined)[] = xValues.map(
      pct => lerpAt(ref.capacityPct, ref.voltage, pct) ?? undefined
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
  const activeRuns = visibleRuns ? runs.filter(r => visibleRuns.has(r.id)) : runs;

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
