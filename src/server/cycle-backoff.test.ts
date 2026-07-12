import { describe, expect, test } from 'bun:test';
import { nextBackoffCurrentA } from './cycle-runner.ts';

/** A run row shaped like the instant cutoff trips seen on high-IR cells (e.g. run #125) */
function tripRun(
  overrides: Partial<{ end_reason: string | null; duration_s: number | null; final_capacity_mah: number | null }> = {}
) {
  return { end_reason: 'manual_stop', duration_s: 0.8, final_capacity_mah: 2, ...overrides };
}

describe('nextBackoffCurrentA', () => {
  test('halves the current on an instant trip', () => {
    expect(nextBackoffCurrentA(tripRun(), 40, 10)).toBe(20);
    expect(nextBackoffCurrentA(tripRun(), 20, 10)).toBe(10);
  });

  test('floors at minA and stops once there', () => {
    expect(nextBackoffCurrentA(tripRun(), 15, 10)).toBe(10);
    expect(nextBackoffCurrentA(tripRun(), 10, 10)).toBeNull();
    expect(nextBackoffCurrentA(tripRun(), 9, 10)).toBeNull();
  });

  test("a real discharge doesn't back off", () => {
    expect(nextBackoffCurrentA(tripRun({ duration_s: 289, final_capacity_mah: 3198 }), 40, 10)).toBeNull();
    // short but with real capacity (fast sampling glitch)
    expect(nextBackoffCurrentA(tripRun({ duration_s: 25, final_capacity_mah: 250 }), 40, 10)).toBeNull();
  });

  test('device-reported completion also counts as a trip', () => {
    expect(nextBackoffCurrentA(tripRun({ end_reason: 'complete' }), 40, 10)).toBe(20);
  });

  test('host-initiated stops never back off', () => {
    for (const reason of ['step_ended_early', 'temp_alert', 'time_limit', 'fault', 'service_restart', null]) {
      expect(nextBackoffCurrentA(tripRun({ end_reason: reason }), 40, 10)).toBeNull();
    }
  });

  test('missing run row (recorder never finalized) never backs off', () => {
    expect(nextBackoffCurrentA(null, 40, 10)).toBeNull();
  });

  test('nonsensical floor disables backoff', () => {
    expect(nextBackoffCurrentA(tripRun(), 40, 0)).toBeNull();
    expect(nextBackoffCurrentA(tripRun(), 40, -5)).toBeNull();
  });
});
