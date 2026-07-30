#!/usr/bin/env bun

/**
 * Main server entry point
 *
 * Wires together: SerialManager → DeviceSession → TestRecorder → SQLite
 * Serves REST API + SSE event stream on a single Bun server.
 */

import homepage from '../frontend/index.html';
import { decodeBase240, decodeTxFrame, isInfoPacket, parseFrame } from '../protocol/codec.ts';
import { EbcDivisors } from '../protocol/constants.ts';
import { logger } from '../utils/logger.ts';
import { shutdown } from '../utils/shutdown.ts';
import { cameraAvailable, cameraRunning, getFrame, startCamera, stopCamera } from './camera.ts';
import { getAllCellStats, getCellCapacityStats, getGroupFleetSummary } from './capacity-estimation.ts';
import { CellPresenceTracker } from './cell-presence.ts';
import { CycleRunner } from './cycle-runner.ts';
import {
  closeDb,
  createCellGroup,
  createSequence,
  deleteCell,
  deleteSequence,
  downsampleTempReadings,
  ensureDefaultCellGroup,
  getCellByBarcode,
  getCellById,
  getCellGroups,
  getCells,
  getCellsInGroup,
  getCompactDataForRun,
  getCycleProgram,
  getDataPointCount,
  getDataPointsForRun,
  getLastDataPointForRun,
  getLastServiceRestartRun,
  getRecentCells,
  getRecentRunsWithData,
  getRecentTestRuns,
  getRunPeakStats,
  getRunsForCycleProgram,
  getSequence,
  getSequences,
  getSetting,
  getTempReadingsForRun,
  getTestRun,
  getTestRunsForCell,
  initDb,
  markIncompleteRuns,
  parseUtcTimestamp,
  setCellGroup,
  setRunExcludeFromCapacity,
  setSetting,
  updateCell,
  updateSequence,
  upsertCell,
} from './db.ts';
import {
  type DecodedReading,
  DeviceSession,
  type RecoveryState,
  type SessionEvent,
  stateByteToMode,
} from './device-session.ts';
import { fetchHaTemperatureEntities, testHaConnection } from './ha-adapter.ts';
import { backfillIrEstimates, estimateIrSamples } from './ir-estimate.ts';
import { SerialManager } from './serial.ts';
import { SettingsLock } from './settings-lock.ts';
import { startTcpBridge, startTcpBridgeStandalone, type TcpBridge } from './tcp-bridge.ts';
import {
  addChannel,
  getChannel,
  getTempConfig,
  type HttpChannelConfig,
  removeChannel,
  setHomeAssistantConfig,
  updateChannelConfig,
} from './temp-config.ts';
import { type TempEvent, TemperatureManager } from './temperature.ts';
import { TestRecorder, type TestSetpoints } from './test-recorder.ts';

const Port = Number(process.env.PORT) || 80;
const TRUSTED_PROXY = '10.255.0.5';

/** Unique ID per server process — clients detect restarts and auto-reload */
const SERVER_BUILD_ID = crypto.randomUUID();

// ── SSE client tracking ───────────────────────────────────────────

interface SseClient {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}
const sseClients = new Set<SseClient>();
let sseIdCounter = 0;
const sseEncoder = new TextEncoder();

function sseFormat(event: string, data: unknown): Uint8Array {
  return sseEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  const encoded = sseFormat(event, data);
  for (const client of sseClients) {
    if (client.closed) continue;
    try {
      client.controller.enqueue(encoded);
    } catch {
      client.closed = true;
      sseClients.delete(client);
    }
  }
}

