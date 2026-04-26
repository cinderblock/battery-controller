/**
 * Core hook for device session state.
 *
 * Manages a native WebSocket to the server and exposes:
 * - Current device state (mode, reading, stats)
 * - Live data point accumulation for the active test
 * - Connection status
 * - REST API helpers for test control and data queries
 *
 * One instance at the app root via React context.
 */

import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import type {
  DecodedReading,
  DeviceInfo,
  DeviceMode,
  PendingCommand,
  TestStats,
  WsMessage,
} from '../api-client.ts';
import { api, apiPost } from '../api-client.ts';

// ── Live data point (lightweight, for chart) ──────────────────────

export interface LivePoint {
  t: number;    // elapsed_s
  v: number;    // voltage
  i: number;    // current
  p: number;    // power
  ah: number;   // capacity mAh
  wh: number;   // energy mWh
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
  locked: boolean;
  bridgeActive: boolean;
  livePoints: LivePoint[];
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
  locked: false,
  bridgeActive: false,
  livePoints: [],
};

// ── Context ───────────────────────────────────────────────────────

export interface SessionContextValue {
  state: SessionState;
  startTest: (params: StartTestParams) => Promise<void>;
  stopTest: () => Promise<void>;
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  const livePointsRef = useRef<LivePoint[]>([]);

  // Track whether we were running before the last state change,
  // so we can clear live points when a new test starts
  const prevModeRef = useRef<DeviceMode>('idle');

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const { protocol, hostname, port } = window.location;
    const wsUrl = `${protocol.replace(/^http/, 'ws')}//${hostname}${port ? ':' + port : ''}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectDelay.current = 1000;
      setState(s => ({ ...s, wsConnected: true }));
    };

    ws.onclose = () => {
      setState(s => ({ ...s, wsConnected: false }));
      wsRef.current = null;
      // Auto-reconnect with capped exponential backoff
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 1.5, 10_000);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };

    ws.onmessage = (event) => {
      let msg: WsMessage;
      try { msg = JSON.parse(event.data); }
      catch { return; }

      switch (msg.type) {
        case 'snapshot':
          livePointsRef.current = [];
          setState(s => ({
            ...s,
            mode: msg.data.mode,
            reading: msg.data.reading,
            stats: msg.data.stats,
            deviceInfo: msg.data.deviceInfo,
            activeRunId: msg.data.activeRunId,
            serialConnected: msg.data.serialConnected,
            deviceResponsive: msg.data.deviceResponsive ?? false,
            locked: msg.data.locked,
            bridgeActive: msg.data.bridgeActive ?? false,
            livePoints: [],
          }));
          prevModeRef.current = msg.data.mode;
          break;

        case 'reading': {
          const r = msg.data;
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
          break;
        }

        case 'state': {
          const wasRunning = isRunningMode(prevModeRef.current);
          const nowRunning = isRunningMode(msg.data.mode);
          // Clear live points when starting a new test
          if (nowRunning && !wasRunning) {
            livePointsRef.current = [];
          }
          prevModeRef.current = msg.data.mode;
          setState(s => ({
            ...s,
            mode: msg.data.mode,
            activeRunId: msg.data.activeRunId,
            livePoints: nowRunning && !wasRunning ? [] : s.livePoints,
          }));
          break;
        }

        case 'connected':
          setState(s => ({ ...s, serialConnected: true }));
          break;

        case 'disconnected':
          setState(s => ({ ...s, serialConnected: false }));
          break;

        case 'deviceInfo':
          setState(s => ({ ...s, deviceInfo: msg.data }));
          break;

        case 'commandPending':
          setState(s => ({ ...s, pendingCommand: msg.data }));
          break;

        case 'commandConfirmed':
          setState(s => ({ ...s, pendingCommand: null }));
          break;

        case 'commandTimeout':
          setState(s => ({ ...s, pendingCommand: null }));
          break;

        case 'lockState':
          setState(s => ({ ...s, locked: msg.data.locked }));
          break;

        case 'bridgeState':
          setState(s => ({ ...s, bridgeActive: msg.data.active }));
          break;

        case 'deviceResponsive':
          setState(s => ({ ...s, deviceResponsive: msg.data.responsive }));
          break;
      }
    };

    wsRef.current = ws;
  }, []);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── REST commands ────────────────────────────────────────────

  const startTest = useCallback(async (params: StartTestParams) => {
    await apiPost('/api/test/start', params);
  }, []);

  const stopTest = useCallback(async () => {
    await apiPost('/api/test/stop', {});
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
    continueTest,
    scanCell,
    enableBridge,
    disableBridge,
  };
}

function isRunningMode(mode: DeviceMode): boolean {
  return mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
}
