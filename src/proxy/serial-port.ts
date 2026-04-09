/**
 * Virtual COM Port via node-null
 *
 * Creates a virtual COM port using the node-null kernel driver.
 * The port appears as a real COM port in Device Manager — external
 * applications (like EB Tester) open it normally. Our code reads/writes
 * through the VirtualPort's duplex stream.
 *
 * This replaces the previous com0com + serialport approach:
 * - No pre-created COM port pair needed
 * - No serialport npm dependency
 * - The proxy creates the port on startup and destroys it on shutdown
 */

import { createPort, SignalChanged, type SignalState, type VirtualPort } from 'node-null';

export class VirtualComPort {
  private port: VirtualPort | null = null;
  private dataCallbacks: Array<(data: Buffer) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private signalCallbacks: Array<(state: SignalState) => void> = [];

  constructor(private portNumber?: number) {}

  /**
   * Create and open the virtual COM port.
   * Returns the assigned port name (e.g. "COM10").
   */
  async open(): Promise<string> {
    this.port = await createPort(this.portNumber !== undefined ? { portNumber: this.portNumber } : undefined);

    // Assert DSR + CTS so the external app sees a "connected" device
    this.port.setSignals({ dtr: true, rts: true });

    // Wire up data events from the duplex stream
    this.port.stream.on('data', (chunk: Buffer) => {
      for (const cb of this.dataCallbacks) {
        cb(chunk);
      }
    });

    // Forward errors
    this.port.on('error', (err: Error) => {
      for (const cb of this.errorCallbacks) {
        cb(err);
      }
    });

    // Forward signal changes (baud, DTR, parity, open/close, etc.)
    this.port.on('signal', (state: SignalState) => {
      for (const cb of this.signalCallbacks) {
        cb(state);
      }
    });

    return this.port.portName;
  }

  /** Destroy the virtual COM port and remove it from the system */
  async close(): Promise<void> {
    if (this.port && !this.port.destroyed) {
      await this.port.destroy();
    }
    this.port = null;
  }

  /** Write data to the virtual COM port (sent to the external app) */
  async write(data: Uint8Array): Promise<void> {
    if (!this.port) throw new Error('Port not open');
    return new Promise((resolve, reject) => {
      this.port!.stream.write(Buffer.from(data), (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Register a callback for data received from the external app */
  onData(callback: (data: Buffer) => void): void {
    this.dataCallbacks.push(callback);
  }

  /** Register a callback for errors */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  /** Register a callback for serial signal changes */
  onSignal(callback: (state: SignalState) => void): void {
    this.signalCallbacks.push(callback);
  }

  /** The assigned COM port name (e.g. "COM10"), or null if not open */
  get portName(): string | null {
    return this.port?.portName ?? null;
  }

  /** Whether an external application has the COM port open */
  get isComOpen(): boolean {
    return this.port?.isComOpen ?? false;
  }

  /** Whether the port is open */
  get isOpen(): boolean {
    return this.port !== null && !this.port.destroyed;
  }
}

/** Re-export SignalChanged for use in the proxy */
export { SignalChanged, type SignalState } from 'node-null';
