import { describe, expect, test } from 'bun:test';
import { CycleRunner, type StepCCV, type StepDCC, sanitizeProbe } from './cycle-runner.ts';
import type { DeviceSession } from './device-session.ts';
import type { TestRecorder } from './test-recorder.ts';

describe('sanitizeProbe', () => {
  test('passes a sane config through unchanged', () => {
    expect(sanitizeProbe({ periodS: 600, lowA: 10, holdS: 8 }, 40)).toEqual({ periodS: 600, lowA: 10, holdS: 8 });
  });

  test('null when no probe configured', () => {
    expect(sanitizeProbe(undefined, 40)).toBeNull();
  });

  test('rejects dips below the estimator acceptance threshold (ΔI < 5A)', () => {
    // 40→36 = 4A step: the estimator would discard it — pure disturbance
    expect(sanitizeProbe({ periodS: 600, lowA: 36, holdS: 8 }, 40)).toBeNull();
    // exactly 5A is accepted
    expect(sanitizeProbe({ periodS: 600, lowA: 35, holdS: 8 }, 40)).not.toBeNull();
  });

  test('rejects after backoff shrinks the setpoint under lowA', () => {
    // Step programmed 40A with lowA 10, backed off to 10A → ΔI = 0
    expect(sanitizeProbe({ periodS: 600, lowA: 10, holdS: 8 }, 10)).toBeNull();
  });

  test('rejects zero/negative fields', () => {
    expect(sanitizeProbe({ periodS: 0, lowA: 10, holdS: 8 }, 40)).toBeNull();
    expect(sanitizeProbe({ periodS: 600, lowA: 0, holdS: 8 }, 40)).toBeNull();
    expect(sanitizeProbe({ periodS: 600, lowA: -5, holdS: 8 }, 40)).toBeNull();
    expect(sanitizeProbe({ periodS: 600, lowA: 10, holdS: 0 }, 40)).toBeNull();
  });

  test('clamps hold to [6, 30]s — needs ≥2–3 readings at ~2s cadence', () => {
    expect(sanitizeProbe({ periodS: 600, lowA: 10, holdS: 2 }, 40)?.holdS).toBe(6);
    expect(sanitizeProbe({ periodS: 600, lowA: 10, holdS: 120 }, 40)?.holdS).toBe(30);
  });

  test('clamps period to ≥60s and ≥4× hold so the dip stays a dip', () => {
    expect(sanitizeProbe({ periodS: 10, lowA: 10, holdS: 8 }, 40)?.periodS).toBe(60);
    // 30s hold forces a 120s minimum period
    expect(sanitizeProbe({ periodS: 90, lowA: 10, holdS: 30 }, 40)?.periodS).toBe(120);
  });
});

// ── fireProbe dip/restore guards ────────────────────────────────────
// Exercises the private dip→hold→restore path against a stubbed session.
// These guards are the hardware-safety core: 0x07 adjust is only
// characterized while the device is actively in d-cc — sending it from
// any other state is uncharted territory on real hardware.

interface StubSession {
  mode: string;
  /** Device state byte (0x0a d-cc run, 0x0c c-cv CC phase, 0x16 c-cv CV phase) */
  stateByte: number;
  /** adjustDCC calls observed (the probe's dips and restores) */
  continues: { currentA: number; cutoffV: number; maxTimeMin: number }[];
  /** adjustCCV calls observed */
  ccvAdjusts: { currentA: number; targetV: number; cutoffCurrentA: number }[];
  /** Device-reported current — adjusts apply here unless dropped */
  deviceCurrent: number;
  /** Number of upcoming adjust frames the "device" silently drops */
  dropNext: number;
  session: DeviceSession;
}

function stubSession(initialMode = 'd-cc'): StubSession {
  const stub: StubSession = {
    mode: initialMode,
    stateByte: initialMode === 'c-cv' ? 0x0c : 0x0a,
    continues: [],
    ccvAdjusts: [],
    deviceCurrent: 40,
    dropNext: 0,
    session: null as unknown as DeviceSession,
  };
  const apply = (currentA: number) => {
    if (stub.dropNext > 0) {
      stub.dropNext--;
    } else {
      stub.deviceCurrent = currentA;
    }
  };
  stub.session = {
    getMode: () => stub.mode,
    getPendingCommand: () => null,
    getReading: () => ({ current: stub.deviceCurrent, stateByte: stub.stateByte }),
    adjustDCC: async (currentA: number, cutoffV: number, maxTimeMin: number) => {
      stub.continues.push({ currentA, cutoffV, maxTimeMin });
      apply(currentA);
    },
    adjustCCV: async (currentA: number, targetV: number, cutoffCurrentA: number) => {
      stub.ccvAdjusts.push({ currentA, targetV, cutoffCurrentA });
      apply(currentA);
    },
  } as unknown as DeviceSession;
  return stub;
}

function probeRunner(stub: StubSession): CycleRunner {
  const runner = new CycleRunner(stub.session, {} as TestRecorder);
  (runner as any).status = 'running';
  return runner;
}

