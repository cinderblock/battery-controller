/**
 * Core hook for device session state.
 *
 * Manages an SSE (EventSource) connection to the server and exposes:
 * - Current device state (mode, reading, stats)
 * - Live data point accumulation for the active test
 * - Connection status
 * - REST API helpers for test control and data queries
 *
 * One instance at the app root via React context.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { estimateIrSamples, type IrPoint, type IrSample } from '../../shared/ir-estimate.ts';
import type {
  CellPresenceState,
  CycleState,
  DecodedReading,
  DeviceInfo,
  DeviceMode,
  PendingCommand,
  TempChannelConfig,
  TempChannelReading,
  TestStats,
} from '../api-client.ts';
import { api, apiPost } from '../api-client.ts';

// ── Live data point (lightweight, for chart) ──────────────────────

export interface LivePoint {
  t: number; // elapsed_s
  v: number; // voltage
  i: number; // current
  p: number; // power
  ah: number; // capacity mAh
  wh: number; // energy mWh
}

/** Accumulated live temperature sample for the active test's chart */
export interface LiveTempPoint {
  channelId: string;
  name: string | null;
  t: number; // elapsed_s at the time the reading arrived
  v: number; // temp_c
}

// ── Live-buffer bounds ─────────────────────────────────────────────
// A multi-hour run at ~2s/reading is tens of thousands of points; temps add
// one sample per channel per packet. Left unbounded, these arrays (and the
// full-array copy + whole-chart re-derive they drive every tick) grow without
// limit and eventually starve the browser. Cap them and decimate the oldest
// half when the cap is hit: recent detail stays at full resolution, older
// history coarsens gracefully. The authoritative full-resolution data is
// persisted server-side (data_points) and reloaded from the API when needed —
// these buffers exist only for the live chart, so decimating them is lossless
// for their purpose. uPlot renders to ~1500px, so the cap is well above what's
// visible.

/** Max live V/I/W/Ah points retained (~2.2h at full 2s resolution, coarser beyond) */
const MAX_LIVE_POINTS = 4000;
/** Max flat live temperature samples across all channels */
const MAX_TEMP_POINTS = 6000;

/**
 * Halve the OLDER half of the buffer, keeping the newest half at full
 * resolution. (A uniform every-other stride would degrade recent points
 * too — after a few halvings the spacing exceeds the IR estimator's 5 s
 * step window and live current steps stop being resolvable.)
 */
function decimateSeries<T>(points: T[]): T[] {
  const mid = Math.floor(points.length / 2);
  const out: T[] = [];
  for (let i = 0; i < mid; i += 2) out.push(points[i]);
  for (let i = mid; i < points.length; i++) out.push(points[i]);
  return out;
}

/**
 * Same idea per temperature channel. The flat buffer interleaves channels
 * (one push per channel per packet), so decimate by each channel's own
 * sample count — every series keeps its recent half intact and thins its
 * older half — and stays time-aligned across channels.
 */
function decimateTempByChannel(points: LiveTempPoint[]): LiveTempPoint[] {
  const totals = new Map<string, number>();
  for (const p of points) totals.set(p.channelId, (totals.get(p.channelId) ?? 0) + 1);

  const seen = new Map<string, number>();
  const out: LiveTempPoint[] = [];
  for (const p of points) {
    const n = seen.get(p.channelId) ?? 0;
    seen.set(p.channelId, n + 1);
    const mid = Math.floor((totals.get(p.channelId) ?? 0) / 2);
    if (n >= mid || n % 2 === 0) out.push(p);
  }
  return out;
}

// ── Session state ─────────────────────────────────────────────────

export interface SessionState {
  wsConnected: boolean;
  serialConnected: boolean;
  deviceResponsive: boolean;
  mode: DeviceMode;
  reading: DecodedReading | null;
  stats: TestStats | null;
  deviceInfo: DeviceInfo | null;
  pendingCommand: PendingCommand | null;
  activeRunId: number | null;
  activeRunMaxTimeMin: number | null;
  locked: boolean;
  bridgeActive: boolean;
  cycleState: CycleState | null;
  /**
   * Server-tracked "is a cell connected that nobody has identified yet".
   * Held server-side so every browser agrees, and so a claim from one browser
   * clears the scan prompt on all of them.
   */
  cellPresence: CellPresenceState | null;
  livePoints: LivePoint[];
  /** Live temperature samples accumulated during the active test */
  liveTempPoints: LiveTempPoint[];
  /**
   * Live DC-IR samples for the active test, computed incrementally as
   * readings arrive (consecutive-pair current steps). Kept separately from
   * livePoints because the point buffer decimates on overflow — after a few
   * halvings the point spacing exceeds the estimator's step window and
   * samples could no longer be recovered from the buffer.
   */
  liveIrSamples: IrSample[];
  stopping: boolean;
  tempChannels: TempChannelConfig[];
  tempReadings: TempChannelReading[];
}

