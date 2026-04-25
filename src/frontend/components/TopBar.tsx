/**
 * TopBar — minimal status strip at the top of the chart view.
 *
 * Shows: connection dot, device state badge, condensed live readings,
 * and a bridge mode toggle for proxying the serial port to EB Tester.
 */

import { useState } from 'react';
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
  const { state, enableBridge, disableBridge } = useSession();
  const { wsConnected, serialConnected, mode, reading, pendingCommand, bridgeActive } = state;
  const [bridgeLoading, setBridgeLoading] = useState(false);

  const connected = wsConnected && (serialConnected || bridgeActive);
  const isRunning = mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';

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
          <span className={`conn-dot ${connected ? 'conn-ok' : 'conn-off'}`} />
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
    </>
  );
}
