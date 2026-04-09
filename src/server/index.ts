#!/usr/bin/env bun

/**
 * Main server entry point
 * Single Bun server handles both HTTP and WebSocket
 */

import type { ServerWebSocket } from 'bun';
import homepage from '../frontend/index.html';
import { logger } from '../utils/logger.ts';
import { shutdown } from '../utils/shutdown.ts';
import { SerialManager } from './serial.ts';
import { StateManager } from './state.ts';
import { startTcpBridge } from './tcp-bridge.ts';

const Port = Number(process.env.PORT) || 80;

// WebSocket client tracking
const wsClients = new Set<ServerWebSocket>();

async function main() {
  // Bridge mode: transparent TCP-serial byte pipe (no WebSocket server)
  if (process.argv.includes('--bridge') || process.env.MODE === 'bridge') {
    await startTcpBridge();
    return;
  }

  logger.info('🚀 Starting Battery Charge & Discharge Controller Server...');

  // Heartbeat watchdog timer
  let heartbeatWatchdog: Timer | null = null;

  // Initialize state manager
  const stateManager = new StateManager();

  // Initialize serial port communication
  const serialManager = new SerialManager();
  await serialManager.connect();

  // Update serial port status when connection changes
  serialManager.addConnectionListener(connected => {
    stateManager.updateSerialPortStatus(connected);
    if (!connected) {
      // Port closed, device is definitely disconnected
      stateManager.updateDeviceStatus(false);
    }
  });

  // Listen for packets from device and log them
  serialManager.addPacketListener((packet: Buffer) => {
    const hex =
      packet
        .toString('hex')
        .toUpperCase()
        .match(/.{1,2}/g)
        ?.join(' ') || '';
    logger.info('📥 Received pack:', hex);

    // Add to message history
    stateManager.addMessage('in', hex);

    // Record device activity
    stateManager.recordDeviceActivity();
  });

  // Initial serial port status
  stateManager.updateSerialPortStatus(serialManager.isPortOpen());

  // Helper function to reset heartbeat watchdog timer
  function resetHeartbeatWatchdog() {
    // Clear existing watchdog if any
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }

    // Set new watchdog that fires after 2 seconds of inactivity
    heartbeatWatchdog = setTimeout(() => {
      // Send heartbeat to all clients
      const heartbeatMessage = JSON.stringify({
        type: 'heartbeat',
        data: { timestamp: Date.now() },
      });

      for (const client of wsClients) {
        try {
          client.send(heartbeatMessage);
        } catch (error) {
          logger.error('Failed to send heartbeat to WebSocket client:', error);
        }
      }

      // Reset watchdog to continue the cycle
      resetHeartbeatWatchdog();
    }, 2000);
  }

  // Helper function to broadcast message to all clients and reset watchdog
  function broadcastToClients(message: string) {
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch (error) {
        logger.error('Failed to send to WebSocket client:', error);
      }
    }
    // Reset watchdog after any broadcast
    resetHeartbeatWatchdog();
  }

  // Create single Bun server for HTTP + WebSocket
  const server = Bun.serve({
    port: Port,

    development: process.env.NODE_ENV === 'development',

    error: error => {
      logger.error('❌ Server error:', error);
    },

    // WebSocket handler
    websocket: {
      open(ws) {
        wsClients.add(ws);
        logger.info('🔌 WebSocket client connected');

        // Update WebSocket status
        stateManager.updateWebSocketStatus(true);
        stateManager.recordWebSocketActivity();

        // Send initial state
        ws.send(
          JSON.stringify({
            type: 'state',
            data: stateManager.getState(),
          })
        );

        // Send message history
        ws.send(
          JSON.stringify({
            type: 'history',
            data: stateManager.getMessageHistory(),
          })
        );

        // Reset watchdog after sending initial data
        resetHeartbeatWatchdog();
      },
      close(ws) {
        wsClients.delete(ws);
        logger.info('🔌 WebSocket client disconnected');

        // Update WebSocket status
        if (wsClients.size === 0) {
          stateManager.updateWebSocketStatus(false);
        }
      },
      async message(ws, message) {
        try {
          const data = JSON.parse(message as string);
          logger.info('📨 Received WebSocket message:', JSON.stringify(data, null, 2));

          // Record WebSocket activity
          stateManager.recordWebSocketActivity();

          if (data.type === 'command') {
            logger.info('📨 Received command:', data.data.command);

            if (data.data.command === 'start') {
              await serialManager.sendConnectCommand();
              stateManager.addMessage('out', '05 00 00 00 00 00 00 CONNECT');
              // Device connection will be updated when packets are received
            } else if (data.data.command === 'stop') {
              await serialManager.sendDisconnectCommand();
              stateManager.addMessage('out', '06 00 00 00 00 00 00 DISCONNECT');
              // Device is now disconnected
              stateManager.updateDeviceStatus(false);
            }
          }
        } catch (error) {
          logger.error('❌ Failed to process WebSocket message:', error);
        }
      },
    },

    routes: {
      '/': homepage,
      // ...other HTTP routes
    },
    fetch(req, server) {
      const url = new URL(req.url);
      // Upgrade HTTP requests to WebSocket if needed
      if (url.pathname === '/ws' && server.upgrade(req)) return;

      return new Response('Not Found', { status: 404 });
    },
  });

  // Subscribe to state changes and broadcast to all WebSocket clients
  stateManager.subscribe(state => {
    const message = JSON.stringify({
      type: 'state',
      data: state,
    });

    broadcastToClients(message);
  });

  // Subscribe to new serial messages and broadcast to all WebSocket clients
  stateManager.subscribeToMessages(msg => {
    const message = JSON.stringify({
      type: 'message',
      data: msg,
    });

    broadcastToClients(message);
  });

  // Initialize heartbeat watchdog timer
  resetHeartbeatWatchdog();

  // Periodically check device connection status
  setInterval(() => {
    const isConnected = serialManager.isDeviceConnected();
    const currentState = stateManager.getState();
    if (currentState.connectionChain.device.connected !== isConnected) {
      stateManager.updateDeviceStatus(isConnected);
    }
  }, 1000); // Check every second

  logger.info(`🌐 Server running at http://localhost:${Port}`);
  logger.info(`📡 WebSocket available at ws://localhost:${Port}/ws`);
  logger.info('✅ Server ready');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\n🛑 Shutting down gracefully...');
    // Clear heartbeat watchdog
    if (heartbeatWatchdog !== null) {
      clearTimeout(heartbeatWatchdog);
    }
    await serialManager.disconnect();
    server.stop();
    shutdown(0);
  });
}

main().catch(error => {
  logger.error('❌ Failed to start server:', error);
  shutdown(1);
});
