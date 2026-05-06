/**
 * 1-Wire (DS18B20) temperature sensor adapter
 *
 * Reads temperature from DS18B20 sensors via Linux sysfs interface.
 * Auto-discovers sensors by scanning /sys/bus/w1/devices/28-*.
 * Gracefully disables itself if 1-Wire is not available.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';

const W1_DEVICES_DIR = '/sys/bus/w1/devices';

let w1Available: boolean | null = null;

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

/**
 * Read temperature from a DS18B20 sensor.
 * Returns temperature in °C or null on failure.
 *
 * The kernel exposes the temperature as an integer in millidegrees C
 * at /sys/bus/w1/devices/{id}/temperature
 */
export async function readW1Temperature(deviceId: string): Promise<number | null> {
  const path = join(W1_DEVICES_DIR, deviceId, 'temperature');

  try {
    const raw = await readFile(path, 'utf-8');
    const millideg = parseInt(raw.trim(), 10);
    if (isNaN(millideg)) return null;
    return millideg / 1000;
  } catch {
    // Sensor may be temporarily unreadable (conversion in progress, disconnected)
    return null;
  }
}
