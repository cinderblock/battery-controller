/**
 * LCD Text Parser — converts raw OCR text into structured data
 *
 * The ZKETech LCD shows 2 lines in a consistent format:
 *
 *   Line 1: {mode} {voltage}V {current/power}A/W
 *   Line 2: {status} {power/info}W {capacity}mAh
 *
 * Examples:
 *   "CU 3.130V 00.00A"   /  "OFF 000W 0044mAh"
 *   "CC 04.200V 01.00A"  /  "CHG 000W 0123mAh"
 *   "CV 4.200V 00.50A"   /  "ON  -PC- 0500mAh"
 *
 * This parser handles OCR noise — fuzzy matching for mode/status,
 * and flexible numeric extraction.
 */

import type { LcdParsed } from './types.ts';

// ── Known Tokens ─────────────────────────────────────────────────────

/** Operating modes the LCD can display (line 1 prefix) */
const KNOWN_MODES = ['CU', 'CC', 'CV', 'CP', 'DC', 'AC'] as const;

/** Status indicators the LCD can display (line 2 prefix) */
const KNOWN_STATUSES = ['OFF', 'ON', 'CHG', 'DIS', 'END', 'ERR', 'FUL', 'OVP'] as const;

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse raw OCR text from the LCD into structured data.
 *
 * Handles typical OCR errors:
 * - V/U confusion (LCD font)
 * - 0/O confusion
 * - W/V/U confusion
 * - Missing/extra spaces
 */
