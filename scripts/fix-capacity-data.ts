#!/usr/bin/env bun
/**
 * One-time migration: fix capacity data for all runs affected by the
 * high-capacity encoding bug.
 *
 * The EBC-A40L changes capacity encoding at ~10 Ah (hi byte +99, 10 mAh/unit).
 * Before this fix, the server stored raw encoded values instead of true mAh.
 *
 * Detection: scans each run's data points for the exact transition pattern —
 * a jump from <12,000 to >30,000 between consecutive points. This is precise
 * enough to be idempotent: corrected data has smooth values through the
 * transition and will never match this pattern.
 *
 * Usage:
 *   bun run scripts/fix-capacity-data.ts [--dry-run] [db-path]
 *
 * Examples:
 *   bun run scripts/fix-capacity-data.ts --dry-run /opt/battery-controller/data/battery.db
 *   bun run scripts/fix-capacity-data.ts /opt/battery-controller/data/battery.db
 */

import { Database } from 'bun:sqlite';

const PRE_TRANSITION_MAX = 10_200;  // Pre-transition raw values are always < ~10,000 (max: 42*240+239 = 10,319)
const POST_TRANSITION_MIN = 30_000; // Post-transition encoded values start at ~33,600+
const JUMP_MIN = 20_000;            // Minimum jump for a real encoding transition
const JUMP_MAX = 35_000;            // Maximum jump (real transitions: 23,777 – 30,832)

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbPath = args.find(a => !a.startsWith('--')) || '/opt/battery-controller/data/battery.db';

console.log(`Capacity data migration`);
console.log(`  DB: ${dbPath}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify data)'}`);
console.log();

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=5000');

interface DataPoint {
  id: number;
  capacity_mah: number;
}

interface RunRow {
  id: number;
  mode: string;
  final_capacity_mah: number | null;
  data_point_count: number;
}

// Get all runs that have data points
const runs = db.query<RunRow, []>(
  `SELECT id, mode, final_capacity_mah, data_point_count
   FROM test_runs
   WHERE data_point_count > 0
   ORDER BY id`
).all();

console.log(`Found ${runs.length} runs with data points`);

let runsFixed = 0;
let pointsFixed = 0;
let totalPoints = 0;

const updatePoint = db.prepare(
  `UPDATE data_points SET capacity_mah = ? WHERE id = ?`
);
const updateRun = db.prepare(
  `UPDATE test_runs SET final_capacity_mah = ? WHERE id = ?`
);

for (const run of runs) {
  // Skip wait/idle runs (no capacity accumulation)
  if (run.mode === 'wait') continue;

  // Get all data points for this run in order
  const points = db.query<DataPoint, [number]>(
    `SELECT id, capacity_mah FROM data_points WHERE run_id = ? ORDER BY elapsed_s`
  ).all(run.id);

  if (points.length === 0) continue;
  totalPoints += points.length;

  // Find the genuine encoding transition: pre-value < 10,200 AND post-value > 30,000
  // AND jump is in the 20,000–35,000 range (real transitions are 23,777–30,832).
  // This three-part check is precise enough to be idempotent: corrected data has
  // smooth values through the transition (no jump), and post-correction data gaps
  // produce jumps > 35,000 that don't match.
  let transitionIdx = -1;
  for (let i = 1; i < points.length; i++) {
    const jump = points[i].capacity_mah - points[i - 1].capacity_mah;
    if (points[i - 1].capacity_mah < PRE_TRANSITION_MAX &&
        points[i].capacity_mah > POST_TRANSITION_MIN &&
        jump >= JUMP_MIN && jump <= JUMP_MAX) {
      transitionIdx = i;
      break;
    }
  }

  if (transitionIdx < 0) continue;

  const transitionTrue = points[transitionIdx - 1].capacity_mah;
  const transitionRaw = points[transitionIdx].capacity_mah;

  // Correct all points from the transition onward
  const corrections: { id: number; corrected: number }[] = [];
  for (let i = transitionIdx; i < points.length; i++) {
    const corrected = transitionTrue + (points[i].capacity_mah - transitionRaw) * 10;
    if (Math.abs(corrected - points[i].capacity_mah) > 0.5) {
      corrections.push({ id: points[i].id, corrected });
    }
  }

  if (corrections.length === 0) continue;

  const lastCorrected = transitionTrue + (points[points.length - 1].capacity_mah - transitionRaw) * 10;
  const oldFinal = run.final_capacity_mah;

  console.log(
    `  Run #${run.id} (${run.mode}): ${corrections.length}/${points.length} points to fix, ` +
    `transition at [${transitionIdx}] (${transitionTrue} → ${transitionRaw}), ` +
    `final: ${oldFinal?.toFixed(0) ?? 'null'} → ${lastCorrected.toFixed(0)} mAh`
  );

  if (!dryRun) {
    db.exec('BEGIN');
    try {
      for (const { id, corrected } of corrections) {
        updatePoint.run(corrected, id);
      }
      if (oldFinal !== null) {
        updateRun.run(lastCorrected, run.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`    ERROR on run #${run.id}: ${e}`);
      continue;
    }
  }

  runsFixed++;
  pointsFixed += corrections.length;
}

console.log();
console.log(`Summary:`);
console.log(`  Runs with transition: ${runsFixed}`);
console.log(`  Data points corrected: ${pointsFixed} / ${totalPoints} total`);
if (dryRun) {
  console.log(`  (dry run — no changes made)`);
} else {
  console.log(`  Changes committed.`);
}

db.close();
