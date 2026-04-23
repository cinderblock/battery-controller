# Synthetic exploration harness

Tools for reverse-engineering the EB Tester VB6 UI _without real hardware_.

Two pieces, designed to be driven by an LLM (Claude) via simple HTTP:

1. **`fake-device/`** — a synthetic ZKETech device. Opens a virtual COM port on
   Windows (via `ghostcom`) that the VB6 app connects to. Emulates the EBC /
   EBD serial protocol based on what we know from `protocol.md`. Exposes an
   HTTP control API so an external driver (human or LLM) can observe what the
   app sent, mutate the device's state, and inject arbitrary bytes to probe
   how the app reacts.
2. **`ui-driver/`** — a thin [pywinauto](https://pywinauto.readthedocs.io/)
   wrapper (Python + FastAPI) that lets the same driver enumerate controls
   in the VB6 app, click buttons, read labels, and screenshot the window.

Together they close the loop: the driver clicks a button, the fake device
records what bytes were sent, the driver reads the UI reaction, repeat.

## Architecture

```
                ┌──────────────────────────────────────────┐
                │              Windows host                │
                │                                          │
  ┌────────┐    │    ┌──────────┐      ┌─────────────┐     │
  │ Claude │◄───┼───►│ Control  │◄────►│ FakeDevice  │     │
  │ (or    │    │    │ HTTP API │      │  state +    │     │
  │  you)  │    │    │ (SSE log)│      │  response   │     │
  └────┬───┘    │    │ :49700   │      │  generator  │     │
       │        │    └──────────┘      └──────┬──────┘     │
       │        │                             │            │
       │        │                             │ Uint8Array │
       │        │                             ▼            │
       │        │                      ┌─────────────┐     │
       │        │                      │ ghostcom    │     │
       │        │                      │ VirtualPort │     │
       │        │                      │ (COM11…)    │     │
       │        │                      └──────┬──────┘     │
       │        │                             │            │
       │        │                             ▼            │
       │        │                       ┌───────────┐      │
       │        │                       │ VB6 app   │      │
       │        │                       │ EBTester  │      │
       │        │                       │ MSComm1   │      │
       │        │                       └─────┬─────┘      │
       │        │                             │            │
       │        │    ┌──────────┐             │ UIA        │
       └────────┼───►│ pywinauto│◄────────────┘            │
                │    │ driver   │                          │
                │    │ :49701   │                          │
                │    └──────────┘                          │
                └──────────────────────────────────────────┘
```

No Pi, no real device. Everything is synthetic.

## Device reference data

**`device-table.json`** — all 58 supported ZKETech models (22 EBC chargers,
36 EBD loads) with index, name, and family. Also includes per-family
divisors, state byte values, and known info-packet type codes. This is the
language-agnostic source of truth for Python scripts and LLM agents. The
canonical TypeScript version is `src/protocol/constants.ts → DeviceTable`.

## Quickstart

```bash
# 1. Start the fake device (opens a virtual COM port, prints its name)
bun run fake-device

# 2. In EB Tester: set COM port to whatever was printed, click "Start" / connect.

# 3. Inspect what's happening from another shell:
curl http://localhost:49700/state
curl http://localhost:49700/log?limit=20

# 4. Mutate the fake device's state to see how the UI reacts:
curl -X PATCH http://localhost:49700/state \
  -H 'content-type: application/json' \
  -d '{"voltage": 4.15, "current": 1.23, "mode": "charging"}'

# 5. Send arbitrary bytes to probe unknown response layouts:
curl -X POST http://localhost:49700/inject \
  -H 'content-type: application/json' \
  -d '{"hex": "fa02000000000000000000000000010a00f8"}'
```

## Fake device CLI

```
bun run fake-device [--com N] [--profile NAME] [--api-port N] [--log-dir DIR] [--quiet]

  --com N           Virtual COM port number (default: 2, falls back through 9)
                    EB Tester only accepts COM2..COM9 — don't go outside this range.
  --profile NAME    Device profile (default: ebc-a40l)
                    Available: ebc-a40l
  --api-port N      HTTP control API port (default: 49700)
  --log-dir DIR     Record traffic to this dir as JSONL (default: no recording)
                    If set, produces a file compatible with the existing
                    src/analyzer parser.
  --quiet           Don't print TX/RX frames to stdout
```

## HTTP control API

All responses are JSON. POST/PATCH bodies are JSON.

| Method | Path                      | Purpose                                                      |
|--------|---------------------------|--------------------------------------------------------------|
| GET    | `/`                       | Summary: profile, com port, api port, uptime, frame counts. |
| GET    | `/state`                  | Full device state.                                           |
| PATCH  | `/state`                  | Merge partial updates into device state.                    |
| POST   | `/reset`                  | Reset device state to profile defaults (idle).              |
| GET    | `/log?limit=N`            | Last N frame log entries (default 50).                      |
| GET    | `/log/stream`             | Server-sent events: one JSON entry per frame / state change. |
| POST   | `/inject`                 | `{hex}` — send one raw RX frame to the app right now.        |
| POST   | `/respond/to/:cmd`        | `{hex}` — when app sends TX with command byte `:cmd`, reply with this frame instead of the default. `:cmd` is decimal or 0x-prefixed hex. |
| DELETE | `/respond/to/:cmd`        | Clear an override.                                           |
| GET    | `/respond/overrides`      | List current overrides.                                      |
| POST   | `/note`                   | `{text}` — append a timestamped note to the log.            |

### State shape

```ts
{
  mode: 'idle' | 'charging' | 'discharging' | 'complete' | 'fault',
  current: number,          // A (instantaneous, what the device reports)
  voltage: number,          // V
  capacity: number,         // mAh (device-accumulated on EBC family)
  currentSetpoint: number,  // A (echoed back in RX bytes 10-11)
  voltageSetpoint: number,  // V (echoed back in RX bytes 12-13)
  cutoffCurrent: number,    // A (echoed back in RX byte 15)
  step: number,             // step number for cycle tests
  errors: number,           // reserved — byte layout of error flags unknown
  // simulation controls:
  auto: boolean,            // if true, voltage/current/capacity evolve with time
  autoRateVPerMin: number,  // V/min rate when auto
  cadenceMs: number,        // how often to emit periodic RX (default 500)
}
```

### Log entry shape

```ts
{
  t: string,                // ISO timestamp
  mono: number,             // performance.now() at capture
  dir: 'tx' | 'rx' | 'note',
  hex: string,              // raw bytes, space-separated
  summary: string,          // human-readable
  decoded?: object,         // parsed fields if frame was valid
  checksumValid?: boolean,
  note?: string,            // for dir='note'
}
```

## Driving it like an MCP server

The control API is small enough to feel like a tool surface. A typical
exploration session:

1. Start fake device, start VB6 app, have it connect to the COM port.
2. `GET /state` — confirm device is idle.
3. Click "Start" in VB6 via the UI driver (or by hand).
4. `GET /log?limit=10` — see the TX command bytes. Does the `commandName`
   decode to something reasonable? Are there unknown payload bytes?
5. `PATCH /state` — simulate a changing voltage, watch the UI update on
   screen or via `GET /ui/screenshot`.
6. Spot an unknown response byte? `POST /respond/to/0xXX` with different
   hex payloads and click the same button again — see which UI labels
   change vs stay the same. That tells us which field that byte drives.
7. `POST /inject` weird state bytes (0x33, 0x77, …) to see if the UI has a
   hidden error/warning path.

## Orphaned COM ports

Killing the fake device with `Ctrl+C` cleans up its virtual COM port.
Force-killing it (TaskManager, `kill -9`, crash) leaves the port
registered in the ghostcom driver, consuming a number in the COM2..9
range — which EB Tester needs.

To inspect and reap:

```bash
bun run com:check   # list ports ghostcom still knows about
bun run com:clean   # destroy ones whose companion side is closed (zombies)
```

Zombies specifically = "companion handle is not open" — a port
currently in use by a live process (including the real-device proxy)
is reported as `live` and won't be touched by `com:clean`.

## Open TODOs

- `profiles/` currently ships only `ebc-a40l`. Add `ebd-usb-plus`,
  `generic`, and one per model we want to characterize.
- No sim evolution (voltage/current don't change over time yet). Need to
  flesh out `simulate()` in `device.ts` once we understand charge curves.
- Error/protection bytes are unknown — `errors` field is a placeholder.
- UI driver is stubbed; only lists controls and clicks by name so far.
- No recording replay yet — we can read recordings, not play them back as
  synthetic RX traffic. Would be useful for regression testing the UI.
