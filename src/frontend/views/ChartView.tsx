/**
 * ChartView — the app's primary interface.
 *
 * Full-viewport chart showing all historical runs for the selected cell group.
 * When a test is active, the live trace is prominent and old runs desaturate.
 * Bottom bar has New Run / Stop button, cell group selector with fleet stats,
 * and legend toggle.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  mergeCapacityChart,
  mergeActiveRunWithLive,
  dataPointsToChartRun,
  runToCapacityDomain,
  type ChartRun,
  type MetricKey,
  type ThresholdLine,
} from '../lib/chart-data.ts';
import { getDefaultReferenceCurves } from '../lib/lfp-reference-curves.ts';
import { Chart } from '../components/Chart.tsx';
import { CapacityChart } from '../components/CapacityChart.tsx';
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
  const [chartMode, setChartMode] = useState<'time' | 'capacity'>('capacity');
  const [visibleMetrics, setVisibleMetrics] = useState<Set<MetricKey>>(
    () => new Set(['voltage', 'current'])
  );
  const [visibleRuns, setVisibleRuns] = useState<Set<number>>(() => new Set());

  // ── Auto-detect cell insertion ────────────────────────────────
  // When the device is idle and voltage jumps from near-zero to cell range,
  // a new cell was probably inserted → auto-open the start modal.
  const prevVoltageRef = useRef<number>(0);
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    const voltage = state.reading?.voltage ?? 0;
    const isIdle = state.mode === 'idle';
    const prev = prevVoltageRef.current;

    // Skip the first reading (don't trigger on app load)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      prevVoltageRef.current = voltage;
      return;
    }

    // Detect voltage transition: low → cell range, while idle
    if (isIdle && prev < 1.5 && voltage > 2.0 && !startModalOpen) {
      setStartModalOpen(true);
    }

    prevVoltageRef.current = voltage;
  }, [state.reading?.voltage, state.mode, startModalOpen]);

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
      state.activeRunId,
    ),
    [runs, state.livePoints, visibleRuns, visibleMetrics, isTestActive, state.activeRunId]
  );

  // ── Capacity chart data ───────────────────────────────────────
  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? null;
  const nominalMah = selectedGroup?.nominal_capacity_mah ?? 200000;
  const nominalAh = nominalMah / 1000;

  // Merge live points into the active run so the capacity chart stays current
  const runsWithLive = useMemo(
    () => mergeActiveRunWithLive(runs, state.activeRunId, state.livePoints),
    [runs, state.activeRunId, state.livePoints]
  );

  const capacityRuns = useMemo(
    () => runsWithLive.map(run => runToCapacityDomain(run, nominalMah)),
    [runsWithLive, nominalMah]
  );

  const referenceCurves = useMemo(
    () => getDefaultReferenceCurves(nominalAh),
    [nominalAh]
  );

  const capacityChartData = useMemo(
    () => mergeCapacityChart(capacityRuns, referenceCurves, visibleRuns),
    [capacityRuns, referenceCurves, visibleRuns]
  );

  // ── Threshold lines from active run setpoints ──────────────────
  const thresholds = useMemo((): ThresholdLine[] => {
    const activeRun = runs.find(r => r.id === state.activeRunId);
    if (!activeRun?.meta) return [];

    const meta = activeRun.meta;
    const lines: ThresholdLine[] = [];

    if (meta.setpoint_cutoff_v != null) {
      lines.push({
        value: meta.setpoint_cutoff_v,
        scale: 'V',
        label: `Cutoff ${meta.setpoint_cutoff_v.toFixed(2)}V`,
        color: 'rgba(244, 67, 54, 0.5)',
      });
    }
    if (meta.setpoint_voltage_v != null && meta.mode === 'c-cv') {
      lines.push({
        value: meta.setpoint_voltage_v,
        scale: 'V',
        label: `Target ${meta.setpoint_voltage_v.toFixed(2)}V`,
        color: 'rgba(79, 195, 247, 0.5)',
      });
    }
    if (meta.setpoint_cutoff_current_a != null) {
      lines.push({
        value: meta.setpoint_cutoff_current_a,
        scale: 'A',
        label: `Cutoff ${meta.setpoint_cutoff_current_a.toFixed(1)}A`,
        color: 'rgba(129, 199, 132, 0.5)',
      });
    }

    return lines;
  }, [runs, state.activeRunId]);

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
        ) : chartMode === 'time' ? (
          chartData.data[0]?.length ? (
            <Chart data={chartData.data} seriesInfo={chartData.seriesInfo} thresholds={thresholds} />
          ) : (
            <div className="chart-empty">
              {runs.length === 0
                ? 'No test runs yet. Start a new test to begin.'
                : 'No visible series. Open the legend to toggle metrics and runs.'}
            </div>
          )
        ) : (
          capacityChartData.data[0]?.length ? (
            <CapacityChart data={capacityChartData.data} seriesInfo={capacityChartData.seriesInfo} thresholds={thresholds} />
          ) : (
            <div className="chart-empty">
              {runs.length === 0
                ? 'No test runs yet. Start a new test to begin.'
                : 'No visible runs. Open the legend to toggle runs.'}
            </div>
          )
        )}
        {chartMode === 'time' && <LiveOverlay />}
      </div>

      {/* Bottom bar */}
      <div className="bottom-bar">
        <button className="btn btn-legend" onClick={() => setLegendOpen(!legendOpen)}>
          Legend
        </button>

        <div className="chart-mode-toggle">
          <button
            className={`chart-mode-btn ${chartMode === 'time' ? 'active' : ''}`}
            onClick={() => setChartMode('time')}
          >
            Time
          </button>
          <button
            className={`chart-mode-btn ${chartMode === 'capacity' ? 'active' : ''}`}
            onClick={() => setChartMode('capacity')}
          >
            V-Ah
          </button>
        </div>

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
