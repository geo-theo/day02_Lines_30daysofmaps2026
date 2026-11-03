import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';
import { decodeFeed } from '../src/gtfs-realtime.js';
import { LIVE_CONFIG } from '../src/live-config.js';

const capturedFeed = await readFile(new URL('fixtures/mountain-line-2026-11-03.pb', import.meta.url));
const feedResponse = () => new Response(capturedFeed, { headers: { 'Content-Type': 'application/x-google-protobuf' } });
async function outputDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'transit-pages-test-'));
  t.after(async () => {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('Pages build publishes a decodable same-origin snapshot and the browser assets under a repository subpath', async t => {
  const outputDir = await outputDirectory(t);
  let requests = 0;
  const result = await buildPages({ outputDir, fetcher: async (url, options) => {
    requests++;
    assert.equal(url, 'https://bt.mountainline.com/gtfsrt/vehicles');
    assert.ok(options.signal instanceof AbortSignal);
    return feedResponse();
  } });
  assert.equal(requests, 1);
  assert.equal(result.vehicleCount, 9);
  const page = new URL('https://example.github.io/transit-map/');
  const feedURL = new URL(LIVE_CONFIG.feedUrl, page);
  assert.equal(feedURL.origin, page.origin);
  assert.equal(feedURL.pathname, '/transit-map/data/vehicles.pb');
  const snapshot = await readFile(join(outputDir, LIVE_CONFIG.feedUrl));
  assert.deepEqual(snapshot, capturedFeed);
  // Static servers can label .pb as application/octet-stream; the browser decoder still works.
  assert.equal(decodeFeed(snapshot, 'application/octet-stream').vehicles.length, 9);
  assert.match(await readFile(join(outputDir, 'index.html'), 'utf8'), /\.\/src\/app\.js/);
  for (const filename of await readdir(join(outputDir, 'src'))) {
    if (!filename.endsWith('.js')) continue;
    const source = await readFile(join(outputDir, 'src', filename), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) assert.ok((await readFile(join(outputDir, 'src', match[1]))).length);
    }
  }
  for (const path of ['styles.css', 'data/lines_6514.geojson', 'data/stops_6514.geojson', 'data/gtfs-route-map.json']) {
    assert.ok((await readFile(join(outputDir, path))).length);
  }
  assert.deepEqual((await readdir(outputDir)).sort(), ['data', 'index.html', 'src', 'styles.css']);
});

test('failed or invalid upstream responses fail the build without replacing the last built snapshot', async t => {
  const outputDir = await outputDirectory(t);
  await buildPages({ outputDir, fetcher: async () => feedResponse() });
  const failures = [
    [() => new Response('Unavailable', { status: 503 }), /HTTP 503/],
    [() => new Response('<html>Proxy error</html>'), /HTML\/XML/],
    [() => new Response(''), /Empty or oversized/],
    [() => new Response(capturedFeed, { headers: { 'Content-Length': '2000001' } }), /Oversized/],
    [() => new Response(new Uint8Array(2_000_001)), /oversized/],
    [() => new Response(JSON.stringify({ header: { gtfs_realtime_version: '2.0', incrementality: 1 } })), /Differential/],
  ];
  for (const [response, error] of failures) {
    await assert.rejects(buildPages({ outputDir, fetcher: async () => response() }), error);
    assert.deepEqual(await readFile(join(outputDir, 'data/vehicles.pb')), capturedFeed);
  }
  await assert.rejects(buildPages({ outputDir, fetcher: async () => { throw new TypeError('Network unavailable'); } }), /Network unavailable/);
  assert.deepEqual(await readFile(join(outputDir, 'data/vehicles.pb')), capturedFeed);
});

test('a valid empty full snapshot is publishable without inventing bus positions', async t => {
  const outputDir = await outputDirectory(t);
  const result = await buildPages({ outputDir, fetcher: async () => new Response(
    'header { gtfs_realtime_version: "2.0" incrementality: FULL_DATASET timestamp: 1000 }') });
  assert.equal(result.vehicleCount, 0);
  const feed = decodeFeed(await readFile(join(outputDir, 'data/vehicles.pb')));
  assert.equal(feed.timestamp, 1000);
  assert.deepEqual(feed.vehicles, []);
});
