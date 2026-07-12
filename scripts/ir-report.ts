/**
 * Offline IR report — run the estimator over every run in a database
 * snapshot and print per-cell results. Validates the estimator against
 * real data without touching the live server.
 *
 *   DB_PATH=/tmp/battery-snap.db bun run scripts/ir-report.ts
 */

import { getCells, getDataPointsForRun, getDb, initDb, type TestRun } from '../src/server/db.ts';
import { estimateIrMohm, modeSupportsIr } from '../src/server/ir-estimate.ts';

initDb();

const runs = getDb()
  .query<TestRun, []>(
    `SELECT * FROM test_runs WHERE mode IN ('c-cv', 'd-cc', 'd-cp') AND data_point_count >= 2 ORDER BY cell_id, started_at`
  )
  .all();

const cellNames = new Map(getCells().map(c => [c.id, c.label || c.barcode]));

console.log('cell                run  mode   date              I_peak    dur      IR est');
for (const run of runs) {
  if (!modeSupportsIr(run.mode)) continue;
  const est = estimateIrMohm(getDataPointsForRun(run.id), run.mode);
  const cell = run.cell_id !== null ? (cellNames.get(run.cell_id) ?? `#${run.cell_id}`) : '(none)';
  console.log(
    `${cell.padEnd(18)} #${String(run.id).padEnd(4)} ${run.mode.padEnd(5)} ${run.started_at.slice(0, 16)}  ` +
      `${String(run.peak_current_a ?? '?').padStart(6)}A ${String(Math.round(run.duration_s ?? 0)).padStart(6)}s  ` +
      (est
        ? `${est.mohm.toFixed(2).padStart(8)} mΩ (${est.samples} sample${est.samples === 1 ? '' : 's'})`
        : '       —')
  );
}
