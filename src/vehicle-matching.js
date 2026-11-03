import { projectPosition } from './projection.js';
import { cumulativeDistances, locateOnShape } from './schematic-data.js';
import { mixPosition } from './transition-data.js';

export function pointAtDistance(points, distances, distance) {
  if (distance <= 0) return [...points[0]];
  for (let i = 1; i < points.length; i++) {
    if (distances[i] >= distance) return mixPosition(points[i - 1], points[i],
      (distance - distances[i - 1]) / (distances[i] - distances[i - 1] || 1));
  }
  return [...points.at(-1)];
}

export function referenceDistance(anchors, distance) {
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (distance <= b.sourceDistance) {
      const t = Math.max(0, Math.min(1, (distance - a.sourceDistance) / (b.sourceDistance - a.sourceDistance || 1)));
      return a.schematicDistance + (b.schematicDistance - a.schematicDistance) * t;
    }
  }
  return anchors.at(-1).schematicDistance;
}

// An inbound bus follows its INBOUND source shape. Transfer distance through
// ordered station anchors to the outbound-only drawing in reverse. Reject
// routes whose endpoints/order cannot be reconciled with that drawing.
function inboundAnchors(shape, target, schematic) {
  const length = shape.distances.at(-1), targetLength = target.distances.at(-1);
  const separation = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (separation(shape.coordinates[0], target.sourceCoordinates.at(-1)) > 250 ||
      separation(shape.coordinates.at(-1), target.sourceCoordinates[0]) > 250) return null;
  const anchors = [{ sourceDistance: 0, schematicDistance: targetLength }];
  for (const anchor of [...target.anchors].reverse()) {
    const stops = schematic.stopById.get(anchor.nodeId).sourceStops;
    const locations = stops.map(stop => locateOnShape(stop.projected, shape.coordinates, shape.distances));
    const closest = locations.reduce((a, b) => a.distanceFromShape < b.distanceFromShape ? a : b);
    if (closest.distanceFromShape > 100 || closest.distanceAlong <= anchors.at(-1).sourceDistance + 1 ||
        closest.distanceAlong >= length - 1 || anchor.schematicDistance >= anchors.at(-1).schematicDistance) continue;
    anchors.push({ sourceDistance: closest.distanceAlong, schematicDistance: anchor.schematicDistance });
  }
  // Require interior reference points covering a useful part of the route.
  if (anchors.length < 3) return null;
  anchors.push({ sourceDistance: length, schematicDistance: 0 });
  if (anchors.some((anchor, i) => i && anchor.sourceDistance - anchors[i - 1].sourceDistance > length * 0.65)) return null;
  return anchors;
}

