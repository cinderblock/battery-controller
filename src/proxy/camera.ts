/**
 * RTSP Camera Screenshot Capture
 *
 * Keeps a persistent ffmpeg process decoding an RTSP stream at low
 * framerate, continuously overwriting a temp JPEG. On capture request,
 * copies the latest frame to a timestamped file.
 *
 * This gives near-zero-latency screenshots (the frame is always "hot"
 * on disk) without spawning ffmpeg per-capture.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const FFMPEG_RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 3;

export class RtspCamera {
  private process: ChildProcess | null = null;
  private rawFramePath: string;
  private latestFramePath: string;
  private captureCount = 0;
  private restartAttempts = 0;
  private restarting = false;
  private stopped = false;

  /**
   * @param rtspUrl     RTSP stream URL
   * @param sessionDir  Directory for screenshots
   * @param filter      Optional ffmpeg -vf filter string (e.g. "crop=700:750:0:0,rotate=PI/2")
   */
  constructor(
    private rtspUrl: string,
    private sessionDir: string,
    private filter?: string
  ) {
    this.rawFramePath = join(sessionDir, '.latest-frame-raw.jpg');
    this.latestFramePath = join(sessionDir, '.latest-frame.jpg');
  }

  /**
   * Start the persistent ffmpeg process that continuously decodes the
   * RTSP stream and overwrites latest-frame.jpg.
   */
  start(): void {
    if (this.stopped) return;

    // Persistent ffmpeg writes unfiltered frames to the raw file.
    // Filters (crop/rotate) are applied at capture time because
    // ffmpeg's -update 1 mode bypasses -vf on Windows.
    const args = [
      '-rtsp_transport',
      'tcp',
      '-i',
      this.rtspUrl,
      '-vf',
      'fps=2',
      '-f',
      'image2',
      '-update',
      '1',
      '-q:v',
      '2',
      '-y',
      this.rawFramePath,
    ];

    try {
      this.process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'], // only capture stderr
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        console.error(
          '\x1b[31m[camera] ffmpeg not found. Install via: winget install ffmpeg  or  scoop install ffmpeg\x1b[0m'
        );
      } else {
        console.error(`\x1b[31m[camera] Failed to start ffmpeg: ${msg}\x1b[0m`);
      }
      this.process = null;
      return;
    }

    // Monitor stderr for connection errors
    let stderrBuffer = '';
    this.process.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      // Log significant errors (not every ffmpeg status line)
      if (stderrBuffer.includes('Connection refused') || stderrBuffer.includes('No route to host')) {
        console.error(`\x1b[31m[camera] RTSP connection failed: check camera URL and network\x1b[0m`);
        stderrBuffer = '';
      } else if (stderrBuffer.includes('401 Unauthorized')) {
        console.error(`\x1b[31m[camera] RTSP authentication failed: check credentials in URL\x1b[0m`);
        stderrBuffer = '';
      }
      // Trim buffer to avoid memory growth
      if (stderrBuffer.length > 4096) {
        stderrBuffer = stderrBuffer.slice(-1024);
      }
    });

    this.process.on('error', (err: Error) => {
      if (err.message.includes('ENOENT')) {
        console.error(
          '\x1b[31m[camera] ffmpeg not found. Install via: winget install ffmpeg  or  scoop install ffmpeg\x1b[0m'
        );
        this.stopped = true; // Don't retry if ffmpeg isn't installed
      } else {
        console.error(`\x1b[31m[camera] ffmpeg error: ${err.message}\x1b[0m`);
      }
      this.process = null;
    });

    this.process.on('exit', (code: number | null) => {
      this.process = null;
      if (this.stopped) return;

      if (code !== 0 && code !== null) {
        console.warn(`\x1b[33m[camera] ffmpeg exited with code ${code}\x1b[0m`);
        this.attemptRestart();
      }
    });

    console.log(`[camera] ffmpeg started — decoding ${this.rtspUrl} at 2 fps`);
    this.restartAttempts = 0;
  }

  /**
   * Attempt to restart ffmpeg after an unexpected exit.
   */
  private attemptRestart(): void {
    if (this.stopped || this.restarting) return;

    this.restartAttempts++;
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error(
        `\x1b[31m[camera] ffmpeg failed ${MAX_RESTART_ATTEMPTS} times, disabling camera for this session\x1b[0m`
      );
      this.stopped = true;
      return;
    }

    this.restarting = true;
    console.log(
      `[camera] Restarting ffmpeg in ${FFMPEG_RESTART_DELAY_MS}ms (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})...`
    );

    setTimeout(() => {
      this.restarting = false;
      if (!this.stopped) this.start();
    }, FFMPEG_RESTART_DELAY_MS);
  }

  /**
   * Capture the latest frame. Copies the continuously-updated JPEG to a
   * timestamped file in the session directory.
   *
   * @returns The screenshot filename (relative to sessionDir), or null if
   *          capture failed (ffmpeg not running, no frame available, etc.)
   */
  capture(): string | null {
    if (!this.isFrameAvailable()) {
      // Retry once after a short delay (ffmpeg may be mid-write)
      return this.captureWithRetry();
    }

    return this.doCopy();
  }

  private captureWithRetry(): string | null {
    // Synchronous short sleep — acceptable for a reverse-engineering tool
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait 100ms
    }

    if (!this.isFrameAvailable()) return null;
    return this.doCopy();
  }

  private isFrameAvailable(): boolean {
    if (!existsSync(this.rawFramePath)) return false;

    try {
      const stat = statSync(this.rawFramePath);
      if (stat.size < 100) return false;

      const header = readFileSync(this.rawFramePath).slice(0, 2);
      return header[0] === 0xff && header[1] === 0xd8;
    } catch {
      return false;
    }
  }

  private doCopy(): string | null {
    try {
      this.captureCount++;
      const filename = `screenshot-${this.captureCount.toString().padStart(4, '0')}.jpg`;
      const destPath = join(this.sessionDir, filename);

      if (this.filter) {
        // Apply crop/rotate filter when copying
        const result = spawnSync('ffmpeg', ['-i', this.rawFramePath, '-vf', this.filter, '-q:v', '2', '-y', destPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 3000,
        });
        if (result.status !== 0) {
          // Filter failed — fall back to raw copy
          copyFileSync(this.rawFramePath, destPath);
        }
      } else {
        copyFileSync(this.rawFramePath, destPath);
      }

      // Update .latest-frame.jpg to the filtered version
      copyFileSync(destPath, this.latestFramePath);

      const stat = statSync(destPath);
      return JSON.stringify({ filename, sizeBytes: stat.size });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[camera] Screenshot copy failed: ${msg}\x1b[0m`);
      return null;
    }
  }

  /**
   * Get the size in bytes of a screenshot file.
   */
  getFileSize(filename: string): number {
    try {
      return statSync(join(this.sessionDir, filename)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read the current raw (unfiltered) frame into memory.
   *
   * Returns the JPEG buffer before any crop/rotate filter has been
   * applied, or null if no valid frame is available. Use this to feed
   * the OCR pipeline which applies its own sharp-based preprocessing.
   */
  getRawFrame(): Buffer | null {
    try {
      if (!existsSync(this.rawFramePath)) return null;
      const buf = readFileSync(this.rawFramePath);
      // Validate JPEG magic bytes and minimum plausible size
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Get the current frame with crop/rotate filter applied, as an in-memory
   * buffer. Uses sharp instead of ffmpeg for zero-latency filter application.
   *
   * This is the preferred input for OCR — it returns just the LCD region
   * without any disk I/O or subprocess spawning.
   *
   * @returns Filtered JPEG buffer, or null if no valid frame is available
   */
  async getFilteredFrame(): Promise<Buffer | null> {
    const raw = this.getRawFrame();
    if (!raw) return null;
    if (!this.filter) return raw;

    try {
      return await applyFilterWithSharp(raw, this.filter);
    } catch {
      // Filter application failed — return raw frame as fallback
      return raw;
    }
  }

  /** Whether the ffmpeg process is running */
  isRunning(): boolean {
    return this.process !== null && !this.stopped;
  }

  /** Stop the ffmpeg process and clean up temp files */
  stop(): void {
    this.stopped = true;

    if (this.process) {
      this.process.kill('SIGTERM');

      // Force kill after 2 seconds if still running
      const proc = this.process;
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 2000);

      this.process = null;
    }

    // Clean up temp files
    for (const f of [this.rawFramePath, this.latestFramePath]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ── Filter Application via Sharp ─────────────────────────────────────

/**
 * Parse an ffmpeg -vf filter string and apply it using sharp.
 *
 * Supports the filter chains produced by the crop-selector tool:
 *
 * - `crop=W:H:X:Y`         → sharp.extract({ left: X, top: Y, width: W, height: H })
 * - `crop=W:H:(iw-W)/2:…`  → center-crop (expressions evaluated against current dimensions)
 * - `rotate=ANGLE:…`       → sharp.rotate(degrees)  (ANGLE in radians, extra params ignored)
 * - `scale=iw*N:ih*N`      → sharp.resize(w*N, h*N, { kernel: 'nearest' })
 *
 * Filters are applied sequentially. Between each step, the pipeline is
 * flushed to a buffer so the next step's dimension expressions (iw, ih)
 * resolve against the current image size.
 */
async function applyFilterWithSharp(image: Buffer, filterString: string): Promise<Buffer> {
  const filters = filterString.split(',').map(f => f.trim());
  let buf = image;

  for (const filter of filters) {
    const meta = await sharp(buf).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw === 0 || ih === 0) break;

    if (filter.startsWith('crop=')) {
      // crop=W:H:X:Y — values may be expressions like (iw-817)/2
      const parts = filter.slice(5).split(':');
      if (parts.length >= 4) {
        const w = evalDimExpr(parts[0], iw, ih);
        const h = evalDimExpr(parts[1], iw, ih);
        const x = evalDimExpr(parts[2], iw, ih);
        const y = evalDimExpr(parts[3], iw, ih);

        // Clamp to valid range
        const cx = Math.max(0, Math.min(x, iw - 1));
        const cy = Math.max(0, Math.min(y, ih - 1));
        const cw = Math.max(1, Math.min(w, iw - cx));
        const ch = Math.max(1, Math.min(h, ih - cy));

        buf = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).toBuffer();
      }
    } else if (filter.startsWith('rotate=')) {
      // rotate=ANGLE:ow=...:oh=... — extract just the angle, ignore ow/oh
      const anglePart = filter.slice(7).split(':')[0];
      const radians = evalAngle(anglePart);
      const degrees = (radians * 180) / Math.PI;
      buf = await sharp(buf).rotate(degrees, { background: '#000' }).toBuffer();
    } else if (filter.startsWith('scale=')) {
      // scale=iw*N:ih*N
      const parts = filter.slice(6).split(':');
      if (parts.length >= 2) {
        const newW = Math.round(evalDimExpr(parts[0], iw, ih));
        const newH = Math.round(evalDimExpr(parts[1], iw, ih));
        if (newW > 0 && newH > 0) {
          buf = await sharp(buf).resize(newW, newH, { kernel: 'nearest' }).toBuffer();
        }
      }
    }
    // Unknown filters (transpose, etc.) are silently skipped
  }

  return buf;
}

/**
 * Evaluate an ffmpeg dimension expression against current width/height.
 *
 * Handles: plain numbers, `iw`, `ih`, `iw*3`, `(iw-817)/2`, etc.
 * Also handles ffmpeg rotation functions `rotw(angle)` and `roth(angle)`.
 */
function evalDimExpr(expr: string, iw: number, ih: number): number {
  const cleaned = expr.trim();

  // Plain number
  const plain = Number(cleaned);
  if (!Number.isNaN(plain) && !cleaned.includes('i')) return plain;

  // Substitute iw, ih, and PI
  let sub = cleaned
    .replace(/\biw\b/g, String(iw))
    .replace(/\bih\b/g, String(ih))
    .replace(/\bPI\b/gi, String(Math.PI));

  // Handle rotw(angle) and roth(angle) — ffmpeg functions for rotation output size
  sub = sub.replace(/rotw\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    // Rotation output width: |w*cos(a)| + |h*sin(a)|
    return String(Math.abs(iw * Math.cos(angle)) + Math.abs(ih * Math.sin(angle)));
  });
  sub = sub.replace(/roth\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    return String(Math.abs(iw * Math.sin(angle)) + Math.abs(ih * Math.cos(angle)));
  });

  // Evaluate the arithmetic expression
  try {
    const result = Function(`"use strict"; return (${sub})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return Math.round(result);
  } catch {
    // Fall through
  }

  return parseFloat(cleaned) || 0;
}

/** Parse an angle expression that may contain PI (e.g. "PI/2", "9.5*PI/180") */
function evalAngle(expr: string): number {
  const cleaned = expr.trim().replace(/\bPI\b/gi, String(Math.PI));
  try {
    const result = Function(`"use strict"; return (${cleaned})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return result;
  } catch {
    // Fall through
  }
  return parseFloat(expr) || 0;
}
