import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyVehicles } from './vehicle-proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const liveProxy = process.argv.includes('--live');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.geojson': 'application/geo+json', '.json': 'application/json' };

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/vehicles' && liveProxy) {
      if (request.method !== 'GET') { response.writeHead(405).end('Method not allowed'); return; }
      await proxyVehicles(response);
      return;
    }
    let path = resolve(root, `.${pathname}`);
    const relativeParts = path.slice(root.length).split(/[\\/]/);
    if ((path !== root && !path.startsWith(root + sep)) || relativeParts.some(p => p.startsWith('.'))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': `${mime[extname(path)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Transit map: http://127.0.0.1:${port}${liveProxy ? '/?feed=./api/vehicles' : ''}`));
