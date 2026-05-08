#!/usr/bin/env bun

/**
 * Data–Screenshot Correlator v2 — structured dataset, no images required
 *
 * Connects to the TCP bridge on the Pi, listens for serial packets from
 * the ZKETech device, and produces a structured JSONL dataset correlating:
 *
 *   1. Decoded protocol data (exact: voltage, current, state, capacity)
 *   2. LCD display text (fast Tesseract OCR, ~200ms)
 *   3. LCD display synthesis (instant: derived from protocol decode)
 *   4. GUI application text (UI Automation or Tesseract on screenshot)
 *
 * The dataset is pure structured data — no images needed. Screenshots
 * can optionally be saved with --save-images for debugging.
 *
 * Usage:
 *   bun run correlate
 *   bun run correlate -- --host coulomb --rtsp rtsp://...
 *   bun run correlate -- --save-images     # also save screenshot JPEGs
 *   bun run correlate -- --no-gui          # skip GUI capture
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readGui } from '../ocr/gui-reader.ts';
import { synthesizeFromProtocol } from '../ocr/lcd-parser.ts';
import { TesseractReader } from '../ocr/tesseract-reader.ts';
import type { CorrelatedRecord, GuiReading, OcrReading } from '../ocr/types.ts';
import { buildTxFrame, decodeRxFrame, parseFrame, scanForFrames, toHex } from '../protocol/codec.ts';
import { RxPacketLength } from '../protocol/constants.ts';
import type { DecodedRxFrame } from '../protocol/types.ts';
import { RtspCamera } from '../proxy/camera.ts';
import { GuiCapture, findEbTesterWindow } from '../proxy/gui-capture.ts';
import { BridgeTcpPort } from '../run/config.ts';

// ── Config ───────────────────────────────────────────────────────────

interface Config {
  host: string;
  port: number;
  rtspUrl: string;
  rtspFilter: string | undefined;
  outDir: string;
  /** Save screenshot images alongside structured data */
  saveImages: boolean;
  /** Enable GUI window capture + OCR */
  enableGui: boolean;
}

