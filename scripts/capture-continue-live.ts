#!/usr/bin/env bun

/**
 * Real-hardware capture of mid-run continue semantics (protocol.md gap).
 *
 * Phase A (this script, --phase a): while the EBC-A40L is charging (C-CV,
 * CMD 0x28 continue), change the current setpoint mid-run and watch the
 * device-reported capacity accumulator — does it keep counting or reset?
 *
 * Phase C (--phase c): same question for D-CC (CMD 0x08 continue), which
 * is what gates the IR-probe feature. Assumes a d-cc test is already
 * running (started by the orchestrating session).
 *
 * Prints one CSV-ish line per poll: t, mode, I, V, capacityMah.
 * USER-AUTHORIZED interruption of the running charge (2026-07-16).
 */

const BASE = 'http://coulomb';

const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'a';

interface Reading {
  mode: string;
  reading: {
    current: number;
    voltage: number;
    capacityMah: number;
    setpointEcho: number | null;
  };
}

async function poll(): Promise<Reading> {
  const res = await fetch(`${BASE}/api/test/current`);
  return (await res.json()) as Reading;
}

async function continueWith(body: Record<string, number>): Promise<string> {
  const res = await fetch(`${BASE}/api/test/continue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return `${res.status} ${await res.text()}`;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function logPoll(t: number): Promise<void> {
  try {
    const s = await poll();
    console.log(
      `t=${t.toString().padStart(3)}s mode=${s.mode} I=${s.reading.current.toFixed(2)}A ` +
        `V=${s.reading.voltage.toFixed(3)}V cap=${s.reading.capacityMah.toFixed(0)}mAh ` +
        `setpointEcho=${s.reading.setpointEcho}`
    );
  } catch (e) {
    console.log(`t=${t}s POLL FAILED: ${e}`);
  }
}

// Each phase: baseline polls → continue to a lower current → polls →
// continue back → polls. The capacity column is the answer.
const PLANS = {
  a: {
    label: 'C-CV continue (0x28) on live charge',
    low: { currentA: 15, voltageV: 3.7, cutoffCurrentA: 2, maxTimeMin: 200 },
    high: { currentA: 20, voltageV: 3.7, cutoffCurrentA: 2, maxTimeMin: 200 },
  },
  c: {
    label: 'D-CC continue (0x08) on test discharge',
    low: { currentA: 5, cutoffV: 2.8, maxTimeMin: 15 },
    high: { currentA: 15, cutoffV: 2.8, maxTimeMin: 15 },
  },
} as const;

const plan = PLANS[phase as 'a' | 'c'];
if (!plan) {
  console.error(`Unknown phase: ${phase}`);
  process.exit(1);
}

console.log(`=== Phase ${phase.toUpperCase()}: ${plan.label} ===`);

let t = 0;
for (; t < 10; t += 2) {
  await logPoll(t);
  await sleep(2000);
}

console.log(`>>> continue → ${plan.low.currentA}A : ${await continueWith(plan.low)}`);
for (; t < 35; t += 2) {
  await logPoll(t);
  await sleep(2000);
}

console.log(`>>> continue → ${plan.high.currentA}A : ${await continueWith(plan.high)}`);
for (; t < 55; t += 2) {
  await logPoll(t);
  await sleep(2000);
}

console.log('=== capture complete ===');
