import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareMap } from '../src/map-data.js';
import { prepareSchematic, cumulativeDistances } from '../src/schematic-data.js';
import { prepareTransition, resamplePairedPaths, mixPosition } from '../src/transition-data.js';
import { createTransition } from '../src/transition.js';

const read = async name => JSON.parse(await readFile(new URL(`../data/${name}_6514.geojson`, import.meta.url), 'utf8'));
const [lines, stops] = await Promise.all([read('lines'), read('stops')]);
const geographic = prepareMap(lines, stops);
const schematic = prepareSchematic(lines, stops);
const model = prepareTransition(geographic, schematic);
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;

test('all 12 outbound paths match by route and source shape ID; 12 inbound paths remain geographic-only', () => {
  assert.equal(model.routes.length, 24);
  assert.equal(model.routes.filter(r => r.geographic && r.schematic).length, 12);
  for (const route of model.routes) {
    assert.equal(route.color, geographic.routes.find(r => r.id === route.id).color);
    if (route.schematic) {
      assert.equal(route.direction, 'Outbound');
      assert.equal(route.geographic.length, route.schematic.length);
    } else assert.equal(route.direction, 'Inbound');
  }
});

test('resampling preserves every original geographic vertex, schematic bend, and exact endpoint', () => {
  for (const route of model.routes.filter(r => r.schematic)) {
    const source = geographic.routes.find(r => r.id === route.id).shapes.find(s => s.sourceShapeId === route.sourceShapeId);
    const target = schematic.routes.find(r => r.sourceShapeId === route.sourceShapeId);
    for (const [original, sampled] of [[source.coordinates, route.geographic], [target.coordinates, route.schematic]]) {
      for (const vertex of original) assert.ok(sampled.some(point => near(vertex, point)), `Lost bend in route ${route.id}`);
      assert.deepEqual(sampled[0], original[0]);
      assert.deepEqual(sampled.at(-1), original.at(-1));
      const lengths = cumulativeDistances(sampled);
      const originalLength = cumulativeDistances(original).at(-1);
      assert.ok(Math.abs(lengths.at(-1) - originalLength) < 1e-6, `Changed endpoint path on ${route.id}`);
    }
    for (let i = 1; i < route.geographic.length; i++) {
      assert.ok(Math.hypot(...route.geographic[i].map((v, axis) => v - route.geographic[i - 1][axis])) <= 35.000001);
      assert.ok(Math.hypot(...route.schematic[i].map((v, axis) => v - route.schematic[i - 1][axis])) <= 4.000001);
    }
  }
});

test('every paired stop anchor lands on its own port, including intermediate animation positions', () => {
  for (const route of model.routes.filter(r => r.schematic)) {
    const target = schematic.routes.find(r => r.sourceShapeId === route.sourceShapeId);
    for (const [index, anchor] of target.anchors.entries()) {
      const sample = route.anchorIndices[index];
      assert.ok(near(route.schematic[sample], anchor.position));
      const match = anchor.sourceMatches.find(m => m.sourceStopId === anchor.sourceStopId);
      const sourcePoint = mixPosition(target.sourceCoordinates[match.segment], target.sourceCoordinates[match.segment + 1], match.fraction);
      assert.ok(near(route.geographic[sample], sourcePoint));
      for (const t of [0, 0.2, 0.5, 0.9, 1]) {
        assert.ok(near(mixPosition(route.geographic[sample], route.schematic[sample], t),
          mixPosition(sourcePoint, anchor.position, t)));
      }
    }
  }
});

test('all 334 source stop identities survive; exactly 141 move to their explicit group and 193 fade in place', () => {
  assert.equal(model.stops.length, 334);
  assert.equal(new Set(model.stops.map(s => s.id)).size, 334);
  assert.equal(model.stops.filter(s => s.schematic).length, 141);
  assert.equal(model.stops.filter(s => !s.schematic).length, 193);
  for (const stop of model.stops) {
    assert.deepEqual(stop.geographic, geographic.stops.find(s => s.properties.stop_id === stop.id).geometry.coordinates);
    if (stop.schematic) {
      assert.equal(stop.nodeId, schematic.sourceStopToNode.get(stop.id));
      assert.deepEqual(stop.schematic, schematic.stopById.get(stop.nodeId).position);
    }
  }
});

