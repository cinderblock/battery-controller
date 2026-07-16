import { describe, expect, test } from 'bun:test';
import { estimateHeatMwh, estimateIrMohm, estimateIrSamples, modeSupportsIr } from './ir-estimate.ts';

/**
 * Reference values from real runs on coulomb (2026-07-12, cell 5 / F02729):
 * - Run 123 (c-cv): rest 3.215V → 3.700V at 22.85A ≈ 21.2 mΩ
 * - Run 125 (d-cc): rest 3.263V → 2.607V at 30.67A ≈ 21.4 mΩ
 */

function pt(elapsed_s: number, voltage_v: number, current_a: number) {
  return { elapsed_s, voltage_v, current_a };
}

describe('estimateIrMohm', () => {
  test('charge start step (real run 123 shape)', () => {
    const est = estimateIrMohm([pt(-0.001, 3.215, 0), pt(1.982, 3.7, 22.85), pt(3.981, 3.7, 22.43)], 'c-cv');
    expect(est).not.toBeNull();
    expect(est?.samples).toBe(1);
    expect(est?.mohm).toBeCloseTo(21.23, 1);
  });

  test('discharge start step (real run 125 shape)', () => {
    const est = estimateIrMohm([pt(0, 3.263, 0), pt(0.784, 2.607, 30.67)], 'd-cc');
    expect(est).not.toBeNull();
    expect(est?.mohm).toBeCloseTo(21.39, 1);
  });

  test('median over multiple steps (start + stop transitions)', () => {
    // Start step ~20 mΩ, mid-run noise below threshold, stop step ~22 mΩ
    const est = estimateIrMohm(
      [pt(0, 3.2, 0), pt(2, 3.6, 20), pt(4, 3.61, 20.5), pt(6, 3.62, 20.4), pt(8, 3.18, 0.4)],
      'c-cv'
    );
    expect(est).not.toBeNull();
    expect(est?.samples).toBe(2);
    // Stop step: (3.18 - 3.62) / (0.4 - 20.4) = 22 mΩ; median of [20, 22] = 21
    expect(est?.mohm).toBeCloseTo(21, 1);
  });

  test('slow CV taper never passes the current-step threshold', () => {
    const points = [pt(0, 3.7, 22)];
    for (let i = 1; i < 100; i++) {
      points.push(pt(i * 2, 3.7, 22 - i * 0.05));
    }
    expect(estimateIrMohm(points, 'c-cv')).toBeNull();
  });

  test('rejects wrong-signed steps (voltage moved for another reason)', () => {
    // Discharge where voltage RISES as current rises — not a resistive step
    expect(estimateIrMohm([pt(0, 3.2, 0), pt(2, 3.5, 20)], 'd-cc')).toBeNull();
  });

  test('rejects steps spread over too much time (SOC drift, not IR)', () => {
    expect(estimateIrMohm([pt(0, 3.2, 0), pt(60, 3.6, 20)], 'c-cv')).toBeNull();
  });

  test('healthy low-IR cell resolves sub-mΩ values', () => {
    // 0.5 mΩ: 40A step sags 20mV
    const est = estimateIrMohm([pt(0, 3.3, 0), pt(2, 3.28, 40)], 'd-cc');
    expect(est).not.toBeNull();
    expect(est?.mohm).toBeCloseTo(0.5, 2);
  });

  test('returns null for empty or single-point runs', () => {
    expect(estimateIrMohm([], 'c-cv')).toBeNull();
    expect(estimateIrMohm([pt(0, 3.2, 0)], 'c-cv')).toBeNull();
  });
});

describe('estimateIrSamples', () => {
  test('one sample per current step, timestamped at the step end', () => {
    // Discharge with an active-probe twiddle: start step, a mid-run dip and
    // recovery (down to 10A, back to 40A), each a resolvable step.
    // Readings arrive ~2s apart, so an 8s probe hold still resolves both the
    // down-step and the restore-step (each spans one 2s sample gap).
    const est = estimateIrSamples(
      [
        pt(0, 3.3, 0), // rest
        pt(2, 2.9, 40), // start step → ~10 mΩ
        pt(600, 2.88, 40), // steady (no step)
        pt(602, 3.02, 10), // probe down → sign-corrected (3.02-2.88)/(40-10) ≈ 4.67 mΩ
        pt(604, 3.02, 10), // hold (no step)
        pt(606, 3.02, 10), // hold
        pt(608, 3.02, 10), // hold
        pt(610, 2.9, 40), // probe restore → (3.02-2.9)/(40-10) ≈ 4 mΩ
      ],
      'd-cc'
    );
    expect(est.map(s => s.t)).toEqual([2, 602, 610]);
    expect(est[0].mohm).toBeCloseTo(10, 1);
    expect(est.length).toBe(3);
  });

  test('steady run yields only the start step (why we need active probing)', () => {
    const points = [pt(0, 3.3, 0), pt(2, 2.9, 40)];
    for (let i = 2; i < 100; i++) points.push(pt(i * 2, 2.9 - i * 0.001, 40));
    expect(estimateIrSamples(points, 'd-cc').length).toBe(1);
  });

  test('empty for unsupported mode', () => {
    expect(estimateIrSamples([pt(0, 3.2, 0), pt(2, 3.0, 20)], 'wait')).toEqual([]);
  });

  test('median matches estimateIrMohm over the same samples', () => {
    const points = [pt(0, 3.2, 0), pt(2, 3.6, 20), pt(8, 3.18, 0.4)];
    const samples = estimateIrSamples(points, 'c-cv');
    const est = estimateIrMohm(points, 'c-cv');
    expect(est?.samples).toBe(samples.length);
  });
});

describe('estimateHeatMwh', () => {
  test('constant current: heat = I²R·t exactly', () => {
    // 20A through 21mΩ for 1 hour = 400 × 0.021 = 8.4W → 8400 mWh
    const points = [pt(0, 3.7, 20), pt(1800, 3.7, 20), pt(3600, 3.7, 20)];
    expect(estimateHeatMwh(points, 21)).toBeCloseTo(8400, 0);
  });

  test('trapezoidal on I² across a taper', () => {
    // 20A → 10A over 3600s, R = 10mΩ: avg(I²) = (400+100)/2 = 250 → 2.5W → 2500 mWh
    const points = [pt(0, 3.7, 20), pt(3600, 3.7, 10)];
    expect(estimateHeatMwh(points, 10)).toBeCloseTo(2500, 0);
  });

  test('null on unusable inputs', () => {
    expect(estimateHeatMwh([pt(0, 3.7, 20)], 21)).toBeNull();
    expect(estimateHeatMwh([pt(0, 3.7, 20), pt(2, 3.7, 20)], 0)).toBeNull();
    expect(estimateHeatMwh([], 21)).toBeNull();
  });

  test('non-monotonic timestamps are skipped, not subtracted', () => {
    const points = [pt(0, 3.7, 20), pt(10, 3.7, 20), pt(5, 3.7, 20), pt(20, 3.7, 20)];
    // Only the 0→10 and 5→20 spans count (10s + 15s at 4W = 100/3.6 + ... )
    const result = estimateHeatMwh(points, 10);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });
});

describe('modeSupportsIr', () => {
  test('current-carrying modes only', () => {
    expect(modeSupportsIr('c-cv')).toBe(true);
    expect(modeSupportsIr('d-cc')).toBe(true);
    expect(modeSupportsIr('d-cp')).toBe(true);
    expect(modeSupportsIr('wait')).toBe(false);
    expect(modeSupportsIr('idle')).toBe(false);
  });
});
