/**
 * Serial port communication manager
 * Handles connection to hardware device and protocol parsing
 *
 * PROTOCOL: 8E1 9600 binary packet protocol
 * - Device sends 19-token packets (including START and END tokens)
 * - Host sends 10-token packets (including START and END tokens)
 * - START token: 0xFA, END token: 0xF8
 *
 * IMPLEMENTATION: Direct file I/O on Linux serial device
 * - Serial ports are just files on Linux (/dev/serial0, /dev/ttyUSB0, etc.)
 * - We configure the port using stty and read/write using standard file I/O
 * - This avoids native dependencies and works perfectly with Bun runtime
 * - Alternative to serialport package which requires Node-specific native APIs
 *   See: https://github.com/oven-sh/bun/issues/18546
 */

/**
 * Serial Protocol: 8E1 9600 binary
 * Sample communications to/from device:
 * 
 * START: (From host) (10 tokens per packet)
 * 0xFA 0x05 0x00 0x00 0x00 0x00 0x00 0x00 0x05 0xF8
 * 
 * RESPONSES: (From device) (19 tokens per packet) every 2 seconds
 * 
 * 0xFA 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0xC8 0x00 0x50 0x00 0x00 0x0A 0x92 0xF8
 * 0xFA 0x64 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01 0x46 0x02 0x14 0x11 0x86 0x0A 0xA8 0xF8
 * 0xFA 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0xC8 0x00 0x50 0x00 0x00 0x0A 0x92 0xF8
 * 0xFA 0x64 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01 0x46 0x02 0x14 0x11 0x86 0x0A 0xA8 0xF8
 * 0xFA 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0xC8 0x00 0x50 0x00 0x00 0x0A 0x92 0xF8
 * 0xFA 0x64 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01 0x46 0x02 0x14 0x11 0x86 0x0A 0xA8 0xF8
 * 0xFA 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0xC8 0x00 0x50 0x00 0x00 0x0A 0x92 0xF8
 * 
 * STOP: (from host) (10 tokens per packet)
 * 0xFA 0x06 0x00 0x00 0x00 0x00 0x00 0x00 0x06 0xF8

 */

import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { checksum } from '../protocol/codec.ts';
import { EndToken, RxPacketLength, StartToken, TxPacketLength } from '../protocol/constants.ts';
import { logger } from '../utils/logger.ts';

const SkipPacketWithFailedChecksum = true;

export class SerialManager {
  private fileHandle: FileHandle | null = null;
  private connectCommandSent: boolean = false;
  private lastPacketReceived: number = 0;
  private readonly DEVICE_TIMEOUT_MS = 5000; // 5 seconds

  constructor(
    private portPath: string = '/dev/serial0',
    private baudRate: number = 9600
  ) {}

  async connect() {
    logger.info(`📟 Connecting to serial port: ${this.portPath} @ ${this.baudRate} baud`);

    try {
      // Configure serial port using stty
      await this.configurePort();

      // Open the serial device file for reading and writing
      this.fileHandle = await open(this.portPath, 'r+');

      logger.info('✅ Serial port connected');

      for (const listener of this.connectionListener) listener(true);

      // Start reading from serial port
      this.doReading().catch(error => {
        logger.error('❌ Error reading from serial port:', error);
        this.disconnect();
      });
    } catch (error) {
      logger.error('❌ Failed to connect to serial port:', error);
      throw error;
    }
  }

  async disconnect() {
    if (!this.fileHandle) return;

    const handle = this.fileHandle;
    this.fileHandle = null;
    await handle.close();

    logger.info('📴 Serial port disconnected');

    for (const listener of this.connectionListener) listener(false);
  }

  private connectionListener: Set<(online: boolean) => void> = new Set();

  addConnectionListener(listener: (online: boolean) => void): () => void {
    this.connectionListener.add(listener);
    return () => this.connectionListener.delete(listener);
  }

  private readBuffer: Buffer = Buffer.allocUnsafe(RxPacketLength * 10);
  private readBufferOffset = 0;

  private async doReading() {
    if (!this.fileHandle) throw new Error('Serial port not connected');

    let consecutiveZeroReads = 0;

    while (this.fileHandle) {
      // Blocks until data is available (stty min 1)
      const { bytesRead } = await this.fileHandle.read(
        this.readBuffer,
        this.readBufferOffset,
        this.readBuffer.length - this.readBufferOffset
      );

      if (bytesRead === 0) {
        consecutiveZeroReads++;
        if (consecutiveZeroReads >= 10) {
          logger.error('Serial port returning no data after 10 attempts, disconnecting');
          this.disconnect();
          return;
        }
        await Bun.sleep(500);
        continue;
      }

      consecutiveZeroReads = 0;
      this.readBufferOffset += bytesRead;
      this.parseBuffer();
    }
  }