// ── JSON helpers ───────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200, req?: Request): Response {
  const json = JSON.stringify(data);
  // Gzip large responses when the client supports it
  if (req && json.length > 4096 && req.headers.get('accept-encoding')?.includes('gzip')) {
    const compressed = Bun.gzipSync(Buffer.from(json));
    return new Response(compressed, {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
    });
  }
  return new Response(json, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

async function parseBody<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  // Bridge mode: transparent TCP-serial byte pipe (no HTTP server)
  if (process.argv.includes('--bridge') || process.env.MODE === 'bridge') {
    await startTcpBridgeStandalone();
    return;
  }

  logger.info('Starting Battery Controller Server...');

  // ── Initialize database ────────────────────────────────────────
  initDb();
  const incomplete = markIncompleteRuns();
  if (incomplete.runs > 0) {
    logger.info(`Marked ${incomplete.runs} incomplete run(s) from previous session as 'service_restart'`);
  }
  if (incomplete.cycles > 0) {
    logger.info(
      `Found ${incomplete.cycles} active cycle program(s) from previous session — CycleRunner will attempt recovery`
    );
  }
  ensureDefaultCellGroup();
  backfillIrEstimates();

  // ── Initialize serial + session + recorder ─────────────────────
  const serialManager = new SerialManager();
  await serialManager.connect();

  const session = new DeviceSession(serialManager, (mode, rawCapMah): RecoveryState | null => {
    const run = getLastServiceRestartRun(mode);
    if (!run) return null;
    const lastPoint = getLastDataPointForRun(run.id);
    if (!lastPoint) return null;
    const stats = getRunPeakStats(run.id);

    // Reconstruct testStartTime from last data point's wall-clock time
    const lastRecordedMs = parseUtcTimestamp(lastPoint.recorded_at);
    const gapS = (Date.now() - lastRecordedMs) / 1000;
    const trueElapsedS = lastPoint.elapsed_s + gapS;
    const testStartTime = Date.now() - trueElapsedS * 1000;

    // Detect high-capacity mode from the raw device value.
    // In low-cap mode, raw values max out at ~10,000–11,000 mAh before
    // the hi-byte +99 transition. In high-cap mode, the minimum raw value
    // is ~33,769 (the transition point). A threshold of 20,000 cleanly
    // separates the two ranges.
    const HIGH_CAP_THRESHOLD = 20_000;
    const highCapMode = rawCapMah > HIGH_CAP_THRESHOLD;

    // In high-cap mode, validate the DB capacity value. If the CapacityTracker
    // wasn't correcting properly before the restart (e.g., previous recovery
    // failed to detect high-cap mode), the DB may contain raw (uncorrected)
    // values. Detect this and recompute from the raw device value.
    let capacityForRecovery = lastPoint.capacity_mah;
    if (highCapMode) {
      // Approximate true capacity from raw using known EBC-A40L constants:
      //   corrected = transitionTrue + (raw - transitionRaw) * 10
      //   transitionRaw ≈ transitionTrue + 99*240 = transitionTrue + 23,760
      //   transitionTrue ≈ 10,000 mAh (varies by ~200)
      // Simplifies to: corrected ≈ 10 * raw - 327,600
      const approxCorrected = 10 * rawCapMah - 327_600;
      if (approxCorrected > 0) {
        const divergence = Math.abs(lastPoint.capacity_mah - approxCorrected) / approxCorrected;
        if (divergence > 0.1) {
          logger.warn(
            `Recovery: DB capacity (${lastPoint.capacity_mah} mAh) diverges ${(divergence * 100).toFixed(0)}% ` +
              `from expected (${approxCorrected} mAh) — likely uncorrected raw. Using computed value.`
          );
          capacityForRecovery = approxCorrected;
        }
      }
    }

    logger.info(
      `Recovery: run #${run.id}, elapsed=${trueElapsedS.toFixed(0)}s (gap=${gapS.toFixed(1)}s), ` +
        `energy=${lastPoint.energy_mwh.toFixed(0)} mWh, highCap=${highCapMode}, ` +
        `dbCap=${lastPoint.capacity_mah}, recoveryCap=${capacityForRecovery}`
    );

    return {
      runId: run.id,
      testStartTime,
      energyMwh: lastPoint.energy_mwh,
      capState: {
        highCapMode,
        transitionRaw: rawCapMah,
        transitionTrue: capacityForRecovery,
      },
      peakVoltage: stats?.peakVoltage ?? 0,
      minVoltage: stats?.minVoltage ?? Infinity,
      peakCurrent: stats?.peakCurrent ?? 0,
      maxTimeMin: run.setpoint_max_time_min ?? null,
    };
  });
  const recorder = new TestRecorder(session);
  const settingsLock = new SettingsLock();
  const cycleRunner = new CycleRunner(session, recorder);
  const cellPresence = new CellPresenceTracker();

  session.start();
  cycleRunner.start(); // Restore cycle context before recorder (so recovered runs get linked)
  recorder.start();

  // ── Start camera if RTSP_URL is configured ─────────────────────
  if (cameraAvailable()) {
    startCamera();
  }

  // ── Initialize temperature monitoring ─────────────────────────
  const tempManager = new TemperatureManager();
  tempManager.setRunContext(recorder);
  await tempManager.start();

  // Wire temperature events → SSE broadcasts + alert abort
  tempManager.on((event: TempEvent) => {
    switch (event.type) {
      case 'temperature':
        broadcast('temperature', { readings: event.readings });
        break;
      case 'tempAlert': {
        logger.warn(
          `TEMPERATURE ALERT: ${event.name ?? event.channelId} = ${event.tempC.toFixed(1)}°C ` +
            `(threshold: ${event.alertMaxC}°C) — stopping test`
        );
        // During a cycle, a bare device stop would look like "step completed"
        // and the runner would advance to the next step (possibly restarting
        // charge on an overheating cell) — abort the whole cycle instead.
        const cycleStatus = cycleRunner.getState().status;
        if (cycleStatus === 'running' || cycleStatus === 'waiting') {
          cycleRunner.abort('temp_alert').catch(e => logger.error('Cycle abort failed:', e));
        } else {
          session.stop('temp_alert').catch(e => logger.error('Temp-alert stop failed:', e));
        }
        broadcast('tempAlert', event);
        break;
      }
      case 'tempChannelDiscovered':
      case 'tempChannelUnplugged':
      case 'tempChannelReconnected':
        broadcast(event.type, event);
        break;
    }
  });

  // ── Wire session events → SSE broadcasts ───────────────────────
  session.on((event: SessionEvent) => {
    switch (event.type) {
      case 'reading':
        cellPresence.update(event.data.voltage);
        broadcast('reading', event.data);
        break;
      case 'stateChange':
        // A run starting means the cell is in use, however it was identified —
        // covers "Skip — no barcode", the API, and cycle steps alike.
        if (event.to !== 'idle') cellPresence.claim(null);
        broadcast('state', {
          mode: event.to,
          previousMode: event.from,
          activeRunId: recorder.getActiveRunId(),
          timestamp: Date.now(),
        });
        break;
      case 'connected':
        broadcast('connected', { timestamp: Date.now() });
        break;
      case 'disconnected':
        broadcast('disconnected', { timestamp: Date.now() });
        break;
      case 'deviceInfo':
        broadcast('deviceInfo', event.data);
        break;
      case 'commandPending':
        broadcast('commandPending', event.data);
        break;
      case 'commandConfirmed':
        broadcast('commandConfirmed', event.data);
        break;
      case 'commandTimeout':
        broadcast('commandTimeout', event.data);
        break;
      case 'deviceUnresponsive':
        broadcast('deviceResponsive', { responsive: false });
        break;
      case 'deviceResponsive':
        broadcast('deviceResponsive', { responsive: true });
        break;
    }
  });

  // ── Wire lock state → SSE broadcasts ──────────────────────────
  settingsLock.onLockChange(locked => {
    broadcast('lockState', { locked });
  });

  // ── Wire cell presence → SSE broadcasts ───────────────────────
  cellPresence.on(state => {
    broadcast('cellPresence', state);
  });

  // ── Wire cycle state → SSE broadcasts ─────────────────────────
  cycleRunner.onStateChange(state => {
    broadcast('cycleState', state);
  });

  // ── Bridge mode toggle ────────────────────────────────────────
  let activeBridge: TcpBridge | null = null;
  let bridgeEnabling = false;

  async function enableBridge(): Promise<void> {
    if (activeBridge || bridgeEnabling) return;
    bridgeEnabling = true;

    // Notify clients immediately so UI disables controls during transition
    broadcast('bridgeState', { active: true });

    try {
      // Tear down device pipeline — keep the serial file handle open
      cycleRunner.stop();
      recorder.stop();
      session.destroy();
      const serialHandle = serialManager.takeHandle();

      // Start the TCP bridge on the same file handle (no close/reopen)
      activeBridge = startTcpBridge(serialHandle, {
        onFrame(direction, frameBytes) {
          const parsed = parseFrame(frameBytes, direction);
          if (!parsed?.checksumValid) return;
          const p = parsed.payload;

          if (direction === 'rx') {
            const stateByte = p[0];
            const isInfo = isInfoPacket(stateByte);
            const current = decodeBase240(p[1], p[2], EbcDivisors.current);
            const voltage = decodeBase240(p[3], p[4], EbcDivisors.voltage);
            const capacityMah = decodeBase240(p[5], p[6], EbcDivisors.capacity);
            const rawField7 = decodeBase240(p[7], p[8], 1);
            const setpointEcho = decodeBase240(p[9], p[10], EbcDivisors.current);
            const cutoffEcho = decodeBase240(p[11], p[12], EbcDivisors.setpointVoltage);
            const maxTimeEcho = p[13] * 240 + p[14];

            broadcast('bridgeReading', {
              mode: stateByteToMode(stateByte),
              stateByte,
              voltage,
              current,
              power: voltage * current,
              capacityMah,
              capacityAh: capacityMah / 1000,
              energyMwh: 0,
              energyWh: 0,
              elapsedS: 0,
              timestamp: Date.now(),
              isInfoPacket: isInfo,
              rawField7,
              setpointEcho,
              cutoffEcho,
              maxTimeEcho,
            });
          } else {
            const decoded = decodeTxFrame(parsed, 'ebc');
            broadcast('bridgeCommand', {
              command: p[0],
              commandName: decoded.commandName,
              currentSetpoint: decoded.currentSetpoint,
              cutoffVoltage: decoded.cutoffVoltage,
              maxTime: decoded.maxTime,
              timestamp: Date.now(),
            });
          }
        },
      });
      logger.info('Bridge mode enabled — serial port handed to TCP bridge');
    } catch (err) {
      broadcast('bridgeState', { active: false });
      throw err;
    } finally {
      bridgeEnabling = false;
    }
  }

  async function disableBridge(): Promise<void> {
    if (!activeBridge) return;
    logger.info('Disabling bridge mode...');

    // Stop the TCP bridge — get the serial file handle back (no close/reopen)
    const serialHandle = await activeBridge.stop();
    activeBridge = null;

    // Hand the handle back to the serial manager and resume reading
    serialManager.resumeWithHandle(serialHandle);
    session.start();

    // Immediately poke the device — it may have stopped streaming
    // after EB Tester's heartbeats ceased during bridge mode
    logger.info('Sending init to restart device data stream...');
    session.sendInit().catch(err => {
      logger.error('Init after bridge disable failed:', err);
    });

    cycleRunner.start();
    recorder.start();

    broadcast('bridgeState', { active: false });
    logger.info('Bridge mode disabled — serial port returned to device session');
  }

  // ── Guard: reject commands when locked ────────────────────────
  function requireUnlocked(): Response | null {
    if (settingsLock.isLocked()) {
      return errorResponse('Settings are locked', 403);
    }
    return null;
  }

  // ── REST route handler ────────────────────────────────────────
  async function handleApi(req: Request, pathname: string): Promise<Response | null> {
    const method = req.method;

    // ── SSE event stream ─────────────────────────────────────
    if (pathname === '/api/events' && method === 'GET') {
      const clientId = ++sseIdCounter;
      let client: SseClient;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = { id: clientId, controller, closed: false };
          sseClients.add(client);
          logger.info(`SSE client connected (#${clientId}, total: ${sseClients.size})`);

          // Set browser reconnect interval
          controller.enqueue(sseEncoder.encode('retry: 1000\n\n'));

          // Send initial state snapshot
          controller.enqueue(
            sseFormat('snapshot', {
              buildId: SERVER_BUILD_ID,
              mode: session.getMode(),
              reading: session.getReading(),
              stats: session.getTestStats(),
              deviceInfo: session.getDeviceInfo(),
              activeRunId: recorder.getActiveRunId(),
              activeRunMaxTimeMin: recorder.getActiveRunMaxTimeMin(),
              serialConnected: serialManager.isPortOpen(),
              deviceResponsive: session.isDeviceResponsive(),
              locked: settingsLock.isLocked(),
              cycleState: cycleRunner.getState(),
              cellPresence: cellPresence.getState(),
              bridgeActive: activeBridge !== null || bridgeEnabling,
              temperature: {
                channels: tempManager.getChannels(),
                readings: tempManager.getLastReadings(),
              },
            })
          );
        },
        cancel() {
          client.closed = true;
          sseClients.delete(client);
          logger.info(`SSE client disconnected (#${clientId}, total: ${sseClients.size})`);
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // ── Test control ──────────────────────────────────────────
    if (pathname === '/api/test/start' && method === 'POST') {
      if (activeBridge || bridgeEnabling) return errorResponse('Cannot start test while bridge mode is active', 409);
      const locked = requireUnlocked();
      if (locked) return locked;

      const body = await parseBody<{
        mode: string;
        currentA?: number;
        voltageV?: number;
        powerW?: number;
        cutoffV?: number;
        cutoffCurrentA?: number;
        maxTimeMin?: number;
        cellId?: number;
        barcode?: string;
      }>(req);
      if (!body?.mode) return errorResponse('Missing mode');

      if (session.isRunning()) {
        return errorResponse('A test is already running', 409);
      }

      // Associate cell if provided
      if (body.barcode) {
        const cell = upsertCell(body.barcode);
        recorder.setCellId(cell.id);
      } else if (body.cellId) {
        recorder.setCellId(body.cellId);
      }

      // Record setpoints
      const setpoints: TestSetpoints = {
        currentA: body.currentA,
        voltageV: body.voltageV,
        powerW: body.powerW,
        cutoffV: body.cutoffV,
        cutoffCurrentA: body.cutoffCurrentA,
        maxTimeMin: body.maxTimeMin,
      };
      recorder.setSetpoints(setpoints);

      // Send command to device
      switch (body.mode) {
        case 'd-cc':
          if (!body.currentA || !body.cutoffV) return errorResponse('D-CC requires currentA and cutoffV');
          await session.startDCC(body.currentA, body.cutoffV, body.maxTimeMin ?? 0);
          break;
        case 'd-cp':
          if (!body.powerW || !body.cutoffV) return errorResponse('D-CP requires powerW and cutoffV');
          await session.startDCP(body.powerW, body.cutoffV, body.maxTimeMin ?? 0);
          break;
        case 'c-cv':
          if (!body.currentA || !body.voltageV || !body.cutoffCurrentA)
            return errorResponse('C-CV requires currentA, voltageV, and cutoffCurrentA');
          await session.startCCV(body.currentA, body.voltageV, body.cutoffCurrentA, body.maxTimeMin ?? 0);
          break;
        default:
          return errorResponse(`Unknown mode: ${body.mode}`);
      }

      return jsonResponse({ ok: true, mode: body.mode });
    }

    if (pathname === '/api/test/stop' && method === 'POST') {
      const locked = requireUnlocked();
      if (locked) return locked;

      await session.stop();
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/test/continue' && method === 'POST') {
      const locked = requireUnlocked();
      if (locked) return locked;

      const body = await parseBody<{
        currentA?: number;
        voltageV?: number;
        powerW?: number;
        cutoffV?: number;
        cutoffCurrentA?: number;
        maxTimeMin?: number;
      }>(req);
      if (!body) return errorResponse('Missing body');

      const mode = session.getMode();
      switch (mode) {
        case 'd-cc':
          if (!body.currentA || !body.cutoffV) return errorResponse('D-CC continue requires currentA and cutoffV');
          await session.continueDCC(body.currentA, body.cutoffV, body.maxTimeMin ?? 0);
          break;
        case 'd-cp':
          if (!body.powerW || !body.cutoffV) return errorResponse('D-CP continue requires powerW and cutoffV');
          await session.continueDCP(body.powerW, body.cutoffV, body.maxTimeMin ?? 0);
          break;
        case 'c-cv':
          if (!body.currentA || !body.voltageV || !body.cutoffCurrentA)
            return errorResponse('C-CV continue requires currentA, voltageV, and cutoffCurrentA');
          await session.continueCCV(body.currentA, body.voltageV, body.cutoffCurrentA, body.maxTimeMin ?? 0);
          break;
        default:
          return errorResponse(`Not in a running state (mode: ${mode})`, 409);
      }

      return jsonResponse({ ok: true, mode });
    }

    if (pathname === '/api/test/current' && method === 'GET') {
      return jsonResponse({
        mode: session.getMode(),
        reading: session.getReading(),
        stats: session.getTestStats(),
        pendingCommand: session.getPendingCommand(),
        activeRunId: recorder.getActiveRunId(),
        deviceInfo: session.getDeviceInfo(),
        serialConnected: serialManager.isPortOpen(),
        bridgeActive: activeBridge !== null || bridgeEnabling,
      });
    }

    // ── Cell presence (scan prompt) ───────────────────────────
    if (pathname === '/api/cell-presence' && method === 'GET') {
      return jsonResponse(cellPresence.getState());
    }

    // Identifying the connected cell on any browser clears the scan prompt on
    // all of them. Barcode is optional — see CellPresenceTracker.claim().
    if (pathname === '/api/cell-presence/claim' && method === 'POST') {
      const body = await parseBody<{ barcode?: string | null }>(req);
      cellPresence.claim(body?.barcode?.trim() || null);
      return jsonResponse(cellPresence.getState());
    }

    // ── Cell management ───────────────────────────────────────
    if (pathname === '/api/cells/recent' && method === 'GET') {
      return jsonResponse(getRecentCells());
    }

    if (pathname === '/api/cells' && method === 'GET') {
      return jsonResponse(getCells());
    }

    if (pathname === '/api/cells' && method === 'POST') {
      const body = await parseBody<{ barcode: string; label?: string }>(req);
      if (!body?.barcode) return errorResponse('Missing barcode');
      const cell = upsertCell(body.barcode, body.label);
      return jsonResponse(cell);
    }

    if (pathname === '/api/cells/scan' && method === 'POST') {
      const body = await parseBody<{ barcode: string; label?: string }>(req);
      if (!body?.barcode) return errorResponse('Missing barcode');
      const cell = upsertCell(body.barcode, body.label);
      recorder.setCellId(cell.id);
      cellPresence.claim(cell.barcode);
      return jsonResponse({ ok: true, cell });
    }

    // /api/cells/:id/runs
    const cellRunsMatch = pathname.match(/^\/api\/cells\/(\d+)\/runs$/);
    if (cellRunsMatch && method === 'GET') {
      const cellId = parseInt(cellRunsMatch[1], 10);
      const cell = getCellById(cellId);
      if (!cell) return errorResponse('Cell not found', 404);
      return jsonResponse(getTestRunsForCell(cellId));
    }

    // /api/cells/:id
    const cellByIdMatch = pathname.match(/^\/api\/cells\/(\d+)$/);
    if (cellByIdMatch && method === 'GET') {
      const cellId = parseInt(cellByIdMatch[1], 10);
      const cell = getCellById(cellId);
      if (!cell) return errorResponse('Cell not found', 404);
      return jsonResponse(cell);
    }
    if (cellByIdMatch && method === 'PATCH') {
      const cellId = parseInt(cellByIdMatch[1], 10);
      const body = await parseBody<{ label?: string | null; notes?: string | null; retired?: boolean }>(req);
      const cell = updateCell(cellId, body ?? {});
      if (!cell) return errorResponse('Cell not found', 404);
      return jsonResponse(cell);
    }
    if (cellByIdMatch && method === 'DELETE') {
      const locked = requireUnlocked();
      if (locked) return locked;

      const cellId = parseInt(cellByIdMatch[1], 10);
      const cell = getCellById(cellId);
      if (!cell) return errorResponse('Cell not found', 404);

      const url = new URL(req.url);
      const force = url.searchParams.get('force') === '1';
      const result = deleteCell(cellId, force);
      if (!result.deleted) {
        return jsonResponse(
          {
            error: `Cell has ${result.runCount} recorded run(s). Pass force=1 to delete them too.`,
            runCount: result.runCount,
          },
          409
        );
      }
      logger.info(
        `Deleted cell #${cellId} (${cell.label || cell.barcode})${result.runCount > 0 ? ` and ${result.runCount} run(s)` : ''}`
      );
      return jsonResponse({ ok: true, deletedRuns: result.runCount });
    }

    // ── Test run queries ──────────────────────────────────────
    if (pathname === '/api/runs/recent' && method === 'GET') {
      const url = new URL(req.url);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      // Optional ?cellId=N — only that cell's runs (lets the UI load runs
      // older than the global recent window, e.g. a cell tested a month ago)
      const cellIdParam = url.searchParams.get('cellId');
      const cellId = cellIdParam !== null ? parseInt(cellIdParam, 10) : undefined;
      // If ?withData=1, return runs bundled with compact data points (single request)
      if (url.searchParams.get('withData') === '1') {
        return jsonResponse(getRecentRunsWithData(limit, cellId), 200, req);
      }
      return jsonResponse(getRecentTestRuns(limit), 200, req);
    }

    // /api/runs/:id
    const runByIdMatch = pathname.match(/^\/api\/runs\/(\d+)$/);
    if (runByIdMatch && method === 'GET') {
      const runId = parseInt(runByIdMatch[1], 10);
      const run = getTestRun(runId);
      if (!run) return errorResponse('Run not found', 404);
      return jsonResponse(run);
    }

    if (runByIdMatch && method === 'PATCH') {
      const runId = parseInt(runByIdMatch[1], 10);
      const run = getTestRun(runId);
      if (!run) return errorResponse('Run not found', 404);

      const body = await parseBody<{ excludeFromCapacity?: boolean }>(req);
      if (typeof body?.excludeFromCapacity !== 'boolean') {
        return errorResponse('Missing excludeFromCapacity');
      }
      setRunExcludeFromCapacity(runId, body.excludeFromCapacity);
      return jsonResponse(getTestRun(runId));
    }

    // /api/runs/:id/data — full rows, or ?compact=1 for the chart's
    // downsampled column-array form (per-run piece of the old withData bundle)
    const runDataMatch = pathname.match(/^\/api\/runs\/(\d+)\/data$/);
    if (runDataMatch && method === 'GET') {
      const runId = parseInt(runDataMatch[1], 10);
      const run = getTestRun(runId);
      if (!run) return errorResponse('Run not found', 404);
      if (new URL(req.url).searchParams.get('compact') === '1') {
        return jsonResponse(getCompactDataForRun(runId), 200, req);
      }
      return jsonResponse(getDataPointsForRun(runId));
    }

    // /api/runs/:id/export (CSV)
    const runExportMatch = pathname.match(/^\/api\/runs\/(\d+)\/export$/);
    if (runExportMatch && method === 'GET') {
      const runId = parseInt(runExportMatch[1], 10);
      const run = getTestRun(runId);
      if (!run) return errorResponse('Run not found', 404);

      const points = getDataPointsForRun(runId);
      const header = 'elapsed_s,voltage_v,current_a,power_w,capacity_mah,energy_mwh,state_byte\n';
      const rows = points
        .map(
          p =>
            `${p.elapsed_s},${p.voltage_v},${p.current_a},${p.power_w},${p.capacity_mah},${p.energy_mwh},${p.state_byte}`
        )
        .join('\n');

      return new Response(header + rows, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="run-${runId}.csv"`,
        },
      });
    }

    // ── Cell groups ───────────────────────────────────────────
    if (pathname === '/api/cell-groups' && method === 'GET') {
      return jsonResponse(getCellGroups());
    }

    if (pathname === '/api/cell-groups' && method === 'POST') {
      const body = await parseBody<{
        name: string;
        nominalCapacityMah: number;
        chemistry: string;
        chargeVoltageV?: number | null;
        dischargeCutoffV?: number | null;
        chargeCutoffCurrentA?: number | null;
      }>(req);
      if (!body?.name || !body?.nominalCapacityMah || !body?.chemistry) {
        return errorResponse('Missing name, nominalCapacityMah, or chemistry');
      }
      const group = createCellGroup(
        body.name,
        body.nominalCapacityMah,
        body.chemistry,
        body.chargeVoltageV,
        body.dischargeCutoffV,
        body.chargeCutoffCurrentA
      );
      return jsonResponse(group, 201);
    }

    // /api/cell-groups/:id/cells
    const groupCellsMatch = pathname.match(/^\/api\/cell-groups\/(\d+)\/cells$/);
    if (groupCellsMatch && method === 'GET') {
      const groupId = parseInt(groupCellsMatch[1], 10);
      return jsonResponse(getCellsInGroup(groupId));
    }

    // /api/cell-groups/:id/summary — fleet summary for a cell group
    const groupSummaryMatch = pathname.match(/^\/api\/cell-groups\/(\d+)\/summary$/);
    if (groupSummaryMatch && method === 'GET') {
      const groupId = parseInt(groupSummaryMatch[1], 10);
      const summary = getGroupFleetSummary(groupId);
      if (!summary) return errorResponse('Cell group not found', 404);
      return jsonResponse(summary);
    }

    // ── Capacity stats ───────────────────────────────────────

    // /api/cells/:id/capacity — per-cell capacity statistics
    const cellCapMatch = pathname.match(/^\/api\/cells\/(\d+)\/capacity$/);
    if (cellCapMatch && method === 'GET') {
      const cellId = parseInt(cellCapMatch[1], 10);
      const stats = getCellCapacityStats(cellId);
      if (!stats) return errorResponse('Cell not found', 404);
      return jsonResponse(stats);
    }

    // /api/capacity/all — all cell stats (regardless of group)
    if (pathname === '/api/capacity/all' && method === 'GET') {
      return jsonResponse(getAllCellStats());
    }

    // /api/cells/:id/group — assign a cell to a group
    const cellGroupMatch = pathname.match(/^\/api\/cells\/(\d+)\/group$/);
    if (cellGroupMatch && method === 'PUT') {
      const cellId = parseInt(cellGroupMatch[1], 10);
      const cell = getCellById(cellId);
      if (!cell) return errorResponse('Cell not found', 404);
      const body = (await req.json()) as { groupId: number | null };
      setCellGroup(cellId, body.groupId);
      return jsonResponse({ ok: true });
    }

    // ── Sequences ─────────────────────────────────────────────
    if (pathname === '/api/sequences' && method === 'GET') {
      return jsonResponse(getSequences());
    }

    if (pathname === '/api/sequences' && method === 'POST') {
      const body = await parseBody<{ name: string; stepsJson: string; cellGroupId?: number }>(req);
      if (!body?.name || !body?.stepsJson) return errorResponse('Missing name or stepsJson');
      const seq = createSequence(body.name, body.stepsJson, body.cellGroupId);
      return jsonResponse(seq, 201);
    }

    const seqByIdMatch = pathname.match(/^\/api\/sequences\/(\d+)$/);
    if (seqByIdMatch && method === 'GET') {
      const id = parseInt(seqByIdMatch[1], 10);
      const seq = getSequence(id);
      if (!seq) return errorResponse('Sequence not found', 404);
      return jsonResponse(seq);
    }

    if (seqByIdMatch && method === 'PUT') {
      const id = parseInt(seqByIdMatch[1], 10);
      const body = await parseBody<{ name: string; stepsJson: string }>(req);
      if (!body?.name || !body?.stepsJson) return errorResponse('Missing name or stepsJson');
      updateSequence(id, body.name, body.stepsJson);
      return jsonResponse({ ok: true });
    }

    if (seqByIdMatch && method === 'DELETE') {
      const id = parseInt(seqByIdMatch[1], 10);
      const seq = getSequence(id);
      if (!seq) return errorResponse('Sequence not found', 404);
      deleteSequence(id);
      return jsonResponse({ ok: true });
    }

    // ── Settings lock ─────────────────────────────────────────
    if (pathname === '/api/lock/status' && method === 'GET') {
      return jsonResponse({
        locked: settingsLock.isLocked(),
        hasPassword: settingsLock.hasPassword(),
      });
    }

    if (pathname === '/api/lock' && method === 'POST') {
      const body = await parseBody<{ password: string; oldPassword?: string }>(req);
      if (!body?.password) return errorResponse('Missing password');
      const ok = await settingsLock.setPassword(body.password, body.oldPassword);
      if (!ok) return errorResponse('Old password is incorrect', 403);
      settingsLock.lock();
      return jsonResponse({ ok: true, locked: true });
    }

    if (pathname === '/api/unlock' && method === 'POST') {
      const body = await parseBody<{ password: string }>(req);
      if (!body?.password) return errorResponse('Missing password');
      const ok = await settingsLock.unlock(body.password);
      if (!ok) return errorResponse('Incorrect password', 403);
      return jsonResponse({ ok: true, locked: false });
    }

    if (pathname === '/api/lock/engage' && method === 'POST') {
      const ok = settingsLock.lock();
      if (!ok) return errorResponse('No password set — cannot lock', 400);
      return jsonResponse({ ok: true, locked: true });
    }

    // ── Cycle programs ─────────────────────────────────────────
    if (pathname === '/api/cycle/status' && method === 'GET') {
      return jsonResponse(cycleRunner.getState());
    }

    if (pathname === '/api/cycle/start' && method === 'POST') {
      const locked = requireUnlocked();
      if (locked) return locked;

      const body = await parseBody<{
        name: string;
        steps: unknown[];
        cellId?: number;
        variables?: { key: string; value: number }[];
      }>(req);
      if (!body?.name || !body?.steps) return errorResponse('Missing name or steps');

      const variables = Array.isArray(body.variables)
        ? body.variables.filter(v => v && typeof v.key === 'string' && Number.isFinite(v.value))
        : [];

      try {
        await cycleRunner.startSequence(body.name, body.steps as any, body.cellId ?? null, variables);
        return jsonResponse({ ok: true, state: cycleRunner.getState() });
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : 'Failed to start cycle', 409);
      }
    }

    if (pathname === '/api/cycle/stop' && method === 'POST') {
      const locked = requireUnlocked();
      if (locked) return locked;

      await cycleRunner.abort();
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/cycle/end-step' && method === 'POST') {
      const locked = requireUnlocked();
      if (locked) return locked;

      try {
        await cycleRunner.endCurrentStep();
        return jsonResponse({ ok: true, state: cycleRunner.getState() });
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : 'Failed to end step', 409);
      }
    }

    // GET /api/cycle-programs/:id/timeline — full sequence timeline
    const timelineMatch = pathname.match(/^\/api\/cycle-programs\/(\d+)\/timeline$/);
    if (timelineMatch && method === 'GET') {
      const programId = parseInt(timelineMatch[1], 10);
      const program = getCycleProgram(programId);
      if (!program) return errorResponse('Cycle program not found', 404);

      const runs = getRunsForCycleProgram(programId);

      // Compute cumulative sequence offset for each run
      let cumulativeOffset = 0;
      const timeline = runs.map(run => {
        const sequenceOffsetS = cumulativeOffset;
        const points = getDataPointsForRun(run.id);
        cumulativeOffset += run.duration_s ?? 0;
        return { ...run, sequenceOffsetS, dataPoints: points };
      });

      return jsonResponse({ program, runs: timeline });
    }

    // ── Data export ──────────────────────────────────────────

    // CSV export for all runs of a specific cell
    const cellExportMatch = pathname.match(/^\/api\/cells\/(\d+)\/export$/);
    if (cellExportMatch && method === 'GET') {
      const cellId = parseInt(cellExportMatch[1], 10);
      const cell = getCellById(cellId);
      if (!cell) return errorResponse('Cell not found', 404);

      const cellRuns = getTestRunsForCell(cellId);
      const header =
        'run_id,mode,started_at,ended_at,end_reason,elapsed_s,voltage_v,current_a,power_w,capacity_mah,energy_mwh,state_byte\n';
      const rows: string[] = [];
      for (const run of cellRuns) {
        const points = getDataPointsForRun(run.id);
        for (const p of points) {
          rows.push(
            `${run.id},${run.mode},${run.started_at},${run.ended_at ?? ''},${run.end_reason ?? ''},` +
              `${p.elapsed_s},${p.voltage_v},${p.current_a},${p.power_w},${p.capacity_mah},${p.energy_mwh},${p.state_byte}`
          );
        }
      }

      const filename = `cell-${cell.barcode.replace(/[^a-zA-Z0-9-_]/g, '_')}.csv`;
      return new Response(header + rows.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // ── Temperature ─────────────────────────────────────────
    if (pathname === '/api/temp/config' && method === 'GET') {
      const cfg = getTempConfig();
      return jsonResponse({
        pollIntervalS: cfg.pollIntervalS,
        homeAssistant: cfg.homeAssistant ? { baseUrl: cfg.homeAssistant.baseUrl, hasToken: true } : null,
        channels: cfg.channels,
      });
    }

    if (pathname === '/api/temp/config/ha' && method === 'PUT') {
      const body = await parseBody<{ baseUrl: string; token: string }>(req);
      if (!body?.baseUrl || !body?.token) return errorResponse('Missing baseUrl or token');
      await setHomeAssistantConfig({ baseUrl: body.baseUrl.replace(/\/+$/, ''), token: body.token });
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/temp/config/ha' && method === 'DELETE') {
      await setHomeAssistantConfig(null);
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/temp/config/ha/test' && method === 'POST') {
      const body = await parseBody<{ baseUrl: string; token: string }>(req);
      if (!body?.baseUrl || !body?.token) return errorResponse('Missing baseUrl or token');
      const err = await testHaConnection({ baseUrl: body.baseUrl.replace(/\/+$/, ''), token: body.token });
      if (err) return jsonResponse({ ok: false, error: err }, 200);
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/temp/ha/entities' && method === 'GET') {
      const cfg = getTempConfig();
      if (!cfg.homeAssistant) return errorResponse('Home Assistant not configured', 404);
      try {
        const entities = await fetchHaTemperatureEntities(cfg.homeAssistant);
        return jsonResponse(
          entities.map(e => ({
            entityId: e.entity_id,
            name: e.attributes.friendly_name ?? e.entity_id,
            state: e.state,
            unit: e.attributes.unit_of_measurement,
            deviceClass: e.attributes.device_class,
          }))
        );
      } catch (err) {
        return errorResponse(`Failed to fetch HA entities: ${err instanceof Error ? err.message : String(err)}`, 502);
      }
    }

    if (pathname === '/api/temp/channels' && method === 'GET') {
      const cfg = getTempConfig();
      const lastReadings = tempManager.getLastReadings();
      const readingsMap = new Map(lastReadings.map(r => [r.channelId, r.tempC]));
      return jsonResponse(
        cfg.channels.map(ch => ({
          ...ch,
          lastTempC: readingsMap.get(ch.id) ?? null,
        }))
      );
    }

    if (pathname === '/api/temp/channels' && method === 'POST') {
      const body = await parseBody<{
        sourceType: 'http';
        entityId: string;
        name?: string;
        alertMaxC?: number | null;
      }>(req);
      if (!body?.entityId) return errorResponse('Missing entityId');
      const channelId = `ha-${body.entityId}`;
      const newChannel: HttpChannelConfig = {
        id: channelId,
        name: body.name ?? null,
        sourceType: 'http',
        entityId: body.entityId,
        enabled: true,
        alertMaxC: body.alertMaxC ?? null,
        firstSeenAt: new Date().toISOString(),
      };
      await addChannel(newChannel);
      return jsonResponse(newChannel, 201);
    }

    const tempChannelMatch = pathname.match(/^\/api\/temp\/channels\/(.+)$/);
    if (tempChannelMatch && method === 'PATCH') {
      const channelId = decodeURIComponent(tempChannelMatch[1]);
      const body = await parseBody<{ name?: string | null; enabled?: boolean; alertMaxC?: number | null }>(req);
      if (!body) return errorResponse('Missing body');
      const updated = await updateChannelConfig(channelId, body);
      if (!updated) return errorResponse('Channel not found', 404);
      return jsonResponse(updated);
    }

    if (tempChannelMatch && method === 'DELETE') {
      const channelId = decodeURIComponent(tempChannelMatch[1]);
      const removed = await removeChannel(channelId);
      if (!removed) return errorResponse('Channel not found', 404);
      return jsonResponse({ ok: true });
    }

    if (pathname === '/api/temp/current' && method === 'GET') {
      return jsonResponse(tempManager.getLastReadings());
    }

    // /api/runs/:id/temperature — downsampled per channel for the chart
    // (raw rows for a multi-hour run are ~740 KB); ?full=1 for everything
    const runTempMatch = pathname.match(/^\/api\/runs\/(\d+)\/temperature$/);
    if (runTempMatch && method === 'GET') {
      const runId = parseInt(runTempMatch[1], 10);
      const rows = getTempReadingsForRun(runId);
      if (new URL(req.url).searchParams.get('full') === '1') return jsonResponse(rows);
      return jsonResponse(downsampleTempReadings(rows), 200, req);
    }

    // /api/runs/:id/ir-samples — per-step DC-IR time series computed from the
    // run's FULL-resolution stored points. The frontend can't recover these
    // from its own run data: chart loads are downsampled and the live buffer
    // decimates, both of which stretch point spacing past the estimator's
    // step window.
    const runIrMatch = pathname.match(/^\/api\/runs\/(\d+)\/ir-samples$/);
    if (runIrMatch && method === 'GET') {
      const runId = parseInt(runIrMatch[1], 10);
      const run = getTestRun(runId);
      if (!run) return errorResponse('Run not found', 404);
      return jsonResponse(estimateIrSamples(getDataPointsForRun(runId), run.mode));
    }

    // ── Bridge mode ──────────────────────────────────────────
    if (pathname === '/api/bridge/status' && method === 'GET') {
      return jsonResponse({
        active: activeBridge !== null,
        hasClient: activeBridge?.hasClient() ?? false,
      });
    }

    if (pathname === '/api/bridge/start' && method === 'POST') {
      if (activeBridge || bridgeEnabling) return errorResponse('Bridge already active', 409);
      if (session.isRunning()) return errorResponse('Cannot enable bridge while a test is running', 409);
      try {
        await enableBridge();
        return jsonResponse({ ok: true });
      } catch (err) {
        return errorResponse(`Failed to start bridge: ${err instanceof Error ? err.message : String(err)}`, 500);
      }
    }

    if (pathname === '/api/bridge/stop' && method === 'POST') {
      if (!activeBridge) return errorResponse('Bridge not active', 409);
      try {
        await disableBridge();
        return jsonResponse({ ok: true });
      } catch (err) {
        return errorResponse(`Failed to stop bridge: ${err instanceof Error ? err.message : String(err)}`, 500);
      }
    }

    // ── Camera ────────────────────────────────────────────────
    if (pathname === '/api/camera/frame' && method === 'GET') {
      if (!cameraAvailable()) return errorResponse('No camera configured', 404);
      if (!cameraRunning()) return errorResponse('Camera not running', 503);
      const frame = await getFrame();
      if (!frame) return errorResponse('No frame available', 503);
      return new Response(frame, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-cache, no-store',
          'X-Frame-Age': '0',
        },
      });
    }

    if (pathname === '/api/camera/status' && method === 'GET') {
      return jsonResponse({
        configured: cameraAvailable(),
        running: cameraRunning(),
      });
    }

    // Full SQLite database download
    if (pathname === '/api/export/db' && method === 'GET') {
      const dbPath = process.env.DB_PATH || '/opt/battery-controller/data/battery.db';
      const file = Bun.file(dbPath);
      if (!(await file.exists())) return errorResponse('Database file not found', 404);
      return new Response(file, {
        headers: {
          'Content-Type': 'application/x-sqlite3',
          'Content-Disposition': 'attachment; filename="battery.db"',
        },
      });
    }

    return null; // Not an API route
  }

  // ── SSE keepalive ──────────────────────────────────────────────
  const keepaliveInterval = setInterval(() => {
    const ping = sseEncoder.encode(': keepalive\n\n');
    for (const client of sseClients) {
      if (client.closed) continue;
      try {
        client.controller.enqueue(ping);
      } catch {
        client.closed = true;
        sseClients.delete(client);
      }
    }
  }, 5_000);

  // ── Create server ─────────────────────────────────────────────
  const server = Bun.serve({
    port: Port,
    development: process.env.NODE_ENV === 'development',

    error(error) {
      logger.error('Server error:', error);
    },

    routes: {
      '/': homepage,
      '/health': homepage, // SPA: same HTML, client-side routing
      '/sequences': homepage,
      '/temperature': homepage,
    },

    async fetch(req, server) {
      const url = new URL(req.url);

      // ── Trusted proxy: real client IP from X-Forwarded-* ──────
      const connectingIp = server.requestIP(req)?.address;
      const isTrustedProxy = connectingIp === TRUSTED_PROXY;
      const clientIp = isTrustedProxy
        ? (req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? connectingIp)
        : connectingIp;

      // Static files (zbar.wasm barcode scanner — deployed alongside the bundle)
      if (url.pathname === '/static/zbar.js') {
        const file = Bun.file('./zbar.js');
        return new Response(file, {
          headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' },
        });
      }
      if (url.pathname === '/static/zbar.wasm') {
        const file = Bun.file('./zbar.wasm.bin');
        return new Response(file, {
          headers: { 'Content-Type': 'application/wasm', 'Cache-Control': 'public, max-age=86400' },
        });
      }

      // REST API
      if (url.pathname.startsWith('/api/')) {
        const response = await handleApi(req, url.pathname);
        if (response) return response;
        return new Response('Not Found', { status: 404 });
      }

      // SPA fallback: serve index.html for unrecognized paths
      // (handles direct navigation / page refresh on client-side routes)
      return new Response(homepage);
    },
  });

  logger.info(`Server running at http://localhost:${Port}`);
  logger.info(`SSE event stream at http://localhost:${Port}/api/events`);
  logger.info(
    `Device mode: ${session.getMode()}, serial: ${serialManager.isPortOpen() ? 'connected' : 'disconnected'}`
  );

  // ── Graceful shutdown ──────────────────────────────────────────
  async function gracefulShutdown() {
    logger.info('Shutting down...');
    clearInterval(keepaliveInterval);

    // Close SSE streams first so the server can drain, then stop accepting
    // requests and wait for in-flight ones to finish BEFORE tearing down
    // what they depend on — otherwise a request mid-flight during a deploy
    // restart hits "Cannot use a closed database". Cap the drain wait so a
    // stuck connection can't stall shutdown past systemd's patience.
    for (const client of sseClients) {
      try {
        client.controller.close();
      } catch {
        /* already closed */
      }
    }
    sseClients.clear();
    try {
      await Promise.race([server.stop(), Bun.sleep(2000)]);
    } catch {
      /* already stopped */
    }

    stopCamera();
    if (activeBridge) {
      const handle = await activeBridge.stop();
      await handle.close();
      activeBridge = null;
    } else {
      cycleRunner.stop();
      recorder.stop();
      session.destroy();
      await serialManager.disconnect();
    }
    closeDb();
    shutdown(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch(error => {
  logger.error('Failed to start server:', error);
  shutdown(1);
});
