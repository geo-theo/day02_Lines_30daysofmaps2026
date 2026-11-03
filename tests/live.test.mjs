import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeFeed, normalizeFeed } from '../src/gtfs-realtime.js';
import { createVehicleMatcher, pointAtDistance, referenceDistance, vehicleFreshness } from '../src/vehicle-matching.js';
import { vehicleScreenPosition, unplacedVehicleLayout } from '../src/vehicle-view.js';
import { createLiveFeed } from '../src/live-feed.js';
import { LIVE_CONFIG as config } from '../src/live-config.js';
import { prepareMap } from '../src/map-data.js';
import { prepareSchematic, locateOnShape } from '../src/schematic-data.js';
import { parseCSV } from '../scripts/build-gtfs-map.mjs';
const read = path => readFile(new URL(path, import.meta.url));
const json = async path => JSON.parse(await read(path));
const [lines, stops, mapping] = await Promise.all([
  json('../data/lines_6514.geojson'), json('../data/stops_6514.geojson'), json('../data/gtfs-route-map.json'),
]);
const model = prepareMap(lines, stops), schematic = prepareSchematic(lines, stops);
const match = createVehicleMatcher(model, schematic, mapping, config);
const vehicleAt = (shape, overrides = {}) => {
  const [longitude, latitude] = shape.geometry.coordinates[Math.floor(shape.geometry.coordinates.length * 0.4)];
  const tripId = Object.keys(mapping.trips).find(id => mapping.patterns[mapping.trips[id]].shapeId === shape.properties.shape_id);
  return { id: 'test', longitude, latitude, tripId, timestamp: 1793695812, ...overrides };
};

test('real Mountain Line binary and debug responses decode without assuming JSON or Content-Type', async () => {
  const binary = decodeFeed(await read('fixtures/mountain-line-2026-11-03.pb'), 'application/x-google-protobuf');
  const text = decodeFeed(await read('fixtures/mountain-line-2026-11-03.textproto'));
  for (const feed of [binary, text]) {
    assert.equal(feed.vehicles.length, 9);
    assert.equal(feed.vehicles[0].id, '25715');
    assert.equal(feed.vehicles[0].speed, 0);
    assert.ok(feed.vehicles.every(v => !v.tripId && !v.routeId));
    assert.equal(feed.vehicles.find(v => v.id === '25714').timestamp, 1793695393);
  }
  assert.ok(Math.abs(binary.vehicles[0].latitude - text.vehicles[0].latitude) < 0.00001);
  const later = decodeFeed(await read('fixtures/mountain-line-2026-11-03-later.textproto'));
  assert.equal(later.timestamp - text.timestamp, 150);
  assert.equal(later.vehicles.find(v => v.id === '25714').timestamp, text.vehicles.find(v => v.id === '25714').timestamp);
});

test('snake/camel JSON fields preserve direction zero and validate/deduplicate positions', () => {
  const feed = normalizeFeed({ header: { gtfsRealtimeVersion: '2.0', timestamp: '1793695812' }, entity: [
    { id: 'a', vehicle: { vehicle: { id: 'bus' }, position: { latitude: 46, longitude: -114 },
      timestamp: '1793695810', trip: { tripId: '1015020', routeId: '1', directionId: 0 } } },
    { id: 'b', vehicle: { vehicle: { id: 'bus' }, position: { latitude: 46, longitude: -114 }, timestamp: 1793695800 } },
    { id: 'invalid', vehicle: { position: { latitude: 300, longitude: 0 } } },
    { id: 'deleted', isDeleted: true, vehicle: { position: { latitude: 46, longitude: -114 } } },
  ] });
  assert.equal(feed.vehicles.length, 1);
  assert.equal(feed.skipped, 1);
  assert.equal(feed.vehicles[0].directionId, 0);
  assert.equal(feed.vehicles[0].tripId, '1015020');
  assert.throws(() => normalizeFeed({ header: { gtfs_realtime_version: '2.0', incrementality: 1 } }), /Differential/);
});