const INITIAL_STATE: SessionState = {
  wsConnected: false,
  serialConnected: false,
  deviceResponsive: false,
  mode: 'idle',
  reading: null,
  stats: null,
  deviceInfo: null,
  pendingCommand: null,
  activeRunId: null,
  activeRunMaxTimeMin: null,
  locked: false,
  bridgeActive: false,
  cycleState: null,
  cellPresence: null,
  livePoints: [],
  liveTempPoints: [],
  liveIrSamples: [],
  stopping: false,
  tempChannels: [],
  tempReadings: [],
};

// ── Context ───────────────────────────────────────────────────────

export interface SessionContextValue {
  state: SessionState;
  startTest: (params: StartTestParams) => Promise<void>;
  stopTest: () => Promise<void>;
  /** End the current cycle step early and advance to the next one */
  endStep: () => Promise<void>;
  continueTest: (params: ContinueTestParams) => Promise<void>;
  scanCell: (barcode: string, label?: string) => Promise<void>;
  /**
   * Tell the server which cell is connected, clearing the scan prompt on every
   * browser. Pass null when starting without a barcode.
   */
  claimCell: (barcode: string | null) => Promise<void>;
  /**
   * Whether *this* browser is the one that claimed the given insertion. Lets
   * the auto-close skip the browser where the user just scanned, which should
   * carry on into the configure step rather than have the wizard vanish.
   */
  didClaimInsertion: (insertionId: number) => boolean;
  enableBridge: () => Promise<void>;
  disableBridge: () => Promise<void>;
}

export interface StartTestParams {
  mode: 'd-cc' | 'd-cp' | 'c-cv';
  /** Amps — or, when useCRate is set, a C multiplier the server resolves against the cell's type */
  currentA?: number;
  useCRate?: boolean;
  voltageV?: number;
  powerW?: number;
  cutoffV?: number;
  cutoffCurrentA?: number;
  maxTimeMin?: number;
  cellId?: number;
  barcode?: string;
}

export interface ContinueTestParams {
  currentA?: number;
  voltageV?: number;
  powerW?: number;
  cutoffV?: number;
  cutoffCurrentA?: number;
  maxTimeMin?: number;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}

// ── Hook implementation ───────────────────────────────────────────

