/**
 * Camera frame provider for the Pi server.
 *
 * Keeps a persistent ffmpeg process decoding an RTSP stream at low
 * framerate, writing unfiltered frames to a temp file. On request,
 * reads the latest frame, applies crop/rotate via sharp, and returns
 * the filtered JPEG buffer.
 *
 * Configure via environment variables:
 *   RTSP_URL     — RTSP stream URL (e.g. rtsp://10.255.0.2:7447/token)
 *   RTSP_FILTER  — ffmpeg -vf filter string for crop/rotate
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';

const FPS = 2;
const RESTART_DELAY_MS = 3000;
const MAX_RESTART_ATTEMPTS = 5;

let ffmpeg: ChildProcess | null = null;
let restartAttempts = 0;
let stopped = false;
let rawFramePath = '';

// Sharp is optional — loaded dynamically so the server still starts without it
let sharpModule: typeof import('sharp') | null = null;

async function loadSharp(): Promise<typeof import('sharp') | null> {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = await import('sharp');
    return sharpModule;
  } catch {
    logger.warn('[camera] sharp not available — frames will be served unfiltered');
    return null;
  }
}

// ── Frame cache ─────────────────────────────────────────────────

let cachedFiltered: { buffer: Buffer; rawMtime: number } | null = null;

function getRawFrameMtime(): number {
  try {
    return statSync(rawFramePath).mtimeMs;
  } catch {
    return 0;
  }
}

// ── Public API ──────────────────────────────────────────────────

export function cameraAvailable(): boolean {
  return !!process.env.RTSP_URL;
}

export function cameraRunning(): boolean {
  return ffmpeg !== null && !stopped;
}

export function startCamera(): void {
  const rtspUrl = process.env.RTSP_URL;
  if (!rtspUrl) return;

  stopped = false;

  // Create temp directory for frame files
  const tmpDir = join(process.env.DATA_DIR || '/opt/battery-controller/data', 'camera');
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}
  rawFramePath = join(tmpDir, '.latest-frame-raw.jpg');

  spawnFfmpeg(rtspUrl);

  // Pre-load sharp in the background
  loadSharp();
}

function spawnFfmpeg(rtspUrl: string): void {
  if (stopped) return;

  const args = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-vf', `fps=${FPS}`,
    '-f', 'image2',
    '-update', '1',
    '-q:v', '2',
    '-y', rawFramePath,
  ];

  try {
    ffmpeg = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      logger.error('[camera] ffmpeg not found — install with: sudo apt-get install -y ffmpeg');
      stopped = true;
    } else {
      logger.error(`[camera] Failed to start ffmpeg: ${msg}`);
    }
    ffmpeg = null;
    return;
  }

  // Monitor stderr for connection errors (suppress normal noise)
  let stderrBuf = '';
  ffmpeg.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.includes('Connection refused') || stderrBuf.includes('No route to host')) {
      logger.error('[camera] RTSP connection failed — check camera URL and network');
      stderrBuf = '';
    } else if (stderrBuf.includes('401 Unauthorized')) {
      logger.error('[camera] RTSP auth failed — check credentials');
      stderrBuf = '';
    }
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-1024);
  });

  ffmpeg.on('error', (err: Error) => {
    if (err.message.includes('ENOENT')) {
      logger.error('[camera] ffmpeg not found');
      stopped = true;
    }
    ffmpeg = null;
  });

  ffmpeg.on('exit', (code: number | null) => {
    ffmpeg = null;
    if (stopped) return;
    if (code !== 0 && code !== null) {
      logger.warn(`[camera] ffmpeg exited with code ${code}`);
      attemptRestart(rtspUrl);
    }
  });

  logger.info(`[camera] Started — decoding ${rtspUrl} at ${FPS} fps`);
  restartAttempts = 0;
}

function attemptRestart(rtspUrl: string): void {
  if (stopped) return;
  restartAttempts++;
  if (restartAttempts > MAX_RESTART_ATTEMPTS) {
    logger.error(`[camera] ffmpeg failed ${MAX_RESTART_ATTEMPTS} times — disabling`);
    stopped = true;
    return;
  }
  logger.info(`[camera] Restarting in ${RESTART_DELAY_MS}ms (${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
  setTimeout(() => { if (!stopped) spawnFfmpeg(rtspUrl); }, RESTART_DELAY_MS);
}

export function stopCamera(): void {
  stopped = true;
  if (ffmpeg) {
    ffmpeg.kill('SIGTERM');
    setTimeout(() => { try { ffmpeg?.kill('SIGKILL'); } catch {} }, 2000);
    ffmpeg = null;
  }
  try { if (rawFramePath && existsSync(rawFramePath)) unlinkSync(rawFramePath); } catch {}
}

/**
 * Get the latest camera frame as a filtered JPEG buffer.
 * Returns null if no frame is available.
 */
