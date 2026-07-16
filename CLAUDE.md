# Battery Controller — Claude Code Context

## What This Is

A replacement for ZKETech's "EB Tester" VB6 application. Controls ZKETech battery charger/dischargers (EBC-_) and electronic loads (EBD-_) over serial. The protocol is reverse-engineered; documentation is in `protocol.md`.

## Key Reference Files

| File                            | What's in it                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol.md`                   | **Full protocol spec** — frame format, base-240 encoding, checksums, command table, response layouts, state bytes, all 58 device models, divisors per family. Start here.                              |
| `src/protocol/constants.ts`     | TypeScript constants: `DeviceTable` (58 models), `EbcDivisors`, `Divisors`, `RxState`, frame tokens                                                                                                    |
| `src/protocol/codec.ts`         | Checksum (mod-240), base-240 encode/decode, frame parse/build/scan, TX/RX decoders (device-family-aware)                                                                                               |
| `src/protocol/types.ts`         | `DeviceFamily`, `ParsedFrame`, `DecodedRxFrame`, `DecodedTxFrame`                                                                                                                                      |
| `scripts/device-table.json`     | **Language-agnostic device table** — all 58 models with index, name, family. Also includes family divisors, state bytes, and known type codes. Python and other non-TypeScript tools should read this. |
| `scripts/fake-device/profiles/` | Fake device profiles — one per model we can simulate. Currently: `ebc-a40l`.                                                                                                                           |

## Protocol Essentials (quick reference)

- **Serial**: 9600 baud, 8 data bits, even parity, 1 stop bit
- **Frames**: `0xFA [payload] [checksum] 0xF8` — TX is 10 bytes, RX is 19 bytes
- **Checksum**: XOR of payload bytes, reduced `% 240` (base-240 safe)
- **Multi-byte values**: base-240 encoding (`hi * 240 + lo`), divided by a model-dependent divisor
- **Capacity encoding quirk**: At ~10 Ah, the EBC-A40L switches from 1 mAh/unit to 10 mAh/unit (hi byte jumps +99). Hosts must detect and correct this — see `src/server/capacity-tracker.ts`
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

### Mid-run setpoint changes (captured 2026-07-16, real A40L)

- **CMD 0x07 (Adjust) is the only working mechanism** — current follows within
  ~1 frame, capacity accumulator keeps counting. Confirmed for D-CC (~2.1 mΩ
  measured via the adjustment steps) AND C-CV during the CC phase (~2.2 mΩ).
  The IR probe uses it.
- CMD 0x08/0x28 (continue) and re-sent 0x01 (START) are **silently ignored**
  while a test runs; 0x08 from long-stopped idle is inert.
- **Pause→resume works**: 0x02 then 0x28 a few seconds later resumes a charge
  with the capacity accumulator preserved. See protocol.md for details.

### Open questions

- Info packet byte 14 → device name mapping (need captures from other models)
- Response bytes 8-9 purpose (always 0 on A40L)
- Error/protection state bytes

See `PLAN-protocol-exercise.md` for the full test checklist.
