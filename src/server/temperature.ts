/**
 * Temperature Manager
 *
 * Central coordinator for multi-channel temperature monitoring:
 * - Polls all enabled channels on a 10-second interval
 * - Auto-discovers 1-Wire sensors and manages plug/unplug state
 * - Maintains last-known-good value per channel (for SSE snapshots)
 * - Emits typed events for subscribers (readings, alerts, discovery)
 */

import { logger } from '../utils/logger.ts';
import { insertTempReading } from './db.ts';
import { checkW1Available, discoverW1Devices, readW1Temperature } from './w1-adapter.ts';
import { readHaTemperature } from './ha-adapter.ts';
import {
  getTempConfig,
  loadTempConfig,
  syncConfigToDb,
  addChannel,
  markW1Seen,
  markW1Unplugged,
  saveTempConfig,
  getChannelDbId,
  type ChannelConfig,
  type W1ChannelConfig,
} from './temp-config.ts';

// ── Event types ───────────────────────────────────────────────────

export interface TempReadingEvent {
  type: 'temperature';
  readings: TempChannelReading[];
}

export interface TempChannelReading {
  channelId: string;
  channelDbId: number;
  name: string | null;
  tempC: number;
  alertMaxC: number | null;
}

export interface TempAlertEvent {
  type: 'tempAlert';
  channelId: string;
  name: string | null;
  tempC: number;
  alertMaxC: number;
}

export interface TempDiscoveryEvent {
  type: 'tempChannelDiscovered' | 'tempChannelUnplugged' | 'tempChannelReconnected';
  channelId: string;
  deviceId?: string;
  name: string | null;
}

export type TempEvent = TempReadingEvent | TempAlertEvent | TempDiscoveryEvent;

type TempEventListener = (event: TempEvent) => void;

/** Interface for getting active run context (provided by TestRecorder) */
export interface RunContext {
  getActiveRunId(): number | null;
  getRunStartTime(): number | null;
}

// ── TemperatureManager ────────────────────────────────────────────

