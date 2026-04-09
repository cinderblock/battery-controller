# Implementation Plan: Serial Dev Proxy & Traffic Recorder

## Goal

Intercept all serial traffic between the EB Tester Windows VB6 app and a ZKETech battery charger/discharger to fully map the protocol for charger models (EBC-*). The EB Tester connects to a virtual COM port on Windows; a proxy forwards traffic over TCP to the Raspberry Pi (`coulomb`) which has the physical serial connection. All traffic is recorded with timestamps for offline analysis.

## Architecture

```
EB Tester VB6 App
    │
    │ opens COMxx (virtual port)
    │
[com0com null-modem pair: COMxx ↔ COMxx+1]
    │
    │ proxy opens COMxx+1
    ▼
┌─────────────────────────────┐
│  Windows Proxy              │
│  src/proxy/index.ts         │
│  - Bridges COM ↔ TCP        │
│  - Records ALL bytes to     │
│    JSONL with timestamps    │
│  - Live frame decode to     │
│    console                  │
└─────────────┬───────────────┘
              │ TCP to coulomb:49600
              ▼
┌─────────────────────────────┐
│  Pi TCP-Serial Bridge       │
│  src/server/tcp-bridge.ts   │
│  - Transparent byte pipe    │
│  - TCP ↔ /dev/serial0       │
│  - No frame parsing         │
└─────────────┬───────────────┘
              │ 9600 8E1
              ▼
        ZKETech Device
```

## Existing Code to Leverage

The project already has significant infrastructure. Reference these exact files:

| What exists | Where | What we reuse |
|---|---|---|
| Serial port open/configure (stty 9600 8E1) | `src/server/serial.ts` lines 65-88 (`connect()`) | Pi bridge reuses `configurePort()` and raw file I/O |
| Frame constants (StartToken=0xFA, EndToken=0xF8, RxPacketLength=19, TxPacketLength=10) | `src/server/serial.ts` lines 46-50 | Shared protocol library |
| Checksum (XOR reduce) | `src/server/serial.ts` lines 322-324 | Shared protocol library |
| Packet parsing (start/end scan, checksum validation) | `src/server/serial.ts` lines 134-174 (`parseBuffer`, `parsePacket`) | Shared protocol library |
| Format-string decoder for RX/TX payloads | `src/run/decode.ts` lines 21-22 (`FORMAT_RX`, `FORMAT_TX`) | Analyzer |
| Build system (Bun.build, in-memory bundling) | `src/run/build.ts` lines 84-159 | Extend for proxy build target |
| Deploy pipeline (SSH to coulomb, systemd service) | `src/run/deploy.ts`, `src/run/setup.ts` | Deploy bridge mode to Pi |
| Config constants | `src/run/config.ts` lines 1-20 | Add bridge TCP port |
| State types (ConnectionChain, SerialMessage) | `src/server/state.ts` lines 11-50 | Reference design for recorder types |

## Steps

### Step 1: Create shared protocol library (`src/protocol/`)

Extract protocol constants and codec from `src/server/serial.ts` and `src/run/decode.ts` into a shared module that all components import.

**Create `src/protocol/constants.ts`:**
```typescript
export const StartToken = 0xfa;
export const EndToken = 0xf8;
export const RxPacketLength = 19;  // device → host (START + 16 data + checksum + END)
export const TxPacketLength = 10;  // host → device (START + 7 data + checksum + END)
export const RxPayloadLength = 16; // data bytes inside RX frame
export const TxPayloadLength = 7;  // data bytes inside TX frame
export const Base240Modulus = 240;
```

**Create `src/protocol/codec.ts`:**
```typescript
// XOR checksum — extracted from serial.ts line 322-324
export function checksum(data: Uint8Array | Buffer): number;

// Base-240 encode/decode — from protocol.md
export function encodeBase240(value: number, divisor: number): [hi: number, lo: number];
export function decodeBase240(hi: number, lo: number, divisor: number): number;

// Frame building — extracted from serial.ts sendPacket() lines 227-238
export function buildTxFrame(payload: Uint8Array): Uint8Array;

// Frame parsing — extracted from serial.ts parsePacket() lines 150-174
export function parseFrame(raw: Uint8Array): ParsedFrame | null;

// Stream frame scanner — extracted from serial.ts parseBuffer() lines 134-143
export function scanForFrames(buffer: Uint8Array, expectedLength: number): { frames: Uint8Array[]; remainder: Uint8Array };
```

