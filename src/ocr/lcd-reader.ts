/**
 * LCD Reader — Claude Code Vision
 *
 * Reads text from a 2-line LCD display on a ZKETech battery charger/tester
 * by shelling out to `claude -p` with the Read tool. This uses the user's
 * existing Claude Code subscription — no API key needed.
 *
 * Two entry points:
 *   readRaw()        — saves the raw frame to a temp file, then asks
 *                      Claude to read the LCD from it
 *   readScreenshot() — takes a path to an already-saved screenshot
 *
 * Usage:
 *   const reader = new LcdReader();
 *   await reader.init();
 *   const result = await reader.readRaw(rawFrameBuffer);
 *   // result.lines → ['CU 3.130V 00.00W', 'OFF 000W 0044mAh']
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────

/** OCR result from a single LCD frame. */
export interface LcdReading {
  /** Raw text returned by Claude (whitespace-trimmed). */
  raw: string;
  /** Individual non-empty lines from the LCD. */
  lines: string[];
  /** Confidence estimate (0–100). Always 95 for Claude Vision. */
  confidence: number;
}

// ── Prompt ──────────────────────────────────────────────────────────

const LCD_PROMPT = [
  'Read the image file at IMAGE_PATH.',
  'It shows a ZKETech battery tester/electronic load with a 2-line LCD display.',
  'Return ONLY the exact 2 lines of text shown on the LCD, nothing else.',
  'No markdown formatting, no code fences, no commentary.',
  'Each line typically shows: mode (CU/CC/CV), voltage (V), current (A), power (W),',
  'or status (OFF/ON) with capacity (mAh) and elapsed time.',
  'Note: on this LCD font, V and U look similar — voltage units are always V.',
  'Similarly, W and A can look alike — power is W, current is A, capacity is mAh.',
  'If the LCD is blank or completely unreadable, return: UNREADABLE',
].join(' ');

// ── LCD Reader ──────────────────────────────────────────────────────

/**
 * LCD reader powered by Claude Code's vision capabilities.
 *
 * Shells out to `claude -p` to read LCD text from camera frames.
 * No API key required — uses the existing Claude Code subscription.
 */
export class LcdReader {
  private tempDir: string;
  private model: string;
  private ready = false;

  /**
   * @param _filterString  Unused — kept for interface compatibility.
   *                       Claude finds the LCD in the frame automatically.
   * @param model          Claude model to use (default: sonnet)
   */
  constructor(_filterString?: string, model = 'sonnet') {
    this.model = model;
    this.tempDir = join(tmpdir(), 'lcd-reader');
  }

  /** Verify claude CLI is available. Call once before any read methods. */
  async init(): Promise<void> {
    // Ensure temp directory exists
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }

    // Check that claude is available
    try {
      const proc = Bun.spawnSync(['claude', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode !== 0) {
        throw new Error('claude exited with non-zero');
      }
      const version = proc.stdout.toString().trim();
      console.log(`[ocr] Claude Code ready (${version}, model: ${this.model})`);
      this.ready = true;
    } catch {
      console.error('\x1b[31m[ocr] claude CLI not found. Install Claude Code to enable LCD reading.\x1b[0m');
      console.error('\x1b[31m[ocr] LCD OCR will be disabled for this session.\x1b[0m');
    }
  }

  /**
   * Read LCD text from a raw (unfiltered) camera frame buffer.
   *
   * Saves the frame to a temp file and asks Claude to read the LCD.
   * Claude handles finding the LCD in the frame, any angle, exposure, etc.
   */
  async readRaw(rawFrame: Buffer): Promise<LcdReading | null> {
    if (!this.ready) return null;

    // Write raw frame to temp file
    const tempPath = join(this.tempDir, `frame-${Date.now()}.jpg`);
    try {
      writeFileSync(tempPath, rawFrame);
      return await this.recognize(tempPath);
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Read LCD text from an already-saved screenshot file.
   *
   * @param image  Absolute path to the screenshot, or a Buffer (which
   *               will be written to a temp file).
   */
  async readScreenshot(image: string | Buffer): Promise<LcdReading | null> {
    if (!this.ready) return null;

    if (typeof image === 'string') {
      return this.recognize(image);
    }

    // Buffer — write to temp file
    const tempPath = join(this.tempDir, `screenshot-${Date.now()}.jpg`);
    try {
      writeFileSync(tempPath, image);
      return await this.recognize(tempPath);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }

  /** Release resources. */
  async terminate(): Promise<void> {
    this.ready = false;
    console.log('[ocr] Claude Code LCD reader stopped');
  }

  // ── Internal ────────────────────────────────────────────────────

  /** Shell out to `claude -p` to read the LCD from an image file. */
  private recognize(imagePath: string): Promise<LcdReading | null> {
    const prompt = LCD_PROMPT.replace('IMAGE_PATH', imagePath);

    return new Promise(resolve => {
      const args = [
        '-p',
        '--model',
        this.model,
        '--allowedTools',
        'Read',
        '--no-session-persistence',
        prompt,
      ];

      let stdout = '';
      let stderr = '';

      const proc = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', err => {
        console.error(`\x1b[31m[ocr] claude process error: ${err.message}\x1b[0m`);
        resolve(null);
      });

      proc.on('close', code => {
        if (code !== 0) {
          console.error(`\x1b[31m[ocr] claude exited with code ${code}\x1b[0m`);
          if (stderr) console.error(`\x1b[31m[ocr] ${stderr.slice(-200)}\x1b[0m`);
          resolve(null);
          return;
        }

        // Strip markdown code fences if present
        let text = stdout.trim();
        text = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();

        if (!text || text === 'UNREADABLE') {
          resolve(null);
          return;
        }

        const lines = text
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);

        resolve({
          raw: text,
          lines,
          confidence: 95,
        });
      });
    });
  }
}
