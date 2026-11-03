import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectPosition, projectCollection } from '../src/projection.js';
import { prepareMap, ROUTE_COLORS } from '../src/map-data.js';

const readData = async name => JSON.parse(await readFile(new URL(`../data/${name}.geojson`, import.meta.url), 'utf8'));
const [lines, stops, reference] = await Promise.all([
  readData('lines_6514'), readData('stops_6514'), readData('main_stops_6514'),
]);

test('EPSG:6514 false origin is [600000, 0] meters', () => {
  const [x, y] = projectPosition([-109.5, 44.25]);
  assert.ok(Math.abs(x - 600000) < 1e-6);
  assert.ok(Math.abs(y) < 1e-6);
});

test('all 334 projected stops agree with the existing meter-coordinate reference to 1 mm', () => {
  const control = new Map(reference.features.map(feature => [feature.properties.stop_id, feature.geometry.coordinates]));
  assert.equal(control.size, 334);
  for (const feature of stops.features) {
    const actual = projectPosition(feature.geometry.coordinates);
    const expected = control.get(feature.properties.stop_id);
    assert.ok(expected, `Missing control stop ${feature.properties.stop_id}`);
    assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 0.001,
      `Projection mismatch for stop ${feature.properties.stop_id}: ${actual} vs ${expected}`);
  }
});

test('source degrees are preserved; projected bounds include every line vertex and stop', () => {
  const originals = JSON.stringify([lines, stops]);
  const model = prepareMap(lines, stops);
  assert.equal(JSON.stringify([lines, stops]), originals);
  const [minX, minY, maxX, maxY] = model.bounds;
  assert.ok(minX > 250000 && maxX < 269000 && minY > 294000 && maxY < 309000);
  const allPoints = [
    ...model.routes.flatMap(route => route.shapes.flatMap(shape => shape.coordinates)),
    ...model.stops.map(stop => stop.geometry.coordinates),
  ];
  for (const [x, y] of allPoints) assert.ok(x >= minX && x <= maxX && y >= minY && y <= maxY);
  assert.equal(model.stops.length, 334);
});

test('12 distinct route colors group both directions of all 24 source shapes', () => {
  const { routes } = prepareMap(lines, stops);
  assert.equal(routes.length, 12);
  assert.equal(new Set(routes.map(route => route.color)).size, 12);
  assert.equal(routes.reduce((sum, route) => sum + route.shapes.length, 0), 24);
  for (const route of routes) {
    assert.equal(route.color, ROUTE_COLORS[route.id]);
    assert.deepEqual(new Set(route.shapes.map(shape => shape.direction)), new Set(['Inbound', 'Outbound']));
  }
});

test('reject meter coordinates rather than silently projecting them twice', () => {
  assert.throws(() => projectCollection(reference), /longitude\/latitude/);
});
