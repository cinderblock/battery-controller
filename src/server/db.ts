/**
 * SQLite data layer using bun:sqlite
 *
 * Stores cells, test runs, data points, cycle programs, and settings.
 * Uses WAL mode for concurrent read/write and crash resilience.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.ts';

// ── UTC timestamp helpers ──────────────────────────────────────────

/** SQLite expression that produces ISO 8601 UTC timestamps (with 'Z' suffix) */
const SQL_NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/**
 * Parse a SQLite timestamp as UTC, regardless of whether it has a 'Z' suffix.
 * SQLite's datetime('now') stores UTC but omits the timezone marker, which
 * causes `new Date()` to misinterpret it as local time.
 */
export function parseUtcTimestamp(sqliteTs: string): number {
  if (sqliteTs.endsWith('Z') || sqliteTs.endsWith('+00:00')) {
    return new Date(sqliteTs).getTime();
  }
  return new Date(sqliteTs + 'Z').getTime();
}

const DB_PATH = process.env.DB_PATH || '/opt/battery-controller/data/battery.db';

let db: Database;

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized — call initDb() first');
  }
  return db;
}

export function initDb(path: string = DB_PATH): Database {
  db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db);
  logger.info(`Database initialized at ${path}`);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}

// ── Migrations ──────────────────────────────────────────────────────

