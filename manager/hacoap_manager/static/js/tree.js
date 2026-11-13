// The Network tab's tree: the border router at the top (or the left, sideways), each router under
// the router it reaches the border router through, and each router's children listed under it,
// the weakest first, with their signal, battery life and soil. No line crosses another. A router's
// children fold away to a count. The heatmap switch tints each card and line by its signal. The
// same nodes, highlight, selection, weak points and traffic as the mesh.

import { h, pct, state, svg } from './core.js';
import { applyFocus, calmMotion, dotGrid, enableZoom, linkKey, linkMargin, linkStrength, marginColor, marginLabel, meshTree, net,
  nodeEvents, nodeLabel, nodeShape, nodeStyle, nodeText, qualityColors, selectNode, shownTopology, signalBars, wayLink, weakness } from './network.js';
import { markWeakPoints } from './netlive.js';
import { drawTrails, signalSpark } from './netplus.js';

const LEVEL = 150;     // down: from a router to the routers under it
const ROUTER_W = 150;  // down: the room a router takes on its own
const GAP = 40;        // between neighbours
const CARD_W = 256, CARD_H = 52, CARD_GAP = 8, INDENT = 22;  // a child's card, and how far right of its rail
const COLUMN = 330;    // sideways: from a router's column to the next
const ROUTER_H = 96;   // sideways: the room a router takes on its own

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

// A link's signal for the tint: its margin, or its link quality as a rough one; null without either.
function tintMargin(link) {
  if (!link) return null;
  const margin = linkMargin(link);
  if (margin !== null) return margin;
  const quality = linkStrength(link).quality;
  return quality === null || quality === undefined ? null : quality * 10 + 5;
}
const tint = (margin, alpha) => (margin === null ? null : `rgb(${marginColor(margin).join(' ')} / ${alpha})`);

// How long a battery lasts, short: "≈ 3 mo", or its power when plugged in
function batteryShort(device) {
  if (!device) return '';
  if (['usb', 'charging', 'charged'].includes(device.power)) return device.power === 'charging' ? 'charging' : 'on USB';
  const days = net.batteryLife.get(device.device_id);
  if (days === null || days === undefined) return device.battery !== null && device.battery !== undefined ? `battery ${pct(device.battery)}` : '';
  return days >= 60 ? `≈ ${Math.round(days / 30)} mo` : `≈ ${Math.round(days)} d`;
}

// Who hangs under whom: routers under the next router towards the border router, children under
// their parent (the weakest first); a folded router's children as one summary card.
function structure(topology, tree) {
  const byName = (a, b) => nodeLabel(a).localeCompare(nodeLabel(b));
  const routersUnder = new Map(), childrenUnder = new Map(), orphans = [];
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
  for (const [id, list] of routersUnder) list.sort(byName);
  for (const [id, list] of childrenUnder) {
    list.sort((a, b) => weakness(tree.linkOf(String(b.id), id)) - weakness(tree.linkOf(String(a.id), id)) || byName(a, b));
  }
  const kidsOf = (id) => {
    const kids = childrenUnder.get(id) || [];
    if (!kids.length || !net.treeFolded.has(id)) return kids.map((node) => ({ node, id: String(node.id), link: tree.linkOf(String(node.id), id) }));
    const boards = kids.filter((n) => n.device_id).length;
    const weak = kids.filter((n) => { const l = tree.linkOf(String(n.id), id); return l && linkStrength(l).quality !== null && linkStrength(l).quality <= 1; }).length;
    return [{ summary: true, id: `fold-${id}`, routerId: id, count: kids.length, boards, weak }];
  };
  return { routersUnder, childrenUnder, orphans: orphans.sort(byName), kidsOf };
}

