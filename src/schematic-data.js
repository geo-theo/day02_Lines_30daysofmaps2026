import { projectPosition } from './projection.js';
import { ROUTE_COLORS } from './map-data.js';
import { SCHEMATIC_ROUTES, SCHEMATIC_STOPS } from './schematic-layout.js';

// Compact the HAND-DRAWN grid vertically for a landscape viewport. A bevel
// restores 45° diagonals after compaction; no geographic coordinates enter it.
const drawingPosition = ([x, y]) => [x, y * 0.6];
function compilePath(entries) {
  const path = [];
  for (const entry of entries) {
    const previous = path.at(-1)?.position;
    const [x, y] = entry.position;
    if (previous) {
      const dx = x - previous[0], dy = y - previous[1];
      if (dx && dy && Math.abs(Math.abs(dx) - Math.abs(dy)) > 1e-8) {
        const position = Math.abs(dx) > Math.abs(dy)
          ? [x - Math.sign(dx) * Math.abs(dy), previous[1]]
          : [previous[0], y - Math.sign(dy) * Math.abs(dx)];
        path.push({ position });
      }
    }
    path.push(entry);
  }
  return path;
}

export function cumulativeDistances(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return distances;
}

// Linear reference on the ORIGINAL ordered source shape, in projected meters.
// GeoJSON has no stop_times: proximity is an explicit inference, not GTFS service.
export function locateOnShape(point, coordinates, distances = cumulativeDistances(coordinates)) {
  let best = { distanceFromShape: Infinity, distanceAlong: 0, segment: 0, fraction: 0 };
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1], b = coordinates[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? Math.max(0, Math.min(1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0;
    const distanceFromShape = Math.hypot(point[0] - a[0] - fraction * dx, point[1] - a[1] - fraction * dy);
    if (distanceFromShape < best.distanceFromShape) {
      best = { distanceFromShape, distanceAlong: distances[i - 1] + fraction * Math.sqrt(lengthSquared),
        segment: i - 1, fraction };
    }
  }
  return { ...best, progress: best.distanceAlong / distances.at(-1) };
}

export function prepareSchematic(linesSource, stopsSource) {
  const sourceStops = new Map(stopsSource.features.map(feature => [String(feature.properties.stop_id), feature]));
  const sourceShapes = new Map(linesSource.features.map(feature => [feature.properties.shape_id, feature]));
  const stops = SCHEMATIC_STOPS.map(stop => ({ ...stop, position: drawingPosition(stop.position), ports: [], routeIds: [],
    sourceStops: stop.sourceStopIds.map(id => {
      const feature = sourceStops.get(id);
      if (!feature) throw new Error(`Unknown source stop ${id} in ${stop.id}.`);
      return { id, name: feature.properties.stop_name, geographic: [...feature.geometry.coordinates],
        projected: projectPosition(feature.geometry.coordinates) };
    }) }));
  const stopById = new Map(stops.map(stop => [stop.id, stop]));
  const routes = SCHEMATIC_ROUTES.map(layout => {
    const source = sourceShapes.get(layout.sourceShapeId);
    if (!source || String(source.properties.Route) !== layout.id || source.properties.Direction !== 'Outbound') {
      throw new Error(`Invalid outbound shape ${layout.sourceShapeId} for route ${layout.id}.`);
    }
    const sourceCoordinates = source.geometry.coordinates.map(projectPosition);
    const sourceDistances = cumulativeDistances(sourceCoordinates);
    const path = compilePath(layout.path.map(entry => {
      if (Array.isArray(entry)) return { position: drawingPosition(entry) };
      const stop = stopById.get(typeof entry === 'string' ? entry : entry.node);
      if (!stop) throw new Error(`Unknown schematic node in route ${layout.id}.`);
      return { nodeId: stop.id, position: typeof entry === 'string' ? [...stop.position] : drawingPosition(entry.at) };
    }));
    const coordinates = path.map(entry => entry.position);
    const distances = cumulativeDistances(coordinates);
    const anchors = path.flatMap((entry, index) => {
      if (!entry.nodeId) return [];
      const nodeId = entry.nodeId;
      const stop = stopById.get(nodeId);
      // Keep every member's individual projection as well as the closest member.
      const matches = stop.sourceStops.map(sourceStop => ({ sourceStopId: sourceStop.id,
        ...locateOnShape(sourceStop.projected, sourceCoordinates, sourceDistances) }));
      const closest = matches.reduce((a, b) => a.distanceFromShape <= b.distanceFromShape ? a : b);
      if (closest.distanceFromShape > 45) throw new Error(`Stop ${nodeId} is not near ${layout.sourceShapeId}.`);
      stop.routeIds.push(layout.id);
      stop.ports.push({ routeId: layout.id, position: coordinates[index] });
      return [{ nodeId, sourceStopIds: [...stop.sourceStopIds], sourceMatches: matches,
        sourceStopId: closest.sourceStopId, sourceDistance: closest.distanceAlong,
        sourceProgress: closest.progress, schematicDistance: distances[index],
        schematicProgress: distances[index] / distances.at(-1), position: coordinates[index] }];
    });
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].sourceDistance < anchors[i - 1].sourceDistance) {
        throw new Error(`Source stop order reverses on ${layout.sourceShapeId} at ${anchors[i].nodeId}.`);
      }
    }
    return { ...layout, badge: drawingPosition(layout.badge), color: ROUTE_COLORS[layout.id], direction: 'Outbound', coordinates, distances, anchors,
      sourceCoordinates, sourceDistances, sourceGeographicCoordinates: source.geometry.coordinates.map(point => [...point]) };
  });
  // Reverse lookup is many-to-one only for these explicit, disjoint stop groups.
  const sourceStopToNode = new Map();
  for (const stop of stops) {
    if (!stop.ports.length) throw new Error(`Unused schematic stop ${stop.id}.`);
    for (const id of stop.sourceStopIds) {
      if (sourceStopToNode.has(id)) throw new Error(`Source stop ${id} appears in multiple schematic groups.`);
      sourceStopToNode.set(id, stop.id);
    }
  }
  return { routes, stops, stopById, sourceStopToNode, bounds: [30, 18, 1300, 576],
    omittedSourceStopIds: [...sourceStops.keys()].filter(id => !sourceStopToNode.has(id)) };
}