function loadConfig(): Config {
  const argv = process.argv.slice(2);
  const config: Config = {
    host: process.env.BRIDGE_HOST || '10.255.5.52',
    port: BridgeTcpPort,
    rtspUrl: process.env.RTSP_URL || '',
    rtspFilter: process.env.RTSP_FILTER,
    outDir: 'recordings',
    saveImages: false,
    enableGui: true,
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
      case '--save-images':
        config.saveImages = true;
        break;
      case '--no-gui':
        config.enableGui = false;
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
  --save-images         Save screenshot JPEGs     [default: off]
  --no-gui              Skip GUI window capture   [default: capture if found]
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

function displayRx(decoded: DecodedRxFrame, synthesis: OcrReading): void {
  const time = formatTime();
  const stateHex = `0x${decoded.state.toString(16).padStart(2, '0')}`;
  const p = synthesis.parsed;
  const mode = p.mode ?? '??';
  const status = p.status ?? '??';
  console.log(
    `\x1b[32m[${time}] RX  ${mode} ${stateHex}  V=${decoded.voltage.toFixed(3)}  ` +
      `I=${decoded.current.toFixed(4)}A  ${status}\x1b[0m`
  );
}

function displayOcr(reading: OcrReading): void {
  const time = formatTime();
  const conf = reading.confidence.toFixed(0);
  const text = reading.rawLines.join(' | ');
  const ms = reading.ocrMs;
  console.log(`\x1b[36m[${time}] OCR [${conf}% ${ms}ms] ${text}\x1b[0m`);
}

function displayGui(reading: GuiReading): void {
  const time = formatTime();
  const count = Object.keys(reading.fields).length;
  const src = reading.source;
  console.log(`\x1b[35m[${time}] GUI [${src} ${reading.readMs}ms] ${count} fields\x1b[0m`);
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

  console.log('=== Battery Controller Correlator v2 (structured dataset) ===');
  console.log(`Bridge:     ${config.host}:${config.port}`);
  console.log(`RTSP cam:   ${config.rtspUrl}`);
  if (config.rtspFilter) console.log(`RTSP filt:  ${config.rtspFilter}`);
  console.log(`Output:     ${sessionDir}`);
  console.log(`Images:     ${config.saveImages ? 'saving' : 'off (structured data only)'}`);
  console.log(`GUI:        ${config.enableGui ? 'enabled' : 'disabled'}`);
  console.log();

  // Start JSONL logger
  const logger = createLogger(sessionDir);
  logger.append({
    t: now.toISOString(),
    mono: performance.now(),
    type: 'note',
    note: `Session started. Bridge=${config.host}:${config.port} RTSP=${config.rtspUrl} images=${config.saveImages}`,
  });

  // Start RTSP camera (always needed for LCD OCR; images saved only if --save-images)
  const camera = new RtspCamera(config.rtspUrl, sessionDir, config.rtspFilter);
  camera.start();

  // Initialize Tesseract reader (replaces Claude CLI — ~200ms vs ~5000ms)
  const tesseract = new TesseractReader();
  console.log('Initializing Tesseract OCR...');
  await tesseract.init();

  // Find and set up GUI capture (optional)
  let guiCapture: GuiCapture | null = null;
  let guiWindowTitle: string | null = null;
  if (config.enableGui) {
    console.log('Looking for EB Tester window...');
    guiWindowTitle = findEbTesterWindow();
    if (guiWindowTitle) {
      guiCapture = new GuiCapture(guiWindowTitle, sessionDir);
      console.log(`[gui] Found: "${guiWindowTitle}"`);
    } else {
      console.log('[gui] EB Tester window not found — GUI capture disabled');
    }
  }

  // ── OCR scheduling ──────────────────────────────────────────────
  //
  // Tesseract is fast enough (~200ms) to run much more frequently
  // than the old Claude CLI approach (~5s, throttled to 10s).
  // We run OCR every 2 seconds for real-time tracking.
  //
  let ocrChain: Promise<void> = Promise.resolve();
  let lastOcrTime = 0;
  const OCR_INTERVAL_MS = 2_000;

  function scheduleOcr(): void {
    const now = Date.now();
    if (now - lastOcrTime < OCR_INTERVAL_MS) return;
    lastOcrTime = now;

    ocrChain = ocrChain
      .then(async () => {
        // Get filtered frame (cropped to LCD region via RTSP_FILTER)
        // This feeds Tesseract just the LCD, not the full camera scene.
        const filtered = await camera.getFilteredFrame();
        if (!filtered) return;

        // LCD OCR — try line-by-line first (better accuracy), fall back to block
        const reading = (await tesseract.readLcdByLine(filtered)) ?? (await tesseract.readLcd(filtered));

        if (reading && reading.confidence > 0) {
          logger.append({
            t: new Date().toISOString(),
            mono: performance.now(),
            type: 'lcd',
            lcd: reading,
          });
          displayOcr(reading);
        }
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m[ocr] Error: ${msg}\x1b[0m`);
      });
  }

  // GUI reading — less frequent (UI Automation or Tesseract)
  let guiChain: Promise<void> = Promise.resolve();
  let lastGuiTime = 0;
  const GUI_INTERVAL_MS = 5_000;

  function scheduleGuiRead(): void {
    if (!guiWindowTitle) return;
    const now = Date.now();
    if (now - lastGuiTime < GUI_INTERVAL_MS) return;
    lastGuiTime = now;

    guiChain = guiChain
      .then(async () => {
        // Capture GUI screenshot (needed for Tesseract fallback)
        let screenshotPath: string | null = null;
        if (guiCapture) {
          const result = guiCapture.capture();
          if (result) {
            try {
              const meta = JSON.parse(result);
              screenshotPath = join(sessionDir, meta.filename);
            } catch {}
          }
        }

        const reading = await readGui(guiWindowTitle!, screenshotPath, tesseract);
        if (reading && Object.keys(reading.fields).length > 0) {
          logger.append({
            t: new Date().toISOString(),
            mono: performance.now(),
            type: 'gui',
            gui: reading,
          });
          displayGui(reading);
        }
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m[gui] Error: ${msg}\x1b[0m`);
      });
  }

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

      // ── Protocol synthesis — instant LCD "reading" from decoded data ──
      const synthesis: OcrReading = {
        parsed: synthesizeFromProtocol(decoded),
        rawLines: [], // no raw text for synthesis
        confidence: 100,
        ocrMs: 0,
        source: 'protocol',
      };

      // ── Save screenshot only if --save-images ──
      let screenshotFile: string | null = null;
      if (config.saveImages) {
        const screenshotResult = camera.capture();
        if (screenshotResult) {
          try {
            const meta = JSON.parse(screenshotResult);
            screenshotFile = meta.filename;
          } catch {}
        }
      }

      // ── Schedule LCD OCR (Tesseract, async, non-blocking) ──
      // Uses getFilteredFrame() which applies the RTSP crop/rotate filter
      // via sharp — feeds Tesseract just the LCD region, not the full scene.
      scheduleOcr();

      // ── Schedule GUI read (async, non-blocking) ──
      if (config.enableGui) {
        scheduleGuiRead();
      }

      // ── Log correlated record ──
      const record: CorrelatedRecord = {
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
          maxTimeOrCutoff: decoded.maxTimeOrCutoff,
          field12: decoded.field12,
          raw: toHex(raw),
        },
        // Inline the protocol synthesis with every RX packet
        lcd: synthesis,
      };

      // Only include screenshot reference when saving images
      if (config.saveImages) {
        record.screenshot = screenshotFile;
      }

      logger.append(record);
      displayRx(decoded, synthesis);
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
    console.log('Device is responding. Correlating packets with structured data.');
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
    if (guiCapture) guiCapture.stop();

    // Wait for any in-flight OCR/GUI reads to finish, then clean up
    Promise.all([ocrChain, guiChain]).finally(async () => {
      await tesseract.terminate();
      logger.close();
      socket.end();
      console.log(`Log: ${logger.path}`);
      console.log(`Session: ${sessionDir}`);
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
