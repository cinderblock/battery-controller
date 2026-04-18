#!/usr/bin/env bun

/**
 * Data–Screenshot Correlator
 *
 * Connects to the TCP bridge on the Pi, listens for serial packets from
 * the ZKETech device, and captures an RTSP camera snapshot for every
 * received packet. Each snapshot is saved alongside the decoded packet
 * data in a JSONL log so that later OCR can correlate device readouts
 * with the protocol-level measurements.
 *
 * Usage:
 *   bun run correlate
 *   bun run correlate -- --host coulomb --rtsp rtsp://...
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildTxFrame, decodeRxFrame, parseFrame, scanForFrames, toHex } from '../protocol/codec.ts';
import { RxPacketLength } from '../protocol/constants.ts';
import type { DecodedRxFrame } from '../protocol/types.ts';
import { BridgeTcpPort } from '../run/config.ts';
import { RtspCamera } from '../proxy/camera.ts';

// ── Config ───────────────────────────────────────────────────────────

interface Config {
  host: string;
  port: number;
  rtspUrl: string;
  rtspFilter: string | undefined;
  outDir: string;
}

function loadConfig(): Config {
  const argv = process.argv.slice(2);
  const config: Config = {
    host: process.env.BRIDGE_HOST || '10.255.5.52',
    port: BridgeTcpPort,
    rtspUrl: process.env.RTSP_URL || '',
    rtspFilter: process.env.RTSP_FILTER,
    outDir: 'recordings',
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--host':
        config.host = argv[++i];
        break;
      case '--port':
        config.port = Number(argv[++i]);
        break;
      case '--rtsp':
        config.rtspUrl = argv[++i];
        break;
      case '--rtsp-filter':
        config.rtspFilter = argv[++i];
        break;
      case '--out':
        config.outDir = argv[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: bun run correlate [options]

Options:
  --host <HOST>         Pi hostname/IP           [env: BRIDGE_HOST, default: 10.255.5.52]
  --port <PORT>         TCP bridge port           [default: ${BridgeTcpPort}]
  --rtsp <URL>          RTSP camera URL           [env: RTSP_URL]
  --rtsp-filter <VF>    ffmpeg -vf filter string  [env: RTSP_FILTER]
  --out <DIR>           Output directory          [default: recordings]
  -h, --help            Show this help
`);
        process.exit(0);
    }
  }

  if (!config.rtspUrl) {
    console.error('Error: RTSP_URL env var or --rtsp flag is required');
    process.exit(1);
  }

  return config;
}

// ── JSONL Logger ─────────────────────────────────────────────────────

interface CorrelatedRecord {
  /** ISO timestamp */
  t: string;
  /** Monotonic time (ms) */
  mono: number;
  /** Record type */
  type: 'rx' | 'tx' | 'connect' | 'note';
  /** Decoded packet data (for rx records) */
  packet?: {
    state: number;
    current: number;
    voltage: number;
    field6: number;
    field7: number;
    field8: number;
    field9: number;
    field10: number;
    field11: number;
    field12: number;
    raw: string;
  };
  /** Screenshot filename (relative to session dir) */
  screenshot?: string | null;
  /** Free-form note */
  note?: string;
}

function createLogger(sessionDir: string) {
  const logPath = join(sessionDir, 'correlated.jsonl');
  const fd = Bun.file(logPath).writer();

  return {
    append(record: CorrelatedRecord) {
      fd.write(JSON.stringify(record) + '\n');
      fd.flush();
    },
    close() {
      fd.end();
    },
    path: logPath,
  };
}

// ── Display ──────────────────────────────────────────────────────────

function formatTime(): string {
  const now = new Date();
  return (
    [
      now.getHours().toString().padStart(2, '0'),
      now.getMinutes().toString().padStart(2, '0'),
      now.getSeconds().toString().padStart(2, '0'),
    ].join(':') +
    '.' +
    now.getMilliseconds().toString().padStart(3, '0')
  );
}

