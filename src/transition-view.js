import { mixPosition } from './transition-data.js';

const ns = 'http://www.w3.org/2000/svg';
const element = (name, attributes = {}, text) => {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
const pathData = points => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const fade = (t, start, end) => {
  const x = Math.max(0, Math.min(1, (t - start) / (end - start)));
  return x * x * (3 - 2 * x);
};

// Screen coordinates are cached until the viewport/cameras change. Only SVG
// attributes change per frame; no label placement or DOM rebuilding per frame.
export function createTransitionView(svg, model, geographicScreen, schematicScreen, geographicLabels, schematicLabels) {
  const routes = element('g', { 'data-layer': 'transition-routes' });
  const stops = element('g', { 'data-layer': 'transition-stops' });
  const nodes = element('g', { 'data-layer': 'transition-nodes' });
  const routeViews = model.routes.map(route => {
    const group = element('g', { 'data-route': route.id, 'data-shape-id': route.sourceShapeId,
      'data-direction': route.direction });
    const casing = element('path', { class: 'schematic-casing' });
    const line = element('path', { class: 'route-line', stroke: route.color });
    line.append(element('title', {}, `Route ${route.id} · ${route.direction}`));
    if (route.schematic) group.append(casing);
    group.append(line);
    routes.append(group);
    const from = route.geographic?.map(geographicScreen);
    const to = route.schematic?.map(schematicScreen);
    if (!from || !to) {
      const d = pathData(from || to);
      line.setAttribute('d', d);
      casing.setAttribute('d', d);
    }
    return { group, casing, line, from, to };
  });
  const stopViews = model.stops.map(stop => {
    const circle = element('circle', { r: 1.9, class: 'stop', 'data-stop': stop.id,
      ...(stop.nodeId ? { 'data-node': stop.nodeId } : {}) });
    circle.append(element('title', {}, `${stop.name} (${stop.id})`));
    stops.append(circle);
    return { circle, from: geographicScreen(stop.geographic), to: stop.schematic && schematicScreen(stop.schematic) };
  });
  const sourceStops = new Map(model.stops.map(stop => [stop.id, stop]));
  const nodeViews = model.nodes.map(stop => {
    const source = stop.sourceStopIds.map(id => sourceStops.get(id)).filter(Boolean);
    const points = stop.ports.map(port => schematicScreen(port.position));
    const [x, y] = schematicScreen(stop.position);
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
    const group = element('g', { 'data-node': stop.id, 'data-source-stop-ids': stop.sourceStopIds.join(','),
      'data-routes': stop.routeIds.join(','), class: 'schematic-stop' });
    group.append(element('title', {}, `${stop.name} · Routes ${stop.routeIds.join(', ')}`));
    const shared = stop.routeIds.length > 1;
    const marker = shared
      ? element('rect', { x: minX - 3.5, y: minY - 3.5, width: maxX - minX + 7,
        height: maxY - minY + 7, rx: 3.5, class: 'schematic-node shared-node' })
      : element('circle', { cx: x, cy: y, r: 3.3, class: 'schematic-node' });
    group.append(marker);
    nodes.append(group);
    const from = source.length ? source.map(stop => geographicScreen(stop.geographic))
      .reduce((sum, p) => [sum[0] + p[0] / source.length, sum[1] + p[1] / source.length], [0, 0]) : [x, y];
    return { group, from, to: [x, y] };
  });
  geographicLabels.setAttribute('data-layer', 'transition-geographic-labels');
  schematicLabels.setAttribute('data-layer', 'transition-schematic-labels');
  svg.append(routes, stops, nodes, geographicLabels, schematicLabels);
  return progress => {
    for (const { group, casing, line, from, to } of routeViews) {
      const opacity = from && to ? 1 : from ? 1 - progress : progress;
      group.setAttribute('opacity', opacity);
      group.style.pointerEvents = opacity < 0.05 ? 'none' : '';
      if (from && to) {
        const d = pathData(from.map((point, index) => mixPosition(point, to[index], progress)));
        casing.setAttribute('d', d);
        line.setAttribute('d', d);
      }
      casing.setAttribute('opacity', progress);
      line.style.strokeWidth = from && !to ? '2.6' : String(2.6 + 1.9 * progress);
    }
    for (const { circle, from, to } of stopViews) {
      const [cx, cy] = to ? mixPosition(from, to, progress) : from;
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      const opacity = to ? 1 - fade(progress, 0.65, 1) : 1 - progress;
      circle.setAttribute('opacity', opacity);
      circle.style.pointerEvents = opacity < 0.05 ? 'none' : '';
    }
    const nodeOpacity = fade(progress, 0.65, 1);
    for (const { group, from, to } of nodeViews) {
      const position = mixPosition(from, to, progress);
      group.setAttribute('transform', `translate(${position[0] - to[0]},${position[1] - to[1]})`);
      group.setAttribute('opacity', nodeOpacity);
      group.style.pointerEvents = nodeOpacity < 0.05 ? 'none' : '';
    }
    geographicLabels.setAttribute('opacity', 1 - fade(progress, 0, 0.22));
    schematicLabels.setAttribute('opacity', fade(progress, 0.78, 1));
  };
}
