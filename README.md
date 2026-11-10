# react-rtsp-player + rtsp-player-server

[![react-rtsp-player](https://img.shields.io/npm/v/react-rtsp-player.svg?label=react-rtsp-player)](https://www.npmjs.com/package/react-rtsp-player)
[![rtsp-player-server](https://img.shields.io/npm/v/rtsp-player-server.svg?label=rtsp-player-server)](https://www.npmjs.com/package/rtsp-player-server)
[![CI](https://github.com/FeruzDev/rtsp-player/actions/workflows/ci.yml/badge.svg)](https://github.com/FeruzDev/rtsp-player/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/react-rtsp-player.svg)](./LICENSE)

**Play RTSP IP cameras (CCTV, Hikvision, Dahua, …) in React with one line:**

```tsx
<RtspPlayer url="rtsp://admin:password@192.168.1.10:554/stream1" />
```

- ⚡ **Low latency** (~0.5–1.5 s), stays on the live edge automatically
- 🧠 **No re-encoding by default**: H.264 is copied as-is → almost zero CPU
- 🔁 **Auto-reconnect** on both sides, with clear error messages (wrong password, camera offline, …)
- 👥 **One camera connection shared** by all viewers; ffmpeg stops when nobody watches
- 🔐 **Named streams** keep camera passwords on the server
- 📦 **ffmpeg included** (via `ffmpeg-static`) — nothing else to install
- 🟦 TypeScript, React 16.8+, plus a framework-agnostic `RtspPlayerCore` class

## Why is there a server?

Browsers cannot open RTSP connections. `rtsp-player-server` connects to the camera with ffmpeg, repackages the video into fragmented MP4 (without re-encoding) and sends it to the browser over a WebSocket, where `react-rtsp-player` plays it with Media Source Extensions.

```
Camera ──RTSP──▶ rtsp-player-server (ffmpeg, Node.js) ──WebSocket / fMP4──▶ <RtspPlayer /> (browser)
```

## Quick start

**1. Start the server** (any machine that can reach the cameras):

```bash
npx rtsp-player-server
```

**2. Use the player in React:**

```bash
npm install react-rtsp-player
```

```tsx
import { RtspPlayer } from 'react-rtsp-player';

export default function Camera() {
  return (
    <RtspPlayer
      url="rtsp://admin:password@192.168.1.10:554/stream1"
      server="ws://localhost:9999"
      style={{ width: 640, aspectRatio: '16 / 9' }}
    />
  );
}
```

That's it. `server` defaults to `ws://<current hostname>:9999`, so on the same machine you can omit it.

## Production: named streams (recommended)

Passing `url` from the browser exposes the camera password and lets anyone ask the server to open any URL. In production, configure streams on the server and let the browser use only their names:

```bash
npx rtsp-player-server --no-urls \
  --stream entrance=rtsp://admin:pass@192.168.1.10:554/stream1 \
  --stream parking=rtsp://admin:pass@192.168.1.11:554/stream1
```

or with a config file (`npx rtsp-player-server -c cameras.json`):

```json
{
  "port": 9999,
  "streams": {
    "entrance": "rtsp://admin:pass@192.168.1.10:554/stream1",
    "parking": { "url": "rtsp://admin:pass@192.168.1.11:554/stream1", "transcode": true }
  }
}
```

```tsx
<RtspPlayer stream="entrance" server="wss://cams.example.com" />
```

Put the server behind HTTPS (nginx / Caddy) and use `wss://` when your site is served over HTTPS.

### Embed in your own Node.js server (Express, Fastify, NestJS, …)

```ts
import express from 'express';
import { createRtspServer } from 'rtsp-player-server';

const app = express();
const server = app.listen(3000);

await createRtspServer({
  server,          // attach to the existing HTTP server
  path: '/rtsp',   // ws://localhost:3000/rtsp
  streams: { entrance: process.env.CAMERA_1_URL! },
});
```

## `<RtspPlayer />` props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | – | Camera URL (`rtsp://`, `rtsps://`, also `rtmp://`, `http(s)://`, `srt://`) |
| `stream` | `string` | – | Name of a stream configured on the server (use instead of `url`) |
| `server` | `string` | `ws(s)://<host>:9999` | WebSocket address of `rtsp-player-server` |
| `transcode` | `boolean` | `false` | Re-encode to H.264 on the server (H.265 / MJPEG cameras). Uses CPU. |
| `audio` | `boolean` | `false` | Include audio (AAC) |
| `maxLatency` | `number` | `1.5` | Seconds behind live before jumping forward |
| `reconnect` | `boolean` | `true` | Reconnect automatically |
| `onStatusChange` | `(status) => void` | – | `'connecting' \| 'playing' \| 'reconnecting' \| 'error' \| 'closed'` |
| `onError` | `(message) => void` | – | Human-readable error (e.g. wrong password) |
| `showStatus` | `boolean` | `true` | Overlay with connecting / reconnecting / error text |
| `labels` | `{ connecting, reconnecting, error }` | English | Overlay texts |
| `wrapperClassName`, `wrapperStyle` | | – | Wrapper `<div>` styling |
| …`<video>` props | | `autoPlay muted playsInline` | `controls`, `className`, `style`, `poster`, `ref`, … |

Browsers only autoplay **muted** video, so `muted` is on by default.

### Custom UI: `useRtspPlayer`

```tsx
import { useRef } from 'react';
import { useRtspPlayer } from 'react-rtsp-player';

function MyPlayer({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { status, error } = useRtspPlayer(ref, { url });
  return (
    <figure>
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>{status === 'playing' ? '🔴 LIVE' : error ?? status}</figcaption>
    </figure>
  );
}
```

### Without React

```ts
import { RtspPlayerCore } from 'react-rtsp-player';

const player = new RtspPlayerCore(document.querySelector('video')!, {
  url: 'rtsp://admin:pass@192.168.1.10/stream1',
  onStatusChange: console.log,
});
player.start();
// player.destroy();
```

## Server options

CLI: `npx rtsp-player-server --help`

| CLI flag | `createRtspServer` option | Default | Description |
| --- | --- | --- | --- |
| `-p, --port` | `port` | `9999` (`$PORT`) | Port of the standalone server |
| | `server`, `path` | – | Attach to an existing HTTP server |
| `-s, --stream name=url` | `streams` | – | Named streams (string URL or `{ url, transcode, audio, rtspTransport, input }`) |
| `--no-urls` | `allowUrls` | `true` without streams, `false` with | Allow `?url=` from clients; can be a validation function |
| `--transcode` | `defaults.transcode` | `false` | Re-encode video to H.264 |
| `--audio` | `defaults.audio` | `false` | Include audio |
| `--udp` | `defaults.rtspTransport` | `tcp` | RTSP over UDP |
| `--ffmpeg` | `ffmpegPath` | bundled | Custom ffmpeg (or `$FFMPEG_PATH`) |
| | `idleTimeout` | `10000` | Stop ffmpeg N ms after the last viewer leaves |
| `-q, --quiet` | `log: false` | | No logs |

## Codecs & browsers

| Camera codec | Works | Notes |
| --- | --- | --- |
| H.264 | ✅ everywhere | Copied without re-encoding |
| H.265 / HEVC | ⚠️ Safari, Chrome/Edge with hardware support | Use `transcode` for all browsers |
| MJPEG / others | ✅ with `transcode` | |

Supported browsers: Chrome, Edge, Firefox, Opera, Safari (macOS), Safari iOS 17.1+ (ManagedMediaSource).

**Tip:** most cameras offer a lower-resolution *sub-stream* (e.g. Hikvision `/Streaming/Channels/102`, Dahua `subtype=1`). Use it for grids of many cameras.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| *wrong username or password (401)* | Check the camera login |
| *connection refused* / *timeout* | IP, port (usually 554) or network between server and camera |
| *Stream path not found (404)* | Check the path part of the URL for your camera model |
| *Codec not supported by this browser* | The camera sends H.265 — enable `transcode` |

## Oʻzbekcha qisqacha

1. Serverni ishga tushiring: `npx rtsp-player-server`
2. React'da: `npm install react-rtsp-player` va `<RtspPlayer url="rtsp://login:parol@192.168.1.10:554/stream1" />`

Brauzer RTSP'ni oʻzi ocha olmaydi, shuning uchun server kamerani ffmpeg orqali oʻqib, videoni brauzerga WebSocket orqali uzatadi. Productionda parollar brauzerga chiqmasligi uchun `--stream nom=url` va `<RtspPlayer stream="nom" />` dan foydalaning.

## Development

```bash
npm install
npm test           # jest (spins up ffmpeg with a test pattern)
npm run typecheck
npm run build
node example/demo.mjs   # http://localhost:5180 — demo with a test camera
```

## Releasing

`npm version patch -ws && git commit -am "release" && git tag vX.Y.Z && git push --follow-tags` — the Release workflow publishes both packages (via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) or the `NPM_TOKEN` secret).

## License

MIT
