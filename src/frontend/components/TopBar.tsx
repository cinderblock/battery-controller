/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot, device state badge, condensed live readings,
 * and a bridge mode toggle for proxying the serial port to EB Tester.
 */

import { useState, useEffect } from 'react';
import { useSession } from '../hooks/useDeviceSession.ts';
import type { DeviceMode } from '../api-client.ts';

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MODE_LABELS: Record<DeviceMode, string> = {
  'idle': 'Idle',
  'd-cc': 'Discharge CC',
  'd-cp': 'Discharge CP',
  'c-cv': 'Charge CV',
  'complete': 'Complete',
  'fault': 'Fault',
};

const MODE_CLASSES: Record<DeviceMode, string> = {
  'idle': 'badge-idle',
  'd-cc': 'badge-discharge',
  'd-cp': 'badge-discharge',
  'c-cv': 'badge-charge',
  'complete': 'badge-complete',
  'fault': 'badge-fault',
};

export function TopBar() {
  const { state, enableBridge, disableBridge } = useSession();
  const { wsConnected, serialConnected, deviceResponsive, mode, reading, pendingCommand, bridgeActive, cycleState } = state;
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [waitRemaining, setWaitRemaining] = useState<number | null>(null);

  const isRunning = mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
  const cycleActive = cycleState && (cycleState.status === 'running' || cycleState.status === 'waiting');

  // Tick the wait countdown every second
  useEffect(() => {
    if (!cycleState?.waitEndTime) { setWaitRemaining(null); return; }
    const tick = () => setWaitRemaining(cycleState.waitEndTime! - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cycleState?.waitEndTime]);

  // Three-state connection: green = all good, amber = backend ok but hardware silent, red = backend down
  const connClass = !wsConnected ? 'conn-off'
    : !serialConnected && !bridgeActive ? 'conn-off'
    : !deviceResponsive && !bridgeActive ? 'conn-warn'
    : 'conn-ok';

  async function toggleBridge() {
    setBridgeLoading(true);
    try {
      if (bridgeActive) {
        await disableBridge();
      } else {
        await enableBridge();
      }
    } catch (err) {
      console.error('Bridge toggle failed:', err);
    } finally {
      setBridgeLoading(false);
    }
  }

  return (
    <>
      <header className="top-bar">
        <div className="top-bar-left">
          <span className={`conn-dot ${connClass}`} />
          {bridgeActive ? (
            <span className="mode-badge badge-bridge">Bridge Mode</span>
          ) : (
            <span className={`mode-badge ${MODE_CLASSES[mode]}`}>
              {pendingCommand ? `${pendingCommand.command}...` : MODE_LABELS[mode]}
            </span>
          )}
        </div>

        {!bridgeActive && reading && (
          <div className="top-bar-readings">
            <span className="reading-val">
              <span className="reading-num">{reading.voltage.toFixed(3)}</span>
              <span className="reading-unit">V</span>
            </span>
            <span className="reading-val">
              <span className="reading-num">{reading.current.toFixed(2)}</span>
              <span className="reading-unit">A</span>
            </span>
            <span className="reading-val">
              <span className="reading-num">{(reading.voltage * reading.current).toFixed(1)}</span>
              <span className="reading-unit">W</span>
            </span>
            {mode !== 'idle' && (
              <span className="reading-val">
                <span className="reading-num">{reading.capacityAh.toFixed(3)}</span>
                <span className="reading-unit">Ah</span>
              </span>
            )}
          </div>
        )}

        <button
          className={`bridge-toggle ${bridgeActive ? 'bridge-active' : ''}`}
          onClick={toggleBridge}
          disabled={bridgeLoading || isRunning}
          title={
            isRunning ? 'Cannot enable bridge while a test is running'
              : bridgeActive ? 'Disable bridge mode — return serial to this app'
              : 'Enable bridge mode — proxy serial to EB Tester via TCP'
          }
        >
          {bridgeLoading ? '...' : bridgeActive ? 'EB' : 'EB'}
        </button>
      </header>

      {bridgeActive && (
        <div className="disconnect-banner disconnect-bridge">
          Bridge mode — serial port proxied to EB Tester (TCP {49600})
        </div>
      )}
      {!wsConnected && (
        <div className="disconnect-banner">
          Server disconnected — reconnecting...
        </div>
      )}
      {wsConnected && !serialConnected && !bridgeActive && (
        <div className="disconnect-banner disconnect-serial">
          Serial port disconnected — device not responding
        </div>
      )}
      {wsConnected && serialConnected && !deviceResponsive && !bridgeActive && (
        <div className="disconnect-banner disconnect-hardware">
          Server connected — hardware not responding
        </div>
      )}
      {cycleActive && cycleState && (
        <div className={`cycle-banner ${cycleState.status === 'waiting' ? 'cycle-waiting' : 'cycle-running'}`}>
          <span className="cycle-name">{cycleState.programName ?? 'Sequence'}</span>
          {cycleState.status === 'waiting' && waitRemaining !== null && (
            <span className="cycle-wait-countdown">
              Wait {formatCountdown(waitRemaining)}
            </span>
          )}
          <span className="cycle-progress">
            Step {cycleState.currentExecIndex + 1}/{cycleState.totalExecSteps}
            {cycleState.totalCycles > 1 && ` \u00b7 Cycle ${cycleState.currentCycle}/${cycleState.totalCycles}`}
          </span>
        </div>
      )}
    </>
  );
}
