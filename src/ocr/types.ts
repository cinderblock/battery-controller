/**
 * Shared OCR types — structured data extracted from displays
 *
 * Both the LCD (camera) and GUI (VB6 app) produce these same structured
 * types, so the correlator can store pure data without images.
 */

// ── LCD Display ──────────────────────────────────────────────────────

/**
 * Structured data parsed from the 2-line LCD display.
 *
 * Line 1 format: `{mode} {voltage}V {current}A` or `{mode} {voltage}V {power}W`
 * Line 2 format: `{status} {power}W {capacity}mAh` or `{status} -PC- {capacity}mAh`
 */
export interface LcdParsed {
  /** Operating mode abbreviation: CU, CC, CV, CP, etc. */
  mode: string | null;
  /** Voltage in volts (e.g. 3.130) */
  voltage: number | null;
  /** Current in amps (e.g. 1.00) */
  current: number | null;
  /** Power in watts (e.g. 0.00) */
  power: number | null;
  /** Load/charge status text: OFF, ON, CHG, DIS, etc. */
  status: string | null;
  /** Accumulated capacity in mAh */
  capacityMah: number | null;
  /** Elapsed time as displayed (e.g. "01:23") */
  time: string | null;
  /** Whether -PC- (PC control) indicator is shown */
  pcMode: boolean;
}

/** Full OCR result with metadata */
export interface OcrReading {
  /** Structured data parsed from the display */
  parsed: LcdParsed;
  /** Raw OCR text lines (for debugging/validation) */
  rawLines: string[];
  /** OCR confidence 0–100 */
  confidence: number;
  /** Time taken for OCR in milliseconds */
  ocrMs: number;
  /** Source engine: 'tesseract', 'claude', or 'protocol' */
  source: 'tesseract' | 'claude' | 'protocol';
}

// ── GUI Application ──────────────────────────────────────────────────

/**
 * Structured data read from the EB Tester GUI window.
 *
 * The VB6 app displays readings in labeled fields. We extract them
 * either via Win32 UI Automation (exact) or Tesseract OCR (screenshot).
 */
export interface GuiReading {
  /** Named fields extracted from the GUI (label → value) */
  fields: Record<string, string>;
  /** Source: 'uia' (UI Automation) or 'tesseract' (screenshot OCR) */
  source: 'uia' | 'tesseract';
  /** Raw OCR text (tesseract source only) */
  rawText?: string;
  /** OCR confidence 0–100 (tesseract source only) */
  confidence?: number;
  /** Time taken in milliseconds */
  readMs: number;
}

// ── Correlator Record ────────────────────────────────────────────────

/** A single correlated data point — pure structured data, no images */
export interface CorrelatedRecord {
  /** ISO timestamp */
  t: string;
  /** Monotonic time (ms) */
  mono: number;
  /** Record type */
  type: 'rx' | 'tx' | 'connect' | 'note' | 'lcd' | 'gui';
  /** Decoded protocol packet data (rx/tx records) */
  packet?: {
    state: number;
    current: number;
    voltage: number;
    field6: number;
    field7: number;
    field8: number;
    field9: number;
    field10: number;
    field11: number;
    maxTimeOrCutoff: number;
    field12: number;
    raw: string;
  };
  /** LCD display reading (lcd records, or inline with rx) */
  lcd?: OcrReading;
  /** GUI application reading (gui records) */
  gui?: GuiReading;
  /** Screenshot filename — only when --save-images is enabled */
  screenshot?: string | null;
  /** Free-form note */
  note?: string;
}
