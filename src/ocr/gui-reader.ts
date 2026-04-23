/**
 * GUI Text Reader — extract data from the EB Tester VB6 window
 *
 * Two strategies in order of preference:
 *
 * 1. **Win32 UI Automation** — reads text directly from VB6 controls
 *    via PowerShell. No image processing needed. Instant and exact.
 *    Works if the VB6 app exposes IAccessible (most do).
 *
 * 2. **Tesseract OCR** — captures a screenshot and OCRs the text.
 *    Works universally. Windows GUI text at screen resolution is
 *    trivially accurate for Tesseract.
 *
 * Both produce structured { fields, source, readMs } output.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { TesseractReader } from './tesseract-reader.ts';
import type { GuiReading } from './types.ts';

// ── UI Automation via PowerShell ─────────────────────────────────────

/**
 * PowerShell script that uses Win32 UI Automation to enumerate all
 * text elements in a window. Outputs CSV: name,value
 *
 * VB6 apps implement IAccessible via OLEACC, which UIAutomation
 * bridges automatically. This reads Label, TextBox, and other
 * controls without needing screenshots.
 */
function buildUiaScript(windowTitle: string): string {
  const escaped = windowTitle.replace(/'/g, "''");
  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  '${escaped}'
)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { exit 1 }

# Walk all descendants and collect text content
$all = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true
)
$elements = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $all)

foreach ($el in $elements) {
  $name = $el.Current.Name
  $ctrlType = $el.Current.ControlType.ProgrammaticName

  # Try ValuePattern for editable controls
  $val = $null
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $val = $vp.Current.Value
  } catch {}

  # Try TextPattern for rich text
  if (-not $val) {
    try {
      $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $val = $tp.DocumentRange.GetText(1000)
    } catch {}
  }

  # Use Name as value for labels/static text
  if (-not $val -and $ctrlType -match 'Text|Edit') {
    $val = $name
  }

  if ($name -and $val) {
    # Output as tab-separated: controlType, name, value
    Write-Output "$ctrlType\t$name\t$val"
  }
}
`.trim();
}

/**
 * Try to read GUI controls via Win32 UI Automation.
 *
 * @returns GuiReading if successful, null if UIA can't access the window
 */
export function readGuiViaUia(windowTitle: string): GuiReading | null {
  const start = performance.now();

  try {
    const script = buildUiaScript(windowTitle);
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });

    if (result.status !== 0 || !result.stdout) return null;

    const lines = result.stdout
      .toString()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return null;

    const fields: Record<string, string> = {};
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const [_ctrlType, name, value] = parts;
        if (name && value && name !== value) {
          // Use the control name as field key, cleaned up
          const key = name.replace(/[:\s]+$/, '').trim();
          if (key) fields[key] = value.trim();
        }
      }
    }

    const elapsed = performance.now() - start;

    if (Object.keys(fields).length === 0) return null;

    return {
      fields,
      source: 'uia',
      readMs: Math.round(elapsed),
    };
  } catch {
    return null;
  }
}

// ── Tesseract Fallback ───────────────────────────────────────────────

/**
 * Read GUI text via Tesseract OCR on a screenshot.
 *
 * For VB6 apps, the readings are typically in a specific region
 * of the window. This reads the full window and returns all text found.
 *
 * @param screenshotPath  Path to the GUI screenshot PNG
 * @param tesseract       Initialized TesseractReader instance
 * @returns GuiReading with OCR results
 */
export async function readGuiViaTesseract(
  screenshotPath: string,
  tesseract: TesseractReader
): Promise<GuiReading | null> {
  if (!existsSync(screenshotPath)) return null;

  const start = performance.now();

  try {
    const image = readFileSync(screenshotPath);
    const result = await tesseract.readGui(image);
    if (!result || !result.text) return null;

    // Parse the OCR text into key-value fields.
    // VB6 apps typically show "Label: Value" pairs.
    const fields = parseGuiText(result.text);

    return {
      fields,
      source: 'tesseract',
      rawText: result.text,
      confidence: result.confidence,
      readMs: Math.round(performance.now() - start),
    };
  } catch {
    return null;
  }
}

/**
 * Parse raw GUI OCR text into key-value fields.
 *
 * Looks for patterns like:
 * - "Voltage: 3.130 V"
 * - "Current  0.00 A"
 * - label-value pairs separated by colons or whitespace
 */
function parseGuiText(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Try "Label: Value" pattern
    const colonMatch = line.match(/^([A-Za-z\s]+):\s*(.+)$/);
    if (colonMatch) {
      const key = colonMatch[1].trim();
      const value = colonMatch[2].trim();
      if (key && value) {
        fields[key] = value;
        continue;
      }
    }

    // Try "Label  Value Unit" pattern (VB6 often uses spacing, not colons)
    const spaceMatch = line.match(/^([A-Za-z]+)\s{2,}(.+)$/);
    if (spaceMatch) {
      const key = spaceMatch[1].trim();
      const value = spaceMatch[2].trim();
      if (key && value) {
        fields[key] = value;
        continue;
      }
    }

    // Store unmatched lines with numeric index
    if (line.match(/\d/)) {
      // Contains a number — probably a reading
      fields[`line_${Object.keys(fields).length}`] = line;
    }
  }

  return fields;
}

// ── Combined Reader ──────────────────────────────────────────────────

/**
 * Read GUI data using the best available method.
 *
 * Tries UI Automation first (instant, exact), falls back to
 * Tesseract OCR on a screenshot (fast, reliable for Windows text).
 */
export async function readGui(
  windowTitle: string,
  screenshotPath: string | null,
  tesseract: TesseractReader
): Promise<GuiReading | null> {
  // Try UI Automation first — no image needed
  const uiaResult = readGuiViaUia(windowTitle);
  if (uiaResult && Object.keys(uiaResult.fields).length > 0) {
    return uiaResult;
  }

  // Fall back to Tesseract on screenshot
  if (screenshotPath) {
    return readGuiViaTesseract(screenshotPath, tesseract);
  }

  return null;
}
