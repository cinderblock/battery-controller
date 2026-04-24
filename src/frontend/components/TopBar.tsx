/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot, device state badge, condensed live readings.
 */

import { useSession } from '../hooks/useDeviceSession.ts';
import type { DeviceMode } from '../api-client.ts';

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
  const { state } = useSession();
  const { wsConnected, serialConnected, mode, reading, pendingCommand } = state;

  const connected = wsConnected && serialConnected;

  return (
    <>
      <header className="top-bar">
        <div className="top-bar-left">
          <span className={`conn-dot ${connected ? 'conn-ok' : 'conn-off'}`} />
          <span className={`mode-badge ${MODE_CLASSES[mode]}`}>
            {pendingCommand ? `${pendingCommand.command}...` : MODE_LABELS[mode]}
          </span>
        </div>

        {reading && (
          <div className="top-bar-readings">
            <span className="reading-val">
              <span className="reading-num">{reading.voltage.toFixed(3)}</span>
              <span className="reading-unit">V</span>
            </span>
            <span className="reading-val">
              <span className="reading-num">{reading.current.toFixed(2)}</span>
              <span className="reading-unit">A</span>
            </span>
            {mode !== 'idle' && (
              <span className="reading-val">
                <span className="reading-num">{reading.capacityAh.toFixed(3)}</span>
                <span className="reading-unit">Ah</span>
              </span>
            )}
          </div>
        )}
      </header>

      {!wsConnected && (
        <div className="disconnect-banner">
          Server disconnected — reconnecting...
        </div>
      )}
      {wsConnected && !serialConnected && (
        <div className="disconnect-banner disconnect-serial">
          Serial port disconnected — device not responding
        </div>
      )}
    </>
  );
}
