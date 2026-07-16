import { describe, expect, test } from 'bun:test';
import { CycleRunner, type StepDCC, sanitizeProbe } from './cycle-runner.ts';
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
  /** adjustDCC calls observed (the probe's dips and restores) */
  continues: { currentA: number; cutoffV: number; maxTimeMin: number }[];
  session: DeviceSession;
}

function stubSession(initialMode = 'd-cc'): StubSession {
  const stub: StubSession = {
    mode: initialMode,
    continues: [],
    session: null as unknown as DeviceSession,
  };
  stub.session = {
    getMode: () => stub.mode,
    getPendingCommand: () => null,
    adjustDCC: async (currentA: number, cutoffV: number, maxTimeMin: number) => {
      stub.continues.push({ currentA, cutoffV, maxTimeMin });
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
});