test('malformed, HTML, truncated binary and empty responses fail clearly', () => {
  for (const text of ['', '<html>Bad Gateway</html>', '{}', 'header { gtfs_realtime_version: "2.0"', 'header { @bad }']) {
    assert.throws(() => decodeFeed(new TextEncoder().encode(text)));
  }
  assert.throws(() => decodeFeed(Uint8Array.of(10, 255, 255)));
});

test('all 24 supported trip shapes map to their correct route/direction and onto a schematic segment', () => {
  for (const shape of lines.features) {
    const input = vehicleAt(shape), result = match(input);
    assert.equal(result.direction, shape.properties.Direction, shape.properties.shape_id);
    assert.equal(result.mapRouteId, String(shape.properties.Route));
    assert.equal(result.sourceShapeId, shape.properties.shape_id);
    assert.ok(result.schematic, `${shape.properties.shape_id}: ${result.reason}`);
    const target = schematic.routes.find(route => route.id === result.mapRouteId);
    assert.ok(locateOnShape(result.schematic, target.coordinates).distanceFromShape < 1e-7);
    assert.deepEqual(result.geographic, model.routes.find(r => r.id === result.mapRouteId).shapes.find(s => s.sourceShapeId === result.sourceShapeId).coordinates[Math.floor(shape.geometry.coordinates.length * 0.4)]);
  }
});

test('outbound station anchors land exactly and inbound progress runs backward along the shared diagram', () => {
  for (const target of schematic.routes) {
    for (const anchor of target.anchors.slice(1, -1)) {
      // Exercise the same linear reference with nonuniform stop intervals.
      const anchors = [{ sourceDistance: 0, schematicDistance: 0 }, ...target.anchors,
        { sourceDistance: target.sourceDistances.at(-1), schematicDistance: target.distances.at(-1) }];
      const point = pointAtDistance(target.coordinates, target.distances, referenceDistance(anchors, anchor.sourceDistance));
      assert.ok(Math.hypot(point[0] - anchor.position[0], point[1] - anchor.position[1]) < 1e-7);
    }
  }
  const inbound = lines.features.find(f => f.properties.shape_id === 'shp-2-01');
  const results = [0.2, 0.5, 0.8].map(fraction => {
    const p = inbound.geometry.coordinates[Math.floor((inbound.geometry.coordinates.length - 1) * fraction)];
    return match({ ...vehicleAt(inbound), longitude: p[0], latitude: p[1] });
  });
  const target = schematic.routes.find(r => r.id === '2');
  const distances = results.map(r => locateOnShape(r.schematic, target.coordinates).distanceAlong);
  assert.ok(distances[0] > distances[1] && distances[1] > distances[2]);
});

test('unassigned, conflicting, unknown, unsupported and off-route vehicles retain geographic positions without false schematic placement', async () => {
  const raw = decodeFeed(await read('fixtures/mountain-line-2026-11-03.pb'));
  for (const vehicle of raw.vehicles) { const r = match(vehicle); assert.equal(r.schematic, null); assert.ok(r.geographic); }
  const base = vehicleAt(lines.features.find(f => f.properties.shape_id === 'shp-1-51'));
  for (const overrides of [
    { routeId: '2' }, { directionId: 1 }, { tripId: 'future-trip' },
    { longitude: -113.5, latitude: 47.1 }, { scheduleRelationship: 3 },
  ]) assert.equal(match({ ...base, ...overrides }).schematic, null);
  const unsupportedTrip = Object.keys(mapping.trips).find(id => mapping.patterns[mapping.trips[id]].shapeId === 'shp-12-03');
  assert.match(match({ ...base, tripId: unsupportedTrip }).reason, /absent/);
  // An unknown trip can still use explicit route and unambiguous GTFS direction.
  assert.ok(match({ ...base, tripId: 'future-trip', routeId: '1', directionId: 0 }).schematic);
  assert.equal(createVehicleMatcher(model, schematic, undefined, config)(base).schematic, null);
});

