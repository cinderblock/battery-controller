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
import type {
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
  livePoints: LivePoint[];
  /** Live temperature samples accumulated during the active test */
  liveTempPoints: LiveTempPoint[];
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
  livePoints: [],
  liveTempPoints: [],
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
  enableBridge: () => Promise<void>;
  disableBridge: () => Promise<void>;
}

export interface StartTestParams {
  mode: 'd-cc' | 'd-cp' | 'c-cv';
  currentA?: number;
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
        livePoints: [],
        liveTempPoints: [],
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
      }
      setState(s => ({
        ...s,
        mode: r.mode,
        reading: r,
        livePoints: [...livePointsRef.current],
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
      }
      prevModeRef.current = data.mode;
      setState(s => ({
        ...s,
        mode: data.mode,
        activeRunId: data.activeRunId,
        livePoints: nowRunning && !wasRunning ? [] : s.livePoints,
        liveTempPoints: nowRunning && !wasRunning ? [] : s.liveTempPoints,
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
    enableBridge,
    disableBridge,
  };
}

function isRunningMode(mode: DeviceMode): boolean {
  return mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
}
