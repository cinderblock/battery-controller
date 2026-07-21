/**
 * HealthView — dedicated battery-health screen (route /health).
 *
 * Ranks every tested cell by capacity / health / internal resistance so the
 * best cells and the junk are obvious at a glance, lets you multi-select cells
 * to gauge how well-matched they'd be as a pack (and auto-pick the tightest
 * group), overlay their discharge curves, drill into per-cell degradation, and
 * soft-retire the cells that aren't worth keeping.
 *
 * Data is REST-only (`/api/capacity/all` + `/api/cells` + per-run data); it
 * does not need the live device session.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Cell, type CellCapacityStats, type RunCapacitySummary, type TestRun } from '../api-client.ts';
import { CapacityChart } from '../components/CapacityChart.tsx';
import {
  type CapacityRun,
  type CapacitySeriesInfo,
  compactDataToChartRun,
  getRunColor,
  runToCapacityDomain,
} from '../lib/chart-data.ts';
import { formatAh, formatIr, formatPct, healthColor, trendArrow } from '../lib/health-format.ts';

// ── Sorting ────────────────────────────────────────────────────────

type SortKey = 'capacity' | 'health' | 'ir' | 'trend' | 'date' | 'name';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'capacity', label: 'Capacity' },
  { key: 'health', label: 'Health' },
  { key: 'ir', label: 'Resistance' },
  { key: 'trend', label: 'Trend' },
  { key: 'date', label: 'Date' },
  { key: 'name', label: 'Name' },
];

function cellName(c: CellCapacityStats): string {
  return c.label || c.barcode;
}

/** Value used for sorting; nulls sort last regardless of direction. */
function sortValue(c: CellCapacityStats, key: SortKey): number | string | null {
  switch (key) {
    case 'capacity':
      return c.latestAh;
    case 'health':
      return c.healthPct;
    case 'ir':
      return c.latestIrMohm;
    case 'trend':
      return c.trendAhPerCycle;
    case 'date':
      // Most-recent tested date (runs are date-ascending); null sorts last.
      return c.runs.length ? new Date(c.runs[c.runs.length - 1].date).getTime() : null;
    case 'name':
      return cellName(c).toLowerCase();
  }
}

function compareCells(a: CellCapacityStats, b: CellCapacityStats, key: SortKey, dir: 1 | -1): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  // Nulls always last
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv)) * dir;
  }
  return (av - bv) * dir;
}

// ── Capacity-by-rate buckets ───────────────────────────────────────

