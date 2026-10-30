// The Network tab's tree: the border router at the top, each router under the router it reaches
// the border router through, and each router's children listed under it with their signal. No
// line crosses another. The same nodes, highlight and selection as the mesh.

import { h, svg } from './core.js';
import { applyFocus, dotGrid, enableZoom, linkKey, linkStrength, meshTree, net, nodeEvents, nodeLabel, nodeShape, nodeStyle,
  nodeText, qualityColors, selectNode, shownTopology, signalBars, wayLink, weakness } from './network.js';

const LEVEL = 150;     // from a router down to the routers under it
const ROUTER_W = 150;  // the room a router takes on its own
const GAP = 40;        // between neighbours
const CARD_W = 210, CARD_H = 44, CARD_GAP = 8, INDENT = 22;  // a child's card, and how far right of its rail

// An orthogonal line through the points, its corners rounded.
function rounded(points, r = 9) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const into = Math.hypot(x - px, y - py), out = Math.hypot(nx - x, ny - y);
    const k = Math.min(r, into / 2, out / 2);
    if (!into || !out || k < 0.5) { d += ` L${x},${y}`; continue; }
    d += ` L${x - ((x - px) / into) * k},${y - ((y - py) / into) * k} Q${x},${y} ${x + ((nx - x) / out) * k},${y + ((ny - y) / out) * k}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${lx},${ly}`;
}

