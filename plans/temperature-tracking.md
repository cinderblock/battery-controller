# Multi-Channel Temperature Tracking

## Goal

Record temperature from multiple named channels during each test run, stored alongside existing electrical data points. Sources include:

- **1-Wire sensors** (DS18B20) connected to the Pi's GPIO — for charger-internal, battery-surface, and wire/bus-bar temperatures
- **HTTP API sensors** — room ambient, weather station, or other networked sensors reporting over REST/JSON

Temperature data should be:
- Time-aligned with existing `data_points` rows
- Queryable per-run (which channels were active, min/max/avg)
- Visible on the live chart and historical chart view
- Extensible — adding a new sensor channel shouldn't require schema changes

## Environment / Context

- **Runtime**: Bun on Raspberry Pi (ARM64, Debian)
- **Database**: SQLite via `bun:sqlite`, WAL mode, schema at `src/server/db.ts` (migration v4 is latest)
- **Data flow**: `DeviceSession` → `TestRecorder` → `insertDataPoint()` into SQLite; SSE pushes `reading` events to frontend
- **Sampling rate**: ~1 reading every 2 seconds (device heartbeat). Temperature sampling can be slower (5–30s) since thermal mass means nothing changes faster.
- **1-Wire on Pi**: Linux exposes DS18B20 sensors at `/sys/bus/w1/devices/28-*/temperature` (millidegrees C). Requires `w1-gpio` and `w1-therm` kernel modules.

## Design Decisions (proposed — pending user input)

### Separate table vs. inline columns

**Recommendation: Separate `temperature_readings` table.**

