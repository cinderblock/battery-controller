/**
 * ChartView — the app's primary interface.
 *
 * Full-viewport chart showing all historical runs for the selected cell group.
 * When a test is active, the live trace is prominent and old runs desaturate.
 * Bottom bar has New Run / Stop button, cell group selector with fleet stats,
 * and legend toggle.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSession } from '../hooks/useDeviceSession.ts';
import {
  api,
  type TestRun,
  type DataPoint,
  type CellGroup,
  type GroupFleetSummary,
} from '../api-client.ts';
import {
  mergeRunsForChart,
  dataPointsToChartRun,
  type ChartRun,
  type MetricKey,
} from '../lib/chart-data.ts';
import { Chart } from '../components/Chart.tsx';
import { TopBar } from '../components/TopBar.tsx';
import { StartModal } from '../components/StartModal.tsx';
import { LegendPanel } from '../components/LegendPanel.tsx';
import { LiveOverlay } from '../components/LiveOverlay.tsx';
import { CameraView } from '../components/CameraView.tsx';

// ── Component ──────────────────────────────────────────────────────

export function ChartView() {
  const { state, stopTest } = useSession();
  const isTestActive = state.mode === 'd-cc' || state.mode === 'd-cp' || state.mode === 'c-cv';

  // ── Historical run data ──────────────────────────────────────
  const [runs, setRuns] = useState<ChartRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [cellGroups, setCellGroups] = useState<CellGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  // ── Fleet summary ────────────────────────────────────────────
  const [fleetSummary, setFleetSummary] = useState<GroupFleetSummary | null>(null);

  // ── UI state ─────────────────────────────────────────────────
  const [legendOpen, setLegendOpen] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [visibleMetrics, setVisibleMetrics] = useState<Set<MetricKey>>(
    () => new Set(['voltage', 'current'])
  );
  const [visibleRuns, setVisibleRuns] = useState<Set<number>>(() => new Set());

  // ── Load cell groups ──────────────────────────────────────────
  useEffect(() => {
    api<CellGroup[]>('/api/cell-groups').then(groups => {
      setCellGroups(groups);
      if (groups.length > 0 && selectedGroupId === null) {
        setSelectedGroupId(groups[0].id);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load fleet summary when group changes ─────────────────────
  useEffect(() => {
    if (selectedGroupId === null) {
      setFleetSummary(null);
      return;
    }
    api<GroupFleetSummary>(`/api/cell-groups/${selectedGroupId}/summary`)
      .then(setFleetSummary)
      .catch(() => setFleetSummary(null));
  }, [selectedGroupId]);

  // ── Load historical runs ──────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    api<TestRun[]>('/api/runs/recent?limit=100')
      .then(async (testRuns) => {
        // Load data points for each run (in parallel, limited batch)
        const chartRuns: ChartRun[] = [];
        const batchSize = 5;

        for (let i = 0; i < testRuns.length; i += batchSize) {
          const batch = testRuns.slice(i, i + batchSize);
          const results = await Promise.all(
            batch.map(async (run) => {
              try {
                const points = await api<DataPoint[]>(`/api/runs/${run.id}/data`);
                if (points.length === 0) return null;
                const label = run.cell_id ? `Cell #${run.cell_id}` : `Run #${run.id}`;
                return dataPointsToChartRun(run, points, label);
              } catch {
                return null;
              }
            })
          );
          for (const r of results) {
            if (r) chartRuns.push(r);
          }
        }

        setRuns(chartRuns);
        setVisibleRuns(new Set(chartRuns.map(r => r.id)));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Reload runs + fleet summary when a test completes ─────────
  const prevActiveRef = usePrevious(isTestActive);
  useEffect(() => {
    // When test transitions from active → idle, reload runs
    if (prevActiveRef && !isTestActive) {
      api<TestRun[]>('/api/runs/recent?limit=100')
        .then(async (testRuns) => {
          const chartRuns: ChartRun[] = [];
          for (const run of testRuns) {
            try {
              const points = await api<DataPoint[]>(`/api/runs/${run.id}/data`);
              if (points.length === 0) continue;
              const label = run.cell_id ? `Cell #${run.cell_id}` : `Run #${run.id}`;
              chartRuns.push(dataPointsToChartRun(run, points, label));
            } catch { /* skip */ }
          }
          setRuns(chartRuns);
          setVisibleRuns(new Set(chartRuns.map(r => r.id)));
        })
        .catch(() => {});

      // Refresh fleet summary too — new run data may update stats
      if (selectedGroupId !== null) {
        api<GroupFleetSummary>(`/api/cell-groups/${selectedGroupId}/summary`)
          .then(setFleetSummary)
          .catch(() => {});
      }
    }
  }, [isTestActive, prevActiveRef, selectedGroupId]);

  // ── Merge data for chart ──────────────────────────────────────
  const chartData = useMemo(
    () => mergeRunsForChart(
      runs,
      state.livePoints,
      visibleRuns,
      visibleMetrics,
      isTestActive,
    ),
    [runs, state.livePoints, visibleRuns, visibleMetrics, isTestActive]
  );

  // ── Toggle handlers ──────────────────────────────────────────
  const toggleMetric = useCallback((metric: MetricKey) => {
    setVisibleMetrics(prev => {
      const next = new Set(prev);
      if (next.has(metric)) next.delete(metric);
      else next.add(metric);
      return next;
    });
  }, []);

  const toggleRun = useCallback((runId: number) => {
    setVisibleRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const showAllRuns = useCallback(() => {
    setVisibleRuns(new Set(runs.map(r => r.id)));
  }, [runs]);

  const hideAllRuns = useCallback(() => {
    setVisibleRuns(new Set());
  }, []);

  // ── Fleet badge for group selector ────────────────────────────
  const groupBadge = fleetSummary && fleetSummary.avgHealthPct !== null
    ? `${fleetSummary.avgHealthPct.toFixed(0)}%`
    : null;

  return (
    <div className="chart-view">
      <TopBar />
      <CameraView />

      <div className="chart-area">
        {loading ? (
          <div className="chart-loading">Loading runs...</div>
        ) : chartData.data[0]?.length ? (
          <Chart data={chartData.data} seriesInfo={chartData.seriesInfo} />
        ) : (
          <div className="chart-empty">
            {runs.length === 0
              ? 'No test runs yet. Start a new test to begin.'
              : 'No visible series. Open the legend to toggle metrics and runs.'}
          </div>
        )}
        <LiveOverlay />
      </div>

      {/* Bottom bar */}
      <div className="bottom-bar">
        <button className="btn btn-legend" onClick={() => setLegendOpen(!legendOpen)}>
          Legend
        </button>

        {cellGroups.length > 0 && (
          <div className="group-select-wrapper">
            <select
              className="group-select"
              value={selectedGroupId ?? ''}
              onChange={e => setSelectedGroupId(parseInt(e.target.value, 10) || null)}
            >
              {cellGroups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            {groupBadge && (
              <span className="group-health-badge" style={{
                color: fleetSummary!.avgHealthPct! >= 90 ? '#4caf50'
                  : fleetSummary!.avgHealthPct! >= 75 ? '#ff9800'
                  : '#f44336'
              }}>
                {groupBadge}
              </span>
            )}
          </div>
        )}

        <div className="bottom-spacer" />

        {isTestActive ? (
          <button className="btn btn-stop" onClick={stopTest}>
            Stop
          </button>
        ) : (
          <button className="btn btn-new-run" onClick={() => setStartModalOpen(true)}>
            New Run
          </button>
        )}

        <a href="/sequences" className="btn btn-link">Sequences</a>
      </div>

      <LegendPanel
        open={legendOpen}
        onClose={() => setLegendOpen(false)}
        runs={runs}
        visibleMetrics={visibleMetrics}
        visibleRuns={visibleRuns}
        onToggleMetric={toggleMetric}
        onToggleRun={toggleRun}
        onShowAll={showAllRuns}
        onHideAll={hideAllRuns}
        fleetSummary={fleetSummary}
      />

      <StartModal
        open={startModalOpen}
        onClose={() => setStartModalOpen(false)}
        cellGroups={cellGroups}
        selectedGroupId={selectedGroupId}
      />
    </div>
  );
}

// ── usePrevious hook ───────────────────────────────────────────────

function usePrevious<T>(value: T): T | undefined {
  const [prev, setPrev] = useState<T | undefined>(undefined);
  useEffect(() => {
    setPrev(value);
  }, [value]);
  return prev;
}
