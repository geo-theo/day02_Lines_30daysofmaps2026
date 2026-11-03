# Day 02 — Transit lines

Parts 1–4: Missoula transit routes and stops on a completely white background,
with **Geographic** and **Schematic** views, a reversible animated transition,
and hourly Mountain Line vehicle snapshots.
HTML, CSS, browser JavaScript modules, and SVG; no runtime dependencies, CDNs,
or basemap tiles. GitHub Actions downloads an hourly bus snapshot and publishes
it with the map on GitHub Pages. No external proxy is needed for deployment;
the route map remains usable independently of the snapshot.

## View locally

With Node.js 20 or later:

```sh
npm start
```

Open <http://127.0.0.1:4173>. No install or build step is necessary. An existing
static HTTP server also works; opening `index.html` with `file://` will not work
because browsers restrict fetching local GeoJSON and JavaScript modules.

To preview the same files GitHub Pages publishes, run `npm run build:pages`
once (this downloads the agency feed), start the server with `npm start`, then
open <http://127.0.0.1:4173/_site/>. The generated `_site/` directory is ignored
by Git. The source-root map works without this step, but has no saved snapshot.

For local agency access without building, run `npm run start:live` and open
<http://127.0.0.1:4173/?feed=./api/vehicles>. This enables the small cached local
proxy needed because the agency currently sends no realtime CORS headers.
See [LIVE.md](LIVE.md) for feed observations, matching rules and Pages setup.

Drag to pan, scroll to zoom, and double-click to fit the full network. With the
map focused, use arrow keys to pan, `+` / `-` to zoom, and `Home` / `0` to fit.
Hover a stop for its name or a line for its route and direction.

Use the **Geographic / Schematic** control above the full-window map. Click or tap
**Schematic** to straighten the geographic network; choose **Geographic** to
animate back to the projected routes. These are native radio buttons: use `Tab`
to focus the selected option, then arrow keys or `Space` to select a view.
You can reverse the transition before it finishes. The URL hash follows the
selection, and browser Back/Forward also animates between views.

Open <http://127.0.0.1:4173/#schematic> for Part 2, or
<http://127.0.0.1:4173/#geographic> for Part 1 (also the default). Each view
retains its own camera. On phones the schematic opens zoomed into the center;
drag to explore. Use double-click, `Home` or `0` to fit the full network.

The schematic uses all 12 outbound route shapes and 82 authored nodes representing
141 source stops. Shared stops are combined explicitly, and 193 intermediate
stops are omitted. See [SCHEMATIC.md](SCHEMATIC.md) for the route-direction choices,
stop-combination rules, layout structure and stable source IDs/anchor contract.

## Part 3 — transition

The 1.4-second transition uses EPSG:6514 easting/northing for its geographic
endpoint and Part 2's authored schematic geometry for its other endpoint. Each
layout is fitted to the same viewport with an equal scale in both axes (north
up geographically; y down schematically), then corresponding screen positions
are interpolated. Each view keeps its own pan/zoom. Pan or zoom during a morph
transforms both endpoints together; resizing recalculates them at the current
animation progress.

- `src/transition-data.js` pairs routes by route ID and `sourceShapeId`, and
  stops through `sourceStopToNode`. It pairs each stop-to-stop route interval
  using Part 2's `sourceDistance` / `schematicDistance` anchors. Every bend from
  both paths is retained, with extra samples at most 35 projected meters or
  4 schematic units apart. It does not equate global route fractions.
- `src/transition-view.js` caches screen positions and updates SVG attributes.
  Colors remain fixed. The 141 mapped source stop dots travel toward their
  explicit schematic groups, then blend into the 82 station symbols. The 193
  omitted stops and 12 inbound shapes fade at their geographic positions;
  schematic-only geometry, if supplied, fades in at its schematic position.
  Names and route badges fade near the appropriate endpoint.
- `src/transition.js` owns one animation clock. Reversals continue from the
  current position, and delayed frames still finish at exactly 0 or 1. At
  completion the original endpoint renderer draws the full native geometry,
  avoiding accumulated interpolation error.
- `prefers-reduced-motion: reduce` switches views immediately. Turning that
  preference on during an animation immediately completes the selected view.
  The native radio buttons have visible focus and checked states; a live
  status announces the selected view without announcing animation frames.

To check manually, switch in both directions, reverse midway, try a zoomed/panned
view, resize during a morph, and use browser Back/Forward. Repeat at phone width
and with your OS/browser reduced-motion preference enabled. A direct hash link
opens its endpoint without an entrance animation.

## Part 4 — hourly vehicle snapshots

