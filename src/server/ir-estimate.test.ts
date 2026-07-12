import { describe, expect, test } from 'bun:test';
import { estimateIrMohm, modeSupportsIr } from './ir-estimate.ts';

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

describe('modeSupportsIr', () => {
  test('current-carrying modes only', () => {
    expect(modeSupportsIr('c-cv')).toBe(true);
    expect(modeSupportsIr('d-cc')).toBe(true);
    expect(modeSupportsIr('d-cp')).toBe(true);
    expect(modeSupportsIr('wait')).toBe(false);
    expect(modeSupportsIr('idle')).toBe(false);
  });
});
