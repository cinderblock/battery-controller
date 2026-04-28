/**
 * SQLite data layer using bun:sqlite
 *
 * Stores cells, test runs, data points, cycle programs, and settings.
 * Uses WAL mode for concurrent read/write and crash resilience.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../utils/logger.ts';

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

  const currentVersion = db.query<{ version: number }, []>(
    'SELECT MAX(version) as version FROM schema_version'
  ).get()?.version ?? 0;

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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
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
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  const existing = db.query<Cell, [string]>(
    'SELECT * FROM cells WHERE barcode = ?'
  ).get(barcode);

  if (existing) {
    if (label !== undefined) {
      db.run('UPDATE cells SET label = ?, updated_at = datetime(\'now\') WHERE id = ?', [label, existing.id]);
      existing.label = label;
    }
    return existing;
  }

  const result = db.run(
    'INSERT INTO cells (barcode, label) VALUES (?, ?)',
    [barcode, label ?? null]
  );
  return db.query<Cell, [number]>('SELECT * FROM cells WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
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

  sets.push("updated_at = datetime('now')");
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
  return db.query<TestRun, [number]>('SELECT * FROM test_runs WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
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
       ended_at = datetime('now'),
       end_reason = ?, final_capacity_mah = ?, final_energy_mwh = ?,
       peak_voltage_v = ?, min_voltage_v = ?, peak_current_a = ?,
       duration_s = ?, data_point_count = ?
     WHERE id = ?`,
    [endReason, finalCapacityMah, finalEnergyMwh, peakVoltageV, minVoltageV, peakCurrentA, durationS, dataPointCount, runId]
  );
}

export function getTestRunsForCell(cellId: number): TestRun[] {
  return getDb().query<TestRun, [number]>(
    'SELECT * FROM test_runs WHERE cell_id = ? ORDER BY started_at DESC'
  ).all(cellId);
}

export function getTestRun(id: number): TestRun | null {
  return getDb().query<TestRun, [number]>('SELECT * FROM test_runs WHERE id = ?').get(id) ?? null;
}

export function getRecentTestRuns(limit: number = 50): TestRun[] {
  return getDb().query<TestRun, [number]>(
    'SELECT * FROM test_runs ORDER BY started_at DESC LIMIT ?'
  ).all(limit);
}

/** Mark incomplete runs from a previous crash as service_restart */
export function markIncompleteRuns(): number {
  const result = getDb().run(
    `UPDATE test_runs SET ended_at = datetime('now'), end_reason = 'service_restart'
     WHERE ended_at IS NULL`
  );
  return result.changes;
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
  insertDataPointStmt.get(getDb()).run(
    runId, elapsedS, voltageV, currentA, powerW, capacityMah, energyMwh, stateByte
  );
}

export function getDataPointsForRun(runId: number): DataPoint[] {
  return getDb().query<DataPoint, [number]>(
    'SELECT * FROM data_points WHERE run_id = ? ORDER BY elapsed_s'
  ).all(runId);
}

/**
 * Compact data point row: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh]
 * Avoids repeating key names for every point — cuts payload size 60-80%.
 */
export type CompactDataRow = [number, number, number, number, number, number];

export interface RunWithCompactData extends TestRun {
  /** Column order: [elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh] */
  d: CompactDataRow[];
}

/** Fetch recent runs with compact data points in one go */
export function getRecentRunsWithData(limit: number = 50): RunWithCompactData[] {
  const db = getDb();
  const runs = db.query<TestRun, [number]>(
    'SELECT * FROM test_runs ORDER BY started_at DESC LIMIT ?'
  ).all(limit);

  if (runs.length === 0) return [];

  // Single query for only the columns we need, in compact form
  const runIds = runs.map(r => r.id);
  const placeholders = runIds.map(() => '?').join(',');
  const allPoints = db.query<{ run_id: number; elapsed_s: number; voltage_v: number; current_a: number; power_w: number; capacity_mah: number; energy_mwh: number }, number[]>(
    `SELECT run_id, elapsed_s, voltage_v, current_a, power_w, capacity_mah, energy_mwh
     FROM data_points WHERE run_id IN (${placeholders}) ORDER BY run_id, elapsed_s`
  ).all(...runIds);

  // Group as compact arrays by run_id
  const pointsByRun = new Map<number, CompactDataRow[]>();
  for (const p of allPoints) {
    let arr = pointsByRun.get(p.run_id);
    if (!arr) { arr = []; pointsByRun.set(p.run_id, arr); }
    arr.push([p.elapsed_s, p.voltage_v, p.current_a, p.power_w, p.capacity_mah, p.energy_mwh]);
  }

  return runs.map(run => ({
    ...run,
    d: pointsByRun.get(run.id) ?? [],
  }));
}

export function getDataPointCount(runId: number): number {
  return getDb().query<{ count: number }, [number]>(
    'SELECT COUNT(*) as count FROM data_points WHERE run_id = ?'
  ).get(runId)?.count ?? 0;
}

/** Find the most recent run closed by service_restart with matching mode */
export function getLastServiceRestartRun(mode: string): TestRun | null {
  return getDb().query<TestRun, [string]>(
    `SELECT * FROM test_runs
     WHERE end_reason = 'service_restart' AND mode = ?
     ORDER BY id DESC LIMIT 1`
  ).get(mode) ?? null;
}

/** Get the last data point for a run (by insertion order) */
export function getLastDataPointForRun(runId: number): DataPoint | null {
  return getDb().query<DataPoint, [number]>(
    'SELECT * FROM data_points WHERE run_id = ? ORDER BY id DESC LIMIT 1'
  ).get(runId) ?? null;
}

