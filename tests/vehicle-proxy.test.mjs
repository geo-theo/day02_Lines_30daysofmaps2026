import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../examples/cloudflare-worker/worker.js';

test('optional Worker restricts origin/path/method, forwards only the fixed binary feed and shares a cache key', async () => {
  const oldFetch = globalThis.fetch, oldCaches = globalThis.caches;
  const cached = new Map(), pending = [], calls = [];
  const env = { ALLOWED_ORIGIN: 'https://example.github.io' };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const request = (path = '/vehicles', origin = env.ALLOWED_ORIGIN, method = 'GET') =>
    new Request(`https://proxy.example${path}`, { method, headers: { Origin: origin } });
  try {
    globalThis.caches = { default: {
      async match(key) { return cached.get(key.url)?.clone(); },
      async put(key, response) { cached.set(key.url, response); },
    } };
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(Uint8Array.of(10, 3, 18), { headers: { 'Content-Type': 'application/x-google-protobuf' } });
    };
    assert.equal((await worker.fetch(request('/vehicles', 'https://other.example'), env, ctx)).status, 403);
    assert.equal((await worker.fetch(request('/elsewhere'), env, ctx)).status, 404);
    const methodError = await worker.fetch(request('/vehicles', env.ALLOWED_ORIGIN, 'POST'), env, ctx);
    assert.equal(methodError.status, 405);
    assert.equal(methodError.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal(calls.length, 0);
    assert.equal((await worker.fetch(request('/vehicles', env.ALLOWED_ORIGIN, 'OPTIONS'), env, ctx)).status, 204);
    const first = await worker.fetch(request('/vehicles?url=https://untrusted.example'), env, ctx);
    await Promise.all(pending);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal(first.headers.get('Cache-Control'), 'public, max-age=3600');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), Uint8Array.of(10, 3, 18));
    await worker.fetch(request('/vehicles?another=query'), env, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://bt.mountainline.com/gtfsrt/vehicles');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    cached.clear();
    globalThis.fetch = async () => { throw new Error('offline'); };
    const error = await worker.fetch(request(), env, ctx);
    assert.equal(error.status, 502);
    assert.equal(error.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
    assert.equal(error.headers.get('Cache-Control'), 'no-store');
    assert.equal((await worker.fetch(request(), {}, ctx)).status, 503);
  } finally { globalThis.fetch = oldFetch; globalThis.caches = oldCaches; }
});
