#!/usr/bin/env bun
/**
 * Extract device names from probe-devices screenshots via OCR.
 *
 * Reads every `probe-byte16-0xXX_*.png` file in a probe-devices output
 * directory, crops the Device column from the bottom-left table, runs
 * Tesseract OCR on each crop, and writes a JSON file mapping
 *
 *   { "0x01": { "name": "EBC-A", "confidence": 94.2, "ocrText": "EBC-A" }, ... }
 *
 * to `<dir>/device-names.json`.
 *
 * IMPORTANT — the Device column is a VB6 data grid that retains
 * connection history across reconnects. In most probes it shows only
 * the current device (one row), but sometimes a reconnect leaves the
 * previous device visible on row 1 with the new device on row 2:
 *
 *     ┌──────────┐
 *     │ Device   │  ← header
 *     │ No Device│  ← row 1 (previous connection)
 *     │ EBD-A20H │  ← row 2 (current connection — what we want)
 *     └──────────┘
 *
 * To handle this we OCR both rows. If row 2 is non-empty, it's the
 * current device; otherwise row 1 is. The VB6 window is a fixed
 * 963×710 layout so the row positions are constant.
 *
 * OCR uses {@link TesseractReader.readGuiLine} with a restricted
 * character whitelist (uppercase letters, digits, dash, plus, space
 * plus lowercase for "No Device") and 4× upscaling to handle the tiny
 * ~9pt VB6 font.
 *
 * Usage:
 *
 *   # Default: process the newest 2026-*-byte* dir under scripts/probes/
 *   bun run scripts/extract-device-names.ts
 *
 *   # Process a specific directory
 *   bun run scripts/extract-device-names.ts scripts/probes/2026-04-22_00-44-35-byte16
 *
 *   # Custom row regions (rare — only if the window layout changed)
 *   bun run scripts/extract-device-names.ts --row1 14,662,95,17 --row2 14,681,95,17
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { TesseractReader } from '../src/ocr/tesseract-reader.ts';

// ── Config & CLI ─────────────────────────────────────────────────────

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Config {
  dir: string;
  /** Row 1 — above the new-device row; may contain prior connection's name */
  row1: Region;
  /** Row 2 — latest connection if the grid is showing 2 rows */
  row2: Region;
  output: string;
  /** Only re-read files whose byte16 value is missing from an existing output */
  incremental: boolean;
  /** Print extra detail per file */
  verbose: boolean;
}

/** Characters that can appear in VB6 Device cell — device names + "No Device" */
const DEVICE_NAME_WHITELIST =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-+ ';

function parseArgs(argv: string[]): Config {
  let dir: string | null = null;
  // Defaults calibrated for 963x710 EB Tester screenshots.
  //   row 1: y=662..679
  //   row 2: y=681..698
  //   x=14..109 — skip the black row-selector indicator (0..9) and
  //   the grid's left cell border (10..13).
  let row1: Region = { left: 14, top: 662, width: 95, height: 17 };
  let row2: Region = { left: 14, top: 681, width: 95, height: 17 };
  let output: string | null = null;
  let incremental = false;
  let verbose = false;

  const parseRegion = (s: string, flag: string): Region => {
    const parts = s?.split(',').map(Number);
    if (!parts || parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      throw new Error(`${flag} expects four comma-separated ints: left,top,width,height`);
    }
    return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--row1') {
      row1 = parseRegion(argv[++i], '--row1');
    } else if (arg === '--row2') {
      row2 = parseRegion(argv[++i], '--row2');
    } else if (arg === '--output' || arg === '-o') {
      output = argv[++i] ?? null;
    } else if (arg === '--incremental') {
      incremental = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      dir = arg;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (!dir) {
    dir = findNewestProbeDir();
    if (!dir) {
      throw new Error(
        'no directory specified and no 20*-byte* directory under scripts/probes/ found'
      );
    }
    console.log(`Defaulting to newest probe dir: ${dir}`);
  }

  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    throw new Error(`directory not found: ${resolved}`);
  }
  const screenshotsDir = join(resolved, 'screenshots');
  if (!existsSync(screenshotsDir)) {
    throw new Error(`no screenshots/ subdir under ${resolved}`);
  }

  return {
    dir: resolved,
    row1,
    row2,
    output: output ?? join(resolved, 'device-names.json'),
    incremental,
    verbose,
  };
}

