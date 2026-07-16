#!/usr/bin/env bun

/**
 * IR-probe end-to-end verification against the in-process fake device.
 *
 * Wires the REAL server stack — DeviceSession → TestRecorder → CycleRunner,
 * with an in-memory SQLite DB — to a FakeDevice (ebc-a40l profile, 3 mΩ
 * simulated internal resistance) through a byte-level adapter that speaks
 * actual protocol frames both ways. Then runs a d-cc step with the IR probe
 * enabled and verifies:
 *
 *   1. The probe dips to lowA and restores the setpoint (visible in the
 *      recorded data points as ~10 A clusters between 40 A stretches).
 *   2. All points land in ONE run — a 0x08 continue must not fork a run.
 *   3. Capacity is monotonic non-decreasing across dips (the host pipeline
 *      isn't confused by mid-run continues).
 *   4. estimateIrSamples recovers the simulated 3 mΩ from the dips.
 *   5. finalizeRun stores a ~3 mΩ median on the run row.
 *
 * Scope note: this validates OUR side (scheduler, guards, encoding,
 * recording). It says nothing about the real device's 0x08 semantics —
 * the fake device implements the behavior we designed for. Real-hardware
 * capture is tracked separately in plans/ir-active-probe.md.
 *
 * Runtime: ~2.5 min (probe period floor is 60 s). Usage:
 *   bun run scripts/verify-ir-probe.ts
 */

import { checksum } from '../src/protocol/codec.ts';
import { EndToken, RxPacketLength, StartToken } from '../src/protocol/constants.ts';
import { CycleRunner } from '../src/server/cycle-runner.ts';
import { getDataPointsForRun, getDb, initDb } from '../src/server/db.ts';
import { DeviceSession } from '../src/server/device-session.ts';
import type { SerialManager } from '../src/server/serial.ts';
import { TestRecorder } from '../src/server/test-recorder.ts';
import { estimateIrSamples } from '../src/shared/ir-estimate.ts';
import { FakeDevice } from './fake-device/device.ts';
import { getProfile } from './fake-device/profiles/index.ts';

// ── Byte-level adapter: SerialManager surface over the FakeDevice ──

class FakeSerialAdapter {
  private packetListeners = new Set<(packet: Buffer) => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private buffer = Buffer.alloc(0);
  device: FakeDevice | null = null;

