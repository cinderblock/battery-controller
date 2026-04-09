# Developer Documentation

## Project Overview

Battery Charge & Discharge Controller is a real-time device monitoring application that:

- Communicates with hardware over serial port
- Maintains synchronized state between physical device and application
- Provides a web GUI for monitoring and control
- Deploys from any development machine to a Raspberry Pi production device

## Technology Stack

- **Runtime**: [Bun](https://bun.sh) - all-in-one JavaScript runtime
- **Language**: TypeScript throughout (server, frontend, deployment scripts)
- **Linting/Formatting**:
  - [Biome](https://biomejs.dev) - TypeScript/JavaScript linting and formatting
  - [Prettier](https://prettier.io) - Markdown formatting, until Biome supports markdown formatting.
- **Backend**: Bun native HTTP + WebSocket servers
- **Frontend**: Vanilla TypeScript with modern CSS
- **Hardware**: Serial port communication (Node.js serialport library)
- **Deployment**: Bun.build() API, ssh2-promise for file transfer from development machine to Raspberry Pi

## Project Structure

```
battery-controller/
├── src/
│   ├── protocol/        # Shared protocol library (constants, codec, types)
│   │   ├── constants.ts # Frame markers, packet lengths, base-240 divisors
│   │   ├── codec.ts     # Checksum, base-240, frame building/parsing/scanning
│   │   ├── types.ts     # ParsedFrame, DecodedRxFrame, DecodedTxFrame, etc.
│   │   └── index.ts     # Barrel export
│   │
│   ├── server/          # Backend server (runs on Raspberry Pi)
│   │   ├── index.ts     # Main entry point (HTTP + WebSocket + bridge mode)
│   │   ├── serial.ts    # Serial port handler
│   │   ├── tcp-bridge.ts # TCP-serial byte pipe for dev proxy
│   │   └── state.ts     # State management
│   │
│   ├── proxy/           # Windows-side dev proxy
│   │   ├── index.ts     # Main entry, wires COM <-> TCP <-> recorder
│   │   ├── recorder.ts  # JSONL traffic recorder
│   │   └── serial-port.ts # Windows COM port wrapper (serialport)
│   │
│   ├── analyzer/        # Offline traffic analyzer
│   │   ├── index.ts     # CLI entry point
│   │   ├── parser.ts    # JSONL reader + frame reconstructor
│   │   └── formatter.ts # Colored table output
│   │
│   ├── frontend/        # React Web GUI
│   │   ├── index.html   # HTML shell
│   │   ├── index.tsx    # React entry point
│   │   ├── App.tsx      # Main React component
│   │   ├── api-client.ts      # Type definitions
│   │   ├── websocket-client.ts # WebSocket client
│   │   └── styles/      # CSS styles
│   │
│   ├── run/             # Deployment scripts (TypeScript)
│   │   ├── setup.ts     # Initial Pi setup (compiles to binary)
│   │   ├── deploy.ts    # Deploy from development machine to Pi
│   │   └── utils.ts     # Shared utilities
│   │
│   └── utils/           # Shared utility functions
│       ├── shutdown.ts  # Graceful shutdown handler
│       ├── str.ts       # Safe string interpolation
│       └── JobGroup.ts  # Promise/job management
│
├── recordings/          # Proxy traffic captures (gitignored)
├── README.md            # User documentation
├── Developer.md         # This file
├── protocol.md          # Protocol reverse-engineering notes
├── package.json
└── tsconfig.json
```

## Architecture

### Data Flow

```
Hardware Device
    ↕ Serial Port
Serial Handler (server/serial.ts)
    ↕
State Manager (server/state.ts)
    ↕
WebSocket Server → WebSocket Client → UI Components → User
```

### Key Components

**Server** (`src/server/`)

- Manages serial port communication
- Maintains device state and message history
- Provides WebSocket interface for frontend
- Runs as systemd service on Raspberry Pi

**Frontend** (`src/frontend/`)

- Real-time dashboard with WebSocket updates
- Control panel for sending commands
- Activity log

**Run Scripts** (`src/run/`)

- TypeScript scripts that orchestrate deployment
- Use Bun.build() API to build in memory
- Transfer files via ssh2-promise
- Run from development machine, manage Raspberry Pi via SSH

**Utilities** (`src/utils/`)

- Shared utility functions used across the application
- `shutdown.ts` - Graceful application shutdown with logging
- `str.ts` - Template literal function for safe string interpolation (handles undefined/null values)
- `JobGroup.ts` - Manages multiple promises with error handling and completion tracking

## Development Workflow

### Local Development (development machine)

1. **Install Bun**

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Install Dependencies**

   ```bash
   bun install
   ```

3. **Install VS Code Extensions** (recommended)
   - Biome (biomejs.biome) - for linting and formatting TypeScript/JavaScript
   - Prettier (esbenp.prettier-vscode) - for formatting Markdown
   - Bun for VS Code (oven.bun-vscode) - for Bun support

4. **Create Environment File**

   ```bash
   # Development machine config only
   cp .env.example .env
   # Edit with Pi hostname and local serial port
   ```

5. **Run Development Server**

   ```bash
   bun run dev
   ```

   - Server runs on http://localhost:3000
   - Hot reload enabled

6. **Linting and Formatting**

   ```bash
   bun run lint        # Check for issues
   bun run lint:fix    # Fix issues automatically
   bun run format      # Format code
   bun run check       # Lint + format + build (full check)
   ```

### Deployment to Raspberry Pi

**Philosophy**: Everything runs from development machine. One command builds binaries, transfers them, and manages the entire deployment.

#### Prerequisites

1. **Prepare Raspberry Pi**
   - Install Raspberry Pi OS Lite
   - Enable SSH
   - Configure passwordless sudo (or be ready to enter password)
   - Configure network/WiFi
   - Note hostname or IP address

2. **Configure Deployment**

   ```bash
   # Copy and edit .env
   cp .env.example .env

   # Set deployment target
   DEPLOY_HOST=raspberrypi.local
   DEPLOY_USER=pi

   # Pi configuration is hardcoded in systemd service
   # (Can be edited on Pi after deployment)
   ```

#### Deployment Process

**Single Command Deployment:**

```bash
bun run deploy
```

This one command:

1. ✅ Checks SSH connection
2. 📥 Installs Bun on Pi (if not already installed)
3. 🔨 Builds `setup` bundle (for Bun runtime, runs on Pi to configure system)
4. 🔨 Builds `battery-controller` server bundle (for Bun runtime)
5. 📤 Transfers files to Pi via SSH (no rsync/scp needed)
6. 📦 Transfers package.json and runs `bun install` on Pi
7. 📁 Creates directory:
   - `/opt/battery-controller/` - Application files and working directory
8. ⚙️ Runs setup (first time only):
   - Installs system dependencies (apt packages)
   - Configures serial port hardware
   - Creates systemd service file (production or dev)
   - Enables production service for auto-start
9. 🚀 Deploys server bundle to `/opt/battery-controller/server.js`
10. 🔄 Restarts `battery-controller.service`
11. 📊 Shows deployment status

**Development Mode (Watch & Auto-Deploy):**

```bash
bun run deploy:watch
```

Watches for changes in:

- `src/server/` - Server code
- `src/frontend/` - Frontend code
- `src/run/` - Deployment scripts

On change: automatically rebuilds and redeploys to Pi.

In watch mode:

- Creates `battery-controller-dev.service` instead of production service
- Dev service runs with `bun --watch` for hot reloading on the Pi
- Dev service conflicts with production service (systemd auto-stops prod when dev starts)
- Changes deployed to Pi trigger automatic restart via Bun's watch mode

**Check Remote Status:**

```bash
bun run status
```

Shows:

- Service status
- Recent logs (last 30 lines)
- Network info
- Disk usage
- Web interface URL

#### Force Re-run Setup

```bash
# Run setup again (even if not first deploy)
bun run deploy --setup
```

## Configuration

### Environment Variables

#### `.env` - Development machine Only

This file is used **only on the development machine** for deployment configuration and local development server settings:

- Deployment configuration (where to deploy)
- Local development server settings

#### Raspberry Pi Configuration

Prerequisites:

- Raspberry Pi OS Lite
- Passswordless SSH access to the Pi
- Passwordless `sudo` access to the Pi

Setup script handles everything else:

- Installs system dependencies
- Creates systemd service file
- Enables service for auto-start
- Sets up directory structure
- Configures permissions
- Disables kernel console on serial ports

## Deployment Scripts

### `deploy.ts`

**Main deployment orchestrator** - runs on the development machine.

**Usage**:

```bash
bun start
```

**Process**:

1. Loads config from `.env` (DEPLOY_HOST, DEPLOY_USER, DEPLOY_KEY)
2. Checks SSH connection
3. Ensures remote Pi is configured as expected
   - Ensures Bun is installed on remote Pi
   - Creates remote directory (`/opt/battery-controller/`)
4. Builds files in memory using Bun.build() API:
   - `setup.js` → Bun bundle for Pi setup
   - `server.js` → Bun bundle (server + frontend)
5. Transfers files via ssh2-promise (no rsync/scp binaries needed)
6. Transfers `package.json` and runs `bun install` on Pi
7. Runs setup on Pi with Bun runtime
8. Restarts systemd service (production or dev)
9. Shows status

**Watch Mode** is enabled by default. It will:

- Monitor `src/server/`, `src/frontend/`, and `src/run/` for changes
- Auto-redeploy on save
- Use dev systemd service with `bun --watch` on remote
- No local dist/ directory - everything built in memory

**Once Mode** can be enabled with `--once` flag. It will build and deploy the project once, then exit.

```bash
bun start --once
```

### `setup.ts`

**System setup script** - idempotent script that runs on the remote to configure the system.

Called automatically by `deploy.ts` on the remote.

### `status.ts`

**Remote status checker** - runs on the development machine, checks Pi via SSH.

**Usage**: `bun run status`

**Shows**:

- Systemd service status
- Recent logs (30 lines)
- Network info (hostname, IP)
- Disk usage
- Web interface URL
- Helper commands

### `utils.ts`

Shared SSH/SCP utilities for deployment scripts.

## Build System

### In-Memory Build & Transfer

The deployment script uses Bun.build() API to build everything in memory, then transfers via SSH:

```typescript
// In deploy.ts:
// 1. Build setup bundle
const result = await Bun.build({
  entrypoints: ['./src/run/setup.ts'],
  target: 'bun',
});

// 2. Build server bundle
const result = await Bun.build({
  entrypoints: ['./src/server/index.ts'],
  target: 'bun',
  external: ['serialport', '@serialport/parser-readline'],
});

// 3. Transfer via SSH (no local files created)
await writeRemoteFile(config, setupBundle, '/opt/setup.js');
await writeRemoteFile(config, serverBundle, '/opt/battery-controller/server.js');
```

**Benefits**:

- No local dist/ directory needed
- Faster builds (no disk I/O for intermediate files)
- ssh2-promise handles all transfers (no rsync/scp binaries required)
- Everything runs with Bun runtime (can use --watch mode)
- Bun installed once on Pi, all bundles use that runtime
- Application directory (`/opt/battery-controller/`) contains both code and runtime data

## Serial Port Communication

### Protocol Status

**⚠️ PROTOCOL: Newline-Delimited (Content Format TBD)**

This application interfaces with hardware using a newline-delimited serial protocol. The message framing is known (newline separators), but the content format within each line is still being reverse engineered.

**Current State:**

- ✅ Message delimiter: Newline (`\n`)
- ❓ Content format: Unknown (could be JSON, CSV, key=value pairs, hex-encoded binary, etc.)
- ✅ Line-by-line parsing with detailed logging
- ❓ Data fields and their meanings
- ❓ Command format

**Reverse Engineering Process:**

1. **Data Collection**
   - Connect to hardware via serial port
   - Monitor incoming lines (each line is logged)
   - Look for patterns in line format
2. **Protocol Analysis**
   - Determine line format (JSON, CSV, key=value, custom, etc.)
   - Identify data fields (voltage, current, status, etc.)
   - Determine data types and units
   - Test what commands the device accepts
3. **Implementation**
   - Update `parseMessage()` in `src/server/serial.ts` with parsing logic
   - Update `serializeCommand()` for command formatting
   - Define `DeviceState` fields in `src/server/state.ts`
   - Update frontend UI to display new state fields

**Debugging Tools:**

All incoming lines are logged:

```
📥 Received line: {"voltage":12.5,"current":3.2}
📥 Length: 32 chars
📥 Hex: 7b22766f6c74616765223a31322e352c2263757272656e74223a332e327d
```

Serial configuration is in `.env`:

```bash
SERIAL_PORT=/dev/ttyUSB0
BAUD_RATE=9600
```

## Systemd Service

The application runs as a systemd service `battery-controller.service` on Raspberry Pi for auto-start and management.

```ini
[Unit]
Description=Battery Charge & Discharge Controller
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/
ExecStart=/home/pi/battery-controller
Restart=always

[Install]
WantedBy=multi-user.target
```

**Commands**:

```bash
sudo systemctl start battery-controller
sudo systemctl stop battery-controller
sudo systemctl restart battery-controller
sudo systemctl status battery-controller
journalctl -u battery-controller -f  # view logs
```

## Code Quality

### Linting and Formatting

This project uses [Biome](https://biomejs.dev) for fast linting and formatting.

**Commands:**

```bash
bun run lint        # Check for linting issues
bun run lint:fix    # Fix linting issues automatically
bun run format      # Format all code
bun run check       # Full check: lint + format + build
```

**Editor Integration:**

- Install the Biome VS Code extension (biomejs.biome)
- Code will auto-format on save
- Linting errors appear inline

**Key Rules:**

- `useNodejsImportProtocol: error` - Enforces "node:" prefix for Node.js imports
- `noUnusedVariables: error` - No unused variables allowed
- Single quotes, semicolons, trailing commas (ES5)
- 120 character line width

### Testing

Not planned

## Troubleshooting

### Build Failures

- Run `bun install` to update dependencies
- Check TypeScript errors with `bun run build`
- Verify tsconfig.json is correct

## Implementing Protocol Support

Once you've reverse engineered the protocol, follow these steps:

### 1. Define Device State (`src/server/state.ts`)

Add fields discovered from protocol analysis:

```typescript
export interface DeviceState {
  connected: boolean;
  lastUpdate: number;

  // Example fields (replace with actual):
  voltage: number;
  current: number;
  temperature: number;
  statusFlags: number;
  // etc.
}
```

### 2. Implement Line Parsing (`src/server/serial.ts`)

Replace the `parseMessage()` placeholder with actual parsing logic based on the discovered format:

**For JSON format:**

```typescript
private parseMessage(line: string): ProtocolMessage | null {
  if (!line.trim()) return null; // Ignore empty lines
  return JSON.parse(line);
}
```

**For CSV format:**

```typescript
private parseMessage(line: string): ProtocolMessage | null {
  const values = line.split(',');
  return {
    voltage: parseFloat(values[0]),
    current: parseFloat(values[1]),
    temperature: parseFloat(values[2]),
    // Map to your actual fields
  };
}
```

**For key=value format:**

```typescript
private parseMessage(line: string): ProtocolMessage | null {
  const pairs = line.split(' ');
  const result: any = {};
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    result[key] = isNaN(Number(value)) ? value : Number(value);
  }
  return result;
}
```

**For hex-encoded binary:**

```typescript
private parseMessage(line: string): ProtocolMessage | null {
  const buffer = Buffer.from(line.trim(), 'hex');
  return {
    voltage: buffer.readUInt16LE(0) / 100,
    current: buffer.readInt16LE(2) / 100,
    temperature: buffer.readInt8(4),
    // etc.
  };
}
```

### 3. Implement Command Serialization (`src/server/serial.ts`)

Update `serializeCommand()` to format commands correctly:

```typescript
private serializeCommand(command: string): Buffer {
  // Text-based: add delimiter
  return Buffer.from(command + '\n', 'utf8');

  // Binary: encode as needed
  // const buffer = Buffer.alloc(4);
  // buffer.writeUInt32LE(parseInt(command), 0);
  // return buffer;
}
```

### 4. Update Message Processing (`src/server/serial.ts`)

```typescript
private processMessage(message: ProtocolMessage) {
  this.stateManager.updateDeviceState({
    voltage: message.voltage,
    current: message.current,
    temperature: message.temperature,
    // Map protocol fields to state
  });
}
```

### 5. Update Frontend (`src/frontend/App.tsx`)

Add UI elements for new state fields:

```typescript
<div className="state-item">
  <span className="label">Voltage:</span>
  <span className="value">{state.voltage?.toFixed(2)} V</span>
</div>
```

## Dev Proxy: Serial Traffic Capture

The dev proxy intercepts serial traffic between the EB Tester VB6 app and a ZKETech charger/discharger to map the protocol for EBC-\* models. See `PLAN-dev-proxy.md` for the full architecture.

### Architecture

```
EB Tester VB6 App
    │ opens COMxx (virtual port)
[com0com null-modem pair: COMxx ↔ COMxx+1]
    │ proxy opens COMxx+1
Windows Proxy (src/proxy/)
    │ TCP to coulomb:49600
Pi TCP-Serial Bridge (src/server/tcp-bridge.ts)
    │ 9600 8E1
ZKETech Device
```

### Virtual COM Port (node-null)

The proxy uses [node-null](../node-null/) to create a virtual COM port on the fly. No pre-installed drivers like com0com are needed — node-null includes its own kernel driver.

**Prerequisites:**

1. node-null driver installed (see node-null README for build/install instructions)
2. Test signing enabled: `bcdedit /set testsigning on` (reboot required)
3. Package linked: `cd ../node-null && bun link && cd ../battery-controller && bun link node-null`

The proxy creates a COM port on startup and destroys it on shutdown. EB Tester opens that same port directly.

### Running the Proxy

```bash
# Start the TCP-serial bridge on the Pi
sudo systemctl start battery-controller-bridge

# Start the proxy on Windows (auto-assigns a COM port)
bun run proxy

# Request a specific COM port number
bun run proxy -- --com 10

# Options:
#   --com <N>       COM port number (e.g. 10 for COM10) [auto-assigned if omitted]
#   --host <HOST>   Pi hostname [env: DEPLOY_HOST]
#   --port <PORT>   Pi TCP bridge port [default: 49600]
#   --log <DIR>     Recording output directory [default: recordings/]
#   --rtsp <URL>    RTSP camera URL [env: RTSP_URL]
```

The proxy prints live-decoded traffic to the console and records all raw bytes to a JSONL file in `recordings/`.

**Interactive commands while the proxy runs:**

- Type any text + Enter → timestamped note in the JSONL
- Type `snap` or `s` + Enter → manual camera screenshot (if `--rtsp` is set)
- Ctrl+C → graceful shutdown

**RTSP camera:** When `--rtsp` is provided, ffmpeg (must be installed) continuously decodes the stream at 2fps. Screenshots are captured automatically ~2 seconds after each TX command (debounced), or manually via the `snap` command. Screenshots are saved as `screenshot-NNNN.jpg` alongside the JSONL file. Requires ffmpeg: `winget install ffmpeg` or `scoop install ffmpeg`.

### Analyzing Recordings

```bash
# Decode all frames
bun run analyze recordings/<file>.jsonl

# Only host->device commands
bun run analyze --filter tx recordings/<file>.jsonl

# Highlight unknown/model-dependent fields
bun run analyze --unknown recordings/<file>.jsonl

# Summary statistics only
bun run analyze --summary recordings/<file>.jsonl

# Raw hex only
bun run analyze --raw recordings/<file>.jsonl
```

### Bridge Service Management (Pi)

```bash
# Start bridge mode (conflicts with normal server and dev service)
sudo systemctl start battery-controller-bridge

# Stop bridge, return to normal server
sudo systemctl stop battery-controller-bridge
sudo systemctl start battery-controller
```

## Future Enhancements

- Historical data logging
- Charts and graphs
- Database integration