// Down: the border router at the top
function layoutDown(tree, s, roots) {
  const widths = new Map();
  const width = (id) => {
    if (!widths.has(id)) {
      const items = (s.routersUnder.get(id) || []).map((n) => width(String(n.id)));
      if (s.childrenUnder.has(id)) items.unshift(CARD_W + INDENT);
      widths.set(id, Math.max(ROUTER_W, items.reduce((a, b) => a + b, 0) + GAP * Math.max(0, items.length - 1)));
    }
    return widths.get(id);
  };
  const routerSpots = [], cards = [], lines = [];
  const place = (node, x0, y) => {
    const id = String(node.id);
    const w = width(id);
    const x = x0 + w / 2;
    routerSpots.push({ node, id, x, y });
    const subs = s.routersUnder.get(id) || [];
    const kids = s.kidsOf(id);
    const items = [...(kids.length ? [{ w: CARD_W + INDENT }] : []), ...subs.map((sub) => ({ sub, w: width(String(sub.id)) }))];
    const total = items.reduce((a, item) => a + item.w, 0) + GAP * Math.max(0, items.length - 1);
    let at = x0 + (w - total) / 2;
    for (const item of items) {
      if (item.sub) {
        const sid = String(item.sub.id), cx = at + item.w / 2;
        lines.push({ a: sid, b: id, link: tree.linkOf(sid, id), kind: 'router', label: [cx + 8, y + LEVEL - 40],
          d: rounded([[x, y], [x, y + LEVEL / 2], [cx, y + LEVEL / 2], [cx, y + LEVEL]]) });
        place(item.sub, at, y + LEVEL);
      } else {
        const railX = at + 10, busY = y + LEVEL / 2, top = y + LEVEL - CARD_H / 2;
        kids.forEach((kid, i) => {
          const cy = top + i * (CARD_H + CARD_GAP);
          lines.push({ a: kid.id, b: id, link: kid.link, kind: kid.summary ? 'fold' : 'child',
            d: rounded([[x, y], [x, busY], [railX, busY], [railX, cy + CARD_H / 2], [at + INDENT, cy + CARD_H / 2]]) });
          cards.push({ ...kid, x: at + INDENT, y: cy });
        });
      }
      at += item.w + GAP;
    }
  };
  let x0 = 0;
  for (const root of roots) {
    place(root, x0, 0);
    x0 += width(String(root.id)) + GAP * 2;
  }
  s.orphans.forEach((node, i) => cards.push({ node, id: String(node.id), x: x0, y: i * (CARD_H + CARD_GAP), link: null }));
  return { routerSpots, cards, lines };
}

