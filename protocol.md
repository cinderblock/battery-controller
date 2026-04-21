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
| `0x04`       | **Calibrate**     | Calibration command                                                              |
| `0x05`       | **Init / Start**  | All zeros — starts measurement stream, also serves as handshake                  |
| `0x06`       | **Stop**          | All zeros — stops measurement stream                                             |
| `0x07`       | **Configure/QC**  | byte 7 = mode selector (see QC/PD table below)                                  |
| `0x08`       | **D-CC continue** | Same format as D-CC start — updates setpoints during active test                 |
| `0x09`       | **Resistance test** | Details unknown                                                                |
| `0x0A`       | **Heartbeat**     | byte 3 = sequence counter (increments 1, 2, ...) — keepalive                    |
| `0x11`       | **D-CP start**    | bytes 2-3 = current, bytes 4-5 = cutoff                                         |
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

The EB Tester v1.8.9 software supports **58 device models**. The device type table is at offset 0x1E634 in the VB6 binary.

### EBC — Battery Charger/Discharger (22 models)

| Model           | Notes                      |
| --------------- | -------------------------- |
| EBC-A, EBC-AH   | Basic charger             |
| EBC-B, EBC-BH   | Basic charger variant     |
| EBC-A01          | Single-cell               |
| EBC-A05, EBC-A05+ | 5A charger              |
| EBC-A10, EBC-A10+, EBC-A10H | 10A charger   |
| EBC-A20, EBC-A20+ | 20A charger              |
| EBC-A40L, EBC-A50L, EBC-A100L | High-current |
| EBC-A5M          | 5A multi-channel          |
| EBC-B10          | B-series 10A              |
| EBC-B20H, EBC-B20H-72V3, EBC-B20H-108V3 | High-voltage |
| EBC-B50          | 50A charger               |
| EBC-A40L-40A     | 40A variant               |

### EBD — Electronic Load / Discharger (36 models)

| Model           | Notes                      |
| --------------- | -------------------------- |
| EBD-A, EBD-AH   | Basic load                |
| EBD-B, EBD-BH   | Basic load variant        |
| EBD-A01          | Single-cell               |
| EBD-A10, EBD-A10H, EBD-A15 | 10-15A load    |
| EBD-A20H, EBD-A20H-200W | 20A / 200W load     |
| EBD-A30H, EBD-A40L, EBD-A50H, EBD-A100, EBD-A100L | High-power |
| EBD-A2S, EBD-A5S, EBD-A5D | Multi-channel     |
| EBD-B10H, EBD-B10H-V3 | High-voltage load    |
| EBD-B20H, EBD-B20H-72V3 | 72V high-voltage   |
| EBD-B30H, EBD-B30H-72V3, EBD-B40H | 30-40A HV |
| EBD-M, EBD-M02, EBD-M03, EBD-M03+, EBD-M05, EBD-M10 | Mini/meter series |
| EBD-P10, EBD-P15, EBD-P30H | P-series         |
| EBD-USB, EBD-USB+ | USB power monitor         |

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
Bytes 8-9:   (unknown)  (base-240) — always 0 on EBC-A40L
Bytes 10-11: Current setpoint echo  (base-240, ÷100 → A)
Bytes 12-13: Voltage setpoint echo  (base-240, ÷100 → V)
Byte 14:     Step number (0x00 for single test)
Byte 15:     Cutoff current echo    (raw, ÷100 → A)
Byte 16:     Device constant        (0x0A on EBC-A40L, possibly firmware/device ID)
Byte 17:     XOR checksum (bytes 1-16)
Byte 18:     0xF8       — frame end
```

> **Capacity (bytes 6-7):** The raw base-240 value equals mAh directly. At 4.00A for 62 seconds, the expected capacity is 68.9 mAh — the device reports raw value 68. At 3.00A for 145.6 seconds, the expected capacity is 121.3 mAh — the device reports raw value 121. Unlike the EBD-USB+ where the host computes capacity by integration, **EBC devices track capacity internally**.

> **Setpoint echo (bytes 10-15):** During idle (state 0x02), these fields retain the last test's configured setpoints. During an active test (state 0x0C), they echo the current test's parameters.

> **Bytes 8-9:** Always 0 in all EBC-A40L captures (both idle and charging). Possibly temperature, energy, or internal resistance on other EBC models, but unused or unsupported on the A40L.

### Device Info / Identification Packet (state + 0x64)

After receiving an init command (CMD 0x05), the device sends **alternating** responses: one normal data packet, then one info packet with state = normal_state + 0x64. The info packet uses a different mapping for bytes 10-16:

```
Bytes 10-11: Device capability 1  (base-240) — possibly max current
Bytes 12-13: Device capability 2  (base-240, ÷100 → 5.00V on A40L) — possibly max voltage
Byte 14:     Device type index    (0x11 = 17 on EBC-A40L)
Byte 15:     Device subtype/rev   (0x86 = 134 on EBC-A40L)
Byte 16:     Device constant      (0x0A = 10, same as normal packets)
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

