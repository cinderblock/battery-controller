/**
 * HTTP control API for the FakeDevice.
 *
 * Designed to be driven by an LLM (or a human with curl). All responses
 * are JSON. All request bodies are JSON. Errors return
 *   { error: string }
 * with a 4xx status.
 *
 * Endpoints are documented in scripts/README.md.
 */

import { fromHex, toHex } from '../../src/protocol/codec.ts';
import { RxPacketLength } from '../../src/protocol/constants.ts';
import type { FakeDevice } from './device.ts';
import type { DeviceState, LogEntry } from './types.ts';

export interface ControlApiOptions {
  device: FakeDevice;
  port: number;
  /** Called once the server is listening */
  onReady?: (url: string) => void;
}

export function startControlApi(opts: ControlApiOptions): { stop: () => Promise<void> } {
  const { device, port } = opts;

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(req: Request) {
      return handle(device, req).catch(err => jsonError(500, err?.message ?? String(err)));
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  opts.onReady?.(url);

  return {
    async stop() {
      await server.stop(true);
    },
  };
}

// ── Router ────────────────────────────────────────────────────────────

async function handle(device: FakeDevice, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // CORS — the UI driver (Python) may call this from a different origin.
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Root — quick overview
  if (path === '/' && method === 'GET') {
    return json(200, {
      name: 'battery-controller fake-device control API',
      endpoints: [
        'GET  /status',
        'GET  /state',
        'PATCH /state',
        'POST /reset',
        'GET  /log?limit=N',
        'GET  /log/stream       (SSE)',
        'POST /inject           {hex}',
        'POST /respond/to/:cmd  {hex}',
        'DELETE /respond/to/:cmd',
        'GET  /respond/overrides',
        'GET  /identity',
        'PATCH /identity        {deviceTypeByte?, deviceSubtypeByte?, deviceConstantByte?, infoMaxCurrent?, infoMaxVoltage?}',
        'POST /emit-info        force next emission to be an info packet (state+0x64)',
        'POST /note             {text}',
      ],
      status: device.getStatus(),
    });
  }

  if (path === '/status' && method === 'GET') {
    return json(200, device.getStatus());
  }

  if (path === '/state' && method === 'GET') {
    return json(200, device.getState());
  }

  if (path === '/state' && method === 'PATCH') {
    const body = await readJson<Partial<DeviceState>>(req);
    try {
      const next = device.patchState(body);
      return json(200, next);
    } catch (err) {
      return jsonError(400, (err as Error).message);
    }
  }

  if (path === '/reset' && method === 'POST') {
    return json(200, device.reset());
  }

  if (path === '/log' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
      return jsonError(400, 'limit must be between 1 and 1000');
    }
    return json(200, device.getLog(limit));
  }

  if (path === '/log/stream' && method === 'GET') {
    return streamLog(device, req);
  }

  if (path === '/inject' && method === 'POST') {
    const body = await readJson<{ hex: string }>(req);
    if (!body?.hex || typeof body.hex !== 'string') {
      return jsonError(400, 'body must be {"hex": "..."}');
    }
    let bytes: Uint8Array;
    try {
      bytes = fromHex(body.hex);
    } catch (err) {
      return jsonError(400, `invalid hex: ${(err as Error).message}`);
    }
    if (bytes.length !== RxPacketLength) {
      return jsonError(400, `inject expects ${RxPacketLength} bytes, got ${bytes.length}`);
    }
    device.injectRx(bytes);
    return json(200, { injected: toHex(bytes) });
  }

  // /respond/to/:cmd  (POST = set, DELETE = clear)
  const respondMatch = path.match(/^\/respond\/to\/(.+)$/);
  if (respondMatch) {
    const cmd = parseCmd(respondMatch[1]);
    if (cmd === null) {
      return jsonError(400, `invalid cmd '${respondMatch[1]}' — use decimal or 0x-prefixed hex`);
    }
    if (method === 'POST') {
      const body = await readJson<{ hex: string }>(req);
      if (!body?.hex || typeof body.hex !== 'string') {
        return jsonError(400, 'body must be {"hex": "..."}');
      }
      let bytes: Uint8Array;
      try {
        bytes = fromHex(body.hex);
      } catch (err) {
        return jsonError(400, `invalid hex: ${(err as Error).message}`);
      }
      try {
        device.setResponseOverride(cmd, bytes);
        return json(200, { cmd: hexByte(cmd), hex: toHex(bytes) });
      } catch (err) {
        return jsonError(400, (err as Error).message);
      }
    }
    if (method === 'DELETE') {
      const removed = device.clearResponseOverride(cmd);
      return json(200, { cmd: hexByte(cmd), removed });
    }
    return jsonError(405, `method ${method} not allowed on ${path}`);
  }

  if (path === '/respond/overrides' && method === 'GET') {
    return json(200, device.listOverrides());
  }

  if (path === '/identity' && method === 'GET') {
    return json(200, device.getIdentity());
  }

  if (path === '/identity' && method === 'PATCH') {
    const body = await readJson<{
      deviceTypeByte?: number;
      deviceSubtypeByte?: number;
      deviceConstantByte?: number;
      infoMaxCurrent?: number;
      infoMaxVoltage?: number;
    }>(req);
    if (!body || typeof body !== 'object') {
      return jsonError(400, 'body must be a JSON object');
    }
    try {
      device.setIdentity(body);
      return json(200, device.getIdentity());
    } catch (err) {
      return jsonError(400, (err as Error).message);
    }
  }

  if (path === '/emit-info' && method === 'POST') {
    // Force the next periodic emission to be an info packet (state+0x64).
    // Normally only triggered by the host's init command (0x05); exposed
    // here so identity-sweep probes can make the UI re-read bytes 14/15/16
    // without having to fake a full reconnect.
    device.triggerInfo();
    return json(200, { queued: true });
  }

  if (path === '/note' && method === 'POST') {
    const body = await readJson<{ text: string }>(req);
    if (!body?.text || typeof body.text !== 'string') {
      return jsonError(400, 'body must be {"text": "..."}');
    }
    device.note(body.text);
    return json(200, { noted: body.text });
  }

  return jsonError(404, `not found: ${method} ${path}`);
}

// ── SSE streaming for /log/stream ────────────────────────────────────

function streamLog(device: FakeDevice, req: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Replay the last few entries so the subscriber sees recent history.
      for (const entry of device.getLog(20)) {
        controller.enqueue(encoder.encode(sseFormat(entry)));
      }

      unsubscribe = device.subscribe(entry => {
        try {
          controller.enqueue(encoder.encode(sseFormat(entry)));
        } catch {
          // Consumer disconnected mid-enqueue; cleanup handles it.
        }
      });

      // Close when the client disconnects.
      const abort = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', abort);
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders(),
    },
  });
}

function sseFormat(entry: LogEntry): string {
  return `data: ${JSON.stringify(entry)}\n\n`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

function jsonError(status: number, message: string): Response {
  return json(status, { error: message });
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`invalid JSON body: ${(err as Error).message}`);
  }
}

function parseCmd(raw: string): number | null {
  const n = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw.slice(2), 16) : parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) return null;
  return n;
}

function hexByte(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}
