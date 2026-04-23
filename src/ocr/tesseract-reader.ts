/**
 * Tesseract-based OCR Reader — fast real-time text extraction
 *
 * Replaces the Claude CLI approach (~5s per call) with Tesseract.js
 * (~200ms per call). Uses sharp for image preprocessing optimized
 * for each source type:
 *
 * - **LCD** (camera): channel extraction, invert, normalize, upscale
 * - **GUI** (screenshot): minimal preprocessing (already clean text)
 *
 * The worker is initialized once and reused across all reads,
 * avoiding the ~1s cold-start penalty per call.
 */

import { join } from 'node:path';
import sharp from 'sharp';
import { type Worker, createWorker, PSM } from 'tesseract.js';
import { parseLcdText } from './lcd-parser.ts';
import type { OcrReading } from './types.ts';

// ── Config ───────────────────────────────────────────────────────────

/** Project root — eng.traineddata lives here */
const PROJECT_ROOT = join(import.meta.dir, '..', '..');

/** Characters the LCD can display. Restricting this massively helps accuracy. */
const LCD_WHITELIST = '0123456789.:- ABCDEFGHIJKLMNOPQRSTUVWXYZmkh+/';

/** GUI apps use standard character sets */
const GUI_WHITELIST = '';

// ── LCD Preprocessing ────────────────────────────────────────────────

/**
 * LCD image preprocessing pipeline.
 *
 * The camera captures the LCD with backlight glow and text-on-background
 * contrast that varies with white balance. This pipeline extracts the
 * text for Tesseract using two strategies based on image size:
 *
 * **Pre-filtered images** (already cropped/upscaled by RTSP filter):
 *   - CLAHE for local contrast (handles mixed bezel/LCD regions)
 *   - Invert + threshold for clean dark-on-light output
 *   - No upscaling (already upscaled by RTSP filter)
 *
 * **Raw/small crops** (need full preprocessing):
 *   - Max(green, blue) channel extraction
 *   - Invert + normalize + 2x upscale + threshold
 */
async function preprocessLcd(image: Buffer): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  if (w === 0 || h === 0) {
    throw new Error('Invalid image dimensions');
  }

  // If the image is already large (pre-filtered/upscaled), use CLAHE
  // for local contrast enhancement which handles mixed bezel/LCD areas.
  // If it's small (raw crop), use full preprocessing with upscale.
  const isPrefiltered = w > 1000 || h > 300;

  if (isPrefiltered) {
    return preprocessLcdFiltered(image);
  }
  return preprocessLcdRaw(image, w, h);
}

/**
 * Preprocessing for pre-filtered LCD images (already cropped + upscaled
 * by the RTSP filter pipeline). These are ~2400x580 with the LCD text
 * filling most of the frame.
 *
 * Uses blue channel → invert → normalize. Testing showed the blue
 * channel gives better structural accuracy than green (fewer digit
 * confusions in the current/voltage fields), even though the LCD
 * backlight appears green — the text segments have stronger blue
 * contrast after the camera's white balance.
 */
async function preprocessLcdFiltered(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .extractChannel(2) // blue channel (best text contrast)
    .negate() // light-on-dark → dark-on-light
    .normalize() // stretch contrast to full 0–255 range
    .png()
    .toBuffer();
}

/**
 * Preprocessing for raw/small LCD crops that need full treatment.
 * Takes max(green, blue) for color-temperature robustness,
 * inverts, normalizes, upscales 2x, and binarizes.
 */
async function preprocessLcdRaw(image: Buffer, w: number, h: number): Promise<Buffer> {
  // Extract raw pixel data to compute max(green, blue) per pixel.
  // This handles both green-backlit and blue-backlit LCD variants.
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  const maxChannel = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) {
    const g = data[i * 4 + 1]; // green
    const b = data[i * 4 + 2]; // blue
    maxChannel[i] = Math.max(g, b);
  }

  // Build the preprocessed image from the max(G,B) channel
  return sharp(maxChannel, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .negate() // invert: light-on-dark → dark-on-light
    .normalize() // stretch contrast to 0–255
    .resize(w * 2, h * 2, { kernel: 'nearest' }) // 2x upscale
    .threshold(140) // binarize for clean edges
    .png()
    .toBuffer();
}

