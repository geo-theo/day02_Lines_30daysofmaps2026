import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareMap, ROUTE_COLORS } from '../src/map-data.js';
import { prepareSchematic, locateOnShape } from '../src/schematic-data.js';
import { placeLabels } from '../src/schematic-view.js';

const read = async name => JSON.parse(await readFile(new URL(`../data/${name}_6514.geojson`, import.meta.url), 'utf8'));
const [lines, stops] = await Promise.all([read('lines'), read('stops')]);
const model = prepareSchematic(lines, stops);

test('every geographic route has exactly one explicit outbound schematic shape with the same color', () => {
  const geographic = prepareMap(lines, stops);
  assert.deepEqual(model.routes.map(r => r.id), geographic.routes.map(r => r.id));
  assert.equal(new Set(model.routes.map(r => r.sourceShapeId)).size, 12);
  for (const route of model.routes) {
    const source = lines.features.find(f => f.properties.shape_id === route.sourceShapeId);
    assert.equal(String(source.properties.Route), route.id);
    assert.equal(source.properties.Direction, route.direction);
    assert.equal(route.direction, 'Outbound');
    assert.equal(route.color, ROUTE_COLORS[route.id]);
    assert.deepEqual(route.sourceGeographicCoordinates, source.geometry.coordinates);
    assert.ok(geographic.routes.find(r => r.id === route.id).shapes.some(s => s.sourceShapeId === route.sourceShapeId));
  }
});

test('all schematic edges are horizontal, vertical or 45 degrees, without zero-length edges', () => {
  for (const route of model.routes) {
    assert.ok(route.coordinates.length >= 2);
    for (let i = 1; i < route.coordinates.length; i++) {
      const dx = Math.abs(route.coordinates[i][0] - route.coordinates[i - 1][0]);
      const dy = Math.abs(route.coordinates[i][1] - route.coordinates[i - 1][1]);
      assert.ok(dx + dy > 1e-8, `Zero-length edge on route ${route.id}`);
      assert.ok(dx < 1e-8 || dy < 1e-8 || Math.abs(dx - dy) < 1e-8, `Off-angle edge on route ${route.id}`);
    }
  }
});

test('141 source IDs form 82 disjoint local station groups; omitted stops are explicit', () => {
  const sourceIds = new Set(stops.features.map(s => s.properties.stop_id));
  assert.equal(model.stops.length, 82);
  assert.equal(model.sourceStopToNode.size, 141);
  assert.equal(model.omittedSourceStopIds.length, 193);
  for (const node of model.stops) {
    assert.ok(node.routeIds.length > 0);
    assert.equal(new Set(node.routeIds).size, node.routeIds.length);
    for (const id of node.sourceStopIds) {
      assert.ok(sourceIds.has(id));
      assert.equal(model.sourceStopToNode.get(id), node.id);
      assert.ok(!model.omittedSourceStopIds.includes(id));
    }
    for (const a of node.sourceStops) for (const b of node.sourceStops) {
      assert.ok(Math.hypot(a.projected[0] - b.projected[0], a.projected[1] - b.projected[1]) < 175,
        `Nonlocal combination in ${node.id}`);
    }
  }
  assert.equal(model.sourceStopToNode.size + model.omittedSourceStopIds.length, sourceIds.size);
  assert.deepEqual(model.stopById.get('southgate').sourceStopIds, ['46', '71']);
  assert.equal(model.stopById.get('transfer').routeIds.length, 12);
});

test('anchors follow source order, stay near the selected shape, and land on each schematic path', () => {
  for (const route of model.routes) {
    assert.equal(route.anchors[0].nodeId, 'transfer');
    assert.equal(route.anchors[0].sourceProgress, 0);
    for (const [i, anchor] of route.anchors.entries()) {
      const nearest = anchor.sourceMatches.find(match => match.sourceStopId === anchor.sourceStopId);
      assert.ok(nearest.distanceFromShape < 45);
      assert.ok(anchor.sourceProgress >= 0 && anchor.sourceProgress <= 1);
      assert.ok(anchor.schematicProgress >= 0 && anchor.schematicProgress <= 1);
      assert.ok(route.coordinates.some(point => point[0] === anchor.position[0] && point[1] === anchor.position[1]));
      assert.ok(model.stopById.get(anchor.nodeId).ports.some(p => p.routeId === route.id && p.position === anchor.position));
      if (i) {
        assert.ok(anchor.sourceDistance > route.anchors[i - 1].sourceDistance);
        assert.ok(anchor.schematicDistance > route.anchors[i - 1].schematicDistance);
      }
    }
  }
});

test('schematic lookup and geometry do not depend on GeoJSON feature order or mutate source data', () => {
  const before = JSON.stringify([lines, stops]);
  const reordered = prepareSchematic({ ...lines, features: [...lines.features].reverse() },
    { ...stops, features: [...stops.features].reverse() });
  assert.deepEqual(reordered.routes, model.routes);
  assert.deepEqual(reordered.stops, model.stops);
  assert.equal(JSON.stringify([lines, stops]), before);
});

test('invalid source IDs fail clearly instead of silently reassigning route correspondence', () => {
  assert.throws(() => prepareSchematic({ ...lines,
    features: lines.features.filter(f => f.properties.shape_id !== 'shp-11-52') }, stops), /Invalid outbound shape shp-11-52/);
  assert.throws(() => prepareSchematic(lines, { ...stops,
    features: stops.features.filter(f => f.properties.stop_id !== '497') }), /Unknown source stop 497/);
});

test('linear references use segment distance, not vertex density', () => {
  const points = [[0, 0], [0, 1], [0, 2], [0, 100], [100, 100]];
  const result = locateOnShape([50, 102], points);
  assert.equal(result.distanceFromShape, 2);
  assert.equal(result.distanceAlong, 150);
  assert.equal(result.progress, 0.75);
  assert.equal(result.segment, 3);
});

test('crowded labels yield to hubs, avoid obstacles, and remain inside desktop and phone canvases', () => {
  for (const width of [390, 1280]) {
    const box = (x, y) => ({ x, y, width: 100, height: 20 });
    const labels = placeLabels([
      { id: 'minor', priority: 10, boxes: [box(30, 30)] },
      { id: 'hub', priority: 100, boxes: [box(30, 30)] },
      { id: 'fallback', priority: 50, boxes: [box(30, 30), box(30, 65)] },
      { id: 'outside', priority: 80, boxes: [box(width - 5, 10)] },
      { id: 'controls', priority: 70, boxes: [box(width - 120, 100)] },
    ], [box(width - 120, 100)], width, 500);
    assert.deepEqual(labels.map(label => label.id), ['hub', 'fallback']);
    assert.equal(labels[1].box.y, 65);
  }
});