Rationale:
- Multiple channels per timestamp (can't be a single column)
- Different sampling rate from electrical data (may not align 1:1 with data_points)
- Channels are dynamic — new sensors appear without schema migration
- Keeps `data_points` table lean for the common query path (chart rendering)

### Schema (new migration)

```sql
-- Channel registry (stable across runs, supports auto-discovery)
CREATE TABLE temp_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,                            -- user-assigned name (NULL until user names it)
  source_type TEXT NOT NULL,            -- 'w1' | 'http'
  source_config TEXT NOT NULL,          -- JSON: {device_id: "28-..."} or {url: "http://ha/api/states/sensor.x", json_path: "state"}
  enabled INTEGER DEFAULT 1,
  alert_max_c REAL,                     -- abort threshold (NULL = no limit)
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at TEXT,                    -- updated on each successful read
  unplugged_at TEXT,                    -- set when a previously-seen sensor stops responding
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX idx_temp_channels_config ON temp_channels(source_type, source_config);

-- Temperature samples (only written during active runs/waits)
CREATE TABLE temperature_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES test_runs(id),
  channel_id INTEGER NOT NULL REFERENCES temp_channels(id),
  temp_c REAL NOT NULL,
  elapsed_s REAL NOT NULL,              -- seconds since run start
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_temp_readings_run ON temperature_readings(run_id, channel_id);
```

### Sensor polling architecture

```
TemperatureManager (new, src/server/temperature.ts)
├── polls all enabled channels every 10 seconds
├── auto-discovers 1-Wire sensors on each cycle
├── maintains last-known-good value per channel (for SSE snapshots + live chart)
├── emits 'temperature' events (channelId, tempC, timestamp)
├── emits 'alert' events when a reading exceeds the channel's alert_max_c
└── TestRecorder subscribes: inserts rows with run_id + elapsed_s ONLY when a run/wait is active
```

**Alert behavior:**
- When `temp_c > channel.alert_max_c` during a run → emit alert event → server issues stop command → run ends with `end_reason = 'temp_alert'`
- Alert threshold is per-channel, configurable globally on the channel and overridable per-run in the start modal

### Source adapters

| Source type | Implementation |
|-------------|---------------|
| `w1` | Read `/sys/bus/w1/devices/{device_id}/temperature`, parse as integer millidegrees, ÷ 1000. Auto-discover by scanning `/sys/bus/w1/devices/28-*`. |
| `http` | Home Assistant REST API: `GET {base_url}/api/states/{entity_id}` with long-lived access token. Extract `state` field (or configurable `json_path`). Timeout 5s. |

Both adapters return `number | null` (null = read failure, logged but not stored).

**Auto-discovery flow (1-Wire):**
1. On each poll cycle, scan `/sys/bus/w1/devices/28-*` for device directories
2. If a new device ID appears that isn't in `temp_channels` → insert with `name=NULL`, `first_seen_at=now`
3. Push a `tempChannelDiscovered` SSE event to frontend → UI prompts user to name it
4. If a previously-known device disappears → set `unplugged_at=now`, push `tempChannelUnplugged` event
5. If it reappears → clear `unplugged_at`, update `last_seen_at`, push `tempChannelReconnected` event

### 1-Wire system prerequisites

**In the main app (`TemperatureManager` startup):**
- Check if `/sys/bus/w1/devices/` exists
- If not: log once at info level ("1-Wire not available — w1 kernel modules not loaded, skipping hardware temp sensors") and disable the w1 adapter. No crash, no repeated warnings.
- If yes: proceed with auto-discovery as normal

**In `setup.ts` (deploy script, runs on the Pi):**
- Use `raspi-config nonint` to enable the 1-Wire interface, same pattern as the existing serial config:
  ```ts
  await setRaspiConfig('do_onewire', true);  // raspi-config nonint do_onewire 0
  ```
- This enables the `w1-gpio` overlay in `/boot/config.txt` (default GPIO 4) and loads `w1-gpio` + `w1-therm` modules
- Existing serial setup (`do_serial_cons`, `do_serial_hw`, `pi3-disable-bt` overlay) stays as-is — already correct
- If the overlay was newly added, `configureBootConfig()` already handles the reboot path

### Frontend integration

Temperature channels are **first-class chart series**, just like voltage, current, and power:

- Each channel becomes a toggleable series in the chart legend (same UX as V/I/P/Ah)
- Live chart: temperature points stream in via SSE alongside electrical readings
- Historical chart: `GET /api/runs/:id/temperature` data merged into the run's chart timeline
- Color-code by channel name (fixed palette: battery=red, charger=orange, ambient=blue, weather=green)
- "New Run" modal: per-channel alert threshold inputs (pre-filled from channel defaults)
- Unnamed/newly-discovered channels: toast notification prompting user to assign a name

**Axis layout:**

- **Left Y-axis: combined voltage + current.** Scale so that 0 A aligns with the low cutoff voltage, and max current aligns with the high cutoff voltage. This puts the two electrical signals on one axis with meaningful alignment to the test's setpoints.
- **Right Y-axis: temperature (°C).** All temperature channels share this axis.
- Power and capacity remain as they are today (additional series, toggled independently).

### Configuration storage

**All temperature/sensor config lives in a JSON file on disk** (not the SQLite settings table). This makes it easy to back up, inspect, and survives DB rebuilds.

- Path: `/opt/battery-controller/data/temp-config.json`
- Loaded at startup, written on every change
- Editable entirely from the browser UI (no env vars, no SSH needed)

```jsonc
{
  "pollIntervalS": 10,
  "homeAssistant": {
    "baseUrl": "http://homeassistant.local:8123",
    "token": "eyJ0eXAiOi..."  // long-lived access token
  },
  "channels": [
    {
      "id": "w1-28-00000abcdef",
      "name": "Battery Surface",
      "sourceType": "w1",
      "deviceId": "28-00000abcdef",
      "enabled": true,
      "alertMaxC": 45,
      "firstSeenAt": "2026-05-06T...",
      "lastSeenAt": "2026-05-06T...",
      "unpluggedAt": null
    },
    {
      "id": "ha-sensor.garage_temperature",
      "name": "Garage Ambient",
      "sourceType": "http",
      "entityId": "sensor.garage_temperature",
      "enabled": true,
      "alertMaxC": null,
      "firstSeenAt": "2026-05-06T..."
    }
  ]
}
```

- Channel IDs are deterministic from source: `w1-{deviceId}` or `ha-{entityId}`
- The `temp_channels` SQLite table from the schema section is still used for the `temperature_readings` foreign key, but the JSON file is the source of truth for config — the DB table is synced from it on startup and on changes

### HTTP channel configuration UX

**Global Home Assistant connection:**
- Settings page in the browser UI with fields for base URL + long-lived access token
- "Test Connection" button that hits HA's `/api/` endpoint to verify credentials
- Stored in `temp-config.json` under `homeAssistant`

**Adding an HTTP channel — HA entity browser:**
1. User clicks "Add HTTP Sensor" in the channel management UI
2. If HA connection is configured, app fetches `GET {baseUrl}/api/states` with the token
3. UI filters to entities with `device_class: "temperature"` (or shows all sensors with a type filter)
4. User picks an entity from the list → channel is created with the entity's friendly_name as default name
5. User can rename, set alert threshold, enable/disable

**Fallback:** If HA isn't configured (or user has a non-HA source), a manual form with URL + JSON path is available.

### API endpoints (new)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/temp/config` | Full config (channels + HA connection, token redacted) |
| PUT | `/api/temp/config/ha` | Set/update Home Assistant connection |
| POST | `/api/temp/config/ha/test` | Test HA connection, return status |
| GET | `/api/temp/ha/entities` | Proxy: fetch HA entities (filtered to temperature) |
| GET | `/api/temp/channels` | List all channels (with enabled state + last reading) |
| POST | `/api/temp/channels` | Create a channel (from HA entity picker or manual) |
| PATCH | `/api/temp/channels/:id` | Enable/disable, rename, set alert threshold |
| DELETE | `/api/temp/channels/:id` | Remove a channel |
| GET | `/api/temp/current` | Latest reading per channel |
| GET | `/api/runs/:id/temperature` | All temperature data for a run |

### SSE additions

- New `temperature` event type: `{ readings: [{ channelId: string, name: string, tempC: number }] }` — sent every poll cycle
- `tempChannelDiscovered` / `tempChannelUnplugged` / `tempChannelReconnected` events for 1-Wire auto-discovery
- Include latest temperatures + channel list in `snapshot` event for new clients

## Plan / Steps

- [ ] **1. Schema migration** — Add `temp_channels` + `temperature_readings` tables (migration v5)
- [ ] **2. Config file layer** — JSON read/write for `/opt/battery-controller/data/temp-config.json`, sync to DB on startup
- [ ] **3. 1-Wire adapter** — Read DS18B20 via sysfs, auto-discover, graceful skip if unavailable
- [ ] **4. HTTP/HA adapter** — Fetch entity state from Home Assistant REST API, timeout/retry
- [ ] **5. TemperatureManager** — Poll loop, event emission, last-value cache, alert detection
- [ ] **6. TestRecorder integration** — Subscribe to temperature events, write rows only during active runs/waits
- [ ] **7. Alert/abort logic** — Stop active test when threshold exceeded, `end_reason = 'temp_alert'`
- [ ] **8. Setup script** — Add `raspi-config nonint do_onewire 0` to `setup.ts`
- [ ] **9. API routes** — Config CRUD, HA proxy, channel management, per-run temperature data
- [ ] **10. SSE integration** — Broadcast temperature events + discovery events, include in snapshot
- [ ] **11. Frontend: channel management page** — List channels, rename, enable/disable, set thresholds
- [ ] **12. Frontend: HA entity browser** — Connect to HA, browse temperature entities, add channels
- [ ] **13. Frontend: "New Run" modal** — Per-channel alert threshold overrides
- [x] **14. Frontend: chart integration** — Temperature as regular series, combined V+I left axis, °C right axis
- [x] **15. Frontend: live display** — Current temperatures visible during active test

## Decisions Already Made (don't re-ask)

1. **Sampling interval**: 10 seconds, fixed for now. May tighten to 1s later if needed — design shouldn't preclude it.
2. **Background logging**: No. Only record temperature during active runs and waits. TemperatureManager still polls (to serve live readings to UI), but doesn't persist unless a run is active.
3. **HTTP source**: Home Assistant API. Adapter should target HA's REST API (`/api/states/<entity_id>`). Generic enough to work with other JSON APIs but HA is the primary target.
4. **Alert thresholds**: Yes. Per-channel configurable in the "new Run" modal (or inherited from defaults). System should abort the test if threshold exceeded.
5. **1-Wire auto-discovery**: Auto-detect new sensors on the bus. Prompt user in UI to name them. Track first-seen, last-seen, and unplug/replug timestamps in the channel record.
6. **Run summary stats**: No dedicated columns on `test_runs`. Query `temperature_readings` after the fact to correlate.

## Things Not to Do

- Don't try to embed temperature in the existing `data_points` table — the different sample rates and variable channel count make this a poor fit
- Don't use a daemon or separate process for 1-Wire — Bun can read sysfs directly
- Don't block the main event loop on 1-Wire reads (they're 750ms!) — use async file reads or a worker
- Don't hardcode channel names — keep them user-configurable
- Don't log temperature when no run is active — only persist during runs/waits
- Don't require the user to manually register 1-Wire sensors — auto-discover them
