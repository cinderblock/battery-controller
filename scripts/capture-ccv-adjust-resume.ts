#!/usr/bin/env bun

/**
 * Real-hardware capture: C-CV (charge) mid-run control semantics.
 *
 * Two questions, one bridge session against a live CC-phase charge:
 *
 *   1. Does CMD 0x07 (Adjust) change the charge current mid-run, like it
 *      does for D-CC? protocol.md says EB Tester gates its Adjust button
 *      to D-CC but speculates the device would accept 0x07 in other
 *      modes — unverified. Payload tried: C-CV start layout
 *      [0x07, current, targetV, cutoffA].
 *   2. Does the pause→continue flow resume a charge? 0x02 (pause/stop),
 *      then 0x28 (C-CV continue) a few seconds later — the EB Tester
 *      "Cont." button flow. Watch whether the charge resumes and whether
 *      the capacity accumulator survives the pause.
 *
 * Watch fields: state byte (0x0C = C-CV CC phase), current, capacity.
 * USER-AUTHORIZED (2026-07-16, "feel free to interrupt a run"). Always
 * stops the bridge on exit; leaves the device in whatever state the
 * resume test produced (caller restarts the charge if needed).
 */

import { buildTxFrame, decodeRxFrame, encodeBase240, parseFrame, scanForFrames } from '../src/protocol/codec.ts';
import { EbcDivisors, RxPacketLength } from '../src/protocol/constants.ts';

const BASE = 'http://coulomb';
const BRIDGE_PORT = 49600;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** C-CV layout: current (÷100), target voltage (÷100), cutoff current (÷100) */
function ccvPayload(cmd: number, currentA: number, targetV: number, cutoffA: number): Uint8Array {
  const [iHi, iLo] = encodeBase240(currentA, EbcDivisors.current);
  const [vHi, vLo] = encodeBase240(targetV, EbcDivisors.setpointVoltage);
  const [cHi, cLo] = encodeBase240(cutoffA, EbcDivisors.cutoffCurrent);
  return new Uint8Array([cmd, iHi, iLo, vHi, vLo, cHi, cLo]);
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
  let lastState = -1;
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
          lastState = d.state;
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
    // Whole capture runs dark inside the bridge window: the server's
    // session is detached, so the recorder/cycle-runner never see any of
    // it — no junk runs. We start our own charge and stop it at the end.
    console.log('--- baseline (idle)');
    await sleep(4000);

    send('0x21 START C-CV 20A 3.7V 2A', ccvPayload(0x21, 20, 3.7, 2));
    await sleep(8000);

    send('0x28 CONTINUE → 10A mid-run (expect ignored, like D-CC)', ccvPayload(0x28, 10, 3.7, 2));
    await sleep(8000);

    send('0x07 ADJUST → 10A 3.7V 2A (the question: mid-charge adjust?)', ccvPayload(0x07, 10, 3.7, 2));
    await sleep(10000);

    send('0x07 ADJUST → 20A 3.7V 2A (restore)', ccvPayload(0x07, 20, 3.7, 2));
    await sleep(8000);

    send('0x02 PAUSE', new Uint8Array([0x02, 0, 0, 0, 0, 0, 0]));
    await sleep(4000);

    send('0x28 CONTINUE 20A 3.7V 2A (resume-after-short-pause)', ccvPayload(0x28, 20, 3.7, 2));
    await sleep(12000);

    const resumed = lastState === 0x0c || lastState === 0x16;
    console.log(`--- resume-after-pause ${resumed ? 'WORKED' : 'did NOT work'} (state=0x${lastState.toString(16)})`);
  } finally {
    send('0x02 STOP (end of capture)', new Uint8Array([0x02, 0, 0, 0, 0, 0, 0]));
    await sleep(3000);
    socket.end();
    console.log('bridge stop:', await api('/api/bridge/stop'));
  }

  console.log('=== capture complete — device left idle; relaunch the program ===');
  process.exit(0);
}

main().catch(async err => {
  console.error('capture crashed:', err);
  try {
    console.log('bridge stop (cleanup):', await api('/api/bridge/stop'));
  } catch {}
  process.exit(1);
});