/** Get aggregate peak/min stats from all data points in a run */
export function getRunPeakStats(runId: number): { peakVoltage: number; minVoltage: number; peakCurrent: number } | null {
  const row = getDb().query<{ peak_v: number; min_v: number; peak_i: number }, [number]>(
    `SELECT MAX(voltage_v) as peak_v, MIN(voltage_v) as min_v, MAX(current_a) as peak_i
     FROM data_points WHERE run_id = ?`
  ).get(runId);
  if (!row || row.peak_v == null) return null;
  return { peakVoltage: row.peak_v, minVoltage: row.min_v, peakCurrent: row.peak_i };
}

/** Reopen a service_restart run for continued recording */
export function reopenRun(runId: number): void {
  getDb().run(
    'UPDATE test_runs SET ended_at = NULL, end_reason = NULL WHERE id = ?',
    [runId]
  );
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
  const result = db.run(
    'INSERT INTO sequences (name, steps_json, cell_group_id) VALUES (?, ?, ?)',
    [name, stepsJson, cellGroupId ?? null]
  );
  return db.query<Sequence, [number]>('SELECT * FROM sequences WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
}

export function updateSequence(id: number, name: string, stepsJson: string): void {
  getDb().run(
    'UPDATE sequences SET name = ?, steps_json = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [name, stepsJson, id]
  );
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
  const result = db.run(
    'INSERT INTO cycle_programs (cell_id, name, steps_json) VALUES (?, ?, ?)',
    [cellId, name, stepsJson]
  );
  return db.query<CycleProgram, [number]>('SELECT * FROM cycle_programs WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
}

export function updateCycleProgram(id: number, updates: Partial<Pick<CycleProgram, 'status' | 'current_step' | 'current_cycle' | 'started_at' | 'ended_at'>>): void {
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
  return getDb().query<CycleProgram, []>(
    'SELECT * FROM cycle_programs WHERE status = \'running\' LIMIT 1'
  ).get() ?? null;
}

export function getCycleProgram(id: number): CycleProgram | null {
  return getDb().query<CycleProgram, [number]>(
    'SELECT * FROM cycle_programs WHERE id = ?'
  ).get(id) ?? null;
}

/** All test runs for a cycle program, ordered by start time */
export function getRunsForCycleProgram(programId: number): TestRun[] {
  return getDb().query<TestRun, [number]>(
    'SELECT * FROM test_runs WHERE cycle_program_id = ? ORDER BY started_at ASC'
  ).all(programId);
}

/** Get the most recent test run for a specific cycle step (used for wait resume) */
export function getCycleStepRun(programId: number, stepIndex: number): TestRun | null {
  return getDb().query<TestRun, [number, number]>(
    'SELECT * FROM test_runs WHERE cycle_program_id = ? AND cycle_step_index = ? ORDER BY started_at DESC LIMIT 1'
  ).get(programId, stepIndex) ?? null;
}

// ── Settings operations ─────────────────────────────────────────────

export function getSetting(key: string): string | null {
  return getDb().query<{ value: string }, [string]>(
    'SELECT value FROM settings WHERE key = ?'
  ).get(key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, value]
  );
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
  return getDb().query<Cell, [number]>(
    'SELECT * FROM cells WHERE cell_group_id = ? ORDER BY label, barcode'
  ).all(groupId);
}

export function setCellGroup(cellId: number, groupId: number | null): void {
  getDb().run(
    'UPDATE cells SET cell_group_id = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [groupId, cellId]
  );
}

/** Completed discharge runs for a cell, ordered by date (excludes setup/teardown) */
export function getCompletedDischargeRuns(cellId: number): TestRun[] {
  return getDb().query<TestRun, [number]>(
    `SELECT * FROM test_runs
     WHERE cell_id = ? AND mode = 'd-cc'
       AND final_capacity_mah IS NOT NULL AND final_capacity_mah > 0
       AND ended_at IS NOT NULL
       AND (exclude_from_capacity IS NULL OR exclude_from_capacity = 0)
     ORDER BY started_at ASC`
  ).all(cellId);
}

/** All completed discharge runs (for fleet analysis, excludes setup/teardown) */
export function getAllCompletedDischargeRuns(): TestRun[] {
  return getDb().query<TestRun, []>(
    `SELECT * FROM test_runs
     WHERE mode = 'd-cc'
       AND final_capacity_mah IS NOT NULL AND final_capacity_mah > 0
       AND ended_at IS NOT NULL
       AND (exclude_from_capacity IS NULL OR exclude_from_capacity = 0)
     ORDER BY started_at ASC`
  ).all();
}

export function ensureDefaultCellGroup(): CellGroup {
  const db = getDb();
  const existing = db.query<CellGroup, [string]>(
    'SELECT * FROM cell_groups WHERE name = ?'
  ).get('TS-LFP200AHA');

  if (existing) return existing;

  const result = db.run(
    `INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry, charge_voltage_v, discharge_cutoff_v, charge_cutoff_current_a)
     VALUES ('TS-LFP200AHA', 200000, 'LiFePO4', 3.65, 2.50, 2.00)`
  );
  return db.query<CellGroup, [number]>('SELECT * FROM cell_groups WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
}

export function createCellGroup(
  name: string,
  nominalCapacityMah: number,
  chemistry: string,
  chargeVoltageV?: number | null,
  dischargeCutoffV?: number | null,
  chargeCutoffCurrentA?: number | null,
): CellGroup {
  const db = getDb();
  const result = db.run(
    `INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry, charge_voltage_v, discharge_cutoff_v, charge_cutoff_current_a)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, nominalCapacityMah, chemistry, chargeVoltageV ?? null, dischargeCutoffV ?? null, chargeCutoffCurrentA ?? null]
  );
  return db.query<CellGroup, [number]>('SELECT * FROM cell_groups WHERE id = ?').get(
    result.lastInsertRowid as number
  )!;
}