export class TemperatureManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<TempEventListener> = new Set();
  private lastReadings: Map<string, TempChannelReading> = new Map();
  private knownW1Devices: Set<string> = new Set();
  private polling = false;
  private runContext: RunContext | null = null;

  /** Per-run alert threshold overrides (channelId → maxC). Set by test start, cleared on stop. */
  private runAlertOverrides: Map<string, number> = new Map();

  /** Set the run context provider (call after TestRecorder is created) */
  setRunContext(ctx: RunContext): void {
    this.runContext = ctx;
  }

  async start(): Promise<void> {
    await loadTempConfig();
    syncConfigToDb();

    const config = getTempConfig();
    logger.info(`TemperatureManager starting (poll every ${config.pollIntervalS}s)`);

    // Initial poll
    await this.poll();

    // Start interval
    this.timer = setInterval(() => this.poll(), config.pollIntervalS * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('TemperatureManager stopped');
  }

  /** Subscribe to temperature events */
  on(listener: TempEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Get last-known readings for all channels (for SSE snapshot) */
  getLastReadings(): TempChannelReading[] {
    return [...this.lastReadings.values()];
  }

  /** Get the list of configured channels (for SSE snapshot) */
  getChannels(): ChannelConfig[] {
    return getTempConfig().channels;
  }

  /** Set per-run alert overrides (called at test start) */
  setRunAlertOverrides(overrides: Map<string, number>): void {
    this.runAlertOverrides = overrides;
  }

  /** Clear per-run alert overrides (called at test end) */
  clearRunAlertOverrides(): void {
    this.runAlertOverrides.clear();
  }

  /** Get effective alert threshold for a channel (run override > config default) */
  getEffectiveAlertMax(channel: ChannelConfig): number | null {
    const override = this.runAlertOverrides.get(channel.id);
    if (override !== undefined) return override;
    return channel.alertMaxC;
  }

  // ── Private ─────────────────────────────────────────────────────

  private emit(event: TempEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (err) {
        logger.error('Temperature event listener error:', err);
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // Skip if previous poll is still running
    this.polling = true;

    try {
      await this.discoverW1();
      await this.readAll();
    } catch (err) {
      logger.error('Temperature poll error:', err);
    } finally {
      this.polling = false;
    }
  }

  private async discoverW1(): Promise<void> {
    if (!await checkW1Available()) return;

    const devices = await discoverW1Devices();
    const deviceSet = new Set(devices);
    const config = getTempConfig();

    // Check for new devices
    for (const deviceId of devices) {
      const channelId = `w1-${deviceId}`;
      const existingChannel = config.channels.find(c => c.id === channelId);

      if (!existingChannel) {
        // New sensor discovered
        const newChannel: W1ChannelConfig = {
          id: channelId,
          name: null,
          sourceType: 'w1',
          deviceId,
          enabled: true,
          alertMaxC: null,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          unpluggedAt: null,
        };
        await addChannel(newChannel);
        logger.info(`1-Wire sensor discovered: ${deviceId}`);
        this.emit({ type: 'tempChannelDiscovered', channelId, deviceId, name: null });
      } else if (existingChannel.sourceType === 'w1' && existingChannel.unpluggedAt) {
        // Sensor reconnected
        await markW1Seen(deviceId);
        logger.info(`1-Wire sensor reconnected: ${deviceId}`);
        this.emit({ type: 'tempChannelReconnected', channelId, deviceId, name: existingChannel.name });
      } else {
        // Still present — update last seen
        await markW1Seen(deviceId);
      }
    }

    // Check for unplugged devices
    for (const ch of config.channels) {
      if (ch.sourceType !== 'w1') continue;
      if (!deviceSet.has(ch.deviceId) && !ch.unpluggedAt) {
        await markW1Unplugged(ch.deviceId);
        logger.info(`1-Wire sensor unplugged: ${ch.deviceId}`);
        this.emit({ type: 'tempChannelUnplugged', channelId: ch.id, deviceId: ch.deviceId, name: ch.name });
      }
    }

    // Save config if timestamps changed
    await saveTempConfig();

    this.knownW1Devices = deviceSet;
  }

  private async readAll(): Promise<void> {
    const config = getTempConfig();
    const readings: TempChannelReading[] = [];

    const readPromises = config.channels
      .filter(ch => ch.enabled)
      .map(async (ch) => {
        const tempC = await this.readChannel(ch);
        if (tempC === null) return;

        const dbId = getChannelDbId(ch.id);
        if (dbId === null) return;

        const reading: TempChannelReading = {
          channelId: ch.id,
          channelDbId: dbId,
          name: ch.name,
          tempC,
          alertMaxC: this.getEffectiveAlertMax(ch),
        };

        readings.push(reading);
        this.lastReadings.set(ch.id, reading);

        // Check alert threshold
        const alertMax = this.getEffectiveAlertMax(ch);
        if (alertMax !== null && tempC > alertMax) {
          this.emit({
            type: 'tempAlert',
            channelId: ch.id,
            name: ch.name,
            tempC,
            alertMaxC: alertMax,
          });
        }
      });

    await Promise.all(readPromises);

    if (readings.length > 0) {
      this.emit({ type: 'temperature', readings });
      this.persistReadings(readings);
    }
  }

  /** Write readings to DB if a run is currently active */
  private persistReadings(readings: TempChannelReading[]): void {
    const runId = this.runContext?.getActiveRunId();
    if (runId === null || runId === undefined) return;

    const startTime = this.runContext?.getRunStartTime();
    if (startTime === null || startTime === undefined) return;

    const elapsedS = (Date.now() - startTime) / 1000;

    for (const r of readings) {
      insertTempReading(runId, r.channelDbId, r.tempC, elapsedS);
    }
  }

  private async readChannel(ch: ChannelConfig): Promise<number | null> {
    if (ch.sourceType === 'w1') {
      if (ch.unpluggedAt) return null;
      return readW1Temperature(ch.deviceId);
    }

    if (ch.sourceType === 'http') {
      const config = getTempConfig();
      if (!config.homeAssistant) return null;
      return readHaTemperature(config.homeAssistant, ch.entityId);
    }

    return null;
  }
}
