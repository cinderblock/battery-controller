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

import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FFMPEG_RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 3;

export class RtspCamera {
  private process: ChildProcess | null = null;
  private latestFramePath: string;
  private captureCount = 0;
  private restartAttempts = 0;
  private restarting = false;
  private stopped = false;

  constructor(
    private rtspUrl: string,
    private sessionDir: string
  ) {
    this.latestFramePath = join(sessionDir, '.latest-frame.jpg');
  }

  /**
   * Start the persistent ffmpeg process that continuously decodes the
   * RTSP stream and overwrites latest-frame.jpg.
   */
  start(): void {
    if (this.stopped) return;

    const args = [
      '-rtsp_transport',
      'tcp',
      '-i',
      this.rtspUrl,
      '-vf',
      'fps=2', // 2 fps — keeps frame fresh, low CPU
      '-f',
      'image2',
      '-update',
      '1',
      '-q:v',
      '2', // high quality JPEG
      '-y',
      this.latestFramePath,
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
    if (!existsSync(this.latestFramePath)) return false;

    try {
      const stat = statSync(this.latestFramePath);
      if (stat.size < 100) return false; // Too small to be a valid JPEG

      // Validate JPEG SOI marker
      const header = readFileSync(this.latestFramePath).slice(0, 2);
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

      copyFileSync(this.latestFramePath, destPath);

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

    // Clean up temp file
    try {
      if (existsSync(this.latestFramePath)) {
        unlinkSync(this.latestFramePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
