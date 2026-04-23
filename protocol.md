# ZKETech EB Tester Serial Protocol

Reverse-engineered from `eb_setup_v1.8.9en_202507.exe` (VB6 application by ZKETech, www.zketech.com) via Ghidra decompilation, cross-referenced with the sigrok project's libsigrok driver and community documentation.

> **Note:** The sigrok documentation covers only the **EBD-USB+** electronic load. This software supports a much larger family of **58 devices** including battery charger/dischargers (EBC-*) and higher-power loads (EBD-*). The frame format and base-240 encoding are shared across the family, but the **operating modes, command payloads, and response field mappings differ by device type**. Details below.

## Serial Port Settings

| Parameter  | Value    |
| ---------- | -------- |
| Baud rate  | 9600     |
| Data bits  | 8        |
| Parity     | **Even** |
| Stop bits  | 1        |
| USB-serial | CH341 (some models use PL2303) |

## Frame Format

Every packet is framed with fixed start/end bytes:

```
Host → Device:   10 bytes
Device → Host:   19 bytes
```

```
Byte 0:     0xFA       — frame start (MSG_FRAME_BEGIN)
Byte 1:     CMD/STATE  — command (tx) or state (rx)
Bytes 2-N:  DATA       — payload (all values MUST be < 0xF0)
Byte N+1:   CHECKSUM   — XOR of bytes 1 through N
Byte N+2:   0xF8       — frame end (MSG_FRAME_END)
```

### Checksum

XOR of all bytes between (but not including) the start and end markers, **reduced modulo 240** so the checksum byte itself stays below 0xF0 (the base-240 constraint applies to all payload bytes, including the checksum):

```
raw_xor  = byte[1] ^ byte[2] ^ byte[3] ^ ... ^ byte[N]
checksum = raw_xor % 240
```

> **Confirmed:** During D-CC discharge, rising capacity in bytes 6-7 pushed the raw XOR into the 0xF0–0xFF range. The device sent the value mod 240 (e.g. raw 0xF9 → wire 0x09). Once the XOR drifted back below 0xF0, the wrapped and unwrapped values matched again. This explains "transient" checksum failures that self-resolve as field values change.

## Data Encoding: Base-240

All multi-byte numeric values use **base-240** encoding. The values 0xFA (250, frame start) and 0xF8 (248, frame end) are reserved, so all payload bytes must stay below 0xF0 (240).

### Encoding

```
int_val = round(value * divisor)
hi = int_val / 240
lo = int_val % 240
```

### Decoding

```
value = (hi_byte * 240 + lo_byte) / divisor
```

### Divisors

Divisors are **model-dependent**. The EBD-USB+ divisors come from the sigrok driver; the EBC divisors were confirmed by cross-referencing serial captures with the EB Tester GUI and LCD display on an EBC-A40L.

#### EBD-USB+ (from sigrok)

| Measurement    | Divisor | Float in binary | Resolution | Unit | Display format |
| -------------- | ------- | --------------- | ---------- | ---- | -------------- |
| Current        | 10,000  | `10.0` @ 0x1564 | 0.1 mA    | A    | `0.0000` (4 dp) |
| Voltage        | 1,000   | `1000.0` @ 0x1464 | 1 mV    | V    | `00.000` (3 dp) |
| UVC cutoff     | 100     | `100.0` @ 0x1638 | 10 mV    | V    | `00.00` (2 dp)  |
| D+/D- voltage  | 1,000   | —               | 1 mV       | V    | `0.000` (3 dp)  |
| Time           | —       | `3600.0` @ 0x1468 | 1 sec   | S/H  | —              |

#### EBC Charger/Discharger (confirmed on EBC-A40L)

| Measurement    | Divisor | Resolution | Unit | Display format |
| -------------- | ------- | ---------- | ---- | -------------- |
| Current        | **100** | 10 mA      | A    | `00.00` (2 dp) |
| Voltage        | 1,000   | 1 mV       | V    | `00.000` (3 dp) |
| Voltage setpoint | 100   | 10 mV      | V    | `00.00` (2 dp) |
| Cutoff current | 100     | 10 mA      | A    | `0.00` (2 dp) |
| Capacity       | 1 (raw) | 1 mAh      | mAh  | `0000` (integer) |

> **Confirmed:** GUI shows `04.00A` when the raw base-240 value is 400 (400 ÷ 100 = 4.00). The EBD-USB+ current divisor of 10,000 gives the wrong value (0.04A) for EBC models. Further confirmed by power calculation: 4.00A × 3.145V = 12.58W, matching the GUI power reading exactly.

> **Important:** D+/D- voltage fields are **only present on EBD-USB/EBD-USB+ models** (the USB power monitors). Charger/discharger models (EBC-*, EBD-A*, EBD-B*) use those response bytes for **other data** — see "EBC Response Layout" below.

## Host → Device Commands (10 bytes)

### Command Byte Encoding

The command byte (byte 1) combines a **mode offset** with an **action code**:

```
CMD = mode_offset + action

Mode offsets:              Actions:
  0x00 = D-CC                0x01 = start
  0x10 = D-CP                0x02 = toggle (start/stop)
  0x20 = C-CV                0x04 = calibrate
  0x30 = C-NiMh              0x05 = init (mode-independent)
  0x40 = C-NiCD              0x06 = stop (mode-independent)
  0x50 = C-LiPo              0x07 = configure/QC
  0x60 = C-LiFe              0x08 = continue
  0x70 = C-VRLA              0x09 = resistance test
                              0x0A = heartbeat (mode-independent)
```

### Command Table

| CMD (byte 1) | Name              | Payload                                                                          |
| ------------ | ----------------- | -------------------------------------------------------------------------------- |
| `0x01`       | **D-CC start**    | bytes 2-3 = current (base-240), bytes 4-5 = UVC cutoff (base-240, div 100) |
| `0x02`       | **Load toggle**   | All zeros — toggles load on/off (also stops charging)                            |
| `0x04`       | **Calibrate**     | byte 2 = cal point (0x00=Low Volt, 0x01=High Volt, 0x02=Low Curr, 0x03=High Curr), bytes 3-4 = reference value (base-240, ÷1000 → V or A), bytes 5-7 = zeros |
| `0x05`       | **Init / Start**  | All zeros — starts measurement stream, also serves as handshake                  |
| `0x06`       | **Stop**          | All zeros — stops measurement stream                                             |
| `0x07`       | **Configure/QC**  | byte 7 = mode selector (see QC/PD table below)                                  |
| `0x08`       | **D-CC continue** | Same format as D-CC start — updates setpoints during active test                 |
| `0x09`       | **Resistance test** | bytes 2-3 = test current (base-240, ÷100 → A). No special response — device applies a brief current pulse; VB6 app computes R = ΔV/I client-side from the voltage dip in subsequent RX frames. |
| `0x0A`       | **Heartbeat**     | byte 3 = sequence counter (increments 1, 2, ...) — keepalive                    |
| `0x11`       | **D-CP start**    | bytes 2-3 = power (base-240, raw = W), bytes 4-5 = cutoff voltage (base-240, ÷100 → V), bytes 6-7 = max time (raw = minutes) |
| `0x18`       | **D-CP continue** | Same format as D-CP start                                                        |
| `0x21`       | **C-CV start**    | bytes 2-3 = max current (div 100), bytes 4-5 = target voltage (div 100), bytes 6-7 = cutoff current (div 100) |
| `0x28`       | **C-CV continue** | Same format as C-CV start                                                        |
| `0x31`       | **C-NiMh start**  | bytes 2-3 = current, bytes 4-5 = cutoff                                         |
| `0x41`       | **C-NiCD start**  | bytes 2-3 = current, bytes 4-5 = cutoff                                         |
| `0x51`       | **C-LiPo start**  | bytes 2-3 = current, bytes 4-5 = cutoff                                         |
| `0x61`       | **C-LiFe start**  | bytes 2-3 = current, bytes 4-5 = cutoff                                         |
| `0x71`       | **C-VRLA start**  | bytes 2-3 = current, bytes 4-5 = cutoff                                         |

