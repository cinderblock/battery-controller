/**
 * GUI Window Screenshot Capture
 *
 * Auto-detects the EB Tester VB6 application window and captures
 * screenshots of it via ffmpeg's gdigrab. Runs alongside the RTSP
 * camera — RTSP captures the physical device LCD, this captures
 * what the software displays.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Known process name patterns for the EB Tester application */
const KNOWN_PROCESS_PATTERNS = ['eb_setup', 'eb_tester', 'ebtester'];

/**
 * Find the EB Tester window title by scanning running processes.
 * Returns the main window title, or null if not found.
 */
export function findEbTesterWindow(): string | null {
  try {
    // Use tasklist /v /fo csv to get window titles efficiently
    const result = spawnSync('tasklist', ['/v', '/fo', 'csv'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });

    if (result.status !== 0 || !result.stdout) return null;

    const output = result.stdout.toString();
    const lines = output.split('\n');

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Check if any known process pattern appears in the line
      const matchesProcess = KNOWN_PROCESS_PATTERNS.some(p => lower.includes(p));
      if (!matchesProcess) continue;

      // Parse CSV line — window title is the last field
      // Format: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
      const fields = parseCSVLine(line);
      if (fields.length < 9) continue;

      const windowTitle = fields[fields.length - 1].trim();
      // Skip entries with no real window title
      if (!windowTitle || windowTitle === 'N/A') continue;

      return windowTitle;
    }
  } catch {
    // tasklist failed — not critical
  }

  return null;
}

/** Parse a CSV line handling quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export class GuiCapture {
  private windowTitle: string;
  private captureCount = 0;

  constructor(
    windowTitle: string,
    private sessionDir: string
  ) {
    this.windowTitle = windowTitle;
  }

  /**
   * Capture a screenshot of the GUI window using ffmpeg gdigrab.
   * Returns { filename, sizeBytes } JSON string, or null on failure.
   *
   * gdigrab is a local capture — no network involved — so per-invocation
   * spawning is fast enough (~200-500ms).
   */
  capture(): string | null {
    this.captureCount++;
    const filename = `gui-${this.captureCount.toString().padStart(4, '0')}.png`;
    const destPath = join(this.sessionDir, filename);

    try {
      const result = spawnSync(
        'ffmpeg',
        ['-f', 'gdigrab', '-framerate', '1', '-i', `title=${this.windowTitle}`, '-frames:v', '1', '-y', destPath],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 5000,
        }
      );

      if (result.status !== 0) {
        // Window may have closed — not an error worth logging every time
        this.captureCount--;
        return null;
      }

      if (!existsSync(destPath)) {
        this.captureCount--;
        return null;
      }

      const stat = statSync(destPath);
      return JSON.stringify({ filename, sizeBytes: stat.size });
    } catch {
      this.captureCount--;
      return null;
    }
  }

  /** Clean up — nothing persistent to stop (unlike RTSP camera) */
  stop(): void {
    // No persistent process to kill
  }
}
