/**
 * Shared formatting/coloring helpers for cell-health presentation.
 *
 * Lifted from LegendPanel / CellSelectModal so the Legend panel and the
 * dedicated Health view render capacity, health%, IR, and trend the same way.
 */

/** Green ≥90%, amber ≥75%, red below — matches the fleet-health thresholds. */
export function healthColor(pct: number): string {
  if (pct >= 90) return '#4caf50';
  if (pct >= 75) return '#ff9800';
  return '#f44336';
}

/** ↗ improving, ↘ degrading, → stable; '' when no trend. */
export function trendArrow(trend: number | null): string {
  if (trend === null) return '';
  if (trend > 0.1) return '↗';
  if (trend < -0.1) return '↘';
  return '→';
}

/** Sub-mΩ readings need a decimal to stay meaningful (healthy cells are <1 mΩ). */
export function formatIr(mohm: number | null | undefined): string {
  if (mohm == null) return '—';
  return `${mohm < 10 ? mohm.toFixed(1) : Math.round(mohm)} mΩ`;
}

/** Capacity in Ah with one decimal; em-dash for null. */
export function formatAh(ah: number | null | undefined): string {
  return ah == null ? '—' : `${ah.toFixed(1)} Ah`;
}

/** Health percentage with no decimals; em-dash for null. */
export function formatPct(pct: number | null | undefined): string {
  return pct == null ? '—' : `${Math.round(pct)}%`;
}
