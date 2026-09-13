/**
 * ChartView — the app's primary interface.
 *
 * Full-viewport chart showing all historical runs for the selected cell group.
 * When a test is active, the live trace is prominent and old runs desaturate.
 * Bottom bar has New Run / Stop button, cell group selector with fleet stats,
 * and legend toggle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decideCellPrompt } from '../../shared/cell-prompt.ts';
import type { IrSample } from '../../shared/ir-estimate.ts';
import { api, type Cell, type CellGroup, type GroupFleetSummary, type TestRun } from '../api-client.ts';
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

/** Insertion id whose scan prompt the user dismissed in this tab */
const DISMISSED_INSERTION_KEY = 'dismissedCellInsertion';

/** Source repo, linked from the bottom-right corner. Keep in sync with package.json "repository". */
const REPO_URL = 'https://github.com/cinderblock/battery-controller';

// ── Component ──────────────────────────────────────────────────────

export function ChartView() {
  const { state, stopTest, endStep, enableBridge, disableBridge, didClaimInsertion } = useSession();
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

  // ── DC-IR samples per run (server-computed from full-res points) ──
  const [irSamplesByRunStored, setIrSamplesByRunStored] = useState<Map<number, IrSample[]>>(new Map());

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
  const [daysPast, setDaysPast] = useState(2); // Show runs from last N days (0 = all) — small default keeps first load light
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

  // ── Scan prompt for an unidentified cell ──────────────────────
  // The server decides whether a connected cell still needs identifying (see
  // src/server/cell-presence.ts); a client-side voltage-edge detector can't,
  // because every browser sees the same stream and none of them knows whether
  // another already handled it. Consequences of getting the state from the
  // server: a browser opened long after the cell went on still gets prompted,
  // and a scan on any browser clears the prompt on all of them.
  const presence = state.cellPresence;
  /** True when this browser opened the wizard as a prompt, not by user click */
  const [promptOpened, setPromptOpened] = useState(false);
  /** Insertion the user dismissed here; sessionStorage so it survives reloads */
  const [dismissedInsertion, setDismissedInsertion] = useState<number | null>(() => {
    const raw = sessionStorage.getItem(DISMISSED_INSERTION_KEY);
    return raw === null ? null : Number(raw);
  });

  // Rules live in decideCellPrompt() — pure, and covered by cell-prompt.test.ts
  useEffect(() => {
    const action = decideCellPrompt({
      presence,
      modalOpen: startModalOpen,
      promptOpened,
      dismissedInsertion,
      claimedHere: presence ? didClaimInsertion(presence.insertionId) : false,
    });
    if (action === 'open') {
      setStartModalOpen(true);
      setPromptOpened(true);
    } else if (action === 'close') {
      setStartModalOpen(false);
      setPromptOpened(false);
    }
  }, [presence, startModalOpen, promptOpened, dismissedInsertion, didClaimInsertion]);

  const handleStartModalClose = useCallback(() => {
    setStartModalOpen(false);
    setPromptOpened(false);
    // Closing the wizard while the cell is still unidentified has to suppress
    // the prompt, whether the wizard was opened by the prompt or by hand —
    // otherwise the effect above reopens it immediately and the modal appears
    // impossible to close. Keyed by insertion, so the next cell prompts again.
    if (presence?.present && !presence.claimed) {
      setDismissedInsertion(presence.insertionId);
      sessionStorage.setItem(DISMISSED_INSERTION_KEY, String(presence.insertionId));
    }
  }, [presence]);

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

  /**
   * Metadata-only filters (mode, date window, cell visibility) — safe to
   * evaluate on un-hydrated run stubs. The hydration pump uses this: the
   * complete/partial classification needs voltage data, so gating hydration
   * on it would deadlock (stubs classify as partial and never load).
   */
  const runPassesMetaFilter = useCallback(
    (run: ChartRun) => {
      // Still-running runs always pass
      if (run.meta.ended_at == null) return true;

      const mode = run.meta.mode;
      const isCharge = mode === 'c-cv';
      const isDischarge = mode === 'd-cc' || mode === 'd-cp';
      // Runs that are neither charge nor discharge (e.g. wait) always pass
      if (isCharge && !showCharge) return false;
      if (isDischarge && !showDischarge) return false;

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
    [showCharge, showDischarge, daysPast, hiddenCellIds]
  );

  const runPassesFilter = useCallback(
    (run: ChartRun) => {
      if (!runPassesMetaFilter(run)) return false;
      if (run.meta.ended_at == null) return true;

      const complete = isRunComplete(run, selectedGroup);
      if (complete && !showComplete) return false;
      if (!complete && !showPartial) return false;

      return true;
    },
    [runPassesMetaFilter, showComplete, showPartial, selectedGroup, isRunComplete]
  );

  // When filters or runs change, recompute visible runs
  useEffect(() => {
    setVisibleRuns(new Set(runs.filter(runPassesFilter).map(r => r.id)));
  }, [runs, runPassesFilter]);

  // ── Load historical runs (progressively) ─────────────────────
  //
  // Phase 1: run METADATA only (fast, ~60 KB) → the UI renders immediately.
  // Phase 2: a small pool hydrates each filter-visible run with chart data +
  // temperatures + IR samples, newest first (active run first), so traces
  // appear progressively instead of after one multi-megabyte response.
  // Runs outside the filters (older than the day window, hidden cells) are
  // never fetched until a filter change exposes them.

  /** Metadata-only ChartRun stub — hydrated later by loadRunData */
  const metaToStub = useCallback((meta: TestRun): ChartRun => {
    const label = meta.cell_id ? `Cell #${meta.cell_id}` : `Run #${meta.id}`;
    return compactDataToChartRun(meta, [], label);
  }, []);

  /** Run ids whose data has been fetched (or errored — reload retries) */
  const hydratedRunIds = useRef(new Set<number>());
  const hydratingRunIds = useRef(new Set<number>());

  /** Fetch one run's chart data + temps + IR samples and patch state */
  const loadRunData = useCallback(async (run: ChartRun) => {
    try {
      const [data, temps, ir] = await Promise.all([
        api<{ d: number[][]; downsampled?: boolean }>(`/api/runs/${run.id}/data?compact=1`),
        api<TempDataPoint[]>(`/api/runs/${run.id}/temperature`).catch(() => [] as TempDataPoint[]),
        api<IrSample[]>(`/api/runs/${run.id}/ir-samples`).catch(() => [] as IrSample[]),
      ]);
      hydratedRunIds.current.add(run.id);
      const label = run.meta.cell_id ? `Cell #${run.meta.cell_id}` : `Run #${run.id}`;
      setRuns(prev =>
        data.d.length === 0 && run.meta.ended_at != null
          ? prev.filter(r => r.id !== run.id) // ended runs with no points (empty waits) drop out
          : prev.map(r => (r.id === run.id ? compactDataToChartRun(run.meta, data.d, label, data.downsampled) : r))
      );
      if (temps.length > 0) setTempDataByRun(prev => new Map(prev).set(run.id, temps));
      if (ir.length > 0) setIrSamplesByRunStored(prev => new Map(prev).set(run.id, ir));
    } catch (err) {
      hydratedRunIds.current.add(run.id); // don't hammer a failing endpoint
      console.error(`Failed to load data for run #${run.id}:`, err);
    } finally {
      hydratingRunIds.current.delete(run.id);
    }
  }, []);

  // Hydration pump: start fetches for filter-visible runs lacking data.
  // Each completion updates `runs`, re-running this effect for the next batch.
  useEffect(() => {
    const HYDRATE_POOL = 4;
    const pending = runs.filter(
      r => !hydratedRunIds.current.has(r.id) && !hydratingRunIds.current.has(r.id) && runPassesMetaFilter(r)
    );
    if (pending.length === 0) return;
    pending.sort((a, b) => {
      if (a.id === state.activeRunId) return -1;
      if (b.id === state.activeRunId) return 1;
      return b.id - a.id; // newest first
    });
    const slots = HYDRATE_POOL - hydratingRunIds.current.size;
    for (const run of pending.slice(0, Math.max(0, slots))) {
      hydratingRunIds.current.add(run.id);
      void loadRunData(run);
    }
  }, [runs, runPassesMetaFilter, state.activeRunId, loadRunData]);

  const loadRuns = useCallback(() => {
    return api<TestRun[]>('/api/runs/recent?limit=100')
      .then(metas => {
        setRuns(prev => {
          const byId = new Map(prev.map(r => [r.id, r]));
          const ids = new Set(metas.map(m => m.id));
          // Fresh metadata, but keep already-hydrated data arrays
          const next = metas.map(m => {
            const existing = byId.get(m.id);
            // A run hydrated while it was still running has partial data —
            // once it ends, let the pump fetch the finalized series
            if (existing && existing.meta.ended_at == null && m.ended_at != null) {
              hydratedRunIds.current.delete(m.id);
            }
            return existing && hydratedRunIds.current.has(m.id)
              ? { ...existing, meta: m }
              : (existing ?? metaToStub(m));
          });
          // Keep per-cell runs loaded on demand that fall outside the window
          const extras = prev.filter(r => !ids.has(r.id));
          return [...next, ...extras];
        });
      })
      .catch(() => {});
  }, [metaToStub]);

  /** Load an out-of-window cell's run list on demand (Cells modal check);
   *  the hydration pump fetches their data once they pass the filters. */
  const loadRunsForCell = useCallback(
    async (cellId: number) => {
      setLoadingCellId(cellId);
      try {
        const metas = await api<TestRun[]>(`/api/runs/recent?limit=200&cellId=${cellId}`);
        setRuns(prev => {
          const existing = new Set(prev.map(r => r.id));
          const fresh = metas.filter(m => !existing.has(m.id)).map(metaToStub);
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      } catch (err) {
        console.error(`Failed to load runs for cell #${cellId}:`, err);
      } finally {
        setLoadingCellId(null);
      }
    },
    [metaToStub]
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

  // Merge live points into the active run (shared by the IR trace and the
  // capacity chart below)
  const runsWithLive = useMemo(
    () => mergeActiveRunWithLive(runs, state.activeRunId, state.livePoints),
    [runs, state.activeRunId, state.livePoints]
  );

  // ── Running DC-IR estimate per run — plotted on the temp chart's mΩ axis.
  //    Steady runs yield only their start/stop current steps; runs with the
  //    IR probe enabled yield a sample per dip. Historic runs use the
  //    server-computed series (full-resolution points); the active run
  //    appends the incrementally-accumulated live samples on top. ────────
  const irSamplesByRun = useMemo(() => {
    const map = new Map(irSamplesByRunStored);
    if (state.activeRunId != null && state.liveIrSamples.length > 0) {
      const stored = map.get(state.activeRunId) ?? [];
      // Live samples cover from page load onward; stored covers up to the
      // last fetch. Union by timestamp so overlap doesn't double-plot.
      const seen = new Set(stored.map(s => Math.round(s.t)));
      const fresh = state.liveIrSamples.filter(s => !seen.has(Math.round(s.t)));
      map.set(
        state.activeRunId,
        [...stored, ...fresh].sort((a, b) => a.t - b.t)
      );
    }
    return map;
  }, [irSamplesByRunStored, state.activeRunId, state.liveIrSamples]);

  // ── Temperature chart (separate, x-synced below the main chart) ──
  const tempChartData = useMemo((): MergedChartData => {
    if (!visibleMetrics.has('temperature')) return { data: [[]], seriesInfo: [] };
    return buildTempChartData(
      runs,
      visibleRuns,
      tempDataByRun,
      state.liveTempPoints,
      state.activeRunId,
      isTestActive,
      irSamplesByRun
    );
  }, [
    runs,
    visibleRuns,
    visibleMetrics,
    tempDataByRun,
    state.liveTempPoints,
    state.activeRunId,
    isTestActive,
    irSamplesByRun,
  ]);

  const showTempChart = tempChartData.seriesInfo.length > 0 && (tempChartData.data[0]?.length ?? 0) > 0;

  // Shared full-view x-domain for the stacked main+temperature charts. The
  // temperature series usually cover only part of the timeline (only runs with
  // temp data), so without a shared extent the temp chart would autoscale to
  // its own narrow window and — via the x-sync — snap the whole view in on
  // every temp packet. Union both charts' x extents and hand it to both.
  const sharedXExtent = useMemo((): [number, number] | undefined => {
    const mins: number[] = [0];
    const maxs: number[] = [];

    // Anchor the extent on METADATA durations of the visible runs, so the
    // time axis is stable from first paint instead of stretching run by run
    // as hydration fills the data in (runs all share elapsed_s = 0 origin).
    for (const r of runs) {
      if (!visibleRuns.has(r.id)) continue;
      if (r.meta.duration_s != null && r.meta.duration_s > 0) maxs.push(r.meta.duration_s);
    }

    // Union with the actual loaded data extents — covers the live run
    // outgrowing its metadata and any duration/points mismatch.
    for (const xs of [chartData.data[0], tempChartData.data[0]]) {
      if (xs && xs.length > 0) {
        mins.push(xs[0] as number);
        maxs.push(xs[xs.length - 1] as number);
      }
    }
    if (maxs.length === 0) return undefined;
    return [Math.min(...mins), Math.max(...maxs)];
  }, [runs, visibleRuns, chartData, tempChartData]);

  // Chart trace to emphasize, driven by hovering/selecting a timeline step.
  const [highlightedRunId, setHighlightedRunId] = useState<number | null>(null);

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
  const tempHasIr = tempChartData.seriesInfo.some(s => s.metric === 'ir');
  const tempHasTemps = tempChartData.seriesInfo.some(s => s.metric === 'temperature');
  const mainLeftPx = (visibleMetrics.has('voltage') ? 65 : 0) + (visibleMetrics.has('current') ? 55 : 0);
  const mainRightPx = (visibleMetrics.has('power') ? 50 : 0) + (visibleMetrics.has('capacity') ? 55 : 0);
  const tempLeftPx = (tempHasTemps ? 55 : 0) + (tempHasIr ? 55 : 0); // °C + mΩ axes, both left
  const tempRightPx = 0; // temp chart has no right axis
  const mainPadLeft = tempChartVisible ? Math.max(0, tempLeftPx - mainLeftPx) : 0;
  const mainPadRight = tempChartVisible ? Math.max(0, tempRightPx - mainRightPx) : 0;
  const tempPadLeft = Math.max(0, mainLeftPx - tempLeftPx);
  const tempPadRight = Math.max(0, mainRightPx - tempRightPx);

  // ── Capacity chart data ───────────────────────────────────────
  const nominalMah = selectedGroup?.nominal_capacity_mah ?? 200000;
  const nominalAh = nominalMah / 1000;

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
        <TopBar activeCellIrMohm={activeCellIrMohm} onHighlightRun={setHighlightedRunId} />

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
                    xExtent={sharedXExtent}
                    focusRunId={highlightedRunId}
                    padLeft={mainPadLeft}
                    padRight={mainPadRight}
                  />
                </div>
                {showTempChart && (
                  <>
                    <button type="button" className="chart-temps-toggle" onClick={toggleTempsCollapsed}>
                      <span className={`chart-temps-chevron${tempsCollapsed ? '' : ' open'}`}>{'▸'}</span>
                      {tempHasTemps && tempHasIr
                        ? 'Temperatures · IR'
                        : tempHasIr
                          ? 'Internal Resistance'
                          : 'Temperatures'}
                    </button>
                    {tempChartVisible && (
                      <div className="chart-stack-temps">
                        <Chart
                          data={tempChartData.data}
                          seriesInfo={tempChartData.seriesInfo}
                          syncKey="bc-time"
                          xExtent={sharedXExtent}
                          focusRunId={highlightedRunId}
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

          <a href="/health" className="btn btn-link">
            Health
          </a>

          <a href="/sequences" className="btn btn-link">
            Sequences
          </a>

          <a href="/cell-types" className="btn btn-link">
            Cell Types
          </a>

          <button
            className={`btn ${state.bridgeActive ? 'btn-bridge-active' : 'btn-link'}`}
            onClick={toggleBridge}
            disabled={bridgeLoading || isTestActive}
          >
            {bridgeLoading ? '...' : state.bridgeActive ? 'Proxy On' : 'Serial Proxy'}
          </button>

          <a href={REPO_URL} className="github-link" target="_blank" rel="noopener noreferrer">
            <span className="github-link-label">Source on GitHub</span>
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          </a>
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
          onClose={handleStartModalClose}
          cellGroups={cellGroups}
          newCellPrompt={promptOpened}
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
