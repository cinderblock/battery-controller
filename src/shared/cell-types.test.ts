import { describe, expect, test } from 'bun:test';
import { type CellTypeInput, hasErrors, suggestedVoltages, validateCellType } from './cell-types.ts';

const LFP_200: CellTypeInput = {
  name: 'TS-LFP200AHA',
  chemistry: 'LiFePO4',
  nominalCapacityMah: 200_000,
  chargeVoltageV: 3.65,
  dischargeCutoffV: 2.5,
  chargeCutoffCurrentA: 2,
};

function fields(input: Partial<CellTypeInput>, severity?: 'error' | 'warning'): string[] {
  return validateCellType(input)
    .filter(i => !severity || i.severity === severity)
    .map(i => i.field);
}

describe('validateCellType', () => {
  test('a datasheet-correct LFP type has no issues', () => {
    expect(validateCellType(LFP_200)).toEqual([]);
  });

  test('every field is required', () => {
    const errs = fields({}, 'error');
    expect(errs).toContain('name');
    expect(errs).toContain('chemistry');
    expect(errs).toContain('nominalCapacityMah');
    expect(errs).toContain('chargeVoltageV');
    expect(errs).toContain('dischargeCutoffV');
    expect(errs).toContain('chargeCutoffCurrentA');
  });

  test('a Li-ion charge target on an LFP cell is refused, not warned', () => {
    const issues = validateCellType({ ...LFP_200, chargeVoltageV: 4.2 });
    expect(issues).toEqual([expect.objectContaining({ field: 'chargeVoltageV', severity: 'error' })]);
  });

  test('a deliberate derate inside the hard window is a warning only', () => {
    const issues = validateCellType({ ...LFP_200, chargeVoltageV: 3.45 });
    expect(hasErrors(issues)).toBe(false);
    expect(issues).toEqual([expect.objectContaining({ field: 'chargeVoltageV', severity: 'warning' })]);
  });

  test('charge voltage must sit above the discharge cutoff', () => {
    // Chemistry windows already keep charge above cutoff for the named
    // chemistries; "Other" has none, so the ordering rule is the only guard.
    const issues = validateCellType({
      name: 'pack',
      chemistry: 'Other',
      nominalCapacityMah: 5000,
      chargeVoltageV: 3.0,
      dischargeCutoffV: 3.5,
      chargeCutoffCurrentA: 0.1,
    });
    expect(issues).toEqual([
      expect.objectContaining({ field: 'chargeVoltageV', severity: 'error', message: expect.stringMatching(/above/) }),
    ]);
  });

  test('cutoff current above 1C is an error, above 0.2C a warning', () => {
    expect(fields({ ...LFP_200, chargeCutoffCurrentA: 250 }, 'error')).toEqual(['chargeCutoffCurrentA']);
    expect(fields({ ...LFP_200, chargeCutoffCurrentA: 60 }, 'warning')).toEqual(['chargeCutoffCurrentA']);
    expect(fields({ ...LFP_200, chargeCutoffCurrentA: 60 }, 'error')).toEqual([]);
  });

  test('windows are per chemistry: 1.5 V is fine for NiMH and refused for LFP', () => {
    const nimh = validateCellType({
      name: 'AA',
      chemistry: 'NiMH',
      nominalCapacityMah: 2000,
      chargeVoltageV: 1.5,
      dischargeCutoffV: 1.0,
      chargeCutoffCurrentA: 0.1,
    });
    expect(nimh).toEqual([]);
    expect(fields({ ...LFP_200, chargeVoltageV: 1.5 }, 'error')).toEqual(['chargeVoltageV']);
  });

  test('Other only applies generic sanity bounds', () => {
    const pack = validateCellType({
      name: '12 V pack',
      chemistry: 'Other',
      nominalCapacityMah: 7000,
      chargeVoltageV: 14.4,
      dischargeCutoffV: 10.5,
      chargeCutoffCurrentA: 0.35,
    });
    expect(pack).toEqual([]);
  });

  test('unknown chemistry is an error but the other fields are still checked', () => {
    const errs = fields({ ...LFP_200, chemistry: 'Unobtainium', nominalCapacityMah: -1 }, 'error');
    expect(errs).toContain('chemistry');
    expect(errs).toContain('nominalCapacityMah');
  });
});

describe('suggestedVoltages', () => {
  test('pre-fills a chemistry with its own typical numbers', () => {
    expect(suggestedVoltages('LiFePO4')).toEqual({ chargeVoltageV: 3.65, dischargeCutoffV: 2.5 });
    expect(suggestedVoltages('Li-ion')).toEqual({ chargeVoltageV: 4.2, dischargeCutoffV: 2.75 });
  });

  test('suggestions validate cleanly for every chemistry', () => {
    for (const chem of ['LiFePO4', 'Li-ion', 'LiPo', 'NiMH', 'Lead-acid'] as const) {
      const v = suggestedVoltages(chem);
      const issues = validateCellType({
        name: chem,
        chemistry: chem,
        nominalCapacityMah: 10_000,
        ...v,
        chargeCutoffCurrentA: 0.5,
      });
      expect(issues).toEqual([]);
    }
  });
});
