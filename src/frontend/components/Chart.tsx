/**
 * uPlot wrapper component.
 *
 * Creates a uPlot instance, handles resizing, and efficiently updates
 * data without recreating the chart on every render.
 * Includes a crosshair cursor with tooltip showing all series values.
 */

import { useEffect, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import type { ChartSeriesInfo, MetricKey, ThresholdLine } from '../lib/chart-data.ts';
import { formatElapsedShort } from '../lib/chart-data.ts';

function createTooltipEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'cap-chart-tooltip'; // reuse capacity chart tooltip styling
  el.style.display = 'none';
  return el;
}

// ── Types ──────────────────────────────────────────────────────────

export interface ChartProps {
  data: (number | null | undefined)[][];
  seriesInfo: ChartSeriesInfo[];
  thresholds?: ThresholdLine[];
  className?: string;
}

// ── Scale config ───────────────────────────────────────────────────

const METRIC_SCALE: Record<MetricKey, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  capacity: 'Ah',
};

const METRIC_UNIT: Record<MetricKey, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  capacity: 'Ah',
};

// ── Component ──────────────────────────────────────────────────────

export function Chart({ data, seriesInfo, thresholds = [], className }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const prevSeriesKeyRef = useRef<string>('');

  // Keep seriesInfo in a ref so the cursor hook reads it without causing rebuild
  const seriesInfoRef = useRef(seriesInfo);
  seriesInfoRef.current = seriesInfo;

  // Keep thresholds in a ref so the draw hook reads them without causing rebuild
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

  // Build a stable key from series info to detect when series structure changes
  const seriesKey = seriesInfo.map(s => `${s.runId}:${s.metric}:${s.isLive}`).join('|');

  const buildOptions = useCallback((): uPlot.Options => {
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

    // Right Y axis: current
    if (usedScales.has('A')) {
      axes.push({
        scale: 'A',
        side: 1, // right
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

    // Build series definitions
    const series: uPlot.Series[] = [
      { label: 'Time' }, // X series (required placeholder)
    ];

    for (const info of seriesInfo) {
      series.push({
        label: info.label,
        scale: METRIC_SCALE[info.metric],
        stroke: info.color,
        width: info.isLive ? 2.5 : 1,
        spanGaps: false,
        points: { show: false },
      });
    }

    const tooltip = tooltipRef.current;

    return {
      width,
      height,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, fill: '#fff' },
      },
      scales: {
        x: { time: false },
        V: { auto: true },
        A: { auto: true, range: (_u: uPlot, min: number, max: number) => [Math.max(0, min - 1), max + 1] },
        W: { auto: true, range: (_u: uPlot, min: number, max: number) => [Math.max(0, min - 5), max + 5] },
        Ah: { auto: true, range: (_u: uPlot, min: number, max: number) => [0, max * 1.05] },
      },
      axes,
      series,
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

            if (idx == null || idx < 0) {
              tooltip.style.display = 'none';
              return;
            }

            const info = seriesInfoRef.current;
            const xVal = u.data[0][idx];
            if (xVal == null) {
              tooltip.style.display = 'none';
              return;
            }

            const entries: { label: string; value: string; color: string }[] = [];
            for (let si = 0; si < info.length; si++) {
              const s = info[si];
              const val = u.data[si + 1]?.[idx];
              if (val == null) continue;

              const unit = METRIC_UNIT[s.metric];
              const decimals = s.metric === 'voltage' ? 3 : s.metric === 'current' ? 2 : 1;
              entries.push({
                label: s.label,
                value: `${(val as number).toFixed(decimals)} ${unit}`,
                color: s.color,
              });
            }

            if (entries.length === 0) {
              tooltip.style.display = 'none';
              return;
            }

            const cx = u.cursor.left ?? 0;
            const cy = u.cursor.top ?? 0;
            const plotLeft = u.bbox.left / devicePixelRatio;
            const plotTop = u.bbox.top / devicePixelRatio;

            tooltip.style.display = 'block';
            tooltip.style.left = `${plotLeft + cx + 12}px`;
            tooltip.style.top = `${plotTop + cy - 10}px`;

            let html = `<div class="cap-tt-header">${formatElapsedShort(xVal as number)}</div>`;
            for (const e of entries) {
              html += `<div class="cap-tt-row"><span class="cap-tt-swatch" style="background:${e.color}"></span><span class="cap-tt-label">${e.label}</span><span class="cap-tt-val">${e.value}</span></div>`;
            }
            tooltip.innerHTML = html;

            // Keep tooltip within container bounds
            const container = u.root.parentElement;
            if (container) {
              const containerRect = container.getBoundingClientRect();
              const tooltipRect = tooltip.getBoundingClientRect();
              if (tooltipRect.right > containerRect.right - 4) {
                tooltip.style.left = `${plotLeft + cx - tooltipRect.width - 12}px`;
              }
              if (tooltipRect.bottom > containerRect.bottom - 4) {
                tooltip.style.top = `${plotTop + cy - tooltipRect.height + 10}px`;
              }
            }
          },
        ],
      },
    };
  }, [seriesInfo]);

  // Create tooltip element on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const tt = createTooltipEl();
    container.appendChild(tt);
    tooltipRef.current = tt;
    return () => {
      tt.remove();
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
  }, [seriesKey, buildOptions]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div
      ref={containerRef}
      className={`chart-container cap-chart ${className ?? ''}`}
    />
  );
}