Select a bus marker with a pointer or Enter/Space, or use the vehicle list in
the lower-right panel. Details show vehicle/route/direction, trip/destination when
available, position time, speed and numeric bearing. The panel distinguishes
feed time from receipt time and labels the hourly snapshots. GitHub Actions
downloads the agency feed hourly. Each browser loads the saved file on page load,
then checks it every five minutes while visible and pauses in background tabs.
Failed browser reads retry every five minutes. Positions over two minutes old have dashed
markers; positions over two hours old remain in the list but disappear from the
map. The optional development proxies still cache snapshots for one hour on demand.

Geographic markers use actual reported positions. Schematic markers use projected
progress on their assigned geographic shape and ordered station anchors, including
reverse references for inbound buses on the shared route diagram. Markers follow
the same transition progress and camera transforms as the routes. Missing or
ambiguous route assignments, unsupported shapes and off-route positions appear
as small, unlabeled circles inside the **Mountain Line Transfer Center** station
box on the schematic. They transition back to their reported geographic positions.
This grouping does not assign a route or imply an actual location at the center.

The observed overnight feed supplied vehicle positions without trip/route
assignments, so those particular buses cannot be placed reliably on a route.
They remain visible in the transfer station box, with circles sized to fit the count.
The static lookup supports identifiers when available; see [LIVE.md](LIVE.md)
for the captured formats, refresh observations, limitations and verification.

## Data and projection

- `data/lines_6514.geojson`: 24 LineStrings, 12 routes (1–7, 9–12, 14).
  Coordinates span longitude **−114.0883 to −113.86517** and latitude
  **46.819761 to 46.92457** degrees.
- `data/stops_6514.geojson`: 334 Points. Coordinates span longitude
  **−114.08799 to −113.865247** and latitude **46.819761 to 46.924218** degrees.
- Neither requested file declares a CRS. The coordinate values and stop
  longitude/latitude properties confirm geographic degrees despite the filenames.
  All source files remain unchanged.
- `src/projection.js` converts every position in memory to **EPSG:6514,
  NAD83(2011) / Montana, meters** using the ellipsoidal Lambert Conformal Conic
  two-standard-parallel equations on GRS80. Parameters: parallels 49° and 45°,
  origin 44.25° N / 109.5° W, false easting 600,000 m, false northing 0 m.
  See the [OGC CRS definition](https://www.opengis.net/def/crs/EPSG/0/6514) and
  [PROJ's LCC documentation](https://proj.org/en/stable/operations/projections/lcc.html).
- The geographic source datum realization and epoch are unknown. For this map,
  longitude/latitude positions are treated as NAD83(2011) before projection:
  a ballpark datum assumption, without a precision WGS84-to-NAD83 datum shift.
- `data/main_stops_6514.geojson` already declares EPSG:6514 and has projected
  meter coordinates. It is used only as an independent projection check; the map
  loads the two requested geographic files.
- SVG is drawn from projected easting/northing with equal scale in both axes,
  north up. Both directions share a route color. Extent includes all route
  vertices and stops, with responsive margins.
  Route labels avoid one another; black points have a thin white outline.

## Check

```sh
npm test
```

Checks the projection's false origin and all 334 reference stops (within 1 mm),
input preservation, projected bounds, and direction/color grouping.
Part 2 also checks source identity, stop groups, travel order, schematic angles,
linear references, stable feature-order-independent lookups and label collisions.
Part 3 checks route/stop correspondence, one-view-only geometry, every retained
bend, sample spacing, exact endpoints, paired stop anchors, feature-order
independence, reversals, delayed frames, and immediate reduced-motion switches.
Part 4 checks feed decoding, route/direction matching, inbound/outbound references,
ambiguity, stale/expired positions, marker interpolation and responsible polling.

## GitHub Pages

The included `.github/workflows/pages.yml` handles the whole deployment on GitHub:

1. In the repository's **Settings → Pages → Build and deployment**, set
   **Source** to **GitHub Actions**. GitHub Free requires a public repository.
2. Commit and push these files to `main`. The workflow also runs on pushes, so
   the first deployment does not need to wait for the hourly schedule.
3. In **Actions → Publish hourly bus snapshots**, check the result. To retry or
   refresh immediately, choose **Run workflow** on `main`.

The workflow is scheduled for **17 minutes past every hour (UTC)**. It tests the
app, downloads and validates one agency snapshot, packages the browser assets and
three static datasets in `_site/`, and deploys that artifact directly to Pages.
It needs no personal token, external service, or hourly commits to the repository.
The browser reads `./data/vehicles.pb` from the same site; all URLs work under
a repository subpath. A download/validation failure fails the build and leaves
the last deployed site in place. Initial deployment requires a successful fetch.

Scheduled runs can be delayed or dropped, and GitHub disables public-repository
schedules after 60 days without repository activity. Check the Actions tab if
snapshots stop advancing. See [GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [LIVE.md](LIVE.md) for freshness behavior and optional local/proxy alternatives.

Expected site: <https://geo-theo.github.io/day02_Lines_30daysofmaps2026/>.
Deployment has not been performed from this workspace.

