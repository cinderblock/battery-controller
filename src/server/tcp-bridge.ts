/**
 * TCP-Serial Bridge
 *
 * Transparent byte pipe: TCP <-> /dev/serial0
 * No frame parsing, no buffering — raw bytes forwarded bidirectionally
 * with timing fidelity preserved.
 *
 * Runs on the Raspberry Pi as an alternative to the WebSocket server.
 * The Windows proxy connects here to relay traffic from the virtual COM port.
 */

import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import type { Socket } from 'bun';
import { BaudRate } from '../protocol/constants.ts';
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
      '1', // Wait for at least 1 character before returning reads
      'time',
      '0', // No timeout
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

/**
 * Start the TCP-serial bridge.
 *
 * - Opens the serial port as a raw file
 * - Listens for a single TCP client
 * - Forwards bytes bidirectionally with no parsing or buffering
 */
export async function startTcpBridge(): Promise<void> {
  logger.info(`[bridge] Starting TCP-serial bridge`);
  logger.info(`[bridge] Serial port: ${SERIAL_PORT}`);
  logger.info(`[bridge] TCP port: ${TCP_PORT}`);

  // Configure serial port
  await configureSerialPort(SERIAL_PORT);

  // Open serial port for read/write
  const serialHandle: FileHandle = await open(SERIAL_PORT, 'r+');
  logger.info('[bridge] Serial port opened');

  // Track active client
  let activeClient: Socket<unknown> | null = null;

  // Start reading from serial port and forwarding to TCP
  const serialReadBuffer = new Uint8Array(1024);

  async function serialReadLoop() {
    try {
      while (true) {
        const { bytesRead } = await serialHandle.read(serialReadBuffer, 0, serialReadBuffer.length);
        if (bytesRead === 0) continue;

        const data = serialReadBuffer.slice(0, bytesRead);

        if (activeClient) {
          activeClient.write(data);
        }
      }
    } catch (error) {
      logger.error('[bridge] Serial read error:', error);
      // If serial dies, close the TCP client
      if (activeClient) {
        activeClient.end();
        activeClient = null;
      }
    }
  }

  // Start serial read loop (non-blocking)
  serialReadLoop();

  // Start TCP server
  Bun.listen({
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
        // Forward TCP data -> serial port (immediate, no buffering)
        serialHandle.write(new Uint8Array(data)).catch(err => {
          logger.error('[bridge] Serial write error:', err);
        });
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

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\n[bridge] Shutting down...');
    if (activeClient) {
      activeClient.end();
    }
    await serialHandle.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('[bridge] SIGTERM received, shutting down...');
    if (activeClient) {
      activeClient.end();
    }
    await serialHandle.close();
    process.exit(0);
  });
}