// Sideways: the border router at the left, each level a column to the right
function layoutSideways(tree, s, roots) {
  const heights = new Map();
  const kidsHeight = (id) => { const n = s.kidsOf(id).length; return n ? n * (CARD_H + CARD_GAP) - CARD_GAP : 0; };
  const height = (id) => {
    if (!heights.has(id)) {
      const items = [kidsHeight(id), ...(s.routersUnder.get(id) || []).map((n) => height(String(n.id)))].filter(Boolean);
      heights.set(id, Math.max(ROUTER_H, items.reduce((a, b) => a + b, 0) + GAP * Math.max(0, items.length - 1)));
    }
    return heights.get(id);
  };
  const routerSpots = [], cards = [], lines = [];
  const place = (node, x, y0) => {
    const id = String(node.id);
    const hgt = height(id);
    const y = y0 + hgt / 2;
    routerSpots.push({ node, id, x, y });
    const kids = s.kidsOf(id);
    const subs = s.routersUnder.get(id) || [];
    const items = [...(kids.length ? [{ h: kidsHeight(id) }] : []), ...subs.map((sub) => ({ sub, h: height(String(sub.id)) }))];
    const total = items.reduce((a, item) => a + item.h, 0) + GAP * Math.max(0, items.length - 1);
    let at = y0 + (hgt - total) / 2;
    const busX = x + 70, cardX = x + COLUMN - CARD_W / 2 - 10;
    for (const item of items) {
      if (item.sub) {
        const sid = String(item.sub.id), sy = at + item.h / 2;
        lines.push({ a: sid, b: id, link: tree.linkOf(sid, id), kind: 'router', label: [x + COLUMN - 70, sy - 8],
          d: rounded([[x, y], [busX, y], [busX, sy], [x + COLUMN, sy]]) });
        place(item.sub, x + COLUMN, at);
      } else {
        kids.forEach((kid, i) => {
          const cy = at + i * (CARD_H + CARD_GAP);
          lines.push({ a: kid.id, b: id, link: kid.link, kind: kid.summary ? 'fold' : 'child',
            d: rounded([[x, y], [busX, y], [busX, cy + CARD_H / 2], [cardX, cy + CARD_H / 2]]) });
          cards.push({ ...kid, x: cardX, y: cy });
        });
      }
      at += item.h + GAP;
    }
  };
  let y0 = 0;
  for (const root of roots) {
    place(root, 0, y0);
    y0 += height(String(root.id)) + GAP * 2;
  }
  s.orphans.forEach((node, i) => cards.push({ node, id: String(node.id), x: -CARD_W - 60, y: i * (CARD_H + CARD_GAP), link: null }));
  return { routerSpots, cards, lines };
}

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
  const sideways = !!net.treeSideways;
  const s = structure(topology, tree);
  const roots = [tree.center, ...topology.nodes.filter((n) => !n.parent && n !== tree.center && !tree.towards.has(String(n.id)))].filter(Boolean);
  const { routerSpots, cards, lines } = (sideways ? layoutSideways : layoutDown)(tree, s, roots);

  const xs = [...routerSpots.flatMap((p) => [p.x - ROUTER_W / 2, p.x + ROUTER_W / 2]), ...cards.flatMap((c) => [c.x, c.x + CARD_W])];
  const ys = [...routerSpots.flatMap((p) => [p.y - 30, p.y + 40]), ...cards.flatMap((c) => [c.y, c.y + CARD_H])];
  const pad = 50, top = 70;  // and room at the top: the map's toolbar floats there
  const box = [Math.min(...xs) - pad, Math.min(...ys) - pad - top, Math.max(...xs) - Math.min(...xs) + 2 * pad,
    Math.max(...ys) - Math.min(...ys) + 2 * pad + top];
  const tinted = !!net.heatmap;

  const lineEls = lines.map((line) => {
    const strength = line.link ? linkStrength(line.link) : null;
    const color = strength && strength.quality !== null ? qualityColors[strength.quality] : 'var(--t-text-muted)';
    const halo = tinted ? tint(tintMargin(line.link), 0.3) : null;
    return svg('g', { class: `tree-link ${line.kind}`, 'data-key': linkKey(line.a, line.b), 'data-a': line.a, 'data-b': line.b,
      style: `--q: ${color}` },
    halo ? svg('path', { class: 'tree-halo', d: line.d, style: `stroke: ${halo}` }) : null,
    svg('path', { d: line.d }),
    line.label && strength ? svg('text', { class: 'tree-link-label', x: line.label[0], y: line.label[1] },
      marginLabel(line.link) !== null ? `${marginLabel(line.link)} dB` : `${strength.quality} of 3`) : null,
    strength ? svg('title', {}, strength.text) : null);
  });

  const routerEls = routerSpots.map((spot) => {
    const way = wayLink(tree, spot.id);
    const shape = nodeShape(spot.node, 1, way ? linkStrength(way).quality : undefined);
    const kids = s.childrenUnder.get(spot.id) || [];
    const folded = net.treeFolded.has(spot.id);
    const group = svg('g', { class: 'node tree-router', 'data-node': spot.id, transform: `translate(${spot.x},${spot.y})`, tabindex: 0,
      role: 'button', 'aria-label': `${nodeLabel(spot.node)}, ${nodeStyle(spot.node).label}`, onclick: () => selectNode(spot.id, true) },
    svg('circle', { r: shape.r + 6, class: 'select-ring' }), shape.el, nodeText(clip(nodeLabel(spot.node), 22), shape.r + 4, 'router'),
    kids.length ? svg('g', { class: `tree-fold${folded ? ' folded' : ''}`, transform: `translate(${-shape.r - 6},${-shape.r - 6})`, role: 'button',
      tabindex: 0, 'aria-label': folded ? `Show its ${kids.length} children` : `Fold its ${kids.length} children`,
      onclick: (event) => { event.stopPropagation(); toggleFold(spot.id); } },
    svg('circle', { r: 9 }), svg('text', { y: 3.5, 'text-anchor': 'middle' }, folded ? String(kids.length) : '–'),
    svg('title', {}, folded ? `Show its ${kids.length} children` : `Fold its ${kids.length} children`)) : null);
    nodeEvents(group, spot.id);
    return group;
  });

  const cardEls = cards.map((c) => c.summary ? summaryCard(c) : nodeCard(c, tinted));
  const drawing = svg('svg', { viewBox: (net.zoom.tree || box).join(' '), preserveAspectRatio: sideways ? 'xMinYMid meet' : 'xMidYMin meet',
    class: `tree${tinted ? ' tinted' : ''}` },
  ...dotGrid('tree-grid', box), svg('g', { class: 'links' }, lineEls), ...routerEls, ...cardEls);
  container.append(drawing);
  enableZoom(container, drawing, box, 'tree', { maxOut: 1.5 });
  markWeakPoints(drawing, null);
  glide(drawing, routerSpots, cards, sideways);
  applyFocus();
}

