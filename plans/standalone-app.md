# Standalone Web Application for EBC-A40L Battery Controller

Plan path: `plans/standalone-app.md`

## Goal

Replace the VB6 "EB Tester" software with a standalone web application running directly on the Pi (`coulomb`). The app owns the serial port, serves a phone-first web UI at `http://coulomb.tsl/`, and adds multi-cell tracking with barcode identification for a fleet of ~14 LiFePO4 200Ah ThunderSky cells. All test data persists on the Pi.

## Environment / context

- Pi hostname: **`coulomb`** (10.255.5.52), `.tsl` domain resolves on the local network.
- Runtime: **Bun** (already installed at `/home/pi/.bun/bin/bun`).
- Serial port: `/dev/serial0`, 9600 8E1. Currently owned by `battery-controller-bridge.service`.
- Existing TypeScript protocol codec: `src/protocol/` (checksum, base-240, frame build/parse/scan, device table, divisors). Zero Node.js deps — runs anywhere.
- Existing server skeleton: `src/server/` (serial manager using `stty` + raw file I/O, state manager, Bun HTTP+WS server, TCP bridge mode).
- Existing frontend skeleton: `src/frontend/` (React 19 + react-query + react-use-websocket, connection-chain visualization, hex packet display, dark theme CSS).
- Build system: `src/run/build.ts` (Bun.build for server bundle + frontend bundle), `src/run/deploy.ts` (SSH transfer + systemd service management).
- Device: EBC-A40L, byte16=0x0A, family=ebc, modes: D-CC, D-CP, C-CV.
- Confirmed protocol commands: init (0x05), stop (0x06), load toggle (0x02), D-CC start/continue (0x01/0x08), D-CP start/continue (0x11/0x18), C-CV start/continue (0x21/0x28), heartbeat (0x0A), resistance test (0x09), calibration (0x04).
- RX frame decoding: state byte, current (÷100), voltage (÷1000), capacity (raw mAh), setpoint echo, cutoff echo, step, device ID.
- **User's phone: iOS Chrome** (WebKit engine — no BarcodeDetector API, getUserMedia may require HTTPS).
- **Cells: ThunderSky TS-LFP200AHA** — 200Ah LiFePO4 prismatic, 3.2V nominal, Code 128 barcodes.

## Decisions already made (don't re-ask)

- Standalone on the Pi — no Windows proxy in the runtime path.
- Bun runtime, TypeScript throughout.
- Phone-first UI (user scans QR code printed/taped on the Pi).
- SQLite for persistence (Bun has built-in `bun:sqlite`, zero native deps).
- The existing `src/protocol/` codec is reused as-is (it has zero platform dependencies).
- The existing serial manager approach (stty + raw file I/O) is reused — it works on the Pi and avoids native deps.
- Single-device assumption for now (one EBC-A40L on `/dev/serial0`). Multi-device can be added later.
- **HTTP only** — no self-signed TLS. User may set up an HTTPS reverse proxy on a separate server with real certs if needed for iOS camera access. NEVER generate or use self-signed certificates.
- **No "disconnect" button** — the app always owns the serial port, always shows the device's live state. The connection is permanent.
- **Device reports are the source of truth** — UI shows optimistic updates with visual pending indicators until the device confirms. All state changes broadcast to all connected clients via WebSocket.
- **iOS Chrome is the primary platform** — zbar-wasm is the primary barcode scanner engine (BarcodeDetector API unavailable on WebKit). Manual barcode entry is the fallback if camera access fails over HTTP.
- **Step/cycle tests are in scope** — automated multi-step sequences (charge → wait → discharge → repeat) are a core feature, not deferred.
- **No historical data migration** — starting fresh.
- **Cell barcodes are Code 128** — format: `TS-LFP200AHA` (model) + serial number.

## Architecture overview

