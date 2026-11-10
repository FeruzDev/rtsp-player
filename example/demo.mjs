// Demo: serves example/index.html and a test-pattern camera at ws://localhost:5180/rtsp?stream=test
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRtspServer } from '../packages/server/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, url.pathname === '/' ? 'example/index.html' : url.pathname);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await createRtspServer({
  server,
  path: '/rtsp',
  allowUrls: true,
  streams: {
    test: {
      input: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25'],
      transcode: true,
    },
  },
});
server.listen(Number(process.env.PORT ?? 5180), () => console.log('demo on http://localhost:5180'));
