// Small read-only decoder for the standard VehiclePosition subset. Unknown
// protobuf fields are skipped, never evaluated. Wire field numbers are from:
// https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
const schema = {
  feed: { 1: ['header', 'header'], 2: ['entity', 'entity', true] },
  header: { 1: ['gtfs_realtime_version', 'string'], 2: ['incrementality', 'uint'], 3: ['timestamp', 'uint'] },
  entity: { 1: ['id', 'string'], 2: ['is_deleted', 'uint'], 4: ['vehicle', 'vehicle'] },
  vehicle: { 1: ['trip', 'trip'], 2: ['position', 'position'], 3: ['current_stop_sequence', 'uint'],
    4: ['current_status', 'uint'], 5: ['timestamp', 'uint'], 7: ['stop_id', 'string'], 8: ['vehicle', 'descriptor'] },
  trip: { 1: ['trip_id', 'string'], 2: ['start_time', 'string'], 3: ['start_date', 'string'],
    4: ['schedule_relationship', 'uint'], 5: ['route_id', 'string'], 6: ['direction_id', 'uint'] },
  position: { 1: ['latitude', 'float'], 2: ['longitude', 'float'], 3: ['bearing', 'float'], 5: ['speed', 'float'] },
  descriptor: { 1: ['id', 'string'], 2: ['label', 'string'], 3: ['license_plate', 'string'] },
};
const decoder = new TextDecoder('utf-8', { fatal: true });

function protobuf(bytes, type) {
  let offset = 0;
  const message = {};
  function uint() {
    let n = 0n, shift = 0n;
    for (let count = 0; count < 10; count++) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf varint');
      const b = bytes[offset++];
      n |= BigInt(b & 127) << shift;
      if (!(b & 128)) {
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe protobuf integer');
        return Number(n);
      }
      shift += 7n;
    }
    throw new Error('Invalid protobuf varint');
  }
  while (offset < bytes.length) {
    const tag = uint(), field = tag >>> 3, wire = tag & 7;
    if (!field) throw new Error('Invalid protobuf field');
    const definition = schema[type][field];
    let value;
    if (wire === 0) value = uint();
    else if (wire === 2) {
      const length = uint();
      if (offset + length > bytes.length) throw new Error('Truncated protobuf message');
      const chunk = bytes.subarray(offset, offset + length);
      offset += length;
      if (definition) value = definition[1] === 'string' ? decoder.decode(chunk) : protobuf(chunk, definition[1]);
    } else if (wire === 5 || wire === 1) {
      const length = wire === 5 ? 4 : 8;
      if (offset + length > bytes.length) throw new Error('Truncated protobuf number');
      if (definition?.[1] === 'float') value = new DataView(bytes.buffer, bytes.byteOffset + offset, length).getFloat32(0, true);
      offset += length;
    } else throw new Error('Unsupported protobuf wire type');
    if (definition) {
      const [name, kind, repeated] = definition;
      const expected = kind === 'uint' ? 0 : kind === 'float' ? 5 : 2;
      if (wire !== expected) throw new Error('Unexpected protobuf field type');
      if (repeated) (message[name] ??= []).push(value);
      else message[name] = value;
    }
  }
  return message;
}

// The ?debug endpoint is protobuf TEXT, not JSON. This conservative parser
// supports its observed field/message grammar; a changed format fails visibly.
export function parseProtobufText(text) {
  const tokens = [];
  const token = /\s+|#[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][\w.]*|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[{}:<>;,]/gy;
  let offset = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) throw new Error('Unrecognized debug feed syntax');
    offset = token.lastIndex;
    if (!/^\s|^#/.test(match[0])) tokens.push(match[0]);
  }
  let i = 0;
  function object(end, depth = 0) {
    if (depth > 20) throw new Error('Debug feed nesting is too deep');
    const result = {};
    while (i < tokens.length && tokens[i] !== end) {
      const key = tokens[i++];
      if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error('Invalid debug field');
      if (tokens[i] === ':') i++;
      let value = tokens[i++];
      if (value === '{' || value === '<') value = object(value === '{' ? '}' : '>', depth + 1);
      else if (value?.startsWith('"')) value = JSON.parse(value);
      else if (/^[-+]?\d|^\./.test(value ?? '')) value = Number(value);
      else if (value === 'true' || value === 'false') value = value === 'true';
      else if (!/^[A-Za-z_]\w*$/.test(value ?? '')) throw new Error('Invalid debug value');
      if (key === 'entity') (result[key] ??= []).push(value);
      else if (Object.hasOwn(result, key)) throw new Error('Duplicate debug field');
      else result[key] = value;
      if (tokens[i] === ',' || tokens[i] === ';') i++;
    }
    if (end && tokens[i++] !== end) throw new Error('Unclosed debug message');
    return result;
  }
  return object();
}

const get = (object, snake, camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())) => object?.[snake] ?? object?.[camel];
const numeric = value => value === undefined || value === null || value === '' ? undefined : Number(value);
const timestamp = value => { const n = numeric(value); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };

export function normalizeFeed(feed) {
  if (!feed || !get(feed.header, 'gtfs_realtime_version') || (feed.entity !== undefined && !Array.isArray(feed.entity))) {
    throw new Error('Expected a GTFS-Realtime FeedMessage');
  }
  const incrementality = get(feed.header, 'incrementality');
  if (incrementality !== undefined && incrementality !== 0 && incrementality !== 'FULL_DATASET') {
    throw new Error('Differential feeds are not supported; configure a full-dataset feed');
  }
  const vehicles = new Map();
  let skipped = 0;
  for (const entity of feed.entity ?? []) {
    if (get(entity, 'is_deleted')) continue;
    const v = entity.vehicle;
    if (!v) continue;
    const latitude = numeric(v.position?.latitude), longitude = numeric(v.position?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) >= 90 || Math.abs(longitude) > 180) {
      skipped++; continue;
    }
    const id = String(v.vehicle?.id ?? entity.id ?? '');
    if (!id) { skipped++; continue; }
    const vehicle = { id, entityId: String(entity.id ?? ''), label: v.vehicle?.label,
      latitude, longitude, bearing: numeric(v.position?.bearing), speed: numeric(v.position?.speed),
      timestamp: timestamp(v.timestamp), tripId: get(v.trip, 'trip_id'), routeId: get(v.trip, 'route_id'),
      directionId: get(v.trip, 'direction_id'), scheduleRelationship: get(v.trip, 'schedule_relationship'),
      stopId: get(v, 'stop_id'), stopSequence: get(v, 'current_stop_sequence') };
    if (!vehicles.has(id) || (vehicle.timestamp ?? 0) > (vehicles.get(id).timestamp ?? 0)) vehicles.set(id, vehicle);
  }
  return { timestamp: timestamp(feed.header.timestamp), vehicles: [...vehicles.values()], skipped };
}

export function decodeFeed(input, contentType = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length || bytes.length > 2_000_000) throw new Error('Empty or oversized vehicle feed');
  // Sniff the body as well as the header: debug currently omits Content-Type.
  const prefix = new TextDecoder().decode(bytes.subarray(0, 100)).trimStart();
  let feed;
  if (prefix.startsWith('{') || /application\/(?:[^;]*\+)?json/i.test(contentType)) feed = JSON.parse(decoder.decode(bytes));
  else if (/^header\s*[:{<]/.test(prefix)) feed = parseProtobufText(decoder.decode(bytes));
  else if (prefix.startsWith('<')) throw new Error('Feed returned HTML/XML instead of GTFS-Realtime');
  else feed = protobuf(bytes, 'feed');
  return normalizeFeed(feed);
}
