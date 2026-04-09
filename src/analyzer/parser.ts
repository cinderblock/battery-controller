/**
 * JSONL Recording Parser
 *
 * Reads recorded JSONL files, reconstructs byte streams per direction,
 * and extracts complete frames with timestamps.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { decodeRxFrame, decodeTxFrame, fromHex, parseFrame, scanForFrames } from '../protocol/codec.ts';
import { RxPacketLength, TxPacketLength } from '../protocol/constants.ts';
import type { DecodedRxFrame, DecodedTxFrame, FrameDirection } from '../protocol/types.ts';
import type { TrafficRecord } from '../proxy/recorder.ts';

/** A frame with its associated timestamps from the recording */
export interface TimestampedFrame {
  /** ISO 8601 of the record containing the first byte of this frame */
  startTime: string;
  /** ISO 8601 of the record containing the last byte */
  endTime: string;
  /** Monotonic start time (ms) */
  monoStart: number;
  /** Monotonic end time (ms) */
  monoEnd: number;
  /** Direction */
  direction: FrameDirection;
  /** Decoded frame */
  decoded: DecodedRxFrame | DecodedTxFrame;
}

/** A user annotation from the recording */
export interface TimestampedNote {
  /** ISO 8601 timestamp */
  time: string;
  /** Monotonic timestamp (ms) */
  mono: number;
  /** Annotation text */
  text: string;
}

/** A screenshot capture from an RTSP camera */
export interface TimestampedScreenshot {
  /** ISO 8601 timestamp */
  time: string;
  /** Monotonic timestamp (ms) */
  mono: number;
  /** Screenshot filename (relative to recording directory) */
  filename: string;
  /** File size in bytes */
  sizeBytes: number;
}

/** Union type for all events in a recording timeline */
export type TimelineEvent =
  | { type: 'frame'; data: TimestampedFrame }
  | { type: 'note'; data: TimestampedNote }
  | { type: 'screenshot'; data: TimestampedScreenshot };

/** Summary statistics for a recording */
export interface RecordingSummary {
  totalRecords: number;
  totalBytes: number;
  txFrames: number;
  rxFrames: number;
  notes: number;
  screenshots: number;
  checksumErrors: number;
  durationMs: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

/**
 * Stream-parse a JSONL file and extract all timestamped frames and notes.
 * Handles large files efficiently by processing line-by-line.
 * Returns a timeline of events in chronological order.
 */
export async function parseRecording(filePath: string): Promise<{
  frames: TimestampedFrame[];
  timeline: TimelineEvent[];
  summary: RecordingSummary;
}> {
  const frames: TimestampedFrame[] = [];
  const timeline: TimelineEvent[] = [];

  // Per-direction state for stream reassembly
  const streams: Record<
    FrameDirection,
    {
      buffer: Uint8Array;
      records: Array<{ t: string; mono: number; byteStart: number; byteEnd: number }>;
    }
  > = {
    tx: { buffer: new Uint8Array(0), records: [] },
    rx: { buffer: new Uint8Array(0), records: [] },
  };

  let totalRecords = 0;
  let totalBytes = 0;
  let checksumErrors = 0;
  let firstTimestamp = '';
  let lastTimestamp = '';

  // Read file line by line
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let record: TrafficRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    totalRecords++;
    totalBytes += record.len;

    if (!firstTimestamp) firstTimestamp = record.t;
    lastTimestamp = record.t;

    // Handle annotations
    if (record.dir === 'note') {
      const note: TimestampedNote = { time: record.t, mono: record.mono, text: record.raw };
      timeline.push({ type: 'note', data: note });
      continue;
    }

    // Handle screenshots
    if (record.dir === 'screenshot') {
      const screenshot: TimestampedScreenshot = {
        time: record.t,
        mono: record.mono,
        filename: record.raw,
        sizeBytes: record.len,
      };
      timeline.push({ type: 'screenshot', data: screenshot });
      continue;
    }

    const dir = record.dir as FrameDirection;
    const stream = streams[dir];
    const bytes = fromHex(record.raw);

    // Track byte positions for timestamp association
    const byteStart = stream.buffer.length;
    const byteEnd = byteStart + bytes.length;
    stream.records.push({ t: record.t, mono: record.mono, byteStart, byteEnd });

    // Append to stream buffer
    const combined = new Uint8Array(stream.buffer.length + bytes.length);
    combined.set(stream.buffer);
    combined.set(bytes, stream.buffer.length);
    stream.buffer = combined;

    // Scan for complete frames
    const expectedLength = dir === 'rx' ? RxPacketLength : TxPacketLength;
    const result = scanForFrames(stream.buffer, expectedLength);

    if (result.frames.length > 0) {
      // Calculate how many bytes were consumed
      const consumedBytes = stream.buffer.length - result.remainder.length;
      let consumedSoFar = 0;

      for (const raw of result.frames) {
        const frameStart = consumedSoFar;
        const frameEnd = consumedSoFar + raw.length;
        consumedSoFar += raw.length;

        const parsed = parseFrame(raw, dir);
        if (!parsed) continue;

        if (!parsed.checksumValid) checksumErrors++;

        // Find timestamps for this frame's byte range
        const startRecord = stream.records.find(r => r.byteStart <= frameStart && r.byteEnd > frameStart);
        const endRecord = stream.records.find(r => r.byteStart < frameEnd && r.byteEnd >= frameEnd);

        const decoded = dir === 'rx' ? decodeRxFrame(parsed) : decodeTxFrame(parsed);

        const tsFrame: TimestampedFrame = {
          startTime: startRecord?.t ?? record.t,
          endTime: endRecord?.t ?? record.t,
          monoStart: startRecord?.mono ?? record.mono,
          monoEnd: endRecord?.mono ?? record.mono,
          direction: dir,
          decoded,
        };
        frames.push(tsFrame);
        timeline.push({ type: 'frame', data: tsFrame });
      }

      // Update buffer and records to account for consumed bytes
      stream.buffer = result.remainder;

      // Adjust record byte positions
      stream.records = stream.records
        .filter(r => r.byteEnd > consumedBytes)
        .map(r => ({
          ...r,
          byteStart: Math.max(0, r.byteStart - consumedBytes),
          byteEnd: r.byteEnd - consumedBytes,
        }));
    }
  }

  // Calculate duration
  let durationMs = 0;
  if (firstTimestamp && lastTimestamp) {
    durationMs = new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  }

  const txFrames = frames.filter(f => f.direction === 'tx').length;
  const rxFrames = frames.filter(f => f.direction === 'rx').length;
  const noteCount = timeline.filter(e => e.type === 'note').length;
  const screenshotCount = timeline.filter(e => e.type === 'screenshot').length;

  return {
    frames,
    timeline,
    summary: {
      totalRecords,
      totalBytes,
      txFrames,
      rxFrames,
      notes: noteCount,
      screenshots: screenshotCount,
      checksumErrors,
      durationMs,
      firstTimestamp,
      lastTimestamp,
    },
  };
}
