/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot (pulses on each packet, dims when stale),
 * device state badge, condensed live readings with run timer,
 * and cycle timeline progress bar.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeviceMode, StepDetail } from '../api-client.ts';
import { useSession } from '../hooks/useDeviceSession.ts';

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
  idle: 'Idle',
  'd-cc': 'Discharge CC',
  'd-cp': 'Discharge CP',
  'c-cv': 'Charge CV',
  complete: 'Complete',
  fault: 'Fault',
};

const STEP_TIMELINE_CLASSES: Record<string, string> = {
  'c-cv': 'step-charge',
  'd-cc': 'step-discharge',
  'd-cp': 'step-discharge',
  wait: 'step-wait',
};

const MODE_CLASSES: Record<DeviceMode, string> = {
  idle: 'badge-idle',
  'd-cc': 'badge-discharge',
  'd-cp': 'badge-discharge',
  'c-cv': 'badge-charge',
  complete: 'badge-complete',
  fault: 'badge-fault',
};

const STEP_TYPE_TITLES: Record<string, string> = {
  'c-cv': 'Charge (CC-CV)',
  'd-cc': 'Discharge (CC)',
  'd-cp': 'Discharge (CP)',
  wait: 'Wait',
};

const END_REASON_LABELS: Record<string, string> = {
  complete: 'Reached cutoff',
  time_limit: 'Timed out — hit max time',
  manual_stop: 'Stopped manually',
  step_ended_early: 'Ended early',
  temp_alert: 'Temperature limit',
  fault: 'Fault',
  service_restart: 'Interrupted (service restart)',
  service_shutdown: 'Interrupted (shutdown)',
};

// ── Completed-step detail popover ──────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="step-detail-row">
      <span className="step-detail-key">{label}</span>
      <span className="step-detail-val">{value}</span>
    </div>
  );
}

/** Body of the detail popover for a completed test step. */
function StepDetailBody({
  detail,
  durS,
  expectedS,
  capMah,
  stepType,
  timedOut,
}: {
  detail: StepDetail | null;
  durS: number | null;
  expectedS: number;
  capMah: number | null;
  stepType: string;
  timedOut: boolean;
}) {
  const rows: { k: string; v: string }[] = [];

  if (durS != null) {
    const exp = expectedS > 0 ? ` / ${formatDurationCompact(expectedS)}` : '';
    rows.push({ k: 'Time', v: `${formatElapsed(durS)}${exp}` });
  }
  if (capMah != null) rows.push({ k: 'Capacity', v: `${(capMah / 1000).toFixed(2)} Ah` });
  if (detail?.energyWh != null) rows.push({ k: 'Energy', v: `${detail.energyWh.toFixed(1)} Wh` });

  if (detail?.avgCurrentA != null || detail?.peakCurrentA != null) {
    const avg = detail?.avgCurrentA != null ? `${detail.avgCurrentA.toFixed(2)} A avg` : '';
    const peak = detail?.peakCurrentA != null ? `${detail.peakCurrentA.toFixed(2)} A peak` : '';
    rows.push({ k: 'Current', v: [avg, peak].filter(Boolean).join(' · ') });
  }
  if (detail?.minVoltageV != null && detail?.peakVoltageV != null) {
    rows.push({ k: 'Voltage', v: `${detail.minVoltageV.toFixed(3)}–${detail.peakVoltageV.toFixed(3)} V` });
  }
  if (detail?.irMohm != null) {
    rows.push({
      k: 'IR',
      v: detail.irMohm < 10 ? `${detail.irMohm.toFixed(1)} mΩ` : `${Math.round(detail.irMohm)} mΩ`,
    });
  }
  if (detail?.heatWh != null) {
    const pct =
      detail.energyWh && detail.energyWh > 0 ? ` · ${Math.round((detail.heatWh / detail.energyWh) * 100)}%` : '';
    rows.push({ k: 'Heat', v: `${detail.heatWh.toFixed(2)} Wh${pct}` });
  }

  const endLabel = detail?.endReason ? (END_REASON_LABELS[detail.endReason] ?? detail.endReason) : null;

  return (
    <>
      <div className="step-detail-title">{STEP_TYPE_TITLES[stepType] ?? stepType}</div>
      {rows.map(r => (
        <DetailRow key={r.k} label={r.k} value={r.v} />
      ))}
      {endLabel && <div className={`step-detail-end${timedOut ? ' is-timeout' : ''}`}>{endLabel}</div>}
    </>
  );
}

