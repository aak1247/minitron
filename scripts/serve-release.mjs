import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].slice(2), process.argv[3 + i * 2]]));
const root = await fs.realpath(args.dir || 'dist/demo-source');
const port = Number(args.port || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = await fs.realpath(path.resolve(root, '.' + pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    const stat = await fs.stat(file);
    if (!stat.isFile()) { response.writeHead(404); response.end(); return; }
    let start = 0;
    if (request.headers.range) {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range);
      if (!range || Number(range[1]) >= stat.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return;
      }
      start = Number(range[1]); response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${stat.size - 1}/${stat.size}`);
    }
    response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', stat.size - start);
    response.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    const stream = createReadStream(file, { start });
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local release source: http://127.0.0.1:${port}/manifest.json\nDirectory: ${root}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
