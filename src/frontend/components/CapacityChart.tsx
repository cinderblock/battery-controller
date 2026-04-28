/**
 * Voltage vs Capacity chart — shows battery V-Ah curves with current overlay.
 *
 * Uses uPlot (canvas-based) for performance with large datasets.
 * Renders reference curves (datasheet + computed) as dashed lines
 * behind the measured run data. Includes a custom hover tooltip.
 */

import { useEffect, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import type { CapacitySeriesInfo, ThresholdLine } from '../lib/chart-data.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface CapacityChartProps {
  data: (number | null | undefined)[][];
  seriesInfo: CapacitySeriesInfo[];
  thresholds?: ThresholdLine[];
  className?: string;
}

// ── Dash patterns for reference curves ────────────────────────────

const DASH_PATTERNS: Record<string, number[]> = {
  datasheet: [8, 4],
  computed: [4, 3],
};

// ── Tooltip helpers ───────────────────────────────────────────────

function createTooltipEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'cap-chart-tooltip';
  el.style.display = 'none';
  return el;
}

// ── Component ──────────────────────────────────────────────────────

export function CapacityChart({ data, seriesInfo, thresholds = [], className }: CapacityChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const prevSeriesKeyRef = useRef<string>('');

  // Keep thresholds in a ref so the draw hook reads them without causing rebuild
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

  const seriesKey = seriesInfo.map(s => `${s.runId}:${s.metric}:${s.direction}:${s.isReference}`).join('|');

  // Keep seriesInfo in a ref so the cursor hook can read it without causing rebuild
  const seriesInfoRef = useRef(seriesInfo);
  seriesInfoRef.current = seriesInfo;

  const buildOptions = useCallback((): uPlot.Options => {
    const seriesInfo = seriesInfoRef.current;
    const container = containerRef.current;
    const width = container?.clientWidth ?? 800;
    const height = container?.clientHeight ?? 400;

    const hasCurrentSeries = seriesInfo.some(s => s.metric === 'current');

    const series: uPlot.Series[] = [
      { label: 'Capacity %' }, // X series placeholder
    ];

    for (const info of seriesInfo) {
      const dash = info.isReference && info.refStyle
        ? DASH_PATTERNS[info.refStyle]
        : undefined;

      const scale = info.metric === 'current' ? 'A' : 'V';

      series.push({
        label: info.label,
        scale,
        stroke: info.color,
        width: info.isReference ? 1.5 : 2,
        dash,
        spanGaps: false,
        points: { show: false },
      });
    }

    const axes: uPlot.Axis[] = [
      // X axis — capacity %
      {
        space: 60,
        values: (_u: uPlot, vals: number[]) => vals.map(v => `${v.toFixed(0)}%`),
        stroke: '#888',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
      },
      // Left Y axis — voltage
      {
        scale: 'V',
        side: 3,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(2) + ' V'),
        stroke: '#4fc3f7',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 65,
      },
    ];

    // Right Y axis — current (only if we have current series)
    if (hasCurrentSeries) {
      axes.push({
        scale: 'A',
        side: 1,
        values: (_u: uPlot, vals: number[]) => vals.map(v => v.toFixed(1) + ' A'),
        stroke: '#81c784',
        grid: { show: false },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        size: 55,
      });
    }

    // Tooltip element ref for cursor hook
    const tooltip = tooltipRef.current;

    return {
      width,
      height,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, fill: '#fff' },
      },
      scales: {
        x: {
          time: false,
          range: (_u: uPlot, min: number, max: number) => [
            Math.max(0, min),
            Math.min(100, max),
          ],
        },
        V: {
          auto: true,
          range: (_u: uPlot, min: number, max: number) => [
            Math.max(2.0, min - 0.05),
            Math.min(4.0, max + 0.05),
          ],
        },
        A: {
          auto: true,
          range: (_u: uPlot, min: number, max: number) => [
            Math.max(0, min - 1),
            max + 1,
          ],
        },
      },
      axes,
      series,
      legend: { show: false },
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

            // Collect values for all series at this index (measured first, then reference)
            const entries: { label: string; value: string; color: string; isRef: boolean }[] = [];
            for (let si = 0; si < info.length; si++) {
              const s = info[si];
              const val = u.data[si + 1]?.[idx]; // +1 because data[0] is X
              if (val == null) continue;

              const unit = s.metric === 'current' ? 'A' : 'V';
              const decimals = s.metric === 'current' ? 1 : 3;
              entries.push({
                label: s.label,
                value: `${(val as number).toFixed(decimals)} ${unit}`,
                color: s.color,
                isRef: s.isReference,
              });
            }

            if (entries.length === 0) {
              tooltip.style.display = 'none';
              return;
            }

            // Position tooltip near cursor
            const cx = u.cursor.left ?? 0;
            const cy = u.cursor.top ?? 0;
            const plotLeft = u.bbox.left / devicePixelRatio;
            const plotTop = u.bbox.top / devicePixelRatio;

            tooltip.style.display = 'block';
            tooltip.style.left = `${plotLeft + cx + 12}px`;
            tooltip.style.top = `${plotTop + cy - 10}px`;

            // Build tooltip HTML — measured runs first, then reference curves
            const measured = entries.filter(e => !e.isRef);
            const refs = entries.filter(e => e.isRef);
            let html = `<div class="cap-tt-header">${(xVal as number).toFixed(1)}%</div>`;
            for (const e of measured) {
              html += `<div class="cap-tt-row"><span class="cap-tt-swatch" style="background:${e.color}"></span><span class="cap-tt-label">${e.label}</span><span class="cap-tt-val">${e.value}</span></div>`;
            }
            if (refs.length > 0) {
              for (const e of refs) {
                html += `<div class="cap-tt-row" style="opacity:0.6"><span class="cap-tt-swatch" style="background:${e.color}"></span><span class="cap-tt-label">${e.label}</span><span class="cap-tt-val">${e.value}</span></div>`;
              }
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
  }, []); // reads seriesInfoRef.current, no deps needed

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

    if (seriesKey === prevSeriesKeyRef.current && uplotRef.current) {
      return;
    }
    prevSeriesKeyRef.current = seriesKey;

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

  // Update data without recreating chart
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
