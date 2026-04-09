#!/usr/bin/env bun

/**
 * Windows Serial Proxy with Traffic Recording
 *
 * Creates a virtual COM port using node-null, bridges it to the Pi
 * TCP bridge, and records all traffic with timestamps for offline analysis.
 *
 * Architecture:
 *   EB Tester VB6 App -> COM10 (virtual, created by node-null)
 *     -> this proxy -> TCP -> Pi TCP bridge -> /dev/serial0 -> ZKETech device
 *
 * Usage:
 *   bun run proxy                                      # auto-assign COM port
 *   bun run proxy -- --com 10                           # create COM10
 *   bun run proxy -- --com 10 --host coulomb --rtsp rtsp://...
 */

import { spawnSync } from 'node:child_process';
import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'bun';
import { decodeRxFrame, decodeTxFrame, parseFrame, scanForFrames, toHex } from '../protocol/codec.ts';
import { RxPacketLength, TxPacketLength } from '../protocol/constants.ts';
import type { ParsedFrame } from '../protocol/types.ts';
import { BridgeTcpPort, DeployHost } from '../run/config.ts';
import { RtspCamera } from './camera.ts';
import { findEbTesterWindow, GuiCapture } from './gui-capture.ts';
import { Recorder } from './recorder.ts';
import { SignalChanged, type SignalState, VirtualComPort } from './serial-port.ts';

// ── CLI Argument Parsing ──────────────────────────────────────────────

interface ProxyConfig {
  comPortNumber: number | undefined;
  host: string;
  port: number;
  logDir: string;
  rtspUrl: string | null;
  rtspCrop: string | undefined;
  testMode: boolean;
}

