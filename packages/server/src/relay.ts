import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import { Mp4Segmenter } from './mp4';

export interface StreamSource {
  /** RTSP (or any ffmpeg-readable) URL. */
  url?: string;
  /** Raw ffmpeg input arguments, used instead of `url` (e.g. `['-f', 'lavfi', '-i', 'testsrc']`). */
  input?: string[];
  /** Re-encode video to H.264 (needed for H.265/MJPEG cameras or raw inputs). Costs CPU. @default false */
  transcode?: boolean;
  /** Include audio (re-encoded to AAC). @default false */
  audio?: boolean;
  /** RTSP transport. @default 'tcp' */
  rtspTransport?: 'tcp' | 'udp';
}

export interface RelayOptions {
  ffmpegPath: string;
  /** Stop ffmpeg this many ms after the last viewer leaves. */
  idleTimeout: number;
  log: (message: string) => void;
}

interface Viewer {
  ws: WebSocket;
  initSent: boolean;
  waitingKeyframe: boolean;
}

/** Drop frames for viewers whose socket buffer grows beyond this (slow network). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Restart ffmpeg when no data arrives for this long (ms). */
const STALL_TIMEOUT = 15000;

export function buildFfmpegArgs(source: StreamSource): string[] {
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (source.input) {
    args.push(...source.input);
  } else if (source.url) {
    if (/^rtsps?:\/\//i.test(source.url)) {
      // -timeout: give up on unreachable cameras after 10s (microseconds)
      args.push('-rtsp_transport', source.rtspTransport ?? 'tcp', '-timeout', '10000000');
    }
    args.push('-fflags', 'nobuffer', '-i', source.url);
  } else {
    throw new Error('Stream source needs `url` or `input`');
  }

  args.push('-map', '0:v:0');
  if (source.audio) args.push('-map', '0:a:0?');

  if (source.transcode) {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push(...(source.audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']));

  args.push(
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    'pipe:1',
  );
  return args;
}

/** Hides `user:password@` in URLs. */
export const redactUrl = (text: string) => text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@');

/** Turns ffmpeg stderr into a short, human-readable message without credentials. */
export function friendlyError(stderr: string, code: number | null): string {
  const text = stderr.toLowerCase();
  if (/401|unauthorized/.test(text)) return 'Camera rejected the login: wrong username or password (401)';
  if (/404|not found/.test(text) && !/no such file/.test(text)) return 'Stream path not found on the camera (404)';
  if (/connection refused|-138|error number -111|econnrefused/.test(text)) return 'Camera unreachable: connection refused (check IP and port)';
  if (/timed out|timeout|-110|-10060|no data from camera/.test(text)) return 'Camera did not respond (timeout)';
  if (/no route to host|network is unreachable|-113|-10065|-10051/.test(text)) return 'Camera unreachable: no route to host';
  if (/enoent|spawn/.test(text)) return 'ffmpeg not found on the server (set ffmpegPath or FFMPEG_PATH)';
  if (/codec|could not find tag|not supported/.test(text)) return 'Unsupported video codec, try the "transcode" option';

  const last = stderr
    .split('\n')
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean)
    .pop();
  return redactUrl(last ?? `ffmpeg exited with code ${code}`).slice(0, 200);
}

const send = (ws: WebSocket, data: string | Buffer) => {
  if (ws.readyState === ws.OPEN) ws.send(data);
};

/** One ffmpeg process per stream, shared by every viewer. */
export class Relay {
  private viewers = new Set<Viewer>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private init: Buffer | null = null;
  private mime: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = 1000;
  private stderrTail = '';
  private closed = false;

  constructor(
    readonly key: string,
    private readonly source: StreamSource,
    private readonly options: RelayOptions,
    private readonly onEmpty: (relay: Relay) => void,
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  add(ws: WebSocket): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const viewer: Viewer = { ws, initSent: false, waitingKeyframe: true };
    this.viewers.add(viewer);

    if (this.init && this.mime) this.sendInit(viewer);
    else send(ws, JSON.stringify({ type: 'status', status: 'connecting' }));

    ws.on('close', () => this.remove(viewer));
    ws.on('error', () => this.remove(viewer));

    if (!this.proc && !this.restartTimer) this.start();
  }

  private remove(viewer: Viewer): void {
    if (!this.viewers.delete(viewer)) return;
    if (this.viewers.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.close(), this.options.idleTimeout);
    }
  }

  private sendInit(viewer: Viewer): void {
    send(viewer.ws, JSON.stringify({ type: 'init', mime: this.mime }));
    send(viewer.ws, this.init!);
    viewer.initSent = true;
    viewer.waitingKeyframe = true;
  }

  private start(): void {
    if (this.closed) return;
    const args = buildFfmpegArgs(this.source);
    this.options.log(`[${this.key}] starting ffmpeg`);
    this.stderrTail = '';
    this.init = null;
    this.mime = null;

    const proc = spawn(this.options.ffmpegPath, args, { windowsHide: true });
    this.proc = proc;

    const segmenter = new Mp4Segmenter({
      onInit: (init, codec) => {
        this.init = init;
        this.mime = `video/mp4; codecs="${codec}"`;
        this.restartDelay = 1000;
        this.options.log(`[${this.key}] streaming ${this.mime}`);
        for (const viewer of this.viewers) this.sendInit(viewer);
      },
      onSegment: (segment, keyframe) => {
        for (const viewer of this.viewers) {
          if (!viewer.initSent) continue;
          if (viewer.waitingKeyframe) {
            if (!keyframe) continue;
            viewer.waitingKeyframe = false;
          }
          if (viewer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            viewer.waitingKeyframe = true; // skip ahead to the next keyframe
            continue;
          }
          send(viewer.ws, segment);
        }
      },
    });

    // Watchdog: kill ffmpeg if the camera stops sending data (frozen stream, hung connect).
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > STALL_TIMEOUT) {
        this.stderrTail += `\nNo data from camera for ${STALL_TIMEOUT / 1000}s`;
        proc.kill('SIGKILL');
      }
    }, 2000);

    proc.stdout.on('data', (chunk: Buffer) => {
      lastData = Date.now();
      try {
        segmenter.push(chunk);
      } catch (err) {
        this.options.log(`[${this.key}] parse error: ${(err as Error).message}`);
        proc.kill('SIGKILL');
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    const onExit = (code: number | null) => {
      clearInterval(watchdog);
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.closed) return;

      const message = friendlyError(this.stderrTail, code);
      const detail = redactUrl(this.stderrTail.trim().split('\n').slice(-2).join(' | '));
      this.options.log(`[${this.key}] ffmpeg stopped: ${message}${detail ? ` (${detail})` : ''}`);
      for (const viewer of this.viewers) {
        send(viewer.ws, JSON.stringify({ type: 'error', message }));
        send(viewer.ws, JSON.stringify({ type: 'status', status: 'reconnecting' }));
        viewer.initSent = false;
      }

      if (this.viewers.size > 0) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start();
        }, this.restartDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, 15000);
      } else {
        this.close();
      }
    };

    proc.on('error', (err) => {
      // e.g. ENOENT when ffmpeg is missing; 'close' may not follow
      this.stderrTail += `\n${err.message}`;
      onExit(null);
    });
    proc.on('close', onExit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      this.options.log(`[${this.key}] stopping ffmpeg`);
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    for (const viewer of this.viewers) viewer.ws.close();
    this.viewers.clear();
    this.onEmpty(this);
  }
}
