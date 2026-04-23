#!/usr/bin/env bun
/**
 * Extract the device type table from the EB Tester VB6 binary.
 *
 * The table at offset 0x1E634 contains inline VB6 strings (BSTR-like):
 *   4 bytes length (little-endian, byte count)
 *   N bytes UTF-16LE string data
 *   0-3 bytes padding to next 4-byte boundary
 *
 * Usage: bun src/tools/extract-device-table.ts [path-to-eb.exe]
 */

import { readFileSync } from 'fs';

const exePath = process.argv[2] || 'C:/Program Files (x86)/ZKETECH/eb.exe';
const buf = readFileSync(exePath);

const TABLE_START = 0x1e634;
const TABLE_END = 0x1eb00;

interface DeviceEntry {
  index: number;
  offset: number;
  name: string;
}

const entries: DeviceEntry[] = [];
let offset = TABLE_START;
let index = 0;

while (offset < TABLE_END - 4) {
  // Read 4-byte string length (little-endian)
  const len = buf.readUInt32LE(offset);

  // Valid string lengths: 4-30 bytes (2-15 UTF-16 chars), even
  if (len < 4 || len > 30 || len % 2 !== 0 || offset + 4 + len > TABLE_END) {
    offset += 4;
    continue;
  }

  // Read UTF-16LE string
  const strBuf = buf.slice(offset + 4, offset + 4 + len);

  // Validate: high bytes should all be 0x00 for ASCII range
  let isAsciiUtf16 = true;
  for (let i = 1; i < strBuf.length; i += 2) {
    if (strBuf[i] !== 0) {
      isAsciiUtf16 = false;
      break;
    }
  }

  if (isAsciiUtf16) {
    const name = strBuf.toString('utf16le');

    // Only count entries that look like device names (EBC-* or EBD-*)
    // or known labels that are part of the table structure
    if (/^EB[CD]-/.test(name)) {
      entries.push({ index, offset: offset + 4, name });
      index++;
    } else if (index === 0 && /^\[mA\]$/.test(name)) {
      // The first entry seems to be a label — include but note it
      entries.push({ index, offset: offset + 4, name: `${name} (label, not a device)` });
      index++;
    }
  }

  // Advance past string + padding to next 4-byte boundary
  const totalLen = 4 + len;
  offset += totalLen + (totalLen % 4 === 0 ? 0 : 4 - (totalLen % 4));
}

// Print the table
console.log('Device Type Table (from eb.exe @ 0x1E634)');
console.log('==========================================');
console.log('');
console.log('Index  Hex   Family  Name');
console.log('-----  ----  ------  ----');

for (const e of entries) {
  const hex = `0x${e.index.toString(16).padStart(2, '0')}`;
  const family = e.name.startsWith('EBC') ? 'ebc' : e.name.startsWith('EBD') ? 'ebd' : '   ';
  console.log(`  ${e.index.toString().padStart(2)}   ${hex}   ${family}     ${e.name}`);
}

console.log('');
console.log(`Total device entries: ${entries.length}`);
console.log('');

// Highlight the known device
const a40l = entries.find(e => e.name === 'EBC-A40L');
if (a40l) {
  console.log(`EBC-A40L found at index ${a40l.index} (0x${a40l.index.toString(16)})`);
} else {
  console.log('WARNING: EBC-A40L not found in table!');
}

// Check what's at index 17 (0x11) — should be EBC-A40L
const at17 = entries.find(e => e.index === 17);
if (at17) {
  console.log(`Index 17 (0x11) = "${at17.name}"`);
}

// Export as TypeScript const for use in the codebase
console.log('\n// TypeScript lookup table:');
console.log('export const DeviceTypeTable: Record<number, { name: string; family: "ebc" | "ebd" }> = {');
for (const e of entries) {
  if (e.name.includes('label')) continue;
  const family = e.name.startsWith('EBC') ? 'ebc' : 'ebd';
  console.log(`  ${e.index}: { name: '${e.name}', family: '${family}' },`);
}
console.log('};');