function displayRx(decoded: DecodedRxFrame, screenshotFile: string | null): void {
  const time = formatTime();
  const stateHex = `0x${decoded.state.toString(16).padStart(2, '0')}`;
  const snap = screenshotFile ? ` \x1b[35m${screenshotFile}\x1b[0m` : '';
  console.log(
    `\x1b[32m[${time}] RX  STATE=${stateHex}  V=${decoded.voltage.toFixed(3)}  I=${decoded.current.toFixed(4)}A${snap}\x1b[0m`
  );
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  // Create session directory
  const now = new Date();
  const sessionName = now
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, '');
  const sessionDir = join(config.outDir, sessionName);
  mkdirSync(sessionDir, { recursive: true });

  console.log('=== Battery Controller Data–Screenshot Correlator ===');
  console.log(`Bridge:    ${config.host}:${config.port}`);
  console.log(`RTSP cam:  ${config.rtspUrl}`);
  if (config.rtspFilter) console.log(`RTSP filt: ${config.rtspFilter}`);
  console.log(`Output:    ${sessionDir}`);
  console.log();

  // Start JSONL logger
  const logger = createLogger(sessionDir);
  logger.append({
    t: now.toISOString(),
    mono: performance.now(),
    type: 'note',
    note: `Session started. Bridge=${config.host}:${config.port} RTSP=${config.rtspUrl}`,
  });

  // Start RTSP camera
  const camera = new RtspCamera(config.rtspUrl, sessionDir, config.rtspFilter);
  camera.start();

  // Wait a moment for ffmpeg to produce the first frame
  console.log('Waiting for RTSP camera to produce first frame...');
  await Bun.sleep(3000);

  // Frame reassembly buffer
  let rxBuffer = new Uint8Array(0);
  let packetCount = 0;
  let connected = false;

  function appendBuffer(existing: Uint8Array, newData: Uint8Array): Uint8Array {
    const combined = new Uint8Array(existing.length + newData.length);
    combined.set(existing);
    combined.set(newData, existing.length);
    return combined;
  }

  function processRxData(data: Uint8Array): void {
    rxBuffer = appendBuffer(rxBuffer, data);
    const result = scanForFrames(rxBuffer, RxPacketLength);
    rxBuffer = result.remainder;

    for (const raw of result.frames) {
      const frame = parseFrame(raw, 'rx');
      if (!frame) continue;
      if (!frame.checksumValid) {
        console.log(`\x1b[31m[${formatTime()}] RX  CHECKSUM INVALID  ${toHex(raw)}\x1b[0m`);
        continue;
      }

      connected = true;
      packetCount++;

      const decoded = decodeRxFrame(frame);

      // Capture RTSP screenshot correlated with this packet
      const screenshotResult = camera.capture();
      let screenshotFile: string | null = null;
      if (screenshotResult) {
        try {
          const meta = JSON.parse(screenshotResult);
          screenshotFile = meta.filename;
        } catch {}
      }

      // Log correlated record
      logger.append({
        t: new Date().toISOString(),
        mono: performance.now(),
        type: 'rx',
        packet: {
          state: decoded.state,
          current: decoded.current,
          voltage: decoded.voltage,
          field6: decoded.field6,
          field7: decoded.field7,
          field8: decoded.field8,
          field9: decoded.field9,
          field10: decoded.field10,
          field11: decoded.field11,
          field12: decoded.field12,
          raw: toHex(raw),
        },
        screenshot: screenshotFile,
      });

      displayRx(decoded, screenshotFile);
    }
  }

  // Connect to TCP bridge
  console.log(`Connecting to ${config.host}:${config.port}...`);

  const socket = await new Promise<ReturnType<typeof Bun.connect>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('TCP connection timeout (10s)')), 10_000);

    Bun.connect({
      hostname: config.host,
      port: config.port,
      socket: {
        open(socket) {
          clearTimeout(timeout);
          console.log(`Connected to bridge at ${config.host}:${config.port}`);
          resolve(socket);
        },
        data(_socket, data) {
          processRxData(new Uint8Array(data));
        },
        close() {
          console.error('\nTCP connection lost!');
          shutdown();
        },
        error(_socket, error) {
          console.error(`TCP error: ${error.message}`);
          reject(error);
        },
      },
    });
  });

  // Send connect command (0x05) to start device streaming
  console.log('Sending CONNECT command (0x05)...');
  const connectPayload = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const connectFrame = buildTxFrame(connectPayload);
  socket.write(connectFrame);
  console.log(`TX  ${toHex(connectFrame)}`);

  logger.append({
    t: new Date().toISOString(),
    mono: performance.now(),
    type: 'connect',
    note: `Sent CONNECT command: ${toHex(connectFrame)}`,
  });

  // Wait for first packet to confirm device is responding
  console.log('Waiting for device response...');
  const startWait = Date.now();
  while (!connected && Date.now() - startWait < 10_000) {
    await Bun.sleep(100);
  }

  if (!connected) {
    console.error('No response from device after 10 seconds. Device may be off or disconnected.');
    console.log('Will keep listening...');
  } else {
    console.log('Device is responding. Correlating packets with screenshots.');
  }

  console.log();
  console.log('--- Running. Press Ctrl+C to stop. ---');
  console.log();

  // Graceful shutdown — send DISCONNECT so device exits PC mode
  function shutdown(): void {
    console.log(`\nShutting down... ${packetCount} packets correlated.`);

    // Send disconnect command before closing
    if (connected) {
      const disconnectFrame = buildTxFrame(new Uint8Array([0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      socket.write(disconnectFrame);
      console.log(`TX  DISCONNECT ${toHex(disconnectFrame)}`);
    }

    camera.stop();
    logger.close();

    // Brief delay so the disconnect frame gets flushed before TCP close
    setTimeout(() => {
      socket.end();
      console.log(`Log: ${logger.path}`);
      console.log(`Screenshots: ${sessionDir}`);
      process.exit(0);
    }, 500);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
