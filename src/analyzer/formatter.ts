/**
 * Analyzer Output Formatter
 *
 * Produces colored, tabular console output from parsed recording data.
 * Supports multiple output modes: full decode, raw hex, unknown field
 * highlighting, and summary statistics.
 */

import { toHex } from '../protocol/codec.ts';
import type { DecodedRxFrame, DecodedTxFrame } from '../protocol/types.ts';
import type {
  RecordingSummary,
  TimelineEvent,
  TimestampedFrame,
  TimestampedNote,
  TimestampedScreenshot,
} from './parser.ts';

// ── ANSI Colors ───────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  white: '\x1b[37m',
};

// ── Time Formatting ───────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return (
    [
      d.getHours().toString().padStart(2, '0'),
      d.getMinutes().toString().padStart(2, '0'),
      d.getSeconds().toString().padStart(2, '0'),
    ].join(':') +
    '.' +
    d.getMilliseconds().toString().padStart(3, '0')
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

// ── Frame Formatting ──────────────────────────────────────────────────

function formatTxFrame(frame: TimestampedFrame): string {
  const decoded = frame.decoded as DecodedTxFrame;
  const time = formatTimestamp(frame.startTime);
  const hex = toHex(decoded.raw);
  const cmd = `CMD=0x${decoded.command.toString(16).padStart(2, '0')}`;

  let detail = `${cmd} (${decoded.commandName})`;
  if (decoded.currentSetpoint !== undefined && decoded.currentSetpoint > 0) {
    detail += `  I=${decoded.currentSetpoint.toFixed(4)}A`;
  }
  if (decoded.cutoffVoltage !== undefined && decoded.cutoffVoltage > 0) {
    detail += `  cutoff=${decoded.cutoffVoltage.toFixed(2)}V`;
  }

  const checksumMark = decoded.checksumValid ? '' : ` ${colors.red}[BAD CHECKSUM]${colors.cyan}`;

  return (
    `${colors.cyan}[${time}] TX  ${decoded.raw.length.toString().padStart(2)} bytes  ${detail}${checksumMark}${colors.reset}\n` +
    `${colors.dim}         ${hex}${colors.reset}`
  );
}

function formatRxFrame(frame: TimestampedFrame): string {
  const decoded = frame.decoded as DecodedRxFrame;
  const time = formatTimestamp(frame.startTime);
  const hex = toHex(decoded.raw);
  const stateHex = `0x${decoded.state.toString(16).padStart(2, '0')}`;

  const checksumMark = decoded.checksumValid ? '' : ` ${colors.red}[BAD CHECKSUM]${colors.green}`;

  return (
    `${colors.green}[${time}] RX  ${decoded.raw.length.toString().padStart(2)} bytes  STATE=${stateHex}  V=${decoded.voltage.toFixed(3)}  I=${decoded.current.toFixed(4)}A  f6=${decoded.field6.toFixed(3)}  f7=${decoded.field7.toFixed(3)}${checksumMark}${colors.reset}\n` +
    `${colors.dim}         ${hex}${colors.reset}`
  );
}

// ── Raw Hex Formatting ────────────────────────────────────────────────

function formatRawFrame(frame: TimestampedFrame): string {
  const time = formatTimestamp(frame.startTime);
  const dir = frame.direction.toUpperCase();
  const hex = toHex(frame.decoded.raw);
  const color = frame.direction === 'tx' ? colors.cyan : colors.green;
  return `${color}[${time}] ${dir}  ${hex}${colors.reset}`;
}

// ── Unknown Field Highlighting ────────────────────────────────────────

function formatUnknownFields(frame: TimestampedFrame): string {
  if (frame.direction !== 'rx') return formatRxFrame(frame);

  const decoded = frame.decoded as DecodedRxFrame;
  const time = formatTimestamp(frame.startTime);
  const stateHex = `0x${decoded.state.toString(16).padStart(2, '0')}`;

  // Fields 6-12 are model-dependent / unknown for EBC chargers
  const unknowns = [
    `f6=${colors.yellow}${decoded.field6.toFixed(3)}${colors.green}`,
    `f7=${colors.yellow}${decoded.field7.toFixed(3)}${colors.green}`,
    `f10=${colors.yellow}${decoded.field10}${colors.green}`,
    `f11=${colors.yellow}${decoded.field11}${colors.green}`,
    `f12=${colors.yellow}${decoded.field12}${colors.green}`,
  ].join('  ');

  return (
    `${colors.green}[${time}] RX  STATE=${stateHex}  V=${decoded.voltage.toFixed(3)}  I=${decoded.current.toFixed(4)}A  ${unknowns}${colors.reset}\n` +
    `${colors.dim}         ${toHex(decoded.raw)}${colors.reset}`
  );
}

// ── Note Formatting ───────────────────────────────────────────────────

function formatNote(note: TimestampedNote): string {
  const time = formatTimestamp(note.time);
  return `${colors.yellow}[${time}] \u{1F4DD} NOTE: "${note.text}"${colors.reset}`;
}

function formatScreenshot(screenshot: TimestampedScreenshot): string {
  const time = formatTimestamp(screenshot.time);
  const sizeKb = (screenshot.sizeBytes / 1024).toFixed(0);
  return `${colors.magenta}[${time}] \u{1F4F7} SCREENSHOT: ${screenshot.filename} (${sizeKb} KB)${colors.reset}`;
}

// ── Summary Formatting ────────────────────────────────────────────────

export function formatSummary(summary: RecordingSummary): string {
  const lines = [
    `${colors.bold}Recording Summary${colors.reset}`,
    `  Duration:         ${formatDuration(summary.durationMs)}`,
    `  Total records:    ${summary.totalRecords}`,
    `  Total bytes:      ${summary.totalBytes}`,
    `  TX frames:        ${summary.txFrames}`,
    `  RX frames:        ${summary.rxFrames}`,
    `  Notes:            ${summary.notes}`,
    `  Screenshots:      ${summary.screenshots}`,
    `  Checksum errors:  ${summary.checksumErrors > 0 ? colors.red + summary.checksumErrors + colors.reset : '0'}`,
    `  First timestamp:  ${summary.firstTimestamp}`,
    `  Last timestamp:   ${summary.lastTimestamp}`,
  ];
  return lines.join('\n');
}

// ── Main Formatting Entry Point ───────────────────────────────────────

export type OutputMode = 'decode' | 'raw' | 'unknown' | 'summary';

/**
 * Format a timeline of events (frames + notes) in chronological order.
 */
export function formatTimeline(events: TimelineEvent[], mode: OutputMode = 'decode'): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'note') {
      lines.push(formatNote(event.data));
    } else if (event.type === 'screenshot') {
      lines.push(formatScreenshot(event.data));
    } else {
      lines.push(...formatFrames([event.data], mode));
    }
  }
  return lines;
}

export function formatFrames(frames: TimestampedFrame[], mode: OutputMode = 'decode'): string[] {
  const lines: string[] = [];

  for (const frame of frames) {
    switch (mode) {
      case 'raw':
        lines.push(formatRawFrame(frame));
        break;

      case 'unknown':
        if (frame.direction === 'rx') {
          lines.push(formatUnknownFields(frame));
        } else {
          lines.push(formatTxFrame(frame));
        }
        break;

      default:
        if (frame.direction === 'tx') {
          lines.push(formatTxFrame(frame));
        } else {
          lines.push(formatRxFrame(frame));
        }
        break;
    }
  }

  return lines;
}