  addPacketListener(listener: (packet: Buffer) => void): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  addConnectionListener(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  isPortOpen(): boolean {
    return true;
  }

  /** Host → device: frame the 7-byte payload exactly like SerialManager */
  async sendPacket(data: Buffer): Promise<void> {
    const frame = Buffer.from([StartToken, ...data, checksum(data), EndToken]);
    this.device?.ingestBytes(new Uint8Array(frame));
  }

  /** Device → host: scan frames, validate, deliver stripped 16-byte payloads */
  ingestFromDevice(bytes: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    while (this.buffer.length >= RxPacketLength) {
      if (this.buffer[0] !== StartToken) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const frame = this.buffer.subarray(0, RxPacketLength);
      if (frame[RxPacketLength - 1] !== EndToken) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const payload = Buffer.from(frame.subarray(1, RxPacketLength - 2));
      if (checksum(payload) === frame[RxPacketLength - 2]) {
        for (const l of this.packetListeners) l(payload);
      }
      this.buffer = this.buffer.subarray(RxPacketLength);
    }
  }
}

// ── Assertions ──────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Main ────────────────────────────────────────────────────────────

const PROBE = { periodS: 60, lowA: 10, holdS: 6 };
const SETPOINT_A = 40;
const SIM_MOHM = 3; // must match ebc-a40l profile irMohm

async function main(): Promise<void> {
  initDb(':memory:');

  const adapter = new FakeSerialAdapter();
  const device = new FakeDevice({
    profile: getProfile('ebc-a40l'),
    onTransmit: bytes => adapter.ingestFromDevice(bytes),
  });
  adapter.device = device;
  // Evolve capacity/voltage over time; near-zero voltage drift so the
  // cutoff never trips during the test window
  device.start();
  device.patchState({ auto: true, autoRateVPerMin: 0.0001 });

  const session = new DeviceSession(adapter as unknown as SerialManager);
  const recorder = new TestRecorder(session);
  const runner = new CycleRunner(session, recorder);
  session.start();
  recorder.start();
  runner.start();

  console.log('Waiting for fake device to become responsive...');
  for (let i = 0; i < 20 && !session.isDeviceResponsive(); i++) await sleep(250);
  check('device responsive', session.isDeviceResponsive(), `mode=${session.getMode()}`);

  console.log(`Starting probing d-cc: ${SETPOINT_A}A, probe ${PROBE.lowA}A/${PROBE.holdS}s every ${PROBE.periodS}s`);
  await runner.startSequence('ir-probe-e2e', [
    { type: 'd-cc', currentA: SETPOINT_A, cutoffV: 2.5, maxTimeMin: 30, probe: PROBE },
  ]);

  await sleep(3000);
  const runId = recorder.getActiveRunId();
  check('run recording started', runId !== null, `run #${runId}, mode=${session.getMode()}`);

  // Two probe periods + margin: dip1 @60s, dip2 @120s
  const RUN_S = 140;
  for (let elapsed = 0; elapsed < RUN_S; elapsed += 10) {
    await sleep(10_000);
    const r = session.getReading();
    console.log(
      `  t=${(elapsed + 10).toString().padStart(3)}s  I=${r.current.toFixed(2)}A  V=${r.voltage.toFixed(3)}V  cap=${r.capacityMah.toFixed(0)}mAh`
    );
  }

  const sameRun = recorder.getActiveRunId();
  check('single run across probes', sameRun === runId, `still run #${sameRun}`);

  console.log('Aborting cycle...');
  await runner.abort('manual');
  await sleep(3000);

  // ── Inspect what was recorded ─────────────────────────────────
  if (runId === null) throw new Error('no run to inspect');
  const points = getDataPointsForRun(runId);
  check('data points recorded', points.length > 200, `${points.length} points`);

  // Dip clusters: consecutive stretches at ~lowA
  const dipPoints = points.filter(p => Math.abs(p.current_a - PROBE.lowA) < 0.5);
  let dipClusters = 0;
  let inDip = false;
  for (const p of points) {
    const isDip = Math.abs(p.current_a - PROBE.lowA) < 0.5;
    if (isDip && !inDip) dipClusters++;
    inDip = isDip;
  }
  check('probe dipped twice', dipClusters === 2, `${dipClusters} dip clusters, ${dipPoints.length} dip points`);

  const restored = points[points.length - 1];
  check(
    'setpoint restored after dips',
    points.some((p, i) => i > 0 && Math.abs(p.current_a - SETPOINT_A) < 0.5 && points[i - 1].current_a < 11),
    `last point I=${restored.current_a.toFixed(1)}A`
  );

  let capMonotonic = true;
  for (let i = 1; i < points.length; i++) {
    if (points[i].capacity_mah < points[i - 1].capacity_mah - 0.01) capMonotonic = false;
  }
  check(
    'capacity monotonic across dips',
    capMonotonic,
    `final ${points[points.length - 1].capacity_mah.toFixed(0)} mAh`
  );

  const samples = estimateIrSamples(points, 'd-cc');
  const near = samples.filter(s => Math.abs(s.mohm - SIM_MOHM) < 0.5);
  check(
    `IR samples recover the simulated ${SIM_MOHM} mΩ`,
    samples.length >= 4 && near.length >= 4,
    `${samples.length} samples: [${samples.map(s => `${s.mohm}@${Math.round(s.t)}s`).join(', ')}]`
  );

  const runRow = getDb()
    .query<{ ir_mohm: number | null; end_reason: string | null }, [number]>(
      'SELECT ir_mohm, end_reason FROM test_runs WHERE id = ?'
    )
    .get(runId);
  check(
    'finalized run stores ~3 mΩ median',
    runRow?.ir_mohm != null && Math.abs(runRow.ir_mohm - SIM_MOHM) < 0.5,
    `ir_mohm=${runRow?.ir_mohm}, end_reason=${runRow?.end_reason}`
  );

  // ── Teardown ──────────────────────────────────────────────────
  runner.stop();
  recorder.stop();
  session.destroy();
  device.stop();

  console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED' : `\n💥 ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('verify-ir-probe crashed:', err);
  process.exit(1);
});
