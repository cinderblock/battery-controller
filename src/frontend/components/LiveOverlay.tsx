/**
 * LiveOverlay — floating readings panel during active test.
 *
 * Shows voltage, current, power, capacity, energy, and elapsed time
 * in a prominent overlay at the top-right of the chart.
 */

import { useSession } from '../hooks/useDeviceSession.ts';
import { formatElapsedShort } from '../lib/chart-data.ts';

export function LiveOverlay() {
  const { state } = useSession();
  const { reading, mode } = state;

  const isRunning = mode === 'd-cc' || mode === 'd-cp' || mode === 'c-cv';
  if (!isRunning || !reading) return null;

  return (
    <div className="live-overlay">
      <div className="live-row live-primary">
        <span className="live-val">{reading.voltage.toFixed(3)}<small>V</small></span>
        <span className="live-val">{reading.current.toFixed(2)}<small>A</small></span>
      </div>
      <div className="live-row">
        <span className="live-val">{reading.power.toFixed(1)}<small>W</small></span>
        <span className="live-val">{reading.capacityAh.toFixed(3)}<small>Ah</small></span>
      </div>
      <div className="live-row">
        <span className="live-val">{reading.energyWh.toFixed(1)}<small>Wh</small></span>
        <span className="live-val live-time">{formatElapsedShort(reading.elapsedS)}</span>
      </div>
    </div>
  );
}
