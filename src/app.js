import { prepareMap } from './map-data.js';
import { prepareSchematic } from './schematic-data.js';
import { drawSchematic } from './schematic-view.js';
import { prepareTransition } from './transition-data.js';
import { createTransition } from './transition.js';
import { createTransitionView } from './transition-view.js';
import { LIVE_CONFIG } from './live-config.js';
import { createLiveFeed } from './live-feed.js';
import { createVehicleMatcher } from './vehicle-matching.js';
import { createVehicleView } from './vehicle-view.js';

const svg = document.querySelector('#map');
const status = document.querySelector('#status');
const controls = [...document.querySelectorAll('[data-view]')];
const viewStatus = document.querySelector('#view-status');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const ns = 'http://www.w3.org/2000/svg';
let model;
let schematic;
let correspondence;
let view = location.hash === '#schematic' ? 'schematic' : 'geographic';
let progress = view === 'schematic' ? 1 : 0;
const cameras = {};
let transitionView;
let sceneDirty = true;
let renderedView;
let frame;
let vehicleView;
const transition = createTransition({ initial: progress, onUpdate(value) {
  progress = value;
  draw();
  if (!transition.active) {
    viewStatus.textContent = `${view === 'schematic' ? 'Schematic' : 'Geographic'} view. ${
      view === 'schematic' ? '12 outbound routes and 82 stations.' : '24 route shapes and 334 stops.'}`;
  }
} });

function element(name, attributes = {}, text) {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function updateDescription() {
  const isSchematic = view === 'schematic';
  document.querySelector('#map-title').textContent = `Missoula transit ${isSchematic ? 'schematic' : 'geographic'} map`;
  document.querySelector('#map-description').textContent = isSchematic
    ? 'Twelve outbound routes with selected stops. Buses without a reliable route position are grouped as small circles in the Mountain Line Transfer Center box. Shared station symbols join parallel lanes; unmarked crossings are not transfers. Drag to pan; plus and minus zoom; Home fits all routes.'
    : 'Both directions of all twelve transit routes and all 334 stops, projected in EPSG:6514 on white. Drag to pan; plus and minus zoom; Home fits all routes.';
}

function initialCamera(mode) {
  // A phone opens on the central network; pan to explore, Home to fit it all.
  return { zoom: mode === 'schematic' && svg.clientWidth < 540 ? 2.2 : 1, x: 0, y: 0 };
}

function changeView(next) {
  if (!model || !['geographic', 'schematic'].includes(next) || next === view) return;
  view = next;
  updateControls();
  updateDescription();
  viewStatus.textContent = `Changing to ${view} view.`;
  transition.setTarget(view === 'schematic' ? 1 : 0, { immediate: reducedMotion.matches });
}

function updateControls() {
  for (const input of controls) input.checked = input.dataset.view === view;
}

for (const input of controls) {
  input.addEventListener('change', () => {
    if (location.hash !== `#${input.dataset.view}`) location.hash = input.dataset.view;
    changeView(input.dataset.view);
  });
}
updateControls();
reducedMotion.addEventListener('change', event => {
  if (event.matches && transition.active) transition.finish();
});

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Sample by distance along the path, not vertex index (GTFS vertex density varies).
function samplesAlong(points, count) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  }
  const total = lengths.at(-1);
  if (!total) return [points[0]];
  let segment = 1;
  return Array.from({ length: count }, (_, index) => {
    const target = total * (index + 1) / (count + 1);
    while (segment < points.length - 1 && lengths[segment] < target) segment++;
    const ratio = (target - lengths[segment - 1]) / (lengths[segment] - lengths[segment - 1]);
    return points[segment - 1].map((value, axis) =>
      value + ratio * (points[segment][axis] - value));
  });
}

function drawLabels(group, routes, stops, width, height) {
  const occupied = [];
  const routeSamples = routes.map(route => ({
    id: route.id,
    points: route.shapes.flatMap(shape => samplesAlong(shape, 90)),
  }));
  for (const route of routes) {
    const otherPoints = routeSamples.filter(other => other.id !== route.id).flatMap(other => other.points);
    let best;
    let bestScore = -Infinity;
    for (const shape of route.shapes) {
      for (const anchor of samplesAlong(shape, 22)) {
        const separation = Math.min(...otherPoints.map(point => distance(anchor, point)));
        for (const [dx, dy] of [[0, -12], [12, 0], [0, 12], [-12, 0]]) {
          const point = [anchor[0] + dx, anchor[1] + dy];
          const halfWidth = route.id.length * 4 + 5;
          if (point[0] < halfWidth + 8 || point[0] > width - halfWidth - 8 ||
              point[1] < 15 || point[1] > height - 15) continue;
          if (occupied.some(box => Math.abs(point[0] - box.x) < halfWidth + box.halfWidth + 8 &&
              Math.abs(point[1] - box.y) < 25)) continue;
          const stopClearance = Math.min(...stops.map(stop => distance(point, stop)));
          const lineClearance = Math.min(...otherPoints.map(other => distance(point, other)));
          const score = Math.min(separation, 60) + Math.min(stopClearance, 20) + Math.min(lineClearance, 25);
          if (score > bestScore) {
            bestScore = score;
            best = { point, halfWidth };
          }
        }
      }
    }
    if (!best) continue;
    occupied.push({ x: best.point[0], y: best.point[1], halfWidth: best.halfWidth });
    group.append(element('text', { x: best.point[0], y: best.point[1],
      fill: route.color, class: 'route-label' }, route.id));
  }
}

