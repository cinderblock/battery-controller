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

// Base-240 divisors for decoding/encoding multi-byte numeric fields.
// Divisors are MODEL-DEPENDENT — see protocol.md for details.
export const Divisors = {
  current: 10_000, // 0.1 mA resolution (EBD-USB+)
  voltage: 1_000, // 1 mV resolution (all models)
  cutoffVoltage: 100, // 10 mV resolution (all models)
  dpDmVoltage: 1_000, // 1 mV resolution (EBD-USB+ only)
} as const;

// EBC charger/discharger divisors (confirmed on EBC-A40L via serial capture)
export const EbcDivisors = {
  current: 100, // 10 mA resolution — GUI format "00.00"
  voltage: 1_000, // 1 mV resolution — GUI format "00.000" (same as EBD)
  setpointVoltage: 100, // 10 mV resolution — target voltage / UVC cutoff
  cutoffCurrent: 100, // 10 mA resolution — min current to end CV charge
  capacity: 1, // 1 mAh — raw base-240 value IS mAh (device-computed)
} as const;

// Known state byte values
export const RxState = {
  // EBD-USB+ states (from sigrok)
  EBD_IDLE: 0x00, // Measuring, load OFF
  EBD_IDLE_INFO: 0x64, // Info packet (load OFF alternate)
  EBD_ACTIVE: 0x0a, // Measuring, load ON
  EBD_ACTIVE_INFO: 0x6e, // Info packet (load ON alternate)
  // EBC charger states (confirmed on EBC-A40L)
  EBC_IDLE: 0x02, // Idle / monitoring, test not running
  EBC_IDLE_INFO: 0x66, // Info packet (idle alternate, = 0x02 + 0x64)
  EBC_CHARGING: 0x0c, // Charging active, current flowing
  EBC_CHARGE_COMPLETE: 0x16, // Charge cutoff reached (transient, → idle)
} as const;

// Info packet state offset — info state = normal state + INFO_OFFSET
export const INFO_STATE_OFFSET = 0x64;

// Serial port settings
export const BaudRate = 9600;
export const DataBits = 8;
export const Parity = 'even' as const;
export const StopBits = 1;