/**
 * Preprocess for GUI screenshots — minimal processing needed.
 * Windows renders clean anti-aliased text at screen resolution.
 */
async function preprocessGui(image: Buffer): Promise<Buffer> {
  return sharp(image).greyscale().normalize().png().toBuffer();
}

// ── Tesseract Reader ─────────────────────────────────────────────────

export class TesseractReader {
  private worker: Worker | null = null;
  private ready = false;
  private initializing: Promise<void> | null = null;

  /**
   * Initialize the Tesseract worker. Call once before any read methods.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initializing) return this.initializing;

    this.initializing = this._doInit();
    await this.initializing;
  }

  private async _doInit(): Promise<void> {
    try {
      this.worker = await createWorker('eng', undefined, {
        langPath: PROJECT_ROOT,
        // Suppress Tesseract's verbose logging
        logger: () => {},
      });
      this.ready = true;
      console.log('[ocr] Tesseract worker ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[ocr] Tesseract init failed: ${msg}\x1b[0m`);
      console.error('\x1b[31m[ocr] Ensure eng.traineddata exists in project root\x1b[0m');
    }
  }

  /**
   * Read LCD display text from an image.
   *
   * Applies the LCD preprocessing pipeline, then runs Tesseract in
   * SINGLE_BLOCK mode with a restricted character whitelist.
   *
   * @param image  JPEG/PNG buffer (can be raw camera frame or cropped LCD)
   * @returns Structured OCR reading, or null if recognition fails
   */
  async readLcd(image: Buffer): Promise<OcrReading | null> {
    if (!this.ready || !this.worker) return null;

    const start = performance.now();

    try {
      const processed = await preprocessLcd(image);
      return await this.recognizeLcd(processed, start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[ocr] LCD read error: ${msg}\x1b[0m`);
      return null;
    }
  }

  /**
   * Read LCD text, splitting the image into individual lines.
   *
   * For better accuracy, splits the preprocessed image in half
   * vertically and recognizes each line independently in SINGLE_LINE
   * mode. This avoids Tesseract's line-segmentation errors on LCD text.
   *
   * @param image  JPEG/PNG buffer
   * @returns Structured OCR reading, or null if recognition fails
   */
  async readLcdByLine(image: Buffer): Promise<OcrReading | null> {
    if (!this.ready || !this.worker) return null;

    const start = performance.now();

    try {
      const processed = await preprocessLcd(image);
      const meta = await sharp(processed).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w === 0 || h === 0) return null;

      const midY = Math.round(h / 2);
      const lines: string[] = [];

      // Top half — Line 1
      const topBuf = await sharp(processed)
        .extract({ left: 0, top: 0, width: w, height: midY })
        .png()
        .toBuffer();

      await this.worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: LCD_WHITELIST,
        user_defined_dpi: '200',
      });
      const r1 = await this.worker.recognize(topBuf);
      lines.push(r1.data.text.trim());

      // Bottom half — Line 2
      const botBuf = await sharp(processed)
        .extract({ left: 0, top: midY, width: w, height: h - midY })
        .png()
        .toBuffer();

      const r2 = await this.worker.recognize(botBuf);
      lines.push(r2.data.text.trim());

      const elapsed = performance.now() - start;
      const confidence = (r1.data.confidence + r2.data.confidence) / 2;
      const rawText = lines.filter(Boolean).join('\n');

      if (!rawText) return null;

      return {
        parsed: parseLcdText(rawText),
        rawLines: lines.filter(Boolean),
        confidence,
        ocrMs: Math.round(elapsed),
        source: 'tesseract',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[ocr] LCD line-by-line error: ${msg}\x1b[0m`);
      return null;
    }
  }

  /**
   * Read text from a GUI screenshot.
   *
   * GUI screenshots contain clean Windows-rendered text, so minimal
   * preprocessing is needed. Uses AUTO page segmentation to handle
   * the varied layout of VB6 applications.
   *
   * @param image   PNG buffer of the GUI window
   * @param region  Optional crop region { left, top, width, height }
   *                to focus on a specific area of the GUI
   * @returns Raw recognized text with confidence, or null on failure
   */
  async readGui(
    image: Buffer,
    region?: { left: number; top: number; width: number; height: number }
  ): Promise<{ text: string; confidence: number; readMs: number } | null> {
    if (!this.ready || !this.worker) return null;

    const start = performance.now();

    try {
      let buf = image;
      if (region) {
        buf = await sharp(image).extract(region).png().toBuffer();
      }

      const processed = await preprocessGui(buf);

      await this.worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        tessedit_char_whitelist: GUI_WHITELIST,
        user_defined_dpi: '96', // screen DPI
      });

      const result = await this.worker.recognize(processed);
      const elapsed = performance.now() - start;

      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence,
        readMs: Math.round(elapsed),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[ocr] GUI read error: ${msg}\x1b[0m`);
      return null;
    }
  }

  /**
   * Read a single line of GUI text — e.g. a table cell, a caption,
   * a status field. Optimized for small, tight crops where `readGui`'s
   * AUTO page-segmentation tends to misread at low confidence.
   *
   * Differences from {@link readGui}:
   *   - Upscales the crop 4× (nearest neighbor) before recognition.
   *     VB6 renders text at ~8-10pt which is too small for Tesseract
   *     to handle reliably; upscaling dramatically improves accuracy.
   *   - Uses PSM.SINGLE_LINE so Tesseract doesn't waste effort looking
   *     for paragraph structure.
   *   - Accepts a character whitelist — device names, unit strings,
   *     and similar VB6 fields have small alphabets where whitelisting
   *     eliminates character confusions (0↔D, 1↔I, O↔0, etc.).
   *
   * @param image      PNG buffer (typically a full screenshot)
   * @param region     Crop region in the source image
   * @param opts       { whitelist? — allowed chars, upscale? — factor (default 4) }
   */
  async readGuiLine(
    image: Buffer,
    region: { left: number; top: number; width: number; height: number },
    opts: { whitelist?: string; upscale?: number } = {}
  ): Promise<{ text: string; confidence: number; readMs: number } | null> {
    if (!this.ready || !this.worker) return null;

    const upscale = opts.upscale ?? 4;
    const start = performance.now();

    try {
      // Crop → greyscale+normalize → upscale (lanczos for smooth edges,
      // which Tesseract handles better than blocky nearest-neighbor on
      // small antialiased fonts) → extend with white padding so text
      // isn't hugging the frame (Tesseract needs breathing room to
      // detect line boundaries and avoid confusing borders with glyphs).
      const PAD = 12;
      const buf = await sharp(image)
        .extract(region)
        .greyscale()
        .normalize()
        .resize(region.width * upscale, region.height * upscale, { kernel: 'lanczos3' })
        .extend({
          top: PAD,
          bottom: PAD,
          left: PAD,
          right: PAD,
          background: { r: 255, g: 255, b: 255 },
        })
        .png()
        .toBuffer();

      await this.worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: opts.whitelist ?? GUI_WHITELIST,
        user_defined_dpi: '300', // match the upscaled font size
      });

      const result = await this.worker.recognize(buf);
      const elapsed = performance.now() - start;

      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence,
        readMs: Math.round(elapsed),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[ocr] GUI line read error: ${msg}\x1b[0m`);
      return null;
    }
  }

  /** Release the Tesseract worker */
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    console.log('[ocr] Tesseract worker stopped');
  }

  // ── Internal ────────────────────────────────────────────────────

  private async recognizeLcd(processed: Buffer, startTime: number): Promise<OcrReading | null> {
    if (!this.worker) return null;

    await this.worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: LCD_WHITELIST,
      user_defined_dpi: '200',
    });

    const result = await this.worker.recognize(processed);
    const elapsed = performance.now() - startTime;
    const rawText = result.data.text.trim();

    if (!rawText) return null;

    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    return {
      parsed: parseLcdText(rawText),
      rawLines: lines,
      confidence: result.data.confidence,
      ocrMs: Math.round(elapsed),
      source: 'tesseract',
    };
  }
}
