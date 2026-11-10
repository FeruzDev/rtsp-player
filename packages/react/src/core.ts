export type PlayerStatus = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'error' | 'closed';

export interface PlayerOptions {
  /** Camera URL, e.g. `rtsp://user:pass@192.168.1.10:554/stream1`. Either this or `stream`. */
  url?: string;
  /** Name of a stream configured on the server (keeps camera passwords off the browser). */
  stream?: string;
  /** WebSocket address of rtsp-player-server. @default `ws(s)://<current host>:9999` */
  server?: string;
  /** Ask the server to re-encode to H.264 (for H.265 / MJPEG cameras). Only with `url`. */
  transcode?: boolean;
  /** Ask the server to include audio. Only with `url`. */
  audio?: boolean;
  /** Max delay behind live edge in seconds before jumping forward. @default 1.5 */
  maxLatency?: number;
  /** Reconnect automatically when the connection drops. @default true */
  reconnect?: boolean;
  onStatusChange?: (status: PlayerStatus) => void;
  onError?: (message: string) => void;
}

type AnyMediaSource = MediaSource;

const getMediaSource = (): (typeof MediaSource) | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  return w.ManagedMediaSource ?? w.MediaSource;
};

/** `true` when the browser can play the stream (needs Media Source Extensions). */
export function isPlayerSupported(): boolean {
  return getMediaSource() !== undefined && typeof WebSocket !== 'undefined';
}

/** Builds the WebSocket URL used to connect to rtsp-player-server. */
export function buildSocketUrl(options: Pick<PlayerOptions, 'url' | 'stream' | 'server' | 'transcode' | 'audio'>): string {
  let base = options.server;
  if (!base) {
    const loc = typeof window !== 'undefined' ? window.location : undefined;
    const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${proto}//${loc?.hostname || 'localhost'}:9999`;
  }
  const url = new URL(base);
  if (options.stream) url.searchParams.set('stream', options.stream);
  else if (options.url) url.searchParams.set('url', options.url);
  if (options.transcode) url.searchParams.set('transcode', '1');
  if (options.audio) url.searchParams.set('audio', '1');
  return url.toString();
}

/**
 * Framework-agnostic player: connects a `<video>` element to rtsp-player-server.
 *
 * ```ts
 * const player = new RtspPlayerCore(video, { url: 'rtsp://...' });
 * player.start();
 * // later
 * player.destroy();
 * ```
 */
export class RtspPlayerCore {
  private ws: WebSocket | null = null;
  private mediaSource: AnyMediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private queue: ArrayBuffer[] = [];
  private status: PlayerStatus = 'idle';
  private destroyed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private fatal = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: PlayerOptions,
  ) {
    this.onPlaying = this.onPlaying.bind(this);
    this.onUpdateEnd = this.onUpdateEnd.bind(this);
  }

  getStatus(): PlayerStatus {
    return this.status;
  }

  start(): void {
    if (this.destroyed) return;
    if (!this.options.url && !this.options.stream) {
      this.fail('No camera url or stream given', true);
      return;
    }
    if (!isPlayerSupported()) {
      this.fail('This browser does not support Media Source Extensions', true);
      return;
    }
    this.video.addEventListener('playing', this.onPlaying);
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.video.removeEventListener('playing', this.onPlaying);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.teardownMedia();
    this.setStatus('closed');
  }

  private setStatus(status: PlayerStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private fail(message: string, fatal = false) {
    this.fatal = this.fatal || fatal;
    this.options.onError?.(message);
    if (fatal) this.setStatus('error');
  }

  private onPlaying() {
    this.retryDelay = 1000;
    this.setStatus('playing');
  }

  private connect() {
    if (this.destroyed) return;
    this.setStatus(this.status === 'idle' ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(buildSocketUrl(this.options));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleMessage(event.data);
      } else {
        this.queue.push(event.data as ArrayBuffer);
        this.flush();
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.destroyed) return;
      if (this.fatal || this.options.reconnect === false) {
        if (!this.fatal) this.setStatus('closed');
        return;
      }
      this.setStatus('reconnecting');
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    };
  }

  private handleMessage(raw: string) {
    let msg: { type: string; mime?: string; status?: PlayerStatus; message?: string; fatal?: boolean };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'init' && msg.mime) this.setupMedia(msg.mime);
    else if (msg.type === 'status' && msg.status && this.status !== 'playing') this.setStatus(msg.status);
    else if (msg.type === 'status' && msg.status === 'reconnecting') this.setStatus('reconnecting');
    else if (msg.type === 'error' && msg.message) this.fail(msg.message, !!msg.fatal);
  }

  private setupMedia(mime: string) {
    this.teardownMedia();
    const MS = getMediaSource()!;
    if (!MS.isTypeSupported(mime)) {
      this.fail(`Codec not supported by this browser: ${mime}. Try the "transcode" option.`, true);
      this.ws?.close();
      return;
    }

    const ms = new MS();
    this.mediaSource = ms;
    const w = window as unknown as { ManagedMediaSource?: unknown };
    if (w.ManagedMediaSource && MS === w.ManagedMediaSource) {
      (this.video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
    }
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;

    ms.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== ms) return;
        try {
          const sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          sb.addEventListener('updateend', this.onUpdateEnd);
          this.sourceBuffer = sb;
          this.flush();
        } catch (err) {
          this.fail(`Cannot create media buffer: ${(err as Error).message}`, true);
        }
      },
      { once: true },
    );
  }

  private teardownMedia() {
    this.queue = [];
    if (this.sourceBuffer) {
      this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
      this.sourceBuffer = null;
    }
    if (this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
    }
    this.mediaSource = null;
    if (this.objectUrl) {
      this.video.removeAttribute('src');
      this.video.load();
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private onUpdateEnd() {
    this.keepLive();
    this.flush();
  }

  /** Keep playback close to the live edge and the buffer small. */
  private keepLive() {
    const video = this.video;
    const buffered = video.buffered;
    if (!buffered.length) return;
    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);
    const maxLatency = this.options.maxLatency ?? 1.5;

    if (video.currentTime < start || end - video.currentTime > maxLatency) {
      video.currentTime = Math.max(start, end - 0.2);
    }
    if (video.paused && video.autoplay) {
      video.play().catch(() => {
        /* autoplay blocked: user has to press play */
      });
    }
  }

  private flush() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || !this.queue.length || this.mediaSource?.readyState !== 'open') return;

    const buffered = this.video.buffered;
    if (buffered.length) {
      const start = buffered.start(0);
      const end = buffered.end(buffered.length - 1);
      if (end - start > 30) {
        sb.remove(start, end - 10);
        return;
      }
    }

    try {
      sb.appendBuffer(this.queue[0]);
      this.queue.shift();
    } catch (err) {
      const e = err as DOMException;
      if (e.name === 'QuotaExceededError' && buffered.length) {
        sb.remove(buffered.start(0), Math.max(buffered.start(0), buffered.end(buffered.length - 1) - 2));
      } else {
        this.fail(`Playback error: ${e.message}`);
        this.ws?.close(); // reconnect from a fresh init segment
      }
    }
  }
}