```
Phone browser (http://coulomb.tsl/)
    │
    ├── WebSocket ──→ live readings (typed JSON, ~2s cadence)
    │                  shared state: all clients see the same thing
    └── REST API ───→ commands, cell management, data queries
         │
    ┌────┴────────────────────────────────┐
    │  Bun server (port 80)               │
    │  ├── device-session.ts              │  ← serial protocol state machine
    │  ├── cycle-runner.ts                │  ← multi-step test orchestration
    │  ├── test-recorder.ts               │  ← persists data points to SQLite
    │  ├── db.ts                          │  ← bun:sqlite data layer
    │  ├── capacity-estimation.ts         │  ← statistical analysis
    │  └── settings-lock.ts              │  ← password-protected settings lock
    └────┬────────────────────────────────┘
         │
    /dev/serial0 (9600 8E1)
         │
    EBC-A40L hardware
```

## EBC-A40L limits & defaults

These values govern UI validation, preset defaults, and parameter step sizes.

### Hardware limits

| Parameter | Min | Max | Resolution | Divisor |
|-----------|-----|-----|-----------|---------|
| Current | 0.00 A | 40.00 A | 0.01 A (10 mA) | ÷100 |
| Voltage | 0.000 V | 5.000 V | 0.001 V (1 mV) | ÷1000 |
| Cutoff voltage | 0.00 V | 5.00 V | 0.01 V (10 mV) | ÷100 |
| Cutoff current | 0.00 A | 40.00 A | 0.01 A (10 mA) | ÷100 |
| Power (D-CP) | 0 W | 350 W | 1 W | ÷1 |
| Time limit | 0 min | 9999 min | 1 min | ÷1 |

### ThunderSky TS-LFP200AHA recommended values

Source: ThunderSky/Winston datasheets (LiFePO4 chemistry).

| Parameter | Value | Notes |
|-----------|-------|-------|
| Nominal voltage | 3.2 V | |
| Charge voltage (CV target) | **3.65 V** | Absolute max 3.8V — do not exceed |
| Charge cutoff current | **2.00 A** (0.01C) | Conservative; 4A (0.02C) also acceptable |
| Discharge cutoff voltage | **2.50 V** (full capacity) | 2.80 V for conservative/longevity testing |
| Absolute min voltage | 2.0 V | Permanent damage below this |
| Max charge/discharge rate | 0.2C = 40A | Device limit, well within cell's safe range |

### Default presets (shown in UI)

| Mode | Current | Target V | Cutoff V | Cutoff I | Time limit |
|------|---------|----------|----------|----------|------------|
| **D-CC** (full capacity) | 40.00 A | — | 2.50 V | — | 600 min |
| **D-CC** (conservative) | 20.00 A | — | 2.80 V | — | 720 min |
| **C-CV** (standard) | 40.00 A | 3.65 V | — | 2.00 A | 600 min |
| **C-CV** (gentle) | 20.00 A | 3.65 V | — | 2.00 A | 720 min |
| **D-CP** (constant power) | — | — | 2.50 V | — | 600 min |

At 40A, a full 200Ah cycle takes ~5h charge + ~5h discharge = ~10h per cycle.

## Plan / steps

### Phase 1: Core serial service (no UI changes yet)

**Goal:** A Bun process on the Pi that owns `/dev/serial0`, connects to the EBC-A40L, decodes every RX frame, exposes a command API, and persists data points to SQLite. Always connected — no connect/disconnect lifecycle.