function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  )`);

  const currentVersion =
    db.query<{ version: number }, []>('SELECT MAX(version) as version FROM schema_version').get()?.version ?? 0;

  const migrations: { version: number; sql: string }[] = [
    {
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS cells (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          barcode TEXT UNIQUE NOT NULL,
          label TEXT,
          nominal_capacity_mah INTEGER DEFAULT 200000,
          chemistry TEXT DEFAULT 'LiFePO4',
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cells_barcode ON cells(barcode);

        CREATE TABLE IF NOT EXISTS cell_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          nominal_capacity_mah INTEGER NOT NULL,
          chemistry TEXT DEFAULT 'LiFePO4',
          charge_voltage_v REAL,
          discharge_cutoff_v REAL,
          charge_cutoff_current_a REAL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS cycle_programs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cell_id INTEGER REFERENCES cells(id),
          name TEXT,
          steps_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          current_step INTEGER DEFAULT 0,
          current_cycle INTEGER DEFAULT 0,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS test_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cell_id INTEGER REFERENCES cells(id),
          cycle_program_id INTEGER REFERENCES cycle_programs(id),
          cycle_step_index INTEGER,
          mode TEXT NOT NULL,
          setpoint_current_a REAL,
          setpoint_voltage_v REAL,
          setpoint_power_w REAL,
          setpoint_cutoff_v REAL,
          setpoint_cutoff_current_a REAL,
          setpoint_max_time_min INTEGER,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          ended_at TEXT,
          start_reason TEXT DEFAULT 'manual',
          end_reason TEXT,
          final_capacity_mah REAL,
          final_energy_mwh REAL,
          peak_voltage_v REAL,
          min_voltage_v REAL,
          peak_current_a REAL,
          duration_s REAL,
          data_point_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_test_runs_cell_id ON test_runs(cell_id);
        CREATE INDEX IF NOT EXISTS idx_test_runs_cycle_id ON test_runs(cycle_program_id);

        CREATE TABLE IF NOT EXISTS data_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES test_runs(id),
          elapsed_s REAL NOT NULL,
          voltage_v REAL NOT NULL,
          current_a REAL NOT NULL,
          power_w REAL NOT NULL,
          capacity_mah REAL NOT NULL,
          energy_mwh REAL NOT NULL,
          state_byte INTEGER NOT NULL,
          recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_data_points_run_id ON data_points(run_id);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sequences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          cell_group_id INTEGER REFERENCES cell_groups(id),
          steps_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
      `,
    },
    {
      version: 2,
      sql: `
        ALTER TABLE cells ADD COLUMN cell_group_id INTEGER REFERENCES cell_groups(id);
      `,
    },
    {
      version: 3,
      sql: `
        ALTER TABLE test_runs ADD COLUMN exclude_from_capacity BOOLEAN DEFAULT 0;
        ALTER TABLE test_runs ADD COLUMN cycle_iteration INTEGER;
      `,
    },
    {
      version: 4,
      sql: `
        -- Convert bare datetime('now') timestamps to ISO 8601 UTC (with 'Z').
        -- datetime('now') stored UTC without a timezone marker, which JS
        -- new Date() misinterprets as local time.
        UPDATE cells SET
          created_at = replace(created_at, ' ', 'T') || 'Z'
          WHERE created_at NOT LIKE '%Z' AND created_at NOT LIKE '%+%';
        UPDATE cells SET
          updated_at = replace(updated_at, ' ', 'T') || 'Z'
          WHERE updated_at NOT LIKE '%Z' AND updated_at NOT LIKE '%+%';
        UPDATE cell_groups SET
          created_at = replace(created_at, ' ', 'T') || 'Z'
          WHERE created_at NOT LIKE '%Z' AND created_at NOT LIKE '%+%';
        UPDATE cycle_programs SET
          created_at = replace(created_at, ' ', 'T') || 'Z'
          WHERE created_at NOT LIKE '%Z' AND created_at NOT LIKE '%+%';
        UPDATE cycle_programs SET
          started_at = replace(started_at, ' ', 'T') || 'Z'
          WHERE started_at IS NOT NULL AND started_at NOT LIKE '%Z' AND started_at NOT LIKE '%+%';
        UPDATE cycle_programs SET
          ended_at = replace(ended_at, ' ', 'T') || 'Z'
          WHERE ended_at IS NOT NULL AND ended_at NOT LIKE '%Z' AND ended_at NOT LIKE '%+%';
        UPDATE test_runs SET
          started_at = replace(started_at, ' ', 'T') || 'Z'
          WHERE started_at NOT LIKE '%Z' AND started_at NOT LIKE '%+%';
        UPDATE test_runs SET
          ended_at = replace(ended_at, ' ', 'T') || 'Z'
          WHERE ended_at IS NOT NULL AND ended_at NOT LIKE '%Z' AND ended_at NOT LIKE '%+%';
        UPDATE data_points SET
          recorded_at = replace(recorded_at, ' ', 'T') || 'Z'
          WHERE recorded_at NOT LIKE '%Z' AND recorded_at NOT LIKE '%+%';
        UPDATE sequences SET
          created_at = replace(created_at, ' ', 'T') || 'Z'
          WHERE created_at NOT LIKE '%Z' AND created_at NOT LIKE '%+%';
        UPDATE sequences SET
          updated_at = replace(updated_at, ' ', 'T') || 'Z'
          WHERE updated_at NOT LIKE '%Z' AND updated_at NOT LIKE '%+%';
      `,
    },
    {
      version: 5,
      sql: `
        -- Channel registry for temperature sensors (1-Wire + HTTP/HA)
        CREATE TABLE temp_channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_key TEXT UNIQUE NOT NULL,
          name TEXT,
          source_type TEXT NOT NULL,
          source_config TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          alert_max_c REAL,
          first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_seen_at TEXT,
          unplugged_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );

        -- Temperature readings (only stored during active runs/waits)
        CREATE TABLE temperature_readings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES test_runs(id),
          channel_id INTEGER NOT NULL REFERENCES temp_channels(id),
          temp_c REAL NOT NULL,
          elapsed_s REAL NOT NULL,
          recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE INDEX idx_temp_readings_run ON temperature_readings(run_id, channel_id);
      `,
    },
  ];

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      logger.info(`Running migration v${migration.version}...`);
      db.exec(migration.sql);
      db.exec(`INSERT INTO schema_version (version) VALUES (${migration.version})`);
    }
  }
}

// ── Cell operations ─────────────────────────────────────────────────

export interface Cell {
  id: number;
  barcode: string;
  label: string | null;
  nominal_capacity_mah: number;
  chemistry: string;
  notes: string | null;
  cell_group_id: number | null;
  created_at: string;
  updated_at: string;
}

