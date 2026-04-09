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

XOR of all bytes between (but not including) the start and end markers:

```
checksum = byte[1] ^ byte[2] ^ byte[3] ^ ... ^ byte[N]
```

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

These divisors are confirmed from the sigrok EBD-USB+ driver. The EB Tester v1.8.9 binary contains the corresponding float constants in its VB6 constant pool:

| Measurement    | Divisor | Float in binary | Resolution | Unit | Display format |
| -------------- | ------- | --------------- | ---------- | ---- | -------------- |
| Current        | 10,000  | `10.0` @ 0x1564 | 0.1 mA    | A    | `0.0000` (4 dp) |
| Voltage        | 1,000   | `1000.0` @ 0x1464 | 1 mV    | V    | `00.000` (3 dp) |
| UVC cutoff     | 100     | `100.0` @ 0x1638 | 10 mV    | V    | `00.00` (2 dp)  |
| D+/D- voltage  | 1,000   | —               | 1 mV       | V    | `0.000` (3 dp)  |
| Time           | —       | `3600.0` @ 0x1468 | 1 sec   | S/H  | —              |

> **Important:** D+/D- voltage fields are **only present on EBD-USB/EBD-USB+ models** (the USB power monitors). Charger/discharger models (EBC-*, EBD-A*, EBD-B*) use those response bytes for **other data** — likely temperature, internal resistance, or charge state. The UI labels `Cur(mA)` and `Curr(A)` suggest some models report current in mA (divisor 1,000) rather than the EBD-USB+'s 0.1 mA resolution.

## Host → Device Commands (10 bytes)

| CMD (byte 1) | Name              | Payload                                                                          |
| ------------ | ----------------- | -------------------------------------------------------------------------------- |
| `0x01`       | **Load start**    | bytes 2-3 = current (base-240, div 10000), bytes 4-5 = UVC cutoff (base-240, div 100) |
| `0x02`       | **Load toggle**   | All zeros — toggles load on/off                                                 |
| `0x04`       | **Calibrate**     | Calibration command                                                              |
| `0x05`       | **Init / Start**  | All zeros — starts measurement stream, also serves as handshake                  |
| `0x06`       | **Stop**          | All zeros — stops measurement stream                                             |
| `0x07`       | **Configure/QC**  | byte 7 = mode selector (see QC/PD table below)                                  |
| `0x0A`       | **Heartbeat**     | All zeros — keepalive                                                            |

### Example: Init

```
FA 05 00 00 00 00 00 00 05 F8
```

### Example: Start load at 1.000A, cutoff 3.00V

```
Current: 1.000 A × 10000 = 10000
  hi = 10000 / 240 = 41  (0x29)
  lo = 10000 % 240 = 160 (0xA0)

Cutoff:  3.00 V × 100 = 300
  hi = 300 / 240 = 1     (0x01)
  lo = 300 % 240 = 60    (0x3C)

Packet: FA 01 29 A0 01 3C 00 00 [XOR] F8
```

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

> **Model-dependent:** The field mapping below is confirmed for the EBD-USB+ only. For EBC charger/discharger models, bytes 6-9 likely carry **temperature** and/or **charge state** rather than D+/D- voltages. The UI strings `Temp(C)`, `Cur(mA)`, and the display formats `00.000` (voltage), `0.0000` (current), `000.0` (temperature?) suggest the response is reinterpreted per device type.

### EBD-USB+ Response Layout

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

### EBC Charger/Discharger Response Layout (needs verification)

The VB6 binary display formats and UI labels suggest this layout for EBC models:

```
Byte 0:      0xFA       — frame start
Byte 1:      STATE      — device state (charging/discharging/idle/error)
Bytes 2-3:   Current    (base-240) — displayed as Cur(mA) or Curr(A)
Bytes 4-5:   Voltage    (base-240, ÷1000 → V) — displayed as Volt(V), format "00.000"
Bytes 6-7:   Temperature? (model-dependent) — displayed as Temp(C), format "000.0"
Bytes 8-9:   (unknown — possibly internal resistance or charge current setpoint)
Bytes 10-11: (unknown — possibly cutoff voltage or cells count)
Bytes 12-13: (unknown — possibly mode/step indicator)
Bytes 14-16: (reserved / model-dependent)
Byte 17:     XOR checksum (bytes 1-16)
Byte 18:     0xF8       — frame end
```