export function useDeviceSessionManager(): SessionContextValue {
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const esRef = useRef<EventSource | null>(null);
  const livePointsRef = useRef<LivePoint[]>([]);
  const liveTempPointsRef = useRef<LiveTempPoint[]>([]);
  // IR accumulation: samples extracted pair-by-pair as readings arrive, at
  // full resolution (see SessionState.liveIrSamples for why not livePoints)
  const liveIrSamplesRef = useRef<IrSample[]>([]);
  const prevIrPointRef = useRef<IrPoint | null>(null);
  const serverBuildIdRef = useRef<string | null>(null);

  // Track whether we were running before the last state change,
  // so we can clear live points when a new test starts
  const prevModeRef = useRef<DeviceMode>('idle');

  const connect = useCallback(() => {
    if (esRef.current?.readyState === EventSource.OPEN) return;
    esRef.current?.close();

    const { protocol, hostname, port } = window.location;
    const url = `${protocol}//${hostname}${port ? ':' + port : ''}/api/events`;
    const es = new EventSource(url);

    es.onopen = () => {
      setState(s => ({ ...s, wsConnected: true }));
    };

    es.onerror = () => {
      setState(s => ({ ...s, wsConnected: false }));
      // EventSource auto-reconnects on network errors, but permanently closes on
      // HTTP errors (e.g. 502 from reverse proxy while service is restarting).
      // Detect CLOSED state and schedule a manual reconnect.
      if (es.readyState === EventSource.CLOSED) {
        esRef.current = null;
        setTimeout(connect, 2000);
      }
    };

    es.addEventListener('snapshot', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }

      // Auto-reload when the server restarts with new code
      const buildId = data.buildId;
      if (buildId && serverBuildIdRef.current && buildId !== serverBuildIdRef.current) {
        console.log('[sse] Server restarted with new build, reloading...');
        window.location.reload();
        return;
      }
      if (buildId) serverBuildIdRef.current = buildId;

      livePointsRef.current = [];
      liveTempPointsRef.current = [];
      liveIrSamplesRef.current = [];
      prevIrPointRef.current = null;
      setState(s => ({
        ...s,
        mode: data.mode,
        reading: data.reading,
        stats: data.stats,
        deviceInfo: data.deviceInfo,
        activeRunId: data.activeRunId,
        activeRunMaxTimeMin: data.activeRunMaxTimeMin ?? null,
        serialConnected: data.serialConnected,
        deviceResponsive: data.deviceResponsive ?? false,
        locked: data.locked,
        bridgeActive: data.bridgeActive ?? false,
        cycleState: data.cycleState ?? null,
        cellPresence: data.cellPresence ?? null,
        livePoints: [],
        liveTempPoints: [],
        liveIrSamples: [],
        tempChannels: data.temperature?.channels ?? [],
        tempReadings: data.temperature?.readings ?? [],
      }));
      prevModeRef.current = data.mode;
    });

    es.addEventListener('reading', e => {
      let r: any;
      try {
        r = JSON.parse(e.data);
      } catch {
        return;
      }

      // Accumulate live data point
      const isRunning = r.mode === 'd-cc' || r.mode === 'd-cp' || r.mode === 'c-cv';
      if (isRunning && !r.isInfoPacket) {
        livePointsRef.current.push({
          t: r.elapsedS,
          v: r.voltage,
          i: r.current,
          p: r.power,
          ah: r.capacityMah,
          wh: r.energyMwh,
        });
        if (livePointsRef.current.length > MAX_LIVE_POINTS) {
          livePointsRef.current = decimateSeries(livePointsRef.current);
        }

        // IR: check this reading against the previous one for a current step
        const irPoint: IrPoint = { elapsed_s: r.elapsedS, voltage_v: r.voltage, current_a: r.current };
        if (prevIrPointRef.current) {
          const sample = estimateIrSamples([prevIrPointRef.current, irPoint], r.mode)[0];
          if (sample) liveIrSamplesRef.current = [...liveIrSamplesRef.current, sample];
        }
        prevIrPointRef.current = irPoint;
      }
      setState(s => ({
        ...s,
        mode: r.mode,
        reading: r,
        livePoints: [...livePointsRef.current],
        liveIrSamples: liveIrSamplesRef.current,
      }));
    });

    es.addEventListener('state', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }

      const wasRunning = isRunningMode(prevModeRef.current);
      const nowRunning = isRunningMode(data.mode);
      // Clear live points when starting a new test
      if (nowRunning && !wasRunning) {
        livePointsRef.current = [];
        liveTempPointsRef.current = [];
        liveIrSamplesRef.current = [];
        prevIrPointRef.current = null;
      }
      prevModeRef.current = data.mode;
      setState(s => ({
        ...s,
        mode: data.mode,
        activeRunId: data.activeRunId,
        livePoints: nowRunning && !wasRunning ? [] : s.livePoints,
        liveTempPoints: nowRunning && !wasRunning ? [] : s.liveTempPoints,
        liveIrSamples: nowRunning && !wasRunning ? [] : s.liveIrSamples,
      }));
    });

    es.addEventListener('connected', () => {
      setState(s => ({ ...s, serialConnected: true }));
    });

    es.addEventListener('disconnected', () => {
      setState(s => ({ ...s, serialConnected: false }));
    });

    es.addEventListener('deviceInfo', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, deviceInfo: data }));
    });

    es.addEventListener('commandPending', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, pendingCommand: data }));
    });

    es.addEventListener('commandConfirmed', () => {
      setState(s => ({ ...s, pendingCommand: null }));
    });

    es.addEventListener('commandTimeout', () => {
      setState(s => ({ ...s, pendingCommand: null }));
    });

    es.addEventListener('lockState', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, locked: data.locked }));
    });

    es.addEventListener('bridgeState', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, bridgeActive: data.active }));
    });

    es.addEventListener('bridgeReading', e => {
      let r: any;
      try {
        r = JSON.parse(e.data);
      } catch {
        return;
      }
      // Update reading from sniffed bridge traffic (don't change mode or accumulate chart points)
      setState(s => ({ ...s, reading: r }));
    });

    es.addEventListener('deviceResponsive', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, deviceResponsive: data.responsive }));
    });

    es.addEventListener('cycleState', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, cycleState: data }));
    });

    es.addEventListener('cellPresence', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      setState(s => ({ ...s, cellPresence: data }));
    });

    es.addEventListener('temperature', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      const readings: TempChannelReading[] = data.readings ?? [];

      // Accumulate temperature history for the active test's chart,
      // timestamped with the device's current elapsed time
      const cur = stateRef.current;
      if (isRunningMode(cur.mode) && cur.reading) {
        const t = cur.reading.elapsedS;
        for (const r of readings) {
          liveTempPointsRef.current.push({ channelId: r.channelId, name: r.name, t, v: r.tempC });
        }
        if (liveTempPointsRef.current.length > MAX_TEMP_POINTS) {
          liveTempPointsRef.current = decimateTempByChannel(liveTempPointsRef.current);
        }
        setState(s => ({ ...s, tempReadings: readings, liveTempPoints: [...liveTempPointsRef.current] }));
        return;
      }

      setState(s => ({ ...s, tempReadings: readings }));
    });

    es.addEventListener('tempChannelDiscovered', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      // Refresh channels from server
      api<TempChannelConfig[]>('/api/temp/channels')
        .then(channels => {
          setState(s => ({ ...s, tempChannels: channels }));
        })
        .catch(() => {});
    });

    es.addEventListener('tempChannelUnplugged', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      api<TempChannelConfig[]>('/api/temp/channels')
        .then(channels => {
          setState(s => ({ ...s, tempChannels: channels }));
        })
        .catch(() => {});
    });

    es.addEventListener('tempChannelReconnected', e => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      api<TempChannelConfig[]>('/api/temp/channels')
        .then(channels => {
          setState(s => ({ ...s, tempChannels: channels }));
        })
        .catch(() => {});
    });

    esRef.current = es;
  }, []);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  // ── REST commands ────────────────────────────────────────────

  const startTest = useCallback(async (params: StartTestParams) => {
    await apiPost('/api/test/start', params);
  }, []);

  const stopTest = useCallback(async () => {
    setState(s => ({ ...s, stopping: true }));
    try {
      // If a cycle sequence is running, abort it (which also stops the device)
      const cycle = stateRef.current.cycleState;
      if (cycle && (cycle.status === 'running' || cycle.status === 'waiting')) {
        await apiPost('/api/cycle/stop', {});
      } else {
        await apiPost('/api/test/stop', {});
      }
    } finally {
      setState(s => ({ ...s, stopping: false }));
    }
  }, []);

  const endStep = useCallback(async () => {
    await apiPost('/api/cycle/end-step', {});
  }, []);

  const continueTest = useCallback(async (params: ContinueTestParams) => {
    await apiPost('/api/test/continue', params);
  }, []);

  const scanCell = useCallback(async (barcode: string, label?: string) => {
    await apiPost('/api/cells/scan', { barcode, label });
  }, []);

  // Insertion this browser claimed, so the auto-close can leave it alone
  const claimedInsertionRef = useRef<number | null>(null);

  const claimCell = useCallback(async (barcode: string | null) => {
    claimedInsertionRef.current = stateRef.current.cellPresence?.insertionId ?? null;
    try {
      await apiPost('/api/cell-presence/claim', { barcode });
    } catch {
      // Best-effort: the prompt clearing everywhere is a convenience, and the
      // run itself will claim the insertion server-side when it starts.
    }
  }, []);

  const didClaimInsertion = useCallback((insertionId: number) => claimedInsertionRef.current === insertionId, []);

  const enableBridge = useCallback(async () => {
    await apiPost('/api/bridge/start', {});
  }, []);

  const disableBridge = useCallback(async () => {
    await apiPost('/api/bridge/stop', {});
  }, []);

  return {
    state,
    startTest,
    stopTest,
    endStep,
    continueTest,
    scanCell,
    claimCell,
    didClaimInsertion,
    enableBridge,
    disableBridge,
  };
}

function isRunningMode(mode: DeviceMode): boolean {
  return mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
}
