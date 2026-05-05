#!/usr/bin/env bun
/**
 * One-time cleanup: fix elapsed_s anomalies in data_points.
 *
 * Two issues:
 * 1. Single points with elapsed_s ≈ -0.001 (rounding artifact on first point) — clamp to 0
 * 2. Huge time gaps from service restarts that attached data to existing runs — delete
 *    the orphaned post-gap points and recalculate run stats
 *
 * Usage:
 *   bun run scripts/fix-time-data.ts [--dry-run] [db-path]
 */

import { Database } from 'bun:sqlite';

const GAP_THRESHOLD = 3600; // 1 hour — any gap bigger than this is a service restart artifact

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbPath = args.find(a => !a.startsWith('--')) || '/opt/battery-controller/data/battery.db';

console.log(`Time data cleanup`);
console.log(`  DB: ${dbPath}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log();

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=5000');

interface DataPoint {
  id: number;
  elapsed_s: number;
  capacity_mah: number;
  energy_mwh: number;
  voltage_v: number;
  current_a: number;
}

interface RunRow {
  id: number;
  mode: string;
  data_point_count: number;
}

const runs = db.query<RunRow, []>(
  `SELECT id, mode, data_point_count FROM test_runs WHERE data_point_count > 0 ORDER BY id`
).all();

let pointsClamped = 0;
let pointsDeleted = 0;
let runsUpdated = 0;

for (const run of runs) {
  const pts = db.query<DataPoint, [number]>(
    `SELECT id, elapsed_s, capacity_mah, energy_mwh, voltage_v, current_a
     FROM data_points WHERE run_id = ? ORDER BY elapsed_s`
  ).all(run.id);

  if (pts.length === 0) continue;

  // --- Fix 1: Clamp tiny negative elapsed_s to 0 ---
  const tinyNegs = pts.filter(p => p.elapsed_s < 0 && p.elapsed_s > -1);
  if (tinyNegs.length > 0) {
    console.log(`  Run #${run.id}: clamping ${tinyNegs.length} tiny negative elapsed_s to 0`);
    if (!dryRun) {
      for (const p of tinyNegs) {
        db.run(`UPDATE data_points SET elapsed_s = 0 WHERE id = ?`, [p.id]);
      }
    }
    pointsClamped += tinyNegs.length;
  }

  // --- Fix 2: Remove large negative elapsed_s blocks (like run #53) ---
  // Must run BEFORE gap detection, since gaps within negative blocks are artifacts
  const bigNegs = pts.filter(p => p.elapsed_s < -1);
  if (bigNegs.length > 0) {
    const firstGood = pts.findIndex(p => p.elapsed_s >= 0);
    if (firstGood > 0) {
      const toDelete = pts.slice(0, firstGood);
      console.log(`  Run #${run.id}: removing ${toDelete.length} negative-time orphan points (${Math.round(toDelete[0].elapsed_s)}s..${Math.round(toDelete[toDelete.length - 1].elapsed_s)}s)`);
      if (!dryRun) {
        db.exec('BEGIN');
        for (const p of toDelete) {
          db.run(`DELETE FROM data_points WHERE id = ?`, [p.id]);
        }
        db.exec('COMMIT');
      }
      pointsDeleted += toDelete.length;
      // Remove deleted points from the working array so gap detection works on clean data
      pts.splice(0, firstGood);
    }
  }

  // --- Fix 3: Find and remove post-gap orphaned points ---
  let gapIdx = -1;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].elapsed_s - pts[i - 1].elapsed_s;
    if (gap > GAP_THRESHOLD) {
      gapIdx = i;
      break;
    }
  }

  if (gapIdx < 0) {
    // No gap found — if we deleted negative orphans, recalc run stats from remaining points
    if (bigNegs.length > 0 && pts.length > 0) {
      const last = pts[pts.length - 1];
      const maxV = Math.max(...pts.map(p => p.voltage_v));
      const minV = Math.min(...pts.map(p => p.voltage_v));
      const maxI = Math.max(...pts.map(p => p.current_a));
      console.log(`    → ${pts.length} points remain, duration=${Math.round(last.elapsed_s)}s`);
      if (!dryRun) {
        db.run(
          `UPDATE test_runs SET data_point_count = ?, duration_s = ?,
           final_capacity_mah = ?, final_energy_mwh = ?,
           peak_voltage_v = ?, min_voltage_v = ?, peak_current_a = ?
           WHERE id = ?`,
          [pts.length, last.elapsed_s, last.capacity_mah, last.energy_mwh,
           maxV, minV, maxI, run.id]
        );
      }
      runsUpdated++;
    }
    continue;
  }

  const goodPoints = pts.slice(0, gapIdx);
  const orphanPoints = pts.slice(gapIdx);
  const lastGood = goodPoints[goodPoints.length - 1];

  console.log(
    `  Run #${run.id}: removing ${orphanPoints.length} post-gap points ` +
    `(gap at ${Math.round(lastGood.elapsed_s)}s → ${Math.round(orphanPoints[0].elapsed_s)}s, ` +
    `keeping ${goodPoints.length} points, duration=${Math.round(lastGood.elapsed_s)}s)`
  );

  if (!dryRun) {
    db.exec('BEGIN');
    for (const p of orphanPoints) {
      db.run(`DELETE FROM data_points WHERE id = ?`, [p.id]);
    }

    // Recalculate run stats from remaining good points
    const maxV = Math.max(...goodPoints.map(p => p.voltage_v));
    const minV = Math.min(...goodPoints.map(p => p.voltage_v));
    const maxI = Math.max(...goodPoints.map(p => p.current_a));
    db.run(
      `UPDATE test_runs SET data_point_count = ?, duration_s = ?,
       final_capacity_mah = ?, final_energy_mwh = ?,
       peak_voltage_v = ?, min_voltage_v = ?, peak_current_a = ?
       WHERE id = ?`,
      [goodPoints.length, lastGood.elapsed_s, lastGood.capacity_mah, lastGood.energy_mwh,
       maxV, minV, maxI, run.id]
    );
    db.exec('COMMIT');
  }

  pointsDeleted += orphanPoints.length;
  runsUpdated++;
}

console.log();
console.log(`Summary:`);
console.log(`  Points clamped (tiny negative → 0): ${pointsClamped}`);
console.log(`  Orphan points deleted: ${pointsDeleted}`);
console.log(`  Runs recalculated: ${runsUpdated}`);
if (dryRun) console.log(`  (dry run — no changes made)`);
else console.log(`  Changes committed.`);

db.close();
