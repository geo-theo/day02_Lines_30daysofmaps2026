import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitionView } from '../src/transition-view.js';

// The renderer only uses these SVG operations. Inspect its real attributes at
// intermediate and final positions without adding a browser dependency.
class SVGNode {
  constructor(name) { this.name = name; this.attributes = {}; this.children = []; this.style = {}; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
}
const by = (node, key, value) => {
  if (node.attributes[key] === value) return node;
  for (const child of node.children) {
    const found = by(child, key, value);
    if (found) return found;
  }
};

test('SVG morph keeps identities and colors, interpolates positions, and gracefully fades one-sided geometry', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElementNS: (_, name) => new SVGNode(name) };
  try {
    const svg = new SVGNode('svg'), geographicLabels = new SVGNode('g'), schematicLabels = new SVGNode('g');
    const model = {
      routes: [
        { id: '1', sourceShapeId: 'matched', direction: 'Outbound', color: '#0072b2',
          geographic: [[0, 0], [20, 10]], schematic: [[10, 20], [30, 20]] },
        { id: '1', sourceShapeId: 'inbound', direction: 'Inbound', color: '#0072b2',
          geographic: [[1, 2], [10, 15]], schematic: null },
        { id: '2', sourceShapeId: 'new', direction: 'Outbound', color: '#c44428',
          geographic: null, schematic: [[4, 5], [9, 5]] },
      ],
      stops: [
        { id: 'a', name: 'Stop A', nodeId: 'hub', geographic: [0, 0], schematic: [10, 20] },
        { id: 'b', name: 'Stop B', nodeId: 'hub', geographic: [2, 0], schematic: [10, 20] },
        { id: 'omitted', name: 'Minor stop', geographic: [6, 8], schematic: null },
      ],
      nodes: [
        { id: 'hub', name: 'Hub', sourceStopIds: ['a', 'b'], routeIds: ['1', '2'],
          position: [10, 20], ports: [{ position: [9, 20] }, { position: [11, 20] }] },
        { id: 'new-stop', name: 'New station', sourceStopIds: ['missing'], routeIds: ['2'],
          position: [9, 5], ports: [{ position: [9, 5] }] },
      ],
    };
    const draw = createTransitionView(svg, model, p => p, p => p, geographicLabels, schematicLabels);
    const route = by(svg, 'data-shape-id', 'matched');
    const line = by(route, 'class', 'route-line');
    const inbound = by(svg, 'data-shape-id', 'inbound');
    const schematicOnly = by(svg, 'data-shape-id', 'new');
    const sourceStop = by(svg, 'data-stop', 'a');
    const omittedStop = by(svg, 'data-stop', 'omitted');
    const hub = by(by(svg, 'data-layer', 'transition-nodes'), 'data-node', 'hub');
    const newStation = by(svg, 'data-node', 'new-stop');
    for (const t of [0, 0.1, 0.5, 0.9, 1, 0.5, 0]) {
      draw(t);
      assert.equal(line.attributes.stroke, '#0072b2');
      assert.equal(route.attributes['data-shape-id'], 'matched');
      assert.equal(route.attributes.opacity, '1');
      assert.equal(inbound.attributes.opacity, String(1 - t));
      assert.equal(schematicOnly.attributes.opacity, String(t));
      assert.equal(sourceStop.attributes['data-stop'], 'a');
      assert.equal(sourceStop.attributes['data-node'], 'hub');
      assert.equal(Number(sourceStop.attributes.cx), 10 * t);
      assert.equal(Number(sourceStop.attributes.cy), 20 * t);
      assert.equal(omittedStop.attributes.cx, '6');
      assert.equal(omittedStop.attributes.cy, '8');
      assert.equal(omittedStop.attributes.opacity, String(1 - t));
      assert.equal(hub.attributes['data-source-stop-ids'], 'a,b');
      assert.ok(!line.attributes.d.includes('NaN'));
      assert.equal(newStation.attributes.transform, 'translate(0,0)');
    }
    draw(1);
    assert.equal(line.attributes.d, 'M10.00,20.00 L30.00,20.00');
    assert.equal(line.style.strokeWidth, '4.5');
    assert.equal(by(route, 'class', 'schematic-casing').attributes.opacity, '1');
    assert.equal(sourceStop.attributes.opacity, '0');
    assert.equal(hub.attributes.opacity, '1');
    assert.equal(hub.attributes.transform, 'translate(0,0)');
    const marker = by(hub, 'class', 'schematic-node shared-node');
    assert.equal(marker.attributes.x, '5.5');
    assert.equal(marker.attributes.y, '16.5');
    assert.equal(marker.attributes.width, '9');
    assert.equal(marker.attributes.height, '7');
    assert.equal(geographicLabels.attributes.opacity, '0');
    assert.equal(schematicLabels.attributes.opacity, '1');
    draw(0);
    assert.equal(line.attributes.d, 'M0.00,0.00 L20.00,10.00');
    assert.equal(sourceStop.attributes.opacity, '1');
    assert.equal(hub.attributes.opacity, '0');
    assert.equal(geographicLabels.attributes.opacity, '1');
    assert.equal(schematicLabels.attributes.opacity, '0');
    assert.equal(svg.children.length, 5, 'Drawing frames must not add DOM layers');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
