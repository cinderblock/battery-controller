/**
 * uPlot wrapper component.
 *
 * Creates a uPlot instance, handles resizing, and efficiently updates
 * data without recreating the chart on every render.
 * Includes a crosshair cursor with tooltip showing all series values.
 */

import { useCallback, useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { BandDef, ChartSeriesInfo, MetricKey, ThresholdLine } from '../lib/chart-data.ts';
import { formatElapsedShort } from '../lib/chart-data.ts';
import { attachWheelZoom } from '../lib/uplot-wheel-zoom.ts';

const MAX_TOOLTIP_ROWS = 16;

/** How many nearby series the tooltip lists */
const MAX_NEARBY_SERIES = 5;

/** Cursor-to-line distance (CSS px) within which the nearest series gets focus */
const FOCUS_PROX_PX = 40;

/** Alpha applied to non-focused series while one is focused */
const FOCUS_ALPHA = 0.3;

/**
 * Value of series `ys` at x-index `idx`, linearly interpolating across null
 * gaps so the result matches what spanGaps draws. Returns null past the ends
 * of the series' data.
 */
function seriesValueAt(xs: number[], ys: (number | null | undefined)[] | undefined, idx: number): number | null {
  if (!ys) return null;
  const direct = ys[idx];
  if (direct != null) return direct;

  let lo = idx - 1;
  while (lo >= 0 && ys[lo] == null) lo--;
  if (lo < 0) return null;
  let hi = idx + 1;
  while (hi < ys.length && ys[hi] == null) hi++;
  if (hi >= ys.length) return null;

  const t = (xs[idx] - xs[lo]) / (xs[hi] - xs[lo]);
  return (ys[lo] as number) + t * ((ys[hi] as number) - (ys[lo] as number));
}

// ── Zoom sync ──────────────────────────────────────────────────────
// uPlot's cursor.sync shares only the crosshair; drag-zoom emits setScale,
// which we mirror to every other chart registered under the same key.

const zoomSyncGroups = new Map<string, Set<uPlot>>();
let zoomSyncInProgress = false;

function registerZoomSync(key: string, u: uPlot): () => void {
  let group = zoomSyncGroups.get(key);
  if (!group) {
    group = new Set();
    zoomSyncGroups.set(key, group);
  }
  group.add(u);
  return () => {
    group.delete(u);
    if (group.size === 0) zoomSyncGroups.delete(key);
  };
}

function propagateXZoom(key: string, source: uPlot): void {
  if (zoomSyncInProgress) return;
  const group = zoomSyncGroups.get(key);
  if (!group) return;
  const { min, max } = source.scales.x;
  if (min == null || max == null) return;
  zoomSyncInProgress = true;
  try {
    for (const peer of group) {
      if (peer !== source) peer.setScale('x', { min, max });
    }
  } finally {
    zoomSyncInProgress = false;
  }
}

// ── Live-point markers ─────────────────────────────────────────────
// A dot pinned to the newest point of each live series, pulsing when a
// fresh data point arrives. DOM overlays — no extra canvas redraws.

interface LiveMarker {
  el: HTMLDivElement;
  lastX: number | null;
}

function updateLiveMarkers(
  u: uPlot,
  container: HTMLDivElement,
  info: ChartSeriesInfo[],
  markers: Map<number, LiveMarker>
): void {
  const seen = new Set<number>();
  const offX = u.bbox.left / devicePixelRatio;
  const offY = u.bbox.top / devicePixelRatio;
  const { min: xMin, max: xMax } = u.scales.x;

  for (let si = 0; si < info.length; si++) {
    const s = info[si];
    if (!s.isLive || s.color === 'transparent') continue;
    const ys = u.data[si + 1];
    if (!ys) continue;

    let idx = ys.length - 1;
    while (idx >= 0 && ys[idx] == null) idx--;
    if (idx < 0) continue;

    const xVal = u.data[0][idx] as number;
    seen.add(si);

    let m = markers.get(si);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'live-point-marker';
      container.appendChild(el);
      m = { el, lastX: null };
      markers.set(si, m);
    }

    // Hide when the newest point is zoomed out of view
    if (xMin != null && xMax != null && (xVal < xMin || xVal > xMax)) {
      m.el.style.display = 'none';
      continue;
    }

    const left = u.valToPos(xVal, 'x');
    const top = u.valToPos(ys[idx] as number, METRIC_SCALE[s.metric]);
    m.el.style.display = '';
    m.el.style.setProperty('--marker-color', s.color);
    m.el.style.left = `${offX + left}px`;
    m.el.style.top = `${offY + top}px`;

    // New point → restart the pulse animation
    if (m.lastX !== xVal) {
      m.lastX = xVal;
      m.el.classList.remove('pulse');
      void m.el.offsetWidth; // force reflow so the animation restarts
      m.el.classList.add('pulse');
    }
  }

  for (const [si, m] of markers) {
    if (!seen.has(si)) {
      m.el.remove();
      markers.delete(si);
    }
  }
}

