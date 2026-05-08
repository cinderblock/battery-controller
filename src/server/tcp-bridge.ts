/**
 * TCP-Serial Bridge
 *
 * Transparent byte pipe: TCP <-> /dev/serial0
 * No frame parsing, no buffering — raw bytes forwarded bidirectionally
 * with timing fidelity preserved.
 *
 * Can run either as:
 * - Standalone mode: `--bridge` CLI flag, owns the process lifecycle
 * - Dynamic mode: started/stopped from the web UI while the main server runs
 *
 * The Windows proxy connects here to relay traffic from the virtual COM port.
 */

import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import type { Socket, TCPSocketListener } from 'bun';
import { scanForFrames } from '../protocol/codec.ts';
import { BaudRate, RxPacketLength, TxPacketLength } from '../protocol/constants.ts';
import { BridgeTcpPort } from '../run/config.ts';
import { logger } from '../utils/logger.ts';

const SERIAL_PORT = process.env.SERIAL_PORT || '/dev/serial0';
const TCP_PORT = Number(process.env.BRIDGE_PORT) || BridgeTcpPort;

/**
 * Configure serial port using stty (same approach as SerialManager.configurePort)
 */
async function configureSerialPort(portPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-F',
      portPath,
      `${BaudRate}`,
      'cs8', // 8 data bits
      '-cstopb', // 1 stop bit
      'parenb', // Enable parity
      '-parodd', // Use even parity
      'raw', // Raw mode
      '-echo', // No echo
      'min',
      '0', // Return immediately with whatever is available
      'time',
      '10', // 1-second timeout (deciseconds) — returns 0 bytes on timeout
    ];

    logger.info(`[bridge] Configuring serial port: stty ${args.join(' ')}`);
    const stty = spawn('stty', args);

    stty.on('close', code => {
      if (code === 0) {
        logger.info(`[bridge] Serial port configured: ${BaudRate} baud, 8E1`);
        resolve();
      } else {
        reject(new Error(`stty exited with code ${code}`));
      }
    });

    stty.on('error', err => {
      reject(new Error(`Failed to run stty: ${err.message}`));
    });
  });
}

// ── Stoppable bridge instance ────────────────────────────────────

export interface BridgeOptions {
  /** Called when a complete frame is detected in either direction */
  onFrame?: (direction: 'tx' | 'rx', frame: Uint8Array) => void;
  /** Skip stty configuration (port already configured by SerialManager) */
  skipPortConfig?: boolean;
}

export interface TcpBridge {
  /** Stop the bridge, close serial port and TCP listener */
  stop(): Promise<void>;
  /** Whether a TCP client is currently connected */
  hasClient(): boolean;
}

/**
 * Start the TCP-serial bridge and return a handle to stop it.
 *
 * - Opens the serial port as a raw file
 * - Listens for a single TCP client on the bridge port
 * - Forwards bytes bidirectionally with no parsing or buffering
 */
export async function startTcpBridge(options: BridgeOptions = {}): Promise<TcpBridge> {
  logger.info(`[bridge] Starting TCP-serial bridge`);
  logger.info(`[bridge] Serial port: ${SERIAL_PORT}`);
  logger.info(`[bridge] TCP port: ${TCP_PORT}`);

  // Configure serial port (skip if caller already configured it)
  if (!options.skipPortConfig) {
    await configureSerialPort(SERIAL_PORT);
  }

  // Open serial port for read/write
  const serialHandle: FileHandle = await open(SERIAL_PORT, 'r+');
  logger.info('[bridge] Serial port opened');

  // Track active client
  let activeClient: Socket<unknown> | null = null;
  let stopped = false;

  // Frame sniff buffers (for passively decoding traffic without altering it)
  let rxSniffBuffer = new Uint8Array(0);
  let txSniffBuffer = new Uint8Array(0);

  function appendBytes(existing: Uint8Array, incoming: Uint8Array): Uint8Array {
    const combined = new Uint8Array(existing.length + incoming.length);
    combined.set(existing);
    combined.set(incoming, existing.length);
    return combined;
  }

  // Start reading from serial port and forwarding to TCP
  const serialReadBuffer = new Uint8Array(1024);

  async function serialReadLoop() {
    try {
      while (!stopped) {
        const { bytesRead } = await serialHandle.read(serialReadBuffer, 0, serialReadBuffer.length);
        if (bytesRead === 0) continue; // timeout, no data — check loop condition

        const data = serialReadBuffer.slice(0, bytesRead);

        if (activeClient) {
          activeClient.write(data);
        }

        // Sniff RX frames (device → host)
        if (options.onFrame) {
          rxSniffBuffer = appendBytes(rxSniffBuffer, data);
          const result = scanForFrames(rxSniffBuffer, RxPacketLength);
          rxSniffBuffer = result.remainder;
          for (const frame of result.frames) {
            try { options.onFrame('rx', frame); } catch { /* don't interrupt bridge */ }
          }
        }
      }
    } catch (error) {
      if (stopped) return; // Expected when serial handle is closed during stop
      logger.error('[bridge] Serial read error:', error);
      if (activeClient) {
        activeClient.end();
        activeClient = null;
      }
    }
  }

  // Start serial read loop (non-blocking)
  serialReadLoop();

  // Start TCP server
  const tcpServer: TCPSocketListener<unknown> = Bun.listen({
    hostname: '0.0.0.0',
    port: TCP_PORT,
    socket: {
      open(socket) {
        if (activeClient) {
          logger.warn('[bridge] Rejecting second TCP client — only one connection allowed at a time');
          socket.end();
          return;
        }
        activeClient = socket;
        logger.info(`[bridge] TCP client connected from ${socket.remoteAddress}`);
      },

      data(_socket, data) {
        const bytes = new Uint8Array(data);
        // Forward TCP data -> serial port (immediate, no buffering)
        serialHandle.write(bytes).catch(err => {
          if (!stopped) logger.error('[bridge] Serial write error:', err);
        });

        // Sniff TX frames (host → device)
        if (options.onFrame) {
          txSniffBuffer = appendBytes(txSniffBuffer, bytes);
          const result = scanForFrames(txSniffBuffer, TxPacketLength);
          txSniffBuffer = result.remainder;
          for (const frame of result.frames) {
            try { options.onFrame('tx', frame); } catch { /* don't interrupt bridge */ }
          }
        }
      },

      close(socket) {
        if (activeClient === socket) {
          logger.info('[bridge] TCP client disconnected');
          activeClient = null;
        }
      },

      error(socket, error) {
        logger.error('[bridge] TCP socket error:', error);
        if (activeClient === socket) {
          activeClient = null;
        }
      },
    },
  });

  logger.info(`[bridge] Listening on TCP port ${TCP_PORT}`);
  logger.info('[bridge] Bridge ready — waiting for connections');

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      logger.info('[bridge] Stopping bridge...');
      if (activeClient) {
        activeClient.end();
        activeClient = null;
      }
      tcpServer.stop(true);
      await serialHandle.close();
      logger.info('[bridge] Bridge stopped');
    },
    hasClient() {
      return activeClient !== null;
    },
  };
}

/**
 * Start the bridge in standalone mode (owns the process lifecycle).
 * Used when the server is started with `--bridge`.
 */
export async function startTcpBridgeStandalone(): Promise<void> {
  const bridge = await startTcpBridge();

  process.on('SIGINT', async () => {
    logger.info('\n[bridge] Shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('[bridge] SIGTERM received, shutting down...');
    await bridge.stop();
    process.exit(0);
  });
}
