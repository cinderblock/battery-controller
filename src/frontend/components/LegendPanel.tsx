/**
 * LegendPanel — slide-in panel from the left edge.
 *
 * Controls:
 * - Fleet health summary (when a group summary is loaded)
 * - Series metric toggles (voltage, current, power, capacity)
 * - Per-run visibility with color swatches, capacity stats, and trend
 */

import type { CellCapacityStats, GroupFleetSummary } from '../api-client.ts';
import type { ChartRun, MetricKey } from '../lib/chart-data.ts';
import { formatElapsed, getRunColor } from '../lib/chart-data.ts';

// ── Types ──────────────────────────────────────────────────────────

interface LegendPanelProps {
  open: boolean;
  onClose: () => void;
  runs: ChartRun[];
  /** Stable run → color map shared with the chart (buildRunColorMap) */
  runColors?: Map<number, string>;
  visibleMetrics: Set<MetricKey>;
  visibleRuns: Set<number>;
  onToggleMetric: (metric: MetricKey) => void;
  onToggleRun: (runId: number) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  fleetSummary: GroupFleetSummary | null;
}

const ALL_METRICS: { key: MetricKey; label: string; color: string }[] = [
  { key: 'voltage', label: 'Voltage', color: '#4fc3f7' },
  { key: 'current', label: 'Current', color: '#81c784' },
  { key: 'power', label: 'Power', color: '#ffb74d' },
  { key: 'capacity', label: 'Capacity', color: '#ba68c8' },
  { key: 'temperature', label: 'Temperature', color: '#f44336' },
];

// ── Helpers ────────────────────────────────────────────────────────

function healthColor(pct: number): string {
  if (pct >= 90) return '#4caf50';
  if (pct >= 75) return '#ff9800';
  return '#f44336';
}

function trendArrow(trend: number | null): string {
  if (trend === null) return '';
  if (trend > 0.1) return '\u2197'; // ↗ improving
  if (trend < -0.1) return '\u2198'; // ↘ degrading
  return '\u2192'; // → stable
}

// ── Fleet summary subcomponent ─────────────────────────────────────

function FleetSummarySection({ summary }: { summary: GroupFleetSummary }) {
  return (
    <div className="legend-section fleet-summary">
      <h4>Fleet Health</h4>
      <div className="fleet-grid">
        <div className="fleet-stat">
          <span className="fleet-stat-label">Cells tested</span>
          <span className="fleet-stat-value">
            {summary.cellsTested} / {summary.cellsTotal}
          </span>
        </div>
        {summary.avgHealthPct !== null && (
          <div className="fleet-stat">
            <span className="fleet-stat-label">Avg health</span>
            <span className="fleet-stat-value" style={{ color: healthColor(summary.avgHealthPct) }}>
              {summary.avgHealthPct.toFixed(1)}%
            </span>
          </div>
        )}
        {summary.avgLatestAh !== null && (
          <div className="fleet-stat">
            <span className="fleet-stat-label">Avg capacity</span>
            <span className="fleet-stat-value">{summary.avgLatestAh.toFixed(1)} Ah</span>
          </div>
        )}
        {summary.minLatestAh !== null && summary.maxLatestAh !== null && (
          <div className="fleet-stat">
            <span className="fleet-stat-label">Range</span>
            <span className="fleet-stat-value">
              {summary.minLatestAh.toFixed(1)} – {summary.maxLatestAh.toFixed(1)} Ah
            </span>
          </div>
        )}
        {summary.weakestCell && (
          <div className="fleet-stat fleet-stat-full">
            <span className="fleet-stat-label">Weakest</span>
            <span className="fleet-stat-value fleet-stat-weak">
              {summary.weakestCell.barcode} — {summary.weakestCell.capacityAh.toFixed(1)} Ah
            </span>
          </div>
        )}
      </div>

      {/* Per-cell breakdown */}
      {summary.cells.length > 0 && (
        <div className="fleet-cells">
          <h4>Per-Cell Capacity</h4>
          {summary.cells.map(cell => (
            <CellStatRow key={cell.cellId} cell={cell} nominalAh={summary.nominalAh} />
          ))}
        </div>
      )}
    </div>
  );
}

