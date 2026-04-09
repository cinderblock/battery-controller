/**
 * GUI Window Screenshot Capture
 *
 * Auto-detects the EB Tester VB6 application window and captures
 * screenshots via PowerShell + .NET CopyFromScreen. Runs alongside
 * the RTSP camera — RTSP captures the physical device LCD, this
 * captures what the software displays.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Patterns matched against process name + window title */
const KNOWN_PATTERNS = ['eb_setup', 'eb_tester', 'ebtester', 'zketech', 'eb tester'];

/**
 * Find the EB Tester window by enumerating all visible windows.
 *
 * VB6 apps often have a hidden shell window that Get-Process reports,
 * while the actual visible form is a separate top-level window with
 * a different title. We enumerate all windows and match against
 * known patterns to find the real one (with non-zero size).
 *
 * Returns the exact window title, or null if not found.
 */
export function findEbTesterWindow(): string | null {
  try {
    // EnumWindows finds ALL top-level windows; we filter by title pattern
    // and non-zero size to find the actual visible VB6 form.
    const script = `
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static List<string> results = new List<string>();
  public static bool Callback(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    if (w > 0 && ht > 0) results.Add(sb.ToString());
    return true;
  }
}
'@
[WinEnum]::EnumWindows([WinEnum+EnumProc]{ param($h,$l) [WinEnum]::Callback($h,$l) }, [IntPtr]::Zero) | Out-Null
[WinEnum]::results | ForEach-Object { Write-Output $_ }
`.trim();

    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
    });

    if (result.status !== 0 || !result.stdout) return null;

    const lines = result.stdout.toString().split('\n');
    for (const line of lines) {
      const title = line.trim();
      if (!title) continue;
      const lower = title.toLowerCase();
      if (KNOWN_PATTERNS.some(p => lower.includes(p))) {
        return title;
      }
    }
  } catch {
    // PowerShell not available — not critical
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

/**
 * PowerShell script that finds a window by (partial) title, restores it
 * if minimized, captures its client area via .NET Graphics.CopyFromScreen,
 * and saves as PNG. Works reliably with VB6 apps where ffmpeg gdigrab fails.
 */
function buildCaptureScript(windowTitle: string, destPath: string): string {
  // Escape for PowerShell string literal
  const escapedTitle = windowTitle.replace(/'/g, "''");
  const escapedPath = destPath.replace(/'/g, "''");
  // VB6 apps don't respond to PrintWindow, so we briefly set the
  // window topmost, CopyFromScreen its rect, then remove topmost.
  // Total visual disruption: ~200ms. SWP_NOMOVE|SWP_NOSIZE = 0x0003
  return `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinApi {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
  public static readonly IntPtr TOPMOST = new IntPtr(-1);
  public static readonly IntPtr NOTOPMOST = new IntPtr(-2);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
'@
$hwnd = [WinApi]::FindWindow([NullString]::Value, '${escapedTitle}')
if ($hwnd -eq [IntPtr]::Zero) { exit 1 }
[WinApi]::ShowWindow($hwnd, 9) | Out-Null
[WinApi]::SetWindowPos($hwnd, [WinApi]::TOPMOST, 0, 0, 0, 0, 0x0003) | Out-Null
Start-Sleep -Milliseconds 200
$rc = New-Object WinApi+RECT
[WinApi]::GetWindowRect($hwnd, [ref]$rc) | Out-Null
$ww = $rc.R - $rc.L; $hh = $rc.B - $rc.T
if ($ww -le 0 -or $hh -le 0) { exit 1 }
$bmp = New-Object System.Drawing.Bitmap($ww, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rc.L, $rc.T, 0, 0, (New-Object System.Drawing.Size($ww, $hh)))
$g.Dispose()
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[WinApi]::SetWindowPos($hwnd, [WinApi]::NOTOPMOST, 0, 0, 0, 0, 0x0003) | Out-Null
`.trim();
}

export class GuiCapture {
  private captureCount = 0;

  constructor(
    private windowTitle: string,
    private sessionDir: string
  ) {}

  /**
   * Capture a screenshot of the GUI window using PowerShell + .NET
   * Graphics.CopyFromScreen. Works with VB6 apps where gdigrab fails.
   *
   * Returns { filename, sizeBytes } JSON string, or null on failure.
   */
  capture(): string | null {
    this.captureCount++;
    const filename = `gui-${this.captureCount.toString().padStart(4, '0')}.png`;
    const destPath = join(this.sessionDir, filename);

    try {
      const script = buildCaptureScript(this.windowTitle, destPath);
      const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 8000,
      });

      if (result.status !== 0 || !existsSync(destPath)) {
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

  /** Clean up — nothing persistent to stop */
  stop(): void {
    // No persistent process to kill
  }
}
