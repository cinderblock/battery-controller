#!/usr/bin/env bun

/**
 * probe-devices.ts — sweep one axis of the RX identity triple (bytes
 * 14, 15, 16) and capture a screenshot of the EB Tester UI for each value.
 *
 * ## How the UI reads device identity (important!)
 *
 * Experiments (Apr 2026) confirmed:
 *   - Byte 16 (deviceConstantByte) is the UI's device identifier.
 *   - The UI reads identity ONLY when it receives an info packet (state
 *     byte 0x66) in response to CMD 0x05 (init). Info packets that arrive
 *     spontaneously after that are IGNORED for identity purposes.
 *   - Therefore: to make the UI re-identify, we must disconnect and
 *     reconnect the UI between probes, which forces a fresh init handshake.
 *
 * The older `/emit-info` approach (just force an info packet) is kept in
 * the control API for protocol testing, but it does not change what the UI
 * displays. Don't use it for identity sweeps.
 *
 * ## What this script does, per probe value
 *
 *   1. PATCH /identity on the fake device with the new byte values.
 *   2. (If --reconnect, the default) Click Disconn, then Connect in the UI
 *      driver so the EB Tester re-issues CMD 0x05 and reads byte 16 fresh.
 *   3. POST /note so the sweep is visible in the fake device's log.
 *   4. Wait --settle-ms for the UI to finish redrawing after reconnect.
 *   5. GET /screenshot from the UI driver.
 *   6. Save the PNG + a JSONL entry under scripts/probes/<timestamp>-<axis>/.
 *
 * ## Prereqs
 *
 *   bun run fake-device                       # exposes :49700
 *   uv run python scripts/ui-driver/driver.py --auto-attach ".*EB Tester.*"
 *                                             # exposes :49701, attached to EB Tester
 *   The EB Tester should be launched and attached. This script does not
 *   kill/relaunch it — it just toggles the Connect/Disconn button.
 *
 * A follow-up OCR script reads each screenshot's title region to produce
 * the byte → device-name table.
 *
 * Usage:
 *   bun run scripts/probe-devices.ts                        # full byte-16 sweep
 *   bun run scripts/probe-devices.ts --start 0x00 --end 0x0f
 *   bun run scripts/probe-devices.ts --axis byte14 --fixed15 0xef --fixed16 0x0a
 *   bun run scripts/probe-devices.ts --no-reconnect         # legacy emit-info mode
 *   bun run scripts/probe-devices.ts --help
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── CLI ────────────────────────────────────────────────────────────────

type Axis = 'byte14' | 'byte15' | 'byte16';

interface Config {
  axis: Axis;
  start: number;
  end: number; // inclusive
  fixed14: number;
  fixed15: number;
  fixed16: number;
  settleMs: number;
  fakeDeviceUrl: string;
  uiDriverUrl: string;
  outDir: string | null; // null = auto from timestamp
  skip: Set<number>;
  dryRun: boolean;
  verbose: boolean;
  /**
   * If true (default), disconnect+reconnect the EB Tester between probes
   * so each byte value drives a fresh CMD 0x05 init handshake, which is
   * the only path by which the UI re-reads the identity bytes. If false,
   * fall back to the old /emit-info approach (useful only for testing
   * that info packets themselves are reaching the UI — it does NOT change
   * what the UI displays).
   */
  reconnect: boolean;
  /** ms to wait after clicking Disconn before clicking Connect. */
  disconnectMs: number;
  /** ms to wait for UI to process init after clicking Connect. */
  connectMs: number;
}

function parseByte(v: string): number {
  const n = v.startsWith('0x') || v.startsWith('0X') ? parseInt(v.slice(2), 16) : parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) {
    throw new Error(`invalid byte value: ${v} (expected 0..255)`);
  }
  return n;
}

