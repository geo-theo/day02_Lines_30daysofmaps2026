// For GitHub Pages, set feedUrl to your HTTPS proxy's public URL (see LIVE.md).
// A ?feed= URL override is also supported for local development and diagnostics.
export const LIVE_CONFIG = Object.freeze({
  feedUrl: 'https://bt.mountainline.com/gtfsrt/vehicles',
  mappingUrl: './data/gtfs-route-map.json',
  refreshMs: 60 * 60 * 1000,
  timeoutMs: 10_000,
  staleSeconds: 120,
  hideAfterSeconds: 2 * 60 * 60,
  maxSnapMeters: 150,
  ambiguityMeters: 25,
});