const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function renderTree() {
  const container = document.getElementById('tree-view');
  if (net.view !== 'tree') return;
  container.querySelector(':scope > svg')?.remove();  // the tree itself (the zoom buttons have icons)
  container.querySelector('.map-empty')?.remove();
  const topology = shownTopology();
  if (!topology) {
    container.append(h('div', { class: 'map-empty' }, svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-list-tree' })),
      h('p', {}, 'No tree yet: read the network first.')));
    return;
  }
  const tree = meshTree(topology);
  const byName = (a, b) => nodeLabel(a).localeCompare(nodeLabel(b));
  // Who hangs under whom: routers under the next router towards the border router, children under their parent
  const routersUnder = new Map(), childrenUnder = new Map();
  const orphans = [];
  for (const node of topology.nodes) {
    const id = String(node.id);
    const up = tree.towards.get(id);
    if (!up) {
      if (node.parent) orphans.push(node);
      continue;
    }
    const under = node.parent ? childrenUnder : routersUnder;
    if (!under.has(up)) under.set(up, []);
    under.get(up).push(node);
  }
  const widths = new Map();
  const width = (id) => {
    if (!widths.has(id)) {
      const items = (routersUnder.get(id) || []).map((n) => width(String(n.id)));
      if (childrenUnder.has(id)) items.unshift(CARD_W + INDENT);
      widths.set(id, Math.max(ROUTER_W, items.reduce((a, b) => a + b, 0) + GAP * Math.max(0, items.length - 1)));
    }
    return widths.get(id);
  };

  const routerSpots = [], cards = [], lines = [];
  // A stack of child cards hanging from (x, y), its rail at railX
  const stack = (kids, parentId, x, y, left, top) => {
    const railX = left + 10;
    const busY = y + LEVEL / 2;  // where the router's lines branch out, as for the routers under it
    kids.forEach((kid, i) => {
      const id = String(kid.id);
      const cy = top + i * (CARD_H + CARD_GAP);
      const link = tree.linkOf(id, parentId);
      lines.push({ a: id, b: parentId, link, kind: 'child',
        d: rounded([[x, y], [x, busY], [railX, busY], [railX, cy + CARD_H / 2], [left + INDENT, cy + CARD_H / 2]]) });
      cards.push({ node: kid, id, x: left + INDENT, y: cy, link });
    });
  };
  const place = (node, x0, y) => {
    const id = String(node.id);
    const w = width(id);
    const x = x0 + w / 2;
    routerSpots.push({ node, id, x, y });
    const subs = (routersUnder.get(id) || []).sort(byName);
    const kids = (childrenUnder.get(id) || []).sort((a, b) =>
      weakness(tree.linkOf(String(b.id), id)) - weakness(tree.linkOf(String(a.id), id)) || byName(a, b));  // the weakest first
    const items = [...(kids.length ? [{ w: CARD_W + INDENT }] : []), ...subs.map((sub) => ({ sub, w: width(String(sub.id)) }))];
    const total = items.reduce((a, item) => a + item.w, 0) + GAP * Math.max(0, items.length - 1);
    let at = x0 + (w - total) / 2;
    for (const item of items) {
      if (item.sub) {
        const sid = String(item.sub.id), cx = at + item.w / 2;
        lines.push({ a: sid, b: id, link: tree.linkOf(sid, id), kind: 'router', label: [cx, y + LEVEL - 40],
          d: rounded([[x, y], [x, y + LEVEL / 2], [cx, y + LEVEL / 2], [cx, y + LEVEL]]) });
        place(item.sub, at, y + LEVEL);
      } else {
        stack(kids, id, x, y, at, y + LEVEL - CARD_H / 2);
      }
      at += item.w + GAP;
    }
  };
  // The border router's tree, then any router not linked to it, then any child whose parent isn't known
  const roots = [tree.center, ...topology.nodes.filter((n) => !n.parent && n !== tree.center && !tree.towards.has(String(n.id)))].filter(Boolean);
  let x0 = 0;
  for (const root of roots) {
    place(root, x0, 0);
    x0 += width(String(root.id)) + GAP * 2;
  }
  orphans.sort(byName).forEach((node, i) => cards.push({ node, id: String(node.id), x: x0, y: i * (CARD_H + CARD_GAP), link: null }));

  const xs = [...routerSpots.map((s) => s.x - ROUTER_W / 2), ...cards.map((c) => c.x), ...routerSpots.map((s) => s.x + ROUTER_W / 2), ...cards.map((c) => c.x + CARD_W)];
  const ys = [...routerSpots.map((s) => s.y), ...cards.map((c) => c.y + CARD_H)];
  const pad = 50;
  const box = [Math.min(...xs) - pad, Math.min(...ys) - 40 - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad,
    Math.max(...ys) - Math.min(...ys) + 80 + 2 * pad];

  const lineEls = lines.map((line) => {
    const strength = line.link ? linkStrength(line.link) : null;
    const color = strength && strength.quality !== null ? qualityColors[strength.quality] : 'var(--t-text-muted)';
    return svg('g', { class: `tree-link ${line.kind}`, 'data-key': linkKey(line.a, line.b), 'data-a': line.a, 'data-b': line.b,
      style: `--q: ${color}` },
    svg('path', { d: line.d }),
    line.label && strength ? svg('text', { class: 'tree-link-label', x: line.label[0] + 8, y: line.label[1] },
      line.link.link_margin !== null && line.link.link_margin !== undefined ? `${line.link.link_margin} dB` : `${strength.quality} of 3`) : null,
    strength ? svg('title', {}, strength.text) : null);
  });
  const routerEls = routerSpots.map((spot) => {
    const way = wayLink(tree, spot.id);
    const shape = nodeShape(spot.node, 1, way ? linkStrength(way).quality : undefined);
    const group = svg('g', { class: 'node tree-router', 'data-node': spot.id, transform: `translate(${spot.x},${spot.y})`, tabindex: 0,
      role: 'button', 'aria-label': `${nodeLabel(spot.node)}, ${nodeStyle(spot.node).label}`, onclick: () => selectNode(spot.id, true) },
    svg('circle', { r: shape.r + 6, class: 'select-ring' }), shape.el, nodeText(clip(nodeLabel(spot.node), 22), shape.r + 4, 'router'));
    nodeEvents(group, spot.id);
    return group;
  });
  const cardEls = cards.map((c) => {
    const strength = c.link ? linkStrength(c.link) : null;
    const device = c.node.device_id;
    const sub = device ? 'your board' : nodeStyle(c.node).label.split(' (')[0];
    const group = svg('g', { class: `node tree-card${device ? ' board' : ''}`, 'data-node': c.id, 'data-device': device || null,
      transform: `translate(${c.x},${c.y})`, tabindex: 0, role: 'button', 'aria-label': `${nodeLabel(c.node)}, ${sub}`,
      onclick: () => selectNode(c.id, true) },
    svg('rect', { class: 'select-ring', x: -3, y: -3, width: CARD_W + 6, height: CARD_H + 6, rx: 11 }),
    svg('rect', { class: 'card-bg', width: CARD_W, height: CARD_H, rx: 8 }),
    svg('g', { transform: `translate(${CARD_H / 2},${CARD_H / 2})` }, nodeShape(c.node, device ? 0.62 : 1, strength ? strength.quality : undefined).el),
    svg('text', { class: 'card-name', x: CARD_H + 2, y: 19 }, clip(nodeLabel(c.node), strength ? 15 : 20)),
    svg('text', { class: 'card-sub', x: CARD_H + 2, y: 34 }, sub),
    strength ? signalBars(strength.quality, { x: CARD_W - 34, y: 9, width: 22, height: 15 }) : null,
    strength ? svg('text', { class: 'card-margin', x: CARD_W - 10, y: 36, 'text-anchor': 'end' },
      c.link.link_margin !== null && c.link.link_margin !== undefined ? `${c.link.link_margin} dB` : `${strength.quality}/3`) : null,
    strength ? svg('title', {}, strength.text) : null);
    nodeEvents(group, c.id);
    return group;
  });
  const drawing = svg('svg', { viewBox: (net.zoom.tree || box).join(' '), preserveAspectRatio: 'xMidYMin meet', class: 'tree' },
    ...dotGrid('tree-grid', box), svg('g', { class: 'links' }, lineEls), ...routerEls, ...cardEls);
  container.append(drawing);
  enableZoom(container, drawing, box, 'tree', { maxOut: 1.5 });
  applyFocus();
}
