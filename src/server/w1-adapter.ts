/**
 * 1-Wire (DS18B20) temperature sensor adapter
 *
 * Reads temperature from DS18B20 sensors via Linux sysfs interface.
 * Auto-discovers sensors by scanning /sys/bus/w1/devices/28-*.
 * Uses therm_bulk_read to trigger all conversions simultaneously,
 * then reads cached results — one 750ms wait regardless of sensor count.
 * Gracefully disables itself if 1-Wire is not available.
 */

import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';

const W1_DEVICES_DIR = '/sys/bus/w1/devices';
const BUS_MASTER_DIR = join(W1_DEVICES_DIR, 'w1_bus_master1');
const BULK_READ_PATH = join(BUS_MASTER_DIR, 'therm_bulk_read');

let w1Available: boolean | null = null;
let bulkReadAvailable: boolean | null = null;
let convTimeConfigured = false;

/** Check if 1-Wire sysfs interface is available */
export async function checkW1Available(): Promise<boolean> {
  if (w1Available !== null) return w1Available;

  try {
    await readdir(W1_DEVICES_DIR);
    w1Available = true;
    logger.info('1-Wire interface available');
  } catch {
    w1Available = false;
    logger.info('1-Wire not available — w1 kernel modules not loaded, skipping hardware temp sensors');
  }
  return w1Available;
}

/** Discover all DS18B20 device IDs on the 1-Wire bus */
export async function discoverW1Devices(): Promise<string[]> {
  if (!await checkW1Available()) return [];

  try {
    const entries = await readdir(W1_DEVICES_DIR);
    return entries.filter(e => e.startsWith('28-'));
  } catch (err) {
    logger.error('Failed to scan 1-Wire bus:', err);
    return [];
  }
}

/** Set conv_time=0 on all sensors so reads use bus polling instead of fixed 750ms sleep */
async function configureConvTime(): Promise<void> {
  if (convTimeConfigured) return;

  try {
    const devices = await discoverW1Devices();
    for (const deviceId of devices) {
      const convTimePath = join(W1_DEVICES_DIR, deviceId, 'conv_time');
      try {
        await writeFile(convTimePath, '0');
      } catch {
        // May lack write permission — reads still work, just slower
      }
    }
    convTimeConfigured = true;
  } catch {
    // Non-fatal
  }
}

/** Check if therm_bulk_read is available on the bus master */
async function checkBulkRead(): Promise<boolean> {
  if (bulkReadAvailable !== null) return bulkReadAvailable;

  try {
    await access(BULK_READ_PATH);
    bulkReadAvailable = true;
  } catch {
    bulkReadAvailable = false;
  }
  return bulkReadAvailable;
}

/**
 * Trigger a bulk conversion on all sensors simultaneously.
 * After this returns, readW1Temperature() will return cached results instantly.
 */
async function triggerBulkRead(): Promise<void> {
  try {
    await writeFile(BULK_READ_PATH, 'trigger');
    // Poll until conversion complete (reads back "1")
    for (let i = 0; i < 20; i++) {
      const status = (await readFile(BULK_READ_PATH, 'utf-8')).trim();
      if (status === '1') return;
      await new Promise(r => setTimeout(r, 50));
    }
  } catch {
    // Fall through — individual reads will trigger their own conversions
  }
}

/**
 * Read all sensors efficiently: bulk-trigger conversions, then read cached results.
 * Returns a map of deviceId → temperature in °C.
 */
export async function readAllW1Temperatures(deviceIds: string[]): Promise<Map<string, number>> {
  if (deviceIds.length === 0) return new Map();

  await configureConvTime();

  if (await checkBulkRead()) {
    await triggerBulkRead();
  }

  // Read all results in parallel (instant after bulk conversion)
  const results = new Map<string, number>();
  await Promise.all(deviceIds.map(async (deviceId) => {
    const temp = await readW1Temperature(deviceId);
    if (temp !== null) results.set(deviceId, temp);
  }));

  return results;
}

/**
 * Read temperature from a single DS18B20 sensor.
 * Returns temperature in °C or null on failure.
 * After a bulk read, this returns cached data instantly.
 */
export async function readW1Temperature(deviceId: string): Promise<number | null> {
  const path = join(W1_DEVICES_DIR, deviceId, 'temperature');

  try {
    const raw = await readFile(path, 'utf-8');
    const millideg = parseInt(raw.trim(), 10);
    if (isNaN(millideg)) return null;
    return millideg / 1000;
  } catch {
    return null;
  }
}