function printHelp(): void {
  console.log(`extract-device-names — OCR device names from probe screenshots

USAGE:
  bun run scripts/extract-device-names.ts [DIR] [OPTIONS]

ARGUMENTS:
  DIR                      Probe directory containing screenshots/ (default: newest under scripts/probes/)

OPTIONS:
  --row1 L,T,W,H           Top device-cell region (default: 14,662,95,17)
  --row2 L,T,W,H           Bottom device-cell region (default: 14,681,95,17)
  --output, -o FILE        Output JSON path (default: DIR/device-names.json)
  --incremental            Only OCR files whose byte16 isn't already in the output
  --verbose, -v            Print per-file OCR result
  --help, -h               Show this help
`);
}

function findNewestProbeDir(): string | null {
  const probesDir = resolve(__dirname, 'probes');
  if (!existsSync(probesDir)) return null;
  // Prefer ISO-date-prefixed dated sweeps (e.g. 2026-04-22_00-44-35-byte16).
  // Fall back to any directory whose name contains "byte16" if no dated
  // sweep is found. Sorted descending by name so lexical newest wins.
  const entries = readdirSync(probesDir)
    .map(name => ({ name, path: join(probesDir, name) }))
    .filter(e => {
      try {
        return statSync(e.path).isDirectory();
      } catch {
        return false;
      }
    });
  const dated = entries
    .filter(e => /^\d{4}-\d{2}-\d{2}.*byte16/.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (dated.length > 0) return dated[0].path;
  const byte16 = entries
    .filter(e => /byte16/.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  return byte16[0]?.path ?? null;
}

// ── Main ─────────────────────────────────────────────────────────────

interface ExtractedEntry {
  byte16: number;
  byte16Hex: string;
  screenshot: string;
  /** Which row the current device was found in */
  fromRow: 1 | 2;
  /** Raw OCR of row 1 (may be "" if empty) */
  ocrRow1: string;
  /** Raw OCR of row 2 (may be "" if empty) */
  ocrRow2: string;
  /** Post-processed device name */
  name: string;
  confidence: number;
  cleaned: boolean;
  ocrMs: number;
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  console.log('=== extract-device-names ===');
  console.log(`Dir:      ${cfg.dir}`);
  console.log(`Row 1:    ${JSON.stringify(cfg.row1)}`);
  console.log(`Row 2:    ${JSON.stringify(cfg.row2)}`);
  console.log(`Output:   ${cfg.output}`);
  console.log('');

  const screenshotsDir = join(cfg.dir, 'screenshots');
  const allFiles = readdirSync(screenshotsDir)
    .filter(f => /^probe-byte16-0x[0-9a-f]{2}_.*\.png$/i.test(f))
    .sort();

  if (allFiles.length === 0) {
    throw new Error(`no probe-byte16-*.png files in ${screenshotsDir}`);
  }

  console.log(`Found ${allFiles.length} screenshots.`);

  // Load any existing results for incremental mode
  let existing: Record<string, ExtractedEntry> = {};
  if (cfg.incremental && existsSync(cfg.output)) {
    try {
      const raw = JSON.parse(readFileSync(cfg.output, 'utf-8'));
      existing = raw.entries ?? {};
      console.log(`Incremental: ${Object.keys(existing).length} entries already OCR'd.`);
    } catch (err) {
      console.warn(`Could not read existing output, starting fresh: ${(err as Error).message}`);
    }
  }

  const tesseract = new TesseractReader();
  await tesseract.init();

  const results: Record<string, ExtractedEntry> = { ...existing };
  let done = 0;
  let skipped = 0;

  for (const file of allFiles) {
    const m = file.match(/^probe-byte16-(0x[0-9a-f]{2})_/i);
    if (!m) continue;
    const byte16Hex = m[1].toLowerCase();
    const byte16 = parseInt(byte16Hex, 16);

    if (cfg.incremental && results[byte16Hex]) {
      skipped++;
      continue;
    }

    const path = join(screenshotsDir, file);
    const image = readFileSync(path);

    // OCR both rows — the latest (row 2) wins if it has content.
    // Run sequentially because Tesseract.js uses a single worker and
    // concurrent setParameters() calls can race.
    const r1 = await tesseract.readGuiLine(image, cfg.row1, {
      whitelist: DEVICE_NAME_WHITELIST,
      upscale: 4,
    });
    const r2 = await tesseract.readGuiLine(image, cfg.row2, {
      whitelist: DEVICE_NAME_WHITELIST,
      upscale: 4,
    });

    if (!r1 && !r2) {
      console.warn(`${byte16Hex}  ${file}  (OCR returned nothing for either row)`);
      continue;
    }

    const row1Text = r1?.text?.trim() ?? '';
    const row2Text = r2?.text?.trim() ?? '';
    // Row 2 is only considered "populated" if it has at least 3 alnum
    // chars AND confidence ≥ 40. Empty cells return single-char noise
    // like "I" from the cell border at confidence ~20, which we ignore.
    // The shortest legitimate device name is "EBC-A" (5 alnum chars), so
    // 3 is a safe floor.
    const row1Alnum = row1Text.replace(/[^A-Za-z0-9]/g, '');
    const row2Alnum = row2Text.replace(/[^A-Za-z0-9]/g, '');
    const row2Conf = r2?.confidence ?? 0;
    const row1Conf = r1?.confidence ?? 0;
    const row2HasContent = row2Alnum.length >= 3 && row2Conf >= 40;
    const row1HasContent = row1Alnum.length >= 3 && row1Conf >= 40;
    // Prefer row 2 (latest) when populated; fall back to row 1; else
    // keep whichever row had the cleaner read (might still be noise).
    const pick: 1 | 2 = row2HasContent ? 2 : row1HasContent ? 1 : row1Conf >= row2Conf ? 1 : 2;
    const chosenText = pick === 2 ? row2Text : row1Text;
    const chosenOcr = pick === 2 ? r2 : r1;

    const { cleaned, name } = normalizeDeviceName(chosenText);

    results[byte16Hex] = {
      byte16,
      byte16Hex,
      screenshot: file,
      fromRow: pick,
      ocrRow1: row1Text,
      ocrRow2: row2Text,
      name,
      confidence: Math.round((chosenOcr?.confidence ?? 0) * 10) / 10,
      cleaned,
      ocrMs: (r1?.readMs ?? 0) + (r2?.readMs ?? 0),
    };

    done++;
    const pct = ((done + skipped) / allFiles.length) * 100;

    if (cfg.verbose) {
      console.log(
        `${byte16Hex}  ${name.padEnd(12)}  conf=${results[byte16Hex].confidence.toString().padStart(5)}  row=${pick}  r1=${JSON.stringify(row1Text).padEnd(14)}  r2=${JSON.stringify(row2Text).padEnd(14)}  (${pct.toFixed(0)}%)`
      );
    } else {
      console.log(
        `${byte16Hex}  ${name.padEnd(12)}  conf=${results[byte16Hex].confidence.toString().padStart(5)}  row=${pick}  (${pct.toFixed(0)}%)`
      );
    }
  }

  await tesseract.terminate();

  // Write output sorted by byte16
  const sortedKeys = Object.keys(results).sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
  const sorted: Record<string, ExtractedEntry> = {};
  for (const k of sortedKeys) sorted[k] = results[k];

  // Also compute a distinct-name histogram
  const histogram: Record<string, string[]> = {};
  for (const [byte16Hex, entry] of Object.entries(sorted)) {
    const key = entry.name;
    (histogram[key] ??= []).push(byte16Hex);
  }

  const output = {
    source: basename(cfg.dir),
    row1: cfg.row1,
    row2: cfg.row2,
    extractedAt: new Date().toISOString(),
    count: sortedKeys.length,
    entries: sorted,
    histogram,
  };

  writeFileSync(cfg.output, JSON.stringify(output, null, 2));

  console.log('');
  console.log(`Wrote ${cfg.output} (${sortedKeys.length} entries, ${skipped} skipped).`);
  console.log('');
  console.log('Distinct device names:');
  const histEntries = Object.entries(histogram).sort((a, b) => b[1].length - a[1].length);
  for (const [name, bytes] of histEntries) {
    const sample = bytes.slice(0, 6).join(' ');
    const more = bytes.length > 6 ? ` (+${bytes.length - 6} more)` : '';
    console.log(`  ${name.padEnd(16)}  ${bytes.length.toString().padStart(3)}x  ${sample}${more}`);
  }
}

// ── Device name normalization ────────────────────────────────────────

/**
 * Tesseract systematically confuses certain character pairs when
 * reading the VB6 Device cell. This table corrects the most common
 * ones. Corrections are applied ONLY in contexts where the raw read
 * violates the known ZKE product-name grammar:
 *
 *   <prefix>-<letter><digits><suffix?>
 *
 *   prefix  := EBC | EBD | HSD
 *   letter  := A | B | C | K | M | P | USB
 *   digits  := 0..999
 *   suffix  := H | L | N | + | empty
 *
 * For example, raw "EEC-AZ0" → the "EE" prefix violates the grammar
 * because no product starts with "EE", so we correct to "EB". The "Z"
 * appears in a position where only digits are expected, so "Z"→"2".
 * Result: "EBC-A20".
 *
 * Corrections are conservative: if the raw already matches the
 * grammar, no change is made.
 */
const PREFIX_FIX: Record<string, string> = {
  EEC: 'EBC',
  EED: 'EBD',
  EBED: 'EBD', // occasional EB + E prefix doubling
  EEBD: 'EBD',
  EBEC: 'EBC',
};

/**
 * In numeric positions, Tesseract often reads digits as look-alike
 * letters. We only apply this when we're confident the position holds
 * a digit (see {@link normalizeDeviceName} for the grammar check).
 *
 * NOTE: "L"→"1" deliberately excluded — L legitimately appears as a
 * model suffix ("EBC-A40L", "EBC-A100L"). "B"→"8" excluded — B
 * legitimately appears as a model letter ("EBC-B", "EBC-B10"). "S"→"5"
 * excluded — S legitimately appears in "EBD-USB". These get left alone
 * so the curator can inspect the raw OCR and resolve them.
 */
const DIGIT_FIX: Record<string, string> = {
  D: '0',
  O: '0',
  Q: '0',
  Z: '2',
  T: '1',
};

function normalizeDeviceName(raw: string): { name: string; cleaned: boolean } {
  let s = raw.trim();
  const original = s;

  // Strip typical OCR border noise — punctuation at start/end.
  s = s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

  // "No Device" (when byte16 is rejected) sometimes reads as "NoDevice"
  // or "MO DEVICE"; normalize.
  if (/^[nm]o\s*device$/i.test(s)) return { name: 'No Device', cleaned: s !== original };

  if (!s) return { name: '', cleaned: true };

  s = s.toUpperCase();

  // Collapse any run of whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  // Prefix fix — correct "EEC" → "EBC", etc. Applied if the leading
  // 3-4 chars before the first dash match a known bad prefix.
  const dashIdx = s.indexOf('-');
  if (dashIdx > 0) {
    const prefix = s.slice(0, dashIdx);
    if (PREFIX_FIX[prefix]) {
      s = PREFIX_FIX[prefix] + s.slice(dashIdx);
    }
  }

  // Digit fix — structure after the dash is:
  //   <letter><digits-or-letters><optional-suffix>
  // where the trailing suffix is one of H, L, N, + and appears only
  // if the preceding char is a digit (so "EBC-A40L" has suffix "L"
  // but "EBC-A" has no suffix — the trailing A is the model letter).
  //
  // We peel off the suffix BEFORE applying digit corrections, otherwise
  // a valid trailing letter gets "corrected" to a digit.
  //
  // Digit corrections only apply to chars in DIGIT_FIX — that map is
  // deliberately conservative; ambiguous chars (L/S/B) that could be
  // either letters or digits are left alone for curator review.
  const m = s.match(/^([A-Z]+)-([A-Z])([A-Z0-9]*)$/);
  if (m) {
    const [, pfx, first, rest] = m;
    let middle = rest;
    let suffix = '';
    if (rest.length >= 2) {
      const last = rest[rest.length - 1];
      const prev = rest[rest.length - 2];
      if ('HLN+'.includes(last) && /[0-9DOQZT]/.test(prev)) {
        suffix = last;
        middle = rest.slice(0, -1);
      }
    }
    let fixed = '';
    for (const ch of middle) {
      fixed += DIGIT_FIX[ch] ?? ch;
    }
    s = `${pfx}-${first}${fixed}${suffix}`;
  }

  return { name: s, cleaned: s !== original };
}

// ── Entry ────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