function screenFor(mode, { width, height }) {
  const camera = cameras[mode];
  const [minX, minY, maxX, maxY] = (mode === 'schematic' ? schematic : model).bounds;
  const margin = Math.min(width, height) < 500 ? 28 : 44;
  const top = 64; // Keep fitted routes clear of the view control.
  const scale = Math.min(Math.max(1, width - 2 * margin) / Math.max(1, maxX - minX),
    Math.max(1, height - top - 2 * margin) / Math.max(1, maxY - minY)) * camera.zoom;
  return ([x, y]) => [
    width / 2 + camera.x + (x - (minX + maxX) / 2) * scale,
    top + (height - top) / 2 + camera.y + (y - (minY + maxY) / 2) * scale * (mode === 'schematic' ? 1 : -1),
  ];
}

function geographicLabelLayer(screen, { width, height }) {
  const routes = model.routes.map(route => ({ ...route,
    shapes: route.shapes.map(shape => shape.coordinates.map(screen)) }));
  const stopPoints = model.stops.map(stop => screen(stop.geometry.coordinates));
  const labels = element('g', { 'data-layer': 'labels', 'aria-hidden': 'true' });
  drawLabels(labels, routes, stopPoints, width, height);
  return labels;
}

function drawGeographic(screen, viewport) {
  const routeLayer = element('g', { 'data-layer': 'routes' });
  const stopLayer = element('g', { 'data-layer': 'stops' });
  model.routes.forEach(route => {
    const routeGroup = element('g', { 'data-route': route.id, stroke: route.color });
    route.shapes.forEach(source => {
      const points = source.coordinates.map(screen);
      const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      const path = element('path', { d, class: 'route-line', 'data-shape-id': source.sourceShapeId,
        'data-direction': source.direction });
      path.append(element('title', {}, `Route ${route.id} · ${source.direction}`));
      routeGroup.append(path);
    });
    routeLayer.append(routeGroup);
  });

  model.stops.forEach(stop => {
    const [cx, cy] = screen(stop.geometry.coordinates);
    const circle = element('circle', { cx, cy, r: 1.9, class: 'stop', 'data-stop': stop.properties.stop_id });
    circle.append(element('title', {}, `${stop.properties.stop_name} (${stop.properties.stop_code || stop.properties.stop_id})`));
    stopLayer.append(circle);
  });
  svg.append(routeLayer, stopLayer, geographicLabelLayer(screen, viewport));
}

function draw() {
  if (!model) return;
  const { width, height } = svg.getBoundingClientRect();
  if (!width || !height) return;
  const viewport = { width, height };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.dataset.progress = String(progress);
  const endpoint = progress === 0 ? 'geographic' : progress === 1 ? 'schematic' : null;
  svg.dataset.view = endpoint || 'transition';
  if (endpoint) {
    if (sceneDirty || renderedView !== endpoint) {
      svg.querySelectorAll('[data-layer]').forEach(layer => layer.remove());
      const screen = screenFor(endpoint, viewport);
      if (endpoint === 'schematic') drawSchematic(svg, schematic, screen, viewport);
      else drawGeographic(screen, viewport);
      transitionView = undefined;
      renderedView = endpoint;
    }
  } else {
    if (sceneDirty || !transitionView) {
      svg.querySelectorAll('[data-layer]').forEach(layer => layer.remove());
      const geographicScreen = screenFor('geographic', viewport);
      const schematicScreen = screenFor('schematic', viewport);
      const labels = element('g', { 'aria-hidden': 'true' });
      const diagram = element('g');
      drawSchematic(diagram, schematic, schematicScreen, viewport);
      labels.append(...diagram.querySelectorAll('[data-layer="labels"], [data-layer="badges"]'));
      transitionView = createTransitionView(svg, correspondence, geographicScreen, schematicScreen,
        geographicLabelLayer(geographicScreen, viewport), labels);
    }
    transitionView(progress);
    renderedView = 'transition';
  }
  sceneDirty = false;
  vehicleView?.draw(progress, screenFor('geographic', viewport), screenFor('schematic', viewport));
}

function scheduleDraw() {
  sceneDirty = true;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
}

function fit() {
  for (const mode of activeCameras()) cameras[mode] = { zoom: 1, x: 0, y: 0 };
  scheduleDraw();
}

// Gestures during a morph transform both ends together, preserving continuity.
function activeCameras() {
  return transition.active ? ['geographic', 'schematic'] : [view];
}

function pan(dx, dy) {
  for (const mode of activeCameras()) {
    cameras[mode].x += dx;
    cameras[mode].y += dy;
  }
  scheduleDraw();
}