function parseArgs(): Config {
  const argv = process.argv.slice(2);
  const c: Config = {
    axis: 'byte16',
    start: 0x00,
    end: 0xef,
    fixed14: 0x00,
    fixed15: 0x00,
    fixed16: 0x0a,
    settleMs: 1500,
    fakeDeviceUrl: 'http://127.0.0.1:49700',
    uiDriverUrl: 'http://127.0.0.1:49701',
    outDir: null,
    skip: new Set(),
    dryRun: false,
    verbose: false,
    reconnect: true,
    disconnectMs: 800,
    connectMs: 1500,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--axis': {
        const v = need();
        if (v !== 'byte14' && v !== 'byte15' && v !== 'byte16') {
          throw new Error(`invalid --axis: ${v} (expected byte14|byte15|byte16)`);
        }
        c.axis = v;
        break;
      }
      case '--start':
        c.start = parseByte(need());
        break;
      case '--end':
        c.end = parseByte(need());
        break;
      case '--fixed14':
        c.fixed14 = parseByte(need());
        break;
      case '--fixed15':
        c.fixed15 = parseByte(need());
        break;
      case '--fixed16':
        c.fixed16 = parseByte(need());
        break;
      case '--settle-ms':
        c.settleMs = Number(need());
        if (!Number.isFinite(c.settleMs) || c.settleMs < 0) {
          throw new Error('--settle-ms must be a non-negative number');
        }
        break;
      case '--fake-device-url':
        c.fakeDeviceUrl = need().replace(/\/+$/, '');
        break;
      case '--ui-driver-url':
        c.uiDriverUrl = need().replace(/\/+$/, '');
        break;
      case '--out':
        c.outDir = need();
        break;
      case '--skip': {
        for (const s of need().split(',')) {
          if (s.trim()) c.skip.add(parseByte(s.trim()));
        }
        break;
      }
      case '--dry-run':
        c.dryRun = true;
        break;
      case '--reconnect':
        c.reconnect = true;
        break;
      case '--no-reconnect':
        c.reconnect = false;
        break;
      case '--disconnect-ms':
        c.disconnectMs = Number(need());
        if (!Number.isFinite(c.disconnectMs) || c.disconnectMs < 0) {
          throw new Error('--disconnect-ms must be a non-negative number');
        }
        break;
      case '--connect-ms':
        c.connectMs = Number(need());
        if (!Number.isFinite(c.connectMs) || c.connectMs < 0) {
          throw new Error('--connect-ms must be a non-negative number');
        }
        break;
      case '--verbose':
      case '-v':
        c.verbose = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        printUsage();
        process.exit(1);
    }
  }

  if (c.end < c.start) {
    throw new Error(`--end (${hexByte(c.end)}) must be >= --start (${hexByte(c.start)})`);
  }
  return c;
}

function printUsage(): void {
  console.log(`
Usage: bun run scripts/probe-devices.ts [options]

Sweep one axis of the RX identity triple (bytes 14, 15, 16) and capture
an EB Tester UI screenshot for each value.

Options:
  --axis byte14|byte15|byte16  Which axis to vary (default: byte16)
  --start N                    First value, decimal or 0x-prefixed (default 0x00)
  --end N                      Last value, inclusive (default 0xef)
  --fixed14 N                  Value for byte 14 when not swept (default 0x00)
  --fixed15 N                  Value for byte 15 when not swept (default 0x00)
  --fixed16 N                  Value for byte 16 when not swept (default 0x0a)
  --settle-ms N                Wait ms after PATCH before screenshot (default 1500)
  --fake-device-url URL        Fake-device control API (default http://127.0.0.1:49700)
  --ui-driver-url URL          UI-driver API (default http://127.0.0.1:49701)
  --out DIR                    Output directory (default: scripts/probes/<ts>-<axis>)
  --skip LIST                  Comma-separated bytes to skip (e.g. "0x00,0xff")
  --reconnect                  Force reconnect-per-probe (the default).
  --no-reconnect               Use /emit-info only (legacy mode, usually
                               useless for identity sweeps — the UI
                               ignores post-init info packets for naming).
  --disconnect-ms N            ms to wait after Disconn click (default 800)
  --connect-ms N               ms to wait after Connect click (default 1500)
  --dry-run                    Validate + print plan, don't hit APIs
  -v, --verbose                Verbose logging
  -h, --help                   Show this help

Examples:
  # Default: full byte-16 sweep, 0x00..0xef, ~6 min
  bun run scripts/probe-devices.ts

  # Quick smoke test
  bun run scripts/probe-devices.ts --start 0x00 --end 0x0f

  # Sweep byte 14 with the anomalous-value context (byte15=byte14=0xef on A40L)
  bun run scripts/probe-devices.ts --axis byte14 --fixed15 0xef --fixed16 0x0a
`);
}

