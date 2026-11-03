// Usage: node scripts/build-gtfs-map.mjs PATH_TO_EXTRACTED_GTFS
// No network requests: use a single downloaded, extracted agency GTFS ZIP.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseCSV(text) {
  const rows = [], row = [];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field); field = '';
      if (c !== ',') {
        if (row.some(Boolean)) rows.push([...row]);
        row.length = 0;
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift().map(s => s.replace(/^\uFEFF/, ''));
  return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ''])));
}

export function buildMapping(routes, trips, feedInfo, lines) {
  const shapes = new Map(lines.features.map(f => [f.properties.shape_id, f.properties]));
  const mapIds = new Set(lines.features.map(f => String(f.properties.Route)));
  const result = { source: 'https://mountainline.com/files/MUTD_GTFS.zip',
    generatedAt: new Date().toISOString(), feedInfo,
    routes: {}, patterns: [], trips: {} };
  for (const route of routes) {
    result.routes[route.route_id] = { name: route.route_long_name,
      shortName: route.route_short_name,
      mapRouteId: mapIds.has(route.route_short_name) ? route.route_short_name : null };
  }
  const patternIndex = new Map();
  for (const trip of trips) {
    const shape = shapes.get(trip.shape_id);
    const mapRouteId = result.routes[trip.route_id]?.mapRouteId;
    const pattern = { routeId: trip.route_id, directionId: trip.direction_id,
      shapeId: trip.shape_id, headsign: trip.trip_headsign,
      mapRouteId, direction: shape && String(shape.Route) === mapRouteId ? shape.Direction : null };
    const key = JSON.stringify(pattern);
    if (!patternIndex.has(key)) { patternIndex.set(key, result.patterns.length); result.patterns.push(pattern); }
    result.trips[trip.trip_id] = patternIndex.get(key);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Supply the directory containing routes.txt, trips.txt, feed_info.txt.');
  const directory = resolve(process.argv[2]);
  const [routes, trips, info] = await Promise.all(['routes', 'trips', 'feed_info'].map(async name =>
    parseCSV(await readFile(resolve(directory, `${name}.txt`), 'utf8'))));
  const lines = JSON.parse(await readFile(new URL('../data/lines_6514.geojson', import.meta.url)));
  const mapping = buildMapping(routes, trips, info[0], lines);
  await writeFile(new URL('../data/gtfs-route-map.json', import.meta.url), JSON.stringify(mapping, null, 2) + '\n');
  console.log(`Mapped ${trips.length} trips and ${mapping.patterns.length} patterns. Unsupported shapes stay explicit.`);
}
