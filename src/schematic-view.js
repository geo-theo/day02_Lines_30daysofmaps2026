const ns = 'http://www.w3.org/2000/svg';
const element = (name, attributes = {}, text) => {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
const pathData = points => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const overlaps = (a, b, gap = 4) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

export function stationBounds(stop, screen) {
  const points = stop.ports.map(port => screen(port.position));
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { x: Math.min(...xs) - 3.5, y: Math.min(...ys) - 3.5,
    width: Math.max(...xs) - Math.min(...xs) + 7, height: Math.max(...ys) - Math.min(...ys) + 7 };
}

// Screen-space labels keep their size during zoom; lower-priority names yield
// to hubs, endpoints and shared stops. No two accepted label boxes overlap.
export function placeLabels(candidates, obstacles, width, height) {
  const occupied = [...obstacles];
  const placed = [];
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    for (const box of candidate.boxes) {
      if (box.x < 10 || box.y < 10 || box.x + box.width > width - 10 || box.y + box.height > height - 10) continue;
      if (occupied.some(other => overlaps(box, other))) continue;
      occupied.push(box);
      placed.push({ ...candidate, box });
      break;
    }
  }
  return placed;
}

export function drawSchematic(svg, model, screen, { width, height }) {
  const routes = element('g', { 'data-layer': 'routes' });
  const nodes = element('g', { 'data-layer': 'stops' });
  const labels = element('g', { 'data-layer': 'labels', 'aria-hidden': 'true' });
  const badges = element('g', { 'data-layer': 'badges', 'aria-hidden': 'true' });
  const obstacles = [];
  for (const route of model.routes) {
    const group = element('g', { 'data-route': route.id, 'data-shape-id': route.sourceShapeId,
      'data-direction': route.direction });
    const d = pathData(route.coordinates.map(screen));
    group.append(element('path', { d, class: 'schematic-casing' }));
    const line = element('path', { d, stroke: route.color, class: 'schematic-line' });
    line.append(element('title', {}, `Route ${route.id} · ${route.name} · ${route.direction}`));
    group.append(line);
    routes.append(group);
    const [x, y] = screen(route.badge);
    if (x < 14 || x > width - 14 || y < 14 || y > height - 14) continue;
    const badge = element('g', { transform: `translate(${x},${y})`, 'data-route-badge': route.id });
    badge.append(element('rect', { x: -13, y: -11, width: 26, height: 22, rx: 5, fill: route.color }));
    badge.append(element('text', { class: 'schematic-badge', y: 1 }, route.id));
    badges.append(badge);
    obstacles.push({ x: x - 14, y: y - 12, width: 28, height: 24 });
  }
  const candidates = [];
  const measure = document.createElement('canvas').getContext('2d');
  for (const stop of model.stops) {
    const points = stop.ports.map(port => screen(port.position));
    const [x, y] = screen(stop.position);
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
    if (maxX < -20 || minX > width + 20 || maxY < -20 || minY > height + 20) continue;
    const group = element('g', { 'data-node': stop.id, 'data-source-stop-ids': stop.sourceStopIds.join(','),
      'data-routes': stop.routeIds.join(','), class: 'schematic-stop' });
    group.append(element('title', {}, `${stop.name} · Routes ${stop.routeIds.join(', ')}${stop.sourceStopIds.length > 1 ? ' · Nearby stops combined' : ''}`));
    const shared = stop.routeIds.length > 1;
    if (shared) {
      group.append(element('rect', { ...stationBounds(stop, screen), rx: 3.5, class: 'schematic-node shared-node' }));
    } else {
      group.append(element('circle', { cx: x, cy: y, r: 3.3, class: 'schematic-node' }));
    }
    nodes.append(group);
    obstacles.push({ x: minX - 5, y: minY - 5, width: maxX - minX + 10, height: maxY - minY + 10 });
    const lines = stop.label.lines || [stop.name];
    const major = (stop.label.priority || 0) >= 80;
    measure.font = `${major ? 600 : 400} ${major ? 12.5 : 11.5}px Arial`;
    const textWidth = Math.max(...lines.map(line => measure.measureText(line).width));
    const textHeight = lines.length * 15;
    const phoneHub = width < 540 && stop.id === 'transfer';
    const dx = phoneHub ? -45 : stop.label.dx ?? 14;
    const dy = phoneHub ? -155 : stop.label.dy ?? 4;
    const anchor = stop.label.anchor || 'start';
    const preferredX = x + dx - (anchor === 'end' ? textWidth : anchor === 'middle' ? textWidth / 2 : 0);
    const preferredY = y + dy - 11;
    const boxes = [
      { x: preferredX, y: preferredY, leader: Math.hypot(dx, dy) > 60 },
      { x: maxX + 13, y: y - textHeight / 2 },
      { x: minX - textWidth - 13, y: y - textHeight / 2 },
      { x: x - textWidth / 2, y: minY - textHeight - 12 },
      { x: x - textWidth / 2, y: maxY + 12 },
    ];
    // Hubs and endpoints may use a short leader into nearby whitespace rather
    // than disappearing in the dense center of an overview or mobile map.
    if (major) {
      for (const gap of width < 540 ? [24, 40, 60] : [30, 50, 75, 105, 140]) {
        boxes.push({ x: maxX + gap, y: y - textHeight / 2, leader: true },
          { x: minX - textWidth - gap, y: y - textHeight / 2, leader: true },
          { x: x - textWidth / 2, y: minY - textHeight - gap, leader: true },
          { x: x - textWidth / 2, y: maxY + gap, leader: true },
          { x: maxX + gap, y: minY - textHeight - gap, leader: true },
          { x: minX - textWidth - gap, y: maxY + gap, leader: true });
      }
    }
    candidates.push({ id: stop.id, lines, major,
      point: [x, y], boxes: boxes.map(point => ({ ...point, width: textWidth, height: textHeight })),
      priority: stop.label.priority || (shared ? 60 : 30) });
  }
  for (const label of placeLabels(candidates, obstacles, width, height)) {
    if (label.box.leader) {
      const [x, y] = label.point;
      const endX = Math.max(label.box.x, Math.min(x, label.box.x + label.box.width));
      const endY = Math.max(label.box.y, Math.min(y, label.box.y + label.box.height));
      labels.append(element('path', { d: `M${x},${y} L${endX},${endY}`, class: 'label-leader' }));
    }
    const text = element('text', { x: label.box.x, y: label.box.y + 11,
      class: `station-label${label.major ? ' major-label' : ''}`, 'data-label-node': label.id });
    label.lines.forEach((line, index) => text.append(element('tspan', { x: label.box.x, dy: index ? 15 : 0 }, line)));
    labels.append(text);
  }
  svg.append(routes, nodes, labels, badges);
}