function CellStatRow({ cell, nominalAh }: { cell: CellCapacityStats; nominalAh: number }) {
  const name = cell.label || cell.barcode;
  const trend = trendArrow(cell.trendAhPerCycle);

  return (
    <div className="fleet-cell-row">
      <span className="fleet-cell-name" title={cell.barcode}>
        {name}
      </span>
      <div className="fleet-cell-stats">
        {cell.latestAh !== null ? (
          <>
            <span className="fleet-cell-capacity">{cell.latestAh.toFixed(1)} Ah</span>
            {cell.healthPct !== null && (
              <span className="fleet-cell-health" style={{ color: healthColor(cell.healthPct) }}>
                {cell.healthPct.toFixed(0)}%
              </span>
            )}
            {trend && (
              <span
                className="fleet-cell-trend"
                title={
                  cell.trendAhPerCycle !== null
                    ? `${cell.trendAhPerCycle > 0 ? '+' : ''}${cell.trendAhPerCycle.toFixed(3)} Ah/cycle`
                    : ''
                }
              >
                {trend}
              </span>
            )}
            <span className="fleet-cell-runs">{cell.runCount} runs</span>
          </>
        ) : (
          <span className="fleet-cell-none">no data</span>
        )}
      </div>
      {/* Mini capacity bar */}
      {cell.latestAh !== null && nominalAh > 0 && (
        <div className="fleet-cell-bar">
          <div
            className="fleet-cell-bar-fill"
            style={{
              width: `${Math.min(100, (cell.latestAh / nominalAh) * 100)}%`,
              backgroundColor: healthColor(cell.healthPct ?? 0),
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export function LegendPanel({
  open,
  onClose,
  runs,
  runColors,
  visibleMetrics,
  visibleRuns,
  onToggleMetric,
  onToggleRun,
  onShowAll,
  onHideAll,
  fleetSummary,
}: LegendPanelProps) {
  return (
    <div className={`legend-panel ${open ? 'legend-open' : ''}`}>
      <div className="legend-header">
        <h3>Legend</h3>
        <button className="legend-close" onClick={onClose} aria-label="Close legend">
          &times;
        </button>
      </div>

      {/* Fleet summary */}
      {fleetSummary && fleetSummary.cellsTested > 0 && <FleetSummarySection summary={fleetSummary} />}

      {/* Metric toggles */}
      <div className="legend-section">
        <h4>Series</h4>
        <div className="metric-toggles">
          {ALL_METRICS.map(m => (
            <label key={m.key} className="metric-toggle">
              <input type="checkbox" checked={visibleMetrics.has(m.key)} onChange={() => onToggleMetric(m.key)} />
              <span className="metric-swatch" style={{ backgroundColor: m.color }} />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      {/* Run toggles */}
      <div className="legend-section">
        <div className="legend-section-header">
          <h4>Runs ({runs.length})</h4>
          <div className="legend-bulk-actions">
            <button onClick={onShowAll}>All</button>
            <button onClick={onHideAll}>None</button>
          </div>
        </div>
        <div className="run-list">
          {runs.map((run, index) => {
            const color = runColors?.get(run.id) ?? getRunColor(index);
            const visible = visibleRuns.has(run.id);
            const date = new Date(run.meta.started_at).toLocaleDateString();
            const capacityStr =
              run.meta.final_capacity_mah != null ? `${(run.meta.final_capacity_mah / 1000).toFixed(1)} Ah` : '\u2014';
            const durationStr = run.meta.duration_s != null ? formatElapsed(run.meta.duration_s) : '\u2014';

            return (
              <label key={run.id} className={`run-toggle ${visible ? '' : 'run-hidden'}`}>
                <input type="checkbox" checked={visible} onChange={() => onToggleRun(run.id)} />
                <span className="run-swatch" style={{ backgroundColor: color }} />
                <div className="run-info">
                  <span className="run-label">{run.label}</span>
                  <span className="run-details">
                    {date} · {run.meta.mode.toUpperCase()} · {capacityStr} · {durationStr}
                  </span>
                </div>
              </label>
            );
          })}
          {runs.length === 0 && <div className="run-empty">No completed runs yet</div>}
        </div>
      </div>
    </div>
  );
}