  private parseBuffer(): void {
    for (let i = 0; i < this.readBufferOffset - RxPacketLength; i++) {
      if (!this.parsePacket(this.readBuffer.slice(i, i + RxPacketLength))) continue;

      const end = i + RxPacketLength;
      this.readBuffer.copy(this.readBuffer, 0, end, this.readBufferOffset);
      this.readBufferOffset -= end;
      i = -1; // restart loop
    }
  }

  /**
   * Parse a packet from the serial port
   * @param packet - The packet to parse
   * @returns True if a packet was detected and we can skip the data from it
   */
  private parsePacket(packet: Buffer): boolean {
    if (packet.length !== RxPacketLength) throw new Error('Invalid packet length');

    const EndIndex = RxPacketLength - 1;
    const ChecksumIndex = EndIndex - 1;

    if (packet[0] !== StartToken) return false;
    if (packet[EndIndex] !== EndToken) return false;

    logger.info('📥 Received block:', packet.toString('hex'));

    // Validate checksum: XOR of data bytes, reduced mod 240 (base-240 safe),
    // must match the checksum byte on the wire.
    const data = Buffer.from(packet.slice(1, ChecksumIndex));
    if (checksum(data) !== packet[ChecksumIndex]) return SkipPacketWithFailedChecksum;

    logger.info('📥 Received valid packet:', data.toString('hex'));

    // Record packet received timestamp
    this.lastPacketReceived = Date.now();

    for (const listener of this.packetListeners) listener(data);

    return true;
  }

  private packetListeners: Set<(packet: Buffer) => void> = new Set();

