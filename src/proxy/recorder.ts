/**
 * Traffic Recorder
 *
 * Records all serial traffic to a JSONL file with timestamps
 * for offline analysis. Each line is a self-contained record.
 */

import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FrameDirection } from '../protocol/types.ts';

export interface TrafficRecord {
  /** ISO 8601 wall clock timestamp */
  t: string;
  /** High-resolution monotonic timestamp in ms (from performance.now()) */
  mono: number;
  /** Direction: tx = host->device, rx = device->host, note = annotation, screenshot = camera capture */
  dir: FrameDirection | 'note' | 'screenshot';
  /** Hex string of raw bytes (traffic) or annotation text (note) */
  raw: string;
  /** Byte count (traffic) or 0 (note) */
  len: number;
}

export class Recorder {
  private fd: number;
  private filePath: string;
  private recordCount = 0;

  constructor(outputDir: string) {
    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    // Generate filename from current timestamp
    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d{3}Z$/, '');
    const filename = `${timestamp}.jsonl`;
    this.filePath = join(outputDir, filename);

    // Open file for append (create if not exists)
    this.fd = openSync(this.filePath, 'a');
  }

  /**
   * Record a traffic event. Writes immediately (synchronous) to avoid
   * data loss if the process crashes.
   */
  write(dir: FrameDirection, bytes: Uint8Array): void {
    const record: TrafficRecord = {
      t: new Date().toISOString(),
      mono: performance.now(),
      dir,
      raw: Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''),
      len: bytes.length,
    };

    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
    this.recordCount++;
  }

  /** Get the path to the recording file */
  getPath(): string {
    return this.filePath;
  }

  /** Get the number of records written */
  getRecordCount(): number {
    return this.recordCount;
  }

  /**
   * Record a user annotation / note. Timestamped alongside traffic so
   * the analyzer can correlate user actions with protocol events.
   */
  note(text: string): void {
    const record: TrafficRecord = {
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'note',
      raw: text,
      len: 0,
    };

    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
    this.recordCount++;
  }

  /**
   * Record a screenshot capture. The filename is relative to the
   * recording directory (screenshots are co-located with the JSONL).
   */
  screenshot(filename: string, sizeBytes: number): void {
    const record: TrafficRecord = {
      t: new Date().toISOString(),
      mono: performance.now(),
      dir: 'screenshot',
      raw: filename,
      len: sizeBytes,
    };

    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
    this.recordCount++;
  }

  /** Get the directory containing the recording file */
  getDir(): string {
    return dirname(this.filePath);
  }

  /** Close the recording file */
  close(): void {
    closeSync(this.fd);
  }
}
