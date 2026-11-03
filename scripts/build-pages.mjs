import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFeed } from '../src/gtfs-realtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = 'https://bt.mountainline.com/gtfsrt/vehicles';
const maxBytes = 2_000_000;

// The workflow publishes this directory only after the entire build succeeds.
// A failed download/validation leaves the previously deployed site in place.
export async function buildPages({ outputDir = resolve(root, '_site'), fetcher = fetch } = {}) {
  const response = await fetcher(upstream, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Vehicle feed returned HTTP ${response.status}`);
  if (Number(response.headers.get('Content-Length')) > maxBytes) throw new Error('Oversized vehicle feed');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const feed = decodeFeed(bytes, response.headers.get('Content-Type') ?? '');

  await mkdir(resolve(outputDir, 'data'), { recursive: true });
  // Publish only the browser assets and the three static datasets the app uses.
  const files = ['index.html', 'styles.css', 'src', 'data/lines_6514.geojson',
    'data/stops_6514.geojson', 'data/gtfs-route-map.json'];
  await Promise.all(files.map(path => cp(resolve(root, path), resolve(outputDir, path), { recursive: true })));
  await writeFile(resolve(outputDir, 'data/vehicles.pb'), bytes);
  return { outputDir, vehicleCount: feed.vehicles.length, timestamp: feed.timestamp };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await buildPages();
    const feedTime = result.timestamp ? new Date(result.timestamp * 1000).toISOString() : 'not supplied';
    console.log(`Prepared _site with ${result.vehicleCount} vehicles. Feed time: ${feedTime}`);
  } catch (error) {
    console.error(`Pages build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
