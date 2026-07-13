/**
 * ChartView — the app's primary interface.
 *
 * Full-viewport chart showing all historical runs for the selected cell group.
 * When a test is active, the live trace is prominent and old runs desaturate.
 * Bottom bar has New Run / Stop button, cell group selector with fleet stats,
 * and legend toggle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Cell,
  type CellGroup,
  type GroupFleetSummary,
  type TestRun,
  type TestRunWithData,
} from '../api-client.ts';
import { CameraView } from '../components/CameraView.tsx';
import { CapacityChart } from '../components/CapacityChart.tsx';
import { CellSelectModal } from '../components/CellSelectModal.tsx';
import { Chart } from '../components/Chart.tsx';
import { LegendPanel } from '../components/LegendPanel.tsx';
import { StartModal } from '../components/StartModal.tsx';
import { TopBar } from '../components/TopBar.tsx';
import { useSession } from '../hooks/useDeviceSession.ts';
import {
  buildRunColorMap,
  buildTempChartData,
  type ChartRun,
  type ColorBy,
  compactDataToChartRun,
  type MergedChartData,
  type MetricKey,
  mergeActiveRunWithLive,
  mergeCapacityChart,
  mergeRunsForChart,
  runToCapacityDomain,
  type TempDataPoint,
  type ThresholdLine,
} from '../lib/chart-data.ts';
import { getDefaultReferenceCurves } from '../lib/lfp-reference-curves.ts';

// ── Component ──────────────────────────────────────────────────────

export function ChartView() {
  const { state, stopTest, endStep, enableBridge, disableBridge } = useSession();
  const isTestActive = state.mode === 'd-cc' || state.mode === 'd-cp' || state.mode === 'c-cv';
  const [bridgeLoading, setBridgeLoading] = useState(false);

  // ── End-step-early button (two-tap confirm) ──────────────────
  const cycleActive =
    state.cycleState != null && (state.cycleState.status === 'running' || state.cycleState.status === 'waiting');
  const [endStepArmed, setEndStepArmed] = useState(false);
  const endStepArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEndStep = useCallback(async () => {
    if (!endStepArmed) {
      // First tap arms the button; it disarms itself after 4s
      setEndStepArmed(true);
      if (endStepArmTimer.current) clearTimeout(endStepArmTimer.current);
      endStepArmTimer.current = setTimeout(() => setEndStepArmed(false), 4000);
      return;
    }
    if (endStepArmTimer.current) clearTimeout(endStepArmTimer.current);
    setEndStepArmed(false);
    try {
      await endStep();
    } catch (err) {
      console.error('End step failed:', err);
    }
  }, [endStepArmed, endStep]);

  useEffect(
    () => () => {
      if (endStepArmTimer.current) clearTimeout(endStepArmTimer.current);
    },
    []
  );

  // ── Layout refs ─────────────────────────────────────────────
  const chartViewRef = useRef<HTMLDivElement>(null);

  // On mobile, scroll past the camera to hide it by default
  const handleCameraVisibility = useCallback((visible: boolean) => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const el = chartViewRef.current;
      if (!el || window.innerWidth > 480) return;
      const cam = el.querySelector('.camera-view') as HTMLElement | null;
      if (cam) {
        el.scrollTop = cam.offsetHeight;
      }
    });
  }, []);

  // ── Historical run data ──────────────────────────────────────
  const [runs, setRuns] = useState<ChartRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [cellGroups, setCellGroups] = useState<CellGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  // ── Active run metadata (for threshold lines) ────────────────
  const [activeRunMeta, setActiveRunMeta] = useState<TestRun | null>(null);

  // ── Temperature data per run ────────────────────────────────
  const [tempDataByRun, setTempDataByRun] = useState<Map<number, TempDataPoint[]>>(new Map());

  // ── Fleet summary ────────────────────────────────────────────
  const [fleetSummary, setFleetSummary] = useState<GroupFleetSummary | null>(null);

  // ── UI state ─────────────────────────────────────────────────
  const [legendOpen, setLegendOpen] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [chartMode, setChartMode] = useState<'time' | 'capacity'>('time');
  const [visibleMetrics, setVisibleMetrics] = useState<Set<MetricKey>>(
    () => new Set(['voltage', 'current', 'temperature'])
  );
  const [visibleRuns, setVisibleRuns] = useState<Set<number>>(() => new Set());

  // ── Run filters ──────────────────────────────────────────────
  const [showCharge, setShowCharge] = useState(true);
  const [showDischarge, setShowDischarge] = useState(true);
  const [showComplete, setShowComplete] = useState(true);
  const [showPartial, setShowPartial] = useState(true);
  const [daysPast, setDaysPast] = useState(7); // Show runs from last N days (0 = all)
  const [colorBy, setColorBy] = useState<ColorBy>('run');

  // ── Cell visibility (Cells modal) ─────────────────────────────
  const [cells, setCells] = useState<Cell[]>([]);
  const [cellsModalOpen, setCellsModalOpen] = useState(false);
  /** Cell ids whose runs are hidden (-1 = runs with no cell) */
  const [hiddenCellIds, setHiddenCellIds] = useState<Set<number>>(() => new Set());
  /** Cell whose runs are currently being fetched on demand */
  const [loadingCellId, setLoadingCellId] = useState<number | null>(null);

  const loadCells = useCallback(() => {
    return api<Cell[]>('/api/cells')
      .then(setCells)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadCells();
  }, [loadCells]);

  // ── Auto-detect cell insertion ────────────────────────────────
  // When the device is idle and voltage jumps from near-zero to cell range,
  // a new cell was probably inserted → auto-open the start modal.
  // We use null to mean "no real reading yet" — only start detecting after
  // two consecutive real readings, so page reload doesn't trigger it.
  const prevVoltageRef = useRef<number | null>(null);

  useEffect(() => {
    // Only track voltages from real device readings, not the default-zero
    // snapshot that arrives before the device responds.
    if (!state.reading || !state.deviceResponsive) return;

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
  }, [state.reading?.voltage, state.mode, state.deviceResponsive, startModalOpen]);

  // ── Load cell groups ──────────────────────────────────────────
  useEffect(() => {
    api<CellGroup[]>('/api/cell-groups')
      .then(groups => {
        setCellGroups(groups);
        if (groups.length > 0 && selectedGroupId === null) {
          setSelectedGroupId(groups[0].id);
        }
      })
      .catch(() => {});
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
    if (!state.activeRunId) {
      setActiveRunMeta(null);
      return;
    }
    api<TestRun>(`/api/runs/${state.activeRunId}`)
      .then(setActiveRunMeta)
      .catch(() => setActiveRunMeta(null));
  }, [state.activeRunId]);

  // ── Run filter helpers ──────────────────────────────────────────

  /** Check whether a run looks like a "complete" cycle based on actual data.
   *  Charge: started below midpoint voltage, ended at/near cutoff current.
   *  Discharge: started above midpoint voltage, ended at/near cutoff voltage. */
  const isRunComplete = useCallback((run: ChartRun, group: CellGroup | null): boolean => {
    const n = run.voltage.length;
    if (n === 0) return false;
    const startV = run.voltage[0];
    const endV = run.voltage[n - 1];
    const endI = run.current[n - 1];
    const mode = run.meta.mode;

    // Derive voltage midpoint from cell group range (default LFP 2.8–3.65)
    const vLow = group?.discharge_cutoff_v ?? 2.8;
    const vHigh = group?.charge_voltage_v ?? 3.65;
    const vMid = (vLow + vHigh) / 2;

    if (mode === 'c-cv') {
      // Charge complete: started below midpoint AND ended at cutoff current
      const cutoffA = run.meta.setpoint_cutoff_current_a ?? group?.charge_cutoff_current_a ?? 2;
      return startV < vMid && endI <= cutoffA * 1.1;
    }
    if (mode === 'd-cc' || mode === 'd-cp') {
      // Discharge complete: started above midpoint AND ended at cutoff voltage
      const cutoffV = run.meta.setpoint_cutoff_v ?? vLow;
      return startV > vMid && endV <= cutoffV + 0.05;
    }
    return false;
  }, []);

  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? null;

  const runPassesFilter = useCallback(
    (run: ChartRun) => {
      // Still-running runs always pass
      if (run.meta.ended_at == null) return true;

      const mode = run.meta.mode;
      const isCharge = mode === 'c-cv';
      const isDischarge = mode === 'd-cc' || mode === 'd-cp';
      // Runs that are neither charge nor discharge (e.g. wait) always pass
      if (isCharge && !showCharge) return false;
      if (isDischarge && !showDischarge) return false;

      const complete = isRunComplete(run, selectedGroup);
      if (complete && !showComplete) return false;
      if (!complete && !showPartial) return false;

      // Date range filter
      if (daysPast > 0 && run.meta.ended_at) {
        const runDate = new Date(run.meta.ended_at).getTime();
        const cutoff = Date.now() - daysPast * 24 * 60 * 60 * 1000;
        if (runDate < cutoff) return false;
      }

      // Cell visibility (managed via the Cells modal; -1 = runs with no cell)
      if (hiddenCellIds.has(run.meta.cell_id ?? -1)) return false;

      return true;
    },
    [showCharge, showDischarge, showComplete, showPartial, daysPast, hiddenCellIds, selectedGroup, isRunComplete]
  );

  // When filters or runs change, recompute visible runs
  useEffect(() => {
    setVisibleRuns(new Set(runs.filter(runPassesFilter).map(r => r.id)));
  }, [runs, runPassesFilter]);

  // ── Load historical runs ──────────────────────────────────────

  /** Convert API runs-with-data to ChartRuns */
  const toChartRuns = useCallback((runsWithData: TestRunWithData[]): ChartRun[] => {
    const chartRuns: ChartRun[] = [];
    for (const rwd of runsWithData) {
      if (rwd.d.length === 0) continue;
      const label = rwd.cell_id ? `Cell #${rwd.cell_id}` : `Run #${rwd.id}`;
      chartRuns.push(compactDataToChartRun(rwd, rwd.d, label, rwd.downsampled));
    }
    return chartRuns;
  }, []);

  /** Fetch temperature data for the given runs into a map */
  const fetchTemps = useCallback(async (chartRuns: ChartRun[]): Promise<Map<number, TempDataPoint[]>> => {
    const tempMap = new Map<number, TempDataPoint[]>();
    await Promise.all(
      chartRuns.map(run =>
        api<TempDataPoint[]>(`/api/runs/${run.id}/temperature`)
          .then(data => {
            if (data.length > 0) tempMap.set(run.id, data);
          })
          .catch(() => {})
      )
    );
    return tempMap;
  }, []);

  const loadRuns = useCallback(() => {
    return api<TestRunWithData[]>('/api/runs/recent?limit=100&withData=1')
      .then(async runsWithData => {
        const chartRuns = toChartRuns(runsWithData);
        setRuns(prev => {
          // Keep any per-cell runs loaded on demand that fall outside the
          // recent window (their cells are still checked in the modal)
          const ids = new Set(chartRuns.map(r => r.id));
          const extras = prev.filter(r => !ids.has(r.id));
          return [...chartRuns, ...extras];
        });
        const tempMap = await fetchTemps(chartRuns);
        setTempDataByRun(prev => {
          const merged = new Map(prev);
          for (const [id, points] of tempMap) merged.set(id, points);
          return merged;
        });
      })
      .catch(() => {});
  }, [toChartRuns, fetchTemps]);

  /** Load an out-of-window cell's runs on demand (Cells modal check) */
  const loadRunsForCell = useCallback(
    async (cellId: number) => {
      setLoadingCellId(cellId);
      try {
        const runsWithData = await api<TestRunWithData[]>(`/api/runs/recent?limit=200&withData=1&cellId=${cellId}`);
        const chartRuns = toChartRuns(runsWithData);
        setRuns(prev => {
          const existing = new Set(prev.map(r => r.id));
          const fresh = chartRuns.filter(r => !existing.has(r.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        const tempMap = await fetchTemps(chartRuns);
        setTempDataByRun(prev => {
          const merged = new Map(prev);
          for (const [id, points] of tempMap) merged.set(id, points);
          return merged;
        });
      } catch (err) {
        console.error(`Failed to load runs for cell #${cellId}:`, err);
      } finally {
        setLoadingCellId(null);
      }
    },
    [toChartRuns, fetchTemps]
  );

  /** Toggle a cell's visibility; load its runs when first shown */
  const toggleCellVisibility = useCallback(
    (cellId: number) => {
      // Showing a cell that has no loaded runs → fetch them
      const showing = hiddenCellIds.has(cellId);
      if (showing && cellId >= 0 && !runs.some(r => r.meta.cell_id === cellId)) {
        loadRunsForCell(cellId);
      }
      setHiddenCellIds(prev => {
        const next = new Set(prev);
        if (next.has(cellId)) next.delete(cellId);
        else next.add(cellId);
        return next;
      });
    },
    [hiddenCellIds, runs, loadRunsForCell]
  );

  const handleCellDeleted = useCallback(
    (cellId: number) => {
      setRuns(prev => prev.filter(r => r.meta.cell_id !== cellId));
      loadCells();
    },
    [loadCells]
  );

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

  // ── Stable run → color assignment (chart series + legend agree) ──
  const runColorMap = useMemo(() => buildRunColorMap(runs, colorBy), [runs, colorBy]);

  // ── Loaded run counts per cell (for the Cells modal) ─────────────
  const loadedRunCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const run of runs) {
      const key = run.meta.cell_id ?? -1;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [runs]);

  // ── Merge data for chart (V/I/W/Ah — temps get their own chart) ──
  const chartData = useMemo((): MergedChartData => {
    return mergeRunsForChart(
      runs,
      state.livePoints,
      visibleRuns,
      visibleMetrics,
      isTestActive,
      state.activeRunId,
      runColorMap
    );
  }, [runs, state.livePoints, visibleRuns, visibleMetrics, isTestActive, state.activeRunId, runColorMap]);

  // ── Temperature chart (separate, x-synced below the main chart) ──
  const tempChartData = useMemo((): MergedChartData => {
    if (!visibleMetrics.has('temperature')) return { data: [[]], seriesInfo: [] };
    return buildTempChartData(runs, visibleRuns, tempDataByRun, state.liveTempPoints, state.activeRunId, isTestActive);
  }, [runs, visibleRuns, visibleMetrics, tempDataByRun, state.liveTempPoints, state.activeRunId, isTestActive]);

  const showTempChart = tempChartData.seriesInfo.length > 0 && (tempChartData.data[0]?.length ?? 0) > 0;

  // ── Temp chart collapse — persisted; phones start collapsed since the
  //    TopBar chips already show live temperatures ─────────────────────
  const [tempsCollapsed, setTempsCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem('bc-temp-chart-collapsed');
    if (stored !== null) return stored === '1';
    return window.innerWidth <= 480;
  });
  const toggleTempsCollapsed = useCallback(() => {
    setTempsCollapsed(prev => {
      localStorage.setItem('bc-temp-chart-collapsed', prev ? '0' : '1');
      return !prev;
    });
  }, []);
  const tempChartVisible = showTempChart && !tempsCollapsed;

  // Align the stacked charts' plot areas: pad each side to the wider of the
  // two charts' axis gutters (axis sizes mirror Chart.tsx's axis configs)
  const mainLeftPx = (visibleMetrics.has('voltage') ? 65 : 0) + (visibleMetrics.has('current') ? 55 : 0);
  const mainRightPx = (visibleMetrics.has('power') ? 50 : 0) + (visibleMetrics.has('capacity') ? 55 : 0);
  const tempLeftPx = 55; // °C axis (left side)
  const mainPadLeft = tempChartVisible ? Math.max(0, tempLeftPx - mainLeftPx) : 0;
  const mainPadRight = 0; // temp chart has no right axis
  const tempPadLeft = Math.max(0, mainLeftPx - tempLeftPx);
  const tempPadRight = mainRightPx;

  // ── Capacity chart data ───────────────────────────────────────
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

  const referenceCurves = useMemo(() => getDefaultReferenceCurves(nominalAh), [nominalAh]);

  const capacityChartData = useMemo(
    () => mergeCapacityChart(capacityRuns, referenceCurves, visibleRuns),
    [capacityRuns, referenceCurves, visibleRuns]
  );

  // ── Active cell IR — drives the TopBar live I²R heat readout ────
  const activeCellIrMohm = useMemo(() => {
    const cellId = activeRunMeta?.cell_id;
    if (cellId == null) return null;
    return cells.find(c => c.id === cellId)?.latest_ir_mohm ?? null;
  }, [activeRunMeta, cells]);

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

  // ── Scale ranges: align V and A axes to cell parameters ─────
  const scaleRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {};
    const group = selectedGroup;
    if (group) {
      // Voltage: discharge cutoff → charge voltage
      if (group.discharge_cutoff_v != null && group.charge_voltage_v != null) {
        ranges.V = { min: group.discharge_cutoff_v, max: group.charge_voltage_v };
      }
      // Current: 0 → max setpoint current across all loaded runs
      let maxA = 0;
      for (const r of runs) {
        if (r.meta.setpoint_current_a != null && r.meta.setpoint_current_a > maxA) {
          maxA = r.meta.setpoint_current_a;
        }
      }
      if (maxA > 0) {
        ranges.A = { min: 0, max: maxA };
      }
    }
    return ranges;
  }, [selectedGroup, runs]);

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
  const groupBadge =
    fleetSummary && fleetSummary.avgHealthPct !== null ? `${fleetSummary.avgHealthPct.toFixed(0)}%` : null;

  async function toggleBridge() {
    setBridgeLoading(true);
    try {
      if (state.bridgeActive) await disableBridge();
      else await enableBridge();
    } catch (err) {
      console.error('Bridge toggle failed:', err);
    } finally {
      setBridgeLoading(false);
    }
  }

  return (
    <div className="chart-view" ref={chartViewRef}>
      <CameraView onVisibilityChange={handleCameraVisibility} />

      <div className="chart-view-body">
        <TopBar activeCellIrMohm={activeCellIrMohm} />

        <div className="chart-area">
          {loading ? (
            <div className="chart-loading">Loading runs...</div>
          ) : chartMode === 'time' ? (
            chartData.data[0]?.length ? (
              <div className="chart-stack">
                <div className="chart-stack-main">
                  <Chart
                    data={chartData.data}
                    seriesInfo={chartData.seriesInfo}
                    thresholds={thresholds}
                    scaleRanges={scaleRanges}
                    bands={chartData.bands}
                    syncKey="bc-time"
                    padLeft={mainPadLeft}
                    padRight={mainPadRight}
                  />
                </div>
                {showTempChart && (
                  <>
                    <button type="button" className="chart-temps-toggle" onClick={toggleTempsCollapsed}>
                      <span className={`chart-temps-chevron${tempsCollapsed ? '' : ' open'}`}>{'▸'}</span>
                      Temperatures
                    </button>
                    {tempChartVisible && (
                      <div className="chart-stack-temps">
                        <Chart
                          data={tempChartData.data}
                          seriesInfo={tempChartData.seriesInfo}
                          syncKey="bc-time"
                          padLeft={tempPadLeft}
                          padRight={tempPadRight}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="chart-empty">
                {runs.length === 0
                  ? 'No test runs yet. Start a new test to begin.'
                  : 'No visible series. Open the legend to toggle metrics and runs.'}
              </div>
            )
          ) : capacityChartData.data[0]?.length ? (
            <CapacityChart
              data={capacityChartData.data}
              seriesInfo={capacityChartData.seriesInfo}
              thresholds={thresholds}
            />
          ) : (
            <div className="chart-empty">
              {runs.length === 0
                ? 'No test runs yet. Start a new test to begin.'
                : 'No visible runs. Open the legend to toggle runs.'}
            </div>
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

          <div className="run-filters">
            <button
              className={`filter-chip filter-charge${showCharge ? ' active' : ''}`}
              onClick={() => setShowCharge(v => !v)}
            >
              Charge
            </button>
            <button
              className={`filter-chip filter-discharge${showDischarge ? ' active' : ''}`}
              onClick={() => setShowDischarge(v => !v)}
            >
              Discharge
            </button>
            <span className="filter-sep" />
            <button
              className={`filter-chip filter-complete${showComplete ? ' active' : ''}`}
              onClick={() => setShowComplete(v => !v)}
            >
              Complete
            </button>
            <button
              className={`filter-chip filter-partial${showPartial ? ' active' : ''}`}
              onClick={() => setShowPartial(v => !v)}
            >
              Partial
            </button>
            <span className="filter-sep" />
            <select
              className="filter-select"
              value={daysPast}
              onChange={e => setDaysPast(parseInt(e.target.value, 10))}
            >
              <option value="0">All runs</option>
              <option value="1">Last 24h</option>
              <option value="7">Last 7d</option>
              <option value="30">Last 30d</option>
            </select>
            <button
              className={`filter-chip${hiddenCellIds.size > 0 ? ' active' : ''}`}
              onClick={() => setCellsModalOpen(true)}
            >
              Cells{hiddenCellIds.size > 0 ? ` (${hiddenCellIds.size} hidden)` : '…'}
            </button>
            <select className="filter-select" value={colorBy} onChange={e => setColorBy(e.target.value as ColorBy)}>
              <option value="run">Color: run</option>
              <option value="mode">Color: chg/dis</option>
              <option value="cell">Color: cell</option>
            </select>
          </div>

          {cellGroups.length > 0 && (
            <div className="group-select-wrapper">
              <select
                className="group-select"
                value={selectedGroupId ?? ''}
                onChange={e => setSelectedGroupId(parseInt(e.target.value, 10) || null)}
              >
                {cellGroups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              {groupBadge && (
                <span
                  className="group-health-badge"
                  style={{
                    color:
                      fleetSummary!.avgHealthPct! >= 90
                        ? '#4caf50'
                        : fleetSummary!.avgHealthPct! >= 75
                          ? '#ff9800'
                          : '#f44336',
                  }}
                >
                  {groupBadge}
                </span>
              )}
            </div>
          )}

          <div className="bottom-spacer" />

          {cycleActive && (
            <button className={`btn btn-end-step${endStepArmed ? ' armed' : ''}`} onClick={handleEndStep}>
              {endStepArmed ? 'Really end step?' : 'End Step'}
            </button>
          )}

          {isTestActive || state.stopping || cycleActive ? (
            <button className="btn btn-stop" onClick={stopTest} disabled={state.stopping}>
              {state.stopping ? 'Stopping...' : 'Stop'}
            </button>
          ) : (
            <button className="btn btn-new-run" onClick={() => setStartModalOpen(true)} disabled={state.bridgeActive}>
              New Run
            </button>
          )}

          <a href="/sequences" className="btn btn-link">
            Sequences
          </a>

          <button
            className={`btn ${state.bridgeActive ? 'btn-bridge-active' : 'btn-link'}`}
            onClick={toggleBridge}
            disabled={bridgeLoading || isTestActive}
          >
            {bridgeLoading ? '...' : state.bridgeActive ? 'Proxy On' : 'Serial Proxy'}
          </button>
        </div>

        <LegendPanel
          open={legendOpen}
          onClose={() => setLegendOpen(false)}
          runs={runs}
          runColors={runColorMap}
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

        <CellSelectModal
          open={cellsModalOpen}
          onClose={() => setCellsModalOpen(false)}
          cells={cells}
          loadedRunCounts={loadedRunCounts}
          hiddenCellIds={hiddenCellIds}
          onToggleCell={toggleCellVisibility}
          onLoadCell={loadRunsForCell}
          loadingCellId={loadingCellId}
          onCellDeleted={handleCellDeleted}
        />
      </div>
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
