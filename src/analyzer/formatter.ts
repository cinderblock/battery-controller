/**
 * Analyzer Output Formatter
 *
 * Produces colored, tabular console output from parsed recording data.
 */

import type { RxPacketRecord, TxPacketRecord } from '../proxy/recorder.ts';
import type {
  RecordingSummary,
  TimelineEvent,
  TimestampedNote,
  TimestampedPacket,
  TimestampedScreenshot,
} from './parser.ts';

// ── ANSI Colors ───────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
};

// ── Time Formatting ───────────────────────────────────────────────────

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return (
    [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => n.toString().padStart(2, '0')).join(':') +
    '.' +
    d.getMilliseconds().toString().padStart(3, '0')
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

// ── Packet Formatting ─────────────────────────────────────────────────

function fmtTx(pkt: TimestampedPacket, mode: OutputMode): string {
  const tx = pkt.record as TxPacketRecord;
  const time = fmtTime(pkt.time);

  if (mode === 'raw') {
    return `${c.cyan}[${time}] TX  ${tx.raw}${c.reset}`;
  }

  let detail = `CMD=0x${tx.cmd.toString(16).padStart(2, '0')} (${tx.cmdName})`;
  if (tx.currentSetpoint !== undefined && tx.currentSetpoint > 0) {
    detail += `  I=${tx.currentSetpoint.toFixed(4)}A`;
  }
  if (tx.cutoffVoltage !== undefined && tx.cutoffVoltage > 0) {
    detail += `  cutoff=${tx.cutoffVoltage.toFixed(2)}V`;
  }
  const warn = tx.checksumValid ? '' : ` ${c.red}[BAD CHECKSUM]${c.cyan}`;

  return (
    `${c.cyan}[${time}] TX  ${tx.len} bytes  ${detail}${warn}${c.reset}\n` +
    `${c.dim}         ${formatHexSpaced(tx.raw)}${c.reset}`
  );
}

function fmtRx(pkt: TimestampedPacket, mode: OutputMode): string {
  const rx = pkt.record as RxPacketRecord;
  const time = fmtTime(pkt.time);

  if (mode === 'raw') {
    return `${c.green}[${time}] RX  ${rx.raw}${c.reset}`;
  }

  const stateHex = `0x${rx.state.toString(16).padStart(2, '0')}`;
  const warn = rx.checksumValid ? '' : ` ${c.red}[BAD CHECKSUM]${c.green}`;

  if (mode === 'unknown') {
    const unknowns = [
      `f6=${c.yellow}${rx.field6.toFixed(3)}${c.green}`,
      `f7=${c.yellow}${rx.field7.toFixed(3)}${c.green}`,
      `f10=${c.yellow}${rx.field10}${c.green}`,
      `f11=${c.yellow}${rx.field11}${c.green}`,
      `f12=${c.yellow}${rx.field12}${c.green}`,
    ].join('  ');
    return (
      `${c.green}[${time}] RX  STATE=${stateHex}  V=${rx.voltage.toFixed(3)}  I=${rx.current.toFixed(4)}A  ${unknowns}${warn}${c.reset}\n` +
      `${c.dim}         ${formatHexSpaced(rx.raw)}${c.reset}`
    );
  }

  return (
    `${c.green}[${time}] RX  ${rx.len} bytes  STATE=${stateHex}  V=${rx.voltage.toFixed(3)}  I=${rx.current.toFixed(4)}A  f6=${rx.field6.toFixed(3)}  f7=${rx.field7.toFixed(3)}${warn}${c.reset}\n` +
    `${c.dim}         ${formatHexSpaced(rx.raw)}${c.reset}`
  );
}

function formatHexSpaced(hex: string): string {
  return hex.replace(/(.{2})/g, '$1 ').trim();
}

// ── Note / Screenshot Formatting ──────────────────────────────────────

function fmtNote(note: TimestampedNote): string {
  return `${c.yellow}[${fmtTime(note.time)}] \u{1F4DD} NOTE: "${note.text}"${c.reset}`;
}

function fmtScreenshot(s: TimestampedScreenshot): string {
  const sizeKb = (s.sizeBytes / 1024).toFixed(0);
  return `${c.magenta}[${fmtTime(s.time)}] \u{1F4F7} SCREENSHOT: ${s.filename} (${sizeKb} KB)${c.reset}`;
}

// ── Summary ───────────────────────────────────────────────────────────

export function formatSummary(summary: RecordingSummary): string {
  const lines = [
    `${c.bold}Recording Summary${c.reset}`,
    `  Duration:         ${fmtDuration(summary.durationMs)}`,
    `  Total records:    ${summary.totalRecords}`,
    `  TX packets:       ${summary.txPackets}`,
    `  RX packets:       ${summary.rxPackets}`,
    `  Notes:            ${summary.notes}`,
    `  Screenshots:      ${summary.screenshots}`,
    `  Checksum errors:  ${summary.checksumErrors > 0 ? c.red + summary.checksumErrors + c.reset : '0'}`,
    `  First timestamp:  ${summary.firstTimestamp}`,
    `  Last timestamp:   ${summary.lastTimestamp}`,
  ];
  return lines.join('\n');
}

// ── Main Entry Point ──────────────────────────────────────────────────

export type OutputMode = 'decode' | 'raw' | 'unknown' | 'summary';

export function formatTimeline(events: TimelineEvent[], mode: OutputMode = 'decode'): string[] {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'note':
        lines.push(fmtNote(event.data));
        break;
      case 'screenshot':
        lines.push(fmtScreenshot(event.data));
        break;
      case 'packet':
        if (event.data.direction === 'tx') {
          lines.push(fmtTx(event.data, mode));
        } else {
          lines.push(fmtRx(event.data, mode));
        }
        break;
    }
  }
  return lines;
}