### Example: Init

```
FA 05 00 00 00 00 00 00 05 F8
```

### Example: Start load at 1.000A, cutoff 3.00V (EBD-USB+, D-CC)

```
Current: 1.000 A × 10000 = 10000
  hi = 10000 / 240 = 41  (0x29)
  lo = 10000 % 240 = 160 (0xA0)

Cutoff:  3.00 V × 100 = 300
  hi = 300 / 240 = 1     (0x01)
  lo = 300 % 240 = 60    (0x3C)

Packet: FA 01 29 A0 01 3C 00 00 [XOR] F8
```

### Example: Start D-CP discharge at 5W, cutoff 2.50V, 1 minute (EBC-A40L)

```
Power:  5 W → raw value 5
  hi = 5 / 240 = 0      (0x00)
  lo = 5 % 240 = 5      (0x05)

Cutoff: 2.50 V × 100 = 250
  hi = 250 / 240 = 1    (0x01)
  lo = 250 % 240 = 10   (0x0A)

Time:   1 minute → raw value 1
  hi = 1 / 240 = 0      (0x00)
  lo = 1 % 240 = 1      (0x01)

Packet: FA 11 00 05 01 0A 00 01 1E F8
```

> **D-CP power encoding:** The power value is encoded as the raw wattage (no divisor). 5W → 5, not 500. This is different from current encoding (where 5A → 500 with divisor 100). Confirmed by matching the TX frame with the UI's "Test Val: 5.00 W" field.

### Example: Resistance test at 5A (EBC-A40L)

```
Current: 5.00 A × 100 = 500
  hi = 500 / 240 = 2    (0x02)
  lo = 500 % 240 = 20   (0x14)

Packet: FA 09 02 14 00 00 00 00 1F F8
```

> **VB6 limitation:** The resistance test current field is stored as VB6 `Integer` (signed 16-bit), capping at 32767 mA (32.76A). The protocol can encode up to 57599 (575.99A at ÷100), but the VB6 app silently rejects values ≥ 32768. The device's actual max current (40A for EBC-A40L) is within the VB6 limit, so this only matters for >32A devices.

### Example: Start C-CV charge at 4.00A, 3.50V, cutoff 0.10A (EBC-A40L)

```
Current: 4.00 A × 100 = 400
  hi = 400 / 240 = 1     (0x01)
  lo = 400 % 240 = 160   (0xA0)

Voltage: 3.50 V × 100 = 350
  hi = 350 / 240 = 1     (0x01)
  lo = 350 % 240 = 110   (0x6E)

Cutoff:  0.10 A × 100 = 10
  hi = 10 / 240 = 0      (0x00)
  lo = 10 % 240 = 10     (0x0A)

Packet: FA 21 01 A0 01 6E 00 0A E5 F8
```

> **C-CV mode payload uses all 3 field pairs:** max charging current (bytes 2-3), target charge voltage (bytes 4-5), and minimum current cutoff (bytes 6-7). The charger applies constant current until the target voltage is reached, then holds voltage while current tapers. Charging stops when current drops below the cutoff.

### Example: Calibrate Low Voltage at 3.800V

```
Value: 3.800 V × 1000 = 3800 (calibration always uses ÷1000)
  hi = 3800 / 240 = 15    (0x0F)
  lo = 3800 % 240 = 200   (0xC8)

Packet: FA 04 00 0F C8 00 00 00 C3 F8
             │  └───┘
             │  value = 3800 → 3.800V
             └── point 0x00 = Low Volt
```

> **Calibration encoding:** All four calibration points (Low/High Volt, Low/High Curr) encode the reference value as millivolts or milliamps (÷1000), unlike the normal protocol which uses ÷100 for current and ÷1000 for voltage. The VB6 dialog enables voltage buttons only at idle and current buttons only during an active test.

### Heartbeat Sequence Counter

The heartbeat command carries a sequence counter in byte 3:

```
FA 0A 00 01 00 00 00 00 0B F8   — heartbeat #1
FA 0A 00 02 00 00 00 00 08 F8   — heartbeat #2
```

The EB Tester sends heartbeats approximately every 60 seconds during active tests.

### QC/PD Mode Commands (CMD `0x07`)

| Byte 7 | Function       | Full Packet                          |
| ------ | -------------- | ------------------------------------ |
| `0x0A` | QC2.0 5V       | `FA 07 00 00 00 00 00 0A 0D F8`     |
| `0x0B` | QC2.0 9V       | `FA 07 00 00 00 00 00 0B 0C F8`     |
| `0x0C` | QC2.0 12V      | `FA 07 00 00 00 00 00 0C 0B F8`     |
| `0x0D` | QC2.0 20V      | `FA 07 00 00 00 00 00 0D 0A F8`     |
| `0x0E` | QC3.0 enter    | `FA 07 00 00 00 00 00 0E 09 F8`     |
| `0x0F` | QC3.0 +0.2V    | `FA 07 00 00 00 00 00 0F 08 F8`     |
| `0x10` | QC3.0 -0.2V    | `FA 07 00 00 00 00 00 10 17 F8`     |
| `0x14` | MTK-PE minus   | `FA 07 00 00 00 00 00 14 13 F8`     |
| `0x15` | MTK-PE plus    | `FA 07 00 00 00 00 00 15 12 F8`     |

QC/MTK commands produce no device response — success is indicated by a voltage change in subsequent measurement frames. These QC/PD commands only apply to the **EBD-USB+** model.

## Supported Device Family

The EB Tester v1.8.9 software supports **58 device models** (22 EBC chargers, 36 EBD loads). The device name strings are stored in two pools in the VB6 binary:

- **Main table** at offset `0x1E634`: 51 models (indices 0–50)
- **Extended table** at offset `0x1F64C`: 7 additional variant models (indices 51–57)

