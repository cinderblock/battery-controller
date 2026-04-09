/**
 * Traffic Recorder
 *
 * Records decoded serial packets to a JSONL file with timestamps.
 * Each line is a self-contained record — either a decoded packet,
 * a user annotation, or a screenshot reference.
 */

import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toHex } from '../protocol/codec.ts';
import type { DecodedRxFrame, DecodedTxFrame, FrameDirection } from '../protocol/types.ts';

/** A decoded TX (host -> device) packet record */
export interface TxPacketRecord {
  t: string;
  mono: number;
  dir: 'tx';
  /** Full frame as hex string */
  raw: string;
  len: number;
  /** Command byte */
  cmd: number;
  /** Human-readable command name */
  cmdName: string;
  /** Decoded fields (base-240) */
  currentSetpoint?: number;
  cutoffVoltage?: number;
  checksumValid: boolean;
}

/** A decoded RX (device -> host) packet record */
export interface RxPacketRecord {
  t: string;
  mono: number;
  dir: 'rx';
  /** Full frame as hex string */
  raw: string;
  len: number;
  /** State byte */
  state: number;
  /** Decoded fields (base-240) */
  current: number;
  voltage: number;
  /** Model-dependent fields (raw base-240 decoded values) */
  field6: number;
  field7: number;
  field8: number;
  field9: number;
  field10: number;
  field11: number;
  field12: number;
  checksumValid: boolean;
}

/** Annotation, screenshot, or other metadata record */
export interface MetaRecord {
  t: string;
  mono: number;
  dir: 'note' | 'screenshot';
  raw: string;
  len: number;
}

export type TrafficRecord = TxPacketRecord | RxPacketRecord | MetaRecord;

export class Recorder {
  private fd: number;
  private filePath: string;
  private recordCount = 0;

  constructor(outputDir: string) {
    mkdirSync(outputDir, { recursive: true });

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d{3}Z$/, '');
    const filename = `${timestamp}.jsonl`;
    this.filePath = join(outputDir, filename);

    this.fd = openSync(this.filePath, 'a');
  }

  private append(record: TrafficRecord): void {
    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
    this.recordCount++;
  }

  /** Record a decoded TX packet */
  tx(frame: DecodedTxFrame): void {
    this.append({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'tx',
      raw: toHex(frame.raw).replace(/ /g, ''),
      len: frame.raw.length,
      cmd: frame.command,
      cmdName: frame.commandName,
      currentSetpoint: frame.currentSetpoint,
      cutoffVoltage: frame.cutoffVoltage,
      checksumValid: frame.checksumValid,
    });
  }

  /** Record a decoded RX packet */
  rx(frame: DecodedRxFrame): void {
    this.append({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'rx',
      raw: toHex(frame.raw).replace(/ /g, ''),
      len: frame.raw.length,
      state: frame.state,
      current: frame.current,
      voltage: frame.voltage,
      field6: frame.field6,
      field7: frame.field7,
      field8: frame.field8,
      field9: frame.field9,
      field10: frame.field10,
      field11: frame.field11,
      field12: frame.field12,
      checksumValid: frame.checksumValid,
    });
  }

  /** Record a user annotation */
  note(text: string): void {
    this.append({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'note',
      raw: text,
      len: 0,
    });
  }

  /** Record a screenshot capture */
  screenshot(filename: string, sizeBytes: number): void {
    this.append({
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'screenshot',
      raw: filename,
      len: sizeBytes,
    });
  }

  getPath(): string {
    return this.filePath;
  }

  getRecordCount(): number {
    return this.recordCount;
  }

  getDir(): string {
    return dirname(this.filePath);
  }

  close(): void {
    closeSync(this.fd);
  }
}