export function parseLcdText(text: string): LcdParsed {
  const result: LcdParsed = {
    mode: null,
    voltage: null,
    current: null,
    power: null,
    status: null,
    capacityMah: null,
    time: null,
    pcMode: false,
  };

  if (!text || text.trim().length === 0) return result;

  // Split into lines (handle both \n and | separators from OCR output)
  const lines = text
    .split(/[\n|]/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return result;

  // Parse line 1: mode + voltage + current/power
  if (lines.length >= 1) {
    parseLine1(lines[0], result);
  }

  // Parse line 2: status + power/info + capacity
  if (lines.length >= 2) {
    parseLine2(lines[1], result);
  }

  return result;
}

// ── Line 1 Parser ────────────────────────────────────────────────────

function parseLine1(line: string, result: LcdParsed): void {
  // Normalize OCR noise: common substitutions
  const normalized = normalizeLcdText(line);

  // Extract mode (first 1-3 letter token). LCD shows 2-letter modes (CU, CC, CV)
  // but OCR sometimes drops a character, giving just "C", or adds one.
  const modeMatch = normalized.match(/^([A-Z]{1,3})\b/);
  if (modeMatch) {
    const candidate = modeMatch[1];
    result.mode = fuzzyMatchMode(candidate);
  }

  // Extract voltage: number followed by V
  const voltageMatch = normalized.match(/(\d+\.?\d*)\s*V/i);
  if (voltageMatch) {
    result.voltage = parseFloat(voltageMatch[1]);
  }

  // Extract current (A) or power (W) — the second numeric value with unit
  // Look for the unit AFTER the voltage match
  const afterVoltage = voltageMatch
    ? normalized.slice((voltageMatch.index ?? 0) + voltageMatch[0].length)
    : normalized;

  const currentMatch = afterVoltage.match(/(\d+\.?\d*)\s*A/i);
  if (currentMatch) {
    result.current = parseFloat(currentMatch[1]);
  }

  const powerMatch = afterVoltage.match(/(\d+\.?\d*)\s*W/i);
  if (powerMatch) {
    result.power = parseFloat(powerMatch[1]);
  }
}

// ── Line 2 Parser ────────────────────────────────────────────────────

function parseLine2(line: string, result: LcdParsed): void {
  const normalized = normalizeLcdText(line);

  // Extract status (first token)
  const statusMatch = normalized.match(/^([A-Z]{2,4})\b/);
  if (statusMatch) {
    result.status = fuzzyMatchStatus(statusMatch[1]);
  }

  // Check for -PC- indicator
  if (normalized.includes('-PC-') || normalized.includes('PC')) {
    result.pcMode = true;
  }

  // Extract capacity: number followed by mAh (or OCR variants: mHh, mHn, mh, pAh, etc.)
  const capacityMatch = normalized.match(/(\d+)\s*[MP]\s*[AH]\s*[HN]?/i);
  if (capacityMatch) {
    result.capacityMah = parseInt(capacityMatch[1], 10);
  }

  // Extract power on line 2: number followed by W
  const powerMatch = normalized.match(/(\d+\.?\d*)\s*W/i);
  if (powerMatch && result.power === null) {
    result.power = parseFloat(powerMatch[1]);
  }

  // Extract time: MM:SS or HH:MM:SS pattern
  const timeMatch = normalized.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (timeMatch) {
    result.time = timeMatch[1];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize common LCD OCR errors.
 *
 * The 7-segment LCD font causes systematic Tesseract confusions:
 * - V ↔ U ↔ 0 (the vertical bars of V look like U or 0)
 * - A ↔ 6 ↔ R (the crossbar of A confuses with 6 or R)
 * - 0 ↔ 9 ↔ @ ↔ O (round shapes interchange)
 * - C ↔ G (open vs closed curve)
 * - mAh often reads as "mHn", "mkh", "mh", etc.
 */
function normalizeLcdText(text: string): string {
  let s = text
    .toUpperCase()
    // Strip trailing punctuation from OCR noise
    .replace(/[,.']+$/g, '')
    // @ is always 0 on an LCD
    .replace(/@/g, '0')
    // Fix parentheses/brackets that are stray OCR noise
    .replace(/[()[\]{}]/g, '')
    // U→V when preceded by a digit (voltage unit confusion)
    .replace(/(\d)\s*U\b/g, '$1V')
    // Fix common digit-letter confusion
    .replace(/[lI|]/g, '1') // l/I/| → 1
    .replace(/O(?=\d)/g, '0') // O before digit → 0
    .replace(/(?<=\d)O/g, '0') // digit then O → 0
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // Structural fix: a number like "3.1320" where the trailing "0" should be "V"
  // Pattern: digit.digit{3}0 followed by space → insert V
  s = s.replace(/(\d\.\d{3})0(\s)/g, '$1V$2');
  // Same at end of string
  s = s.replace(/(\d\.\d{3})0$/g, '$1V');

  // Structural fix: trailing "6", "R", "6R", "06R" etc. after current digits should be "A"
  // Pattern: "NN.NN" followed by non-A unit char(s)
  s = s.replace(/(\d{2}\.\d{2})\s*[6R]+[A-Z]*/g, '$1A');
  // Also handle "00. 06" / "00. 06R" → "00.00A" (stray space in number + wrong unit)
  s = s.replace(/(\d{2})\.\s+(\d)[6R]+[A-Z]*/g, '$1.0$2A');

  return s;
}

/** Fuzzy match a 1-3 letter token to known operating modes */
function fuzzyMatchMode(candidate: string): string {
  // Direct match
  if ((KNOWN_MODES as readonly string[]).includes(candidate)) return candidate;

  // Common OCR misreads
  const fixes: Record<string, string> = {
    // Single-char partial reads (Tesseract dropped a letter)
    C: 'CU', // Most common mode, "C" alone likely means "CU"
    // 2-char matches
    CV: 'CV',
    CU: 'CU',
    CC: 'CC',
    CP: 'CP',
    CW: 'CU', // W is a common misread of U in LCD font
    CY: 'CU', // Y is a common misread of U in LCD font
    CI: 'CU', // I misread of U
    CL: 'CU', // l→L after uppercase, misread of U
    Cl: 'CU', // l misread of U
    // OCR might read C as G
    GU: 'CU',
    GV: 'CV',
    GC: 'CC',
    // 3-char (OCR added noise)
    CUV: 'CU',
    CVV: 'CV',
  };
  return fixes[candidate] ?? candidate;
}

/** Fuzzy match a status token to known statuses */
function fuzzyMatchStatus(candidate: string): string {
  if ((KNOWN_STATUSES as readonly string[]).includes(candidate)) return candidate;

  const fixes: Record<string, string> = {
    OEF: 'OFF',
    OFE: 'OFF',
    OF: 'OFF',
    '0FF': 'OFF',
    ONI: 'ON',
    GHG: 'CHG',
    DI5: 'DIS',
    FULL: 'FUL',
  };
  return fixes[candidate] ?? candidate;
}

// ── Protocol Synthesis ───────────────────────────────────────────────

/**
 * Maps from protocol state byte to the LCD mode abbreviation.
 *
 * The mode displayed on the LCD depends on which command started the
 * test — this is encoded in the state byte.
 */
const STATE_TO_MODE: Record<number, string> = {
  0x00: 'CU', // EBD idle (constant voltage mode default)
  0x02: 'CU', // EBC idle
  0x0a: 'CU', // EBD active — mode depends on command, CU is default
  0x0c: 'CC', // EBC charging (constant current charge)
};

const STATE_TO_STATUS: Record<number, string> = {
  0x00: 'OFF', // EBD idle
  0x02: 'OFF', // EBC idle
  0x0a: 'ON', // EBD active
  0x0c: 'CHG', // EBC charging
};

/**
 * Synthesize LCD display text from decoded protocol data.
 *
 * This produces what the LCD *should* show based on the protocol
 * values, without any camera or OCR involved. Instant and exact.
 *
 * @param decoded  Decoded RX frame from the protocol codec
 * @returns Structured LCD data matching what the physical display shows
 */
export function synthesizeFromProtocol(decoded: {
  state: number;
  voltage: number;
  current: number;
  field6: number;
  field7: number;
}): LcdParsed {
  const state = decoded.state;
  // Strip info offset for mode/status lookup
  const baseState = state >= 0x64 ? state - 0x64 : state;

  return {
    mode: STATE_TO_MODE[baseState] ?? null,
    voltage: decoded.voltage,
    current: decoded.current,
    power: Math.round(decoded.voltage * decoded.current * 1000) / 1000,
    status: STATE_TO_STATUS[baseState] ?? null,
    // field6 is capacity for EBC (raw mAh), D+ voltage for EBD
    capacityMah: baseState === 0x02 || baseState === 0x0c ? Math.round(decoded.field6 * 1000) : null,
    time: null, // not available from protocol
    pcMode: true, // always true when connected via PC
  };
}
