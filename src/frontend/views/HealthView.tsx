/**
 * HealthView — dedicated battery-health screen (route /health).
 *
 * Ranks every tested cell by capacity / health / internal resistance so the
 * best cells and the junk are obvious at a glance, lets you multi-select cells
 * to see how well-matched they'd be as a pack, and (later phases) overlay their
 * discharge curves and drill into per-cell degradation.
 *
 * Data is REST-only (`/api/capacity/all` + `/api/cells`); it does not need the
 * live device session.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type Cell, type CellCapacityStats, type RunCapacitySummary } from '../api-client.ts';
import { formatAh, formatIr, formatPct, healthColor, trendArrow } from '../lib/health-format.ts';

// ── Sorting ────────────────────────────────────────────────────────

type SortKey = 'capacity' | 'health' | 'ir' | 'trend' | 'name';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'capacity', label: 'Capacity' },
  { key: 'health', label: 'Health' },
  { key: 'ir', label: 'Resistance' },
  { key: 'trend', label: 'Trend' },
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

// ── Component ──────────────────────────────────────────────────────

export function HealthView() {
  const [stats, setStats] = useState<CellCapacityStats[] | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('capacity');
  const [sortDir, setSortDir] = useState<1 | -1>(-1); // best first by default
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
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

  const sorted = useMemo(() => {
    if (!stats) return [];
    return [...stats].sort((a, b) => compareCells(a, b, sortKey, sortDir));
  }, [stats, sortKey, sortDir]);

  // Cells that have never had a completed discharge run (not in /api/capacity/all).
  const untested = useMemo(() => {
    const withData = new Set((stats ?? []).map(s => s.cellId));
    return cells.filter(c => !withData.has(c.id));
  }, [stats, cells]);

  const selectedStats = useMemo(() => sorted.filter(c => selected.has(c.cellId)), [sorted, selected]);
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

  return (
    <div className="health-view">
      <header className="health-header">
        <a className="btn btn-back" href="/">
          ← Back
        </a>
        <h1>Battery Health</h1>
        <span className="health-count">
          {stats ? `${stats.length} tested` : ''}
          {untested.length ? ` · ${untested.length} untested` : ''}
        </span>
      </header>

      {error && <div className="health-error">{error}</div>}
      {!stats && !error && <div className="health-loading">Loading cell stats…</div>}

      {stats && stats.length === 0 && <div className="health-empty">No cells with completed discharge runs yet.</div>}

      {stats && stats.length > 0 && (
        <>
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

          <div className="health-table">
            {sorted.map(cell => (
              <CellRow
                key={cell.cellId}
                cell={cell}
                selected={selected.has(cell.cellId)}
                onToggleSelect={() => toggleSelect(cell.cellId)}
              />
            ))}
          </div>

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

      {match && <MatchBar match={match} onClear={() => setSelected(new Set())} />}
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────

function CellRow({
  cell,
  selected,
  onToggleSelect,
}: {
  cell: CellCapacityStats;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const rates = capacityByRate(cell.runs);
  const barPct = cell.healthPct != null ? Math.min(100, cell.healthPct) : 0;

  return (
    <label className={`health-row ${selected ? 'health-row-selected' : ''}`}>
      <input type="checkbox" checked={selected} onChange={onToggleSelect} />
      <div className="health-row-body">
        <div className="health-row-top">
          <span className="health-row-name">{cellName(cell)}</span>
          <span className="health-row-cap">{formatAh(cell.latestAh)}</span>
          {cell.healthPct != null && (
            <span className="health-row-health" style={{ color: healthColor(cell.healthPct) }}>
              {formatPct(cell.healthPct)}
            </span>
          )}
          <span className="health-row-ir">{formatIr(cell.latestIrMohm)}</span>
          {cell.trendAhPerCycle != null && <span className="health-row-trend">{trendArrow(cell.trendAhPerCycle)}</span>}
          <span className="health-row-runs">{cell.runCount} runs</span>
        </div>

        {rates.length > 0 && (
          <div className="health-row-rates">
            {rates.map(r => (
              <span key={r.rateA} className="health-rate-chip">
                <span className="health-rate-a">{r.rateA} A</span>
                <span className="health-rate-ah">{r.ah.toFixed(1)} Ah</span>
              </span>
            ))}
          </div>
        )}

        {cell.healthPct != null && cell.nominalAh > 0 && (
          <div className="health-row-bar">
            <div
              className="health-row-bar-fill"
              style={{ width: `${barPct}%`, backgroundColor: healthColor(cell.healthPct) }}
            />
          </div>
        )}
      </div>
    </label>
  );
}

// ── Match / pack-spread bar ────────────────────────────────────────

function MatchBar({ match, onClear }: { match: MatchStats; onClear: () => void }) {
  const color = matchColor(match.spreadPct);
  return (
    <div className="health-match-bar">
      <div className="health-match-title">
        <strong>{match.count}</strong> selected
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