1. **Create `src/server/device-session.ts`** — high-level session manager wrapping `SerialManager`:
   - Sends init (0x05) on serial open, maintains heartbeat (0x0A) timer (~55s).
   - **Graceful mid-test recovery:** On startup, if the device is already streaming data (non-idle state byte), pick up the existing test state without sending init. Detect the current mode from the state byte, reconstruct what we can from the readings, and start recording.
   - Parses every RX packet using `parseFrame()` + `decodeRxFrame(frame, 'ebc')`.
   - Maintains in-memory state: current mode, decoded readings (V, I, P=V×I, capacity, energy=∫P·dt), elapsed time.
   - Detects state transitions from the state byte. Maps to enum: `idle`, `d-cc`, `d-cp`, `c-cv`, `complete`, `fault`.
   - Emits typed events: `'reading'`, `'stateChange'`, `'connected'`, `'disconnected'`.
   - Command methods: `startDCC(currentA, cutoffV, maxTimeMin?)`, `startDCP(powerW, cutoffV, maxTimeMin)`, `startCCV(currentA, targetV, cutoffCurrentA)`, `stop()`, `continue(...)`.
   - **Optimistic command tracking:** When a command is sent, emit a `'commandPending'` event with the expected state change. When the device confirms (state byte changes), emit `'commandConfirmed'`. If no confirmation within ~5s, emit `'commandTimeout'`.
   - Auto-reconnect on serial port loss (retry with backoff).

2. **Create `src/server/db.ts`** — SQLite data layer using `bun:sqlite`:
   - Schema (see Data Model section below).
   - Migration runner (version table + idempotent `CREATE TABLE IF NOT EXISTS`).
   - Insert/query functions for cells, test runs, and data points.
   - DB file at `/opt/battery-controller/data/battery.db`.
   - **WAL mode** for concurrent read/write.
   - **Crash resilience:** WAL mode + frequent commits. On startup, detect incomplete test runs (no `ended_at`) and mark them as `end_reason = 'service_restart'`.

3. **Create `src/server/test-recorder.ts`** — listens to device-session events, records test runs:
   - On state change to running: creates a new `test_run` row.
   - On each `'reading'` event during a running test: inserts a `data_point` row.
   - On state change to idle/complete: finalizes the test run (end time, final capacity, final energy).
   - Associates with a cell if one has been scanned.
   - **On mid-test recovery:** Creates a test run with `start_reason = 'recovered'` and a note that earlier data points are missing.

4. **Create `src/server/settings-lock.ts`** — password-based settings lock:
   - Simple bcrypt-hashed password stored in SQLite `settings` table.
   - Lock/unlock via REST API. Lock state broadcast to all clients.
   - When locked: test start/stop/parameter changes are rejected (401). Read-only monitoring still works.
   - Lock persists across Pi reboots (stored in DB).
   - First-time setup: no password = unlocked. Set password via UI.

5. **Refactor `src/server/index.ts`** — replace raw packet logging with typed API:
   - WebSocket broadcasts structured `DecodedReading` objects (not raw hex).
   - **All connected clients see the same state.** When one client sends a command, all clients see the optimistic update and the device confirmation.
   - REST endpoints:
     - `POST /api/test/start` — `{mode, current?, voltage?, power?, cutoffV?, cutoffCurrent?, maxTime?}`
     - `POST /api/test/stop`
     - `POST /api/test/continue` — continue with (optionally updated) setpoints
     - `GET /api/test/current` — current test state + readings
     - `GET /api/cells` — list all cells
     - `POST /api/cells` — create/update cell (barcode + optional label)
     - `GET /api/cells/:id/runs` — test runs for a cell
     - `GET /api/runs/:id/data` — data points for a run
     - `GET /api/runs/:id/export` — CSV export
     - `POST /api/cells/scan` — associate current/next test with a cell (from barcode)
     - `POST /api/lock` — set/change lock password
     - `POST /api/unlock` — unlock with password
     - `GET /api/lock/status` — is settings locked?
     - `POST /api/cycle/start` — start a cycle program
     - `POST /api/cycle/stop` — abort cycle program
     - `GET /api/cycle/status` — current cycle state
   - WebSocket message types:
     - `{type: 'reading', data: DecodedReading}` — ~every 2s
     - `{type: 'state', data: DeviceState}` — on state transitions
     - `{type: 'commandPending', data: {command, expectedState}}` — optimistic
     - `{type: 'commandConfirmed', data: {command, actualState}}` — device confirmed
     - `{type: 'lockState', data: {locked: boolean}}` — lock state change
     - `{type: 'cycleState', data: CycleState}` — cycle progress updates
   - No disconnect endpoint — connection is always on.

