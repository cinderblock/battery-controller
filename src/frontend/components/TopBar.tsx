/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot (pulses on each packet, dims when stale),
 * device state badge, condensed live readings with run timer,
 * and cycle timeline progress bar.
 */

import { useEffect, useRef, useReducer, useState } from 'react';
import { useSession } from '../hooks/useDeviceSession.ts';
import type { DeviceMode } from '../api-client.ts';

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${totalMin}m`;
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

function formatDurationCompact(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
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
  const { state } = useSession();
  const { wsConnected, serialConnected, deviceResponsive, mode, reading, pendingCommand, bridgeActive, cycleState, activeRunMaxTimeMin } = state;
  const [, forceTick] = useReducer((x: number) => x + 1, 0);

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

  // Force a re-render every second while a cycle step is active (wait or running).
  // Wait steps need this for the countdown; running steps need it so the
  // progress bar can interpolate elapsed time between device readings.
  useEffect(() => {
    if (!cycleActive) return;
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, [cycleActive]);

  // Derive remaining time at render time — always fresh from Date.now()
  const waitRemaining = cycleState?.waitEndTime ? cycleState.waitEndTime - Date.now() : null;

  // Connection dot class: off → warn (stale) → ok, plus flash on packet
  const connClass = !wsConnected ? 'conn-off'
    : !serialConnected && !bridgeActive ? 'conn-off'
    : readingStale || (!deviceResponsive && !bridgeActive) ? 'conn-warn'
    : 'conn-ok';
  const flashClass = readingFlash && connClass === 'conn-ok' ? ' conn-flash' : '';

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

        {reading && (
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
            {reading.rawField7 != null && (
              <span className={`reading-val rv-raw${reading.rawField7 !== 0 ? ' rv-highlight' : ''}`}>
                <span className="reading-num">0x{reading.rawField7.toString(16).toUpperCase().padStart(4, '0')}</span>
                <span className="reading-unit">b8-9</span>
              </span>
            )}
          </div>
        )}

        {/* Live temperature readings */}
        {state.tempReadings.length > 0 && (
          <div className="temp-live-readings">
            {state.tempReadings.map(r => (
              <span
                key={r.channelId}
                className={`temp-live-chip${r.alertMaxC != null && r.tempC > r.alertMaxC ? ' alert' : ''}`}
              >
                <span className="temp-label">{r.name ?? r.channelId.slice(-6)}</span>
                <span className="temp-value">{r.tempC.toFixed(1)}°</span>
              </span>
            ))}
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

      </header>

      {/* Status banner or timeline bar — always exactly one row */}
      {bridgeActive ? (
        <div className="cycle-timeline-bar banner-in-timeline disconnect-bridge">
          Bridge mode — sniffing serial traffic
        </div>
      ) : !wsConnected ? (
        <div className="cycle-timeline-bar banner-in-timeline">
          Server disconnected — reconnecting...
        </div>
      ) : !serialConnected ? (
        <div className="cycle-timeline-bar banner-in-timeline disconnect-serial">
          Serial port disconnected — device not responding
        </div>
      ) : !deviceResponsive && !bridgeActive ? (
        <div className="cycle-timeline-bar banner-in-timeline disconnect-hardware">
          Server connected — hardware not responding
        </div>
      ) : !(cycleActive && cycleState && cycleState.execStepTypes.length > 0) ? (
        <div className="cycle-timeline-bar" />
      ) : null}
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
            // Active test step: interpolate elapsed from last reading + local clock
            // so the bar advances smoothly between ~1s device packets
            const interpolatedS = reading.elapsedS + (Date.now() - lastReadingTimeRef.current) / 1000;
            activeProgressPct = Math.min(100, (interpolatedS / expectedS) * 100);
          }
        }

        return (
          <div className="cycle-timeline-bar">
            {cycleState.execStepTypes.map((stepType, i) => {
              const capMah = cycleState.stepCapacities?.[i];
              const durS = cycleState.stepDurations?.[i];
              const flexWeight = cycleState.stepExpectedS?.[i] ?? 1;

              const isDone = i < activeIdx;
              const isActive = i === activeIdx;
              const isFuture = i > activeIdx;
              const fillPct = isDone ? 100 : isActive ? activeProgressPct : 0;

              const expectedS = cycleState.stepExpectedS?.[i] ?? 0;
              const expectedLabel = expectedS > 0 ? formatDurationCompact(expectedS) : '';

              // Build label per step state:
              // - Done: final capacity + duration / expected
              // - Active: live capacity + elapsed / expected
              // - Future: expected duration + step parameters
              // - Wait (future/done): just the duration
              let label = '';
              if (isFuture) {
                if (stepType === 'wait') {
                  label = expectedLabel;
                } else {
                  const paramLabel = cycleState.stepLabels?.[i] ?? '';
                  label = [expectedLabel, paramLabel].filter(Boolean).join(' · ');
                }
              } else if (isActive && stepType === 'wait' && waitRemaining !== null) {
                label = formatCountdown(waitRemaining);
              } else if (isActive && reading && stepType !== 'wait') {
                const parts: string[] = [];
                parts.push(`${reading.capacityAh.toFixed(1)}Ah`);
                const elapsed = formatElapsed(reading.elapsedS);
                parts.push(expectedLabel ? `${elapsed}/${expectedLabel}` : elapsed);
                label = parts.join(' · ');
              } else {
                const parts: string[] = [];
                if (capMah != null) parts.push(`${(capMah / 1000).toFixed(1)}Ah`);
                if (stepType === 'wait') {
                  // Use expected duration for done waits — actual duration rounds
                  // down (e.g. 29m55s → "29m") which looks wrong next to "30m"
                  label = expectedLabel || (durS != null ? formatDurationCompact(durS) : '');
                  if (parts.length) label = `${parts.join(' · ')} · ${label}`;
                } else if (durS != null) {
                  const dur = formatDurationCompact(durS);
                  label = expectedLabel ? `${dur}/${expectedLabel}` : dur;
                  if (parts.length) label = `${parts.join(' · ')} · ${label}`;
                } else {
                  label = parts.join(' · ');
                }
              }

              return (
                <div
                  key={i}
                  className={`cycle-timeline-step ${STEP_TIMELINE_CLASSES[stepType] ?? 'step-unknown'}${isDone ? ' step-done' : ''}${isActive ? ' step-active' : ''}${isFuture ? ' step-future' : ''}`}
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
