import { describe, test, expect } from 'bun:test';
import { CapacityTracker } from './capacity-tracker.ts';
import { encodeBase240 } from '../protocol/codec.ts';

/**
 * Test data derived from real run #4 on coulomb (EBC-A40L, 40A D-CC discharge).
 *
 * The device changes capacity encoding at ~10 Ah:
 * - Below ~10 Ah: bytes 5-6 base-240, 1 mAh per unit
 * - Above ~10 Ah: hi byte gets +99, 10 mAh per unit
 *
 * Run #4 reference: 40A for 12,529s = ~139.2 Ah actual.
 * Database recorded only 46,691 mAh (the bug).
 */

/** Simulate a base-240 decoded capacity value from raw bytes */
function rawCap(hi: number, lo: number): number {
  return hi * 240 + lo;
}

describe('CapacityTracker', () => {
  test('passes through low-capacity values unchanged', () => {
    const tracker = new CapacityTracker();

    expect(tracker.update(0, true)).toBe(0);
    expect(tracker.update(22, true)).toBe(22);
    expect(tracker.update(5000, true)).toBe(5000);
    expect(tracker.update(9987, true)).toBe(9987);

    expect(tracker.highCapMode).toBe(false);
  });

  test('detects transition and applies 10x correction', () => {
    const tracker = new CapacityTracker();

    // Feed realistic pre-transition values (40A discharge, +22 mAh per 2s tick)
    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }

    expect(tracker.highCapMode).toBe(false);
    expect(tracker.capacityMah).toBe(9966); // last value fed (453 × 22 = 9966, since 454 × 22 = 9988 > 9987)

    // Transition: hi byte jumps by +99 (from 41 to 140)
    // Real data: 9987 → 33769 (raw jump of +23782)
    const transitionRaw = rawCap(140, 169); // = 33769
    const corrected = tracker.update(transitionRaw, true);

    expect(tracker.highCapMode).toBe(true);
    // At transition: true capacity = prevRaw (9966) + 0 delta = 9966
    expect(corrected).toBe(9966);
  });

  test('post-transition values scale by 10x', () => {
    const tracker = new CapacityTracker();

    // Ramp to transition
    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }
    const lastPre = tracker.capacityMah; // 9966

    // Trigger transition
    const transitionRaw = rawCap(140, 169); // 33769
    tracker.update(transitionRaw, true);

    // Feed post-transition values (real data: +2.2 per tick = 10 mAh true per tick)
    const postTransitionValues = [
      rawCap(140, 171), // 33771 → delta 2 → true delta 20
      rawCap(140, 173), // 33773 → delta 4 → true delta 40
      rawCap(141, 0),   // 33840 → delta 71 → true delta 710
    ];

    for (const raw of postTransitionValues) {
      tracker.update(raw, true);
    }

    // At rawCap(141, 0) = 33840: delta from transition = 33840 - 33769 = 71
    // True capacity = 9966 + 71 * 10 = 10676
    expect(tracker.capacityMah).toBe(lastPre + 71 * 10);
  });

  test('matches real run #4 end-of-run capacity', () => {
    const tracker = new CapacityTracker();

    // Simulate run #4: ramp to 9987, then transition, then end at 46691
    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }
    const lastPre = tracker.capacityMah;

    // Transition at 33769
    tracker.update(33769, true);

    // Jump to end-of-run value: 46691
    tracker.update(46691, true);

    // True capacity = lastPre + (46691 - 33769) * 10
    const expected = lastPre + (46691 - 33769) * 10;
    expect(tracker.capacityMah).toBe(expected);

    // At 40A for 12529s, expected capacity ≈ 139211 mAh
    // Our value should be close (within one tick's worth)
    expect(Math.abs(tracker.capacityMah - 139211)).toBeLessThan(30);
  });

  test('handles charge run (C-CV) the same way', () => {
    // Run #3 data: C-CV charge at 40A, same transition pattern
    const tracker = new CapacityTracker();

    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }

    tracker.update(33769, true); // transition
    tracker.update(47189, true); // end of run #3

    const lastPre = 9966;
    const expected = lastPre + (47189 - 33769) * 10;
    expect(tracker.capacityMah).toBe(expected);
    // Run #3: 15455s at roughly 40A CC then tapering CV
    // True capacity ≈ 144 Ah — our decoded value should be ~134-145 Ah range
    expect(tracker.capacityMah).toBeGreaterThan(130_000);
    expect(tracker.capacityMah).toBeLessThan(150_000);
  });

  test('does not trigger transition when not running', () => {
    const tracker = new CapacityTracker();

    // Idle readings with residual capacity from previous run
    tracker.update(39957, false); // idle, big value from last run
    tracker.update(39957, false);

    expect(tracker.highCapMode).toBe(false);
    expect(tracker.capacityMah).toBe(39957);
  });

  test('resets cleanly for new test', () => {
    const tracker = new CapacityTracker();

    // Complete a run into high-cap mode
    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }
    tracker.update(33769, true);
    tracker.update(40000, true);
    expect(tracker.highCapMode).toBe(true);

    // Reset for new test
    tracker.reset();

    expect(tracker.highCapMode).toBe(false);
    expect(tracker.capacityMah).toBe(0);

    // New test should work normally
    expect(tracker.update(22, true)).toBe(22);
    expect(tracker.highCapMode).toBe(false);
  });

  test('recovery restores high-cap state correctly', () => {
    const tracker = new CapacityTracker();

    // Simulate a run up to high-cap mode
    for (let cap = 0; cap <= 9987; cap += 22) {
      tracker.update(cap, true);
    }
    tracker.update(33769, true);
    tracker.update(40000, true);

    // Save state (as would happen before service restart)
    const state = tracker.getState();
    const lastCap = tracker.capacityMah;

    // Simulate service restart: new tracker, restore state
    const recovered = new CapacityTracker();
    recovered.restore(state, 40000);

    expect(recovered.highCapMode).toBe(true);
    expect(recovered.capacityMah).toBe(lastCap);

    // Continue with new readings after recovery
    const next = recovered.update(40002, true);
    expect(next).toBe(lastCap + 20); // delta 2 * 10 = 20 mAh
  });

  test('recovery from DB with wrong capacity still works', () => {
    // Scenario: service restarts, DB has old-style wrong capacity,
    // and we reconstruct from the raw device value + DB value.
    const tracker = new CapacityTracker();

    // The recovery provider sets transitionRaw = current raw,
    // transitionTrue = last DB capacity. On the first reading after
    // recovery, delta is 0, so capacity = DB value exactly.
    const rawDeviceValue = 42000; // current raw from device (encoded)
    const dbCapacity = 80000;     // what we last stored (corrected)

    tracker.restore(
      { highCapMode: true, transitionRaw: rawDeviceValue, transitionTrue: dbCapacity },
      rawDeviceValue,
    );

    expect(tracker.capacityMah).toBe(80000);

    // Next reading: raw increments by 2 (= 20 mAh true)
    const next = tracker.update(42002, true);
    expect(next).toBe(80020);
  });

  test('matches live run #56 transition data exactly', () => {
    // Real data captured from diagnostic discharge run #56 on coulomb (2026-05-04)
    // 40A D-CC discharge, 2.8V cutoff, EBC-A40L
    // Pre-transition: cap increments by 22 per 2s tick (1 mAh/unit)
    // Transition at point 451: 9991 → 33769 (jump of 23778)
    // Post-transition: cap increments by 2-3 per 2s tick (10 mAh/unit)
    const tracker = new CapacityTracker();

    // Feed exact pre-transition values from run #56 (last 5 points before transition)
    const preTransition = [9880, 9902, 9925, 9947, 9969, 9991];
    // Feed enough earlier values to establish the pattern
    for (let cap = 0; cap < preTransition[0]; cap += 22) {
      tracker.update(cap, true);
    }
    for (const cap of preTransition) {
      tracker.update(cap, true);
    }
    expect(tracker.highCapMode).toBe(false);
    expect(tracker.capacityMah).toBe(9991);

    // Exact transition point from run #56
    tracker.update(33769, true);
    expect(tracker.highCapMode).toBe(true);
    expect(tracker.capacityMah).toBe(9991); // prevRaw preserved at transition

    // Exact post-transition values from run #56
    const postTransition = [33772, 33774, 33776, 33778, 33781, 33783, 33785, 33787, 33789, 33792];
    for (const raw of postTransition) {
      const corrected = tracker.update(raw, true);
      expect(corrected).toBeGreaterThan(9991);
    }

    // At raw 33792: delta = 33792 - 33769 = 23, true = 9991 + 23*10 = 10221
    expect(tracker.capacityMah).toBe(9991 + (33792 - 33769) * 10);
    expect(tracker.capacityMah).toBe(10221);

    // At raw 33829 (last captured): corrected = 9991 + 600 = 10591
    // Theoretical at 955.9s: 40A × 955.9s / 3.6 = 10621 mAh (0.3% error)
    tracker.update(33829, true);
    expect(tracker.capacityMah).toBe(10591);
  });

  test('capacity values are monotonically increasing through transition', () => {
    const tracker = new CapacityTracker();
    let prev = 0;

    // Feed values that simulate a real discharge
    // Pre-transition: 0 to ~9988 in steps of 22
    for (let cap = 0; cap <= 9987; cap += 22) {
      const corrected = tracker.update(cap, true);
      expect(corrected).toBeGreaterThanOrEqual(prev);
      prev = corrected;
    }

    // Transition
    const atTransition = tracker.update(33769, true);
    expect(atTransition).toBeGreaterThanOrEqual(prev);
    prev = atTransition;

    // Post-transition: 33771 onward in steps of 2
    for (let raw = 33771; raw <= 34000; raw += 2) {
      const corrected = tracker.update(raw, true);
      expect(corrected).toBeGreaterThanOrEqual(prev);
      prev = corrected;
    }
  });
});