test('shared corridors never infer a direction from coincident inbound/outbound geometry', () => {
  const outbound = lines.features.find(f => f.properties.shape_id === 'shp-2-51');
  const input = vehicleAt(outbound, { tripId: undefined, routeId: '2' });
  // The shared terminal is deliberately ambiguous without a direction/trip.
  [input.longitude, input.latitude] = outbound.geometry.coordinates[0];
  const result = match(input);
  assert.equal(result.match, 'ambiguous');
  assert.equal(result.schematic, null);
});

test('loop crossings with nonlocal progress ties are withheld until continuity disambiguates them', () => {
  const fakeModel = { routes: [{ id: 'x', color: '#000', shapes: [{ sourceShapeId: 'loop', direction: 'Outbound',
    coordinates: [[0, 0], [1000, 1000], [0, 1000], [1000, 0]] }] }] };
  // Use a real projected coordinate as the crossing center.
  const geographic = match({ id: 'p', longitude: -114, latitude: 46.88 }).geographic;
  const shape = fakeModel.routes[0].shapes[0];
  shape.coordinates = shape.coordinates.map(([x, y]) => [geographic[0] + x - 500, geographic[1] + y - 500]);
  const matcher = createVehicleMatcher(fakeModel, { routes: [] }, {
    routes: { x: { mapRouteId: 'x' } }, trips: { t: 0 }, patterns: [{ routeId: 'x', directionId: '0', shapeId: 'loop', mapRouteId: 'x' }],
  }, config);
  const v = { id: 'p', longitude: -114, latitude: 46.88, tripId: 't', timestamp: 1000 };
  assert.equal(matcher(v).match, 'ambiguous');
  const resolved = matcher(v, { tripId: 't', sourceShapeId: 'loop', timestamp: 995, distanceAlong: 650 });
  assert.notEqual(resolved.match, 'ambiguous');
  assert.ok(resolved.distanceAlong < 1000);
});

test('age uses the position clock, marks old hourly snapshots stale, and expires markers after two hours', () => {
  const now = 10_000;
  const hourlySnapshot = vehicleFreshness({ timestamp: now - 3600 }, now, now, config);
  assert.equal(hourlySnapshot.hidden, false);
  assert.equal(hourlySnapshot.stale, true);
  assert.equal(vehicleFreshness({ timestamp: now - 7200 }, now, now, config).hidden, false);
  assert.equal(vehicleFreshness({ timestamp: now - 7201 }, now, now, config).hidden, true);
  assert.equal(vehicleFreshness({ timestamp: 850 }, 999, 1000, config).stale, true);
  assert.equal(vehicleFreshness({}, 999, 1000, config).estimated, true);
  assert.equal(vehicleFreshness({ firstReceivedAt: 990 }, undefined, 1000, config).stale, true);
  assert.equal(vehicleFreshness({ timestamp: 1100 }, 1100, 1000, config).hidden, true);
});

test('markers interpolate route or unplaced endpoints and reverse without changing geographic positions', () => {
  const v = { geographic: [100, 200], schematic: [5, 9] };
  const geographic = ([x, y]) => [x * 2, -y * 2], schematic = ([x, y]) => [x + 10, y + 10];
  assert.deepEqual(vehicleScreenPosition(v, 0, geographic, schematic).position, [200, -400]);
  assert.deepEqual(vehicleScreenPosition(v, 1, geographic, schematic).position, [15, 19]);
  assert.deepEqual(vehicleScreenPosition(v, 0.5, geographic, schematic).position, [107.5, -190.5]);
  assert.equal(vehicleScreenPosition({ ...v, schematic: null }, 1, geographic, schematic).opacity, 0);
  const unplaced = { ...v, schematic: null }, slot = [350, 650];
  for (const t of [0, 0.5, 1, 0.5, 0]) {
    const result = vehicleScreenPosition(unplaced, t, geographic, schematic, slot);
    assert.equal(result.opacity, 1);
    assert.deepEqual(result.position, [200 + 150 * t, -400 + 1050 * t]);
  }
  assert.deepEqual(vehicleScreenPosition(v, 1, geographic, schematic, slot).position, [15, 19]);
  assert.equal(unplaced.schematic, null);
});