export function upsertCell(barcode: string, label?: string | null): Cell {
  const db = getDb();
  const existing = db.query<Cell, [string]>('SELECT * FROM cells WHERE barcode = ?').get(barcode);

  if (existing) {
    if (label !== undefined) {
      db.run(`UPDATE cells SET label = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [label, existing.id]);
      existing.label = label;
    }
    return existing;
  }

  const result = db.run('INSERT INTO cells (barcode, label) VALUES (?, ?)', [barcode, label ?? null]);
  return db.query<Cell, [number]>('SELECT * FROM cells WHERE id = ?').get(result.lastInsertRowid as number)!;
}

export function getCells(): Cell[] {
  return getDb().query<Cell, []>('SELECT * FROM cells ORDER BY label, barcode').all();
}

export function getRecentCells(limit = 1): Cell[] {
  return getDb().query<Cell, [number]>('SELECT * FROM cells ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function getCellById(id: number): Cell | null {
  return getDb().query<Cell, [number]>('SELECT * FROM cells WHERE id = ?').get(id) ?? null;
}

export function getRunCountForCell(cellId: number): number {
  return (
    getDb().query<{ count: number }, [number]>('SELECT COUNT(*) as count FROM test_runs WHERE cell_id = ?').get(cellId)
      ?.count ?? 0
  );
}

/**
 * Delete a cell. Refuses (returns the run count) when the cell has recorded
 * runs unless `force` is set, in which case the runs and all their data
 * points and temperature readings are deleted too.
 */
export function deleteCell(cellId: number, force = false): { deleted: boolean; runCount: number } {
  const db = getDb();
  const runCount = getRunCountForCell(cellId);
  if (runCount > 0 && !force) {
    return { deleted: false, runCount };
  }

  const txn = db.transaction(() => {
    if (runCount > 0) {
      db.run('DELETE FROM temperature_readings WHERE run_id IN (SELECT id FROM test_runs WHERE cell_id = ?)', [cellId]);
      db.run('DELETE FROM data_points WHERE run_id IN (SELECT id FROM test_runs WHERE cell_id = ?)', [cellId]);
      db.run('DELETE FROM test_runs WHERE cell_id = ?', [cellId]);
    }
    db.run('DELETE FROM cells WHERE id = ?', [cellId]);
  });
  txn();

  return { deleted: true, runCount };
}

export function getCellByBarcode(barcode: string): Cell | null {
  return getDb().query<Cell, [string]>('SELECT * FROM cells WHERE barcode = ?').get(barcode) ?? null;
}

export function updateCell(id: number, updates: { label?: string | null; notes?: string | null }): Cell | null {
  const db = getDb();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];

  if (updates.label !== undefined) {
    sets.push('label = ?');
    vals.push(updates.label);
  }
  if (updates.notes !== undefined) {
    sets.push('notes = ?');
    vals.push(updates.notes);
  }
  if (sets.length === 0) return getCellById(id);

  sets.push(`updated_at = ${SQL_NOW_UTC}`);
  vals.push(id);
  db.run(`UPDATE cells SET ${sets.join(', ')} WHERE id = ?`, vals);
  return getCellById(id);
}

// ── Test run operations ─────────────────────────────────────────────

export interface TestRun {
  id: number;
  cell_id: number | null;
  cycle_program_id: number | null;
  cycle_step_index: number | null;
  mode: string;
  setpoint_current_a: number | null;
  setpoint_voltage_v: number | null;
  setpoint_power_w: number | null;
  setpoint_cutoff_v: number | null;
  setpoint_cutoff_current_a: number | null;
  setpoint_max_time_min: number | null;
  started_at: string;
  ended_at: string | null;
  start_reason: string;
  end_reason: string | null;
  final_capacity_mah: number | null;
  final_energy_mwh: number | null;
  peak_voltage_v: number | null;
  min_voltage_v: number | null;
  peak_current_a: number | null;
  duration_s: number | null;
  data_point_count: number;
  exclude_from_capacity: number;
  cycle_iteration: number | null;
}

export interface CreateTestRunParams {
  cellId?: number | null;
  cycleProgramId?: number | null;
  cycleStepIndex?: number | null;
  mode: string;
  setpointCurrentA?: number | null;
  setpointVoltageV?: number | null;
  setpointPowerW?: number | null;
  setpointCutoffV?: number | null;
  setpointCutoffCurrentA?: number | null;
  setpointMaxTimeMin?: number | null;
  startReason?: string;
  excludeFromCapacity?: boolean;
  cycleIteration?: number | null;
}

export function createTestRun(params: CreateTestRunParams): TestRun {
  const db = getDb();
  const result = db.run(
    `INSERT INTO test_runs (cell_id, cycle_program_id, cycle_step_index, mode,
       setpoint_current_a, setpoint_voltage_v, setpoint_power_w,
       setpoint_cutoff_v, setpoint_cutoff_current_a, setpoint_max_time_min,
       start_reason, exclude_from_capacity, cycle_iteration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.cellId ?? null,
      params.cycleProgramId ?? null,
      params.cycleStepIndex ?? null,
      params.mode,
      params.setpointCurrentA ?? null,
      params.setpointVoltageV ?? null,
      params.setpointPowerW ?? null,
      params.setpointCutoffV ?? null,
      params.setpointCutoffCurrentA ?? null,
      params.setpointMaxTimeMin ?? null,
      params.startReason ?? 'manual',
      params.excludeFromCapacity ? 1 : 0,
      params.cycleIteration ?? null,
    ]
  );
  return db.query<TestRun, [number]>('SELECT * FROM test_runs WHERE id = ?').get(result.lastInsertRowid as number)!;
}

export function finalizeTestRun(
  runId: number,
  endReason: string,
  finalCapacityMah: number,
  finalEnergyMwh: number,
  peakVoltageV: number,
  minVoltageV: number,
  peakCurrentA: number,
  durationS: number,
  dataPointCount: number
): void {
  getDb().run(
    `UPDATE test_runs SET
       ended_at = ${SQL_NOW_UTC},
       end_reason = ?, final_capacity_mah = ?, final_energy_mwh = ?,
       peak_voltage_v = ?, min_voltage_v = ?, peak_current_a = ?,
       duration_s = ?, data_point_count = ?
     WHERE id = ?`,
    [
      endReason,
      finalCapacityMah,
      finalEnergyMwh,
      peakVoltageV,
      minVoltageV,
      peakCurrentA,
      durationS,
      dataPointCount,
      runId,
    ]
  );
}

export function getTestRunsForCell(cellId: number): TestRun[] {
  return getDb()
    .query<TestRun, [number]>('SELECT * FROM test_runs WHERE cell_id = ? ORDER BY started_at DESC')
    .all(cellId);
}

export function getTestRun(id: number): TestRun | null {
  return getDb().query<TestRun, [number]>('SELECT * FROM test_runs WHERE id = ?').get(id) ?? null;
}

export function getRecentTestRuns(limit: number = 50): TestRun[] {
  return getDb().query<TestRun, [number]>('SELECT * FROM test_runs ORDER BY started_at DESC LIMIT ?').all(limit);
}

/** Mark incomplete runs and cycle programs from a previous crash */
export function markIncompleteRuns(): { runs: number; cycles: number } {
  const db = getDb();
  const runs = db.run(
    `UPDATE test_runs SET ended_at = ${SQL_NOW_UTC}, end_reason = 'service_restart'
     WHERE ended_at IS NULL`
  ).changes;
  // Note: cycle programs are NOT aborted here. The CycleRunner.start() method
  // handles recovery — it will either resume the program or abort it if recovery fails.
  const cycles =
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM cycle_programs WHERE status IN ('running', 'pending')`
      )
      .get()?.count ?? 0;
  return { runs, cycles };
}

// ── Data point operations ───────────────────────────────────────────

export interface DataPoint {
  id: number;
  run_id: number;
  elapsed_s: number;
  voltage_v: number;
  current_a: number;
  power_w: number;
  capacity_mah: number;
  energy_mwh: number;
  state_byte: number;
  recorded_at: string;
}

const insertDataPointStmt = {
  _stmt: null as ReturnType<Database['prepare']> | null,
  get(db: Database) {
    if (!this._stmt) {
      this._stmt = db.prepare(
        `INSERT INTO data_points (run_id, elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh, state_byte)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
    }
    return this._stmt;
  },
};

