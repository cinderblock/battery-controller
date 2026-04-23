/**
 * RTSP Crop Selector — Interactive Web Tool
 *
 * Serves a web page where you can draw a rotatable rectangle on the raw
 * camera frame to select the crop region. Preview the result (using sharp
 * for clean rotation without black bars), then save the ffmpeg filter
 * string to .env.local.
 *
 * Usage:  bun run crop-tool
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 3456;
const TEMP_DIR = join(tmpdir(), 'rtsp-crop-selector');
const PROJECT_ROOT = join(import.meta.dir, '../..');
const ENV_PATH = join(PROJECT_ROOT, '.env.local');
const HTML_PATH = join(import.meta.dir, 'crop-selector.html');

/** Read key=value pairs from .env.local (ignoring comments / blanks). */
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return env;
}

const env = loadEnv();
const RTSP_URL = process.env.RTSP_URL || env.RTSP_URL;
const CURRENT_FILTER = process.env.RTSP_FILTER || env.RTSP_FILTER || '';

if (!RTSP_URL) {
  console.error('Error: RTSP_URL not set. Set it in .env.local or as an environment variable.');
  process.exit(1);
}

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

/** Grab a single raw (unfiltered) frame from the RTSP stream. */
function grabFrame(): Buffer | null {
  const outPath = join(TEMP_DIR, 'frame.jpg');
  const result = spawnSync(
    'ffmpeg',
    ['-rtsp_transport', 'tcp', '-i', RTSP_URL, '-frames:v', '1', '-q:v', '2', '-y', outPath],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 },
  );

  if (existsSync(outPath)) {
    const buf = readFileSync(outPath);
    if (buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8) return buf;
  }

  console.error('[crop-tool] Failed to grab frame');
  if (result.stderr) console.error(result.stderr.toString().slice(-500));
  return null;
}

/**
 * Crop + rotate a region from the last grabbed frame using sharp.
 *
 * Strategy: extract the axis-aligned bounding box of the rotated selection,
 * rotate to straighten, then center-crop to the desired dimensions. This
 * produces a clean result with no black bars.
 */
async function sharpPreview(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDeg: number,
  scale: number = 3,
): Promise<Buffer | null> {
  const srcPath = join(TEMP_DIR, 'frame.jpg');
  if (!existsSync(srcPath)) return null;

  try {
    const meta = await sharp(srcPath).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (!imgW || !imgH) return null;

    // No rotation — simple crop + upscale
    if (angleDeg === 0) {
      const left = Math.max(0, Math.round(cx - w / 2));
      const top = Math.max(0, Math.round(cy - h / 2));
      const eW = Math.min(w, imgW - left);
      const eH = Math.min(h, imgH - top);
      return await sharp(srcPath)
        .extract({ left, top, width: eW, height: eH })
        .resize(eW * scale, eH * scale, { kernel: 'lanczos3' })
        .jpeg({ quality: 90 })
        .toBuffer();
    }

    // Compute the axis-aligned bounding box of the rotated selection
    const rad = angleDeg * Math.PI / 180;
    const absCos = Math.abs(Math.cos(rad));
    const absSin = Math.abs(Math.sin(rad));
    const bbW = Math.ceil(w * absCos + h * absSin) + 4;
    const bbH = Math.ceil(w * absSin + h * absCos) + 4;

    // Clamp bounding box to image bounds
    const bbLeft = Math.max(0, Math.round(cx - bbW / 2));
    const bbTop = Math.max(0, Math.round(cy - bbH / 2));
    const bbRight = Math.min(imgW, bbLeft + bbW);
    const bbBottom = Math.min(imgH, bbTop + bbH);
    const clampedW = bbRight - bbLeft;
    const clampedH = bbBottom - bbTop;

    if (clampedW < 1 || clampedH < 1) return null;

    // Step 1: extract bounding box
    // Step 2: rotate to straighten (sharp positive = CW)
    const rotatedBuf = await sharp(srcPath)
      .extract({ left: bbLeft, top: bbTop, width: clampedW, height: clampedH })
      .rotate(-angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .toBuffer();

    // Step 3: center-crop to final dimensions
    const rotMeta = await sharp(rotatedBuf).metadata();
    const rotW = rotMeta.width ?? w;
    const rotH = rotMeta.height ?? h;
    const finalLeft = Math.max(0, Math.round((rotW - w) / 2));
    const finalTop = Math.max(0, Math.round((rotH - h) / 2));
    const finalW = Math.min(w, rotW - finalLeft);
    const finalH = Math.min(h, rotH - finalTop);

    return await sharp(rotatedBuf)
      .extract({ left: finalLeft, top: finalTop, width: finalW, height: finalH })
      .resize(finalW * scale, finalH * scale, { kernel: 'lanczos3' })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.error('[crop-tool] Sharp preview failed:', err);
    return null;
  }
}

/** Update RTSP_FILTER in .env.local (preserving other lines). */
function saveFilter(filter: string): boolean {
  try {
    let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';

    if (/^RTSP_FILTER=/m.test(content)) {
      content = content.replace(/^RTSP_FILTER=.*$/m, `RTSP_FILTER=${filter}`);
    } else {
      content = `${content.trimEnd()}\nRTSP_FILTER=${filter}\n`;
    }

    writeFileSync(ENV_PATH, content);
    return true;
  } catch (err) {
    console.error('[crop-tool] Failed to save filter:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    switch (url.pathname) {
      // Serve the interactive HTML page
      case '/': {
        const html = readFileSync(HTML_PATH, 'utf-8');
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // Return current config as JSON
      case '/config':
        return Response.json({ filter: CURRENT_FILTER });

      // Grab a raw frame from the camera and return it as JPEG
      case '/frame': {
        const frame = grabFrame();
        if (!frame) return new Response('Failed to capture frame', { status: 500 });
        return new Response(frame, {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
        });
      }

      // Preview: crop + rotate using sharp (clean, no black bars)
      case '/preview': {
        const cx = parseFloat(url.searchParams.get('cx') || '');
        const cy = parseFloat(url.searchParams.get('cy') || '');
        const w = parseInt(url.searchParams.get('w') || '', 10);
        const h = parseInt(url.searchParams.get('h') || '', 10);
        const angle = parseFloat(url.searchParams.get('angle') || '0');
        const scale = parseInt(url.searchParams.get('scale') || '3', 10);

        if (Number.isNaN(cx) || Number.isNaN(cy) || !w || !h) {
          return new Response('Missing cx/cy/w/h parameters', { status: 400 });
        }

        const preview = await sharpPreview(cx, cy, w, h, angle, scale);
        if (!preview) return new Response('Preview failed', { status: 500 });
        return new Response(preview, {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
        });
      }

      // Save filter to .env.local
      case '/save': {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        const body = (await req.json()) as { filter: string };
        const ok = saveFilter(body.filter);
        return Response.json({ ok });
      }

      default:
        return new Response('Not found', { status: 404 });
    }
  },
});

console.log(`\n  🎯  RTSP Crop Selector running at  http://localhost:${server.port}\n`);
console.log(`  Camera : ${RTSP_URL}`);
console.log(`  Filter : ${CURRENT_FILTER || '(none)'}\n`);

// Auto-open browser (Windows)
Bun.spawn(['cmd', '/c', 'start', `http://localhost:${server.port}`], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
