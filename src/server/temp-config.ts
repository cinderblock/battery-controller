/**
 * Temperature configuration — JSON file-based storage
 *
 * All temperature/sensor config lives in a JSON file on disk.
 * The JSON file is the source of truth; the DB temp_channels table
 * is synced from it on startup and on changes (for foreign key references).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { upsertTempChannel, getTempChannelByKey, updateTempChannel, deleteTempChannel, getTempChannels } from './db.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface W1ChannelConfig {
  id: string;           // "w1-28-00000abcdef"
  name: string | null;
  sourceType: 'w1';
  deviceId: string;     // "28-00000abcdef"
  enabled: boolean;
  alertMaxC: number | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  unpluggedAt: string | null;
}

export interface HttpChannelConfig {
  id: string;           // "ha-sensor.garage_temperature"
  name: string | null;
  sourceType: 'http';
  entityId: string;     // "sensor.garage_temperature"
  enabled: boolean;
  alertMaxC: number | null;
  firstSeenAt: string;
}

export type ChannelConfig = W1ChannelConfig | HttpChannelConfig;

export interface HomeAssistantConfig {
  baseUrl: string;
  token: string;
}

export interface TempConfig {
  pollIntervalS: number;
  homeAssistant: HomeAssistantConfig | null;
  channels: ChannelConfig[];
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: TempConfig = {
  pollIntervalS: 10,
  homeAssistant: null,
  channels: [],
};

// ── File path ─────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || '/opt/battery-controller/data';
const CONFIG_PATH = join(DATA_DIR, 'temp-config.json');

// ── State ─────────────────────────────────────────────────────────

let config: TempConfig = { ...DEFAULT_CONFIG, channels: [] };

// ── Public API ────────────────────────────────────────────────────

export function getTempConfig(): TempConfig {
  return config;
}

export async function loadTempConfig(): Promise<TempConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TempConfig>;
    config = {
      pollIntervalS: parsed.pollIntervalS ?? DEFAULT_CONFIG.pollIntervalS,
      homeAssistant: parsed.homeAssistant ?? null,
      channels: parsed.channels ?? [],
    };
    logger.info(`Temperature config loaded (${config.channels.length} channels)`);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      logger.info('No temperature config file found, using defaults');
      config = { ...DEFAULT_CONFIG, channels: [] };
    } else {
      logger.error('Failed to parse temperature config, using defaults:', err);
      config = { ...DEFAULT_CONFIG, channels: [] };
    }
  }
  return config;
}

export async function saveTempConfig(): Promise<void> {
  const json = JSON.stringify(config, null, 2) + '\n';
  await writeFile(CONFIG_PATH, json, 'utf-8');
}

/** Sync JSON config channels into the DB temp_channels table (for FK references) */
export function syncConfigToDb(): void {
  const dbChannels = getTempChannels();
  const dbKeys = new Set(dbChannels.map(c => c.channel_key));
  const configKeys = new Set(config.channels.map(c => c.id));

  // Upsert channels from config into DB
  for (const ch of config.channels) {
    const sourceConfig = ch.sourceType === 'w1'
      ? JSON.stringify({ device_id: ch.deviceId })
      : JSON.stringify({ entity_id: ch.entityId });

    const dbCh = upsertTempChannel(ch.id, ch.sourceType, sourceConfig);

    // Sync mutable fields from config → DB
    updateTempChannel(dbCh.id, {
      name: ch.name,
      enabled: ch.enabled,
      alertMaxC: ch.alertMaxC,
    });
  }

  // Remove DB channels that are no longer in config
  for (const dbCh of dbChannels) {
    if (!configKeys.has(dbCh.channel_key)) {
      deleteTempChannel(dbCh.id);
    }
  }
}

// ── Channel mutations ─────────────────────────────────────────────

export function getChannel(id: string): ChannelConfig | undefined {
  return config.channels.find(c => c.id === id);
}

export async function addChannel(channel: ChannelConfig): Promise<void> {
  const existing = config.channels.findIndex(c => c.id === channel.id);
  if (existing >= 0) {
    config.channels[existing] = channel;
  } else {
    config.channels.push(channel);
  }
  await saveTempConfig();
  syncConfigToDb();
}

export async function updateChannelConfig(
  id: string,
  updates: Partial<Pick<ChannelConfig, 'name' | 'enabled' | 'alertMaxC'>>,
): Promise<ChannelConfig | null> {
  const ch = config.channels.find(c => c.id === id);
  if (!ch) return null;

  if (updates.name !== undefined) ch.name = updates.name;
  if (updates.enabled !== undefined) ch.enabled = updates.enabled;
  if (updates.alertMaxC !== undefined) ch.alertMaxC = updates.alertMaxC;

  await saveTempConfig();
  syncConfigToDb();
  return ch;
}

export async function removeChannel(id: string): Promise<boolean> {
  const idx = config.channels.findIndex(c => c.id === id);
  if (idx < 0) return false;

  config.channels.splice(idx, 1);
  await saveTempConfig();
  syncConfigToDb();
  return true;
}

export async function setHomeAssistantConfig(ha: HomeAssistantConfig | null): Promise<void> {
  config.homeAssistant = ha;
  await saveTempConfig();
}

/** Update last_seen/unplugged timestamps for a w1 channel in config */
export async function markW1Seen(deviceId: string): Promise<void> {
  const ch = config.channels.find(
    c => c.sourceType === 'w1' && c.deviceId === deviceId
  ) as W1ChannelConfig | undefined;
  if (!ch) return;

  const now = new Date().toISOString();
  ch.lastSeenAt = now;
  if (ch.unpluggedAt) {
    ch.unpluggedAt = null;
  }
  // Don't await — batch saves happen in the poll loop
}

export async function markW1Unplugged(deviceId: string): Promise<void> {
  const ch = config.channels.find(
    c => c.sourceType === 'w1' && c.deviceId === deviceId
  ) as W1ChannelConfig | undefined;
  if (!ch) return;

  if (!ch.unpluggedAt) {
    ch.unpluggedAt = new Date().toISOString();
  }
}

/** Get the DB id for a channel key (needed for insertTempReading FK) */
export function getChannelDbId(channelKey: string): number | null {
  const dbCh = getTempChannelByKey(channelKey);
  return dbCh?.id ?? null;
}