> **Device identification:** The EB Tester identifies the connected device from **byte 16 of every RX frame** — the "device ID byte" (previously called the "device constant"). Bytes 14 and 15 — previously suspected as type/subtype — are actually device-capability fields that the UI does **not** use for name lookup. See [Device Identification](#device-identification) below for the empirical mapping.

### Complete Device List (in binary string table order)

| Index | Hex  | Family | Model          |
| ----: | ---- | ------ | -------------- |
|     0 | 0x00 | EBC    | EBC-A          |
|     1 | 0x01 | EBC    | EBC-AH         |
|     2 | 0x02 | EBC    | EBC-B          |
|     3 | 0x03 | EBC    | EBC-BH         |
|     4 | 0x04 | EBC    | EBC-A10        |
|     5 | 0x05 | EBC    | EBC-B10        |
|     6 | 0x06 | EBD    | EBD-A          |
|     7 | 0x07 | EBD    | EBD-AH         |
|     8 | 0x08 | EBD    | EBD-B          |
|     9 | 0x09 | EBD    | EBD-BH         |
|    10 | 0x0a | EBD    | EBD-A10        |
|    11 | 0x0b | EBD    | EBD-A15        |
|    12 | 0x0c | EBD    | EBD-A2S        |
|    13 | 0x0d | EBD    | EBD-A5S        |
|    14 | 0x0e | EBD    | EBD-A20H       |
|    15 | 0x0f | EBD    | EBD-P10        |
|    16 | 0x10 | EBD    | EBD-P15        |
|    17 | 0x11 | EBD    | EBD-B10H       |
|    18 | 0x12 | EBD    | EBD-M02        |
|    19 | 0x13 | EBD    | EBD-USB+       |
|    20 | 0x14 | EBD    | EBD-USB        |
|    21 | 0x15 | EBD    | EBD-B20H       |
|    22 | 0x16 | EBC    | EBC-B20H       |
|    23 | 0x17 | EBC    | EBC-B50        |
|    24 | 0x18 | EBD    | EBD-B40H       |
|    25 | 0x19 | EBD    | EBD-A50H       |
|    26 | 0x1a | EBD    | EBD-A40L       |
|    27 | 0x1b | EBD    | EBD-A30H       |
|    28 | 0x1c | EBD    | EBD-P30H       |
|    29 | 0x1d | EBD    | EBD-A01        |
|    30 | 0x1e | EBC    | EBC-A01        |
|    31 | 0x1f | EBC    | EBC-A100L      |
|    32 | 0x20 | EBD    | EBD-B30H       |
|    33 | 0x21 | EBC    | EBC-A5M        |
|    34 | 0x22 | EBD    | EBD-A5D        |
|    35 | 0x23 | EBD    | EBD-M          |
|    36 | 0x24 | EBC    | EBC-A05+       |
|    37 | 0x25 | EBC    | EBC-A05        |
|    38 | 0x26 | EBC    | EBC-A20+       |
|    39 | 0x27 | EBC    | EBC-A20        |
|    40 | 0x28 | EBC    | EBC-A50L       |
|    41 | 0x29 | EBC    | EBC-A40L       |
|    42 | 0x2a | EBD    | EBD-M03+       |
|    43 | 0x2b | EBD    | EBD-M05        |
|    44 | 0x2c | EBD    | EBD-M03        |
|    45 | 0x2d | EBD    | EBD-M10        |
|    46 | 0x2e | EBD    | EBD-A10H       |
|    47 | 0x2f | EBC    | EBC-A10+       |
|    48 | 0x30 | EBC    | EBC-A10H       |
|    49 | 0x31 | EBD    | EBD-A100L      |
|    50 | 0x32 | EBD    | EBD-A100       |
|    51 | 0x33 | EBC    | EBC-A40L-40A   |
|    52 | 0x34 | EBD    | EBD-A20H-200W  |
|    53 | 0x35 | EBD    | EBD-B20H-72V3  |
|    54 | 0x36 | EBC    | EBC-B20H-72V3  |
|    55 | 0x37 | EBC    | EBC-B20H-108V3 |
|    56 | 0x38 | EBD    | EBD-B30H-72V3  |
|    57 | 0x39 | EBD    | EBD-B10H-V3    |

## Device Identification

The EB Tester identifies the connected device by reading **byte 16 of every RX frame** — called the *device ID byte* throughout this doc (equivalent to `frame[16]` or `payload[15]` depending on where you count from). The UI uses this single byte to look up the displayed device name and the set of available operating modes from an internal table.

Two clarifications versus earlier hypotheses:

1. **Bytes 14 and 15 on the info packet** (`0x11`, `0x86` on EBC-A40L) are **not** the device identifier. They are capability / revision fields that the UI ignores for name lookup. Confirmed by probing: we can leave them at `0x00` and the UI still shows the correct device based on byte 16.
2. **Byte 16 is not an index into the binary string table.** The per-const name sequence does not match either the main table at `0x1E634` or the extended table at `0x1F64C`. A separate indirection must exist in the VB6 code.

### Empirical mapping

Established via fake-device probing in April 2026. The probe script (`scripts/probe-devices.ts`) increments the fake device's byte-16 value while observing the device name that appears in EB Tester's device-selection grid. Reference device is EBC-A40L (byte 16 = `0x0A`). The raw sweep output (174 screenshots, OCR'd and manually cross-checked) lives under `scripts/probes/2026-04-22_00-44-35-byte16/`; the curated mapping is in `device-names.curated.json`.

**The primary byte16 range 0x01–0x2A covers 42 distinct devices:**

| byte 16 | Device         | byte 16 | Device         | byte 16 | Device          |
| ------- | -------------- | ------- | -------------- | ------- | --------------- |
| `0x00`  | "No Device"    | `0x0F`  | EBD-A10        | `0x1E`  | EBD-B40H        |
| `0x01`  | EBC-A          | `0x10`  | EBD-A15        | `0x1F`  | EBD-A50H        |
| `0x02`  | EBC-AH         | `0x11`  | EBD-A2S        | `0x20`  | EBD-A40L        |
| `0x03`  | EBC-B          | `0x12`  | EBD-A5S        | `0x21`  | EBD-A30H        |
| `0x04`  | EBC-BH         | `0x13`  | EBD-A20H       | `0x22`  | EBD-P30H        |
| `0x05`  | EBC-A05        | `0x14`  | EBD-A10H       | `0x23`  | EBD-A01         |
| `0x06`  | EBC-A10H       | `0x15`  | EBD-P10        | `0x24`  | EBC-A01         |
| `0x07`  | EBC-A10        | `0x16`  | EBD-P15        | `0x25`  | EBC-A100L       |
| `0x08`  | EBC-B10        | `0x17`  | EBD-B10H       | `0x26`  | EBD-A100        |
| `0x09`  | EBC-A20        | `0x18`  | EBD-M02        | `0x27`  | EBD-B30H        |
| `0x0A`  | **EBC-A40L** ★ | `0x19`  | EBD-M03        | `0x28`  | EBC-A5M         |
| `0x0B`  | EBD-A          | `0x1A`  | EBD-USB        | `0x29`  | EBD-A5D         |
| `0x0C`  | EBD-AH         | `0x1B`  | EBD-B20H       | `0x2A`  | EBD-M           |
| `0x0D`  | EBD-B          | `0x1C`  | EBC-B20H       |         |                 |
| `0x0E`  | EBD-BH         | `0x1D`  | EBC-B50        |         |                 |

★ Reference device — cross-validated against the physical EBC-A40L.

**The rest of the 0x00–0xEF space:**

| Range           | Behaviour                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `0x2B`–`0x64`   | All 58 values display **"No Device"**. Verified directly via OCR of each probe screenshot.                                                                                                                                                                                                                                                      |
| `0x65`–`0x8E`   | **Mirror** of `0x01`–`0x2A` — byte `N+0x64` produces the same device name as byte `N`. Confirmed for every pair where both probes captured cleanly; no mirror mismatches found.                                                                                                                                                                 |
| `0x8F`–`0xEF`   | All 97 values display **"No Device"**. OCR row 1 reads "No Device" on every probe. (Some of the screenshots still show a device name in row 2 from UI display latching — that's a VB6 grid artefact, not a real mapping.) Provenance: `0x8F`–`0xB8` from the original 2026-04-22 sweep; `0xB9`–`0xDC` from the 2026-04-22T18:00Z re-sweep; `0xDD`–`0xEF` from the 2026-04-22T22:30Z third re-sweep (run in two short bursts after a fresh session unlock, screenshots at 1.5× DPI merged in via OCR with scaled row regions). |

### Mode information

Modes are known only for a handful of bytes (0x01–0x0B), from earlier sweeps that recorded mode-set patterns. The 2026-04-22 sweep captured device names only; modes will be re-captured in a follow-up sweep. See `PLAN-protocol-exercise.md`.

| byte 16 | Available modes                                     |
| ------- | --------------------------------------------------- |
| `0x01`  | D-CC, D-CP, C-CV, C-NiMh, C-LiPo, C-NiCD, C-LiFe    |
| `0x02`–`0x04` | (same 7 modes)                                |
| `0x05`  | D-CC, D-CP, C-CV, C-NiMh, C-LiPo, C-NiCD, C-LiFe, DC5V |
| `0x06`  | 8 modes (specifics not re-captured)                 |
| `0x07`  | D-CC, D-CP, C-CV                                    |
| `0x08`  | D-CC, C-CV                                          |
| `0x09`  | D-CC, D-CP, C-CV                                    |
| `0x0A`  | D-CC, D-CP, C-CV                                    |
| `0x0B`  | D-CC, D-CP, C-CV, Meter, D-CV                       |

### Canonical devices not yet mapped to byte16

The binary's DeviceTable at offset `0x1E634`/`0x1F64C` lists 58 distinct names (see `scripts/device-table.json`). The 2026-04-22 sweep mapped 42 of them to byte16 values. The 2026-04-22T22:30Z third re-sweep closed the remaining gap by confirming all 19 values `0xDD`–`0xEF` also read "No Device", completing the characterisation of the full `0x00`–`0xEF` byte16 space. That leaves the following 16 canonical devices with **no byte16 home anywhere in the mapped space**:

`EBD-USB+`, `EBC-A05+`, `EBC-A20+`, `EBC-A50L`, `EBD-M03+`, `EBD-M05`, `EBD-M10`, `EBC-A10+`, `EBD-A100L`, `EBC-A40L-40A`, `EBD-A20H-200W`, `EBD-B20H-72V3`, `EBC-B20H-72V3`, `EBC-B20H-108V3`, `EBD-B30H-72V3`, `EBD-B10H-V3`.

Because every byte16 value is now accounted for, these 16 devices must be selected by a mechanism other than byte16 alone. The most plausible candidate is info-packet bytes 14/15 magic gating — especially for the `+` and `-V3` / `-72V3` / `-108V3` / `-200W` variants, which look like capability annotations layered on top of a base model. The 2026-04-22T07:44Z sweep observed that `(byte14=0xEF, byte15=0xEF, byte16=0x0A)` showed **EBC-A** instead of EBC-A40L, which is concrete evidence that bytes 14/15 can override the byte16 lookup in at least one corner of the parameter space (see Open Questions below).

### Open questions

1. **Where do the 16 unmapped canonical devices live?** The full `0x00`–`0xEF` byte16 space is now characterised, and none of it maps to `EBD-USB+`, `EBC-A05+`, `EBC-A20+`, `EBC-A50L`, `EBD-M03+`, `EBD-M05`, `EBD-M10`, `EBC-A10+`, `EBD-A100L`, `EBC-A40L-40A`, `EBD-A20H-200W`, `EBD-B20H-72V3`, `EBC-B20H-72V3`, `EBC-B20H-108V3`, `EBD-B30H-72V3`, or `EBD-B10H-V3`. They must be selected by bytes 14/15 (see #2), by a launch flag or registry setting, or by something other than the info packet entirely. See `PLAN-ui-exploration.md` task 1.4.
2. **Why does `(0xEF, 0xEF, 0x0A)` show EBC-A?** Observed in an earlier sweep. One-off, or a hidden rule that kicks in for specific byte-14/15 magic values? This is now the leading candidate mechanism for the 16 unmapped canonical devices (the `+` and `-V3` variants) — they may be gated by byte 14/15 magic on top of an already-mapped byte16.
3. **Relationship to the binary string tables** at `0x1E634` and `0x1F64C` — which indirection table maps byte 16 → string index? The empirical order of our captured 42 devices does not linearly match either table.
4. **Behaviour against an EBD-family fake device.** All probing was done against an EBC profile; an EBD profile may expose a different branch in EB Tester's identification code.
5. **Semantics of info-packet bytes 14 + 15.** Confirmed NOT to drive the displayed name on their own; likely capability / firmware-revision fields OR overrides that only fire for specific magic values (see #2). An EBC-A40L emits `0x11, 0x86`; values from other physical devices would clarify.

## Operating Modes

The software defines distinct operating modes for discharge (D-*) and charge (C-*):

### Discharge Modes

| Mode   | Description              |
| ------ | ------------------------ |
| `D-CC` | Constant Current discharge |
| `D-CP` | Constant Power discharge   |
| `D-CV` | Constant Voltage discharge |

### Charge Modes

| Mode      | Description              | Per-cell voltage constant |
| --------- | ------------------------ | ------------------------- |
| `C-NiMh`  | Nickel-Metal Hydride     | 1.450 V (@ 0x158C)       |
| `C-NiCD`  | Nickel-Cadmium           | — (likely similar)        |
| `C-Liion`  | Lithium-Ion              | 4.477 V (@ 0x1474)      |
| `C-LiPo`  | Lithium Polymer          | (shares Li-ion profile)   |
| `C-LiFe`  | Lithium Iron Phosphate   | 3.793 V (@ 0x168C)       |
| `C-VRLA`  | Valve-Regulated Lead-Acid | 2.125 V (@ 0x1684)      |
| `C-PB`    | Lead-acid (flooded)      | 2.062 V (@ 0x1694)       |
| `C-CV`    | Constant Voltage charge  | —                         |
| `C-CC`    | Constant Current charge (implied by "Please select CC mode") | — |

Additional float constants in the VB6 binary suggest device-specific limits:
- `2800.0` (@ 0x16A0) — likely max capacity in mAh
- `150.0` (@ 0x16A4) — likely max current in 100mA units (15.0A)
- `500.0` (@ 0x16A8) — likely max power in 100mW units (50W)
- `50.0` (@ 0x16AC) — likely max voltage (50V)
- `2.469 V` (@ 0x169C) — possibly a chemistry-specific per-cell constant

### Step Test

The software supports programmable step sequences (`frmCtrlPrg` / `frmRunPrg`):
- Each step can be: **D-CC**, **D-CP**, **D-CV**, **C-NiMh**, **C-NiCD**, **C-LiPo**, **C-LiFe**, **C-VRLA**, **C-PB**, **C-CV**, **Wait**, or **Cycle**
- Step files saved as `.stp` format
- Step 1 cannot be "Wait" or "Cycle"
- Supports repeat/cycle with configurable cycle count

### Cycle Test

Automated charge/discharge cycling with cutoff conditions:
- Cutoff by voltage (`Cutoff Volt`, `Cutoff V`)
- Cutoff by current (`Cutoff Curr`)
- Cutoff by time (`Max Time`)

> **Confirmed by serial capture (Apr 2026, fake-device session):** Cycle/step sequencing is **fully host-driven**. The device has no awareness of multi-step programs. The EB Tester PC software:
>
> 1. Sends a normal mode-specific **start** command for step 1 (e.g. `0x01` D-CC, `0x21` C-CV) with that step's setpoints.
> 2. Runs a client-side timer for the step's time cutoff.
> 3. When a cutoff triggers (time, voltage, or current), sends `0x02` **Load toggle** to halt the device.
> 4. For `Wait` steps — emits **no** serial traffic; just sleeps client-side for the configured minutes.
> 5. For `Cycle` steps — emits **no** serial traffic; loops the step pointer back to the start of the previous block client-side.
> 6. Advances to the next step and repeats.
>
> Therefore, a cycle-test TX trace is indistinguishable from a sequence of Single-Test Start/Stop cycles.
>
> **Mode palette** (from `Parameter Setting` dialog ComboBox enumeration on EBC-A40L): `D-CC`, `D-CP`, `C-CV`, `Wait`, `Cycle`. `Wait` uses only the Cutoff field (minutes); `Cycle` uses the Cutoff field as a loop count.

### UI Button → Serial Command (confirmed on EBC-A40L)

Verified via pywinauto driving the EB Tester GUI while the fake-device captured TX frames:

| UI element (tab)          | On click                                      | TX command |
| ------------------------- | --------------------------------------------- | ---------- |
| `Connect`                 | initial handshake                             | `0x05` init |
| `Disconn` (+ Yes on prompt) | two frames: halt then stop                  | `0x02` load toggle, then `0x06` stop |
| Single Test `Start` (C-CV) | current-V-cutoff payload                     | `0x21` |
| Single Test `Start` (D-CC) | current / cutoff-V / time payload            | `0x01` |
| Single Test `Start` (D-CP) | power / cutoff-V / time payload              | `0x11` |
| Single Test `Continue` (D-CC) | same payload format as Start              | `0x08` |
| Single Test `Continue` (D-CP) | same payload format as Start              | `0x18` |
| Single Test `Continue` (C-CV) | same payload format as Start              | `0x28` |
| Single Test `Adjust`        | update setpoints mid-run                    | `0x07` (mode-independent configure; **distinct from** the QC/PD use of `0x07` on EBD-USB+) |
| Single Test `Stop`          | pauses output; **no confirmation dialog**   | `0x02` load toggle |
| Single Test `Monitor`       | UI-only (toggles chart y-autoscale)          | — (no TX) |
| Cycle Test `Start`          | start first step                             | (first step's mode-appropriate start) |
| Cycle Test `Stop`           | halt cycle                                   | `0x02` load toggle |
| Setting dialog `OK`/`Cancel`/`Add`/`Clear` | client-side only                | — (no TX) |
| Toolbar icon 1 (folder)     | opens Curve Data + Curve Type dialog         | — (no TX) |
| Toolbar icon 2 (disk)       | Save (no-op when no run data)                | — (no TX) |
| Toolbar icon 3 (image)      | opens "Save Picture" file dialog             | — (no TX) |
| Toolbar icon 4 (wrench)     | opens "Display Setting" chart config         | — (no TX) |
| Toolbar icon 5 (magnifier)  | no visible effect (zoom/query query?)        | — (no TX) |
| Toolbar icon 6 (info)       | opens "About Software" dialog                | — (no TX) |
| `Chn1`/`Chn2`/`All Channel` radios | hidden on single-channel devices; no effect on EBC-A40L | — (no TX) |

> **Important clarification:** The `Stop` button in the UI sends `0x02` (load toggle), **not** `0x06`. The mode-independent `0x06` stop command is emitted only from the `Disconn` confirmation path. This matters for the server implementation — a client asking to "stop" a test should emit `0x02`; `0x06` is reserved for fully disconnecting the measurement stream.

## Device → Host Response (19 bytes)

The response layout is **model-dependent**. The frame format and base-240 encoding are shared, but specific byte meanings differ between EBD-USB+ and EBC charger models.

### EBD-USB+ Response Layout (from sigrok)

```
Byte 0:      0xFA       — frame start
Byte 1:      STATE      — device state
Bytes 2-3:   Current    (base-240, ÷10000 → A)
Bytes 4-5:   Voltage    (base-240, ÷1000  → V)
Bytes 6-7:   D+ voltage (base-240, ÷1000  → V)
Bytes 8-9:   D- voltage (base-240, ÷1000  → V)
Bytes 10-11: Current limit setting (when load active)
Bytes 12-13: UVC threshold setting (when load active)
Bytes 14-16: (reserved / model-dependent)
Byte 17:     XOR checksum (bytes 1-16)
Byte 18:     0xF8       — frame end
```

### EBC Charger/Discharger Response Layout (confirmed on EBC-A40L)

Verified by cross-referencing serial captures with EB Tester GUI screenshots and LCD display readings.

```
Byte 0:      0xFA       — frame start
Byte 1:      STATE      — device state (see state table below)
Bytes 2-3:   Current    (base-240, ÷100 → A)  — actual current flowing
Bytes 4-5:   Voltage    (base-240, ÷1000 → V) — actual terminal voltage
Bytes 6-7:   Capacity   (base-240, raw = mAh) — accumulated mAh (device-computed)
Bytes 8-9:   Energy (mWh)           (base-240, raw = mWh) — always 0 on EBC-A40L captures so far; may be populated on other models
Bytes 10-11: Setpoint echo          (base-240) — current (÷100→A) for D-CC/C-CV, power (raw=W) for D-CP
Bytes 12-13: Cutoff voltage echo    (base-240, ÷100 → V)
Byte 14:     Step number            (0x00 for single test)
Byte 15:     Max time / cutoff echo (raw = minutes for D-CC/D-CP; cutoff current ÷100→A for C-CV)
Byte 16:     Device ID              (0x0A on EBC-A40L — see Device Identification)
Byte 17:     XOR checksum (bytes 1-16)
Byte 18:     0xF8       — frame end
```

> **Capacity (bytes 6-7):** The raw base-240 value equals mAh directly. At 4.00A for 62 seconds, the expected capacity is 68.9 mAh — the device reports raw value 68. At 3.00A for 145.6 seconds, the expected capacity is 121.3 mAh — the device reports raw value 121. Unlike the EBD-USB+ where the host computes capacity by integration, **EBC devices track capacity internally**.

> **Setpoint echo (bytes 10-15):** During idle, these fields retain the last test's configured setpoints. During an active test, they echo the current test's parameters. The encoding of bytes 10-11 and 15 depends on the mode:
> - **D-CC:** bytes 10-11 = current setpoint (÷100 → A), byte 15 = max time (minutes)
> - **D-CP:** bytes 10-11 = power setpoint (raw = W), byte 15 = max time (minutes)
> - **C-CV:** bytes 10-11 = current limit (÷100 → A), byte 15 = cutoff current (÷100 → A)
>
> Confirmed by matching D-CP real-hardware captures: setting 5W / 2.50V / 1min produced bytes 10-11 = `00 05` (5W), 12-13 = `01 0A` (250 → 2.50V), byte 15 = `01` (1 min).

> **Bytes 8-9:** Always 0 in all EBC-A40L captures (idle, charging, and discharging). The EB Tester UI computes and displays Energy (mWh) client-side. These bytes may carry energy or temperature on other EBC models, but are unused on the A40L.

### Device Info / Identification Packet (state + 0x64)

After receiving an init command (CMD 0x05), the device sends **alternating** responses: one normal data packet, then one info packet with state = normal_state + 0x64. The info packet uses a different mapping for bytes 10-16:

```
Bytes 10-11: Device capability 1  (base-240) — possibly max current
Bytes 12-13: Device capability 2  (base-240, ÷100 → 5.00V on A40L) — possibly max voltage
Byte 14:     Extra capability byte (0x11 on EBC-A40L — NOT used by UI for name lookup; see Device Identification)
Byte 15:     Extra capability byte (0x86 on EBC-A40L — NOT used by UI for name lookup; see Device Identification)
Byte 16:     Device ID            (0x0A = 10, same as normal packets — see Device Identification)
```

> The info packet alternation stops once a test is started. It resumes when the EB Tester reconnects and sends a new init command.

### State Byte (byte 1)

#### EBD-USB+ States (from sigrok)

| Value  | Meaning                  |
| ------ | ------------------------ |
| `0x00` | Measuring, load **OFF**  |
| `0x64` | Load OFF — **info packet** (alternate) |
| `0x0A` | Measuring, load **ON**   |
| `0x6E` | Load ON — **info packet** (alternate)  |

#### EBC Charger States (confirmed on EBC-A40L)

| Value  | Hex    | Info variant | Mode (EB Tester UI) | Meaning                  |
| ------ | ------ | ------------ | ------------------- | ------------------------ |
| `0`    | `0x00` | `0x64`       | idle (EBD / post-power-on)          | Idle — device just powered on, no test configured. Also seen on real EBC-A40L before first init. |
| `1`    | `0x01` | `0x65`       | idle (post-test)                    | Idle — test completed or stopped. Device retains last test's setpoints and capacity. |
| `2`    | `0x02` | `0x66`       | idle / C-CV ready                   | Idle / monitoring — test not running, connected |
| `10`   | `0x0A` | `0x6E`       | **D-CC running (Adjust enabled)**   | Discharging, constant current — "phase 1" |
| `11`   | `0x0B` | `0x6F`       | **D-CP running**                    | Discharging, constant power — "phase 1" |
| `12`   | `0x0C` | `0x70`       | **C-CV running**                    | Charging, constant-voltage mode — "phase 1" |
| `20`   | `0x14` | `0x78`       | **D-CC running (Adjust enabled)**   | Discharging, constant current — "phase 2" |
| `21`   | `0x15` | `0x79`       | **D-CP time-complete** (transitional) | Discharging constant power — max time reached. Appears for one frame before transitioning to 0x01 (idle). |
| `22`   | `0x16` | `0x7A`       | **C-CV running / charge complete**  | Charging CV / terminal phase — "phase 2" |

> **Verified April 2026 by fake-device injection + UI observation.** Each mode emits one of two state bytes (X or X+10 decimal); the EB Tester GUI treats both the same — it only cares about whether the test is running and which mode. The second variant is likely the device's "CC → CV transition" (for charge) or "CP → terminal" (for discharge); real-hardware captures will pin down the exact semantics. `0x16` was previously documented as "charge complete" but behaves identically to `0x0C` in the UI, so it's better characterized as "CV / final phase".
>
> Adjust-mid-run is only enabled when the state byte indicates **D-CC** (`0x0a`, `0x14` or their info variants). `D-CP` and `C-CV` tests cannot be adjusted mid-run — the UI disables the button. The device accepts the `0x07` adjust frame regardless; the restriction is purely cosmetic.

> **Info-packet rule:** info state = normal state + `0x64` (100 decimal), mod 240. Confirmed for all observed running states (0x0A→0x6E, 0x0B→0x6F, 0x0C→0x70, 0x14→0x78, 0x15→0x79, 0x16→0x7A) as well as idle (0x02→0x66). Matches EBD-USB+ pattern (0x00→0x64, 0x0A→0x6E).
>
> **Idle state:** any state byte outside the "running" set (0x0A, 0x0B, 0x0C, 0x14, 0x15, 0x16) — including 0x00, 0x01, 0x03-0x09, 0x0D-0x13, 0x17+, 0xEE, etc. — is treated as idle. The UI re-enables Start/Continue/Monitor, greys out Stop, and unlocks the Mode dropdown.

> **Unresolved error states:** the EB Tester binary has error strings `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn` — these must be associated with specific state byte values we haven't captured. Candidates: the unreached values above `0x16` in the "running" modulo-10 cycle (e.g. `0x1E` = 0x14 + 0x0A, `0x20` = 0x16 + 0x0A), but none of those triggered a distinct UI behavior during fake-device probing. Error states may require specific payload patterns (bad checksum, out-of-range setpoints, etc.) rather than a distinct state byte.

## Implementation Notes

- **Send bytes individually** with ~10ms delay between each byte. The device's UART buffer is small and it drops bytes if sent too fast.
- **All payload values must be < 0xF0 (240)** to avoid colliding with the frame markers 0xFA and 0xF8.
- **Parse the incoming stream continuously** — do not assume fixed-length alignment. Scan for 0xFA, validate length and checksum.
- **Resend commands** if no expected response arrives within a reasonable timeout.
- **The device can lock up** and stop responding. The only recovery is a USB replug.
- The VB6 application uses `MSComm1` (Microsoft Communications Control 6.0) with `InputMode = comInputModeBinary`.

## UI Measurements (from VB6 application)

The EB Tester software displays these values, derived from the response frames:

| UI Label     | Display Format | Source                    | Unit |
| ------------ | -------------- | ------------------------- | ---- |
| Voltage      | `00.000`       | Response bytes 4-5        | V    |
| Volt/Cells   | —              | Voltage / cell count      | V    |
| Current      | `0.0000`       | Response bytes 2-3        | A    |
| Cur(mA)      | `[mA]`         | Current × 1000            | mA   |
| Capacity     | —              | Accumulated (host-side)   | mAh  |
| Energy       | —              | Accumulated (host-side)   | mWh  |
| Temperature  | `000.0`        | Response bytes 6-7 (EBC)  | C    |
| D+ Voltage   | `0.000`        | Response bytes 6-7 (USB+) | V    |
| D- Voltage   | `0.000`        | Response bytes 8-9 (USB+) | V    |
| Resistance   | —              | Computed (V/I)            | ohm  |
| Power        | —              | Computed (V*I)            | W    |
| Avg Volt     | —              | Running average           | V    |
| Begin Volt   | —              | First reading             | V    |
| Cutoff Volt  | `00.00`        | User setting              | V    |
| Cutoff Curr  | —              | User setting              | A    |
| Max Time     | —              | User setting              | S    |
| Time         | —              | Elapsed test time         | S    |
| Cells        | —              | User setting              | count |
| Step         | —              | Current step number       | —    |
| Cycle        | —              | Current cycle number      | —    |

**Idle/error display:** `-.---` is shown when no device is connected or readings are invalid. Initial values are `00.000` for voltage, `0.0000` for current.

**Data log columns:** The header line written to `.dat`/`.csv` files is `V--A--mAh` or `V--A--Second`, indicating the primary logged fields are Voltage, Current, and either accumulated capacity or elapsed time.

Capacity (mAh) and Energy (mWh) are **not transmitted by the device** — they are accumulated by the host software by integrating current and power over time.

## VB6 Application Structure

The original application (`eb_setup_v1.8.9en_202507.exe`, extracted from Setup Factory installer) is a VB6 (Visual Basic 6) compiled executable with these forms:

| Form           | Purpose                           |
| -------------- | --------------------------------- |
| `frmMain`      | Main window                       |
| `frmCom`       | COM port settings                 |
| `frmUSB`       | USB Quick Charge control          |
| `frmCtrl`      | Manual control (CC mode)          |
| `frmCtrlAuto`  | Auto control                      |
| `frmCtrlPrg`   | Programmatic/step control         |
| `frmCtrl2S`    | 2-channel control                 |
| `frmRun`       | Test run display                  |
| `frmRunAuto`   | Auto test run display             |
| `frmRunPrg`    | Programmatic test run             |
| `frmRun2S`     | 2-channel test run                |
| `frmCurve`     | Curve/graph display               |
| `frmCurve2`    | Secondary curve display           |
| `frmData`      | Data logging view                 |
| `frmSet`       | Settings                          |
| `frmRes`       | Resistance test                   |
| `frmMeter`     | Meter/gauge display               |
| `frmVol`       | Voltage display                   |
| `frmCur`       | Current display                   |
| `frmType`      | Device type selection             |
| `frmDev`       | Device info                       |
| `frmAdj`       | Calibration adjustment            |
| `frmColor`     | Color settings                    |
| `frmDisp`      | Display settings                  |
| `frmAbout`     | About dialog                      |
| `frmMsg`       | Message dialog                    |
| `frmShow`      | Show/display window               |
| `frmBanner`    | Banner/splash                     |
| `frmLogo`      | Logo display                      |
| `frmUpdate`    | Software update                   |
| `modSocketMaster` | TCP/IP socket module (CSocketMaster) |

Key controls: `MSComm1` (serial port), `tmrComm` (polling timer), `cmSocket` (network socket for remote mode).

## What's Known vs. What Needs Traffic Capture

### Confirmed across all models (from binary + sigrok)

- Frame format: `0xFA [payload] [XOR checksum] 0xF8`
- Base-240 encoding for multi-byte values
- Serial: 9600 baud, 8 data bits, even parity
- Host→Device: 10 bytes, Device→Host: 19 bytes
- Commands: `0x05` init, `0x06` stop, `0x02` toggle
- Command byte encoding: `mode_offset + action` (see command table)
- Info packet alternation pattern: state + 0x64

### Confirmed for EBD-USB+ (from sigrok)

- Response byte mapping (current ÷10000, voltage ÷1000, D+, D-, limits)
- State byte values (0x00, 0x0A, 0x64, 0x6E)
- QC/PD mode commands (0x07)

### Confirmed for EBC-A40L (from serial captures, Apr 2026)

- **Current divisor is 100** (not 10,000) — format `00.00`, 10 mA resolution
- **CMD 0x21 = C-CV charge start** — payload: current (÷100), voltage (÷100), cutoff current (÷100)
- **State 0x02 = idle**, **0x0C = charging active**, **0x66 = info packet**
- **Response bytes 6-7 = capacity in mAh** (raw base-240 value, device-computed)
- **Response bytes 8-9 = always 0** (unknown/unused on A40L)
- **Response bytes 10-11 = current setpoint echo** (÷100)
- **Response bytes 12-13 = voltage setpoint echo** (÷100)
- **Response byte 14 = step number** (0 for single test)
- **Response byte 15 = cutoff current echo** (÷100)
- **Response byte 16 = device ID byte** (0x0A on EBC-A40L) — confirmed via fake-device probing to be the primary identifier the EB Tester uses to look up device name and available modes. See [Device Identification](#device-identification).
- **Heartbeat byte 3 = sequence counter** (1, 2, 3, ...)
- **Idle packets retain last test's setpoints and accumulated capacity**
- **Info packet bytes 14-15 are device-capability fields** (0x11, 0x86 on EBC-A40L) — NOT the device identifier. The UI ignores them for name lookup; byte 16 is the ID. Best current guess for 14/15 is "max current + firmware revision", unverified.
- **State 0x00 = idle (pre-init)** — real A40L emits state 0x00 at startup (before any init command). Previously assumed to be EBD-only.
- **State 0x01 = idle (post-test)** — confirmed on real hardware after D-CP timeout. Device retains setpoints and capacity in this state.
- **State 0x0A = active discharge (D-CC)** — confirmed via proxy capture
- **State 0x0B = active discharge (D-CP)** — confirmed on real hardware (Apr 2026)
- **State 0x15 = D-CP time-complete (transitional)** — confirmed on real hardware. Appears for exactly one 2-second frame when D-CP max-time expires, then device transitions to 0x01 (idle).
- **CMD 0x11 = D-CP start** — confirmed on real hardware: bytes 2-3 = power (raw W, NO divisor), bytes 4-5 = cutoff voltage (÷100), bytes 6-7 = max time (raw minutes). Example: 5W / 2.50V / 1min → `FA 11 00 05 01 0A 00 01 1E F8`
- **CMD 0x09 = Resistance test** — confirmed on real hardware: bytes 2-3 = test current (base-240, ÷100 → A). No special response frame; VB6 app computes R = ΔV/I from the voltage dip during a brief current pulse. VB6 `CInt()` caps at 32767 mA (32.76A). Tested at 1A (below resolution), 5A (3.0 mΩ), 10A (2.5 mΩ), 20A (2.7 mΩ), 30A (2.9 mΩ), 32A (2.8 mΩ).
- **Calibration command (CMD 0x04)** — fully decoded via fake-device capture. 4-point system: byte 2 selects calibration point (0x00=Low Volt, 0x01=High Volt, 0x02=Low Curr, 0x03=High Curr), bytes 3-4 = reference value in base-240 (÷1000 for both V and A). VB6 dialog enables voltage buttons only when idle, current buttons only when a test is running (current flowing). Examples: Low Volt 3.800V → `FA 04 00 0F C8 00 00 00 C3 F8`, High Curr 10.00A → `FA 04 03 29 A0 00 00 00 8E F8`.
- **State 0x14/0x15/0x16 = phase-2 variants** of D-CC/D-CP/C-CV — confirmed via fake-device UI probe (Apr 2026). UI treats phase-1 and phase-2 as the same "running" mode; only the device distinguishes them (likely CC→CV for charge, CC→terminal for discharge).
- **Info-packet rule holds for every running state** (0x0A→0x6E, 0x0B→0x6F, 0x0C→0x70, 0x14→0x78, 0x15→0x79, 0x16→0x7A) — confirmed via fake-device UI probe (Apr 2026)
- **All non-running state bytes are treated as idle** — probed 0x00-0x3E, 0x40, 0x50, 0x60, 0x64-0x7E, 0x80-0xEE; only the six running bytes above triggered "test active" UI
- **Bytes 6-7 carry capacity during discharge** — same mAh field as during charge
- ~~**State 0x16 = charge complete**~~ — **revised:** state 0x16 behaves identically to 0x0C in the UI; it is best characterized as "C-CV phase 2" (likely the CV regulation phase), not a distinct "complete" state. The UI transitions to idle when the device emits any non-running state byte (most commonly 0x02).
- **Adjust-mid-run is only allowed in D-CC mode** — the Adjust button is enabled only while state is 0x0A, 0x14, 0x6E, or 0x78. D-CP and C-CV tests cannot be adjusted mid-run through the UI (the device will still accept a `0x07` adjust frame — the lock is purely UI-side).
- **Checksum is mod-240** — the XOR result is reduced `% 240` to keep the checksum byte below 0xF0, consistent with the base-240 constraint on all payload bytes
- **UI `Stop` button sends `0x02`** (load toggle), not `0x06` — the UI reserves `0x06` for the `Disconn` confirmation flow. Confirmed across Single Test and Cycle Test tabs.
- **CMD `0x07` also serves as mode-independent "Adjust" on EBC** — the UI's "Adjust" button on Single Test (mid-run setpoint change) emits `0x07` with the new setpoints in bytes 2-7, distinct from the QC/PD use of `0x07` documented for EBD-USB+.
- **Cycle Test sequencing is 100% host-driven** — see Cycle Test section. `Wait` and `Cycle` modes emit no serial traffic; time cutoffs translate to `0x02` load-toggle frames.
- **D-CC continue = `0x08`, D-CP continue = `0x18`, C-CV continue = `0x28`** — all three verified by clicking Continue on the Single Test tab after pausing each mode.

### Still unknown / needs more captures

- **Response bytes 8-9** — always 0 on EBC-A40L (confirmed across idle, charge, D-CC, and D-CP captures); may carry temperature, energy, or internal resistance on other models (UI strings `Temp(C)`, `000.0` format suggest temperature)
- **Error/protection states** — error strings `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn` suggest distinct codes for fault conditions. Fake-device probing (Apr 2026) ruled out simple "state byte = error code" patterns across 0x00-0xEE — every non-running state is treated as idle. **Confirmed Apr 2026 on real hardware:** battery disconnect mid-charge (C-CV at 20A) produces **no distinct error state** — the device emits one frame of 0x16 (charge complete) then transitions to 0x02 (idle), same as normal completion. The telltale is the abnormal readings: voltage spikes to 5.028V (charger open-circuited, above the 3.4V target) and current drops from 20A to 5.35A in one frame. The VB6 `ErrDconn` messages must be **client-side heuristics** (voltage > target + sudden current drop → disconnect), not protocol-level error codes.
- **Other charge mode payloads** — C-NiMh/C-LiPo/C-LiFe/C-VRLA likely use the same 3-field format as C-CV, but with chemistry-specific cutoff interpretation
- **Step test protocol** — confirmed (Apr 2026) to be host-driven (same pattern as Cycle Test below); exact semantics of multi-chemistry charge steps still need captures
- ~~**Cycle test protocol**~~ — **resolved (Apr 2026):** fully host-driven. PC software emits Start / `0x02` load toggle per step; `Wait` and `Cycle` modes emit no serial traffic. See Cycle Test section above.
- ~~**Calibration protocol**~~ — **resolved (Apr 2026):** CMD 0x04 fully decoded via fake-device capture. See command table and confirmed list above.
- **Firmware update protocol** — the software has firmware update capability (`frmUpdate`, error strings `ErrUPD`, "Failed! Please check TTL cable")
- **Multi-channel protocol** — EBD-A2S, EBD-A5S, EBC-A5M are multi-channel; how is channel selection encoded? The EB Tester GUI has `Chn1`/`Chn2`/`All Channel` radio buttons in the Parameter Setting panel (confirmed via child-window enumeration in Apr 2026), but these are hidden on single-channel devices like EBC-A40L. Captures from a multi-channel device are needed to see how channel selection is encoded in TX frames — likely an extra byte in payload, or a separate "select channel" command.
- **Device info packet fields** — bytes 10-13 carry device capabilities (max current? max voltage?) but exact mapping needs captures from different models
- **D-CV discharge mode** — confirmed command byte 0x01 exists but no captures yet showing the response format

### Recommended next captures

1. **Disconnect battery mid-test** → capture error/protection state bytes
2. ~~**D-CP discharge (constant power)**~~ → **done (Apr 2026):** CMD 0x11 payload confirmed: power (raw W, no divisor), cutoff voltage (÷100), max time (raw minutes). State 0x0B = running, 0x15 = time-complete (transitional), 0x01 = post-test idle.
3. **C-LiPo or C-NiMh charge** → verify command format matches C-CV (CMD 0x51/0x31)
4. **Step test with 2-3 steps** → capture step transitions, see byte 14 increment
5. **Change setpoints mid-test** → capture CMD 0x08 (continue) behavior
6. **Different device model** → confirm what info-packet bytes 14-15 encode (they are capability fields, not the device ID — see Device Identification) and record the real byte-16 value to validate the fake-device sweep

## References

- **libsigrok driver** (C, most authoritative): [`src/hardware/zketech-ebd-usb/`](https://github.com/sigrokproject/libsigrok) — `protocol.h`, `protocol.c`, `api.c`
- **QB64 implementation**: [gist by mdijkens](https://gist.github.com/mdijkens/0f28abc5bb5855871c53b5ff1e6863c3)
- **sigrok wiki**: [ZKETECH EBD-USB](https://sigrok.org/wiki/ZKETECH_EBD-USB) and [ZKETECH EBD-USB/Info](https://sigrok.org/wiki/ZKETECH_EBD-USB/Info)
- **Mouser user manual PDF**: [EB Tester Software User Manual V1.8.5](https://www.mouser.com/datasheet/2/744/EB_2bTester_2bSoftware_2bUser_2bManual_2bV1.8.5-1825063.pdf)
- **sevarg.net teardown**: [The EBD-M05 Battery Tester](https://www.sevarg.net/2018/12/16/the-ebd-m05-battery-tester-195v-5a-30w/)
