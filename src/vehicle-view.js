import { mixPosition } from './transition-data.js';
import { vehicleFreshness } from './vehicle-matching.js';
import { stationBounds } from './schematic-view.js';

export function vehicleScreenPosition(vehicle, progress, geographicScreen, schematicScreen, unplacedPosition) {
  const from = geographicScreen(vehicle.geographic);
  const to = vehicle.schematic ? schematicScreen(vehicle.schematic) : unplacedPosition;
  return { position: to ? mixPosition(from, to, progress) : from,
    opacity: to ? 1 : 1 - progress };
}

// Group unknown buses inside the transfer symbol without assigning a route or
// changing their geographic positions. Follow the station when panning/zooming.
export function unplacedVehicleLayout(vehicles, transferStop, schematicScreen) {
  const ids = vehicles.map(v => v.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const bounds = stationBounds(transferStop, schematicScreen);
  const width = Math.max(1, bounds.width - 5), height = Math.max(1, bounds.height - 5);
  const columns = Math.max(1, Math.min(ids.length, Math.ceil(Math.sqrt(ids.length * width / height))));
  const rows = Math.max(1, Math.ceil(ids.length / columns));
  const radius = Math.min(3.5, width / (columns * 2.8), height / (rows * 2.8));
  const positions = new Map(ids.map((id, index) => {
    const row = Math.floor(index / columns), rowCount = Math.min(columns, ids.length - row * columns);
    return [id, [bounds.x + bounds.width / 2 + (index % columns - (rowCount - 1) / 2) * width / columns,
      bounds.y + 2.5 + (row + 0.5) * height / rows]];
  }));
  return { positions, radius, bounds };
}

const ns = 'http://www.w3.org/2000/svg';
const svgElement = (name, attrs = {}, text) => {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
const timeText = seconds => seconds ? new Date(seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'not supplied';
const routeText = vehicle => vehicle.mapRouteId || vehicle.routeShortName || vehicle.routeId
  ? `Route ${vehicle.mapRouteId ?? vehicle.routeShortName ?? vehicle.routeId}` : 'Route unassigned';

export function createVehicleView(svg, config, { onDraw, mappingWarning = '', transferStop }) {
  const layer = svgElement('g', { 'data-vehicle-layer': '', role: 'group', 'aria-label': 'Bus locations' });
  const markers = new Map(), rows = new Map();
  const panel = document.querySelector('#live-panel');
  const summary = document.querySelector('#vehicle-summary');
  const list = document.querySelector('#vehicle-list');
  const status = document.querySelector('#live-status');
  const updated = document.querySelector('#live-updated');
  const note = document.querySelector('#live-note');
  const detail = document.querySelector('#vehicle-detail');
  const heading = document.querySelector('#vehicle-heading');
  const detailFields = document.querySelector('#vehicle-fields');
  let state = { phase: 'loading', vehicles: [] }, selected, source, progress = 0;
  const unplacedVehicles = () => state.vehicles.filter(v => !v.schematic &&
    !vehicleFreshness(v, state.timestamp, Date.now() / 1000, config).hidden);
  const fields = new Map();
  for (const label of ['Vehicle ID', 'Route', 'Direction', 'Destination', 'Trip', 'Position time', 'Speed', 'Bearing']) {
    const term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = label; detailFields.append(term, value); fields.set(label, value);
  }
  function select(id, trigger) {
    selected = id; source = trigger;
    detail.hidden = false;
    refreshPanel(); onDraw(); heading.focus({ preventScroll: true });
  }
  document.querySelector('#vehicle-close').addEventListener('click', () => {
    selected = undefined; detail.hidden = true; onDraw();
    if (source?.isConnected && source.getAttribute('tabindex') !== '-1') source.focus({ preventScroll: true });
    else summary.focus({ preventScroll: true });
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) { event.stopPropagation(); document.querySelector('#vehicle-close').click(); }
  });
  function refreshPanel() {
    const now = Date.now() / 1000;
    const count = state.vehicles.length;
    const fresh = state.vehicles.filter(v => !vehicleFreshness(v, state.timestamp, now, config).stale).length;
    const feedOld = state.timestamp && (now - state.timestamp > config.staleSeconds || state.timestamp > now + 60);
    const isStale = feedOld || (count > 0 && fresh < count);
    panel.dataset.state = state.phase === 'error' ? 'error' : isStale ? 'stale' : state.phase;
    const statusText = `Bus snapshots: ${count}`;
    if (status.textContent !== statusText) status.textContent = statusText;
    updated.textContent = `Feed updated ${timeText(state.timestamp)} | Last received ${timeText(state.receivedAt)} | Refreshes hourly`;
    note.textContent = state.phase === 'error'
      ? `${state.error === 'Failed to fetch' ? 'The request was blocked or the network is unavailable' : state.error}. Retrying automatically. ${count ? `Last known positions remain until ${Math.round(config.hideAfterSeconds / 60)} minutes old.` : 'The route map is still available.'}`
      : mappingWarning;
    note.hidden = !note.textContent;
    summary.textContent = `Vehicle list (${count})`;
    for (const [id, row] of rows) if (!state.vehicles.some(v => v.id === id)) { row.remove(); rows.delete(id); }
    for (const vehicle of state.vehicles) {
      let row = rows.get(vehicle.id);
      if (!row) {
        row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button'; button.addEventListener('click', () => select(vehicle.id, button));
        row.append(button); list.append(row); rows.set(vehicle.id, row);
      }
      const freshness = vehicleFreshness(vehicle, state.timestamp, now, config);
      const button = row.firstChild;
      button.textContent = `${vehicle.label ?? vehicle.id} · ${routeText(vehicle)}${vehicle.direction ? ` · ${vehicle.direction}` : ''}${freshness.stale ? ' · stale' : ''}${progress === 1 && freshness.hidden ? ' · marker expired' : progress === 1 && !vehicle.schematic ? ' · unplaced' : ''}`;
      button.setAttribute('aria-pressed', String(selected === vehicle.id));
    }
    if (selected) {
      const v = state.vehicles.find(v => v.id === selected);
      heading.textContent = `Bus ${v?.label ?? selected}`;
      if (v) {
        const freshness = vehicleFreshness(v, state.timestamp, now, config);
        const values = [v.id, routeText(v), v.direction ?? (v.directionId !== undefined ? `GTFS direction ${v.directionId}` : 'Not supplied'),
          v.headsign || 'Not supplied', v.tripId || 'Not supplied',
          `${timeText(v.timestamp)}${freshness.estimated ? ' · age estimated from feed/receipt' : ''}${freshness.stale ? ' · stale' : ''}`,
          Number.isFinite(v.speed) && v.speed >= 0 ? `${Math.round(v.speed * 3.6)} km/h` : 'Not supplied',
          Number.isFinite(v.bearing) && v.bearing >= 0 && v.bearing <= 360 ? String(Math.round(v.bearing)) : 'Not supplied'];
        [...fields.values()].forEach((field, i) => { field.textContent = values[i]; });
      } else for (const field of fields.values()) field.textContent = 'No longer in the current feed.';
    }
  }
  return {
    setState(next) { state = next; refreshPanel(); onDraw(); },
    tick() { refreshPanel(); onDraw(); },
    draw(nextProgress, geographicScreen, schematicScreen) {
      const changedMode = (progress === 1) !== (nextProgress === 1);
      progress = nextProgress;
      if (changedMode) refreshPanel();
      const layout = unplacedVehicleLayout(unplacedVehicles(), transferStop, schematicScreen);
      const ids = new Set(state.vehicles.map(v => v.id));
      for (const [id, marker] of markers) if (!ids.has(id)) { marker.remove(); markers.delete(id); }
      for (const vehicle of state.vehicles) {
        let marker = markers.get(vehicle.id);
        if (!marker) {
          marker = svgElement('g', { class: 'bus-marker', role: 'button', tabindex: '0', 'data-vehicle-id': vehicle.id });
          marker.append(svgElement('circle', { r: 22, class: 'bus-hit-area' }),
            svgElement('circle', { r: 12, class: 'bus-disc' }),
            svgElement('text', { class: 'bus-number', y: 1, 'aria-hidden': 'true' }),
            svgElement('text', { class: 'bus-direction', y: -16, 'aria-hidden': 'true' }),
            svgElement('title'));
          marker.addEventListener('pointerdown', event => event.stopPropagation());
          marker.addEventListener('dblclick', event => event.stopPropagation());
          marker.addEventListener('click', () => select(vehicle.id, marker));
          marker.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(vehicle.id, marker); }
          });
          markers.set(vehicle.id, marker); layer.append(marker);
        }
        const freshness = vehicleFreshness(vehicle, state.timestamp, Date.now() / 1000, config);
        const unplacedPosition = layout.positions.get(vehicle.id);
        const { position, opacity } = vehicleScreenPosition(vehicle, progress, geographicScreen, schematicScreen, unplacedPosition);
        const hidden = freshness.hidden || opacity < 0.05;
        if (hidden && marker === document.activeElement) summary.focus({ preventScroll: true });
        marker.setAttribute('transform', `translate(${position[0]},${position[1]})`);
        marker.setAttribute('opacity', opacity);
        marker.setAttribute('tabindex', hidden ? '-1' : '0');
        marker.setAttribute('aria-hidden', String(hidden));
        marker.setAttribute('aria-pressed', String(selected === vehicle.id));
        marker.setAttribute('data-placement', progress === 1 ? vehicle.schematic ? 'route' : 'transfer' : 'geographic');
        marker.style.display = hidden ? 'none' : '';
        marker.style.setProperty('--bus-color', vehicle.color);
        marker.classList.toggle('bus-stale', freshness.stale);
        marker.classList.toggle('bus-at-transfer', progress === 1 && !vehicle.schematic);
        const compactProgress = vehicle.schematic ? 0 : progress;
        marker.querySelector('.bus-disc').setAttribute('r', 12 + (layout.radius - 12) * compactProgress);
        marker.querySelector('.bus-disc').style.strokeWidth = 3 + (Math.min(1, layout.radius * 0.4) - 3) * compactProgress;
        marker.querySelector('.bus-hit-area').setAttribute('r', 22 + (layout.radius + 1 - 22) * compactProgress);
        const label = `Bus ${vehicle.label ?? vehicle.id}, ${routeText(vehicle)}, ${vehicle.direction ?? 'direction unknown'}${freshness.stale ? ', stale position' : ''}${progress === 1 && !vehicle.schematic ? ', grouped at transfer center: route position unavailable' : ''}. Show details.`;
        marker.setAttribute('aria-label', label);
        marker.querySelector('title').textContent = label;
        marker.querySelector('.bus-number').textContent = vehicle.mapRouteId ?? 'B';
        marker.querySelector('.bus-direction').textContent = vehicle.direction === 'Inbound' ? 'IN' : vehicle.direction === 'Outbound' ? 'OUT' : '';
        marker.querySelector('.bus-number').setAttribute('opacity', 1 - compactProgress);
        marker.querySelector('.bus-direction').setAttribute('opacity', 1 - compactProgress);
      }
      // Keep the persistent, focusable markers above every rebuilt route scene.
      if (svg.lastElementChild !== layer) {
        const focused = layer.contains(document.activeElement) ? document.activeElement : null;
        svg.append(layer);
        focused?.focus({ preventScroll: true });
      }
    },
  };
}