test('matching is independent of feature order and preserves both input layouts', () => {
  const before = JSON.stringify([geographic, schematic]);
  const reversed = prepareTransition(prepareMap({ ...lines, features: [...lines.features].reverse() },
    { ...stops, features: [...stops.features].reverse() }), schematic);
  const stableRoutes = m => [...m.routes].sort((a, b) => a.sourceShapeId.localeCompare(b.sourceShapeId));
  const stableStops = m => [...m.stops].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(stableRoutes(model), stableRoutes(reversed));
  assert.deepEqual(stableStops(model), stableStops(reversed));
  assert.equal(JSON.stringify([geographic, schematic]), before);
});

test('schematic-only routes and stations are retained for fade-in instead of mismatching another shape', () => {
  const changed = { ...geographic,
    routes: geographic.routes.filter(r => r.id !== '11'),
    stops: geographic.stops.filter(s => s.properties.stop_id !== '495'),
  };
  const result = prepareTransition(changed, schematic);
  const route = result.routes.find(r => r.id === '11');
  assert.equal(route.geographic, null);
  assert.deepEqual(route.schematic, schematic.routes.find(r => r.id === '11').coordinates);
  assert.equal(result.nodes.length, 82);
  assert.ok(result.nodes.some(n => n.id === 'airport'));
  assert.ok(!result.stops.some(s => s.id === '495'));
});

test('unequal vertex densities use local anchor intervals, and degenerate intervals stay finite', () => {
  const paired = resamplePairedPaths([[0, 0], [0, 1], [0, 100], [100, 100]],
    [[0, 0], [90, 0], [90, 10]], [{ sourceDistance: 100, schematicDistance: 90 }]);
  const index = paired.anchorIndices[0];
  assert.deepEqual(paired.geographic[index], [0, 100]);
  assert.deepEqual(paired.schematic[index], [90, 0]);
  const zero = resamplePairedPaths([[0, 0], [0, 0]], [[1, 1], [2, 1]],
    [{ sourceDistance: 0, schematicDistance: 0 }]);
  assert.ok([...zero.geographic, ...zero.schematic].flat().every(Number.isFinite));
  assert.throws(() => resamplePairedPaths([[0, 0], [10, 0]], [[0, 0], [10, 0]],
    [{ sourceDistance: 8, schematicDistance: 8 }, { sourceDistance: 3, schematicDistance: 9 }]), /travel order/);
});

function clock(initial = 0) {
  let time = 0, id = 0;
  const pending = new Map(), values = [];
  const transition = createTransition({ initial, duration: 1400, now: () => time,
    requestFrame: callback => { pending.set(++id, callback); return id; },
    cancelFrame: frame => pending.delete(frame), onUpdate: value => values.push(value) });
  return { transition, pending, values, step(next) {
    time = next;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(time);
  } };
}

test('both animation directions settle exactly, even after a background-tab frame delay', () => {
  const c = clock();
  c.transition.setTarget(1);
  c.step(700);
  assert.equal(c.transition.value, 0.5);
  c.step(1400);
  assert.equal(c.transition.value, 1);
  assert.equal(c.transition.active, false);
  assert.equal(c.pending.size, 0);
  c.transition.setTarget(0);
  c.step(2100);
  assert.equal(c.transition.value, 0.5);
  c.step(100000);
  assert.equal(c.transition.value, 0);
  assert.equal(c.transition.active, false);
  assert.equal(c.pending.size, 0);
});

test('rapid reversals are continuous, leave one clock, and do not accumulate drift', () => {
  const c = clock();
  c.transition.setTarget(1);
  c.step(500);
  const interrupted = c.transition.value;
  c.transition.setTarget(0);
  assert.equal(c.transition.value, interrupted);
  assert.equal(c.pending.size, 1);
  c.step(600);
  assert.ok(c.transition.value < interrupted);
  for (let i = 0; i < 40; i++) {
    c.transition.setTarget(i % 2);
    assert.ok(c.pending.size <= 1);
    c.step(650 + i * 20);
  }
  c.transition.setTarget(1);
  c.step(5000);
  assert.equal(c.transition.value, 1);
  assert.equal(c.pending.size, 0);
});

test('reduced motion switches immediately and can finish a running animation without queued frames', () => {
  const c = clock();
  c.transition.setTarget(1, { immediate: true });
  assert.equal(c.transition.value, 1);
  assert.equal(c.transition.active, false);
  assert.equal(c.pending.size, 0);
  c.transition.setTarget(0);
  c.step(500);
  c.transition.finish();
  assert.equal(c.transition.value, 0);
  assert.equal(c.pending.size, 0);
  assert.throws(() => c.transition.setTarget(0.5), /0 or 1/);
});
