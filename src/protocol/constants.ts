/**
 * Protocol constants shared across all components
 *
 * ZKETech EB Tester serial protocol: 9600 8E1 binary framed packets
 * See protocol.md for full documentation.
 */

// Frame markers
export const StartToken = 0xfa;
export const EndToken = 0xf8;

// Full packet lengths (including start, end, and checksum bytes)
export const RxPacketLength = 19; // device -> host: START + 16 data + checksum + END
export const TxPacketLength = 10; // host -> device: START + 7 data + checksum + END

// Payload lengths (data bytes only, excluding start/end/checksum)
export const RxPayloadLength = 16;
export const TxPayloadLength = 7;

// Base-240 encoding modulus — all payload bytes must be < 0xF0 (240)
// to avoid colliding with frame markers 0xFA and 0xF8
export const Base240Modulus = 240;

// Base-240 divisors for decoding/encoding multi-byte numeric fields
export const Divisors = {
  current: 10_000, // 0.1 mA resolution
  voltage: 1_000, // 1 mV resolution
  cutoffVoltage: 100, // 10 mV resolution
  dpDmVoltage: 1_000, // 1 mV resolution (EBD-USB+ only)
} as const;

// Serial port settings
export const BaudRate = 9600;
export const DataBits = 8;
export const Parity = 'even' as const;
export const StopBits = 1;
