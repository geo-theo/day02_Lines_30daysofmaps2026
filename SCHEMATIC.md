# Part 2 — schematic network

Open `/#schematic` on the local server or choose **Schematic** in the view control.
The map remains on white. The
default **Geographic** view retains Part 1's EPSG:6514 projection, both directions
of all 12 routes, and all 334 stops. No source GeoJSON was edited. Part 3 now
animates between these layouts using the correspondence below; see
[README.md](README.md#part-3--transition). No bus feed or live tracking is implemented.

## Drawing and selection

`src/schematic-layout.js` is the hand-maintained layout. Positions are drawing
units, x to the right and y down; they do not come from geographic coordinates.
A route path contains node IDs, explicit bends, and optional node-specific lane
ports (`{ node, at }`). `src/schematic-data.js` compiles this authored grid into a
landscape diagram: y is multiplied by 0.6 and each non-octilinear segment gets a
deterministic axis-aligned/45-degree bevel. The resulting geometry uses only
horizontal, vertical and 45-degree segments. Edit the layout, not the GeoJSON.

All routes use **Outbound**, beginning at stop **497**, Mountain Line Transfer
Center. This makes the source orientation consistent, including routes that
loop before reaching their endpoint. The shape IDs are explicit:

| Route | Outbound source `shape_id` |
| --- | --- |
| 1 | shp-1-51 |
| 2 | shp-2-51 |
| 3 | shp-3-51 |
| 4 | shp-4-52 |
| 5 | shp-5-51 |
| 6 | shp-6-51 |
| 7 | shp-7-51 |
| 9 | shp-9-51 |
| 10 | shp-10-51 |
| 11 | shp-11-52 |
| 12 | shp-12-51 |
| 14 | shp-14-51 |

The diagram selects endpoints, major destinations and corridor stops. **141
source stops become 82 nodes**; **193 intermediate stops are omitted**, not
silently assigned to a distant node. Every combination is an explicit list of
source IDs in the layout. Groups pair nearby stops at the same intersection or
destination (all members are within 175 projected meters of one another).
For example, Southgate Mall combines West **46** and East **71**. Distinct
Westview stops are kept separate. Shared nodes join parallel lanes with a single
station symbol. A crossing without a node does not imply a transfer.

Route descriptions identify the depicted corridors; they are not official
route names. Route colors come from the same `ROUTE_COLORS` table as Part 1.

## Correspondence contract for later parts

`prepareSchematic(lines, stops)` returns these stable relationships:

- `routes[].id`, `sourceShapeId`, and `direction` identify a source shape by its
  properties, never its feature-array index. `sourceGeographicCoordinates` and
  `sourceCoordinates` retain its complete original order in degrees and EPSG:6514
  respectively. `sourceDistances` measures cumulative meters along that shape.
- `routes[].coordinates` and `distances` describe the compiled schematic path
  and cumulative drawing distances. `anchors` pair each selected source stop
  with its exact port on this path, in travel order. An anchor has `nodeId`,
  `sourceStopIds`, the closest `sourceStopId`, `sourceDistance`, `sourceProgress`,
  `schematicDistance`, `schematicProgress`, and `position`. All constituent stop
  matches (segment, fraction, offset in meters) remain in `sourceMatches`.
- `stops[].id` identifies a schematic node; `sourceStopIds` and `sourceStops`
  preserve every constituent source ID, original name, and geographic/projected
  position. `ports` and `routeIds` describe its drawn route connections.
- `stopById` and `sourceStopToNode` provide direct/reverse lookups.
  `omittedSourceStopIds` explicitly lists stops with no displayed node.
- SVG route elements expose `data-route`, `data-shape-id`, and `data-direction`;
  station groups expose `data-node`, `data-source-stop-ids`, and `data-routes`.
  Part 1 paths now also expose their original shape IDs and directions.

**Data limitation:** there are no GTFS `trips` or `stop_times` in this project.
Route membership and ordering for the selected nodes are curated from shape
proximity and checked against the ordered outbound geometry. Each route/node
pair uses the nearest member of its stop group, within 45 projected meters of
the selected shape. All member offsets are retained for inspection. These are
display associations, not an authoritative boarding sequence or timetable.
Later live placement must select the matching shape/direction and handle other
directions and omitted stops deliberately. Do not equate global geographic and
schematic path fractions: the paired anchors provide the local correspondence.

## Interaction and responsive behavior

Use the **Geographic / Schematic** control, or `/#schematic` / `/#geographic`, to
choose a view. The control animates in both directions and supports click, tap,
`Tab` + `Enter` / `Space`, or left/right arrows. Reduced motion selects the
endpoint immediately. Each view retains its
camera. Drag to pan, scroll to zoom, or focus the map and use keyboard arrows
and `+`/`-`. Double-click, `Home` or `0` fits the entire network. A phone
initially opens the schematic at 2.2× for central detail; pan to explore.

Labels remain a fixed screen font size. The placement pass prioritizes the
transfer center, major destinations and endpoints, checks label boxes against
other labels, station markers and route badges, and hides minor names that do
not fit. Major labels can use a leader. Zooming reveals more names. Every stop
has a native hover title, including names hidden by the label placement pass.

`npm test` checks Part 1 plus source identity, local/disjoint stop combinations,
source/diagram anchor ordering, angle constraints, input preservation,
feature-order independence and label collision rules.
