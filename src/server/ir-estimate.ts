/**
 * DC internal-resistance estimation from run data points.
 *
 * The device reports one idle reading (I=0, V=rest) before load current
 * starts, and readings arrive every ~2s, so every charge/discharge run
 * contains at least one sharp current step. Each step where |ΔI| is large
 * enough and the timestamps are close together gives an IR sample
 * R = ΔV/ΔI; the run's estimate is the median of accepted samples.
 *
 * This is a ~2s-timescale DC-IR (it includes some fast polarization on top
 * of pure ohmic resistance), which is what matters for "how much does the
 * voltage sag at X amps" — good for ranking cells and tracking recovery,
 * not a spec-sheet 1kHz AC-IR.
 */

/** Minimum current step to accept a sample — small steps drown in the 1mV/10mA quantization */
const MIN_STEP_A = 5;
/** Maximum time between the two points of a step — beyond this, SOC/relaxation drift dominates */
const MAX_STEP_DT_S = 5;
/** Reject samples outside plausible bounds (mΩ) — protects against glitched readings */
const MAX_PLAUSIBLE_MOHM = 1000;

import { logger } from '../utils/logger.ts';
import {
  getDataPointsForRun,
  getRunsNeedingHeat,
  getRunsNeedingIr,
  getSetting,
  setRunHeatMwh,
  setRunIrMohm,
  setSetting,
} from './db.ts';

export interface IrEstimate {
  /** Median DC internal resistance in milliohms */
  mohm: number;
  /** Number of current-step samples the median was taken over */
  samples: number;
}

interface IrPoint {
  elapsed_s: number;
  voltage_v: number;
  current_a: number;
}

/** Run modes that carry current and can yield an IR estimate */
export function modeSupportsIr(mode: string): boolean {
  return mode === 'c-cv' || mode === 'd-cc' || mode === 'd-cp';
}

/**
 * Estimate DC internal resistance from a run's data points.
 *
 * `mode` determines the expected sign: current_a is an unsigned magnitude,
 * so on a charge step voltage rises with current (ΔV/ΔI > 0) while on a
 * discharge step it falls (ΔV/ΔI < 0). Steps with the wrong sign are
 * rejected rather than folded in with abs() — a wrong-signed "step" means
 * the voltage moved for some other reason (e.g. mode transition glitch).
 *
 * Returns null when the run has no usable current step.
 */
export function estimateIrMohm(points: IrPoint[], mode: string): IrEstimate | null {
  if (!modeSupportsIr(mode)) return null;

  const sign = mode.startsWith('c-') ? 1 : -1;
  const samples: number[] = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    const dI = curr.current_a - prev.current_a;
    if (Math.abs(dI) < MIN_STEP_A) continue;

    const dt = curr.elapsed_s - prev.elapsed_s;
    if (dt < 0 || dt > MAX_STEP_DT_S) continue;

    const rMohm = (sign * (curr.voltage_v - prev.voltage_v) * 1000) / dI;
    if (rMohm <= 0 || rMohm > MAX_PLAUSIBLE_MOHM) continue;

    samples.push(rMohm);
  }

  if (samples.length === 0) return null;

  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const median = samples.length % 2 !== 0 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;

  return { mohm: Math.round(median * 100) / 100, samples: samples.length };
}

// ── Ohmic heat estimation ───────────────────────────────────────────

/**
 * Integrate I²R over a run's data points → ohmic heat energy in mWh.
 *
 * Uses the run's DC-IR estimate, so this captures ohmic plus fast
 * polarization losses at the ~2s timescale — the dominant loss term for
 * these cells. It ignores slower overpotential and entropic heat, so
 * treat it as a floor on total heating. Charge: stored ≈ energy − heat.
 * Discharge: drawn from the cell ≈ energy + heat.
 *
 * Trapezoidal on I² between consecutive samples. Returns null when there
 * aren't at least two points or R isn't usable.
 */
export function estimateHeatMwh(points: IrPoint[], irMohm: number): number | null {
  if (!(irMohm > 0) || points.length < 2) return null;

  const r = irMohm / 1000; // Ω
  let joules = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].elapsed_s - points[i - 1].elapsed_s;
    if (dt <= 0) continue;
    const iSqAvg = (points[i].current_a ** 2 + points[i - 1].current_a ** 2) / 2;
    joules += iSqAvg * r * dt;
  }
  return Math.round((joules / 3.6) * 100) / 100; // J → mWh
}

const BACKFILL_KEY = 'ir_backfill_v1';
const HEAT_BACKFILL_KEY = 'heat_backfill_v1';

/**
 * One-time backfill: compute IR for runs recorded before the ir_mohm column
 * existed. Guarded by a settings flag so historical runs with no usable
 * current step (stored as 0) aren't rescanned on every boot.
 */
export function backfillIrEstimates(): void {
  if (getSetting(BACKFILL_KEY) !== '1') {
    const runs = getRunsNeedingIr();
    let estimated = 0;
    for (const run of runs) {
      const ir = estimateIrMohm(getDataPointsForRun(run.id), run.mode);
      setRunIrMohm(run.id, ir?.mohm ?? 0);
      if (ir) estimated++;
    }
    setSetting(BACKFILL_KEY, '1');
    if (runs.length > 0) {
      logger.info(`IR backfill: estimated ${estimated} of ${runs.length} historical run(s)`);
    }
  }

  if (getSetting(HEAT_BACKFILL_KEY) !== '1') {
    const runs = getRunsNeedingHeat();
    let estimated = 0;
    for (const run of runs) {
      const heat = estimateHeatMwh(getDataPointsForRun(run.id), run.ir_mohm ?? 0);
      setRunHeatMwh(run.id, heat ?? 0);
      if (heat !== null) estimated++;
    }
    setSetting(HEAT_BACKFILL_KEY, '1');
    if (runs.length > 0) {
      logger.info(`Heat backfill: estimated ${estimated} of ${runs.length} historical run(s)`);
    }
  }
}