6. **Update systemd service** — `battery-controller.service` replaces `battery-controller-bridge.service`.
   - `Restart=always` with `RestartSec=5` for crash recovery.
   - `WatchdogSec=60` with sd_notify integration if feasible.

### Phase 2: Chart-first UI

**Goal:** Phone-first web UI where the chart IS the primary interface. All historical runs for the selected cell group are shown. When a test is active, the live trace is prominent and old runs desaturate. Two pages total: main chart view + sequence editor.

**Design reference:** `mockups/mockup5-chart-first.html` (main) and `mockups/mockup6-sequence-editor.html` (sequences).

7. **Main chart view (`src/frontend/views/ChartView.tsx`)** — the app's primary interface:
   - **uPlot** chart fills most of the viewport. Time on X axis.
   - 2-4 series per run: voltage, current, power, capacity (toggleable via legend panel).
   - Left Y axis: voltage. Right Y axis: current/power (configurable).
   - **Idle state:** All historical runs for the selected cell group shown at full opacity. Runs are color-coded, togglable individually in a slide-in legend panel.
   - **Active test:** Live trace in white (prominent), all historical runs desaturated. Live readings overlay in top-right corner (V, I, P, Ah, Wh, elapsed).
   - "New Run" button in bottom bar (visible when idle) opens a start modal.
   - "Stop" button replaces it during active test.
   - Bottom bar also has cell group selector dropdown and link to sequence editor.

8. **Start modal (`src/frontend/components/StartModal.tsx`)** — launch a new test:
   - Cell barcode input (type or scan). Scan button uses zbar-wasm (primary for iOS) with manual entry fallback.
   - Cell label (optional free text).
   - Cell group selector (determines capacity for C-rate display).
   - Mode selector: D-CC, D-CP, C-CV, or "Sequence" (picks a saved sequence).
   - Parameter inputs with validation (10mA current steps, hardware limits).
   - Amps / C-rate toggle — C-rate scales with selected cell group capacity.
   - Camera/HTTP detection: if `getUserMedia` unavailable, show manual barcode entry as default.

9. **Legend panel (`src/frontend/components/LegendPanel.tsx`)** — slide-in from left:
   - Series toggles (voltage, current, power, capacity).
   - Per-run visibility toggles with color swatches and capacity values.
   - Shows cell name, date, and key stats for each run.

10. **Top bar (`src/frontend/components/TopBar.tsx`)** — minimal status strip:
    - Connection dot, device name, state badge.
    - Condensed live readings (V, A, Ah) — always visible.

11. **Session hook (`src/frontend/hooks/useDeviceSession.ts`)** — typed WebSocket consumer:
    - Parses typed messages, maintains current reading + readings array for charting.
    - Exposes `sendCommand()` for REST calls.
    - Handles reconnection + state recovery.
    - **Shared state:** All clients receive the same WebSocket stream.

12. **Routing** — two pages:
    - `/` — Chart view (main interface)
    - `/sequences` — Sequence editor
    - Simple pathname routing, SSR for fast first paint with current device state embedded.

### Phase 3: Sequence editor UI

**Goal:** Visual programming interface for multi-step test sequences. Blocks chain left-to-right like a mini chart preview, with simulated voltage ramps.

13. **Sequence editor page (`src/frontend/views/SequenceEditor.tsx`)**:
    - **Visual timeline (top):** Canvas-rendered mini voltage chart. Discharge blocks ramp down (orange), charge blocks ramp up (blue), wait blocks are flat (gray). Loop repetitions shown at reduced opacity. Click a block to select the corresponding step.
    - **Step list (below):** Expandable cards for each step — mode, parameters, duration.
    - **Step types:** D-CC, D-CP, C-CV, Wait, Loop (wraps a sub-sequence N times).
    - **Add step buttons** at bottom: Discharge, Charge, Wait, Loop.
    - **Amps / C-rate toggle** — current values scale with cell group capacity.
    - **Presets:** "Standard Capacity Test", "Quick Check", "Gentle Cycle", "Full Characterization", "Blank".
    - **Estimated duration** bar based on trivial physics model.
    - **Save / Run** buttons in header. Saved sequences stored in SQLite.

