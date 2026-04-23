#!/usr/bin/env bun

/**
 * Fake device entry point.
 *
 * Creates a virtual COM port, spins up a FakeDevice, and exposes the
 * control API over HTTP. External applications (notably the EB Tester
 * VB6 app) open the COM port and speak to the synthetic device as if
 * it were real hardware.
 *
 * Usage (see scripts/README.md for full reference):
 *   bun run fake-device
 *   bun run fake-device -- --com 11 --profile ebc-a40l --api-port 49700
 */

import { VirtualComPort } from '../../src/proxy/serial-port.ts';
import { startControlApi } from './control-api.ts';
import { FakeDevice } from './device.ts';
import { getProfile } from './profiles/index.ts';

// ── CLI ───────────────────────────────────────────────────────────────

interface Config {
  comPortNumber: number;
  profileName: string;
  apiPort: number;
  quiet: boolean;
}

function parseArgs(): Config {
  const argv = process.argv.slice(2);
  const config: Config = {
    // Default to COM2 and walk up through 9 on conflict — EB Tester only
    // accepts ports in COM2..COM9, so we must stay in that range.
    comPortNumber: 2,
    profileName: 'ebc-a40l',
    apiPort: 49700,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--com':
        config.comPortNumber = Number(argv[++i]);
        break;
      case '--profile':
        config.profileName = argv[++i];
        break;
      case '--api-port':
        config.apiPort = Number(argv[++i]);
        break;
      case '--quiet':
        config.quiet = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return config;
}

function printUsage(): void {
  console.log(`
Usage: bun run fake-device [options]

  --com N           Virtual COM port number (default: 2, falls back through 9)
  --profile NAME    Device profile (default: ebc-a40l)
  --api-port N      HTTP control API port (default: 49700)
  --quiet           Don't print TX/RX frames to stdout
  -h, --help        Show this help
`);
}

// ── Pretty printing (mirrors src/proxy/index.ts conventions) ─────────

function timestamp(): string {
  const now = new Date();
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();
  const profile = getProfile(config.profileName);

  console.log('=== Battery Controller Fake Device ===');
  console.log(`Profile:   ${profile.name} (${profile.family})`);
  console.log(`API port:  ${config.apiPort}`);
  console.log();

  // Open the virtual COM port first so the user sees the name ASAP.
  const comPort = new VirtualComPort(config.comPortNumber);
  const portName = await comPort.open();
  console.log(`Virtual COM port created: ${portName}`);
  console.log(`>>> In EB Tester: set port to ${portName} and connect <<<`);
  console.log();

  // Build the FakeDevice and wire its "onTransmit" hook to the COM port.
  const device = new FakeDevice({
    profile,
    onTransmit: bytes => {
      comPort.write(bytes).catch(err => {
        console.error(`COM write error: ${err.message}`);
      });
    },
  });

  // Route incoming bytes from the VB6 app into the device.
  comPort.onData(buf => {
    device.ingestBytes(new Uint8Array(buf));
  });

  comPort.onError(err => {
    console.error(`COM error: ${err.message}`);
  });

  // Subscribe to the device's log so we can print frames live.
  if (!config.quiet) {
    device.subscribe(entry => {
      // Keep it concise — hex + summary.
      const prefix =
        entry.dir === 'tx'
          ? '\x1b[36m' // cyan
          : entry.dir === 'rx'
            ? '\x1b[32m' // green
            : entry.dir === 'state'
              ? '\x1b[35m' // magenta
              : '\x1b[33m'; // yellow for notes
      const reset = '\x1b[0m';
      const gray = '\x1b[90m';
      const tag = entry.dir.toUpperCase().padEnd(5);
      console.log(`${prefix}[${timestamp()}] ${tag} ${entry.summary}${reset}`);
      if (entry.hex) {
        console.log(`${gray}         ${entry.hex}${reset}`);
      }
      if (entry.checksumValid === false) {
        console.log('\x1b[31m         CHECKSUM INVALID\x1b[0m');
      }
    });
  }

  device.start();

  // Start the control API.
  const api = startControlApi({
    device,
    port: config.apiPort,
    onReady: url => console.log(`Control API:  ${url}`),
  });
  console.log();
  console.log('--- Fake device active. Press Ctrl+C to stop. ---');
  console.log();

  // Graceful shutdown.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting down (${signal})...`);
    device.stop();
    await api.stop().catch(() => {});
    await comPort.close().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  console.error(`Fatal: ${err?.stack ?? err?.message ?? err}`);
  process.exit(1);
});
