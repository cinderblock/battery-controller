#!/usr/bin/env bun

/**
 * Real-hardware capture: what does CMD 0x08 (continue) actually DO?
 *
 * Phase C established that a mid-run 0x08 is silently ignored by the
 * EBC-A40L (current unchanged in both directions). Remaining hypothesis:
 * 0x08 is EB Tester's "Cont." button — RESUME a stopped test, possibly
 * preserving the device's capacity accumulator (which freezes on stop).
 *
 * The server API refuses continues while idle, so this speaks raw frames
 * through the TCP bridge:
 *   1. baseline: idle frames (expect frozen capacity from the last run)
 *   2. send 0x08 (10 A, 2.8 V cutoff, 5 min) → resume? capacity kept?
 *   3. if running: send a second 0x08 with 15 A → mid-run adjust after a
 *      resume? then 0x01 START 15 A mid-run → does re-START adjust, and
 *      does it reset capacity?
 *   4. 0x02 stop, restore bridge off.
 *
 * USER-AUTHORIZED hardware poke (2026-07-16). Always stops the device and
 * the bridge on exit, success or failure.
 */

import { buildTxFrame, decodeRxFrame, encodeBase240, parseFrame, scanForFrames } from '../src/protocol/codec.ts';
import { EbcDivisors, RxPacketLength } from '../src/protocol/constants.ts';

const BASE = 'http://coulomb';
const BRIDGE_PORT = 49600;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function dccPayload(cmd: number, currentA: number, cutoffV: number, maxTimeMin: number): Uint8Array {
  const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
  const [vHi, vLo] = encodeBase240(cutoffV, EbcDivisors.setpointVoltage);
  const [tHi, tLo] = encodeBase240(maxTimeMin, 1);
  return new Uint8Array([cmd, iHi, iLo, vHi, vLo, tHi, tLo]);
}

async function api(path: string, method = 'POST'): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { method });
  return `${res.status} ${await res.text()}`;
}

async function main(): Promise<void> {
  console.log('bridge start:', await api('/api/bridge/start'));
  await sleep(1500);

  let rxBuffer = new Uint8Array(0);
  let lastLog = 0;
  const t0 = Date.now();

  const socket = await Bun.connect({
    hostname: 'coulomb',
    port: BRIDGE_PORT,
    socket: {
      data(_s, chunk: Buffer) {
        const combined = new Uint8Array(rxBuffer.length + chunk.length);
        combined.set(rxBuffer);
        combined.set(chunk, rxBuffer.length);
        const scan = scanForFrames(combined, RxPacketLength);
        rxBuffer = scan.remainder;
        for (const raw of scan.frames) {
          const parsed = parseFrame(raw, 'rx');
          if (!parsed) continue;
          const d = decodeRxFrame(parsed, 'ebc');
          // ~2 frames/s — log at most 1/s to keep output readable
          const now = Date.now();
          if (now - lastLog < 950) continue;
          lastLog = now;
          const t = ((now - t0) / 1000).toFixed(0);
          // EBC family: current ÷100 is already applied by family-aware
          // decode; field6 raw = mAh (decoder value is ÷1000 → Ah)
          console.log(
            `t=${t.padStart(3)}s state=0x${d.state.toString(16).padStart(2, '0')} ` +
              `I=${d.current.toFixed(2)}A V=${d.voltage.toFixed(3)}V cap=${Math.round(d.field6 * 1000)}mAh`
          );
        }
      },
      error(_s, err) {
        console.error('socket error:', err);
      },
    },
  });

  const send = (label: string, payload: Uint8Array) => {
    console.log(`>>> ${label}`);
    socket.write(buildTxFrame(payload));
  };

  try {
    console.log('--- baseline (idle, expect frozen capacity from run #168 ≈ 1694 mAh)');
    await sleep(6000);

    send('0x08 continue 10A 2.8V 5min (resume-from-idle hypothesis)', dccPayload(0x08, 10, 2.8, 5));
    await sleep(12000);

    send('0x08 continue 15A 2.8V 5min (adjust-after-resume)', dccPayload(0x08, 15, 2.8, 5));
    await sleep(10000);

    send('0x01 START 15A 2.8V 5min mid-whatever (re-START adjust? capacity reset?)', dccPayload(0x01, 15, 2.8, 5));
    await sleep(10000);

    send('0x01 START 10A 2.8V 5min (second re-START, watch current + capacity)', dccPayload(0x01, 10, 2.8, 5));
    await sleep(10000);
  } finally {
    send('0x02 STOP', new Uint8Array([0x02, 0, 0, 0, 0, 0, 0]));
    await sleep(4000);
    socket.end();
    console.log('bridge stop:', await api('/api/bridge/stop'));
  }

  console.log('=== capture complete ===');
  process.exit(0);
}

main().catch(async err => {
  console.error('capture crashed:', err);
  // Best-effort cleanup even on crash
  try {
    console.log('bridge stop (cleanup):', await api('/api/bridge/stop'));
  } catch {}
  process.exit(1);
});