**Create `src/protocol/types.ts`:**
```typescript
export interface ParsedFrame {
  raw: Uint8Array;
  direction: "tx" | "rx";
  command: number;       // byte 1
  payload: Uint8Array;   // data bytes (between start/end, excluding checksum)
  checksum: number;
  checksumValid: boolean;
}

export interface DecodedRxFrame extends ParsedFrame {
  direction: "rx";
  state: number;
  current: number;      // A
  voltage: number;      // V
  field6: number;       // raw base-240 value (D+ or temp depending on model)
  field7: number;       // raw base-240 value (D- or unknown)
  field8: number;
  field9: number;
  field10: number;
  field11: number;
}

export interface DecodedTxFrame extends ParsedFrame {
  direction: "tx";
  commandName: string;
  currentSetpoint?: number;
  cutoffVoltage?: number;
}
```

**Then refactor** `src/server/serial.ts` to `import { StartToken, EndToken, ... } from "../protocol/constants"` and `import { checksum, parseFrame } from "../protocol/codec"`. Remove duplicated definitions. Run existing build to confirm nothing breaks.

### Step 2: Pi TCP-Serial Bridge (`src/server/tcp-bridge.ts`)

A new mode for the Pi server: a transparent TCP-to-serial byte pipe. No frame parsing, no WebSocket server — just raw bytes forwarded bidirectionally.

**Create `src/server/tcp-bridge.ts`:**

```typescript
// Opens /dev/serial0 using the same stty + fs approach as serial.ts connect()
// Listens on TCP port (default 49600) using Bun.listen()
// Accepts one client at a time; rejects additional connections with a log warning
// Bidirectional forwarding:
//   TCP data → serial write (immediate, no buffering)
//   Serial read → TCP send (immediate, no buffering)
// On TCP disconnect: optionally send 0x06 (stop) to device
// On serial error: close TCP connection
```

The bridge must NOT parse or buffer frames. If serial produces 3 bytes, those 3 bytes go to TCP immediately, preserving timing fidelity.

**Modify `src/server/index.ts`:**

Add a startup mode check at the top of `main()`:

```typescript
if (process.argv.includes("--bridge") || process.env.MODE === "bridge") {
  await startTcpBridge();
  return;
}
// ... existing server code
```

**Add to `src/run/config.ts`:**
```typescript
export const BridgeTcpPort = 49600; // Private range — avoids IANA-assigned port 9600 (MicroMuse)
```

**Modify `src/run/setup.ts`:**

Add a third systemd service `battery-controller-bridge.service` that runs in bridge mode:
```ini
ExecStart=/home/pi/.bun/bin/bun /opt/battery-controller --bridge
Conflicts=battery-controller.service battery-controller-dev.service
```

**Test:** Deploy to Pi, start bridge service, connect with `nc coulomb 49600` and verify bytes flow to/from the serial port.

### Step 3: Windows Proxy with Recording (`src/proxy/`)

The proxy runs on Windows under Bun. It bridges a virtual COM port (com0com) to the Pi over TCP, recording all traffic.