export function insertDataPoint(
  runId: number,
  elapsedS: number,
  voltageV: number,
  currentA: number,
  powerW: number,
  capacityMah: number,
  energyMwh: number,
  stateByte: number
): void {
  insertDataPointStmt.get(getDb()).run(runId, elapsedS, voltageV, currentA, powerW, capacityMah, energyMwh, stateByte);
}

export function getDataPointsForRun(runId: number): DataPoint[] {
  return getDb().query<DataPoint, [number]>('SELECT * FROM data_points WHERE run_id = ? ORDER BY elapsed_s').all(runId);
}

/**
 * Compact data point row: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh]
 * Avoids repeating key names for every point — cuts payload size 60-80%.
 */
export type CompactDataRow = [number, number, number, number, number, number];

/**
 * Downsampled row with min/max ranges per bucket:
 * [elapsed_s, v_min, v_max, i_min, i_max, p_min, p_max, capacity_mah, energy_mwh]
 */
export type DownsampledDataRow = [number, number, number, number, number, number, number, number, number];

export interface RunWithCompactData extends TestRun {
  /** Column order: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh] */
  d: CompactDataRow[] | DownsampledDataRow[];
  /** True when d contains downsampled rows with min/max ranges */
  downsampled?: boolean;
}

/** Max points per run before downsampling kicks in */
const DOWNSAMPLE_THRESHOLD = 500;