/** Round a discharge current to the nearest 5 A for grouping (e.g. 22.85 → 20/25). */
function rateBucket(currentA: number): number {
  return Math.round(currentA / 5) * 5;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface RateCapacity {
  rateA: number;
  ah: number;
  runs: number;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * First→last tested date range from a run list (runs are date-ascending).
 * Collapses to a single date when all runs land on the same day.
 */
function testedRange(runs: RunCapacitySummary[]): string | null {
  if (runs.length === 0) return null;
  const first = shortDate(runs[0].date);
  const last = shortDate(runs[runs.length - 1].date);
  return first === last ? first : `${first} – ${last}`;
}

/** Median capacity at each ~rate, highest rate first. */
function capacityByRate(runs: RunCapacitySummary[]): RateCapacity[] {
  const byRate = new Map<number, number[]>();
  for (const r of runs) {
    if (r.currentA <= 0 || r.capacityAh <= 0) continue;
    const bucket = rateBucket(r.currentA);
    const list = byRate.get(bucket) ?? [];
    list.push(r.capacityAh);
    byRate.set(bucket, list);
  }
  return [...byRate.entries()]
    .map(([rateA, caps]) => ({ rateA, ah: median(caps), runs: caps.length }))
    .sort((a, b) => b.rateA - a.rateA);
}

// ── Selection / pack-match math ────────────────────────────────────

interface MatchStats {
  count: number;
  minAh: number;
  maxAh: number;
  spreadAh: number;
  spreadPct: number;
  meanAh: number;
  packAh: number; // series pack is limited by the weakest cell
  irMin: number | null;
  irMax: number | null;
}

function matchStats(cells: CellCapacityStats[]): MatchStats | null {
  const caps = cells.map(c => c.latestAh).filter((v): v is number => v != null);
  if (caps.length === 0) return null;
  const minAh = Math.min(...caps);
  const maxAh = Math.max(...caps);
  const meanAh = caps.reduce((a, b) => a + b, 0) / caps.length;
  const irs = cells.map(c => c.latestIrMohm).filter((v): v is number => v != null);
  return {
    count: cells.length,
    minAh,
    maxAh,
    spreadAh: maxAh - minAh,
    spreadPct: maxAh > 0 ? ((maxAh - minAh) / maxAh) * 100 : 0,
    meanAh,
    packAh: minAh * cells.length,
    irMin: irs.length ? Math.min(...irs) : null,
    irMax: irs.length ? Math.max(...irs) : null,
  };
}

/** Match quality by capacity spread: <2% tight, <5% ok, else loose. */
function matchColor(spreadPct: number): string {
  if (spreadPct < 2) return '#4caf50';
  if (spreadPct < 5) return '#ff9800';
  return '#f44336';
}

/**
 * Pick the `size` cells whose latest capacities cluster the tightest.
 * Sorting by capacity makes the tightest group always contiguous, so we just
 * slide a window and take the one with the smallest max−min spread.
 */
function bestMatchedSet(cells: CellCapacityStats[], size: number): number[] {
  const usable = cells.filter(c => c.latestAh != null).sort((a, b) => (a.latestAh ?? 0) - (b.latestAh ?? 0));
  if (size < 2 || usable.length < size) return usable.map(c => c.cellId);

  let bestStart = 0;
  let bestSpread = Infinity;
  for (let i = 0; i + size <= usable.length; i++) {
    const spread = (usable[i + size - 1].latestAh ?? 0) - (usable[i].latestAh ?? 0);
    if (spread < bestSpread) {
      bestSpread = spread;
      bestStart = i;
    }
  }
  return usable.slice(bestStart, bestStart + size).map(c => c.cellId);
}

// ── Compare-curves data ────────────────────────────────────────────

interface CompareData {
  data: (number | null | undefined)[][];
  seriesInfo: CapacitySeriesInfo[];
}

/** Voltage-only capacity-domain overlay, one distinct color per cell. */
function buildCompareData(runs: CapacityRun[]): CompareData {
  if (runs.length === 0) return { data: [], seriesInfo: [] };
  const data: (number | null | undefined)[][] = [[...runs[0].capacityPct]];
  const seriesInfo: CapacitySeriesInfo[] = [];
  runs.forEach((run, i) => {
    data.push(run.voltage.map(v => v ?? undefined));
    seriesInfo.push({
      runId: run.id,
      label: run.label,
      color: getRunColor(i),
      metric: 'voltage',
      isReference: false,
      direction: run.direction,
    });
  });
  return { data, seriesInfo };
}

// ── Component ──────────────────────────────────────────────────────

export function HealthView() {
  const [stats, setStats] = useState<CellCapacityStats[] | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('capacity');
  const [sortDir, setSortDir] = useState<1 | -1>(-1); // best first by default
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [packSize, setPackSize] = useState(4);

  const reload = useCallback(() => {
    let cancelled = false;
    Promise.all([api<CellCapacityStats[]>('/api/capacity/all'), api<Cell[]>('/api/cells')])
      .then(([s, c]) => {
        if (cancelled) return;
        setStats(s);
        setCells(c);
      })
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : 'Failed to load'));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  // cellId → Cell, for retired/notes lookups the stats payload doesn't carry.
  const cellById = useMemo(() => new Map(cells.map(c => [c.id, c])), [cells]);
  const isRetired = useCallback((cellId: number) => cellById.get(cellId)?.retired_at != null, [cellById]);

  const sorted = useMemo(() => {
    if (!stats) return [];
    return [...stats].sort((a, b) => compareCells(a, b, sortKey, sortDir));
  }, [stats, sortKey, sortDir]);

  const activeStats = useMemo(() => sorted.filter(c => !isRetired(c.cellId)), [sorted, isRetired]);
  const retiredStats = useMemo(() => sorted.filter(c => isRetired(c.cellId)), [sorted, isRetired]);

  // Cells that have never had a completed discharge run (not in /api/capacity/all).
  const untested = useMemo(() => {
    const withData = new Set((stats ?? []).map(s => s.cellId));
    return cells.filter(c => !withData.has(c.id) && c.retired_at == null);
  }, [stats, cells]);

  const selectedStats = useMemo(() => activeStats.filter(c => selected.has(c.cellId)), [activeStats, selected]);
  const match = useMemo(() => matchStats(selectedStats), [selectedStats]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      // Name defaults A→Z; metrics default high→low (best first).
      setSortDir(key === 'name' ? 1 : -1);
    }
  }

  function toggleSelect(cellId: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
  }

  async function setRetired(cellId: number, retired: boolean) {
    // Optimistic: update local cell, drop from selection when retiring.
    setCells(prev => prev.map(c => (c.id === cellId ? { ...c, retired_at: retired ? 'now' : null } : c)));
    if (retired) {
      setSelected(prev => {
        const next = new Set(prev);
        next.delete(cellId);
        return next;
      });
    }
    try {
      const updated = await api<Cell>(`/api/cells/${cellId}`, {
        method: 'PATCH',
        body: JSON.stringify({ retired }),
      });
      setCells(prev => prev.map(c => (c.id === cellId ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retire failed');
      reload(); // roll back to server truth
    }
  }

  function pickBestMatch() {
    const ids = bestMatchedSet(activeStats, packSize);
    setSelected(new Set(ids));
  }

  const maxPack = Math.max(2, activeStats.filter(c => c.latestAh != null).length);

  return (
    <div className="health-view">
      <header className="health-header">
        <a className="btn btn-back" href="/">
          ← Back
        </a>
        <h1>Battery Health</h1>
        <span className="health-count">
          {stats ? `${activeStats.length} active` : ''}
          {retiredStats.length ? ` · ${retiredStats.length} retired` : ''}
          {untested.length ? ` · ${untested.length} untested` : ''}
        </span>
      </header>

      {error && <div className="health-error">{error}</div>}
      {!stats && !error && <div className="health-loading">Loading cell stats…</div>}

      {stats && stats.length === 0 && <div className="health-empty">No cells with completed discharge runs yet.</div>}

      {stats && stats.length > 0 && (
        <>
          <div className="health-controls">
            <div className="health-sort">
              <span className="health-sort-label">Sort:</span>
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`filter-chip ${sortKey === opt.key ? 'active' : ''}`}
                  onClick={() => toggleSort(opt.key)}
                >
                  {opt.label}
                  {sortKey === opt.key ? (sortDir === -1 ? ' ↓' : ' ↑') : ''}
                </button>
              ))}
            </div>

            <div className="health-pack">
              <span className="health-sort-label">Best match of</span>
              <button
                type="button"
                className="health-step"
                onClick={() => setPackSize(n => Math.max(2, n - 1))}
                disabled={packSize <= 2}
              >
                −
              </button>
              <span className="health-pack-n">{Math.min(packSize, maxPack)}</span>
              <button
                type="button"
                className="health-step"
                onClick={() => setPackSize(n => Math.min(maxPack, n + 1))}
                disabled={packSize >= maxPack}
              >
                +
              </button>
              <button type="button" className="filter-chip health-pack-go" onClick={pickBestMatch}>
                Pick tightest
              </button>
            </div>
          </div>

          <div className="health-table">
            {activeStats.map(cell => (
              <CellRow
                key={cell.cellId}
                cell={cell}
                cellMeta={cellById.get(cell.cellId) ?? null}
                selected={selected.has(cell.cellId)}
                expanded={expanded === cell.cellId}
                onToggleSelect={() => toggleSelect(cell.cellId)}
                onToggleExpand={() => setExpanded(e => (e === cell.cellId ? null : cell.cellId))}
                onRetire={() => setRetired(cell.cellId, true)}
                onSaveNotes={notes =>
                  api<Cell>(`/api/cells/${cell.cellId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ notes }),
                  }).then(u => setCells(prev => prev.map(c => (c.id === u.id ? u : c))))
                }
              />
            ))}
          </div>

          {retiredStats.length > 0 && (
            <div className="health-retired">
              <h4>Retired ({retiredStats.length})</h4>
              {retiredStats.map(cell => (
                <div key={cell.cellId} className="health-retired-row">
                  <span className="health-retired-name">{cellName(cell)}</span>
                  <span className="health-retired-cap">{formatAh(cell.latestAh)}</span>
                  <span className="health-retired-ir">{formatIr(cell.latestIrMohm)}</span>
                  <button type="button" className="btn btn-link" onClick={() => setRetired(cell.cellId, false)}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}

          {untested.length > 0 && (
            <div className="health-untested">
              <h4>Untested ({untested.length})</h4>
              <div className="health-untested-list">
                {untested.map(c => (
                  <span key={c.id} className="health-untested-cell">
                    {c.label || c.barcode}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {match && <MatchBar match={match} cells={selectedStats} onClear={() => setSelected(new Set())} />}
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────

function CellRow({
  cell,
  cellMeta,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  onRetire,
  onSaveNotes,
}: {
  cell: CellCapacityStats;
  cellMeta: Cell | null;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onRetire: () => void;
  onSaveNotes: (notes: string) => Promise<void>;
}) {
  const rates = capacityByRate(cell.runs);
  const dates = testedRange(cell.runs);

  return (
    <div className={`health-row ${selected ? 'health-row-selected' : ''}`}>
      <div className="health-row-head">
        <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${cellName(cell)}`} />
        <button type="button" className="health-row-body" onClick={onToggleExpand}>
          <span className="health-row-caret">{expanded ? '▾' : '▸'}</span>
          <span className="health-row-name">{cellName(cell)}</span>
          <span className="health-row-cap">{formatAh(cell.latestAh)}</span>
          {cell.healthPct != null && (
            <span className="health-row-health" style={{ color: healthColor(cell.healthPct) }}>
              {formatPct(cell.healthPct)}
            </span>
          )}
          <span className="health-row-ir">{formatIr(cell.latestIrMohm)}</span>
          {cell.trendAhPerCycle != null && <span className="health-row-trend">{trendArrow(cell.trendAhPerCycle)}</span>}
          <span className="health-row-runs">
            {cell.runCount} runs{dates ? ` · ${dates}` : ''}
          </span>
        </button>
      </div>

      {rates.length > 0 && (
        <div className="health-row-sub">
          {rates.map(r => {
            const pct = cell.nominalAh > 0 ? (r.ah / cell.nominalAh) * 100 : 0;
            return (
              <div key={r.rateA} className="health-rate-bar">
                <span className="health-rate-bar-label">{r.rateA} A</span>
                <div className="health-rate-bar-track">
                  <div
                    className="health-rate-bar-fill"
                    style={{ width: `${Math.min(100, pct)}%`, backgroundColor: healthColor(pct) }}
                  />
                </div>
                <span className="health-rate-bar-val">
                  {r.ah.toFixed(1)} Ah · {Math.round(pct)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {expanded && <CellDetail cell={cell} cellMeta={cellMeta} onRetire={onRetire} onSaveNotes={onSaveNotes} />}
    </div>
  );
}

// ── Per-cell degradation detail (Phase 4) ──────────────────────────

function CellDetail({
  cell,
  cellMeta,
  onRetire,
  onSaveNotes,
}: {
  cell: CellCapacityStats;
  cellMeta: Cell | null;
  onRetire: () => void;
  onSaveNotes: (notes: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState(cellMeta?.notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const dirty = notes !== (cellMeta?.notes ?? '');

  const caps = cell.runs.map(r => r.capacityAh);

  return (
    <div className="health-detail">
      <div className="health-detail-stats">
        <DetailStat label="Median" value={formatAh(cell.medianAh)} />
        <DetailStat label="Range" value={`${formatAh(cell.minAh)} – ${formatAh(cell.maxAh)}`} />
        <DetailStat
          label="Trend / cycle"
          value={
            cell.trendAhPerCycle != null
              ? `${cell.trendAhPerCycle > 0 ? '+' : ''}${cell.trendAhPerCycle.toFixed(3)} Ah`
              : '—'
          }
        />
        <DetailStat label="Median IR" value={formatIr(cell.medianIrMohm)} />
      </div>

      {caps.length >= 2 && <Sparkline values={caps} />}

      <div className="health-detail-runs">
        {cell.runs.map((r, i) => (
          <div key={r.id} className="health-detail-run">
            <span className="health-detail-run-idx">#{i + 1}</span>
            <span className="health-detail-run-date">{new Date(r.date).toLocaleDateString()}</span>
            <span className="health-detail-run-rate">{r.currentA.toFixed(0)} A</span>
            <span className="health-detail-run-cap">{r.capacityAh.toFixed(2)} Ah</span>
          </div>
        ))}
      </div>

      <div className="health-detail-notes">
        <textarea
          value={notes}
          placeholder="Notes (terminal cleaning, physical damage, …)"
          onChange={e => setNotes(e.target.value)}
        />
        <div className="health-detail-actions">
          <button
            type="button"
            className="btn btn-save"
            disabled={!dirty || savingNotes}
            onClick={async () => {
              setSavingNotes(true);
              await onSaveNotes(notes).finally(() => setSavingNotes(false));
            }}
          >
            {savingNotes ? 'Saving…' : 'Save notes'}
          </button>
          <button type="button" className="btn btn-danger" onClick={onRetire}>
            Retire cell
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-detail-stat">
      <span className="health-detail-stat-label">{label}</span>
      <span className="health-detail-stat-value">{value}</span>
    </div>
  );
}

/** Tiny inline SVG sparkline of capacity across cycles. */
function Sparkline({ values }: { values: number[] }) {
  const w = 220;
  const h = 40;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className="health-sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Capacity over cycles"
    >
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

// ── Match / pack-spread bar + compare curves (Phases 2–3) ──────────

function MatchBar({ match, cells, onClear }: { match: MatchStats; cells: CellCapacityStats[]; onClear: () => void }) {
  const color = matchColor(match.spreadPct);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compare, setCompare] = useState<CompareData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const openCompare = useCallback(async () => {
    setCompareOpen(true);
    setCompareLoading(true);
    setCompareError(null);
    try {
      const runs: CapacityRun[] = [];
      for (const c of cells) {
        const runId = c.runs.at(-1)?.id;
        if (!runId) continue;
        const [meta, data] = await Promise.all([
          api<TestRun>(`/api/runs/${runId}`),
          api<{ d: number[][]; downsampled?: boolean }>(`/api/runs/${runId}/data?compact=1`),
        ]);
        const chartRun = compactDataToChartRun(meta, data.d, cellName(c), data.downsampled);
        runs.push(runToCapacityDomain(chartRun, c.nominalAh * 1000));
      }
      setCompare(buildCompareData(runs));
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : 'Failed to load curves');
    } finally {
      setCompareLoading(false);
    }
  }, [cells]);

  return (
    <div className="health-match-bar">
      {compareOpen && (
        <div className="health-compare">
          <div className="health-compare-head">
            <strong>Discharge curves</strong>
            <button type="button" className="btn btn-link" onClick={() => setCompareOpen(false)}>
              Close
            </button>
          </div>
          {compareLoading && <div className="health-compare-msg">Loading curves…</div>}
          {compareError && <div className="health-compare-msg health-error">{compareError}</div>}
          {compare && compare.seriesInfo.length > 0 && (
            <>
              <div className="health-compare-chart">
                <CapacityChart data={compare.data} seriesInfo={compare.seriesInfo} />
              </div>
              <div className="health-compare-legend">
                {compare.seriesInfo.map(s => (
                  <span key={s.runId} className="health-compare-legend-item">
                    <span className="health-compare-swatch" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="health-match-title">
        <strong>{match.count}</strong> selected
        {match.count >= 2 && !compareOpen && (
          <button type="button" className="filter-chip health-match-compare" onClick={openCompare}>
            Compare curves
          </button>
        )}
        <button type="button" className="btn btn-link health-match-clear" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="health-match-stats">
        <div className="health-match-stat">
          <span className="health-match-label">Spread</span>
          <span className="health-match-value" style={{ color }}>
            {match.spreadAh.toFixed(2)} Ah ({match.spreadPct.toFixed(1)}%)
          </span>
        </div>
        <div className="health-match-stat">
          <span className="health-match-label">Range</span>
          <span className="health-match-value">
            {match.minAh.toFixed(1)} – {match.maxAh.toFixed(1)} Ah
          </span>
        </div>
        <div className="health-match-stat">
          <span className="health-match-label">Mean</span>
          <span className="health-match-value">{match.meanAh.toFixed(1)} Ah</span>
        </div>
        <div className="health-match-stat">
          <span className="health-match-label">Series pack</span>
          <span className="health-match-value">{match.packAh.toFixed(1)} Ah</span>
        </div>
        {match.irMin != null && match.irMax != null && (
          <div className="health-match-stat">
            <span className="health-match-label">IR range</span>
            <span className="health-match-value">
              {formatIr(match.irMin)} – {formatIr(match.irMax)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