  addPacketListener(listener: (packet: Buffer) => void): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  /**
   * Configure serial port for 8E1 mode
   */
  private async configurePort(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-F',
        this.portPath,
        `${this.baudRate}`,
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

      const argsString = args.join(' ');
      logger.info(`🔧 Running stty ${argsString}`);
      const stty = spawn('stty', args);

      stty.on('close', code => {
        if (code === 0) {
          logger.info(`✅ Serial port configured: ${this.baudRate} baud, 8E1 mode`);
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
   * Send a 10-token packet to device
   * Format: START + 7 data tokens + checksum + END
   */
  async sendPacket(data: Buffer): Promise<void> {
    if (!this.fileHandle) throw new Error('Serial port not connected');

    if (data.length !== TxPacketLength - 3) {
      throw new Error(`Packet must have exactly ${TxPacketLength - 2} data tokens`);
    }

    const sendBuffer = Buffer.from([StartToken, ...data, checksum(data), EndToken]);

    await this.fileHandle.write(sendBuffer);
    logger.info('📤 Sent packet:', sendBuffer.toString('hex'));
  }

  /**
   * Send CONNECT command to device
   * Packet: 0xFA 0x05 0x00 0x00 0x00 0x00 0x00 0x00 0x05 0xF8
   *           fa   05   00   00   00   00   00   00   05   f8
   */
  async sendConnectCommand(): Promise<void> {
    logger.info('📤 Sending START command...');
    this.connectCommandSent = true;
    await this.sendPacket(Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
  /**
   * Send DISCONNECT command to device
   * Packet: 0xFA 0x06 0x00 0x00 0x00 0x00 0x00 0x00 0x06 0xF8
   */
  async sendDisconnectCommand(): Promise<void> {
    logger.info('📤 Sending STOP command...');
    this.connectCommandSent = false;
    this.lastPacketReceived = 0;
    await this.sendPacket(Buffer.from([0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  /**
   * Check if serial port is open
   */
  isPortOpen(): boolean {
    return this.fileHandle !== null;
  }

  /**
   * Check if device is connected
   * Device is considered connected if:
   * - Connect command has been sent
   * - At least one packet has been received after the command
   * - Last packet received within the timeout window
   */
  isDeviceConnected(): boolean {
    if (!this.connectCommandSent || this.lastPacketReceived === 0) {
      return false;
    }
    const now = Date.now();
    return now - this.lastPacketReceived < this.DEVICE_TIMEOUT_MS;
  }

  /**
   * Get last packet received timestamp
   */
  getLastPacketTime(): number {
    return this.lastPacketReceived;
  }

  async sendStopCommand(): Promise<void> {
    logger.info('📤 Sending START command...');
    await this.sendPacket(Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  async sendStartD_CC(params: unknown): Promise<void> {
    logger.info('📤 Sending START command...');
    await this.sendPacket(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  async sendAdjustD_CC(params: unknown): Promise<void> {
    logger.info('📤 Sending ADJUST command...');
    await this.sendPacket(Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  async sendContinueD_CC(params: unknown): Promise<void> {
    logger.info('📤 Sending CONTINUE command...');
    await this.sendPacket(Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  async sendStartD_CP(params: unknown): Promise<void> {
    logger.info('📤 Sending STOP command...');
    await this.sendPacket(Buffer.from([0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }

  async sendContinueD_CP(params: unknown): Promise<void> {
    logger.info('📤 Sending STOP command...');
    await this.sendPacket(Buffer.from([0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
  // Variants with command codes 21/28, 31/38, 41/48, 51/58, 61/68, 71/78	Start
}

// checksum() is now imported from ../protocol/codec.ts

type D_CC_Params = unknown;
type D_CP_Params = unknown;

enum Mode {
  D_CC = 0,
  D_CP = 1,
  NIMH = 2,
  NICHROME = 3,
  LIPO = 4,
  OTHER = 5,
}

enum Status {
  IDLE = 0,
  WORKING = 1,
  AUTO_STOPPED = 2,
}

class StatusCodes {
  constructor(
    private mode: Mode,
    private status: Status
  ) {}

  get code(): number {
    return this.mode + this.status * 10;
  }
}

/*

Other example packets:

Test 1: Enable "D-CC" or "C-CV" mode...

Connect:
0500000000000005

3.103V - Voltage as reported by the software
Messages from device:
0000000CDF00000000000A000000000AD3
6400000CDF000000000146021411860A7B
...

The message we sent to the device:
01000A016E000561

UI was sending one of:
- D-CC 0.10A 3.5V 
- C-CV Test: 0.10A .8V Cutoff .10A

Received:
0000000CDF00000000000A016E00050AB9

Test 2: Discharge?

Device was sending:
0000000CDF00000000000A016E00050AB9
...

We sent: Start (possibly faulty decode)
21000A0050000A71

Device responded with:
0C00000CDF00000000000A0050000A0A85
1600000CDF00000000000A0050000A0A9F
0200000CDF00000000000A0050000A0A8B
0200000CDF00000000000A0050000A0A8B
...

We started the discharge
D-CC: Test 0.10A Cutoff 0.8V Max Time 0
01000A005000005B

Running, UI reported: 3.103V 0.1A 0.31W

0A00000CDF00000000000A005000000A89
0A000A0CDF00000000000A005000000A83
0A000A0CDF00010000000A005000000A82
0A000A0CDF00020000000A005000000A81

Possibly glitched???
0700640050000033

Adjust Test Val to 1.00A
Running: 3.080V~3.081V 1.00A 3.08W

0A00640CC9000200000064005000000A97
0A00640CC9000300000064005000000A96
0A00640CC9000300000064005000000A96
0A00640CC9000400000064005000000A91
0A00640CC9000500000064005000000A90
0A00640CC9000500000064005000000A90
0A00640CC9000600000064005000000A93
0A00640CC9000600000064005000000A93
0A00640CC9000700000064005000000A92
0A00640CC9000700000064005000000A92
0A00640CC9000800000064005000000A9D
0A00640CC9000800000064005000000A9D
0A00640CC9000900000064005000000A9C
0A00640CC9000A00000064005000000A9F
0A00640CC8000A00000064005000000A9E
0A00640CC9000B00000064005000000A9E
0A00640CC9000B00000064005000000A9E
0A00640CC9000C00000064005000000A99
0A00640CC8000C00000064005000000A98
0A00640CC9000D00000064005000000A98
0A00640CC8000D00000064005000000A99
0A00640CC9000E00000064005000000A9B
0A00640CC9000F00000064005000000A9A
0A00640CC9000F00000064005000000A9A
0A00640CC9001000000064005000000A85

Power off??
0A00020000000008

0A00640CC9001000000064005000000A85
0A00640CC9001100000064005000000A84
0A00640CC8001100000064005000000A85
0A00640CC8001200000064005000000A86
0A00640CC9001200000064005000000A87
0A00640CC8001300000064005000000A87
0A00640CC9001400000064005000000A81
0A00640CC9001400000064005000000A81
0A00640CC8001500000064005000000A81
0A00640CC8001500000064005000000A81
0A00640CC9001600000064005000000A83
0A00640CC8001600000064005000000A82
0A00640CC9001700000064005000000A82
0A00640CC8001700000064005000000A83
0A00640CC8001800000064005000000A8C
0A00640CC8001900000064005000000A8D
0A00640CC8001900000064005000000A8D
0A00640CC8001A00000064005000000A8E
0A00640CC8001A00000064005000000A8E
0A00640CC8001B00000064005000000A8F
0A00640CC8001B00000064005000000A8F
0A00640CC8001C00000064005000000A88
0A00640CC8001C00000064005000000A88
0A00640CC8001E00000064005000000A8A
0A00640CC8001E00000064005000000A8A
0A00640CC8001F00000064005000000A8B
0A00640CC8001F00000064005000000A8B
0A00640CC8002000000064005000000AB4
0A00640CC8002000000064005000000AB4
0A00640CC8002100000064005000000AB5
0A00640CC8002100000064005000000AB5
0A00640CC8002200000064005000000AB6
0A00640CC8002300000064005000000AB7
0A00640CC8002300000064005000000AB7
0A00640CC8002400000064005000000AB0
0A00640CC8002400000064005000000AB0
0A00640CC8002500000064005000000AB1
0A00640CC8002500000064005000000AB1
0A00640CC8002600000064005000000AB2
0A00640CC8002600000064005000000AB2
0A00640CC8002700000064005000000AB3

0500000000000005

0500000000000005

0A00640CC8002800000064005000000ABC

080064005000003C // corrupt

0A00640CC8002800000064005000000ABC
0A00640CC8002900000064005000000ABD
0A00640CC8002900000064005000000ABD
0A00640CC8002A00000064005000000ABE
0A00640CC8002A00000064005000000ABE
0A00640CC8002B00000064005000000ABF
0A00640CC8002B00000064005000000ABF
0A00640CC8002C00000064005000000AB8
0A00640CC8002D00000064005000000AB9
0A00640CC8002D00000064005000000AB9
0A00640CC8002E00000064005000000ABA
0A00640CC8002E00000064005000000ABA
0A00640CC8002F00000064005000000ABB
0A00640CC8002F00000064005000000ABB
0A00640CC8003000000064005000000AA4
0A00640CC8003000000064005000000AA4
0A00640CC8003100000064005000000AA5
0A00640CC8003200000064005000000AA6
0200000000000002
// glitch?
0000640CC8003200000064005000000AAC
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF
0000000CDF003200000064005000000ADF

Test 3: 

0200000CDF000500000064016E000A0ADF
C-CV Test: 1A Voltage 3.5V Cutoff 0.1A
Start
210064016E000A20
Running  3.103V-3.109V 1A 3.1W

0C00000CDF000000000064016E000A0AD4
0C00640CDF000000000064016E000A0AB0
0C00640CDF000100000064016E000A0AB1
0C00640CDF000100000064016E000A0AB1
0C00640CDF000200000064016E000A0AB2
0C00640CDF000300000064016E000A0AB3
0C00640CDF000300000064016E000A0AB3
0C00640CE0000400000064016E000A0A8B
0C00640CE0000400000064016E000A0A8B
0C00640CE1000500000064016E000A0A8B
0C00640CE1000500000064016E000A0A8B
0C00640CE1000600000064016E000A0A88
0C00640CE1000600000064016E000A0A88
0C00640CE2000700000064016E000A0A8A
0C00640CE2000800000064016E000A0A85
0C00640CE2000800000064016E000A0A85
0C00640CE3000900000064016E000A0A85
0C00640CE3000900000064016E000A0A85
0C00640CE4000A00000064016E000A0A81
0C00640CE4000A00000064016E000A0A81
0C00640CE4000B00000064016E000A0A80
0C00640CE4000B00000064016E000A0A80
0C00640CE4000C00000064016E000A0A87
0C00640CE5000D00000064016E000A0A87
0C00640CE5000D00000064016E000A0A87
0C00640CE5000E00000064016E000A0A84
0C00640CE5000E00000064016E000A0A84
0C00640CE5000F00000064016E000A0A85
0C00640CE5000F00000064016E000A0A85
0C00640CE5001000000064016E000A0A9A
0C00640CE5001000000064016E000A0A9A
Stop
0A0001000000000B
0C00640CE5001100000064016E000A0A9B
0C00640CE5001200000064016E000A0A98
0C00640CE5001200000064016E000A0A98
0C00640CE5001300000064016E000A0A99
0C00640CE5001300000064016E000A0A99
0C00640CE5001400000064016E000A0A9E
0C00640CE5001400000064016E000A0A9E
0C00640CE5001500000064016E000A0A9F
0200000000000002
0200640CE5001500000064016E000A0A91
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF

Test 4: Test Battery Resistance

0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
090064000000006D
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
090064000000006D
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
090064000000006D
0200000CDE001500000064016E000A0ACE
0200000CDF001500000064016E000A0ACF
0900C800000000C1
0200000CD7000800000064016E000A0ADA
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
090214000000001F
0200000CD0000A00000064016E000A0ADF
0200000CDF001500000064016E000A0ACF
0200000CDF001500000064016E000A0ACF
0904280000000025
0200000CC2001500000064016E000A0AD2
0200000CDE001500000064016E000A0ACE
0200000CDF001500000064016E000A0ACF
0904280000000025
0200000CC2001500000064016E000A0AD2
0200000CDE001500000064016E000A0ACE
0200000CDE001500000064016E000A0ACE

*/
