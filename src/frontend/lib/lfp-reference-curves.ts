/**
 * LFP reference curves and OCV-SoC lookup for TS-LFP200AHA cells.
 *
 * Contains:
 * - Datasheet-derived discharge/charge voltage-vs-capacity curves
 * - OCV-SoC lookup table for estimating state of charge from open-circuit voltage
 * - Computed curve generator using the simulation model from sequence-types.ts
 */

import { simulateStep, type StepDCC, type StepCCV } from './sequence-types.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface ReferenceCurve {
  label: string;
  /** Capacity percentage points (0–100) */
  capacityPct: number[];
  /** Voltage at each capacity point */
  voltage: number[];
  /** Visual style hint */
  style: 'datasheet' | 'computed';
}

// ── OCV-SoC lookup table ──────────────────────────────────────────
//
// Open-circuit voltage vs state of charge for LiFePO4 (rested cell).
// Interpolated from TS-LFP200AHA datasheet + published LFP literature.
// SoC 0% = fully discharged, 100% = fully charged.
//
// NOTE: LFP has a very flat OCV plateau between ~20–80% SoC (~3.22–3.30V),
// making SOC estimation from voltage inherently imprecise in that range.

const OCV_SOC_TABLE: [soc: number, voltage: number][] = [
  [0, 2.50],
  [2, 2.70],
  [5, 2.90],
  [8, 3.05],
  [10, 3.15],
  [15, 3.20],
  [20, 3.23],
  [25, 3.25],
  [30, 3.26],
  [40, 3.27],
  [50, 3.28],
  [60, 3.29],
  [70, 3.30],
  [80, 3.31],
  [85, 3.32],
  [90, 3.34],
  [95, 3.38],
  [97, 3.42],
  [99, 3.50],
  [100, 3.60],
];

/**
 * Estimate SoC (0–100) from open-circuit voltage.
 * Uses linear interpolation through the OCV-SoC table.
 * Returns clamped 0–100.
 */
export function ocvToSoc(voltage: number): number {
  const table = OCV_SOC_TABLE;
  if (voltage <= table[0][1]) return 0;
  if (voltage >= table[table.length - 1][1]) return 100;

  for (let i = 1; i < table.length; i++) {
    const [soc1, v1] = table[i - 1];
    const [soc2, v2] = table[i];
    if (voltage <= v2) {
      const t = (voltage - v1) / (v2 - v1);
      return soc1 + t * (soc2 - soc1);
    }
  }
  return 100;
}

/**
 * Get OCV for a given SoC (0–100).
 * Inverse of ocvToSoc — linear interpolation.
 */
export function socToOcv(soc: number): number {
  const table = OCV_SOC_TABLE;
  if (soc <= 0) return table[0][1];
  if (soc >= 100) return table[table.length - 1][1];

  for (let i = 1; i < table.length; i++) {
    const [soc1, v1] = table[i - 1];
    const [soc2, v2] = table[i];
    if (soc <= soc2) {
      const t = (soc - soc1) / (soc2 - soc1);
      return v1 + t * (v2 - v1);
    }
  }
  return table[table.length - 1][1];
}

// ── Datasheet reference curves ────────────────────────────────────
//
// Digitized from TS-LFP200AHA datasheet, room temperature (~23°C).
// Discharge at 0.5C (100A) and charge at 0.5C (100A).
// Capacity% = fraction of nominal capacity delivered/absorbed.

const DATASHEET_DISCHARGE_05C: ReferenceCurve = {
  label: 'Datasheet 0.5C discharge',
  style: 'datasheet',
  capacityPct: [0, 1, 2, 5, 8, 10, 15, 20, 30, 40, 50, 60, 70, 75, 80, 85, 88, 90, 92, 94, 96, 98, 100],
  voltage:     [3.35, 3.32, 3.30, 3.28, 3.27, 3.26, 3.255, 3.25, 3.24, 3.235, 3.23, 3.225, 3.21, 3.20, 3.18, 3.14, 3.08, 3.00, 2.92, 2.82, 2.70, 2.58, 2.50],
};

const DATASHEET_CHARGE_05C: ReferenceCurve = {
  label: 'Datasheet 0.5C charge',
  style: 'datasheet',
  capacityPct: [0, 2, 5, 8, 10, 15, 20, 30, 40, 50, 60, 70, 75, 80, 85, 88, 90, 92, 94, 96, 98, 100],
  voltage:     [2.80, 3.10, 3.20, 3.25, 3.28, 3.30, 3.31, 3.32, 3.325, 3.33, 3.335, 3.34, 3.345, 3.35, 3.36, 3.38, 3.40, 3.43, 3.48, 3.52, 3.58, 3.65],
};

export function getDatasheetCurves(): ReferenceCurve[] {
  return [DATASHEET_DISCHARGE_05C, DATASHEET_CHARGE_05C];
}

// ── Computed reference curves ─────────────────────────────────────
//
// Generated using the LFP simulation model from sequence-types.ts.
// These match what the sequence editor preview shows.

/**
 * Generate a computed discharge curve using the simulation model.
 * Simulates a D-CC step from fully charged to cutoff.
 */
export function computeDischargeRef(
  currentA: number = 40,
  cutoffV: number = 2.50,
  capacityAh: number = 200,
  numPoints: number = 100,
): ReferenceCurve {
  const step: StepDCC = { type: 'd-cc', currentA, cutoffV };
  const startV = 3.35; // OCV at 100% SoC under load
  const pts = simulateStep(step, startV, numPoints, capacityAh);

  const capacityPct = pts.map(p => p.f * 100);
  const voltage = pts.map(p => p.v);

  return {
    label: `Computed ${(currentA / capacityAh).toFixed(1)}C discharge`,
    style: 'computed',
    capacityPct,
    voltage,
  };
}

/**
 * Generate a computed charge curve using the simulation model.
 * Simulates a C-CV step from empty to full.
 */
export function computeChargeRef(
  currentA: number = 40,
  targetV: number = 3.65,
  cutoffCurrentA: number = 2.0,
  capacityAh: number = 200,
  numPoints: number = 100,
): ReferenceCurve {
  const step: StepCCV = { type: 'c-cv', currentA, targetV, cutoffCurrentA };
  const startV = 2.80; // OCV near 0% SoC under load
  const pts = simulateStep(step, startV, numPoints, capacityAh);

  const capacityPct = pts.map(p => p.f * 100);
  const voltage = pts.map(p => p.v);

  return {
    label: `Computed ${(currentA / capacityAh).toFixed(1)}C charge`,
    style: 'computed',
    capacityPct,
    voltage,
  };
}

/**
 * Get the default set of reference curves for the capacity chart.
 * Includes both datasheet and computed curves.
 */
export function getDefaultReferenceCurves(capacityAh: number = 200): ReferenceCurve[] {
  return [
    ...getDatasheetCurves(),
    computeDischargeRef(40, 2.50, capacityAh),
    computeChargeRef(40, 3.65, 2.0, capacityAh),
  ];
}
