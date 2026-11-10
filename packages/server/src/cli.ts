#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRtspServer, type StreamSource } from './index';

const HELP = `
rtsp-player-server — play RTSP cameras in the browser

Usage:
  npx rtsp-player-server [options]

Options:
  -p, --port <n>          Port (default 9999, or $PORT)
  -s, --stream <name=url> Named stream, repeatable: --stream cam1=rtsp://user:pass@10.0.0.5/live
  -c, --config <file>     JSON file: { "streams": { "cam1": "rtsp://..." }, "port": 9999 }
      --no-urls           Only allow named streams (recommended in production)
      --transcode         Re-encode video to H.264 (H.265 / MJPEG cameras)
      --audio             Include audio (AAC)
      --udp               Use UDP instead of TCP for RTSP
      --ffmpeg <path>     Custom ffmpeg binary
  -q, --quiet             No logs
  -h, --help              Show this help
`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    stream: { type: 'string', short: 's', multiple: true },
    config: { type: 'string', short: 'c' },
    'no-urls': { type: 'boolean' },
    transcode: { type: 'boolean' },
    audio: { type: 'boolean' },
    udp: { type: 'boolean' },
    ffmpeg: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

let fileConfig: { port?: number; streams?: Record<string, string | StreamSource> } = {};
if (values.config) fileConfig = JSON.parse(readFileSync(values.config, 'utf8'));

const streams: Record<string, string | StreamSource> = { ...fileConfig.streams };
for (const entry of values.stream ?? []) {
  const i = entry.indexOf('=');
  if (i <= 0) {
    console.error(`Invalid --stream "${entry}". Expected name=url`);
    process.exit(1);
  }
  streams[entry.slice(0, i)] = entry.slice(i + 1);
}

createRtspServer({
  port: Number(values.port ?? process.env.PORT ?? fileConfig.port ?? 9999),
  streams,
  allowUrls: values['no-urls'] ? false : undefined,
  defaults: {
    transcode: values.transcode,
    audio: values.audio,
    rtspTransport: values.udp ? 'udp' : 'tcp',
  },
  ffmpegPath: values.ffmpeg,
  log: values.quiet ? false : undefined,
})
  .then((server) => {
    const names = Object.keys(streams);
    if (!values.quiet && names.length) console.log(`[rtsp-player-server] streams: ${names.join(', ')}`);
    const shutdown = () => server.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((err: Error) => {
    console.error(`[rtsp-player-server] ${err.message}`);
    process.exit(1);
  });
