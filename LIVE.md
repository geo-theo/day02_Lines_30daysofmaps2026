# Part 4 — hourly Mountain Line vehicle snapshots

The static map, both cameras, and the reversible transition remain usable even
if the live feed fails. There are no browser runtime dependencies or API keys.

## Run

Use Node.js 20 or later. No install or build step is needed.

```sh
npm start
```

Open <http://127.0.0.1:4173>. This is a static-only server. The default agency
feed currently fails browser CORS checks; the map shows a feed-unavailable state.
To see live positions locally, use the optional cached proxy:

```sh
npm run start:live
```

Open <http://127.0.0.1:4173/?feed=./api/vehicles>. The printed URL includes this
override. A normal reload without `?feed=` returns to the configured default.
The proxy binds only to loopback, requests one fixed agency URL, caches successful
responses for one hour, coalesces concurrent requests, and waits at least
one hour before trying again after an upstream failure. It is a development
server, not a server to expose publicly.

`PORT` can change the port. Another static HTTP server works too, but does not
provide `/api/vehicles`. Do not open the app using `file://`.

## Feed observations — November 3, 2026

These are observations of actual responses, not a promise about future feed
behavior. Requests included `Origin: https://theoj.github.io`; all returned 200.
Two debug samples were requested about 139 seconds apart. A single binary sample
was taken between them. Browser verification also used the 30-second cached local
proxy; the public endpoint was not stress-tested.

| URL | Response Date (UTC) | Content-Type | Body |
| --- | --- | --- | --- |
| `https://bt.mountainline.com/gtfsrt/vehicles?debug` | 08:49:56 | **Absent** | 2,020 bytes of protobuf text |
| `https://bt.mountainline.com/gtfsrt/vehicles` | 08:50:14 | `application/x-google-protobuf` | 411 bytes of binary protobuf |
| debug again | 08:52:15 | **Absent** | 2,019 bytes of protobuf text |

The debug body begins like this; it is **not JSON**:

```text
header {
  gtfs_realtime_version: "2.0"
  incrementality: FULL_DATASET
  timestamp: 1793695783
}
entity {
  id: "1"
  vehicle {
    position {
      latitude: 46.884117
      longitude: -114.01038
      bearing: 296.0
      speed: 0.0
    }
    timestamp: 1793695779
    vehicle { id: "25715" }
  }
}
```

The normalized structure is a feed header plus repeated entities containing
VehiclePosition records: vehicle ID, latitude/longitude, bearing, speed (m/s),
and a Unix timestamp in seconds. GTFS fields such as `trip.trip_id`, `route_id`,
and `direction_id` are supported when supplied. All **nine** vehicles in these
overnight samples lacked the entire `trip` descriptor. They were stationary in
one small area; the feed alone does not establish whether they were in service.
A later browser check reported eight vehicles, still without assignments.

The debug header timestamp advanced from `1793695783` (08:49:43 UTC) to
`1793695933` (08:52:13 UTC), a 150-second advance. Most individual position
timestamps advanced too, but vehicle `25714` stayed at `1793695393` (08:43:13 UTC):
one position was already over six minutes old. Coordinates mostly stayed still.
This establishes that snapshots/timestamps change, **not** an exact publisher
refresh period, guaranteed freshness, or guaranteed service hours. No Cache-Control,
ETag, Last-Modified, or advertised refresh interval appeared on these responses.
Captured public text/binary bodies are in `tests/fixtures/`; tests never poll.

Neither endpoint returned `Access-Control-Allow-Origin`, including with a Pages
Origin header. A browser cross-origin GET therefore cannot expose the response
to this app. `fetch(..., { mode: 'no-cors' })` would produce an unreadable opaque
response and cannot fix it. Static GTFS ZIP download headers **do** allow CORS;
that does not imply anything about this separate realtime host.

The application defaults to the binary URL, the standard wire format. It also
recognizes standard snake_case/camelCase GTFS-Realtime JSON from a configured
proxy, and the observed debug text grammar. It sniffs the body because the debug
response has no media type, validates the GTFS header, skips unknown binary
fields, and fails visibly on malformed/HTML responses. Debug syntax is not a
stable machine interface: a future change may require a decoder update. Only
FULL_DATASET feeds are accepted; differential updates are rejected explicitly.

## Behavior and matching