const PROBE_STEP: StepDCC = { type: 'd-cc', currentA: 40, cutoffV: 2.5, maxTimeMin: 600 };
// holdS below the sanitize floor on purpose — fireProbe takes the config
// directly, and a short hold keeps the test fast
const FAST_PROBE = { periodS: 60, lowA: 10, holdS: 0.02 };

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('fireProbe', () => {
  test('dips to lowA then restores the setpoint, preserving cutoff and max time', async () => {
    const stub = stubSession();
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    await settle(60);

    expect(stub.continues).toEqual([
      { currentA: 10, cutoffV: 2.5, maxTimeMin: 600 },
      { currentA: 40, cutoffV: 2.5, maxTimeMin: 600 },
    ]);
  });

  test('skips the restore when the device leaves d-cc mid-dip', async () => {
    const stub = stubSession();
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    stub.mode = 'idle'; // cutoff tripped (or user stopped) during the hold
    await settle(60);

    expect(stub.continues).toEqual([{ currentA: 10, cutoffV: 2.5, maxTimeMin: 600 }]);
  });

  test('never dips when the device is not discharging', async () => {
    const stub = stubSession('c-cv');
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    await settle(60);

    expect(stub.continues).toEqual([]);
  });

  test('never dips once the cycle is no longer running', async () => {
    const stub = stubSession();
    const runner = probeRunner(stub);
    (runner as any).status = 'aborted';

    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    await settle(60);

    expect(stub.continues).toEqual([]);
  });

  test('clearProbeTimers cancels a pending restore', async () => {
    const stub = stubSession();
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP, { ...FAST_PROBE, holdS: 0.5 }, 40);
    (runner as any).clearProbeTimers();
    await settle(60);

    expect(stub.continues).toEqual([{ currentA: 10, cutoffV: 2.5, maxTimeMin: 600 }]);
  });

  test('retries the restore when the device drops the adjust frame', async () => {
    // Observed live (2026-07-16): a dip occasionally stays stuck at lowA
    // because the restore 0x07 doesn't take. Verify triggers a resend.
    const stub = stubSession();
    const runner = probeRunner(stub);
    stub.dropNext = 0; // dip applies…
    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    stub.dropNext = 1; // …but the device ignores the first restore

    await settle(150); // hold (20ms) + verify (20ms) + retry + verify again

    // dip, dropped restore, retried restore — and the device ends at 40A
    expect(stub.continues.map(c => c.currentA)).toEqual([10, 40, 40]);
    expect(stub.deviceCurrent).toBe(40);
  });

  test('gives up after max attempts instead of retrying forever', async () => {
    const stub = stubSession();
    const runner = probeRunner(stub);
    await (runner as any).fireProbe(PROBE_STEP, FAST_PROBE, 40);
    stub.dropNext = 99; // device ignores every restore

    await settle(300);

    // dip + exactly PROBE_RESTORE_MAX_ATTEMPTS restore attempts
    expect(stub.continues.map(c => c.currentA)).toEqual([10, 40, 40, 40]);
    expect(stub.deviceCurrent).toBe(10); // stuck — next probe period recovers
  });
});

// ── Charge (c-cv) probing — CC phase only ───────────────────────────

const PROBE_STEP_CCV: StepCCV = { type: 'c-cv', currentA: 20, targetV: 3.7, cutoffCurrentA: 2, maxTimeMin: 600 };
const FAST_PROBE_CCV = { periodS: 60, lowA: 5, holdS: 0.02 };

describe('fireProbe on c-cv', () => {
  test('dips and restores via adjustCCV during the CC phase', async () => {
    const stub = stubSession('c-cv');
    stub.deviceCurrent = 20;
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP_CCV, FAST_PROBE_CCV, 20);
    await settle(60);

    expect(stub.ccvAdjusts).toEqual([
      { currentA: 5, targetV: 3.7, cutoffCurrentA: 2 },
      { currentA: 20, targetV: 3.7, cutoffCurrentA: 2 },
    ]);
    expect(stub.continues).toEqual([]); // never the d-cc frame layout
  });

  test('never dips during the CV phase (device owns the current)', async () => {
    const stub = stubSession('c-cv');
    stub.deviceCurrent = 20;
    stub.stateByte = 0x16; // CV / phase 2
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP_CCV, FAST_PROBE_CCV, 20);
    await settle(60);

    expect(stub.ccvAdjusts).toEqual([]);
  });

  test('never dips when the current has tapered too close to lowA', async () => {
    const stub = stubSession('c-cv');
    stub.deviceCurrent = 7; // < lowA + 5A estimator threshold
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP_CCV, FAST_PROBE_CCV, 20);
    await settle(60);

    expect(stub.ccvAdjusts).toEqual([]);
  });

  test('restore still fires when the charger slips into CV mid-dip', async () => {
    // Leaving the dip's current LIMIT in place would cap the whole CV tail
    const stub = stubSession('c-cv');
    stub.deviceCurrent = 20;
    const runner = probeRunner(stub);

    await (runner as any).fireProbe(PROBE_STEP_CCV, FAST_PROBE_CCV, 20);
    stub.stateByte = 0x16; // phase flips during the hold
    await settle(60);

    expect(stub.ccvAdjusts.map(c => c.currentA)).toEqual([5, 20]);
  });
});