test('all unplaced buses fit distinctly inside the transfer station at phone/desktop scales and follow its camera', () => {
  const transfer = schematic.stopById.get('transfer');
  for (const count of [0, 1, 9, 19, 100]) for (const scale of [0.2, 0.5, 1, 4]) {
    const vehicles = Array.from({ length: count }, (_, id) => ({ id: String(id), schematic: null }));
    const screen = ([x, y]) => [x * scale + 30, y * scale - 25];
    const layout = unplacedVehicleLayout(vehicles, transfer, screen);
    const { x, y, width, height } = layout.bounds;
    assert.equal(layout.positions.size, count);
    assert.ok(layout.radius > 0 && layout.radius <= 3.5);
    for (const point of layout.positions.values()) {
      assert.ok(point[0] - layout.radius - 0.5 > x && point[0] + layout.radius + 0.5 < x + width);
      assert.ok(point[1] - layout.radius - 0.5 > y && point[1] + layout.radius + 0.5 < y + height);
    }
    const points = [...layout.positions.values()];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      assert.ok(Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) >
        2 * layout.radius + Math.min(1, layout.radius * 0.4));
    }
    assert.deepEqual(unplacedVehicleLayout([...vehicles].reverse(), transfer, screen), layout);
    const panned = unplacedVehicleLayout(vehicles, transfer, point => screen(point).map(value => value + 80));
    for (const [id, point] of layout.positions) {
      assert.ok(panned.positions.get(id).every((value, axis) => Math.abs(value - point[axis] - 80) < 1e-9));
    }
  }
});

test('captured unassigned vehicles remain visible on the schematic without inventing route assignments', async () => {
  const feed = decodeFeed(await read('fixtures/mountain-line-2026-11-03.pb'));
  const vehicles = feed.vehicles.map(v => match(v));
  const layout = unplacedVehicleLayout(vehicles, schematic.stopById.get('transfer'), p => p);
  assert.equal(layout.positions.size, feed.vehicles.length);
  for (const vehicle of vehicles.filter(v => layout.positions.has(v.id))) {
    const screen = vehicleScreenPosition(vehicle, 1, p => p, p => p, layout.positions.get(vehicle.id));
    assert.equal(screen.opacity, 1);
    assert.deepEqual(screen.position, layout.positions.get(vehicle.id));
    assert.equal(vehicle.schematic, null);
    assert.equal(vehicle.mapRouteId, undefined);
  }
});

