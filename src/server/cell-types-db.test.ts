import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createCellGroup,
  deleteCellGroup,
  getCellById,
  getCellGroupsWithUsage,
  initDb,
  resolveCellCapacityAh,
  runMigrations,
  setCellGroup,
  upsertCell,
} from './db.ts';

/**
 * A cell's capacity comes from its type and nowhere else. These tests pin the
 * behaviours that make that safe: the migration that moved existing cells
 * onto their type, the refusal to guess a capacity, and the refusal to delete
 * a type something still depends on.
 */

const LFP = {
  name: 'TS-LFP200AHA',
  nominalCapacityMah: 200_000,
  chemistry: 'LiFePO4',
  chargeVoltageV: 3.65,
  dischargeCutoffV: 2.5,
  chargeCutoffCurrentA: 2,
};
const SMALL = { ...LFP, name: 'EVE LF105', nominalCapacityMah: 105_000, chargeCutoffCurrentA: 1 };

/** Unwrap a query result the test has just inserted, failing loudly if it is missing. */
function must<T>(row: T | null | undefined, what: string): T {
  if (row == null) throw new Error(`expected ${what} to exist`);
  return row;
}

describe('migration v9: capacity moves from the cell to its type', () => {
  function legacyDb(): Database {
    const db = new Database(':memory:');
    runMigrations(db, 8);
    return db;
  }

  function groupId(db: Database, name: string): number {
    return must(db.query<{ id: number }, [string]>('SELECT id FROM cell_groups WHERE name = ?').get(name), name).id;
  }

  function onlyCell(db: Database) {
    return must(
      db
        .query<{ cell_group_id: number | null; nominal_capacity_mah: number | null; chemistry: string | null }, []>(
          'SELECT cell_group_id, nominal_capacity_mah, chemistry FROM cells'
        )
        .get(),
      'the cell'
    );
  }

  test('an untyped cell whose stored capacity matches exactly one type gets that type', () => {
    const db = legacyDb();
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('LFP200', 200000, 'LiFePO4')");
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('asdf', 100000, 'LiFePO4')");
    // Column DEFAULTs give it 200000 / 'LiFePO4' — exactly the live-DB shape
    db.run("INSERT INTO cells (barcode) VALUES ('C-001')");

    runMigrations(db);

    const row = onlyCell(db);
    expect(row.cell_group_id).toBe(groupId(db, 'LFP200'));
    expect(row.nominal_capacity_mah).toBeNull();
    expect(row.chemistry).toBeNull();
  });

  test('two types with the same capacity leave the cell untyped rather than pick one', () => {
    const db = legacyDb();
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('A', 200000, 'LiFePO4')");
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('B', 200000, 'Li-ion')");
    db.run("INSERT INTO cells (barcode) VALUES ('C-001')");

    runMigrations(db);

    expect(onlyCell(db).cell_group_id).toBeNull();
  });

  test('a cell that already had a type keeps it', () => {
    const db = legacyDb();
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('A', 200000, 'LiFePO4')");
    db.run("INSERT INTO cell_groups (name, nominal_capacity_mah, chemistry) VALUES ('B', 50000, 'LiFePO4')");
    const b = groupId(db, 'B');
    db.run('INSERT INTO cells (barcode, cell_group_id) VALUES (?, ?)', ['C-001', b]);

    runMigrations(db);

    expect(onlyCell(db).cell_group_id).toBe(b);
  });
});

describe('cells and types after v9', () => {
  beforeEach(() => {
    initDb(':memory:');
  });
  afterEach(() => {
    closeDb();
  });

  test('a new cell never inherits the legacy 200 Ah column default', () => {
    createCellGroup(LFP);
    createCellGroup(SMALL);
    const cell = upsertCell('C-001');
    expect(cell.nominal_capacity_mah).toBeNull();
    expect(cell.chemistry).toBeNull();
  });

  test('with exactly one type, a new cell is assigned to it; with two, the choice is left open', () => {
    const only = createCellGroup(LFP);
    expect(upsertCell('C-001').cell_group_id).toBe(only.id);

    createCellGroup(SMALL);
    expect(upsertCell('C-002').cell_group_id).toBeNull();
  });

  test('capacity resolves through the type and is unknown otherwise', () => {
    createCellGroup(LFP);
    const small = createCellGroup(SMALL);
    const cell = upsertCell('C-001');

    expect(resolveCellCapacityAh(cell.id)).toBeNull();
    expect(resolveCellCapacityAh(null)).toBeNull();

    setCellGroup(cell.id, small.id);
    expect(resolveCellCapacityAh(cell.id)).toBe(105);
    expect(getCellById(cell.id)?.cell_group_id).toBe(small.id);
  });

  test('a type in use cannot be deleted; an unused one can', () => {
    const lfp = createCellGroup(LFP);
    const small = createCellGroup(SMALL);
    const cell = upsertCell('C-001');
    setCellGroup(cell.id, lfp.id);

    expect(deleteCellGroup(lfp.id)).toEqual({ deleted: false, usage: { cell_count: 1, sequence_count: 0 } });
    expect(getCellGroupsWithUsage().map(g => [g.name, g.cell_count])).toEqual([
      ['EVE LF105', 0],
      ['TS-LFP200AHA', 1],
    ]);

    expect(deleteCellGroup(small.id).deleted).toBe(true);
    expect(getCellGroupsWithUsage()).toHaveLength(1);
  });
});
