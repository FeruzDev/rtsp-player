import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { Relay, redactUrl, type StreamSource } from './relay';

export type { StreamSource } from './relay';
export { buildFfmpegArgs, friendlyError, redactUrl } from './relay';
export { Mp4Segmenter, codecFromInit, isKeyframeFragment } from './mp4';

export interface RtspServerOptions {
  /** Port for a standalone server. Ignored when `server` is given. @default 9999 */
  port?: number;
  /** Host to bind. @default '0.0.0.0' */
  host?: string;
  /** Attach to an existing HTTP(S) server (Express, Fastify, Next custom server...) instead of listening. */
  server?: http.Server;
  /** WebSocket path. @default '/' (standalone) or '/rtsp' (attached) */
  path?: string;
  /**
   * Named streams. Clients connect with `?stream=<name>`; camera URLs and passwords stay on the server.
   * `{ cam1: 'rtsp://user:pass@192.168.1.10/stream1' }`
   */
  streams?: Record<string, string | StreamSource>;
  /**
   * Allow clients to pass any URL with `?url=...`.
   * `true`, `false`, or a function to validate the URL.
   * @default true when `streams` is empty, otherwise false
   */
  allowUrls?: boolean | ((url: string) => boolean);
  /** Defaults applied to every stream. */
  defaults?: Omit<StreamSource, 'url' | 'input'>;
  /** Path to the ffmpeg binary. @default process.env.FFMPEG_PATH, then the bundled ffmpeg-static, then `ffmpeg` */
  ffmpegPath?: string;
  /** Keep ffmpeg running this long after the last viewer disconnects (ms). @default 10000 */
  idleTimeout?: number;
  /** Logger. Pass `false` to silence. @default console.log */
  log?: ((message: string) => void) | false;
}

export interface RtspServer {
  /** Port the server listens on (standalone mode). */
  port: number | undefined;
  wss: WebSocketServer;
  /** Number of running ffmpeg processes. */
  activeStreams(): number;
  close(): Promise<void>;
}

function resolveFfmpeg(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const req = createRequire(__filename);
    const bundled = req('ffmpeg-static') as string | null;
    if (bundled) return bundled;
  } catch {
    /* ffmpeg-static not installed */
  }
  return 'ffmpeg';
}

const isTruthy = (v: string | null) => v === '1' || v === 'true' || v === '';

/** Starts (or attaches) a WebSocket server that relays RTSP cameras to the browser as fragmented MP4. */
export function createRtspServer(options: RtspServerOptions = {}): Promise<RtspServer> {
  const streams = options.streams ?? {};
  const hasNamed = Object.keys(streams).length > 0;
  const allowUrls = options.allowUrls ?? !hasNamed;
  const log = options.log === false ? () => undefined : options.log ?? ((m: string) => console.log(`[rtsp-player-server] ${m}`));
  const relayOptions = {
    ffmpegPath: resolveFfmpeg(options.ffmpegPath),
    idleTimeout: options.idleTimeout ?? 10000,
    log,
  };

  const ownServer = !options.server;
  const httpServer =
    options.server ??
    http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('rtsp-player-server is running. Connect with a WebSocket: ?url=rtsp://... or ?stream=name\n');
    });

  const path = options.path ?? (ownServer ? undefined : '/rtsp');
  const wss = new WebSocketServer({ server: httpServer, path });
  const relays = new Map<string, Relay>();

  const resolveSource = (params: URLSearchParams): { key: string; source: StreamSource } | { error: string } => {
    const name = params.get('stream');
    if (name) {
      const entry = streams[name];
      if (!entry) return { error: `Unknown stream "${name}"` };
      const source = typeof entry === 'string' ? { url: entry } : entry;
      return { key: `stream:${name}`, source: { ...options.defaults, ...source } };
    }

    const url = params.get('url');
    if (url) {
      const allowed = typeof allowUrls === 'function' ? allowUrls(url) : allowUrls;
      if (!allowed) return { error: 'Direct URLs are not allowed on this server; use a named stream' };
      if (!/^(rtsps?|rtmp|https?|srt|udp):\/\//i.test(url)) return { error: 'Unsupported URL scheme' };
      const source: StreamSource = { ...options.defaults, url };
      if (params.has('transcode')) source.transcode = isTruthy(params.get('transcode'));
      if (params.has('audio')) source.audio = isTruthy(params.get('audio'));
      const key = `url:${url}|${source.transcode ? 't' : ''}${source.audio ? 'a' : ''}`;
      return { key, source };
    }
    return { error: 'Missing ?url= or ?stream= parameter' };
  };

  wss.on('connection', (ws: WebSocket, req) => {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const resolved = resolveSource(params);
    if ('error' in resolved) {
      ws.send(JSON.stringify({ type: 'error', message: resolved.error, fatal: true }));
      ws.close(1008, resolved.error.slice(0, 120));
      return;
    }

    let relay = relays.get(resolved.key);
    if (!relay) {
      relay = new Relay(redactUrl(resolved.key),resolved.source, relayOptions, (r) => {
        if (relays.get(resolved.key) === r) relays.delete(resolved.key);
      });
      relays.set(resolved.key, relay);
    }
    relay.add(ws);
  });

  const api: RtspServer = {
    port: undefined,
    wss,
    activeStreams: () => relays.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const relay of [...relays.values()]) relay.close();
        wss.close(() => {
          if (ownServer) httpServer.close(() => resolve());
          else resolve();
        });
      }),
  };

  if (!ownServer) return Promise.resolve(api);

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 9999, options.host ?? '0.0.0.0', () => {
      const address = httpServer.address();
      api.port = typeof address === 'object' && address ? address.port : options.port;
      log(`listening on ws://localhost:${api.port}${path ?? ''}`);
      resolve(api);
    });
  });
}