14. **Create `src/server/cycle-runner.ts`** — server-side cycle orchestrator:
    - Accepts a cycle program: ordered list of steps, each being one of:
      - `{type: 'd-cc', current, cutoffV, maxTime?}`
      - `{type: 'd-cp', power, cutoffV, maxTime?}`
      - `{type: 'c-cv', current, targetV, cutoffCurrent, maxTime?}`
      - `{type: 'wait', duration: seconds}`
      - `{type: 'loop', count, steps: [...]}`  — repeat a sub-sequence N times
    - On test completion (device transitions to idle/complete), automatically starts the next step.
    - Tracks overall cycle progress: current step index, current cycle count, total steps done.
    - **Persists cycle state to SQLite** so it survives Pi reboots. On restart, resumes from the last completed step.
    - Each step creates its own `test_run` row, linked to the same `cycle_id`.
    - Emits `'cycleState'` events for UI updates.

### Phase 4: Capacity estimation + fleet analysis

**Goal:** Statistical capacity analysis. Visible directly in the chart view's legend panel and cell group selector.

15. **Capacity estimation (`src/server/capacity-estimation.ts`)** — statistical analysis:
    - From completed D-CC discharge runs: mean, median, stddev, trend.
    - Optional Peukert correction for different discharge rates.
    - Expose via `GET /api/cells/:id/capacity` and `GET /api/groups/:id/summary`.

16. **Fleet stats in legend panel** — per-cell capacity shown next to each run in the legend. Cell group dropdown shows summary stats (avg, min, max across cells).

### Phase 5: Polish + deployment hardening

17. **QR code** — `GET /api/qr` generates a QR code PNG for `http://coulomb.tsl/`.
18. **Data export** — CSV per run, CSV per cell, full SQLite DB download.
19. **Error handling** — disconnect banners, SIGTERM cleanup, rate-limiting.
20. **Service deployment** — update setup.ts, ensure bridge service is stopped.
21. **Offline resilience** — service worker for app shell caching (UI loads even if Pi is slow to boot).

## Data model

```sql
CREATE TABLE IF NOT EXISTS cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT UNIQUE NOT NULL,        -- e.g. "TS-LFP200AHA 00104F02"
  label TEXT,                          -- optional free-text label
  nominal_capacity_mah INTEGER DEFAULT 200000,
  chemistry TEXT DEFAULT 'LiFePO4',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cycle_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id INTEGER REFERENCES cells(id),
  name TEXT,
  steps_json TEXT NOT NULL,            -- JSON array of step definitions
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'paused', 'completed', 'aborted'
  current_step INTEGER DEFAULT 0,
  current_cycle INTEGER DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id INTEGER REFERENCES cells(id),
  cycle_program_id INTEGER REFERENCES cycle_programs(id),
  cycle_step_index INTEGER,            -- which step in the cycle program
  mode TEXT NOT NULL,                  -- 'd-cc', 'd-cp', 'c-cv'
  setpoint_current_a REAL,
  setpoint_voltage_v REAL,
  setpoint_power_w REAL,
  setpoint_cutoff_v REAL,
  setpoint_cutoff_current_a REAL,
  setpoint_max_time_min INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  start_reason TEXT DEFAULT 'manual',  -- 'manual', 'cycle', 'recovered'
  end_reason TEXT,                     -- 'cutoff_voltage', 'cutoff_current', 'timeout', 'manual_stop', 'fault', 'service_restart'
  final_capacity_mah REAL,
  final_energy_mwh REAL,
  peak_voltage_v REAL,
  min_voltage_v REAL,
  peak_current_a REAL,
  duration_s REAL,
  data_point_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS data_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES test_runs(id),
  elapsed_s REAL NOT NULL,
  voltage_v REAL NOT NULL,
  current_a REAL NOT NULL,
  power_w REAL NOT NULL,
  capacity_mah REAL NOT NULL,
  energy_mwh REAL NOT NULL,
  state_byte INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- settings keys: 'lock_password_hash', 'lock_enabled'

CREATE INDEX IF NOT EXISTS idx_data_points_run_id ON data_points(run_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_cell_id ON test_runs(cell_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_cycle_id ON test_runs(cycle_program_id);
CREATE INDEX IF NOT EXISTS idx_cells_barcode ON cells(barcode);
```