function nodeCard(c, tinted) {
  const strength = c.link ? linkStrength(c.link) : null;
  const deviceId = c.node.device_id;
  const device = deviceId ? state.devices.get(deviceId) : null;
  const sub = device ? [batteryShort(device), device.soil_moisture !== null && device.soil_moisture !== undefined ? `soil ${pct(device.soil_moisture)}` : '']
    .filter(Boolean).join(' · ') || 'your board' : deviceId ? 'your board' : nodeStyle(c.node).label.split(' (')[0];
  const wash = tinted ? tint(tintMargin(c.link), 0.2) : null;
  const spark = deviceId ? signalSpark(deviceId, { width: 48, height: 16 }) : null;
  if (spark) { spark.setAttribute('x', CARD_W - 58); spark.setAttribute('y', 30); }
  const group = svg('g', { class: `node tree-card${deviceId ? ' board' : ''}`, 'data-node': c.id, 'data-device': deviceId || null,
    transform: `translate(${c.x},${c.y})`, tabindex: 0, role: 'button', 'aria-label': `${nodeLabel(c.node)}, ${sub}`,
    onclick: () => selectNode(c.id, true) },
  svg('rect', { class: 'select-ring', x: -3, y: -3, width: CARD_W + 6, height: CARD_H + 6, rx: 11 }),
  svg('rect', { class: 'card-bg', width: CARD_W, height: CARD_H, rx: 8, style: wash ? `fill: ${wash}` : null }),
  svg('g', { transform: `translate(${CARD_H / 2},${CARD_H / 2})` }, nodeShape(c.node, deviceId ? 0.66 : 1, strength ? strength.quality : undefined).el),
  svg('text', { class: 'card-name', x: CARD_H + 2, y: 21 }, clip(nodeLabel(c.node), strength ? 13 : 22)),
  svg('text', { class: 'card-sub', x: CARD_H + 2, y: 39 }, clip(sub, spark ? 19 : 30)),
  strength ? signalBars(strength.quality, { x: CARD_W - 58, y: 8, width: 16, height: 13 }) : null,
  strength ? svg('text', { class: 'card-margin', x: CARD_W - 10, y: 20, 'text-anchor': 'end' },
    marginLabel(c.link) !== null ? `${marginLabel(c.link)} dB` : `${strength.quality}/3`) : null,
  spark,
  strength ? svg('title', {}, strength.text) : null);
  nodeEvents(group, c.id);
  return group;
}

// A folded router's children: how many, and how many are weak. A click unfolds them.
function summaryCard(c) {
  return svg('g', { class: 'node tree-card tree-summary', 'data-node': c.id, transform: `translate(${c.x},${c.y})`, tabindex: 0,
    role: 'button', 'aria-label': `${c.count} children folded: show them`, onclick: () => toggleFold(c.routerId) },
  svg('rect', { class: 'card-bg', width: CARD_W, height: CARD_H, rx: 8 }),
  svg('text', { class: 'card-name', x: 16, y: 22 }, `${c.count} ${c.count === 1 ? 'child' : 'children'}${c.boards ? ` · ${c.boards} your board${c.boards === 1 ? '' : 's'}` : ''}`),
  svg('text', { class: `card-sub${c.weak ? ' weak' : ''}`, x: 16, y: 39 }, c.weak ? `${c.weak} with a weak signal · show them` : 'folded · show them'));
}

export function toggleFold(routerId) {
  if (net.treeFolded.has(routerId)) net.treeFolded.delete(routerId); else net.treeFolded.add(routerId);
  try { localStorage.setItem('hacoap-tree-folded', JSON.stringify([...net.treeFolded])); } catch (error) { /* not remembered */ }
  renderTree();
}

// Each node glides from where it was in the drawing before (a board that moved to another router,
// a fold, a re-sort), with a trail for the ones that moved; the lines fade in where they go.
function glide(drawing, routerSpots, cards, sideways) {
  const now = new Map([...routerSpots, ...cards].map((p) => [p.id, { x: p.x, y: p.y }]));
  const before = net.treePositions && net.treePositions.sideways === sideways ? net.treePositions.at : null;
  net.treePositions = { sideways, at: now };
  if (!before || calmMotion()) return;
  const moving = [...now].filter(([id, p]) => before.has(id) && Math.hypot(before.get(id).x - p.x, before.get(id).y - p.y) > 1);
  if (!moving.length) return;
  drawing.querySelector('.links')?.classList.add('fade-in');
  const started = performance.now();
  const groups = new Map(moving.map(([id]) => [id, drawing.querySelector(`[data-node="${CSS.escape(id)}"]`)]));
  const step = (time) => {
    const k = Math.min(1, (time - started) / 600);
    const ease = 1 - (1 - k) ** 3;
    for (const [id, to] of moving) {
      const from = before.get(id);
      groups.get(id)?.setAttribute('transform', `translate(${from.x + (to.x - from.x) * ease},${from.y + (to.y - from.y) * ease})`);
    }
    if (k < 1 && drawing.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const movedIds = new Set((net.lastMoved || []).map((m) => m.id));
  drawTrails(drawing, moving.filter(([id]) => movedIds.has(id)).map(([id, to]) => ({ id, from: before.get(id), to })));
}

// The tree's controls, once network.js (which imports this module) is ready
export function initTree() {
  net.treeFolded = new Set();
  try {
    net.treeFolded = new Set(JSON.parse(localStorage.getItem('hacoap-tree-folded') || '[]'));
    net.treeSideways = localStorage.getItem('hacoap-tree-sideways') === '1';
  } catch (error) { /* the defaults */ }
  const toggle = document.getElementById('sideways-toggle');
  toggle.checked = !!net.treeSideways;
  toggle.addEventListener('change', () => {
    net.treeSideways = toggle.checked;
    net.zoom.tree = null;  // another shape: start from the whole tree
    try { localStorage.setItem('hacoap-tree-sideways', net.treeSideways ? '1' : '0'); } catch (error) { /* not remembered */ }
    renderTree();
  });
}
