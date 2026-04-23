# Battery Controller — Claude Code Context

## What This Is

A replacement for ZKETech's "EB Tester" VB6 application. Controls ZKETech battery charger/dischargers (EBC-*) and electronic loads (EBD-*) over serial. The protocol is reverse-engineered; documentation is in `protocol.md`.

## Key Reference Files

| File | What's in it |
|------|-------------|
| `protocol.md` | **Full protocol spec** — frame format, base-240 encoding, checksums, command table, response layouts, state bytes, all 58 device models, divisors per family. Start here. |
| `src/protocol/constants.ts` | TypeScript constants: `DeviceTable` (58 models), `EbcDivisors`, `Divisors`, `RxState`, frame tokens |
| `src/protocol/codec.ts` | Checksum (mod-240), base-240 encode/decode, frame parse/build/scan, TX/RX decoders (device-family-aware) |
| `src/protocol/types.ts` | `DeviceFamily`, `ParsedFrame`, `DecodedRxFrame`, `DecodedTxFrame` |
| `scripts/device-table.json` | **Language-agnostic device table** — all 58 models with index, name, family. Also includes family divisors, state bytes, and known type codes. Python and other non-TypeScript tools should read this. |
| `scripts/fake-device/profiles/` | Fake device profiles — one per model we can simulate. Currently: `ebc-a40l`. |

## Protocol Essentials (quick reference)

- **Serial**: 9600 baud, 8 data bits, even parity, 1 stop bit
- **Frames**: `0xFA [payload] [checksum] 0xF8` — TX is 10 bytes, RX is 19 bytes
- **Checksum**: XOR of payload bytes, reduced `% 240` (base-240 safe)
- **Multi-byte values**: base-240 encoding (`hi * 240 + lo`), divided by a model-dependent divisor
- **Two device families**:
  - `ebc` (charger/discharger): current ÷100, idle state 0x02
  - `ebd` (electronic load): current ÷10,000, idle state 0x00
- **Device identification**: After CMD 0x05 (init), device sends alternating info packets (state + 0x64). Byte 14 = type code, byte 15 = subtype. Mapping from type code to device name is incomplete — only `0x11,0x86 → EBC-A40L` confirmed.
- **Auto-detect family**: First RX packet's state byte: `0x00` = EBD, `0x02` = EBC.

## Architecture

```
scripts/
├── fake-device/     # Synthetic device (TypeScript) — emulates serial protocol
│   └── profiles/    # Per-model configs (divisors, state bytes, identity)
├── ui-driver/       # pywinauto wrapper (Python) — controls VB6 GUI
└── device-table.json  # 58 devices, JSON, for Python/agents

src/
├── protocol/        # Shared codec library (zero Node.js deps)
├── server/          # Pi backend (serial + HTTP + WebSocket)
├── proxy/           # Windows dev proxy (COM ↔ TCP, JSONL recorder)
├── analyzer/        # Offline JSONL traffic analyzer
├── correlator/      # Packet ↔ screenshot correlator
└── frontend/        # React web GUI

recordings/          # JSONL serial captures from proxy sessions
```

## Current State (April 2026)

### Confirmed by serial capture (EBC-A40L)
- C-CV charge: full cycle including charge-complete state (0x16)
- D-CC discharge: state 0x0A confirmed, capacity in bytes 6-7
- Init/handshake, heartbeat, stop command
- Checksum mod-240 wrapping

### Not yet captured
- D-CP discharge (constant power)
- Other charge chemistries (C-LiPo, C-NiMH, etc.)
- Error/disconnect states
- Step/cycle tests
- Mid-test setpoint changes (CMD 0x08 continue)

### Open questions
- Info packet byte 14 → device name mapping (need captures from other models)
- Response bytes 8-9 purpose (always 0 on A40L)
- Error/protection state bytes

See `PLAN-protocol-exercise.md` for the full test checklist.