// ── Helpers ────────────────────────────────────────────────────────────

function timestampIso(): string {
  // 2026-04-21_14-30-00
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function hexByte(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

async function httpBinary(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`GET ${url} → ${resp.status}: ${text.slice(0, 200)}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

// ── Service verification ───────────────────────────────────────────────

interface FakeDeviceStatus {
  profile?: string;
  comPort?: string;
  identity?: {
    deviceTypeByte: number;
    deviceSubtypeByte: number;
    deviceConstantByte: number;
    infoMaxCurrent: number;
    infoMaxVoltage: number;
  };
  [k: string]: unknown;
}

interface UiDriverStatus {
  attached?: boolean;
  window_title?: string | null;
  pid?: number | null;
  backend?: string;
}

async function verifyServices(
  config: Config
): Promise<{ fakeDevice: FakeDeviceStatus; uiDriver: UiDriverStatus }> {
  console.log('Checking services...');

  const fakeDevice = await httpJson<FakeDeviceStatus>(`${config.fakeDeviceUrl}/status`).catch(err => {
    throw new Error(
      `Fake device not reachable at ${config.fakeDeviceUrl}: ${(err as Error).message}\n` +
        `  Start it with: bun run fake-device`
    );
  });
  console.log(
    `  fake-device: OK  (profile=${fakeDevice.profile ?? '?'}, com=${fakeDevice.comPort ?? '?'})`
  );

  const uiDriver = await httpJson<UiDriverStatus>(`${config.uiDriverUrl}/status`).catch(err => {
    throw new Error(
      `UI driver not reachable at ${config.uiDriverUrl}: ${(err as Error).message}\n` +
        `  Start it with: uv run python scripts/ui-driver/driver.py --auto-attach ".*EB Tester.*"`
    );
  });
  if (!uiDriver.attached) {
    throw new Error(
      `UI driver is running but not attached. Attach it first:\n` +
        `  curl -X POST ${config.uiDriverUrl}/attach -H 'content-type: application/json' -d '{"title_re":".*EB Tester.*"}'`
    );
  }
  console.log(`  ui-driver:   OK  (attached to "${uiDriver.window_title}", backend=${uiDriver.backend})`);
  console.log();
  return { fakeDevice, uiDriver };
}

// ── UI button state helpers (for --reconnect mode) ────────────────────

interface ControlInfo {
  class_name: string | null;
  title: string | null;
  visible: boolean | null;
  enabled: boolean | null;
  handle: number | null;
}

/**
 * Find the Connect / Disconn button's CURRENT title by scanning the
 * control tree. VB6 enumerates the same button many times through its
 * MDI hierarchy (same handle, different depths) — we just return the
 * first one we find.
 */
async function readConnectButtonTitle(uiDriverUrl: string): Promise<'Connect' | 'Disconn' | null> {
  const controls = await httpJson<ControlInfo[]>(`${uiDriverUrl}/controls`);
  for (const c of controls) {
    if (c.class_name === 'ThunderRT6CommandButton') {
      if (c.title === 'Connect' || c.title === 'Disconn') return c.title;
    }
  }
  return null;
}

/**
 * Click the Connect / Disconn button by current title. Uses the message
 * click (BM_CLICK via SendMessage) which works without focus and off-
 * screen. Falls back to real mouse input if BM_CLICK doesn't flip the
 * title within the timeout — some window states don't respond to
 * BM_CLICK, and we'd rather have a slower-but-working click than a
 * silent no-op.
 */
async function clickConnectButton(
  uiDriverUrl: string,
  wantedCurrentTitle: 'Connect' | 'Disconn',
  waitMs: number
): Promise<{ ok: boolean; method: string; newTitle: string | null }> {
  const currentTitle = await readConnectButtonTitle(uiDriverUrl);
  if (currentTitle !== wantedCurrentTitle) {
    // Already in the state we wanted the button to transition to? Could
    // happen if a previous click took effect after the caller's timeout.
    return { ok: true, method: 'noop', newTitle: currentTitle };
  }

  const expected = wantedCurrentTitle === 'Connect' ? 'Disconn' : 'Connect';
  for (const method of ['message', 'input'] as const) {
    try {
      await httpJson(`${uiDriverUrl}/click`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: wantedCurrentTitle, method }),
      });
    } catch (err) {
      if (method === 'input') throw err;
      // Fall through to input attempt.
      continue;
    }

    // Poll the title until it flips or we time out. VB6 redraws fast
    // after BM_CLICK — a few hundred ms is usually plenty. Note: the
    // deadline is reset for each method attempt, so the input fallback
    // gets its own full budget.
    const deadline = performance.now() + waitMs;
    while (performance.now() < deadline) {
      const t = await readConnectButtonTitle(uiDriverUrl);
      if (t === expected) return { ok: true, method, newTitle: t };
      await sleep(100);
    }
    // Didn't flip — try next method.
  }

  const finalTitle = await readConnectButtonTitle(uiDriverUrl);
  return { ok: false, method: 'failed', newTitle: finalTitle };
}

/**
 * Ensure the UI is disconnected, then reconnect. After this returns,
 * CMD 0x05 has been sent and the fake device has replied with an info
 * packet carrying the CURRENT identity.
 */
async function reconnectUi(
  uiDriverUrl: string,
  disconnectMs: number,
  connectMs: number
): Promise<{ disconnectMethod: string; connectMethod: string }> {
  // Step 1: if connected, disconnect. Wait for the title to flip to Connect.
  const startTitle = await readConnectButtonTitle(uiDriverUrl);
  let disconnectMethod = 'noop';
  if (startTitle === 'Disconn') {
    const res = await clickConnectButton(uiDriverUrl, 'Disconn', disconnectMs);
    if (!res.ok) {
      throw new Error(`disconnect click did not flip button (last title: ${res.newTitle ?? '?'})`);
    }
    disconnectMethod = res.method;
    // The VB6 app often drops the COM handle a moment AFTER its UI caption
    // flips, and clicking Connect while the port is still held from the
    // previous session silently fails. Give the port a beat to really
    // release before reopening.
    await sleep(400);
  }

  // Step 2: click Connect. Wait for the title to flip to Disconn and
  // the UI to process the init handshake.
  const res = await clickConnectButton(uiDriverUrl, 'Connect', connectMs);
  if (!res.ok) {
    throw new Error(`connect click did not flip button (last title: ${res.newTitle ?? '?'})`);
  }
  return { disconnectMethod, connectMethod: res.method };
}

// ── Probe loop ─────────────────────────────────────────────────────────

interface ProbeEntry {
  idx: number;
  byte14: number;
  byte15: number;
  byte16: number;
  screenshot: string;
  screenshotBytes: number;
  windowTitle: string | null;
  patchMs: number;
  reconnectMs: number;
  screenshotMs: number;
  totalMs: number;
  disconnectMethod?: string;
  connectMethod?: string;
  t: string;
  error?: string;
}

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('=== probe-devices ===');
  console.log(`Axis:         ${config.axis}`);
  console.log(`Range:        ${hexByte(config.start)} .. ${hexByte(config.end)}  (${config.end - config.start + 1} values)`);
  console.log(
    `Fixed bytes:  14=${hexByte(config.fixed14)}  15=${hexByte(config.fixed15)}  16=${hexByte(config.fixed16)}`
  );
  console.log(`Settle:       ${config.settleMs} ms`);
  if (config.reconnect) {
    console.log(`Reconnect:    yes  (disconnect ${config.disconnectMs} ms, connect ${config.connectMs} ms)`);
  } else {
    console.log(`Reconnect:    no  (legacy emit-info mode — may not change displayed name)`);
  }
  console.log(`Fake device:  ${config.fakeDeviceUrl}`);
  console.log(`UI driver:    ${config.uiDriverUrl}`);
  if (config.skip.size > 0) {
    console.log(`Skip:         ${[...config.skip].map(hexByte).join(', ')}`);
  }
  console.log();

  // Build the sweep list up front.
  const values: number[] = [];
  for (let v = config.start; v <= config.end; v++) {
    if (!config.skip.has(v)) values.push(v);
  }
  console.log(`Will probe ${values.length} values.`);

  if (config.dryRun) {
    console.log('\n(dry-run — exiting without hitting APIs)');
    return;
  }

  // Verify services are reachable & attached before touching anything.
  const services = await verifyServices(config);

  // Output directory.
  const outDir = config.outDir ?? join('scripts', 'probes', `${timestampIso()}-${config.axis}`);
  const screenshotsDir = join(outDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const logPath = join(outDir, 'probe-log.jsonl');
  const configPath = join(outDir, 'config.json');

  // Snapshot the starting identity so we can restore at the end.
  const originalIdentity = await httpJson<{
    deviceTypeByte: number;
    deviceSubtypeByte: number;
    deviceConstantByte: number;
  }>(`${config.fakeDeviceUrl}/identity`);

  await Bun.write(
    configPath,
    JSON.stringify(
      {
        cli: { ...config, skip: [...config.skip] },
        startedAt: new Date().toISOString(),
        fakeDevice: services.fakeDevice,
        uiDriver: services.uiDriver,
        originalIdentity,
        notes:
          'Each row in probe-log.jsonl maps byte{14,15,16} to a screenshot path. ' +
          'Run the OCR pass to turn this into a const → device-name table.',
      },
      null,
      2
    )
  );

  console.log(`Output:       ${outDir}`);
  console.log();

  // JSONL log writer.
  const logWriter = Bun.file(logPath).writer();

  let aborted = false;
  const onSigint = (): void => {
    if (!aborted) {
      console.log('\n^C — finishing current probe, then exiting cleanly...');
      aborted = true;
    } else {
      console.log('\nSecond ^C — hard exit.');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  const overallStart = performance.now();
  let success = 0;
  let failed = 0;

  try {
    for (let i = 0; i < values.length; i++) {
      if (aborted) break;
      const v = values[i];
      const byte14 = config.axis === 'byte14' ? v : config.fixed14;
      const byte15 = config.axis === 'byte15' ? v : config.fixed15;
      const byte16 = config.axis === 'byte16' ? v : config.fixed16;

      const iterStart = performance.now();
      const iso = new Date().toISOString();
      let patchMs = 0;
      let reconnectMs = 0;
      let screenshotMs = 0;
      let disconnectMethod: string | undefined;
      let connectMethod: string | undefined;
      let entry: ProbeEntry;

      try {
        // 1. PATCH identity.
        const patchStart = performance.now();
        await httpJson(`${config.fakeDeviceUrl}/identity`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceTypeByte: byte14,
            deviceSubtypeByte: byte15,
            deviceConstantByte: byte16,
          }),
        });
        patchMs = Math.round(performance.now() - patchStart);

        // 2. Either reconnect the UI (the way that actually changes what
        //    the UI displays) or just force an info packet (legacy mode).
        if (config.reconnect) {
          const reconnectStart = performance.now();
          const r = await reconnectUi(config.uiDriverUrl, config.disconnectMs, config.connectMs);
          reconnectMs = Math.round(performance.now() - reconnectStart);
          disconnectMethod = r.disconnectMethod;
          connectMethod = r.connectMethod;
        } else {
          // Legacy: post an info packet. The fake device will emit it but
          // the UI probably won't change its displayed device name.
          await httpJson(`${config.fakeDeviceUrl}/emit-info`, { method: 'POST' });
        }

        // 3. Leave a breadcrumb in the fake device log (not fatal if it fails).
        await httpJson(`${config.fakeDeviceUrl}/note`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: `probe ${i + 1}/${values.length}: ${config.axis}=${hexByte(v)} (14=${hexByte(
              byte14
            )} 15=${hexByte(byte15)} 16=${hexByte(byte16)})`,
          }),
        }).catch(() => {
          /* best-effort */
        });

        // 4. Settle — UI finishes repainting after the reconnect.
        await sleep(config.settleMs);

        // 5. Screenshot.
        const shotStart = performance.now();
        const png = await httpBinary(`${config.uiDriverUrl}/screenshot`);
        screenshotMs = Math.round(performance.now() - shotStart);
        if (!isPng(png)) {
          throw new Error(`screenshot is not a valid PNG (${png.length} bytes)`);
        }

        const filename =
          [
            `probe-${config.axis}-${hexByte(v)}`,
            `t${hexByte(byte14)}`,
            `s${hexByte(byte15)}`,
            `c${hexByte(byte16)}`,
          ].join('_') + '.png';
        const screenshotRel = `screenshots/${filename}`;
        await Bun.write(join(outDir, screenshotRel), png);

        // 6. Window title (useful if the UI puts the device name in the title).
        const uiStatus = await httpJson<UiDriverStatus>(`${config.uiDriverUrl}/status`).catch(
          () => ({ window_title: null })
        );

        entry = {
          idx: i,
          byte14,
          byte15,
          byte16,
          screenshot: screenshotRel,
          screenshotBytes: png.length,
          windowTitle: uiStatus.window_title ?? null,
          patchMs,
          reconnectMs,
          screenshotMs,
          totalMs: Math.round(performance.now() - iterStart),
          t: iso,
          disconnectMethod,
          connectMethod,
        };
        success++;
      } catch (err) {
        entry = {
          idx: i,
          byte14,
          byte15,
          byte16,
          screenshot: '',
          screenshotBytes: 0,
          windowTitle: null,
          patchMs,
          reconnectMs,
          screenshotMs,
          totalMs: Math.round(performance.now() - iterStart),
          t: iso,
          disconnectMethod,
          connectMethod,
          error: (err as Error).message,
        };
        failed++;
      }

      logWriter.write(`${JSON.stringify(entry)}\n`);
      await logWriter.flush();

      // Progress — ETA uses cumulative average so it smooths out.
      const elapsedS = (performance.now() - overallStart) / 1000;
      const etaS = (elapsedS / (i + 1)) * (values.length - (i + 1));
      const pct = (((i + 1) / values.length) * 100).toFixed(1);
      const statusStr = entry.error ? `ERR ${entry.error.slice(0, 60)}` : `${entry.totalMs}ms`;
      console.log(
        `[${String(i + 1).padStart(3)}/${values.length}] ` +
          `14=${hexByte(byte14)} 15=${hexByte(byte15)} 16=${hexByte(byte16)}  ` +
          `${statusStr}  (${pct}%, eta ${etaS.toFixed(0)}s)`
      );
      if (config.verbose && !entry.error) {
        console.log(`       → ${entry.screenshot} (${(entry.screenshotBytes / 1024).toFixed(0)} KB)`);
      }
    }
  } finally {
    await logWriter.end();
    process.off('SIGINT', onSigint);

    // Best-effort restore of original identity.
    try {
      await httpJson(`${config.fakeDeviceUrl}/identity`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(originalIdentity),
      });
      if (config.verbose) console.log('Restored original identity.');
    } catch (err) {
      console.error(`Warning: could not restore identity: ${(err as Error).message}`);
    }
  }

  const elapsedS = ((performance.now() - overallStart) / 1000).toFixed(1);
  console.log();
  console.log('=== Done ===');
  console.log(`Probed:       ${success + failed} (${success} ok, ${failed} failed)`);
  console.log(`Elapsed:      ${elapsedS} s`);
  console.log(`Log:          ${logPath}`);
  console.log(`Screenshots:  ${screenshotsDir}`);
  console.log();
  console.log('Next: run the OCR analysis script to extract device names from the screenshots.');
  console.log('  (See scripts/probes/README.md once that script exists.)');

  process.exit(failed > 0 && success === 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Fatal: ${(err as Error)?.stack ?? (err as Error)?.message ?? err}`);
  process.exit(1);
});