function parseArgs(): ProxyConfig {
  const argv = process.argv.slice(2);
  const config: ProxyConfig = {
    comPortNumber: undefined,
    host: DeployHost,
    port: BridgeTcpPort,
    logDir: 'recordings',
    rtspUrl: process.env.RTSP_URL ?? null,
    rtspCrop: process.env.RTSP_CROP,
    testMode: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--com':
        config.comPortNumber = Number(argv[++i]);
        break;
      case '--host':
        config.host = argv[++i];
        break;
      case '--port':
        config.port = Number(argv[++i]);
        break;
      case '--log':
        config.logDir = argv[++i];
        break;
      case '--rtsp':
        config.rtspUrl = argv[++i];
        break;
      case '--test':
        config.testMode = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  return config;
}

function printUsage(): void {
  console.log(`
Usage: bun run proxy [--com <N>] [--host <HOST>] [--port <PORT>] [--log <DIR>]

Options:
  --com <N>       COM port number to create (e.g. 10 for COM10) [auto-assigned if omitted]
  --host <HOST>   Pi hostname or IP                             [env: DEPLOY_HOST, default: ${DeployHost}]
  --port <PORT>   Pi TCP bridge port                            [default: ${BridgeTcpPort}]
  --log <DIR>     Recording output directory                    [default: recordings/]
  --rtsp <URL>    RTSP camera URL for LCD screenshots           [env: RTSP_URL]
  --test          Test mode: skip COM port and TCP, test cameras/recording only
  -h, --help      Show this help message

Camera:
  When --rtsp is provided (or RTSP_URL env var is set), ffmpeg decodes the
  stream at 2fps. Screenshots are captured automatically ~2s after each TX
  command, or manually by typing "snap" or "s" in the console.

The proxy creates a virtual COM port via node-null. Open that COM port in
EB Tester to begin capturing traffic.
`);
}

// ── Console Display ───────────────────────────────────────────────────

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

function displayFrame(frame: ParsedFrame): void {
  const time = formatTime();
  const hex = toHex(frame.raw);
  const len = frame.raw.length;

  if (frame.direction === 'tx') {
    const decoded = decodeTxFrame(frame);
    let detail = `CMD=0x${frame.command.toString(16).padStart(2, '0')} (${decoded.commandName})`;
    if (decoded.currentSetpoint !== undefined && decoded.currentSetpoint > 0) {
      detail += ` I=${decoded.currentSetpoint.toFixed(4)}A`;
    }
    if (decoded.cutoffVoltage !== undefined && decoded.cutoffVoltage > 0) {
      detail += ` cutoff=${decoded.cutoffVoltage.toFixed(2)}V`;
    }
    console.log(`\x1b[36m[${time}] TX  ${len} bytes  ${detail}\x1b[0m`);
    console.log(`\x1b[90m         ${hex}\x1b[0m`);
  } else {
    const decoded = decodeRxFrame(frame);
    const stateHex = `0x${decoded.state.toString(16).padStart(2, '0')}`;
    console.log(
      `\x1b[32m[${time}] RX  ${len} bytes  STATE=${stateHex}  V=${decoded.voltage.toFixed(3)}  I=${decoded.current.toFixed(4)}A\x1b[0m`
    );
    console.log(`\x1b[90m         ${hex}\x1b[0m`);
  }

  if (!frame.checksumValid) {
    console.log(`\x1b[31m         CHECKSUM INVALID\x1b[0m`);
  }
}

function displaySignal(state: SignalState): void {
  const time = formatTime();
  const parts: string[] = [];

  if (state.changedMask & SignalChanged.BAUD) parts.push(`baud=${state.baudRate}`);
  if (state.changedMask & SignalChanged.LINE_CONTROL) {
    parts.push(
      `${state.dataBits}${state.parity[0].toUpperCase()}${state.stopBits === 'one' ? '1' : state.stopBits === 'two' ? '2' : '1.5'}`
    );
  }
  if (state.changedMask & SignalChanged.DTR) parts.push(`DTR=${state.dtr ? 'ON' : 'OFF'}`);
  if (state.changedMask & SignalChanged.RTS) parts.push(`RTS=${state.rts ? 'ON' : 'OFF'}`);
  if (state.changedMask & SignalChanged.COM_OPEN) parts.push('COM OPENED');
  if (state.changedMask & SignalChanged.COM_CLOSE) parts.push('COM CLOSED');
  if (state.changedMask & SignalChanged.BREAK) parts.push(`BREAK=${state.breakState ? 'ON' : 'OFF'}`);
  if (state.changedMask & SignalChanged.HANDFLOW) parts.push('HANDFLOW changed');

  if (parts.length > 0) {
    console.log(`\x1b[90m[${time}] SIG  ${parts.join('  ')}\x1b[0m`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('=== Battery Controller Serial Proxy ===');
  if (config.testMode) console.log('MODE:      TEST (no COM port, no TCP)');
  if (!config.testMode) console.log(`Pi host:   ${config.host}:${config.port}`);
  console.log(`Log dir:   ${config.logDir}`);
  if (config.rtspUrl) console.log(`RTSP cam:  ${config.rtspUrl}`);
  console.log();

  // Create recorder
  const recorder = new Recorder(config.logDir);
  console.log(`Recording to: ${recorder.getPath()}`);

  // Start RTSP camera if configured
  let camera: RtspCamera | null = null;
  if (config.rtspUrl) {
    camera = new RtspCamera(config.rtspUrl, recorder.getDir(), config.rtspCrop);
    camera.start();
  }

  // Auto-detect EB Tester GUI window for screenshots
  let gui: GuiCapture | null = null;
  const guiWindowTitle = findEbTesterWindow();
  if (guiWindowTitle) {
    gui = new GuiCapture(guiWindowTitle, recorder.getDir());
    console.log(`GUI window: "${guiWindowTitle}"`);
  } else {
    console.log('GUI window: EB Tester not detected (will re-check on first TX)');
  }

  const hasAnyCaptureSource = (): boolean => camera !== null || gui !== null;

  // Screenshot capture helper — captures RTSP + GUI, stitches into one image
  let captureCount = 0;
  function doCapture(label: string): void {
    // Try to detect GUI if we haven't found it yet
    if (!gui) {
      const title = findEbTesterWindow();
      if (title) {
        gui = new GuiCapture(title, recorder.getDir());
        console.log(`\x1b[90m[${formatTime()}] GUI window detected: "${title}"\x1b[0m`);
      }
    }

    const dir = recorder.getDir();
    captureCount++;
    const tag = captureCount.toString().padStart(4, '0');

    // Capture both sources to temp files
    const cameraFile = camera?.capture();
    const guiFile = gui?.capture();

    const cameraMeta = cameraFile ? JSON.parse(cameraFile) : null;
    const guiMeta = guiFile ? JSON.parse(guiFile) : null;

    // If we have both, stitch side by side with ffmpeg (GUI left, RTSP right)
    if (cameraMeta && guiMeta) {
      const stitchedName = `snap-${tag}.jpg`;
      const stitchedPath = join(dir, stitchedName);
      const result = spawnSync(
        'ffmpeg',
        [
          '-i',
          join(dir, guiMeta.filename),
          '-i',
          join(dir, cameraMeta.filename),
          '-filter_complex',
          '[0]scale=-1:720[gui];[1]scale=-1:720[cam];[gui][cam]hstack=inputs=2',
          '-q:v',
          '2',
          '-y',
          stitchedPath,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 }
      );

      if (result.status === 0) {
        // Clean up individual files, record the stitched one
        try {
          unlinkSync(join(dir, cameraMeta.filename));
        } catch {}
        try {
          unlinkSync(join(dir, guiMeta.filename));
        } catch {}
        const stat = statSync(stitchedPath);
        recorder.screenshot(stitchedName, stat.size);
        const sizeKb = (stat.size / 1024).toFixed(0);
        console.log(`\x1b[35m[${formatTime()}] \u{1F4F7} ${label}: ${stitchedName} (${sizeKb} KB)\x1b[0m`);
        return;
      }
      // ffmpeg failed — fall through to record individually
    }

    // Record whatever we got individually
    if (cameraMeta) {
      recorder.screenshot(cameraMeta.filename, cameraMeta.sizeBytes);
      const sizeKb = (cameraMeta.sizeBytes / 1024).toFixed(0);
      console.log(`\x1b[35m[${formatTime()}] \u{1F4F7} ${label}: ${cameraMeta.filename} (${sizeKb} KB)\x1b[0m`);
    }
    if (guiMeta) {
      recorder.screenshot(guiMeta.filename, guiMeta.sizeBytes);
      const sizeKb = (guiMeta.sizeBytes / 1024).toFixed(0);
      console.log(`\x1b[35m[${formatTime()}] \u{1F5BC}\u{FE0F}  ${label}: ${guiMeta.filename} (${sizeKb} KB)\x1b[0m`);
    }
  }

  // TX screenshot trigger: capture immediately on first TX frame,
  // then again 1 second later (after device responds and GUI updates).
  let followupTimer: ReturnType<typeof setTimeout> | null = null;
  function onTxFrame(): void {
    if (!hasAnyCaptureSource()) return;

    // Immediate capture — what the GUI showed when it sent the command
    doCapture('TX');

    // Schedule followup 1s later — GUI after device response
    if (followupTimer) clearTimeout(followupTimer);
    followupTimer = setTimeout(() => {
      followupTimer = null;
      doCapture('TX +1s');
    }, 1000);
  }

  // Frame reassembly buffers for live decode
  let txBuffer = new Uint8Array(0);
  let rxBuffer = new Uint8Array(0);

  function appendBuffer(existing: Uint8Array, newData: Uint8Array): Uint8Array {
    const combined = new Uint8Array(existing.length + newData.length);
    combined.set(existing);
    combined.set(newData, existing.length);
    return combined;
  }

  // ── Serial + TCP (skipped in test mode) ────────────────────────────

  let comPort: VirtualComPort | null = null;
  let tcpSocket: Socket<unknown> | null = null;

  if (!config.testMode) {
    // Create virtual COM port
    console.log();
    comPort = new VirtualComPort(config.comPortNumber);
    const portName = await comPort.open();
    console.log(`Virtual COM port created: ${portName}`);
    console.log(`>>> Open ${portName} in EB Tester to begin <<<`);
    console.log();

    // Log serial signal changes (baud rate, DTR, open/close, etc.)
    comPort.onSignal((state: SignalState) => {
      displaySignal(state);

      // Record significant signal changes as notes
      if (state.changedMask & SignalChanged.COM_OPEN) {
        recorder.note(`EB Tester opened ${portName}`);
      }
      if (state.changedMask & SignalChanged.COM_CLOSE) {
        recorder.note(`EB Tester closed ${portName}`);
      }
      if (state.changedMask & SignalChanged.BAUD) {
        recorder.note(`Baud rate set to ${state.baudRate}`);
      }
      if (state.changedMask & SignalChanged.LINE_CONTROL) {
        recorder.note(`Line: ${state.dataBits}${state.parity[0].toUpperCase()}${state.stopBits === 'one' ? '1' : '2'}`);
      }
    });

    // Connect to Pi TCP bridge
    console.log(`Connecting to ${config.host}:${config.port}...`);

    const tcpConnected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('TCP connection timeout (10s)')), 10_000);

      Bun.connect({
        hostname: config.host,
        port: config.port,
        socket: {
          open(socket) {
            clearTimeout(timeout);
            tcpSocket = socket;
            console.log(`Connected to Pi at ${config.host}:${config.port}`);
            resolve();
          },

          data(_socket, data) {
            // Pi -> proxy -> COM port (rx direction: device -> host)
            const bytes = new Uint8Array(data);
            recorder.write('rx', bytes);

            // Forward to COM port
            comPort?.write(bytes).catch(err => {
              console.error(`COM port write error: ${err.message}`);
            });

            // Live frame decode
            rxBuffer = appendBuffer(rxBuffer, bytes);
            const result = scanForFrames(rxBuffer, RxPacketLength);
            rxBuffer = result.remainder;
            for (const raw of result.frames) {
              const frame = parseFrame(raw, 'rx');
              if (frame) displayFrame(frame);
            }
          },

          close() {
            console.error('\nTCP connection to Pi lost!');
            console.error('Recording stopped. Restart the proxy to reconnect.');
            shutdown();
          },

          error(_socket, error) {
            console.error(`TCP error: ${error.message}`);
            reject(error);
          },
        },
      });
    });

    // Wait for TCP connection
    await tcpConnected;

    // COM port -> proxy -> TCP (tx direction: host -> device)
    comPort.onData((data: Buffer) => {
      const bytes = new Uint8Array(data);
      recorder.write('tx', bytes);

      // Forward to Pi
      if (tcpSocket) {
        tcpSocket.write(bytes);
      }

      // Live frame decode
      txBuffer = appendBuffer(txBuffer, bytes);
      const result = scanForFrames(txBuffer, TxPacketLength);
      txBuffer = result.remainder;
      for (const raw of result.frames) {
        const frame = parseFrame(raw, 'tx');
        if (frame) {
          displayFrame(frame);
          onTxFrame(); // capture GUI + RTSP now and again in 1s
        }
      }
    });

    comPort.onError((err: Error) => {
      console.error(`COM port error: ${err.message}`);
    });
  }

  // ── Ready ─────────────────────────────────────────────────────────

  console.log();
  if (config.testMode) {
    console.log('--- Test mode active. Press Ctrl+C to stop. ---');
  } else {
    console.log('--- Proxy active. Press Ctrl+C to stop. ---');
  }
  console.log();

  // ── Interactive annotation via stdin ──────────────────────────────
  // While the proxy runs, type a note and press Enter to annotate the
  // recording. Notes are timestamped in the JSONL alongside traffic.

  const rl = await import('node:readline');
  const reader = rl.createInterface({ input: process.stdin, terminal: false });

  console.log('Type a note and press Enter to annotate the recording.');
  if (hasAnyCaptureSource()) console.log('Type "snap" or "s" to take a manual screenshot.');
  console.log();

  reader.on('line', (line: string) => {
    const text = line.trim();
    if (!text) return;

    // Manual screenshot command
    if (text === 'snap' || text === 's') {
      doCapture('SNAP (manual)');
      return;
    }

    recorder.note(text);
    console.log(`\x1b[33m[${formatTime()}] \u{1F4DD} NOTE: "${text}"\x1b[0m`);
  });

  // Graceful shutdown
  function shutdown(): void {
    console.log('\nShutting down...');
    if (followupTimer) clearTimeout(followupTimer);
    camera?.stop();
    gui?.stop();
    console.log(`Recorded ${recorder.getRecordCount()} events to ${recorder.getPath()}`);
    reader.close();
    recorder.close();
    comPort?.close().catch(() => {});
    if (tcpSocket) {
      tcpSocket.end();
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
