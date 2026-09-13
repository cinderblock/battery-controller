/**
 * Cell types — the per-chemistry facts a cell type carries, and the rules for
 * entering them safely.
 *
 * A cell type (the `cell_groups` table) is the single source of nominal
 * capacity and voltage limits for every cell assigned to it. C-rate steps
 * multiply by the type's capacity; the manual-start form and the step palette
 * seed their voltages from the type. Getting these numbers wrong is how a cell
 * gets over-charged or driven at the wrong current, so both the server and the
 * UI validate through this one module.
 *
 * Voltages are per cell. A multi-cell pack tested as one unit should use
 * "Other", which only enforces generic sanity bounds.
 */

export const CHEMISTRIES = ['LiFePO4', 'Li-ion', 'LiPo', 'NiMH', 'Lead-acid', 'Other'] as const;
export type Chemistry = (typeof CHEMISTRIES)[number];

export function isChemistry(value: unknown): value is Chemistry {
  return typeof value === 'string' && (CHEMISTRIES as readonly string[]).includes(value);
}

/** Inclusive [min, max] in volts. */
export type VoltageRange = readonly [number, number];

export interface VoltageWindow {
  /** Values a datasheet would give; outside this is a warning. */
  typical: VoltageRange;
  /** Values beyond which the entry is refused outright. */
  hard: VoltageRange;
}

export interface ChemistryProfile {
  /** CC-CV charge target (per cell) */
  charge: VoltageWindow;
  /** Discharge cutoff (per cell) */
  cutoff: VoltageWindow;
}

/**
 * Per-cell windows. "typical" spans what datasheets across the chemistry
 * actually specify; "hard" is wide enough for deliberate derating or a
 * slightly unusual variant, but stops an obvious slip (a 4.2 V target on an
 * LFP cell, a 2.5 V cutoff on NiMH).
 */
export const CHEMISTRY_PROFILES: Record<Chemistry, ChemistryProfile> = {
  LiFePO4: {
    charge: { typical: [3.5, 3.65], hard: [3.3, 3.8] },
    cutoff: { typical: [2.5, 2.8], hard: [2.0, 3.2] },
  },
  'Li-ion': {
    charge: { typical: [4.1, 4.2], hard: [3.8, 4.3] },
    cutoff: { typical: [2.75, 3.0], hard: [2.5, 3.5] },
  },
  LiPo: {
    charge: { typical: [4.2, 4.2], hard: [3.8, 4.35] },
    cutoff: { typical: [3.0, 3.3], hard: [2.5, 3.5] },
  },
  NiMH: {
    charge: { typical: [1.45, 1.5], hard: [1.2, 1.7] },
    cutoff: { typical: [0.9, 1.0], hard: [0.8, 1.2] },
  },
  'Lead-acid': {
    charge: { typical: [2.35, 2.45], hard: [2.2, 2.6] },
    cutoff: { typical: [1.75, 1.85], hard: [1.6, 2.0] },
  },
  Other: {
    charge: { typical: [0.5, 30], hard: [0.5, 30] },
    cutoff: { typical: [0.1, 30], hard: [0.1, 30] },
  },
};

/** Sanity cap on nominal capacity — nothing this rig tests is over 10 kAh. */
export const MAX_CAPACITY_MAH = 10_000_000;
export const MAX_NAME_LENGTH = 64;

/** What the create / edit endpoints and the form work with. */
export interface CellTypeInput {
  name: string;
  chemistry: string;
  nominalCapacityMah: number;
  chargeVoltageV: number;
  dischargeCutoffV: number;
  chargeCutoffCurrentA: number;
}

export type CellTypeField = keyof CellTypeInput;