const shortPollingConfig = { ...config, refreshMs: 30_000 };
function pollingHarness(fetcher, feedConfig = shortPollingConfig) {
  let clock = 0, id = 0;
  const timers = new Map(), changes = [];
  const visibility = { hidden: false, addEventListener(_, fn) { this.change = fn; }, removeEventListener() {} };
  const feed = createLiveFeed({ url: 'https://example.test/feed', config: feedConfig, visibility, fetcher,
    now: () => clock, onChange: s => changes.push(s),
    setTimer(fn, delay) { timers.set(++id, { fn, at: clock + delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  return { feed, timers, changes, visibility, async advance(ms) {
    clock += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= clock) { timers.delete(key); await timer.fn(); }
  } };
}
const response = (timestamp, entities = []) => new Response(JSON.stringify({ header: { gtfsRealtimeVersion: '2.0', timestamp }, entity: entities }), { headers: { 'Content-Type': 'application/json' } });

for (const [name, feedConfig, interval] of [
  ['saved snapshot', config, 300_000],
  ['hourly override', { ...config, refreshMs: 3_600_000 }, 3_600_000],
]) test(`${name} polling respects its interval after successes, failures and tab visibility changes`, async () => {
  let calls = 0;
  const h = pollingHarness(async () => {
    calls++;
    if (calls === 2) throw new TypeError('Failed to fetch');
    return response(1000 + calls);
  }, feedConfig);
  h.feed.start(); await h.advance(0);
  assert.equal(calls, 1);
  await h.advance(interval - 1);
  assert.equal(calls, 1, 'A successful fetch must respect the configured interval');
  await h.advance(1);
  assert.equal(calls, 2);
  assert.equal(h.changes.at(-1).phase, 'error');
  await h.advance(interval - 1);
  assert.equal(calls, 2, 'A failed fetch must not shorten the configured interval');
  h.visibility.hidden = true; h.visibility.change();
  await h.advance(1);
  assert.equal(calls, 2);
  h.visibility.hidden = false; h.visibility.change(); await h.advance(0);
  assert.equal(calls, 3);
  assert.equal(h.changes.at(-1).phase, 'ready');
  h.visibility.hidden = true; h.visibility.change();
  h.visibility.hidden = false; h.visibility.change(); await h.advance(0);
  assert.equal(calls, 3, 'Returning to a tab must not fetch again before the next scheduled check');
  h.feed.stop();
});

test('poller pauses hidden tabs, never overlaps requests, and backs off instead of spinning', async () => {
  let calls = 0, release;
  const h = pollingHarness(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  h.feed.start();
  const inFlight = h.advance(0);
  await h.advance(120_000);
  assert.equal(calls, 1);
  release(response(1000)); await inFlight;
  h.visibility.hidden = true; h.visibility.change(); await h.advance(120_000);
  assert.equal(calls, 1);
  h.feed.stop();
  const errors = pollingHarness(async () => { throw new TypeError('Failed to fetch'); });
  errors.feed.start(); await errors.advance(0);
  assert.equal(errors.changes.at(-1).phase, 'error');
  assert.equal([...errors.timers.values()][0].at, 60_000);
  await errors.advance(60_000);
  assert.equal([...errors.timers.values()][0].at, 180_000);
  errors.feed.stop();
});

test('poller retains last good vehicles on HTTP/parse failures, rejects time regression, and clears absent buses on full snapshots', async () => {
  const entity = { id: 'e', vehicle: { vehicle: { id: 'bus' }, timestamp: 1000, position: { latitude: 46.88, longitude: -114 } } };
  const responses = [response(1000, [entity]), new Response('Bad gateway', { status: 502 }), response(900), new Response('<html>Proxy error</html>'), response(1100)];
  const h = pollingHarness(async () => responses.shift());
  h.feed.start(); await h.advance(0);
  assert.equal(h.changes.at(-1).vehicles.length, 1);
  await h.advance(30_000);
  assert.equal(h.changes.at(-1).vehicles.length, 1);
  await h.advance(60_000);
  assert.match(h.changes.at(-1).error, /backwards/);
  await h.advance(120_000);
  assert.equal(h.changes.at(-1).vehicles.length, 1);
  assert.match(h.changes.at(-1).error, /HTML/);
  await h.advance(240_000);
  assert.equal(h.changes.at(-1).vehicles.length, 0);
  assert.equal(h.changes.at(-1).phase, 'ready');
  h.feed.stop();
});

test('poller aborts a timed-out request and retains newer per-vehicle observations', async () => {
  const timed = pollingHarness(async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  timed.feed.start();
  const inFlight = timed.advance(0);
  await timed.advance(10_000); await inFlight;
  assert.equal(timed.changes.at(-1).error, 'Request timed out');
  timed.feed.stop();
  const entity = timestamp => ({ id: 'e', vehicle: { vehicle: { id: 'bus' }, timestamp,
    position: { latitude: 46.88, longitude: -114 } } });
  const responses = [response(1000, [entity(1000)]), response(1100, [entity(900)])];
  const h = pollingHarness(async () => responses.shift());
  h.feed.start(); await h.advance(0); await h.advance(30_000);
  assert.equal(h.changes.at(-1).vehicles[0].timestamp, 1000);
  h.feed.stop();
});

test('static metadata preserves exceptional shapes and CSV quoted commas/newlines', () => {
  assert.equal(Object.keys(mapping.trips).length, 1146);
  assert.ok(mapping.patterns.some(p => p.shapeId === 'shp-12-03' && p.direction === null));
  assert.equal(mapping.routes.Short.mapRouteId, null);
  assert.deepEqual(parseCSV('id,name\r\n1,"a,b"\r\n2,"two\nlines"\r\n3,"a""b"'), [
    { id: '1', name: 'a,b' }, { id: '2', name: 'two\nlines' }, { id: '3', name: 'a"b' },
  ]);
});