| Value  | Hex    | Meaning                  |
| ------ | ------ | ------------------------ |
| `2`    | `0x02` | Idle / monitoring — test not running, connected |
| `12`   | `0x0C` | **Charging active** — current flowing to battery |
| `102`  | `0x66` | Idle — **info packet** (alternate, = 0x02 + 0x64) |

> **Pattern:** The info packet state is always the normal state + 0x64 (100 decimal). For EBD-USB+: 0x00→0x64, 0x0A→0x6E. For EBC: 0x02→0x66. Additional states likely exist for discharging (possibly 0x0A as on EBD), charge complete, and error/protection conditions (error strings `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn` suggest distinct error states).

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
- **Response byte 16 = 0x0A** (constant, device/firmware identifier)
- **Heartbeat byte 3 = sequence counter** (1, 2, 3, ...)
- **Idle packets retain last test's setpoints and accumulated capacity**
- **Info packet bytes 14-15 = device type (0x11) + subtype (0x86)**
- **State 0x0A = active discharge (D-CC)** — confirmed via proxy capture
- **Bytes 6-7 carry capacity during discharge** — same mAh field as during charge
- **State 0x16 = charge complete** — distinct from 0x02 (idle) and 0x0C (charging active)
- **Checksum is mod-240** — the XOR result is reduced `% 240` to keep the checksum byte below 0xF0, consistent with the base-240 constraint on all payload bytes

### Still unknown / needs more captures

- **Response bytes 8-9** — always 0 on EBC-A40L; may carry temperature, energy, or internal resistance on other models (UI strings `Temp(C)`, `000.0` format suggest temperature)
- **Error/protection states** — error strings `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn` suggest distinct state byte values for fault conditions
- **Other charge mode payloads** — C-NiMh/C-LiPo/C-LiFe/C-VRLA likely use the same 3-field format as C-CV, but with chemistry-specific cutoff interpretation
- **Step test protocol** — how are multi-step sequences communicated? Sent as a sequence of individual commands, or uploaded as a program?
- **Cycle test protocol** — automatic cycling likely managed by host software sending start/stop for each phase
- **Calibration protocol** — CMD 0x04 details
- **Firmware update protocol** — the software has firmware update capability (`frmUpdate`, error strings `ErrUPD`, "Failed! Please check TTL cable")
- **Multi-channel protocol** — EBD-A2S, EBD-A5S, EBC-A5M are multi-channel; how is channel selection encoded?
- **Device info packet fields** — bytes 10-13 carry device capabilities (max current? max voltage?) but exact mapping needs captures from different models
- **D-CV discharge mode** — confirmed command byte 0x01 exists but no captures yet showing the response format

### Recommended next captures

1. **Disconnect battery mid-test** → capture error/protection state bytes
2. **D-CP discharge (constant power)** → verify CMD 0x11 payload format
3. **C-LiPo or C-NiMh charge** → verify command format matches C-CV (CMD 0x51/0x31)
4. **Step test with 2-3 steps** → capture step transitions, see byte 14 increment
5. **Change setpoints mid-test** → capture CMD 0x08 (continue) behavior
6. **Different device model** → compare info packet bytes 14-15 for device type mapping

## References

- **libsigrok driver** (C, most authoritative): [`src/hardware/zketech-ebd-usb/`](https://github.com/sigrokproject/libsigrok) — `protocol.h`, `protocol.c`, `api.c`
- **QB64 implementation**: [gist by mdijkens](https://gist.github.com/mdijkens/0f28abc5bb5855871c53b5ff1e6863c3)
- **sigrok wiki**: [ZKETECH EBD-USB](https://sigrok.org/wiki/ZKETECH_EBD-USB) and [ZKETECH EBD-USB/Info](https://sigrok.org/wiki/ZKETECH_EBD-USB/Info)
- **Mouser user manual PDF**: [EB Tester Software User Manual V1.8.5](https://www.mouser.com/datasheet/2/744/EB_2bTester_2bSoftware_2bUser_2bManual_2bV1.8.5-1825063.pdf)
- **sevarg.net teardown**: [The EBD-M05 Battery Tester](https://www.sevarg.net/2018/12/16/the-ebd-m05-battery-tester-195v-5a-30w/)
