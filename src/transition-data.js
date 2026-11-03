import { cumulativeDistances } from './schematic-data.js';

const mix = (a, b, t) => t === 0 ? a : t === 1 ? b : a + (b - a) * t;
export const mixPosition = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];

function pointAt(points, distances, distance) {
  if (distance <= 0) return [...points[0]];
  if (distance >= distances.at(-1)) return [...points.at(-1)];
  let low = 1, high = distances.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (distances[middle] < distance) low = middle + 1;
    else high = middle;
  }
  const span = distances[low] - distances[low - 1];
  return mixPosition(points[low - 1], points[low], span ? (distance - distances[low - 1]) / span : 0);
}

// Pair distance along each stop-to-stop section, never unrelated vertex indices
// or global route fractions. Including BOTH paths' bends preserves their exact
// geometry; the extra samples keep long edges smooth while they straighten.
export function resamplePairedPaths(source, target, anchors = []) {
  const sourceDistances = cumulativeDistances(source);
  const targetDistances = cumulativeDistances(target);
  const boundaries = [{ sourceDistance: 0, schematicDistance: 0 }, ...anchors,
    { sourceDistance: sourceDistances.at(-1), schematicDistance: targetDistances.at(-1) }];
  const geographic = [], schematic = [], anchorIndices = [];
  for (let section = 1; section < boundaries.length; section++) {
    const a = boundaries[section - 1], b = boundaries[section];
    const sourceSpan = b.sourceDistance - a.sourceDistance;
    const targetSpan = b.schematicDistance - a.schematicDistance;
    if (sourceSpan < 0 || targetSpan < 0) throw new Error('Transition anchors must follow travel order.');
    const fractions = new Set([0, 1]);
    for (const [distances, start, span] of [
      [sourceDistances, a.sourceDistance, sourceSpan], [targetDistances, a.schematicDistance, targetSpan],
    ]) {
      if (span > 0) for (const distance of distances) {
        if (distance > start && distance < start + span) fractions.add((distance - start) / span);
      }
    }
    const steps = Math.max(1, Math.ceil(sourceSpan / 35), Math.ceil(targetSpan / 4));
    for (let i = 1; i < steps; i++) fractions.add(i / steps);
    for (const t of [...fractions].sort((x, y) => x - y)) {
      if (t === 0 && geographic.length) continue;
      geographic.push(pointAt(source, sourceDistances, mix(a.sourceDistance, b.sourceDistance, t)));
      schematic.push(pointAt(target, targetDistances, mix(a.schematicDistance, b.schematicDistance, t)));
    }
    if (section <= anchors.length) anchorIndices.push(geographic.length - 1);
  }
  return { geographic, schematic, anchorIndices };
}

export function prepareTransition(geographic, schematic) {
  const key = route => `${route.id}:${route.sourceShapeId}`;
  const targets = new Map(schematic.routes.map(route => [key(route), route]));
  const matched = new Set();
  const routes = geographic.routes.flatMap(route => route.shapes.map(shape => {
    const target = targets.get(key({ ...shape, id: route.id }));
    const identity = { id: route.id, color: route.color, sourceShapeId: shape.sourceShapeId,
      direction: shape.direction };
    if (!target) return { ...identity, geographic: shape.coordinates, schematic: null };
    matched.add(key(target));
    return { ...identity, ...resamplePairedPaths(shape.coordinates, target.coordinates, target.anchors) };
  }));
  for (const target of schematic.routes) {
    if (!matched.has(key(target))) routes.push({ id: target.id, color: target.color,
      sourceShapeId: target.sourceShapeId, direction: target.direction,
      geographic: null, schematic: target.coordinates });
  }
  const stops = geographic.stops.map(stop => {
    const id = String(stop.properties.stop_id);
    const nodeId = schematic.sourceStopToNode.get(id);
    const node = schematic.stopById.get(nodeId);
    return { id, name: stop.properties.stop_name, nodeId,
      geographic: stop.geometry.coordinates, schematic: node?.position || null };
  });
  return { routes, stops, nodes: schematic.stops };
}
