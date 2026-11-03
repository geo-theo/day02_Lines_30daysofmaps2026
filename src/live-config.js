// GitHub Actions publishes this snapshot alongside the map (see LIVE.md).
// A ?feed= URL override is also supported for local development and diagnostics.
export const LIVE_CONFIG = Object.freeze({
  feedUrl: './data/vehicles.pb',
  mappingUrl: './data/gtfs-route-map.json',
  // Check the saved file every five minutes; only Actions calls the agency hourly.
  refreshMs: 5 * 60 * 1000,
  timeoutMs: 10_000,
  staleSeconds: 120,
  hideAfterSeconds: 2 * 60 * 60,
  maxSnapMeters: 150,
  ambiguityMeters: 25,
});