/** Per-chart focused-series tracking so we only call setSeries on change */
const focusedSeriesByChart = new WeakMap<uPlot, number>();

/** Focus series index `si` (0-based into seriesInfo), or -1 to clear focus */
function setFocusedSeries(u: uPlot, si: number): void {
  const prev = focusedSeriesByChart.get(u) ?? -1;
  if (prev === si) return;
  focusedSeriesByChart.set(u, si);
  if (si >= 0) u.setSeries(si + 1, { focus: true });
  else u.setSeries(null, { focus: true });
}

interface TooltipDOM {
  root: HTMLDivElement;
  header: HTMLDivElement;
  rows: { el: HTMLDivElement; swatch: HTMLSpanElement; label: HTMLSpanElement; value: HTMLSpanElement }[];
}

function createTooltipEl(): TooltipDOM {
  const root = document.createElement('div');
  root.className = 'cap-chart-tooltip';
  root.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'cap-tt-header';
  root.appendChild(header);

  const rows: TooltipDOM['rows'] = [];
  for (let i = 0; i < MAX_TOOLTIP_ROWS; i++) {
    const el = document.createElement('div');
    el.className = 'cap-tt-row';
    el.style.display = 'none';

    const swatch = document.createElement('span');
    swatch.className = 'cap-tt-swatch';
    el.appendChild(swatch);

    const label = document.createElement('span');
    label.className = 'cap-tt-label';
    el.appendChild(label);

    const value = document.createElement('span');
    value.className = 'cap-tt-val';
    el.appendChild(value);

    root.appendChild(el);
    rows.push({ el, swatch, label, value });
  }

  return { root, header, rows };
}

// ── Types ──────────────────────────────────────────────────────────

/** Fixed range for a Y scale — aligns 0% and 100% across multiple scales */
export interface ScaleRange {
  min: number;
  max: number;
}

export interface ChartProps {
  data: (number | null | undefined)[][];
  seriesInfo: ChartSeriesInfo[];
  thresholds?: ThresholdLine[];
  scaleRanges?: Partial<Record<string, ScaleRange>>;
  bands?: BandDef[];
  className?: string;
  /** Charts sharing a syncKey share crosshair position and x-axis zoom */
  syncKey?: string;
  /**
   * Shared full-view x-domain for stacked/synced charts. When set and the user
   * is not zoomed in, the chart expands its x range to this extent instead of
   * its own data extent — so a chart with a narrower series (e.g. temperatures
   * that only cover part of the timeline) stays aligned with its peers and
   * doesn't snap the synced view to its own smaller window on every packet.
   */
  xExtent?: [number, number];
  /**
   * Externally-driven series focus: when set, the run's trace is emphasized and
   * the rest dimmed (same visual as cursor-proximity focus). Used to
   * cross-highlight a chart trace from the timeline's step hover/select.
   */
  focusRunId?: number | null;
  /** Extra left/right padding (px) to align plot areas of stacked charts */
  padLeft?: number;
  padRight?: number;
}

// ── Scale config ───────────────────────────────────────────────────

const METRIC_SCALE: Record<MetricKey, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  capacity: 'Ah',
  temperature: '°C',
};

const METRIC_UNIT: Record<MetricKey, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  capacity: 'Ah',
  temperature: '°C',
};

// ── Component ──────────────────────────────────────────────────────

