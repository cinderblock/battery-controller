import { describe, expect, test } from 'bun:test';
import { TempRateFilter } from './temp-rate-filter.ts';

/** Quantize to DS18B20 12-bit resolution (0.0625 °C) */
function quantize(t: number): number {
  return Math.round(t / 0.0625) * 0.0625;
}

describe('TempRateFilter', () => {
  test('first sample initializes with zero rate', () => {
    const f = new TempRateFilter();
    expect(f.update(25.0, 0)).toBe(0);
  });

  test('converges to the true rate on a clean ramp', () => {
    const f = new TempRateFilter();
    const rateCPerMin = 1.5;
    let rate = 0;
    for (let i = 0; i <= 60; i++) {
      const t = i * 10; // 10 s samples over 10 min
      rate = f.update(25 + (rateCPerMin * t) / 60, t * 1000);
    }
    expect(rate).toBeCloseTo(rateCPerMin, 1);
  });

  test('quantized constant temperature stays near zero rate', () => {
    const f = new TempRateFilter();
    // Constant 25.03 °C reads as alternating quantized codes with sensor noise
    let maxAbsRate = 0;
    for (let i = 0; i <= 120; i++) {
      const noisy = 25.03 + 0.03 * Math.sin(i * 1.7); // deterministic pseudo-noise
      const rate = f.update(quantize(noisy), i * 10_000);
      if (i > 12) maxAbsRate = Math.max(maxAbsRate, Math.abs(rate));
    }
    expect(maxAbsRate).toBeLessThan(0.1); // < 0.1 °C/min noise floor
  });

  test('tracks a quantized ramp within tolerance', () => {
    const f = new TempRateFilter();
    const rateCPerMin = 0.5;
    let rate = 0;
    for (let i = 0; i <= 90; i++) {
      const t = i * 10;
      rate = f.update(quantize(25 + (rateCPerMin * t) / 60), t * 1000);
    }
    expect(rate).toBeGreaterThan(0.35);
    expect(rate).toBeLessThan(0.65);
  });

  test('resets after a long gap', () => {
    const f = new TempRateFilter();
    f.update(25, 0);
    f.update(25.5, 10_000);
    f.update(26, 20_000);
    // 10-minute gap — a huge apparent step must not produce a rate spike
    const rate = f.update(40, 620_000);
    expect(rate).toBe(0);
    expect(f.temperatureC).toBe(40);
  });

  test('handles irregular sample intervals', () => {
    const f = new TempRateFilter();
    const rateCPerMin = 1.0;
    const intervals = [8, 12, 10, 15, 9, 11, 10, 14, 8, 10];
    let t = 0;
    let rate = 0;
    for (let round = 0; round < 8; round++) {
      for (const dt of intervals) {
        t += dt;
        rate = f.update(25 + (rateCPerMin * t) / 60, t * 1000);
      }
    }
    expect(rate).toBeCloseTo(rateCPerMin, 1);
  });
});
