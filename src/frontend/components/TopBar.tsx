/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot (pulses on each packet, dims when stale),
 * device state badge, condensed live readings with run timer,
 * and a bridge mode toggle for proxying the serial port to EB Tester.
 */

import { useState, useEffect, useRef } from 'react';
import { useSession } from '../hooks/useDeviceSession.ts';
import type { DeviceMode } from '../api-client.ts';

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMinutes(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${min}m`;
}

const MODE_LABELS: Record<DeviceMode, string> = {
  'idle': 'Idle',
  'd-cc': 'Discharge CC',
  'd-cp': 'Discharge CP',
  'c-cv': 'Charge CV',
  'complete': 'Complete',
  'fault': 'Fault',
};

const STEP_TIMELINE_CLASSES: Record<string, string> = {
  'c-cv': 'step-charge',
  'd-cc': 'step-discharge',
  'd-cp': 'step-discharge',
  'wait': 'step-wait',
};

const STEP_TIMELINE_LABELS: Record<string, string> = {
  'c-cv': 'Charge',
  'd-cc': 'Discharge CC',
  'd-cp': 'Discharge CP',
  'wait': 'Wait',
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
  const { wsConnected, serialConnected, deviceResponsive, mode, reading, pendingCommand, bridgeActive, cycleState, activeRunMaxTimeMin } = state;
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [waitRemaining, setWaitRemaining] = useState<number | null>(null);

  const isRunning = mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
  const cycleActive = cycleState && (cycleState.status === 'running' || cycleState.status === 'waiting');

  // ── Packet freshness tracking ──────────────────────────────────
  const lastReadingTimeRef = useRef(Date.now());
  const [readingStale, setReadingStale] = useState(false);
  const [readingFlash, setReadingFlash] = useState(false);

  // Flash briefly on each new reading
  useEffect(() => {
    if (!reading) return;
    lastReadingTimeRef.current = Date.now();
    setReadingStale(false);
    setReadingFlash(true);
    const id = setTimeout(() => setReadingFlash(false), 200);
    return () => clearTimeout(id);
  }, [reading]);

  // Detect stale data (no packet for >4s)
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastReadingTimeRef.current > 4000) {
        setReadingStale(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Tick the wait countdown every second
  useEffect(() => {
    if (!cycleState?.waitEndTime) { setWaitRemaining(null); return; }
    const tick = () => setWaitRemaining(cycleState.waitEndTime! - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cycleState?.waitEndTime]);

  // Connection dot class: off → warn (stale) → ok, plus flash on packet
  const connClass = !wsConnected ? 'conn-off'
    : !serialConnected && !bridgeActive ? 'conn-off'
    : readingStale || (!deviceResponsive && !bridgeActive) ? 'conn-warn'
    : 'conn-ok';
  const flashClass = readingFlash && connClass === 'conn-ok' ? ' conn-flash' : '';

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
    <div className="top-bar-wrapper">
      <header className="top-bar">
        <div className="top-bar-left">
          <span className={`conn-dot ${connClass}${flashClass}`} />
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
            <span className="reading-val rv-voltage">
              <span className="reading-num">{reading.voltage.toFixed(3)}</span>
              <span className="reading-unit">V</span>
            </span>
            <span className="reading-val rv-current">
              <span className="reading-num">{reading.current.toFixed(2)}</span>
              <span className="reading-unit">A</span>
            </span>
            <span className="reading-val rv-power">
              <span className="reading-num">{(reading.voltage * reading.current).toFixed(1)}</span>
              <span className="reading-unit">W</span>
            </span>
            <span className="reading-val rv-capacity">
              <span className="reading-num">{reading.capacityAh.toFixed(1)}</span>
              <span className="reading-unit">Ah</span>
            </span>
            <span className="reading-val rv-energy">
              <span className="reading-num">{reading.energyWh.toFixed(1)}</span>
              <span className="reading-unit">Wh</span>
            </span>
            <span className="reading-val rv-time">
              <span className="reading-num">{formatElapsed(reading.elapsedS)}</span>
              {isRunning && activeRunMaxTimeMin != null && activeRunMaxTimeMin > 0 && (
                <span className="reading-unit">/ {formatMinutes(activeRunMaxTimeMin)}</span>
              )}
            </span>
            {reading.setpointEcho != null && (
              <span className="reading-val rv-raw">
                <span className="reading-num">{reading.setpointEcho.toFixed(2)}</span>
                <span className="reading-unit">set</span>
              </span>
            )}
            {reading.cutoffEcho != null && (
              <span className="reading-val rv-raw">
                <span className="reading-num">{reading.cutoffEcho.toFixed(2)}</span>
                <span className="reading-unit">cut</span>
              </span>
            )}
            {reading.maxTimeEcho != null && (
              <span className="reading-val rv-raw">
                <span className="reading-num">{reading.maxTimeEcho}</span>
                <span className="reading-unit">tMax</span>
              </span>
            )}
            {reading.stepByte != null && (
              <span className="reading-val rv-raw">
                <span className="reading-num">{reading.stepByte}</span>
                <span className="reading-unit">step</span>
              </span>
            )}
            {reading.rawField7 != null && (
              <span className={`reading-val rv-raw${reading.rawField7 !== 0 ? ' rv-highlight' : ''}`}>
                <span className="reading-num">0x{reading.rawField7.toString(16).toUpperCase().padStart(4, '0')}</span>
                <span className="reading-unit">b8-9</span>
              </span>
            )}
          </div>
        )}

        {/* Cycle info — inline in the header */}
        {cycleActive && cycleState && (
          <div className="top-bar-cycle">
            <span className="cycle-name">{cycleState.programName ?? 'Sequence'}</span>
            {cycleState.status === 'waiting' && waitRemaining !== null && (
              <span className="cycle-wait-countdown">
                Wait {formatCountdown(waitRemaining)}
              </span>
            )}
            <span className="cycle-progress">
              {cycleState.currentExecIndex + 1}/{cycleState.totalExecSteps}
              {cycleState.totalCycles > 1 && ` · Cycle ${cycleState.currentCycle}/${cycleState.totalCycles}`}
            </span>
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
      {cycleActive && cycleState && cycleState.execStepTypes.length > 0 && (() => {
        // Compute progress % for the active step
        const activeIdx = cycleState.currentExecIndex;
        const expectedS = cycleState.stepExpectedS?.[activeIdx] ?? 0;
        let activeProgressPct = 0;
        if (activeIdx < cycleState.totalExecSteps) {
          if (cycleState.status === 'waiting' && waitRemaining !== null && expectedS > 0) {
            // Wait step: use ticking waitRemaining state
            activeProgressPct = Math.min(100, Math.max(0, (1 - waitRemaining / (expectedS * 1000)) * 100));
          } else if (reading && expectedS > 0) {
            // Active test step: use device elapsed (updates on every reading)
            activeProgressPct = Math.min(100, (reading.elapsedS / expectedS) * 100);
          }
        }

        return (
          <div className="cycle-timeline-bar">
            {cycleState.execStepTypes.map((stepType, i) => {
              const capMah = cycleState.stepCapacities?.[i];
              const durS = cycleState.stepDurations?.[i];
              const flexWeight = cycleState.stepExpectedS?.[i] ?? 1;

              // Build label parts
              const parts: string[] = [];
              if (capMah != null) parts.push(`${(capMah / 1000).toFixed(1)}Ah`);
              if (durS != null) parts.push(formatElapsed(durS));
              const label = parts.join(' · ');

              const isDone = i < activeIdx;
              const isActive = i === activeIdx;
              const fillPct = isDone ? 100 : isActive ? activeProgressPct : 0;

              return (
                <div
                  key={i}
                  className={`cycle-timeline-step ${STEP_TIMELINE_CLASSES[stepType] ?? 'step-unknown'}${isDone ? ' step-done' : ''}${isActive ? ' step-active' : ''}`}
                  style={{ flex: flexWeight }}
                  title={`Step ${i + 1}: ${STEP_TIMELINE_LABELS[stepType] ?? stepType}${label ? ` — ${label}` : ''}`}
                >
                  <div className="step-fill" style={{ width: `${fillPct}%` }} />
                  {label && <span className="step-capacity-label">{label}</span>}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
