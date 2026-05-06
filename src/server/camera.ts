/**
 * Camera frame provider for the Pi server.
 *
 * Keeps a persistent ffmpeg process decoding an RTSP stream at low
 * framerate, writing frames to a temp file. On Linux, crop/rotate/scale
 * are applied inside ffmpeg's -vf chain so frames are already small when
 * written to disk. On Windows, ffmpeg's -update 1 mode bypasses -vf
 * filters, so the RTSP_FILTER is applied via sharp at read time instead.
 *
 * Configure via environment variables:
 *   RTSP_URL     — RTSP stream URL (e.g. rtsp://10.255.0.2:7447/token)
 *   RTSP_FILTER  — ffmpeg -vf filter string for crop/rotate/scale
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { applyFilter } from '../utils/sharp-filter.ts';

const IS_WINDOWS = process.platform === 'win32';
const FPS = 1;
const RESTART_DELAY_MS = 3000;
const MAX_RESTART_ATTEMPTS = 5;

let ffmpeg: ChildProcess | null = null;
let restartAttempts = 0;
let stopped = false;
let framePath = '';

// Sharp is optional — loaded dynamically so the server still starts without it.
// Only needed on Windows where ffmpeg can't apply filters via -vf.
let sharpFn: typeof import('sharp') | null = null;

async function loadSharp(): Promise<typeof import('sharp') | null> {
  if (sharpFn) return sharpFn;
  try {
    sharpFn = (await import('sharp')).default;
    return sharpFn;
  } catch {
    logger.warn('[camera] sharp not available — frames will be served unfiltered');
    return null;
  }
}

// ── Frame cache ─────────────────────────────────────────────────

let cachedFrame: { buffer: Buffer; mtime: number } | null = null;

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
  framePath = join(tmpDir, '.latest-frame.jpg');

  spawnFfmpeg(rtspUrl);
}

function spawnFfmpeg(rtspUrl: string): void {
  if (stopped) return;

  // Build -vf chain. On Linux, include RTSP_FILTER so ffmpeg crops early
  // (smaller frames to disk). On Windows, -update 1 bypasses -vf filters,
  // so we only include fps here and apply RTSP_FILTER via sharp at read time.
  // fps filter goes first so we only crop the 1 frame/sec we keep.
  const rtspFilter = process.env.RTSP_FILTER;
  const vf = (rtspFilter && !IS_WINDOWS) ? `fps=${FPS},${rtspFilter}` : `fps=${FPS}`;

  const args = [
    '-nostdin',
    // Low-latency input: skip probe/analysis, disable demux buffering and
    // packet reordering so frames pass through as soon as they arrive
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-max_delay', '0',
    '-reorder_queue_size', '0',
    // Use hardware H.264 decoder on Pi (bcm2835-codec via V4L2 M2M) to
    // offload decode from the CPU instead of burning ~180% CPU in software.
    ...(IS_WINDOWS ? [] : ['-c:v', 'h264_v4l2m2m']),
    '-threads', '1',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-an',
    '-vf', vf,
    '-f', 'image2',
    '-update', '1',
    '-flush_packets', '1',
    '-q:v', '2',
    '-y', framePath,
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
  try { if (framePath && existsSync(framePath)) unlinkSync(framePath); } catch {}
}

/**
 * Get the latest camera frame as a JPEG buffer.
 * On Linux, frames are already cropped/rotated by ffmpeg.
 * On Windows, RTSP_FILTER is applied via sharp at read time.
 * Returns null if no frame is available.
 */
export async function getFrame(): Promise<Buffer | null> {
  if (!framePath || !existsSync(framePath)) return null;

  try {
    const stat = statSync(framePath);
    if (stat.size < 100) return null;

    // Return cached frame if the file hasn't changed
    if (cachedFrame && cachedFrame.mtime === stat.mtimeMs) {
      return cachedFrame.buffer;
    }

    let buf: Buffer = readFileSync(framePath);
    // Validate JPEG magic bytes
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

    // On Windows, ffmpeg can't apply filters via -vf with -update 1,
    // so apply RTSP_FILTER here via sharp instead
    const rtspFilter = IS_WINDOWS ? process.env.RTSP_FILTER : undefined;
    if (rtspFilter) {
      const sharp = await loadSharp();
      if (sharp) {
        buf = await applyFilter(sharp, buf, rtspFilter);
      }
    }

    cachedFrame = { buffer: buf, mtime: stat.mtimeMs };
    return buf;
  } catch (err) {
    logger.debug(`[camera] Frame read error: ${err}`);
    return cachedFrame?.buffer ?? null;
  }
}
