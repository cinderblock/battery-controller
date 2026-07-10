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

  // Build a stable key from series info + scale ranges to detect when chart needs rebuild
  const rangesKey = Object.entries(scaleRanges)
    .filter((e): e is [string, ScaleRange] => e[1] != null)
    .map(([k, v]) => `${k}:${v.min}-${v.max}`)
    .join('|');
  const seriesKey = seriesInfo.map(s => `${s.runId}:${s.metric}:${s.isLive}`).join('|') + '||' + rangesKey;

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

    // Temperature axis (right side)
    if (usedScales.has('°C')) {
      axes.push({
        scale: '°C',
        side: 1,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(1) + '°C'),
        stroke: '#f44336',
        grid: { show: false },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 50,
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

    return {
      width,
      height,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, fill: '#fff' },
      },
      focus: { alpha: FOCUS_ALPHA },
      scales: {
        x: { time: false },
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
        draw: [
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
    const u = new uPlot(opts, data as uPlot.AlignedData, container);
    uplotRef.current = u;

    return () => {
      u.destroy();
      uplotRef.current = null;
      prevSeriesKeyRef.current = '';
    };
  }, [seriesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update data when it changes (without recreating chart)
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    if (data.length === 0) return;

    u.setData(data as uPlot.AlignedData);
  }, [data]);

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