> **TODO:** To map these fields definitively for EBC models, capture serial traffic with a logic analyzer while running the EB Tester software connected to an actual EBC device.

### State Byte (byte 1)

| Value  | Meaning                  |
| ------ | ------------------------ |
| `0x00` | Measuring, load **OFF**  |
| `0x64` | Measuring, load **OFF** (alternate) |
| `0x0A` | Measuring, load **ON**   |
| `0x6E` | Measuring, load **ON** (alternate)  |

> For EBC charger models, additional state values likely exist for charging, charged, error/protection, etc. The error strings `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn` suggest distinct connection and operational states.

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
- Serial: 9600 baud, 8 data bits (parity TBD per model)
- Host→Device: 10 bytes, Device→Host: 19 bytes
- Commands: `0x05` init, `0x06` stop, `0x01` load start, `0x02` toggle

### Confirmed for EBD-USB+ only (from sigrok)

- Response byte mapping (current, voltage, D+, D-, limits)
- State byte values (0x00, 0x0A, 0x64, 0x6E)
- QC/PD mode commands (0x07)
- Even parity

### Unknown / needs traffic capture for EBC charger models

- **Response byte 6-9 mapping** — temperature? internal resistance? charge state?
- **Charge mode commands** — how does the host tell the device to enter C-NiMh, C-LiPo, C-LiFe, C-VRLA, C-PB, C-CV mode? Likely a specific CMD byte or payload variant of 0x01/0x07
- **State byte values for charging** — what values indicate charging, charge complete, protection triggered?
- **Step test protocol** — how are multi-step sequences communicated? Sent as a sequence of individual commands, or uploaded as a program?
- **Cycle test protocol** — automatic cycling likely managed by host software sending start/stop for each phase
- **Calibration protocol** — CMD 0x04 details
- **Firmware update protocol** — the software has firmware update capability (`frmUpdate`, error strings `ErrUPD`, "Failed! Please check TTL cable")
- **Multi-channel protocol** — EBD-A2S, EBD-A5S, EBC-A5M are multi-channel; how is channel selection encoded?
- **Current resolution per model** — UI shows both `Cur(mA)` and `Curr(A)` display formats, suggesting different models report current with different resolution

### Recommended next step

Connect a USB-serial sniffer (or a second serial port tap) between the PC and the device while running the EB Tester software. Log all traffic while performing:

1. Connect → device type detection handshake
2. Start discharge (D-CC mode) → observe command and response field mapping
3. Start charge (C-NiMh or C-LiPo) → capture the charge-mode command
4. Read temperature during charge → identify which response bytes carry temp
5. Step test with 2-3 steps → capture the step transition protocol
6. Calibration → capture CMD 0x04 exchange

## References

- **libsigrok driver** (C, most authoritative): [`src/hardware/zketech-ebd-usb/`](https://github.com/sigrokproject/libsigrok) — `protocol.h`, `protocol.c`, `api.c`
- **QB64 implementation**: [gist by mdijkens](https://gist.github.com/mdijkens/0f28abc5bb5855871c53b5ff1e6863c3)
- **sigrok wiki**: [ZKETECH EBD-USB](https://sigrok.org/wiki/ZKETECH_EBD-USB) and [ZKETECH EBD-USB/Info](https://sigrok.org/wiki/ZKETECH_EBD-USB/Info)
- **Mouser user manual PDF**: [EB Tester Software User Manual V1.8.5](https://www.mouser.com/datasheet/2/744/EB_2bTester_2bSoftware_2bUser_2bManual_2bV1.8.5-1825063.pdf)
- **sevarg.net teardown**: [The EBD-M05 Battery Tester](https://www.sevarg.net/2018/12/16/the-ebd-m05-battery-tester-195v-5a-30w/)