export async function getFrame(): Promise<Buffer | null> {
  if (!rawFramePath || !existsSync(rawFramePath)) return null;

  try {
    const stat = statSync(rawFramePath);
    if (stat.size < 100) return null;

    // Return cached filtered frame if the raw file hasn't changed
    if (cachedFiltered && cachedFiltered.rawMtime === stat.mtimeMs) {
      return cachedFiltered.buffer;
    }

    const raw = readFileSync(rawFramePath);
    // Validate JPEG magic bytes
    if (raw[0] !== 0xff || raw[1] !== 0xd8) return null;

    const filter = process.env.RTSP_FILTER;
    if (!filter) {
      cachedFiltered = { buffer: raw, rawMtime: stat.mtimeMs };
      return raw;
    }

    const sharp = await loadSharp();
    if (!sharp) {
      cachedFiltered = { buffer: raw, rawMtime: stat.mtimeMs };
      return raw;
    }

    const filtered = await applyFilter(sharp.default, raw, filter);
    cachedFiltered = { buffer: filtered, rawMtime: stat.mtimeMs };
    return filtered;
  } catch (err) {
    logger.debug(`[camera] Frame read error: ${err}`);
    return cachedFiltered?.buffer ?? null;
  }
}

// ── Filter application via sharp ────────────────────────────────

async function applyFilter(
  sharp: typeof import('sharp').default,
  image: Buffer,
  filterString: string,
): Promise<Buffer> {
  const filters = filterString.split(',').map(f => f.trim());
  let buf = image;

  for (const filter of filters) {
    const meta = await sharp(buf).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw === 0 || ih === 0) break;

    if (filter.startsWith('crop=')) {
      const parts = filter.slice(5).split(':');
      if (parts.length >= 4) {
        const w = evalDimExpr(parts[0], iw, ih);
        const h = evalDimExpr(parts[1], iw, ih);
        const x = evalDimExpr(parts[2], iw, ih);
        const y = evalDimExpr(parts[3], iw, ih);
        const cx = Math.max(0, Math.min(x, iw - 1));
        const cy = Math.max(0, Math.min(y, ih - 1));
        const cw = Math.max(1, Math.min(w, iw - cx));
        const ch = Math.max(1, Math.min(h, ih - cy));
        buf = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).toBuffer();
      }
    } else if (filter.startsWith('rotate=')) {
      const anglePart = filter.slice(7).split(':')[0];
      const radians = evalAngle(anglePart);
      const degrees = (radians * 180) / Math.PI;
      buf = await sharp(buf).rotate(degrees, { background: '#000' }).toBuffer();
    } else if (filter.startsWith('scale=')) {
      const parts = filter.slice(6).split(':');
      if (parts.length >= 2) {
        const newW = Math.round(evalDimExpr(parts[0], iw, ih));
        const newH = Math.round(evalDimExpr(parts[1], iw, ih));
        if (newW > 0 && newH > 0) {
          buf = await sharp(buf).resize(newW, newH, { kernel: 'nearest' }).toBuffer();
        }
      }
    }
  }

  return buf;
}

function evalDimExpr(expr: string, iw: number, ih: number): number {
  const cleaned = expr.trim();
  const plain = Number(cleaned);
  if (!Number.isNaN(plain) && !cleaned.includes('i')) return plain;

  let sub = cleaned
    .replace(/\biw\b/g, String(iw))
    .replace(/\bih\b/g, String(ih))
    .replace(/\bPI\b/gi, String(Math.PI));

  sub = sub.replace(/rotw\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    return String(Math.abs(iw * Math.cos(angle)) + Math.abs(ih * Math.sin(angle)));
  });
  sub = sub.replace(/roth\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    return String(Math.abs(iw * Math.sin(angle)) + Math.abs(ih * Math.cos(angle)));
  });

  try {
    const result = Function(`"use strict"; return (${sub})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return Math.round(result);
  } catch {}

  return parseFloat(cleaned) || 0;
}

function evalAngle(expr: string): number {
  const cleaned = expr.trim().replace(/\bPI\b/gi, String(Math.PI));
  try {
    const result = Function(`"use strict"; return (${cleaned})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return result;
  } catch {}
  return parseFloat(expr) || 0;
}
