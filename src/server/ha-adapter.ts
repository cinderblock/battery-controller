/**
 * Home Assistant HTTP temperature adapter
 *
 * Fetches entity states from a Home Assistant instance via its REST API.
 * Uses long-lived access tokens for authentication.
 */

import { logger } from '../utils/logger.ts';
import type { HomeAssistantConfig } from './temp-config.ts';

const FETCH_TIMEOUT_MS = 5000;

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    device_class?: string;
    unit_of_measurement?: string;
    [key: string]: unknown;
  };
  last_updated: string;
}

/** Test connectivity to a Home Assistant instance. Returns null on success, error string on failure. */
export async function testHaConnection(ha: HomeAssistantConfig): Promise<string | null> {
  try {
    const resp = await fetch(`${ha.baseUrl}/api/`, {
      headers: { Authorization: `Bearer ${ha.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return `HTTP ${resp.status}: ${resp.statusText}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Fetch all entity states from Home Assistant */
export async function fetchHaStates(ha: HomeAssistantConfig): Promise<HaEntityState[]> {
  const resp = await fetch(`${ha.baseUrl}/api/states`, {
    headers: { Authorization: `Bearer ${ha.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HA /api/states failed: HTTP ${resp.status}`);
  }
  return resp.json() as Promise<HaEntityState[]>;
}

/** Fetch temperature entities (device_class=temperature or sensor.* with °C/°F unit) */
export async function fetchHaTemperatureEntities(ha: HomeAssistantConfig): Promise<HaEntityState[]> {
  const states = await fetchHaStates(ha);
  return states.filter(e => {
    if (e.attributes.device_class === 'temperature') return true;
    if (
      e.entity_id.startsWith('sensor.') &&
      (e.attributes.unit_of_measurement === '°C' || e.attributes.unit_of_measurement === '°F')
    ) {
      return true;
    }
    return false;
  });
}

/** Read temperature for a single entity. Returns °C or null on failure. */
export async function readHaTemperature(ha: HomeAssistantConfig, entityId: string): Promise<number | null> {
  try {
    const resp = await fetch(`${ha.baseUrl}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${ha.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const state = await resp.json() as HaEntityState;
    const value = parseFloat(state.state);
    if (isNaN(value)) return null;

    // Convert °F to °C if needed
    if (state.attributes.unit_of_measurement === '°F') {
      return (value - 32) * 5 / 9;
    }
    return value;
  } catch (err) {
    logger.debug(`Failed to read HA entity ${entityId}:`, err);
    return null;
  }
}