export function Chart({
  data,
  seriesInfo,
  thresholds = [],
  scaleRanges = {},
  bands: bandDefs = [],
  className,
  syncKey,
  xExtent,
  focusRunId = null,
  padLeft = 0,
  padRight = 0,
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<TooltipDOM | null>(null);
  const prevSeriesKeyRef = useRef<string>('');

  // Keep seriesInfo in a ref so the cursor hook reads it without causing rebuild
  const seriesInfoRef = useRef(seriesInfo);
  seriesInfoRef.current = seriesInfo;

  // Keep thresholds in a ref so the draw hook reads them without causing rebuild
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

  // Keep scaleRanges in a ref so buildOptions reads current value
  const scaleRangesRef = useRef(scaleRanges);
  scaleRangesRef.current = scaleRanges;

  // Keep band definitions in a ref
  const bandDefsRef = useRef(bandDefs);
  bandDefsRef.current = bandDefs;

  // Sync + padding props, read at build time via refs (buildOptions is memoized)
  const syncKeyRef = useRef(syncKey);
  syncKeyRef.current = syncKey;
  const padRef = useRef({ padLeft, padRight });
  padRef.current = { padLeft, padRight };

  // Live-point marker overlays, keyed by series index
  const liveMarkersRef = useRef<Map<number, LiveMarker>>(new Map());

  // True while the user has an x zoom narrower than the data extents.
  // setData() must not reset scales then, or live packets (every ~1s)
  // would snap the view back to full immediately after every zoom.
  const userZoomRef = useRef(false);

  // Shared full-view x-domain, read at scale time via a ref (buildOptions is
  // memoized and xExtent grows every packet — a ref avoids rebuilding).
  const xExtentRef = useRef(xExtent);
  xExtentRef.current = xExtent;

  // Set while an internal setData()/creation autoscale is running, so the
  // setScale hook can tell an autoscale apart from a genuine user gesture and
  // skip cross-chart propagation for the former. Otherwise two stacked charts
  // with different data extents fight over the synced x window every packet.
  const autoscalingRef = useRef(false);

  // Run whose trace is emphasized from the timeline. Read by the overlay draw
  // hook; changing it triggers a redraw (see effect below).
  const highlightRunIdRef = useRef<number | null>(focusRunId);

  const refreshLiveMarkers = useCallback((u: uPlot) => {
    const container = containerRef.current;
    if (!container) return;
    updateLiveMarkers(u, container, seriesInfoRef.current, liveMarkersRef.current);
  }, []);

  // Build a stable key from series info + scale ranges to detect when chart needs rebuild
  const rangesKey = Object.entries(scaleRanges)
    .filter((e): e is [string, ScaleRange] => e[1] != null)
    .map(([k, v]) => `${k}:${v.min}-${v.max}`)
    .join('|');
  const seriesKey =
    seriesInfo.map(s => `${s.runId}:${s.metric}:${s.isLive}`).join('|') +
    '||' +
    rangesKey +
    `||pad:${padLeft},${padRight}`;

  const buildOptions = useCallback((): uPlot.Options => {
    const seriesInfo = seriesInfoRef.current;
    const container = containerRef.current;
    const width = container?.clientWidth ?? 800;
    const height = container?.clientHeight ?? 400;

    // Determine which scales we need based on visible metrics
    const usedScales = new Set(seriesInfo.map(s => METRIC_SCALE[s.metric]));

    const axes: uPlot.Axis[] = [
      // X axis
      {
        space: 60,
        values: (_u: uPlot, vals: number[]) => vals.map(v => formatElapsedShort(v)),
        stroke: '#888',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
      },
    ];

    // Left Y axis: voltage (always present if voltage is shown)
    if (usedScales.has('V')) {
      axes.push({
        scale: 'V',
        side: 3, // left
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(2) + ' V'),
        stroke: '#4fc3f7',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 65,
      });
    }

    // Left Y axis: current (shares left side with voltage — both auto-range
    // so 0% and 100% of each scale are aligned)
    if (usedScales.has('A')) {
      axes.push({
        scale: 'A',
        side: 3, // left, alongside voltage
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(1) + ' A'),
        stroke: '#81c784',
        grid: { show: false },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 55,
      });
    }

    // Second right axis: power (if visible)
    if (usedScales.has('W')) {
      axes.push({
        scale: 'W',
        side: 1,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(0) + ' W'),
        stroke: '#ffb74d',
        grid: { show: false },
        ticks: { show: false },
        size: 50,
      });
    }

    // Capacity axis
    if (usedScales.has('Ah')) {
      axes.push({
        scale: 'Ah',
        side: 1,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(1) + ' Ah'),
        stroke: '#ba68c8',
        grid: { show: false },
        ticks: { show: false },
        size: 55,
      });
    }

    // Temperature axis — left side, and it's the only y-axis on the
    // standalone temperature chart, so it owns the horizontal grid
    if (usedScales.has('°C')) {
      axes.push({
        scale: '°C',
        side: 3,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(1) + '°C'),
        stroke: '#f44336',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 55,
      });
    }

    // Build series definitions
    const series: uPlot.Series[] = [
      { label: 'Time' }, // X series (required placeholder)
    ];

    for (const info of seriesInfo) {
      const isBandBound = info.color === 'transparent';
      series.push({
        label: isBandBound ? undefined : info.label,
        scale: METRIC_SCALE[info.metric],
        stroke: isBandBound ? 'transparent' : info.color,
        width: isBandBound ? 0 : info.isLive ? 2.5 : 1,
        spanGaps: true,
        points: { show: false },
      });
    }

    // Build uPlot bands from our BandDef array
    const uBands: uPlot.Band[] = bandDefsRef.current.map(b => ({
      series: [b.minIdx, b.maxIdx] as [number, number],
      fill: b.fill,
    }));

    const tooltip = tooltipRef.current;

    const sync = syncKeyRef.current;
    const { padLeft: extraLeft, padRight: extraRight } = padRef.current;

    return {
      width,
      height,
      // [top, right, bottom, left] — null = uPlot's auto padding; extra
      // left/right padding aligns plot areas of vertically stacked charts
      padding: [null, extraRight > 0 ? extraRight : null, null, extraLeft > 0 ? extraLeft : null],
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, fill: '#fff' },
        ...(sync ? { sync: { key: sync } } : {}),
      },
      focus: { alpha: FOCUS_ALPHA },
      scales: {
        x: {
          time: false,
          // Full (auto) view never narrower than 3 minutes — a just-started
          // live run otherwise plots seconds-wide and jumps on every packet.
          // Explicit user zooms (min/max inside the data extents) pass through.
          range: (u: uPlot, min: number, max: number) => {
            const xs = u.data?.[0];
            const dataMin = xs?.[0];
            const dataMax = xs?.[xs.length - 1];
            const isFullView = dataMin == null || dataMax == null || (min <= dataMin && max >= dataMax);
            // In full view, adopt the shared extent (if any) so stacked/synced
            // charts align to the same x-domain regardless of each one's own
            // series coverage. Union with the data extent so we never clip.
            if (isFullView) {
              const ext = xExtentRef.current;
              if (ext) {
                min = Math.min(min, ext[0]);
                max = Math.max(max, ext[1]);
              }
              if (max - min < 180) return [min, min + 180] as [number, number];
            }
            return [min, max] as [number, number];
          },
        },
        V: scaleRangesRef.current.V
          ? { auto: false, range: [scaleRangesRef.current.V.min, scaleRangesRef.current.V.max] as [number, number] }
          : { auto: true },
        A: scaleRangesRef.current.A
          ? { auto: false, range: [scaleRangesRef.current.A.min, scaleRangesRef.current.A.max] as [number, number] }
          : { auto: true },
        W: {
          auto: true,
          range: (_u: uPlot, min: number, max: number) => [Math.max(0, min - 5), max + 5] as [number, number],
        },
        Ah: { auto: true, range: (_u: uPlot, min: number, max: number) => [0, max * 1.05] as [number, number] },
        '°C': { auto: true },
      },
      axes,
      series,
      bands: uBands,
      legend: { show: false }, // We build our own legend panel
      hooks: {
        setScale: [
          (u: uPlot, scaleKey: string) => {
            if (scaleKey !== 'x') return;
            // Track whether the user is zoomed in (x window narrower than the
            // data) — data updates must not reset the view while zoomed
            const xs = u.data?.[0];
            if (xs && xs.length > 1) {
              const dataMin = xs[0];
              const dataMax = xs[xs.length - 1];
              const { min, max } = u.scales.x;
              userZoomRef.current = min != null && max != null && (min > dataMin || max < dataMax);
            }
            // Only genuine user gestures (drag/wheel/dblclick) sync across
            // charts. An internal setData/creation autoscale must NOT push this
            // chart's own extent onto its peers — that's the snap-back bug.
            if (sync && !autoscalingRef.current) propagateXZoom(sync, u);
          },
        ],
        draw: [
          (u: uPlot) => refreshLiveMarkers(u),
          (u: uPlot) => {
            const lines = thresholdsRef.current;
            if (lines.length === 0) return;

            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;

            for (const t of lines) {
              const yPos = u.valToPos(t.value, t.scale, true);
              if (yPos < top || yPos > top + height) continue;

              ctx.save();
              ctx.strokeStyle = t.color;
              ctx.lineWidth = 1 * devicePixelRatio;
              ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
              ctx.beginPath();
              ctx.moveTo(left, yPos);
              ctx.lineTo(left + width, yPos);
              ctx.stroke();

              // Label
              ctx.fillStyle = t.color;
              ctx.font = `${10 * devicePixelRatio}px sans-serif`;
              ctx.textAlign = 'right';
              ctx.fillText(t.label, left + width - 4 * devicePixelRatio, yPos - 4 * devicePixelRatio);
              ctx.restore();
            }
          },
          // Highlight overlay: redraw the emphasized run's traces at full
          // brightness on top of everything else (see highlightRunIdRef).
          (u: uPlot) => {
            const hr = highlightRunIdRef.current;
            if (hr == null) return;
            const info = seriesInfoRef.current;
            const xs = u.data[0] as number[] | undefined;
            if (!xs || xs.length === 0) return;

            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;

            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            ctx.lineJoin = 'round';

            for (let si = 0; si < info.length; si++) {
              const s = info[si];
              if (s.runId !== hr || !s.label || s.color === 'transparent') continue;
              const ys = u.data[si + 1] as (number | null | undefined)[] | undefined;
              if (!ys) continue;
              const scale = METRIC_SCALE[s.metric];

              ctx.beginPath();
              ctx.strokeStyle = s.baseColor ?? s.color;
              ctx.lineWidth = 3 * devicePixelRatio;
              let started = false;
              for (let i = 0; i < xs.length; i++) {
                const y = ys[i];
                if (y == null) continue; // spanGaps: skip nulls, keep the line going
                const px = u.valToPos(xs[i], 'x', true);
                const py = u.valToPos(y, scale, true);
                if (started) ctx.lineTo(px, py);
                else {
                  ctx.moveTo(px, py);
                  started = true;
                }
              }
              if (started) ctx.stroke();
            }
            ctx.restore();
          },
        ],
        setCursor: [
          (u: uPlot) => {
            if (!tooltip) return;
            const { idx } = u.cursor;

            const hide = () => {
              tooltip.root.style.display = 'none';
              setFocusedSeries(u, -1);
            };

            if (idx == null || idx < 0) {
              hide();
              return;
            }

            const info = seriesInfoRef.current;
            const xs = u.data[0];
            const xVal = xs[idx];
            if (xVal == null) {
              hide();
              return;
            }

            tooltip.header.textContent = formatElapsedShort(xVal as number);

            // Distance from the cursor to each series, in CSS pixels.
            // Values are interpolated across gaps (the merged time axis makes
            // most series sparse, but spanGaps draws them continuously).
            const cursorY = u.cursor.top ?? 0;
            const nearest: Array<{ si: number; distance: number; val: number }> = [];

            for (let si = 0; si < info.length; si++) {
              const s = info[si];
              if (!s.label || s.color === 'transparent') continue; // skip band bounds
              const val = seriesValueAt(
                xs as number[],
                u.data[si + 1] as (number | null | undefined)[] | undefined,
                idx
              );
              if (val == null) continue;

              const seriesY = u.valToPos(val, METRIC_SCALE[s.metric]);
              nearest.push({ si, distance: Math.abs(cursorY - seriesY), val });
            }

            // Show only the closest series, nearest first
            nearest.sort((a, b) => a.distance - b.distance);
            const closest = nearest.slice(0, MAX_NEARBY_SERIES);

            // Highlight the nearest series on the chart when the cursor is
            // actually close to it; otherwise show everything normally
            const focusSi = closest.length > 0 && closest[0].distance <= FOCUS_PROX_PX ? closest[0].si : -1;
            setFocusedSeries(u, focusSi);

            let rowIdx = 0;
            for (const { si, val } of closest) {
              if (rowIdx >= tooltip.rows.length) break;
              const s = info[si];
              const unit = METRIC_UNIT[s.metric];
              const decimals = s.metric === 'voltage' ? 3 : s.metric === 'current' ? 2 : 1;
              const row = tooltip.rows[rowIdx];
              row.swatch.style.background = s.color;
              row.label.textContent = s.label;
              row.value.textContent = `${val.toFixed(decimals)} ${unit}`;
              row.el.style.display = '';
              row.el.classList.toggle('cap-tt-nearest', si === focusSi);
              rowIdx++;
            }

            if (rowIdx === 0) {
              hide();
              return;
            }

            for (let i = rowIdx; i < tooltip.rows.length; i++) {
              tooltip.rows[i].el.style.display = 'none';
            }

            // Position tooltip, flipping to left side when cursor is past 60%
            const cx = u.cursor.left ?? 0;
            const cy = u.cursor.top ?? 0;
            const plotLeft = u.bbox.left / devicePixelRatio;
            const plotTopDpr = u.bbox.top / devicePixelRatio;
            const plotWidth = u.bbox.width / devicePixelRatio;
            const showLeft = cx > plotWidth * 0.6;

            tooltip.root.style.display = 'block';
            tooltip.root.style.left = `${plotLeft + cx + (showLeft ? -12 : 12)}px`;
            tooltip.root.style.top = `${plotTopDpr + cy - 10}px`;
            tooltip.root.style.transform = showLeft ? 'translateX(-100%)' : '';
          },
        ],
      },
    };
  }, []); // reads seriesInfoRef.current, no deps needed

  // Create tooltip element on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const tt = createTooltipEl();
    container.appendChild(tt.root);
    tooltipRef.current = tt;
    return () => {
      tt.root.remove();
      tooltipRef.current = null;
    };
  }, []);

  // Create or recreate chart when series structure changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only recreate if series structure changed
    if (seriesKey === prevSeriesKeyRef.current && uplotRef.current) {
      return;
    }
    prevSeriesKeyRef.current = seriesKey;

    // Destroy old chart
    uplotRef.current?.destroy();

    if (data.length === 0 || data[0].length === 0) {
      uplotRef.current = null;
      return;
    }

    const opts = buildOptions();
    autoscalingRef.current = true;
    const u = new uPlot(opts, data as uPlot.AlignedData, container);
    autoscalingRef.current = false;
    uplotRef.current = u;
    attachWheelZoom(u, 10); // never narrower than 10 s
    const unregisterZoomSync = syncKeyRef.current ? registerZoomSync(syncKeyRef.current, u) : null;

    return () => {
      unregisterZoomSync?.();
      u.destroy();
      uplotRef.current = null;
      prevSeriesKeyRef.current = '';
      for (const m of liveMarkersRef.current.values()) m.el.remove();
      liveMarkersRef.current.clear();
    };
  }, [seriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update data when it changes (without recreating chart). While the user
  // is zoomed in, keep their x window instead of re-running auto-range;
  // double-click (uPlot's built-in reset) returns to the growing full view.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    if (data.length === 0) return;

    // A reset autoscales x; flag it so the setScale hook doesn't propagate this
    // chart's own extent onto synced peers (see autoscalingRef).
    autoscalingRef.current = true;
    u.setData(data as uPlot.AlignedData, !userZoomRef.current);
    autoscalingRef.current = false;
    refreshLiveMarkers(u);
  }, [data, refreshLiveMarkers]);

  // Externally-driven highlight (timeline step hover/select): the overlay draw
  // hook redraws the matching run's traces at full brightness on top of the
  // (possibly dimmed) chart. A single-series uPlot focus can't do this — it
  // can't brighten an alpha-dimmed historic trace, and only emphasizes one
  // series, not all of a run's metrics. Just trigger a redraw here.
  useEffect(() => {
    highlightRunIdRef.current = focusRunId;
    uplotRef.current?.redraw();
  }, [focusRunId]);

  // Handle container resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(entries => {
      const u = uplotRef.current;
      if (!u) return;
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          u.setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className={`chart-container cap-chart ${className ?? ''}`} />;
}
