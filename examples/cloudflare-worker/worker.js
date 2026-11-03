// Optional Cloudflare Worker. Configure ALLOWED_ORIGIN to the origin of your
// GitHub Pages site (no path or trailing slash). No credentials or API keys.
const UPSTREAM = 'https://bt.mountainline.com/gtfsrt/vehicles';
const CACHE_SECONDS = 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN;
    const cors = { 'Access-Control-Allow-Origin': allowed || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
    const reply = (body, status) => new Response(body, { status,
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (!allowed) return reply('Set ALLOWED_ORIGIN on this Worker.', 503);
    if (origin && origin !== allowed) return reply('Origin not allowed', 403);
    if (new URL(request.url).pathname !== '/vehicles') return reply('Not found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply('Method not allowed', 405);
    // All query strings share one cache key and one fixed upstream.
    const cacheKey = new Request(new URL('/vehicles', request.url).href);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    try {
      const upstream = await fetch(UPSTREAM, { signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) return reply('Upstream feed unavailable', 502);
      const body = await upstream.arrayBuffer();
      if (body.byteLength > 2_000_000) return reply('Upstream feed too large', 502);
      const result = new Response(body, { headers: { ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/x-protobuf',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
      ctx.waitUntil(cache.put(cacheKey, result.clone()));
      return result;
    } catch { return reply('Upstream feed unavailable', 502); }
  },
};