**Prerequisites:**
- Install com0com (signed build from https://pete.akeo.ie/2011/07/com0com-signed-drivers.html) — creates COM port pair (e.g., COM10 ↔ COM11). EB Tester opens COM10, proxy opens COM11.
- If com0com requires test-signing: `bcdedit /set testsigning on` and reboot.

**Add dependency to `package.json`:**
```json
"serialport": "^12.0.0"
```

If `serialport` doesn't work under Bun on Windows, fallback to Bun FFI calling Windows `CreateFile("\\\\.\COMxx")` / `ReadFile` / `WriteFile`.

**Create `src/proxy/index.ts`:**

Main entry point. Orchestrates all three connections:

```typescript
// 1. Parse config from CLI args or .env
//    --com COM11          (virtual COM port, our side)
//    --host coulomb       (Pi hostname)
//    --port 49600         (Pi TCP bridge port)
//    --log recordings/    (output directory)

// 2. Open virtual COM port at 9600 8E1 using serialport package

// 3. Connect to Pi via TCP using Bun.connect()

// 4. Create Recorder (JSONL file in --log dir)

// 5. Wire up bidirectional forwarding:
//    COM port data → record("tx") → TCP send to Pi
//    TCP data from Pi → record("rx") → COM port write
//    (tx = host→device direction, rx = device→host)

// 6. Optional: parse frames in real-time for console display
//    Import scanForFrames from src/protocol/codec
//    Maintain separate rx/tx buffers
//    When complete frame found, decode and print

// 7. Handle errors and graceful shutdown (Ctrl+C)
//    On TCP disconnect: log loudly, do NOT auto-reconnect (could confuse
//    EB Tester mid-command). User restarts the proxy manually.
//    Each proxy run produces exactly one JSONL file with clean session boundaries.
```

**Create `src/proxy/recorder.ts`:**

```typescript
export interface TrafficRecord {
  t: string;        // ISO 8601 wall clock
  mono: number;     // high-resolution monotonic timestamp (ms, from performance.now())
  dir: "tx" | "rx"; // tx = EB Tester → device, rx = device → EB Tester
  raw: string;      // hex string of raw bytes
  len: number;      // byte count
}

export class Recorder {
  // Opens file: recordings/YYYY-MM-DDTHH-mm-ss.jsonl
  // write(dir, bytes): appends TrafficRecord as JSON line, flushes immediately
  // close(): flushes and closes file
  // getPath(): returns the log file path
}
```

**Create `src/proxy/serial-port.ts`:**

Wrapper around the `serialport` npm package for Windows COM port access:

```typescript
export class VirtualComPort {
  constructor(portPath: string, baudRate: number);
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(callback: (data: Buffer) => void): void;
}
```

**Console output while running:**

The proxy should print a live view of decoded traffic to the console:

```
[14:30:00.123] TX  10 bytes  CMD=0x05 (init)        fa 05 00 00 00 00 00 00 05 f8
[14:30:00.250] RX  19 bytes  STATE=0x0a (load ON)    V=12.345  I=1.0000A  fa 0a 00 29 ...
[14:30:02.251] RX  19 bytes  STATE=0x0a (load ON)    V=12.340  I=1.0000A  fa 0a 00 29 ...
[14:30:04.123] TX  10 bytes  CMD=0x01 (load start)   I=2.000A cutoff=3.00V
```

This uses `scanForFrames` from `src/protocol/codec.ts` to reconstruct frames from the raw byte stream, and field decoders from `src/protocol/codec.ts` to show human-readable values.

**New `package.json` script:**
```json
"proxy": "bun run src/proxy/index.ts"
```

**Usage:**
```bash
bun run proxy -- --com COM11 --host coulomb
```

### Step 4: Offline Analyzer (`src/analyzer/`)

CLI tool that reads recorded JSONL files, reconstructs and decodes all frames, and produces annotated output.

**Create `src/analyzer/index.ts`:**

```typescript
// CLI entry point
// Usage:
//   bun run analyze <file.jsonl>                    # decode all frames
//   bun run analyze --filter tx <file.jsonl>        # only host→device
//   bun run analyze --filter rx <file.jsonl>        # only device→host
//   bun run analyze --raw <file.jsonl>              # show raw hex only
//   bun run analyze --unknown <file.jsonl>          # highlight unknown fields
//   bun run analyze --annotate <annotations.jsonl> <file.jsonl>  # merge annotations
//   bun run analyze --summary <file.jsonl>          # frame counts, timing stats
//   bun run analyze --diff <file1.jsonl> <file2.jsonl>  # compare sessions (future enhancement)
```

**Create `src/analyzer/parser.ts`:**

```typescript
// Reads JSONL line by line (streaming, handles large files)
// Reconstructs two byte streams (tx and rx) from TrafficRecord entries
// Scans each stream for 0xFA..0xF8 frames using scanForFrames()
// Associates each frame with its timestamp range
// Returns an array of TimestampedFrame objects

export interface TimestampedFrame {
  startTime: string;   // ISO 8601 of first byte
  endTime: string;     // ISO 8601 of last byte
  monoStart: number;
  monoEnd: number;
  frame: ParsedFrame;  // from src/protocol/types.ts
  decoded: DecodedRxFrame | DecodedTxFrame;
}
```

**Create `src/analyzer/formatter.ts`:**

```typescript
// Table output with columns:
//   Time | Dir | Len | Cmd/State | Decoded Fields | Raw Hex
// Color coding:
//   TX = cyan, RX = green
//   Checksum errors = red
//   Unknown command bytes = yellow
// Supports --unknown mode: highlights fields that don't match known patterns
//   This is the key feature for discovering what the EBC charger models
//   send differently from the documented EBD-USB+ protocol
```

**New `package.json` script:**
```json
"analyze": "bun run src/analyzer/index.ts"
```

### Step 5: com0com Setup Documentation

Add a section to `Developer.md` with setup instructions:

1. Download signed com0com from https://pete.akeo.ie/2011/07/com0com-signed-drivers.html
2. Install, create a COM port pair (e.g., COM10 ↔ COM11)
3. Configure EB Tester to use COM10
4. Run proxy with `--com COM11`
5. Alternative: if com0com won't install, use com2tcp from the com0com package (eliminates virtual COM ports entirely — but requires the EB Tester to support TCP, which it does via its `modSocketMaster` module)

## Recording Format

Each JSONL line is a self-contained record:

```jsonl
{"t":"2026-04-08T14:30:00.123Z","mono":45678.123,"dir":"tx","raw":"fa050000000000000005f8","len":10}
{"t":"2026-04-08T14:30:00.250Z","mono":45678.250,"dir":"rx","raw":"fa0a002900c1d000000000000a000000000ad3f8","len":19}
```

- `t`: ISO 8601 wall clock (for human readability and cross-referencing with EB Tester UI actions)
- `mono`: `performance.now()` monotonic milliseconds (for precise inter-packet timing)
- `dir`: `tx` = host→device (EB Tester sending command), `rx` = device→host (device sending data)
- `raw`: hex string of raw bytes as received (may be partial frames — the analyzer handles reassembly)
- `len`: byte count

## File Structure After Implementation

```
battery-controller/
  src/
    protocol/                  # NEW — shared protocol library
      constants.ts
      codec.ts
      types.ts
    server/                    # MODIFIED
      index.ts                 # Add --bridge mode dispatch
      serial.ts                # Refactor to import from protocol/
      tcp-bridge.ts            # NEW — TCP ↔ serial byte pipe
      state.ts                 # Unchanged
    proxy/                     # NEW — Windows-side proxy
      index.ts                 # Main entry, wires COM ↔ TCP ↔ recorder
      recorder.ts              # JSONL traffic recorder
      serial-port.ts           # Windows COM port wrapper
    analyzer/                  # NEW — offline analysis
      index.ts                 # CLI entry
      parser.ts                # JSONL reader + frame reconstructor
      formatter.ts             # Colored table output
    run/                       # MODIFIED
      config.ts                # Add BridgeTcpPort
      build.ts                 # Add proxy build target (if needed)
      setup.ts                 # Add bridge systemd service
      deploy.ts                # Unchanged (deploys bridge too)
      decode.ts                # Refactor to import from protocol/
    frontend/                  # Unchanged
    utils/                     # Unchanged
  recordings/                  # NEW — gitignored log directory
  PLAN-dev-proxy.md            # This file
```

## Implementation Order

1. **`src/protocol/`** — Foundation. Refactor serial.ts and decode.ts to use it. Verify existing `bun run build` still works.
2. **`src/server/tcp-bridge.ts`** — Pi bridge. Deploy with `bun run start`. Test with `nc coulomb 9600`.
3. **`src/proxy/`** — Windows proxy. Install com0com first. Test end-to-end with EB Tester.
4. **`src/analyzer/`** — Offline tool. Can be built in parallel with step 3 using sample JSONL data.
5. **Developer.md** — Update with com0com setup instructions and proxy usage.

## Verification

After all steps are complete, verify the full chain:

1. Start bridge on Pi: `sudo systemctl start battery-controller-bridge`
2. Start proxy on Windows: `bun run proxy -- --com COM11 --host coulomb`
3. Open EB Tester, select COM10, connect to device
4. Perform operations: connect, start D-CC discharge, start C-NiMh charge, calibrate, etc.
5. Stop EB Tester
6. Analyze recording: `bun run analyze recordings/<latest>.jsonl`
7. Compare RX frame fields against protocol.md — identify which bytes carry temperature, charge mode, etc.
