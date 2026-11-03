// Local development only. Fixed upstream, shared hourly cache, no open proxy.
import { LIVE_CONFIG } from '../src/live-config.js';

const upstream = 'https://bt.mountainline.com/gtfsrt/vehicles';
const cacheMs = LIVE_CONFIG.refreshMs;
let cached, pending, retryAt = 0;

export async function proxyVehicles(response) {
  try {
    if (!cached || Date.now() - cached.time >= cacheMs) {
      if (!pending) {
        if (Date.now() < retryAt) throw new Error('Upstream retry cooldown');
        pending = (async () => {
          const result = await fetch(upstream, { signal: AbortSignal.timeout(8000) });
          if (!result.ok) throw new Error(`Upstream HTTP ${result.status}`);
          const body = new Uint8Array(await result.arrayBuffer());
          if (body.length > 2_000_000) throw new Error('Upstream response too large');
          cached = { body, type: result.headers.get('Content-Type') || 'application/x-protobuf', time: Date.now() };
        })().catch(error => { retryAt = Date.now() + cacheMs; throw error; }).finally(() => { pending = undefined; });
      }
      await pending;
    }
    response.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': `public, max-age=${cacheMs / 1000}` });
    response.end(cached.body);
  } catch {
    response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('Mountain Line feed unavailable');
  }
}