export interface ValidationIssue {
  field: CellTypeField;
  /** Errors block saving; warnings are shown and saved anyway. */
  severity: 'error' | 'warning';
  message: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fmtRange([lo, hi]: VoltageRange): string {
  return lo === hi ? `${lo} V` : `${lo}–${hi} V`;
}

function checkVoltage(
  field: CellTypeField,
  label: string,
  value: unknown,
  window: VoltageWindow,
  out: ValidationIssue[]
): value is number {
  if (!isFiniteNumber(value)) {
    out.push({ field, severity: 'error', message: `${label} is required` });
    return false;
  }
  const [hardLo, hardHi] = window.hard;
  if (value < hardLo || value > hardHi) {
    out.push({ field, severity: 'error', message: `${label} must be within ${fmtRange(window.hard)}` });
    return false;
  }
  const [typLo, typHi] = window.typical;
  if (value < typLo || value > typHi) {
    out.push({ field, severity: 'warning', message: `${label} is outside the usual ${fmtRange(window.typical)}` });
  }
  return true;
}

/**
 * Validate a cell type. Returns every issue found; the entry is acceptable
 * when no issue has severity 'error'. Chemistry-specific windows come from
 * CHEMISTRY_PROFILES; cross-field rules (charge above cutoff, cutoff current
 * below 1C) apply to every chemistry.
 */
export function validateCellType(input: Partial<CellTypeInput>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) issues.push({ field: 'name', severity: 'error', message: 'Name is required' });
  else if (name.length > MAX_NAME_LENGTH) {
    issues.push({ field: 'name', severity: 'error', message: `Name must be ${MAX_NAME_LENGTH} characters or fewer` });
  }

  if (!isChemistry(input.chemistry)) {
    issues.push({ field: 'chemistry', severity: 'error', message: 'Pick a chemistry' });
  }
  // Unknown chemistry still gets generic bounds so the rest of the form is checked
  const profile = CHEMISTRY_PROFILES[isChemistry(input.chemistry) ? input.chemistry : 'Other'];

  const cap = input.nominalCapacityMah;
  const capOk = isFiniteNumber(cap) && cap > 0 && cap <= MAX_CAPACITY_MAH;
  if (!capOk) {
    issues.push({
      field: 'nominalCapacityMah',
      severity: 'error',
      message: `Capacity must be between 0 and ${MAX_CAPACITY_MAH / 1000} Ah`,
    });
  }

  const chargeOk = checkVoltage('chargeVoltageV', 'Charge voltage', input.chargeVoltageV, profile.charge, issues);
  const cutoffOk = checkVoltage('dischargeCutoffV', 'Discharge cutoff', input.dischargeCutoffV, profile.cutoff, issues);
  if (chargeOk && cutoffOk && (input.chargeVoltageV as number) <= (input.dischargeCutoffV as number)) {
    issues.push({
      field: 'chargeVoltageV',
      severity: 'error',
      message: 'Charge voltage must be above the discharge cutoff',
    });
  }

  const cutA = input.chargeCutoffCurrentA;
  if (!isFiniteNumber(cutA) || cutA <= 0) {
    issues.push({ field: 'chargeCutoffCurrentA', severity: 'error', message: 'Charge cutoff current is required' });
  } else if (capOk) {
    const cRate = cutA / ((cap as number) / 1000);
    if (cRate > 1) {
      issues.push({
        field: 'chargeCutoffCurrentA',
        severity: 'error',
        message: 'Charge cutoff current is above 1C — the charge would end immediately',
      });
    } else if (cRate > 0.2) {
      issues.push({
        field: 'chargeCutoffCurrentA',
        severity: 'warning',
        message: `Charge cutoff current is ${cRate.toFixed(2)}C; 0.02–0.1C is usual`,
      });
    }
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some(i => i.severity === 'error');
}

/**
 * Typical values for a chemistry — what the type form pre-fills when the
 * chemistry chip is tapped, so a new type starts from a sane place instead of
 * from another chemistry's numbers.
 */
export function suggestedVoltages(chemistry: Chemistry): { chargeVoltageV: number; dischargeCutoffV: number } {
  const p = CHEMISTRY_PROFILES[chemistry];
  return { chargeVoltageV: p.charge.typical[1], dischargeCutoffV: p.cutoff.typical[0] };
}
