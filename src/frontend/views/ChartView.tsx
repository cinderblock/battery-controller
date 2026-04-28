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
  type TestRunWithData,
  type CellGroup,
  type GroupFleetSummary,
} from '../api-client.ts';
import {
  mergeRunsForChart,
  mergeCapacityChart,
  mergeActiveRunWithLive,
  compactDataToChartRun,
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

  // ── Active run metadata (for threshold lines) ────────────────
  const [activeRunMeta, setActiveRunMeta] = useState<TestRun | null>(null);

  // ── Fleet summary ────────────────────────────────────────────
  const [fleetSummary, setFleetSummary] = useState<GroupFleetSummary | null>(null);

  // ── UI state ─────────────────────────────────────────────────
  const [legendOpen, setLegendOpen] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [chartMode, setChartMode] = useState<'time' | 'capacity'>('time');
  const [visibleMetrics, setVisibleMetrics] = useState<Set<MetricKey>>(
    () => new Set(['voltage', 'current'])
  );
  const [visibleRuns, setVisibleRuns] = useState<Set<number>>(() => new Set());

  // ── Auto-detect cell insertion ────────────────────────────────
  // When the device is idle and voltage jumps from near-zero to cell range,
  // a new cell was probably inserted → auto-open the start modal.
  // We use null to mean "no real reading yet" — only start detecting after
  // two consecutive real readings, so page reload doesn't trigger it.
  const prevVoltageRef = useRef<number | null>(null);

  useEffect(() => {
    // Don't act on missing readings (state.reading is null before snapshot)
    if (!state.reading) return;

    const voltage = state.reading.voltage;
    const isIdle = state.mode === 'idle';
    const prev = prevVoltageRef.current;

    prevVoltageRef.current = voltage;

    // Need a prior real reading to detect a transition
    if (prev === null) return;

    // Detect voltage transition: low → cell range, while idle
    if (isIdle && prev < 1.5 && voltage > 2.0 && !startModalOpen) {
      setStartModalOpen(true);
    }
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

  // ── Fetch active run metadata for threshold lines ─────────────
  useEffect(() => {
    if (!state.activeRunId) { setActiveRunMeta(null); return; }
    api<TestRun>(`/api/runs/${state.activeRunId}`)
      .then(setActiveRunMeta)
      .catch(() => setActiveRunMeta(null));
  }, [state.activeRunId]);

  // ── Load historical runs ──────────────────────────────────────
  const loadRuns = useCallback(() => {
    return api<TestRunWithData[]>('/api/runs/recent?limit=100&withData=1')
      .then(runsWithData => {
        const chartRuns: ChartRun[] = [];
        for (const rwd of runsWithData) {
          if (rwd.d.length === 0) continue;
          const label = rwd.cell_id ? `Cell #${rwd.cell_id}` : `Run #${rwd.id}`;
          chartRuns.push(compactDataToChartRun(rwd, rwd.d, label));
        }
        setRuns(chartRuns);
        setVisibleRuns(new Set(chartRuns.map(r => r.id)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    loadRuns().finally(() => setLoading(false));
  }, [loadRuns]);

  // ── Reload runs + fleet summary when a test completes ─────────
  const prevActiveRef = usePrevious(isTestActive);
  useEffect(() => {
    // When test transitions from active → idle, reload runs
    if (prevActiveRef && !isTestActive) {
      loadRuns();

      // Refresh fleet summary too — new run data may update stats
      if (selectedGroupId !== null) {
        api<GroupFleetSummary>(`/api/cell-groups/${selectedGroupId}/summary`)
          .then(setFleetSummary)
          .catch(() => {});
      }
    }
  }, [isTestActive, prevActiveRef, selectedGroupId, loadRuns]);

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
    if (!activeRunMeta) return [];

    const lines: ThresholdLine[] = [];

    if (activeRunMeta.setpoint_cutoff_v != null) {
      lines.push({
        value: activeRunMeta.setpoint_cutoff_v,
        scale: 'V',
        label: `Cutoff ${activeRunMeta.setpoint_cutoff_v.toFixed(2)}V`,
        color: 'rgba(244, 67, 54, 0.5)',
      });
    }
    if (activeRunMeta.setpoint_voltage_v != null && activeRunMeta.mode === 'c-cv') {
      lines.push({
        value: activeRunMeta.setpoint_voltage_v,
        scale: 'V',
        label: `Target ${activeRunMeta.setpoint_voltage_v.toFixed(2)}V`,
        color: 'rgba(79, 195, 247, 0.5)',
      });
    }
    if (activeRunMeta.setpoint_cutoff_current_a != null) {
      lines.push({
        value: activeRunMeta.setpoint_cutoff_current_a,
        scale: 'A',
        label: `Cutoff ${activeRunMeta.setpoint_cutoff_current_a.toFixed(1)}A`,
        color: 'rgba(129, 199, 132, 0.5)',
      });
    }

    return lines;
  }, [activeRunMeta]);

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

        {isTestActive || state.stopping || (state.cycleState && (state.cycleState.status === 'running' || state.cycleState.status === 'waiting')) ? (
          <button className="btn btn-stop" onClick={stopTest} disabled={state.stopping}>
            {state.stopping ? 'Stopping...' : 'Stop'}
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
  const ref = useRef<T | undefined>(undefined);
  const prev = ref.current;
  ref.current = value;
  return prev;
}