- Circle markers use a route number, dark readable text, a route-color border,
  and explicit IN/OUT text when known. `B` means no mapped route assignment.
  Route/geographic markers have 44px hit areas, accessible names, keyboard focus and Enter/Space
  selection. An HTML vehicle list makes overlapping or hidden markers selectable.
  The plain HTML detail panel shows ID, route, direction, destination, trip,
  speed, position time and numeric bearing. The status starts with `Bus snapshots:`
  and a count; feed and receipt times are separated by ` | `, followed by
  `Refreshes hourly` so the snapshot cadence is explicit.
- Geographic markers always use the reported position projected to EPSG:6514;
  they are never moved onto a road. Schematic matching searches only the assigned
  shape(s), never the nearest unrelated route. Positions farther than 150 meters
  from that shape are grouped in the schematic's transfer station box. No trip and no route means no
  inferred route, even where the bus happens to be near a line.
- `data/gtfs-route-map.json` contains exact trip IDs → pattern/shape IDs from
  the agency's static GTFS, plus agency route IDs → this map's route IDs through
  `route_short_name`. Direction IDs are derived from known GTFS shape mappings;
  no general meaning is assumed for 0/1. This downloaded version happens to use
  0 for Outbound and 1 for Inbound. Feed trip/route/direction conflicts withhold
  schematic placement. Unknown trips can use explicit route/direction identifiers
  only when the static mapping leaves an unambiguous supported shape.
- With a route but no direction, coincident directions (distance difference less
  than 25 meters) are ambiguous and appear in the transfer station box. Route loops and
  self-crossings with close positions but progress differing by over 200 meters
  also withhold placement unless recent same-trip, same-shape progress resolves
  the tie. Bearing is shown in details but is not treated as proof of
  a route/direction, especially for stationary vehicles.
- Outbound linear references reuse Part 3's ordered stop anchors. Project onto
  the geographic shape in meters; interpolate geographic distance within that
  stop-to-stop interval to the corresponding schematic interval; then evaluate
  the schematic polyline by distance. Vertex counts/densities and total route
  fractions are not equated.
- Part 2 draws only outbound route geometry. Inbound buses first reference their
  own inbound shape. Its ordered station groups within 100 meters are paired to
  decreasing distances along that route's drawing; endpoints must agree within
  250 meters. At least two interior anchors and no gap exceeding 65% of route
  length are required. Inbound placement is an approximation on the shared route
  diagram, labeled IN; it does not claim the outbound
  street alignment is the inbound alignment. All 12 existing inbound shapes pass
  this check. Unsupported/reordered shapes use the transfer station box on the schematic.
- During the transition, each marker interpolates between its geographic and
  schematic screen coordinates using the exact map progress and endpoint cameras.
  Pan, zoom, resize, reversal and reduced motion use the existing map clock.
  Unmatched vehicles move into the **Mountain Line Transfer Center** station box
  as small, unlabeled circles. All circles fit inside the station, shrinking for
  larger fleets and following its pan/zoom. This is a visual grouping, not a
  geographic location or route assignment. Returning to geographic mode moves
  each marker back to its actual reported point. The HTML list remains available.
  Vehicle updates are discrete observations; no motion between GPS reports is
  fabricated.

An additional diagnostic check on November 3 found eight vehicles still lacking
trip/route identifiers, all more than 300 meters from the nearest mapped shape.
The public `https://bt.mountainline.com/gtfsrt/trips?debug` snapshot contained only
a header, with no trip updates to recover vehicle assignments. The interface
therefore groups these buses in the transfer station box when the schematic
opens. No extra periodic trip-feed request
has been added.

## Freshness, errors, and request budget

`src/live-config.js` configures the feed URL, mapping URL, refresh/timeout periods,
staleness/expiry thresholds, and matching tolerances. `?feed=` overrides only the
client URL and supports absolute HTTPS or document-relative URLs, including
repository subpaths. No arbitrary upstream URL is accepted by either proxy.

An initial request runs when a visible page opens, then one request is made at a
time, one hour after the previous completion. Requests time out after 10 seconds;
failed requests retry after one hour too. The retry cap never shortens the
configured refresh interval. Background tabs schedule no requests; an
already-running request may finish. Returning to a tab respects the same minimum
interval/backoff. Multiple tabs are independent; use the cached proxy for public
deployments with multiple visitors. This is an hourly snapshot view, not continuous
live tracking or a globally synchronized update at the top of each hour.

