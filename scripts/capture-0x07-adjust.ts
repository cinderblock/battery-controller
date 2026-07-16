#!/usr/bin/env bun

/**
 * Real-hardware capture: does CMD 0x07 (Adjust) change D-CC setpoints
 * mid-run on the EBC-A40L?
 *
 * protocol.md documents that EB Tester's "Adjust" button (enabled only
 * during D-CC) emits 0x07 with new setpoints in bytes 2-7 — but that was
 * a TX-side capture of the UI; the device-side effect was never verified.
 * Tonight's captures showed 0x08 and re-sent 0x01 are both ignored
 * mid-run, so 0x07 is the last candidate for the IR-probe current dip.
 *
 * Via TCP bridge: start D-CC 10 A, adjust to 15 A, adjust to 5 A, stop.
 * Watch current (does it follow?) and capacity (does it keep counting?).
 *
 * USER-AUTHORIZED hardware poke (2026-07-16). Always stops the device and
 * the bridge on exit.
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
          const now = Date.now();
          if (now - lastLog < 950) continue;
          lastLog = now;
          const t = ((now - t0) / 1000).toFixed(0);
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
    console.log('--- baseline (idle)');
    await sleep(4000);

    send('0x01 START D-CC 10A 2.8V 5min', dccPayload(0x01, 10, 2.8, 5));
    await sleep(12000);

    send('0x07 ADJUST → 15A 2.8V 5min', dccPayload(0x07, 15, 2.8, 5));
    await sleep(12000);

    send('0x07 ADJUST → 5A 2.8V 5min', dccPayload(0x07, 5, 2.8, 5));
    await sleep(12000);

    send('0x07 ADJUST → 10A 2.8V 5min (restore)', dccPayload(0x07, 10, 2.8, 5));
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
  try {
    console.log('bridge stop (cleanup):', await api('/api/bridge/stop'));
  } catch {}
  process.exit(1);
});