Storage estimate: ~100 bytes/point x 90k points per full 200Ah discharge at 40A x 14 cells x 10 runs = ~1.3GB. Fine for Pi SD card.

## What can be reused vs. written fresh

**Reuse as-is:** `src/protocol/` (entire codec library), `src/server/serial.ts` (serial I/O), `src/run/` (build + deploy tooling).

**Reuse with modifications:** `src/server/index.ts` (add REST API + typed WS), `src/server/state.ts` (expand state model), `src/frontend/App.tsx` (add routing), `src/frontend/hooks/useWebSocket.ts` (typed messages).

**Write fresh:** device-session, cycle-runner, settings-lock, db, test-recorder, capacity-estimation, frontend views (ChartView, SequenceEditor, StartModal, LegendPanel, TopBar), uPlot wrapper, session hook, barcode scanner component.

## New dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `uplot` | Time-series charting | 14kb gzip |
| `zbar-wasm` | Barcode scanner (primary on iOS) | ~90kb, lazy-loaded via Web Worker |

`bun:sqlite` is built into Bun — no additional dependency.

## Findings / gotchas

- **Serial byte-at-a-time sending.** Protocol.md warns about inter-byte delays. The current `SerialManager.sendPacket()` writes entire buffers. May need a `writeByteByByte()` helper with ~10ms delays if frames are dropped on direct serial.
- **Existing `sendStartD_CC()` etc. are stubs** — send all-zero payloads. Device-session layer must build proper payloads.
- **Info packet filtering.** During idle, device alternates normal and info packets (state + 0x64). Recorder should ignore info packets for data but use them for device identification on connect.
- **Capacity field resets** to 0 at each test start. Last value before idle = final capacity.
- **Host-side energy integration.** A40L's energy field (bytes 8-9) is always 0. Must compute `integral(V*I*dt)` using real timestamps.
- **SQLite WAL mode** — enable for concurrent read/write (`PRAGMA journal_mode=WAL`).
- **Camera on HTTP + iOS.** `getUserMedia()` requires a "secure context" on WebKit. Private IPs over plain HTTP likely do NOT qualify on iOS Chrome. Manual barcode entry is the essential fallback. If the user sets up an HTTPS proxy with real certs on a separate server, camera scanning will work. NEVER use self-signed TLS.
- **iOS Chrome = WebKit.** All browsers on iOS use the WebKit engine. BarcodeDetector API is not available. zbar-wasm is the only option for in-browser barcode detection.
- **Mid-test service start.** If the Pi reboots or the service restarts while a test is running, the device continues operating independently. On startup, the first RX packet's state byte tells us whether a test is in progress. We should NOT send init (0x05) if the device is mid-test — that might reset it. Instead, passively observe and reconstruct state from the stream.
- **Cycle orchestration is host-driven.** The EBC-A40L does not natively run multi-step programs. The server must watch for test completion and send the next start command. This means cycles only advance while the server is running — a reboot mid-wait will resume the wait timer from zero (acceptable).
- **Current resolution is 10mA (0.01A).** UI input fields should enforce this step size. The divisor is ÷100, so the base-240 encoded value represents centamps.

## Progress log