The panel distinguishes the feed's published time from the local last-received
time. A successful HTTP response does not reset the age of a vehicle timestamp.
After 120 seconds, a position is stale and its marker gets a dashed outline;
after two hours its marker is hidden, while details remain available in the
list. This retains snapshots between hourly requests without presenting old
positions as fresh. The hourly proxy cache can add nearly an hour of age at
receipt, before any delay in the agency's own feed. A missing position timestamp
uses the feed timestamp with an explicit
estimated-age note; if both are missing, receipt time bounds retention and the
position is always marked stale. Unchanged timestamp-less positions retain their
original receipt time. Future position times over 60 seconds are invalid and
hidden. Feed timestamp regressions are errors; per-vehicle regressions preserve
the newer known record. Full snapshots remove absent vehicles.

Errors retain the last successful snapshot subject to those age limits. An empty
valid snapshot shows “No vehicles currently reported.” The static map does not
depend on either the feed or trip metadata fetch succeeding.

## GitHub Pages and optional serverless proxy

GitHub Pages serves static files; **it cannot run `scripts/serve.mjs`, proxy this
feed by itself, or add CORS headers to the agency's response**. See
[GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
Deploying the static files alone works, but live tracking will show unavailable
until the agency enables CORS or a separate HTTPS proxy is configured.

An optional Cloudflare Worker is provided in `examples/cloudflare-worker/`:

1. Set `ALLOWED_ORIGIN` in `wrangler.toml` to `https://YOUR-USERNAME.github.io`,
   or the origin of your custom Pages domain. Omit the repository path and the
   trailing slash. A staging domain needs its own appropriate configuration.
2. Deploy that directory with your Cloudflare account using Wrangler, for example
   `npx wrangler deploy` from that directory. This project does not install
   Wrangler or deploy any cloud resources automatically.
3. Set `feedUrl` in `src/live-config.js` to the resulting URL, for example
   `https://mountain-line-vehicles.YOUR-SUBDOMAIN.workers.dev/vehicles`.
   Keep `mappingUrl` document-relative so Pages repository subpaths work.
4. Publish the project root through Pages, then verify in browser developer tools
   that the Worker GET succeeds and the returned allow-origin matches the Pages
   origin. Test an outage too; routes must remain interactive.

The Worker only fetches the binary Mountain Line URL, accepts GET/OPTIONS at
`/vehicles`, adds CORS to success and error responses, and caches successful
responses for one hour on demand using the [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).
Queries do not vary the cache key. It has an 8-second upstream timeout and a
2 MB response guard. Edge caches are per data center, not a globally coordinated
hourly poller; high-traffic use may need a centrally scheduled cache/rate
limit. CORS restricts browser access, not arbitrary server-side clients.
No proxy has been deployed as part of this implementation.

## Updating static identifiers

The committed lookup was generated from one download of
<https://mountainline.com/files/MUTD_GTFS.zip>, version **S1000051**, valid
2026-07-03 through 2027-02-15, last-modified 2026-07-08. It has 1,146 trips and
28 patterns. Keep it in sync when the agency changes schedules or identifiers.

Download the ZIP once, extract it to a local directory, then run:

```sh
node scripts/build-gtfs-map.mjs PATH_TO_EXTRACTED_GTFS
npm test
```

The script reads `routes.txt`, `trips.txt`, and `feed_info.txt` without making
network requests. Review the regenerated lookup. Route 4S (`route_id=Short`)
is not represented by this map and is not folded into route 4. Trips with
`shp-12-03` and `shp-6-02` also have no corresponding geographic map shape;
they use the schematic's transfer station box. Updating identifiers does not add
missing map geometry or prove that old route alignments still match the service.

The public protocol is documented in the
[GTFS-Realtime reference](https://gtfs.org/documentation/realtime/reference/)
and [official protobuf schema](https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto).

## Verification

`npm test` uses only local fixtures and deterministic synthetic cases. Part 4
covers actual text/binary decoding, snake/camel JSON, malformed responses,
direction 0, invalid/deleted/duplicate positions, all 24 mapped shapes, exact
station references, inbound reverse progress, unsupported/conflicting/missing
identifiers, shared corridors, loop ties/history, stale/future/missing timestamps,
marker interpolation, unplaced-marker visibility and fitting inside the station at desktop/phone scales,
visibility pauses, request overlap/backoff, timestamp
regression, and full snapshot replacement. Existing Parts 1–3 tests still run.

Browser checks: geographic and schematic modes, keyboard selection, overlapping
vehicle list, inbound and stale markers with an explicitly labeled local test
fixture, expiration, desktop/mobile panel scrolling, and the real proxy feed.
Never substitute a test fixture for live data in a production configuration.
