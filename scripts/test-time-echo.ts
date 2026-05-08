/**
 * Quick test: Send D-CC with time > 240 minutes to check if RX bytes 14-15
 * are a base-240 pair (hypothesis: byte 14 = hi, byte 15 = lo).
 *
 * Connects directly to the TCP bridge on the Pi, sends D-CC start (1A, 2.80V cutoff, 300 min),
 * reads a few RX frames to check the echo, then sends stop.
 */

import { connect } from 'net';
import { buildTxFrame, encodeBase240, parseFrame, decodeRxFrame } from '../src/protocol/codec.ts';
import { RxPacketLength, StartToken, EndToken } from '../src/protocol/constants.ts';

const HOST = process.argv[2] || 'coulomb';
const PORT = 49600;
const TEST_TIME_MINUTES = parseInt(process.argv[3] || '480'); // > 240, so base240 hi byte should be non-zero

// Build D-CC start command: CMD 0x01, current=1A, cutoff=2.80V, time=300min
// TX payload: [cmd, currentHi, currentLo, cutoffHi, cutoffLo, timeHi, timeLo, 0x00]
const currentRaw = encodeBase240(1, 100);    // 1A * 100 = 100 → [0, 100]
const cutoffRaw = encodeBase240(2.80, 100);  // 2.80V * 100 = 280 → [1, 40]
const timeRaw = encodeBase240(TEST_TIME_MINUTES, 1); // 300 → [1, 60]

const startPayload = new Uint8Array([
  0x01,           // CMD: D-CC start
  currentRaw[0], currentRaw[1],
  cutoffRaw[0], cutoffRaw[1],
  timeRaw[0], timeRaw[1],
]);

const stopPayload = new Uint8Array([
  0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // CMD: stop
]);

const startFrame = buildTxFrame(startPayload);
const stopFrame = buildTxFrame(stopPayload);

console.log(`Connecting to ${HOST}:${PORT}...`);
console.log(`D-CC start frame: ${Buffer.from(startFrame).toString('hex')}`);
console.log(`Expected time encoding: base240(${TEST_TIME_MINUTES}) = [${timeRaw[0]}, ${timeRaw[1]}] = [0x${timeRaw[0].toString(16).padStart(2,'0')}, 0x${timeRaw[1].toString(16).padStart(2,'0')}]`);
console.log(`If bytes 14-15 are a base240 pair, we expect: byte14=0x${timeRaw[0].toString(16).padStart(2,'0')}, byte15=0x${timeRaw[1].toString(16).padStart(2,'0')}`);
console.log(`If byte 14 is "step number" (always 0), we expect: byte14=0x00, byte15=???`);
console.log('');

const initPayload = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const initFrame = buildTxFrame(initPayload);

const socket = connect(PORT, HOST, () => {
  console.log('Connected. Sending init then D-CC start...');
  socket.write(initFrame);
  // Wait for device to respond to init before sending start
  setTimeout(() => {
    console.log('Sending D-CC start...');
    socket.write(startFrame);
  }, 1500);
});

let rxBuf = Buffer.alloc(0);
let frameCount = 0;
const MAX_FRAMES = 6; // Capture a few frames then stop

socket.on('data', (chunk: Buffer) => {
  rxBuf = Buffer.concat([rxBuf, chunk]);

  // Scan for complete RX frames
  while (rxBuf.length >= RxPacketLength) {
    const startIdx = rxBuf.indexOf(StartToken);
    if (startIdx < 0) { rxBuf = Buffer.alloc(0); break; }
    if (startIdx > 0) { rxBuf = rxBuf.slice(startIdx); continue; }
    if (rxBuf.length < RxPacketLength) break;

    const frameBytes = rxBuf.slice(0, RxPacketLength);
    rxBuf = rxBuf.slice(RxPacketLength);

    if (frameBytes[RxPacketLength - 1] !== EndToken) {
      // Not a valid frame end, skip this start byte
      rxBuf = Buffer.concat([frameBytes.slice(1), rxBuf]);
      continue;
    }

    frameCount++;
    const raw = Buffer.from(frameBytes).toString('hex');
    const byte14 = frameBytes[14];
    const byte15 = frameBytes[15];
    const state = frameBytes[1];

    console.log(`RX #${frameCount}: state=0x${state.toString(16).padStart(2,'0')} byte14=0x${byte14.toString(16).padStart(2,'0')} byte15=0x${byte15.toString(16).padStart(2,'0')} → base240 pair = ${byte14 * 240 + byte15} raw=${raw}`);

    // Also decode fully
    const parsed = parseFrame(new Uint8Array(frameBytes), 'rx');
    if (parsed) {
      const decoded = decodeRxFrame(parsed, 'ebc');
      console.log(`       decoded: I=${decoded.current}A V=${decoded.voltage}V state=${decoded.state} field10=${decoded.field10} field11=${decoded.field11}`);
    }

    if (frameCount >= MAX_FRAMES) {
      console.log('\nSending STOP...');
      socket.write(stopFrame);
      setTimeout(() => {
        console.log('Done. Closing.');
        socket.end();
        process.exit(0);
      }, 2000);
      return;
    }
  }
});

socket.on('error', (err) => {
  console.error('Socket error:', err.message);
  process.exit(1);
});

socket.on('close', () => {
  console.log('Connection closed.');
});