- [x] Phase 1: Core serial service + SQLite persistence + settings lock
  - [x] `src/server/db.ts` — SQLite data layer (WAL, migrations, CRUD, prepared statements)
  - [x] `src/server/device-session.ts` — session manager (decode, state machine, commands, heartbeat, mid-test recovery)
  - [x] `src/server/test-recorder.ts` — bridges session events → SQLite (run lifecycle, data points, recovery detection)
  - [x] `src/server/settings-lock.ts` — bcrypt password lock via Bun.password (lock/unlock, persisted in DB)
  - [x] `src/server/index.ts` — refactored: REST API (17 endpoints), typed WS broadcasting, wired pipeline
  - [x] Renamed `DeviceSession.stop()` → `destroy()` to resolve conflict with the stop-test command method
- [x] Phase 2: Chart-first UI (main chart view + start modal + legend panel)
  - [x] `src/frontend/api-client.ts` — rewritten: typed WsMessage union, REST entity types, api() helper
  - [x] `src/frontend/hooks/useDeviceSession.ts` — native WebSocket with auto-reconnect, live point accumulation, REST commands
  - [x] `src/frontend/lib/chart-data.ts` — merge multiple runs + live data into uPlot-aligned dataset
  - [x] `src/frontend/components/Chart.tsx` — uPlot wrapper with resize observer, efficient setData() updates
  - [x] `src/frontend/components/TopBar.tsx` — connection dot, mode badge, condensed readings
  - [x] `src/frontend/components/StartModal.tsx` — barcode input, D-CC/D-CP/C-CV mode selector, Amps/C-rate toggle
  - [x] `src/frontend/components/LegendPanel.tsx` — slide-in panel, metric toggles, per-run visibility with color swatches
  - [x] `src/frontend/components/LiveOverlay.tsx` — floating readings during active test (V, A, W, Ah, Wh, elapsed)
  - [x] `src/frontend/views/ChartView.tsx` — main page composing all components, loads historical runs, manages visibility
  - [x] `src/frontend/App.tsx` — SessionContext provider, pathname router (/ and /sequences)
  - [x] `src/frontend/index.tsx` — imports uPlot CSS, removed react-query/react-use-websocket
  - [x] `src/frontend/index.html` — iOS meta tags, theme-color, viewport-fit
  - [x] `src/frontend/styles/main.css` — full rewrite: chart-first dark theme, phone-optimized
  - [x] Removed old hooks (useWebSocket.ts, useDeviceData.ts) — fully replaced
  - [x] Server: added `/sequences` route + SPA fallback for client-side routing
- [x] Phase 3: Sequence editor UI + cycle runner
  - [x] `src/frontend/lib/sequence-types.ts` — step types, LiFePO4 voltage simulation, duration estimation, 4 presets
  - [x] `src/frontend/components/SequenceTimeline.tsx` — canvas timeline with simulated V/I curves, setpoint annotations, loop bracket visual (×N label + return arrow)
  - [x] `src/frontend/components/StepCard.tsx` — expandable parameter cards with SetpointBar visual indicators, C-rate toggle
  - [x] `src/frontend/views/SequenceEditor.tsx` — full editor page: preset/saved sequence loader, step management, save to DB
  - [x] `src/server/cycle-runner.ts` — server-side orchestrator: loop flattener, sequential step execution, wait timers, SQLite persistence for reboot resume
  - [x] Server wiring: cycle runner init/shutdown, WebSocket cycle state broadcasts, REST endpoints for sequences + cycle control
  - [x] CSS: sequence editor styles appended to main.css (dark theme, phone-optimized)
  - [x] Type-checked cleanly (no errors in Phase 3 files)