export function createVehicleMatcher(model, schematic, mapping, config) {
  const shapes = model.routes.flatMap(route => route.shapes.map(shape => ({ ...shape,
    routeId: route.id, color: route.color, distances: cumulativeDistances(shape.coordinates),
    target: schematic.routes.find(target => target.id === route.id) })));
  for (const shape of shapes) {
    const target = shape.target;
    shape.anchors = !target ? null : shape.sourceShapeId === target.sourceShapeId
      ? [{ sourceDistance: 0, schematicDistance: 0 }, ...target.anchors,
        { sourceDistance: shape.distances.at(-1), schematicDistance: target.distances.at(-1) }]
      : inboundAnchors(shape, target, schematic);
  }
  const byId = new Map(shapes.map(shape => [shape.sourceShapeId, shape]));
  const patterns = mapping?.patterns ?? [];
  // Do not assume direction_id=0 means outbound. Derive it from GTFS shape IDs.
  const directionShapes = new Map();
  for (const pattern of patterns) {
    const key = `${pattern.routeId}:${pattern.directionId}`;
    if (!directionShapes.has(key)) directionShapes.set(key, new Set());
    directionShapes.get(key).add(pattern.shapeId);
  }

  return function match(vehicle, previous) {
    const geographic = projectPosition([vehicle.longitude, vehicle.latitude]);
    const result = { ...vehicle, geographic, schematic: null, match: 'unmatched',
      reason: 'No trip or route assignment in the feed.', color: '#334155' };
    let candidates;
    const pattern = vehicle.tripId && mapping && Object.hasOwn(mapping.trips, vehicle.tripId)
      ? patterns[mapping.trips[vehicle.tripId]] : undefined;
    const hasDirection = vehicle.directionId !== undefined && vehicle.directionId !== null && vehicle.directionId !== '';
    if (pattern && ((vehicle.routeId && String(vehicle.routeId) !== pattern.routeId) ||
      (hasDirection && String(vehicle.directionId) !== pattern.directionId))) {
      return { ...result, reason: 'Trip and route/direction identifiers conflict; assignment withheld.' };
    }
    const routeId = pattern?.routeId ?? (vehicle.routeId ? String(vehicle.routeId) : undefined);
    const route = mapping?.routes[routeId];
    const mapRouteId = pattern?.mapRouteId ?? route?.mapRouteId;
    const directionId = pattern?.directionId ?? (hasDirection ? String(vehicle.directionId) : undefined);
    Object.assign(result, { routeId, mapRouteId, directionId, headsign: pattern?.headsign,
      routeName: route?.name, routeShortName: route?.shortName, direction: pattern?.direction,
      color: shapes.find(shape => shape.routeId === mapRouteId)?.color ?? result.color });
    if ([3, 6, 7, 'CANCELED', 'DUPLICATED', 'DELETED'].includes(vehicle.scheduleRelationship)) {
      return { ...result, reason: 'Trip is canceled, deleted, or duplicated; schematic placement withheld.' };
    }
    if (pattern) {
      const shape = byId.get(pattern.shapeId);
      if (!shape || shape.routeId !== mapRouteId) return { ...result, reason: `Trip shape ${pattern.shapeId} is absent from this map or its route mapping conflicts.` };
      candidates = [shape];
      result.match = 'trip';
    } else if (routeId && mapRouteId) {
      if (directionId !== undefined) {
        const ids = directionShapes.get(`${routeId}:${directionId}`);
        // A descriptor without a trip cannot distinguish a known variant.
        if (!ids?.size || [...ids].some(id => !byId.has(id))) {
          return { ...result, reason: 'Direction has unknown/unsupported shape variants; a known trip is needed.' };
        }
        candidates = shapes.filter(shape => ids.has(shape.sourceShapeId));
      } else {
        if (patterns.some(p => p.routeId === routeId && !byId.has(p.shapeId))) {
          return { ...result, reason: 'Route has unsupported shape variants; a known trip is needed.' };
        }
        candidates = shapes.filter(shape => shape.routeId === mapRouteId);
      }
      result.match = 'route';
    } else return { ...result, reason: routeId ? `Route ${routeId} is not represented by this map.` : result.reason };

    const located = candidates.map(shape => ({ shape,
      location: locateOnShape(geographic, shape.coordinates, shape.distances) }))
      .sort((a, b) => a.location.distanceFromShape - b.location.distanceFromShape);
    const best = located[0];
    if (!best || best.location.distanceFromShape > config.maxSnapMeters) {
      return { ...result, match: 'off-route', reason: 'Position is too far from its assigned route; geographic position retained.' };
    }
    if (located[1] && located[1].location.distanceFromShape - best.location.distanceFromShape < config.ambiguityMeters) {
      return { ...result, match: 'ambiguous', reason: 'Overlapping directions cannot be distinguished from the available identifiers.' };
    }
    const { shape } = best;
    let location = best.location;
    // Intersections/loops can have several equally close, distant progress
    // values on ONE shape. Use recent same-trip progress only to resolve ties.
    const alternatives = [];
    for (let i = 1; i < shape.coordinates.length; i++) {
      const local = locateOnShape(geographic, [shape.coordinates[i - 1], shape.coordinates[i]]);
      if (local.distanceFromShape <= location.distanceFromShape + 12) alternatives.push({ ...local,
        segment: i - 1, distanceAlong: shape.distances[i - 1] + local.distanceAlong });
    }
    if (alternatives.some(a => Math.abs(a.distanceAlong - location.distanceAlong) > 200)) {
      const elapsed = vehicle.timestamp - previous?.timestamp;
      const validHistory = previous?.sourceShapeId === shape.sourceShapeId && previous.tripId === vehicle.tripId &&
        elapsed >= 0 && elapsed <= 120;
      const plausible = validHistory ? alternatives.filter(a => a.distanceAlong >= previous.distanceAlong - 60 &&
        a.distanceAlong <= previous.distanceAlong + 35 * elapsed + 80) : [];
      if (!plausible.length || Math.max(...plausible.map(a => a.distanceAlong)) - Math.min(...plausible.map(a => a.distanceAlong)) > 200) {
        return { ...result, match: 'ambiguous', reason: 'Position is at a route loop or crossing; progress is ambiguous.' };
      }
      location = plausible.reduce((a, b) => a.distanceFromShape < b.distanceFromShape ? a : b);
    }
    Object.assign(result, { direction: shape.direction, sourceShapeId: shape.sourceShapeId,
      distanceAlong: location.distanceAlong, distanceFromShape: location.distanceFromShape,
      reason: pattern ? 'Matched by GTFS trip and shape.' : `Matched by route${directionId !== undefined ? ' and direction' : '; direction inferred from position'}.` });
    if (!shape.anchors) return { ...result, reason: result.reason + ' This shape has no reliable schematic reference.' };
    const distance = referenceDistance(shape.anchors, location.distanceAlong);
    result.schematic = pointAtDistance(shape.target.coordinates, shape.target.distances, distance);
    result.schematicReference = shape.direction === 'Inbound' ? 'Inbound position on the shared route diagram (station references).' : 'Outbound station references.';
    return result;
  };
}

export function vehicleFreshness(vehicle, feedTimestamp, nowSeconds, config) {
  const time = vehicle.timestamp ?? feedTimestamp ?? vehicle.firstReceivedAt;
  const age = nowSeconds - time;
  const invalidTime = !Number.isFinite(age) || age < -60;
  return { age: Math.max(0, age), time, estimated: !vehicle.timestamp,
    stale: invalidTime || age > config.staleSeconds || (!vehicle.timestamp && !feedTimestamp),
    hidden: invalidTime || age > config.hideAfterSeconds };
}