/**
 * Downsample a full-resolution run into min/max range buckets.
 * Each bucket covers a time window and emits one row with:
 * [t_mid, v_min, v_max, i_min, i_max, p_min, p_max, cap_last, energy_last]
 */
function downsampleRun(rows: CompactDataRow[], maxPoints: number): DownsampledDataRow[] {
  if (rows.length <= maxPoints) return rows as unknown as DownsampledDataRow[];
  const bucketSize = rows.length / maxPoints;
  const result: DownsampledDataRow[] = [];

  for (let b = 0; b < maxPoints; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.floor((b + 1) * bucketSize);
    let vMin = Infinity,
      vMax = -Infinity;
    let iMin = Infinity,
      iMax = -Infinity;
    let pMin = Infinity,
      pMax = -Infinity;

    for (let j = start; j < end; j++) {
      const r = rows[j];
      // r = [elapsed, voltage, current, power, cap, energy]
      if (r[1] < vMin) vMin = r[1];
      if (r[1] > vMax) vMax = r[1];
      if (r[2] < iMin) iMin = r[2];
      if (r[2] > iMax) iMax = r[2];
      if (r[3] < pMin) pMin = r[3];
      if (r[3] > pMax) pMax = r[3];
    }

    const mid = rows[Math.floor((start + end - 1) / 2)];
    const last = rows[end - 1];
    result.push([mid[0], vMin, vMax, iMin, iMax, pMin, pMax, last[4], last[5]]);
  }

  return result;
}

/** Fetch recent runs with compact data points in one go, optionally for a single cell */
export function getRecentRunsWithData(limit: number = 50, cellId?: number | null): RunWithCompactData[] {
  const db = getDb();
  const runs =
    cellId !== undefined && cellId !== null
      ? db
          .query<TestRun, [number, number]>(
            'SELECT * FROM test_runs WHERE cell_id = ? ORDER BY started_at DESC LIMIT ?'
          )
          .all(cellId, limit)
      : db.query<TestRun, [number]>('SELECT * FROM test_runs ORDER BY started_at DESC LIMIT ?').all(limit);

  if (runs.length === 0) return [];

  // Single query for only the columns we need, in compact form
  const runIds = runs.map(r => r.id);
  const placeholders = runIds.map(() => '?').join(',');
  const allPoints = db
    .query<
      {
        run_id: number;
        elapsed_s: number;
        voltage_v: number;
        current_a: number;
        power_w: number;
        capacity_mah: number;
        energy_mwh: number;
      },
      number[]
    >(
      `SELECT run_id, elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh
     FROM data_points WHERE run_id IN (${placeholders}) ORDER BY run_id, elapsed_s`
    )
    .all(...runIds);

  // Group as compact arrays by run_id
  const pointsByRun = new Map<number, CompactDataRow[]>();
  for (const p of allPoints) {
    let arr = pointsByRun.get(p.run_id);
    if (!arr) {
      arr = [];
      pointsByRun.set(p.run_id, arr);
    }
    arr.push([p.elapsed_s, p.voltage_v, p.current_a, p.power_w, p.capacity_mah, p.energy_mwh]);
  }

  return runs.map(run => {
    const fullRes = pointsByRun.get(run.id) ?? [];
    if (fullRes.length > DOWNSAMPLE_THRESHOLD) {
      return { ...run, d: downsampleRun(fullRes, DOWNSAMPLE_THRESHOLD), downsampled: true };
    }
    return { ...run, d: fullRes };
  });
}

