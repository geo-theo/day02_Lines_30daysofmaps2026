import { projectCollection } from './projection.js';

// Route IDs determine colors, so inbound/outbound shapes always share a color.
export const ROUTE_COLORS = Object.freeze({
  1: '#0072b2', 2: '#c44428', 3: '#008765', 4: '#8b4fa3',
  5: '#bc7800', 6: '#ba3c7b', 7: '#258697', 9: '#676f19',
  10: '#555fc3', 11: '#a2592c', 12: '#3d454f', 14: '#df6514',
});

export function prepareMap(linesSource, stopsSource) {
  const lines = projectCollection(linesSource);
  const stops = projectCollection(stopsSource);
  const routes = new Map();
  for (const feature of lines.features) {
    const id = String(feature.properties.Route);
    if (!Object.hasOwn(ROUTE_COLORS, id)) throw new Error(`No color configured for route ${id}.`);
    if (!routes.has(id)) routes.set(id, { id, color: ROUTE_COLORS[id], shapes: [] });
    const parts = feature.geometry.type === 'MultiLineString'
      ? feature.geometry.coordinates : [feature.geometry.coordinates];
    for (const coordinates of parts) {
      routes.get(id).shapes.push({ coordinates, direction: feature.properties.Direction,
        sourceShapeId: feature.properties.shape_id });
    }
  }
  const points = [
    ...[...routes.values()].flatMap(route => route.shapes.flatMap(shape => shape.coordinates)),
    ...stops.features.map(stop => stop.geometry.coordinates),
  ];
  const bounds = points.reduce(([minX, minY, maxX, maxY], [x, y]) => [
    Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  return { routes: [...routes.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    stops: stops.features, bounds };
}