interface TimelineStepProps {
  stepType: string;
  className: string;
  flexWeight: number;
  fillPct: number;
  label: string;
  detail: StepDetail | null;
  durS: number | null;
  expectedS: number;
  capMah: number | null;
  /** Show the metric breakdown (true for completed test steps) */
  showDetail: boolean;
  /** This step ended on its max-time limit */
  timedOut: boolean;
  /** A preceding test step timed out, so this step's result is less reliable */
  suspect: boolean;
  /** test_runs.id of this step's run, for cross-highlighting the chart trace */
  runId: number | null;
  /** Emphasize (runId) or clear (null) the matching chart trace */
  onHighlight: (runId: number | null) => void;
}

/**
 * One segment of the cycle timeline. Completed test steps (and steps made
 * suspect by an earlier timeout) expose a tap/hover detail popover. The popover
 * is portalled to <body> because the 20px-tall bar clips its own overflow.
 */
function TimelineStep({
  stepType,
  className,
  flexWeight,
  fillPct,
  label,
  detail,
  durS,
  expectedS,
  capMah,
  showDetail,
  timedOut,
  suspect,
  runId,
  onHighlight,
}: TimelineStepProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);
  const canPop = showDetail || suspect;
  const canInteract = canPop || runId != null;

  const open = () => {
    if (runId != null) onHighlight(runId);
    if (!canPop) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The timeline sits at the very top of the viewport, so the popover drops
    // below the step. Clamp its center so a wide popover can't run off screen.
    const half = 130; // ~ half of max-width
    const margin = 6;
    const center = Math.max(half + margin, Math.min(r.left + r.width / 2, window.innerWidth - half - margin));
    setPop({ left: center, top: r.bottom });
  };
  const close = () => {
    setPop(null);
    if (runId != null) onHighlight(null);
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{ flex: flexWeight }}
      tabIndex={canInteract ? 0 : undefined}
      role={canInteract ? 'button' : undefined}
      aria-label={canInteract ? `Step details${timedOut ? ' — timed out' : ''}` : undefined}
      onMouseEnter={canInteract ? open : undefined}
      onMouseLeave={canInteract ? close : undefined}
      onFocus={canInteract ? open : undefined}
      onBlur={canInteract ? close : undefined}
    >
      <div className="step-fill" style={{ width: `${fillPct}%` }} />
      {label && <span className="step-capacity-label">{label}</span>}
      {timedOut && (
        <span className="step-flag step-flag-timeout" aria-hidden>
          ⏱
        </span>
      )}
      {suspect && !timedOut && (
        <span className="step-flag step-flag-suspect" aria-hidden>
          !
        </span>
      )}
      {canPop &&
        pop &&
        createPortal(
          <div className="step-detail-pop" role="tooltip" style={{ left: pop.left, top: pop.top }}>
            {showDetail && (
              <StepDetailBody
                detail={detail}
                durS={durS}
                expectedS={expectedS}
                capMah={capMah}
                stepType={stepType}
                timedOut={timedOut}
              />
            )}
            {suspect && (
              <div className="step-detail-warn">
                A preceding charge/discharge step timed out, so this step started from an unknown state — its result is
                a less reliable measurement.
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

interface TopBarProps {
  /** Active cell's latest DC-IR estimate (mΩ), for the live I²R heat readout */
  activeCellIrMohm?: number | null;
  /** Cross-highlight a chart trace when a completed step is hovered/selected */
  onHighlightRun?: (runId: number | null) => void;
}

const noop = () => {};

export function TopBar({ activeCellIrMohm = null, onHighlightRun }: TopBarProps) {
  const { state } = useSession();
  const {
    wsConnected,
    serialConnected,
    deviceResponsive,
    mode,
    reading,
    pendingCommand,
    bridgeActive,
    cycleState,
    activeRunMaxTimeMin,
  } = state;
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
  const connClass = !wsConnected
    ? 'conn-off'
    : !serialConnected && !bridgeActive
      ? 'conn-off'
      : readingStale || (!deviceResponsive && !bridgeActive)
        ? 'conn-warn'
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
            {isRunning &&
              activeCellIrMohm != null &&
              activeCellIrMohm > 0 &&
              reading.current > 0.1 &&
              (() => {
                const heatW = (reading.current ** 2 * activeCellIrMohm) / 1000;
                const totalW = reading.voltage * reading.current;
                const pct = totalW > 0 ? Math.round((heatW / totalW) * 100) : 0;
                return (
                  <span className="reading-val rv-heat">
                    <span className="reading-num">{heatW.toFixed(1)}</span>
                    <span className="reading-unit">W heat · {pct}%</span>
                  </span>
                );
              })()}
            {activeCellIrMohm != null && activeCellIrMohm > 0 && (
              <span className="reading-val rv-ir">
                <span className="reading-num">
                  {activeCellIrMohm < 10 ? activeCellIrMohm.toFixed(1) : Math.round(activeCellIrMohm)}
                </span>
                <span className="reading-unit">mΩ</span>
              </span>
            )}
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
            {/* RX bytes 14-15: max time (min) in discharge modes, but cutoff
                current (raw ÷100 → A) in C-CV — label accordingly */}
            {reading.maxTimeEcho != null &&
              (reading.mode === 'c-cv' ? (
                <span className="reading-val rv-raw">
                  <span className="reading-num">{(reading.maxTimeEcho / 100).toFixed(2)}</span>
                  <span className="reading-unit">Icut</span>
                </span>
              ) : (
                <span className="reading-val rv-raw">
                  <span className="reading-num">{reading.maxTimeEcho}</span>
                  <span className="reading-unit">tMax</span>
                </span>
              ))}
            {reading.rawField7 != null && (
              <span className={`reading-val rv-raw${reading.rawField7 !== 0 ? ' rv-highlight' : ''}`}>
                <span className="reading-num">0x{reading.rawField7.toString(16).toUpperCase().padStart(4, '0')}</span>
                <span className="reading-unit">b8-9</span>
              </span>
            )}
          </div>
        )}

        {/* Live temperature readings — click through to channel/limit settings */}
        {state.tempReadings.length > 0 && (
          <a href="/temperature" className="temp-live-readings">
            {state.tempReadings.map(r => (
              <span
                key={r.channelId}
                className={`temp-live-chip${r.alertMaxC != null && r.tempC > r.alertMaxC ? ' alert' : ''}`}
              >
                <span className="temp-label">{r.name ?? r.channelId.slice(-6)}</span>
                <span className="temp-value">{r.tempC.toFixed(1)}°</span>
                {r.dTdtCPerMin != null && Math.abs(r.dTdtCPerMin) >= 0.05 && (
                  <span className={`temp-rate ${r.dTdtCPerMin > 0 ? 'temp-rising' : 'temp-falling'}`}>
                    {r.dTdtCPerMin > 0 ? '+' : ''}
                    {r.dTdtCPerMin.toFixed(1)}°/m
                  </span>
                )}
              </span>
            ))}
          </a>
        )}

        {/* Cycle info — inline in the header */}
        {cycleActive && cycleState && (
          <div className="top-bar-cycle">
            <span className="cycle-name">{cycleState.programName ?? 'Sequence'}</span>
            {cycleState.cellName && <span className="cycle-cell">{cycleState.cellName}</span>}
            {cycleState.status === 'waiting' && waitRemaining !== null && (
              <span className="cycle-wait-countdown">Wait {formatCountdown(waitRemaining)}</span>
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
        <div className="cycle-timeline-bar banner-in-timeline">Server disconnected — reconnecting...</div>
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
      {cycleActive &&
        cycleState &&
        cycleState.execStepTypes.length > 0 &&
        (() => {
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

          // Per-step "suspect" flag: a test step is a less-reliable measurement
          // when the nearest preceding test step timed out (the cell wasn't
          // driven to its endpoint, so this step's start state is unknown).
          // Waits are transparent — they neither carry nor clear the concern.
          const stepDetails = cycleState.stepDetails ?? [];
          const suspectFlags: boolean[] = new Array(cycleState.execStepTypes.length).fill(false);
          let prevTestTimedOut = false;
          cycleState.execStepTypes.forEach((stepType, i) => {
            if (stepType === 'wait') return;
            suspectFlags[i] = prevTestTimedOut;
            prevTestTimedOut = stepDetails[i]?.timedOut ?? false;
          });

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

                const detail = stepDetails[i] ?? null;
                const timedOut = detail?.timedOut ?? false;
                const suspect = suspectFlags[i];
                const showDetail = isDone && stepType !== 'wait';

                const className = [
                  'cycle-timeline-step',
                  STEP_TIMELINE_CLASSES[stepType] ?? 'step-unknown',
                  isDone && 'step-done',
                  isActive && 'step-active',
                  isFuture && 'step-future',
                  timedOut && 'step-timedout',
                  suspect && !timedOut && 'step-suspect',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <TimelineStep
                    key={i}
                    stepType={stepType}
                    className={className}
                    flexWeight={flexWeight}
                    fillPct={fillPct}
                    label={label}
                    detail={detail}
                    durS={durS ?? null}
                    expectedS={expectedS}
                    capMah={capMah ?? null}
                    showDetail={showDetail}
                    timedOut={timedOut}
                    suspect={suspect}
                    runId={isDone ? (cycleState.stepRunIds?.[i] ?? null) : null}
                    onHighlight={onHighlightRun ?? noop}
                  />
                );
              })}
            </div>
          );
        })()}
    </div>
  );
}