export function getDataPointCount(runId: number): number {
  return (
    getDb().query<{ count: number }, [number]>('SELECT COUNT(*) as count FROM data_points WHERE run_id = ?').get(runId)
      ?.count ?? 0
  );
}

/** Find the most recent run closed by a service restart/shutdown with matching mode */
export function getLastServiceRestartRun(mode: string): TestRun | null {
  return (
    getDb()
      .query<TestRun, [string]>(
        `SELECT * FROM test_runs
     WHERE end_reason IN ('service_restart', 'service_shutdown') AND mode = ?
     ORDER BY id DESC LIMIT 1`
      )
      .get(mode) ?? null
  );
}

/** Get the last data point for a run (by insertion order) */
export function getLastDataPointForRun(runId: number): DataPoint | null {
  return (
    getDb()
      .query<DataPoint, [number]>('SELECT * FROM data_points WHERE run_id = ? ORDER BY id DESC LIMIT 1')
      .get(runId) ?? null
  );
}

/** Get aggregate peak/min stats from all data points in a run */
export function getRunPeakStats(
  runId: number
): { peakVoltage: number; minVoltage: number; peakCurrent: number } | null {
  const row = getDb()
    .query<{ peak_v: number; min_v: number; peak_i: number }, [number]>(
      `SELECT MAX(voltage_v) as peak_v, MIN(voltage_v) as min_v, MAX(current_a) as peak_i
     FROM data_points WHERE run_id = ?`
    )
    .get(runId);
  if (!row || row.peak_v == null) return null;
  return { peakVoltage: row.peak_v, minVoltage: row.min_v, peakCurrent: row.peak_i };
}

/** Reopen a service_restart run for continued recording */
export function reopenRun(runId: number): void {
  getDb().run('UPDATE test_runs SET ended_at = NULL, end_reason = NULL WHERE id = ?', [runId]);
}

// ── Sequence operations ─────────────────────────────────────────────

