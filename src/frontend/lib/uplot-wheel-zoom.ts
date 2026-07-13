/**
 * Scroll-wheel x-zoom for uPlot charts.
 *
 * Wheel-up zooms in around the pointer, wheel-down zooms out, clamped to
 * the data extents. Zooming goes through u.setScale('x'), so everything
 * built on the setScale hook (chart sync, user-zoom tracking) applies to
 * wheel zoom exactly as it does to drag zoom. Fully zoomed out lands on
 * the exact data extents, which the data-update path treats as the
 * auto-ranging full view again.
 */

import type uPlot from 'uplot';

const ZOOM_FACTOR = 0.75;

export function attachWheelZoom(u: uPlot, minRange: number): void {
  u.over.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();

      const xs = u.data?.[0];
      if (!xs || xs.length < 2) return;
      const dataMin = xs[0];
      const dataMax = xs[xs.length - 1];
      if (!(dataMax > dataMin)) return;

      const min = u.scales.x.min ?? dataMin;
      const max = u.scales.x.max ?? dataMax;
      const xVal = u.posToVal(e.offsetX, 'x');

      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      let range = (max - min) * factor;
      range = Math.max(minRange, Math.min(range, dataMax - dataMin));

      // Keep the point under the pointer stationary
      const leftFrac = (xVal - min) / (max - min);
      let newMin = xVal - leftFrac * range;
      let newMax = newMin + range;

      if (newMin < dataMin) {
        newMin = dataMin;
        newMax = newMin + range;
      }
      if (newMax > dataMax) {
        newMax = dataMax;
        newMin = Math.max(dataMin, newMax - range);
      }

      u.setScale('x', { min: newMin, max: newMax });
    },
    { passive: false }
  );
}
