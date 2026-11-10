import WebSocket from 'ws';
import { createRtspServer, buildFfmpegArgs, type RtspServer } from '../packages/server/src';
import { buildSocketUrl } from '../packages/react/src/core';

const testInput = ['-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25'];

function collect(url: string, until: (msgs: Array<string | Buffer>) => boolean): Promise<Array<string | Buffer>> {
  return new Promise((resolve, reject) => {
    const msgs: Array<string | Buffer> = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout, got: ${msgs.map((m) => (typeof m === 'string' ? m : `<${m.length} bytes>`)).join(', ')}`));
    }, 20000);
    ws.on('message', (data, isBinary) => {
      msgs.push(isBinary ? (data as Buffer) : data.toString());
      if (until(msgs)) {
        clearTimeout(timer);
        ws.close();
        resolve(msgs);
      }
    });
    ws.on('error', reject);
  });
}

describe('rtsp-player-server', () => {
  let server: RtspServer;

  beforeAll(async () => {
    server = await createRtspServer({
      port: 0,
      log: false,
      idleTimeout: 200,
      allowUrls: true,
      streams: { test: { input: testInput, transcode: true } },
    });
  });

  afterAll(() => server.close());

  it('streams init segment then keyframe media segments', async () => {
    const msgs = await collect(`ws://localhost:${server.port}/?stream=test`, (m) => m.filter(Buffer.isBuffer).length >= 3);
    const init = msgs.find((m) => typeof m === 'string' && m.includes('"init"')) as string;
    expect(JSON.parse(init).mime).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}"$/);

    const binaries = msgs.filter(Buffer.isBuffer) as Buffer[];
    expect(binaries[0].toString('ascii', 4, 8)).toBe('ftyp');
    expect(binaries[1].toString('ascii', 4, 8)).toBe('moof');
    expect(binaries[2].toString('ascii', 4, 8)).toBe('moof');
  });

  it('shares one ffmpeg between viewers and stops it when idle', async () => {
    const a = collect(`ws://localhost:${server.port}/?stream=test`, (m) => m.filter(Buffer.isBuffer).length >= 2);
    const b = collect(`ws://localhost:${server.port}/?stream=test`, (m) => m.filter(Buffer.isBuffer).length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.activeStreams()).toBe(1);
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 600));
    expect(server.activeStreams()).toBe(0);
  });

  it('rejects unknown streams and bad urls', async () => {
    const unknown = await collect(`ws://localhost:${server.port}/?stream=nope`, (m) => m.length >= 1);
    expect(JSON.parse(unknown[0] as string)).toMatchObject({ type: 'error', fatal: true });
    const bad = await collect(`ws://localhost:${server.port}/?url=file:///etc/passwd`, (m) => m.length >= 1);
    expect(JSON.parse(bad[0] as string).message).toMatch(/Unsupported URL scheme/);
  });

  it('reports ffmpeg errors for unreachable cameras', async () => {
    const msgs = await collect(
      `ws://localhost:${server.port}/?url=${encodeURIComponent('rtsp://127.0.0.1:1/none')}`,
      (m) => m.some((x) => typeof x === 'string' && x.includes('"error"')),
    );
    const err = msgs.find((x) => typeof x === 'string' && x.includes('"error"')) as string;
    expect(JSON.parse(err).message).toMatch(/unreachable|timeout|respond/i);
  });
});

describe('helpers', () => {
  it('buildFfmpegArgs uses tcp and stream copy by default', () => {
    const args = buildFfmpegArgs({ url: 'rtsp://cam/live' });
    expect(args.join(' ')).toContain('-rtsp_transport tcp');
    expect(args.join(' ')).toContain('-c:v copy');
    expect(args).toContain('-an');
    expect(buildFfmpegArgs({ url: 'rtsp://cam/live', transcode: true, audio: true }).join(' ')).toMatch(/libx264.*-c:a aac/);
  });

  it('buildSocketUrl', () => {
    expect(buildSocketUrl({ server: 'ws://localhost:9999', url: 'rtsp://a:b@cam/1' })).toBe(
      'ws://localhost:9999/?url=rtsp%3A%2F%2Fa%3Ab%40cam%2F1',
    );
    expect(buildSocketUrl({ server: 'wss://x.uz/rtsp', stream: 'cam1', transcode: true })).toBe(
      'wss://x.uz/rtsp?stream=cam1&transcode=1',
    );
  });
});

describe('error messages', () => {
  it('hides credentials and explains common failures', async () => {
    const { friendlyError, redactUrl } = await import('../packages/server/src');
    expect(redactUrl('rtsp://admin:Secret1@10.0.0.5:554/live')).toBe('rtsp://***@10.0.0.5:554/live');
    expect(friendlyError('[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized', 1)).toMatch(/wrong username or password/);
    expect(friendlyError('Error opening input: Error number -138 occurred', 1)).toMatch(/connection refused/);
    expect(friendlyError('[in#0 @ 0x2] Something odd at rtsp://u:p@cam/x', 1)).toBe('Something odd at rtsp://***@cam/x');
  });
});