function zoom(factor, x, y) {
  const bounds = svg.getBoundingClientRect();
  for (const mode of activeCameras()) {
    const camera = cameras[mode];
    const next = Math.max(0.5, Math.min(16, camera.zoom * factor));
    const ratio = next / camera.zoom;
    camera.x = x - bounds.width / 2 - (x - bounds.width / 2 - camera.x) * ratio;
    const centerY = (bounds.height + 64) / 2;
    camera.y = y - centerY - (y - centerY - camera.y) * ratio;
    camera.zoom = next;
  }
  scheduleDraw();
}

svg.addEventListener('wheel', event => {
  if (!model) return;
  event.preventDefault();
  const bounds = svg.getBoundingClientRect();
  zoom(Math.exp(-Math.sign(event.deltaY) * 0.15), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });

let drag;
svg.addEventListener('pointerdown', event => {
  if (!model || event.button !== 0 || !event.isPrimary) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  svg.setPointerCapture(event.pointerId);
  svg.classList.add('dragging');
});
svg.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  pan(event.clientX - drag.x, event.clientY - drag.y);
  drag.x = event.clientX;
  drag.y = event.clientY;
});
function endDrag() { drag = undefined; svg.classList.remove('dragging'); }
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('lostpointercapture', endDrag);
svg.addEventListener('dblclick', () => { if (model) fit(); });
svg.addEventListener('keydown', event => {
  if (!model) return;
  const { width, height } = svg.getBoundingClientRect();
  if (event.key === 'Home' || event.key === '0') fit();
  else if (event.key === '+' || event.key === '=') zoom(1.4, width / 2, height / 2);
  else if (event.key === '-') zoom(1 / 1.4, width / 2, height / 2);
  else if (event.key.startsWith('Arrow')) {
    pan(event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0,
      event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0);
  } else return;
  event.preventDefault();
});

window.addEventListener('hashchange', () => changeView(location.hash === '#schematic' ? 'schematic' : 'geographic'));
// Preserve the user's mode and zoom on responsive layout changes.
new ResizeObserver(scheduleDraw).observe(svg);

try {
  const [lines, stops] = await Promise.all([
    load('../data/lines_6514.geojson'), load('../data/stops_6514.geojson'),
  ]);
  model = prepareMap(lines, stops);
  schematic = prepareSchematic(lines, stops);
  correspondence = prepareTransition(model, schematic);
  cameras.geographic = initialCamera('geographic');
  cameras.schematic = initialCamera('schematic');
  // A hash may have changed while the local files were loading.
  view = location.hash === '#schematic' ? 'schematic' : 'geographic';
  progress = view === 'schematic' ? 1 : 0;
  for (const input of controls) input.disabled = false;
  updateControls();
  updateDescription();
  status.hidden = true;
  transition.setTarget(progress, { immediate: true });
  // Feed/mapping failures must never prevent the static map from opening.
  startLiveVehicles().catch(error => {
    console.warn('Live vehicles could not initialize:', error);
    document.querySelector('#live-note').textContent = 'The route map is still available. Reload to retry live tracking.';
    document.querySelector('#live-note').hidden = false;
    document.querySelector('#live-panel').dataset.state = 'error';
  });
} catch (error) {
  console.error(error);
  status.textContent = 'Could not load the map. Serve this folder over HTTP (npm start), then reload.';
  status.hidden = false;
}

async function startLiveVehicles() {
  let mapping, mappingWarning = '';
  try {
    const response = await fetch(new URL(LIVE_CONFIG.mappingUrl, document.baseURI));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mapping = await response.json();
    if (!Array.isArray(mapping.patterns) || !mapping.routes || !mapping.trips) throw new Error('Invalid static trip mapping');
  } catch {
    mapping = undefined;
    mappingWarning = 'Static trip mapping unavailable; route matching is disabled.';
  }
  const match = createVehicleMatcher(model, schematic, mapping, LIVE_CONFIG);
  const previous = new Map();
  const redraw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
  vehicleView = createVehicleView(svg, LIVE_CONFIG, {
    onDraw: redraw, mappingWarning, transferStop: schematic.stopById.get('transfer'),
  });
  let url;
  try {
    url = new URL(new URLSearchParams(location.search).get('feed') || LIVE_CONFIG.feedUrl, document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) feed URL');
  } catch (error) {
    vehicleView.setState({ phase: 'error', error: error.message, vehicles: [] });
    return;
  }
  const feed = createLiveFeed({ url, config: LIVE_CONFIG, onChange(state) {
    const vehicles = state.vehicles.map(vehicle => match(vehicle, previous.get(vehicle.id)));
    previous.clear();
    for (const vehicle of vehicles) previous.set(vehicle.id, vehicle);
    vehicleView.setState({ ...state, vehicles });
  } });
  feed.start();
  const ageTimer = setInterval(() => vehicleView.tick(), 5000);
  window.addEventListener('pagehide', () => { feed.stop(); clearInterval(ageTimer); }, { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}