export interface Sequence {
  id: number;
  name: string;
  cell_group_id: number | null;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

export function getSequences(): Sequence[] {
  return getDb().query<Sequence, []>('SELECT * FROM sequences ORDER BY name').all();
}

export function getSequence(id: number): Sequence | null {
  return getDb().query<Sequence, [number]>('SELECT * FROM sequences WHERE id = ?').get(id) ?? null;
}

export function createSequence(name: string, stepsJson: string, cellGroupId?: number | null): Sequence {
  const db = getDb();
  const result = db.run('INSERT INTO sequences (name, steps_json, cell_group_id) VALUES (?, ?, ?)', [
    name,
    stepsJson,
    cellGroupId ?? null,
  ]);
  return db.query<Sequence, [number]>('SELECT * FROM sequences WHERE id = ?').get(result.lastInsertRowid as number)!;
}

export function updateSequence(id: number, name: string, stepsJson: string): void {
  getDb().run(`UPDATE sequences SET name = ?, steps_json = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [
    name,
    stepsJson,
    id,
  ]);
}

export function deleteSequence(id: number): void {
  getDb().run('DELETE FROM sequences WHERE id = ?', [id]);
}

// ── Cycle program operations ────────────────────────────────────────

export interface CycleProgram {
  id: number;
  cell_id: number | null;
  name: string | null;
  steps_json: string;
  status: string;
  current_step: number;
  current_cycle: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export function createCycleProgram(cellId: number | null, name: string | null, stepsJson: string): CycleProgram {
  const db = getDb();
  const result = db.run('INSERT INTO cycle_programs (cell_id, name, steps_json) VALUES (?, ?, ?)', [
    cellId,
    name,
    stepsJson,
  ]);
  return db
    .query<CycleProgram, [number]>('SELECT * FROM cycle_programs WHERE id = ?')
    .get(result.lastInsertRowid as number)!;
}

export function updateCycleProgram(
  id: number,
  updates: Partial<Pick<CycleProgram, 'status' | 'current_step' | 'current_cycle' | 'started_at' | 'ended_at'>>
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    vals.push(val as string | number | null);
  }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().run(`UPDATE cycle_programs SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export function getActiveCycleProgram(): CycleProgram | null {
  return getDb().query<CycleProgram, []>("SELECT * FROM cycle_programs WHERE status = 'running' LIMIT 1").get() ?? null;
}

export function getCycleProgram(id: number): CycleProgram | null {
  return getDb().query<CycleProgram, [number]>('SELECT * FROM cycle_programs WHERE id = ?').get(id) ?? null;
}

/** All test runs for a cycle program, ordered by start time */
export function getRunsForCycleProgram(programId: number): TestRun[] {
  return getDb()
    .query<TestRun, [number]>('SELECT * FROM test_runs WHERE cycle_program_id = ? ORDER BY started_at ASC')
    .all(programId);
}

/** Get the most recent test run for a specific cycle step (used for wait resume) */
export function getCycleStepRun(programId: number, stepIndex: number): TestRun | null {
  return (
    getDb()
      .query<TestRun, [number, number]>(
        'SELECT * FROM test_runs WHERE cycle_program_id = ? AND cycle_step_index = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(programId, stepIndex) ?? null
  );
}

// ── Settings operations ─────────────────────────────────────────────

export function getSetting(key: string): string | null {
  return getDb().query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

// ── Cell group operations ───────────────────────────────────────────

export interface CellGroup {
  id: number;
  name: string;
  nominal_capacity_mah: number;
  chemistry: string;
  charge_voltage_v: number | null;
  discharge_cutoff_v: number | null;
  charge_cutoff_current_a: number | null;
  created_at: string;
}

export function getCellGroups(): CellGroup[] {
  return getDb().query<CellGroup, []>('SELECT * FROM cell_groups ORDER BY name').all();
}

export function getCellGroup(id: number): CellGroup | null {
  return getDb().query<CellGroup, [number]>('SELECT * FROM cell_groups WHERE id = ?').get(id) ?? null;
}

export function getCellsInGroup(groupId: number): Cell[] {
  return getDb()
    .query<Cell, [number]>('SELECT * FROM cells WHERE cell_group_id = ? ORDER BY label, barcode')
    .all(groupId);
}

export function setCellGroup(cellId: number, groupId: number | null): void {
  getDb().run(`UPDATE cells SET cell_group_id = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [groupId, cellId]);
}

/** Completed discharge runs for a cell, ordered by date (excludes setup/teardown) */
export function getCompletedDischargeRuns(cellId: number): TestRun[] {
  return getDb()
    .query<TestRun, [number]>(
      `SELECT * FROM test_runs
     WHERE cell_id = ? AND mode = 'd-cc'
       AND final_capacity_mah IS NOT NULL AND final_capacity_mah > 0
       AND ended_at IS NOT NULL
       AND (exclude_from_capacity IS NULL OR exclude_from_capacity = 0)
     ORDER BY started_at ASC`
    )
    .all(cellId);
}

/** All completed discharge runs (for fleet analysis, excludes setup/teardown) */
export function getAllCompletedDischargeRuns(): TestRun[] {
  return getDb()
    .query<TestRun, []>(
      `SELECT * FROM test_runs
     WHERE mode = 'd-cc'
       AND final_capacity_mah IS NOT NULL AND final_capacity_mah > 0
       AND ended_at IS NOT NULL
       AND (exclude_from_capacity IS NULL OR exclude_from_capacity = 0)
     ORDER BY started_at ASC`
    )
    .all();
}

export function ensureDefaultCellGroup(): CellGroup {
  const db = getDb();
  const existing = db.query<CellGroup, [string]>('SELECT * FROM cell_groups WHERE name = ?').get('TS-LFP200AHA');

  if (existing) return existing;

  const result = db.run(
    `INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry, charge_voltage_v, discharge_cutoff_v, charge_cutoff_current_a)
     VALUES ('TS-LFP200AHA', 200000, 'LiFePO4', 3.65, 2.50, 2.00)`
  );
  return db.query<CellGroup, [number]>('SELECT * FROM cell_groups WHERE id = ?').get(result.lastInsertRowid as number)!;
}

export function createCellGroup(
  name: string,
  nominalCapacityMah: number,
  chemistry: string,
  chargeVoltageV?: number | null,
  dischargeCutoffV?: number | null,
  chargeCutoffCurrentA?: number | null
): CellGroup {
  const db = getDb();
  const result = db.run(
    `INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry, charge_voltage_v, discharge_cutoff_v, charge_cutoff_current_a)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      name,
      nominalCapacityMah,
      chemistry,
      chargeVoltageV ?? null,
      dischargeCutoffV ?? null,
      chargeCutoffCurrentA ?? null,
    ]
  );
  return db.query<CellGroup, [number]>('SELECT * FROM cell_groups WHERE id = ?').get(result.lastInsertRowid as number)!;
}

// ── Temperature channel operations ─────────────────────────────────

export interface TempChannel {
  id: number;
  channel_key: string;
  name: string | null;
  source_type: string;
  source_config: string;
  enabled: number;
  alert_max_c: number | null;
  first_seen_at: string;
  last_seen_at: string | null;
  unplugged_at: string | null;
  created_at: string;
}

export function getTempChannels(): TempChannel[] {
  return getDb().query<TempChannel, []>('SELECT * FROM temp_channels ORDER BY name, channel_key').all();
}

export function getTempChannelByKey(key: string): TempChannel | null {
  return getDb().query<TempChannel, [string]>('SELECT * FROM temp_channels WHERE channel_key = ?').get(key) ?? null;
}

export function upsertTempChannel(channelKey: string, sourceType: string, sourceConfig: string): TempChannel {
  const db = getDb();
  const existing = getTempChannelByKey(channelKey);
  if (existing) return existing;

  db.run(
    `INSERT INTO temp_channels (channel_key, source_type, source_config)
     VALUES (?, ?, ?)`,
    [channelKey, sourceType, sourceConfig]
  );
  return getTempChannelByKey(channelKey)!;
}

export function updateTempChannel(
  id: number,
  updates: { name?: string | null; enabled?: boolean; alertMaxC?: number | null }
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }
  if (updates.alertMaxC !== undefined) {
    sets.push('alert_max_c = ?');
    params.push(updates.alertMaxC);
  }

  if (sets.length === 0) return;
  params.push(id);
  db.run(`UPDATE temp_channels SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function updateTempChannelSeen(channelKey: string): void {
  getDb().run(`UPDATE temp_channels SET last_seen_at = ${SQL_NOW_UTC}, unplugged_at = NULL WHERE channel_key = ?`, [
    channelKey,
  ]);
}

export function markTempChannelUnplugged(channelKey: string): void {
  getDb().run(`UPDATE temp_channels SET unplugged_at = ${SQL_NOW_UTC} WHERE channel_key = ? AND unplugged_at IS NULL`, [
    channelKey,
  ]);
}

export function deleteTempChannel(id: number): void {
  const db = getDb();
  db.run('DELETE FROM temperature_readings WHERE channel_id = ?', [id]);
  db.run('DELETE FROM temp_channels WHERE id = ?', [id]);
}

// ── Temperature reading operations ─────────────────────────────────

export interface TempReading {
  id: number;
  run_id: number;
  channel_id: number;
  temp_c: number;
  elapsed_s: number;
  recorded_at: string;
}

export function insertTempReading(runId: number, channelId: number, tempC: number, elapsedS: number): void {
  getDb().run(
    `INSERT INTO temperature_readings (run_id, channel_id, temp_c, elapsed_s)
     VALUES (?, ?, ?, ?)`,
    [runId, channelId, tempC, elapsedS]
  );
}

export function getTempReadingsForRun(
  runId: number
): (TempReading & { channel_key: string; channel_name: string | null })[] {
  return getDb()
    .query<TempReading & { channel_key: string; channel_name: string | null }, [number]>(
      `SELECT tr.*, tc.channel_key, tc.name as channel_name
     FROM temperature_readings tr
     JOIN temp_channels tc ON tr.channel_id = tc.id
     WHERE tr.run_id = ?
     ORDER BY tr.elapsed_s, tc.channel_key`
    )
    .all(runId);
}