- [x] Phase 4: Capacity estimation + fleet analysis
  - [x] DB migration v2: added `cell_group_id` FK on `cells` table
  - [x] DB: `getCellGroup()`, `getCellsInGroup()`, `setCellGroup()`, `getCompletedDischargeRuns()`, `getAllCompletedDischargeRuns()`
  - [x] `src/server/capacity-estimation.ts` — per-cell stats (mean, median, stddev, min, max, trend), Peukert normalization, fleet summary
  - [x] API endpoints: `GET /api/cells/:id/capacity`, `GET /api/cell-groups/:id/summary`, `GET /api/cell-groups/:id/cells`, `GET /api/capacity/all`, `PUT /api/cells/:id/group`
  - [x] `LegendPanel.tsx` — fleet health summary section (avg health, capacity range, weakest cell, per-cell bars with trend arrows)
  - [x] `ChartView.tsx` — loads fleet summary on group change, refreshes on test completion, health badge on group selector
  - [x] CSS: fleet summary grid, per-cell capacity bars, group selector badge
  - [x] Type-checked + builds cleanly
- [x] Phase 5: Polish + deployment hardening
  - [x] Data export: `GET /api/cells/:id/export` (CSV with all runs), `GET /api/export/db` (full SQLite download)
  - [x] Disconnect banners: red "Server disconnected" banner (WebSocket loss), orange "Serial port disconnected" banner
  - [x] `setup.ts`: creates `data/` subdirectory, adds `DB_PATH` env var to systemd unit
  - [x] Type-checked + builds cleanly
- [x] Barcode camera scanner
  - [x] `src/frontend/lib/barcode-scanner.ts` — runtime API detection (native BarcodeDetector on Chrome Android, zbar.wasm fallback), grayscale conversion, Emscripten struct reading
  - [x] `src/frontend/components/BarcodeScanner.tsx` — live camera feed with scanning overlay, guide box, error states for iOS/HTTP
  - [x] `src/frontend/components/StartModal.tsx` — integrated scanner button next to barcode text input
  - [x] Server: serves `/static/zbar.js` + `/static/zbar.wasm` from zbar.wasm npm package at runtime
  - [x] zbar.wasm loaded dynamically (not bundled) — avoids Node.js fs/path build errors

## Resolved questions

1. **Cell barcode format:** Code 128 linear barcode. Text: model ("TS-LFP200AHA") + serial number. Confirmed from photo.
2. **Cell labeling:** Optional free-text label field, no enforced format.
3. **Typical test parameters:** 40A max (device limit), 10mA steps. Defaults per ThunderSky LiFePO4 specs — see table above. 20A is also a good default for gentler cycling.
4. **Multiple concurrent users:** No command locking between users. Device reports are source of truth. All clients share the same WebSocket state. Optimistic UI shows pending indicators until device confirms. Settings can be locked with a password to prevent accidental changes.
5. **Historical data migration:** None needed — starting fresh.
6. **HTTPS:** Not needed for base functionality. HTTP on `coulomb.tsl` is fine. Camera for barcode scanning may require HTTPS on iOS — manual entry is the fallback, or user can set up an HTTPS reverse proxy with real certs. NEVER self-signed.
7. **Step/cycle tests:** Yes, included as Phase 4. Host-driven orchestration with persistence across reboots.

## Things not to do

- Do NOT implement firmware update or calibration UI (out of scope).
- Do NOT implement QC/PD mode (not relevant for EBC-A40L).
- Do NOT implement multi-channel (EBC-A40L is single-channel).
- Do NOT use `serialport` npm package (native bindings; stty + raw I/O works with Bun).
- Do NOT use heavy charting libraries (Chart.js, Recharts) — uPlot is the right tool.
- Do NOT use a full ORM — direct `bun:sqlite` with prepared statements.
- Do NOT use React Router — hash-based routing with a few routes is simpler.
- Do NOT remove the TCP bridge mode — keep as a debug tool.
- Do NOT commit calibration values to the device.
- Do NOT use self-signed TLS certificates — ever.
- Do NOT send init (0x05) if the device is already mid-test on startup — passively observe first.
- Do NOT add a "connect/disconnect" button — the serial connection is always on.
