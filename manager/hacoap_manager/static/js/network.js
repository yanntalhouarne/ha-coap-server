// The Network tab's shared parts and its mesh view: what each node looks like (the same in every
// view), how strong each link is, each node's way to the border router, the highlight every view
// and the node list share, the details drawer, loading and history, the heatmap, pulses.

import { ago, api, busy, h, notify, pct, photoUrl, state, svg, when } from './core.js';
import { currentRoute } from './tabs.js';
import { daysText } from './dashboard.js';
import { deviceName, devicePath, pingDevice } from './devices.js';
import { renderChannelScan, renderFloorplan } from './floorplan.js';
import { renderNetFrame, renderNetworkEvents } from './netframe.js';
import { renderTree } from './tree.js';

// ------------------------------------------------------------------ network

// Node IDs are kept as strings everywhere (they're also the elements' data-node).
export const net = { state: null, positions: new Map(), dragged: new Set(), selected: null, hover: null, layout: null, zoom: {},
  viewing: null, history: [], heatmap: false, allNames: false, allLinks: false, view: 'mesh' };
// The reading on screen: the latest, or an earlier one picked on the history slider.
export const shownTopology = () => (net.viewing ? net.viewing.topology : net.state && net.state.topology);
export const nodeStyles = {
  'border router': { r: 22, label: 'Border router', icon: 'router' },
  router: { r: 16, label: 'Router', icon: 'radio-tower' },
  'FTD child': { r: 11, label: 'FTD child (can become a router)', icon: 'radio-tower' },
  MED: { r: 11, label: 'MED (end device, always listening)', icon: 'cpu' },
  SED: { r: 11, label: 'SED (sleepy end device)', icon: 'moon' },
};
export const qualityColors = { 3: 'var(--t-green)', 2: 'var(--t-yellow)', 1: 'var(--t-red)', 0: 'var(--t-red)' };
export const calmMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const LOW_BATTERY = 20;  // %, as the app's alerts (fleet.LOW_BATTERY)

export function nodeStyle(node) {
  if (node.border_router) return nodeStyles['border router'];
  return nodeStyles[node.kind] || nodeStyles[node.parent ? 'SED' : 'router'];
}

export const iconUse = (name, size, attrs = {}) => svg('use', { href: `#i-${name}`, x: -size / 2, y: -size / 2, width: size, height: size, ...attrs });

// A board's avatar: its plant photo (or the logo) in a circle, ringed by a gauge of its soil
// moisture: cyan when fine, amber when it needs water, grey when offline.
export const AVATAR_R = 20;
export let clipIds = 0;

export function boardAvatar(node, r) {
  const device = node.device_id ? state.devices.get(node.device_id) : null;
  const soil = device && device.soil_moisture !== null && device.soil_moisture !== undefined ? device.soil_moisture : null;
  const ring = r + 5;
  const around = 2 * Math.PI * ring;
  const clip = `avatar-clip-${++clipIds}`;
  const state_ = !device ? '' : !device.online ? ' offline' : device.needs_water ? ' dry' : '';
  return svg('g', { class: `avatar${state_}` },
    svg('circle', { r: ring, class: 'gauge-track' }),
    soil !== null ? svg('circle', { r: ring, class: 'gauge', transform: 'rotate(-90)',
      'stroke-dasharray': `${(Math.max(0, Math.min(100, soil)) / 100) * around} ${around}` }) : null,
    svg('clipPath', { id: clip }, svg('circle', { r })),
    svg('circle', { r, class: 'avatar-bg' }),
    device && device.photo
      ? svg('image', { href: photoUrl(device), x: -r, y: -r, width: 2 * r, height: 2 * r, 'clip-path': `url(#${clip})`,
        preserveAspectRatio: 'xMidYMid slice' })
      : svg('use', { href: '#hacoap-glyph', x: -r * 0.72, y: -r * 0.72, width: r * 1.44, height: r * 1.44, class: 'avatar-glyph' }));
}

// The one thing to know about a board at a glance, as a small badge on its circle.
export function nodeBadge(node) {
  const device = node.device_id ? state.devices.get(node.device_id) : null;
  if (!device) return null;
  if (!device.online) return { icon: 'wifi-off', tone: 'bad', text: 'offline' };
  if (device.battery !== null && device.battery !== undefined && device.battery <= LOW_BATTERY) return { icon: 'battery-low', tone: 'warn', text: 'battery low' };
  if (device.needs_water) return { icon: 'droplet', tone: 'warn', text: 'needs water' };
  return null;
}

// The node's drawing, centred on 0,0, the same in every view: a circle with an icon (or a board's
// plant photo), its ring the strength of its way to the border router (a board's: its soil), and
// a badge for what needs attention. quality: of that way's first link (0-3, null unknown).
// Returns { r (its outer radius, for what goes under it), el }.
export function nodeShape(node, scale = 1, quality = undefined) {
  const style = nodeStyle(node);
  const ring = quality === undefined ? '' : ` q${quality === null ? 'n' : quality}`;
  let r, el;
  if (node.device_id) {
    r = AVATAR_R * scale;
    el = boardAvatar(node, r);
    r += 5;
  } else if (node.border_router) {
    r = style.r * scale;
    el = svg('g', { class: 'shape-br' }, svg('circle', { r: r * 1.75, class: 'br-glow' }), svg('circle', { r }), iconUse(style.icon, r * 1.05));
  } else {
    r = style.r * scale;
    el = svg('g', { class: `shape-node ${node.parent ? 'shape-child' : 'shape-router'}${ring}` }, svg('circle', { r }), iconUse(style.icon, r * 1.05));
  }
  const badge = nodeBadge(node);
  if (!badge) return { r, el };
  const b = 7 * Math.max(0.75, scale);
  return { r, el: svg('g', {}, el, svg('g', { class: `node-badge ${badge.tone}`, transform: `translate(${r * 0.72},${r * 0.72})` },
    svg('circle', { r: b }), iconUse(badge.icon, b * 1.25))) };
}

export function nodeLabel(node) {
  if (node.name) return node.name;
  if (node.border_router) return 'Border router';
  if (node.hostname && node.kind === 'router') return node.hostname;
  return `${node.kind || node.role || 'node'} ${node.rloc16_hex}`.trim();
}

// A name in a small rounded chip, centred under (or beside) its node (on the floor plan, over the picture).
export function nameChip(text, y, kind = '') {
  const w = text.length * 6.7 + 14;
  return svg('g', { class: `chip ${kind}`, transform: `translate(0,${y})` },
    svg('rect', { x: -w / 2, y: 0, width: w, height: 18, rx: 9 }),
    svg('text', { x: 0, y: 12.5, 'text-anchor': 'middle' }, text));
}

// A name under its node, outlined in the background's colour so lines don't cross it out.
export const nodeText = (text, y, kind = '') => svg('text', { class: `node-label ${kind}`, x: 0, y: y + 13, 'text-anchor': 'middle' }, text);

export const shownName = (node) => !!node.device_id || node.border_router || node.kind === 'router' || net.allNames;

// How strong a link is: its signal margin (dB) if the border router gives it, else its link
// quality (0-3). Drawn as the line's colour and thickness.
export function linkStrength(link) {
  if (link.link_margin !== null && link.link_margin !== undefined) {
    const margin = link.link_margin;
    const quality = margin > 20 ? 3 : margin > 10 ? 2 : margin > 2 ? 1 : 0;
    const rssi = link.average_rssi !== null && link.average_rssi !== undefined ? `, ${link.average_rssi} dBm` : '';
    return { width: 1.5 + (Math.max(0, Math.min(40, margin)) / 40) * 3.5, quality, text: `${margin} dB margin${rssi}` };
  }
  const values = [link.link_quality_in, link.link_quality_out].filter((v) => v !== null && v !== undefined);
  if (values.length) {
    const quality = Math.min(...values);
    return { width: { 3: 4.5, 2: 3.2, 1: 2.2, 0: 1.5 }[quality], quality, text: `link quality ${quality} of 3` };
  }
  return { width: 2, quality: null, text: 'no signal information' };
}

// Signal bars (one to four), coloured by quality, as phones show them.
export function signalBars(quality, attrs = {}) {
  const lit = quality === null || quality === undefined ? 0 : quality + 1;
  return svg('svg', { class: `bars q${lit ? quality : 'n'}`, viewBox: '0 0 15 12', 'aria-hidden': 'true', ...attrs },
    ...[0, 1, 2, 3].map((i) => svg('rect', { x: i * 4, y: 9 - i * 3, width: 3, height: 3 + i * 3, rx: 0.6, class: i < lit ? 'lit' : null })));
}

// A gentle curve from a to b.
export function linkPath(a, b, bend = 0.1) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return `M${a.x},${a.y} Q${(a.x + b.x) / 2 - dy * bend},${(a.y + b.y) / 2 + dx * bend} ${b.x},${b.y}`;
}

// How weak a link is, from 0 (strong) to 1 (weak); 0.5 without signal information.
export function weakness(link) {
  if (!link) return 0.5;
  if (link.link_margin !== null && link.link_margin !== undefined) return Math.max(0, Math.min(1, (35 - link.link_margin) / 30));
  const quality = linkStrength(link).quality;
  return quality === null ? 0.5 : { 3: 0.1, 2: 0.45, 1: 0.8, 0: 1 }[quality];
}

export const linkKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

// Each node's way to the border router: the hops over router-to-router links (breadth first, so
// the fewest), and the next node on the way ('towards': a child's parent, a router's neighbour
// one hop nearer). The links on these ways are the network's backbone ('primary'); the other
// router-to-router links are spares. Worked out once per reading.
const trees = new WeakMap();

export function meshTree(topology) {
  if (trees.has(topology)) return trees.get(topology);
  const byId = new Map(topology.nodes.map((n) => [String(n.id), n]));
  const between = new Map();
  for (const link of topology.links) {
    between.set(`${link.a} ${link.b}`, link);
    between.set(`${link.b} ${link.a}`, link);
  }
  const linkOf = (a, b) => between.get(`${a} ${b}`);
  const center = topology.nodes.find((n) => n.border_router) || topology.nodes.find((n) => !n.parent) || topology.nodes[0];
  const neighbours = new Map(topology.nodes.filter((n) => !n.parent).map((n) => [String(n.id), []]));
  for (const link of topology.links.filter((l) => l.kind === 'mesh')) {
    const a = String(link.a), b = String(link.b);
    if (neighbours.has(a) && neighbours.has(b)) {
      neighbours.get(a).push(b);
      neighbours.get(b).push(a);
    }
  }
  const hops = new Map(), towards = new Map();
  if (center) {
    hops.set(String(center.id), 0);
    const queue = [String(center.id)];
    while (queue.length) {
      const id = queue.shift();
      for (const next of neighbours.get(id) || []) {
        if (!hops.has(next)) { hops.set(next, hops.get(id) + 1); towards.set(next, id); queue.push(next); }
      }
    }
  }
  for (const n of topology.nodes) {
    const id = String(n.id), parent = n.parent === null || n.parent === undefined ? null : String(n.parent);
    if (!parent || !byId.has(parent)) continue;
    towards.set(id, parent);
    if (hops.has(parent)) hops.set(id, hops.get(parent) + 1);
  }
  const primary = new Set([...towards].map(([a, b]) => linkKey(a, b)));
  const tree = { byId, linkOf, center, hops, towards, primary };
  trees.set(topology, tree);
  return tree;
}

// The link from a node towards the border router (its parent's, or the next router's), if any.
export function wayLink(tree, id) {
  return tree.towards.has(id) ? tree.linkOf(id, tree.towards.get(id)) : null;
}

// The nodes and links on a node's way to the border router.
export function wayToBorderRouter(topology, id) {
  const { towards } = meshTree(topology);
  const ids = new Set([String(id)]), keys = new Set();
  let at = String(id);
  while (towards.has(at) && !ids.has(towards.get(at))) {
    const next = towards.get(at);
    keys.add(linkKey(at, next));
    ids.add(next);
    at = next;
  }
  return { ids, keys };
}

// The layout: the border router in the middle, the routers around it by how many hops they
// are from it, and each router's children fanned out away from the middle. Distance follows
// signal strength: a child sits closer to its parent the stronger its link, and a router sits
// nearer the middle with a strong link towards the border router, farther with a weak one.
// The rings are ellipses as wide as the map is ('aspect': its width over its height), so it
// fills the view. Nodes you dragged stay where you put them until the next Read the network.
export const RING_GAP = 210;

export function layoutNetwork(topology, aspect = 1.8) {
  const sx = Math.sqrt(Math.max(0.5, Math.min(3, aspect))), sy = 1 / sx;
  const tree = meshTree(topology);
  const nodes = topology.nodes.map((node) => ({ node, id: String(node.id), x: 0, y: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const center = tree.center ? byId.get(String(tree.center.id)) : null;
  const routers = nodes.filter((n) => !n.node.parent);
  const deepest = Math.max(1, ...routers.map((n) => tree.hops.get(n.id) || 0));
  const rings = new Map();
  for (const n of routers) {
    if (n === center) continue;
    const ring = tree.hops.get(n.id) || deepest + 1;
    if (!rings.has(ring)) rings.set(ring, []);
    rings.get(ring).push(n);
  }
  let radius = 0;
  for (const ring of [...rings.keys()].sort((a, b) => a - b)) {
    const members = rings.get(ring).sort((a, b) => (a.node.rloc16 || 0) - (b.node.rloc16 || 0));
    radius = Math.max(radius + RING_GAP, (members.length * 170) / (2 * Math.PI));
    members.forEach((n, i) => {
      const angle = (ring % 2 ? -Math.PI / 2 : 0) + (i / members.length) * 2 * Math.PI;
      // Nearer with a strong link to the router before it (towards the border router), farther with a weak one
      const r = radius * (0.8 + 0.4 * weakness(wayLink(tree, n.id)));
      n.x = Math.cos(angle) * r * sx; n.y = Math.sin(angle) * r * sy;
    });
  }
  // Children: around the border router on a small ring, else fanned out away from the middle
  const children = new Map();
  for (const n of nodes.filter((n) => n.node.parent)) {
    const parent = String(n.node.parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    kids.sort((a, b) => nodeLabel(a.node).localeCompare(nodeLabel(b.node)));
    if (!parent || parent === center) {
      kids.forEach((n, i) => {
        const angle = -Math.PI / 2 + ((i + 0.5) / kids.length) * 2 * Math.PI;
        const r = parent ? 85 + 130 * weakness(tree.linkOf(n.id, parentId)) : radius + RING_GAP;
        n.x = Math.cos(angle) * r * (parent ? 1.25 : sx); n.y = Math.sin(angle) * r * (parent ? 0.85 : sy);
      });
      continue;
    }
    const out = Math.atan2(parent.y, parent.x);
    // Far enough apart that avatars don't touch: about 80 units between neighbours
    const r0 = kids.length > 5 ? 120 : 110;
    const spread = Math.min(2.6, (80 / r0) * (kids.length - 1) / (kids.length > 5 ? 2 : 1));
    kids.forEach((n, i) => {
      const angle = kids.length === 1 ? out : out - spread / 2 + (spread * i) / (kids.length - 1);
      const r = 75 + 150 * weakness(tree.linkOf(n.id, parentId));  // strong: close to its parent
      n.x = parent.x + Math.cos(angle) * r; n.y = parent.y + Math.sin(angle) * r;
    });
  }
  for (const n of nodes) {
    const moved = net.dragged.has(n.id) && net.positions.get(n.id);
    if (moved) { n.x = moved.x; n.y = moved.y; }
    net.positions.set(n.id, { x: n.x, y: n.y });
    const way = wayLink(tree, n.id);
    n.quality = way ? linkStrength(way).quality : undefined;
  }
  // Links, drawn from the node farther from the border router towards the nearer one (the flow runs that way)
  const springs = topology.links.map((link) => {
    let a = byId.get(String(link.a)), b = byId.get(String(link.b));
    if (!a || !b) return null;
    if (tree.towards.get(b.id) === a.id) [a, b] = [b, a];
    const key = linkKey(a.id, b.id);
    return { a, b, link, key, primary: tree.primary.has(key), ...linkStrength(link) };
  }).filter(Boolean);
  return { nodes, springs, byId, center };
}

export function placeNode(n) {
  n.group.setAttribute('transform', `translate(${n.x},${n.y})`);
}

export function placeLinks(springs) {
  for (const s of springs) {
    const d = linkPath(s.a, s.b, s.link.kind === 'mesh' ? 0.06 : 0.12);
    s.path.setAttribute('d', d);
    s.hit.setAttribute('d', d);
    if (s.flow) s.flow.setAttribute('d', d);
  }
}

// A faint grid of dots behind a drawing, moving with it as it's panned and zoomed.
export function dotGrid(id, [x, y, w, height]) {
  return [svg('defs', {}, svg('pattern', { id, width: 28, height: 28, patternUnits: 'userSpaceOnUse' },
    svg('circle', { cx: 14, cy: 14, r: 1.15, class: 'grid-dot' }))),
  svg('rect', { x: x - 2 * w, y: y - 2 * height, width: 5 * w, height: 5 * height, fill: `url(#${id})`, class: 'grid' })];
}

// Pointing at, focusing or selecting a node, in any view or the list.
export function nodeEvents(el, id) {
  el.addEventListener('pointerenter', () => hoverNode(id, true));
  el.addEventListener('pointerleave', () => hoverNode(id, false));
  el.addEventListener('focus', () => hoverNode(id, true));
  el.addEventListener('blur', () => hoverNode(id, false));
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(id, true);
    }
  });
}

export function renderNetwork() {
  const canvas = document.getElementById('network-canvas');
  const topology = shownTopology();
  document.getElementById('network-empty').classList.toggle('d-none', !!topology);
  const before = net.layout ? new Map(net.layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }])) : new Map();
  canvas.querySelector(':scope > svg')?.remove();  // the map itself (the empty note and zoom buttons have icons)
  if (!topology || net.view !== 'mesh') return;

  const aspect = canvas.clientWidth && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1.8;
  const layout = net.layout = layoutNetwork(topology, aspect);
  const xs = layout.nodes.map((n) => n.x), ys = layout.nodes.map((n) => n.y);
  const pad = 90;
  const box = [Math.min(...xs, -140) - pad, Math.min(...ys, -140) - pad,
    Math.max(...xs, 140) - Math.min(...xs, -140) + 2 * pad, Math.max(...ys, 140) - Math.min(...ys, -140) + 2 * pad];
  layout.box = box;

  // The backbone (each node's way to the border router) drawn strongly, with a flow towards it;
  // the spare router-to-router links only when asked for, or for the router in focus
  const links = layout.springs.map((s) => {
    const color = s.quality === null ? 'var(--t-text-muted)' : qualityColors[s.quality];
    s.path = svg('path', { class: 'link', style: `stroke: ${color}`, 'stroke-width': s.primary ? s.width : 1.5 });
    s.flow = s.primary ? svg('path', { class: 'link-flow' }) : null;
    s.hit = svg('path', { class: 'link-hit', onclick: () => showLinkDetails(s) }, svg('title', {}, s.text));
    return svg('g', { class: `link-group ${s.primary ? 'primary' : 'spare'} ${s.link.kind}`, 'data-key': s.key,
      'data-a': s.a.id, 'data-b': s.b.id }, s.path, s.flow, s.hit);
  });
  const groups = layout.nodes.map((n) => {
    const shape = nodeShape(n.node, 1, n.quality);
    const group = svg('g', { class: `node${n.node.device_id ? ' board' : ''}`, 'data-device': n.node.device_id || null, 'data-node': n.id,
      tabindex: 0, role: 'button', 'aria-label': `${nodeLabel(n.node)}, ${n.node.device_id ? 'your board' : nodeStyle(n.node).label}` },
      svg('circle', { r: shape.r + 6, class: 'select-ring' }), shape.el,
      shownName(n.node) ? nodeText(nodeLabel(n.node), shape.r + 4, n.node.device_id ? 'board' : '') : null);
    n.group = group;
    makeDraggable(group, n);
    nodeEvents(group, n.id);
    return group;
  });
  const drawing = svg('svg', { viewBox: (net.zoom.mesh || box).join(' '), preserveAspectRatio: 'xMidYMid meet',
    class: `mesh${net.allLinks ? ' all-links' : ''}` },
    ...dotGrid('mesh-grid', box), net.heatmap ? meshHeatmap() : null, svg('g', { class: 'links' }, links), ...groups);
  canvas.append(drawing);
  if (canvas.clientWidth && canvas.clientWidth < 768) {  // a phone: as tall as the drawing needs, no letterbox
    drawing.style.height = `${Math.max(280, Math.min(window.innerHeight * 0.75, canvas.clientWidth * box[3] / box[2]))}px`;
  }
  enableZoom(canvas, drawing, box, 'mesh');

  // Glide from where the nodes were (after a new reading), else just place them
  const moving = layout.nodes.filter((n) => before.has(n.id) &&
    Math.hypot(before.get(n.id).x - n.x, before.get(n.id).y - n.y) > 1);
  if (moving.length && !calmMotion()) {
    const target = new Map(layout.nodes.map((n) => [n, { x: n.x, y: n.y }]));
    const started = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - started) / 600);
      const ease = 1 - (1 - k) ** 3;
      for (const n of layout.nodes) {
        const from = before.get(n.id) || target.get(n);
        const to = target.get(n);
        n.x = from.x + (to.x - from.x) * ease; n.y = from.y + (to.y - from.y) * ease;
        placeNode(n);
      }
      placeLinks(layout.springs);
      if (k < 1 && net.layout === layout) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    layout.nodes.forEach(placeNode);
    placeLinks(layout.springs);
  }
  applyFocus();
}

// Every view, the list and the figures, after a new reading or a change of what's shown.
export function redrawNetwork() {
  renderNetwork();
  renderTree();
  renderFloorplan();
  renderNetFrame();
  renderHeatmapNote();
}

// ------------------------------------------------------------------ the highlight

// The node pointed at (or else the one selected): its way to the border router lit, the rest
// dimmed, and a router's spare links shown. The same in the mesh, the tree, the floor plan and the list.
export function applyFocus() {
  const topology = shownTopology();
  const id = net.hover ?? net.selected;
  const known = topology && id !== null && id !== undefined && meshTree(topology).byId.has(id);
  const way = known ? wayToBorderRouter(topology, id) : null;
  for (const root of document.querySelectorAll('#network-canvas > svg, #tree-view > svg, #floorplan svg.plan')) {
    root.classList.toggle('tracing', !!way);
    for (const el of root.querySelectorAll('[data-node]')) {
      el.classList.toggle('on-path', !!way && way.ids.has(el.dataset.node));
      el.classList.toggle('selected', el.dataset.node === net.selected);
    }
    for (const el of root.querySelectorAll('[data-key]')) {
      el.classList.toggle('on-path', !!way && way.keys.has(el.dataset.key));
      el.classList.toggle('near', !!way && (el.dataset.a === id || el.dataset.b === id));
    }
  }
  for (const row of document.querySelectorAll('#net-list-body [data-node]')) {
    row.classList.toggle('selected', row.dataset.node === net.selected);
    row.classList.toggle('pointed', row.dataset.node === net.hover);
  }
}

// Pointing at a node (in any view or the list): the highlight, and a small card on the map
// saying what it is.
export function hoverNode(id, on) {
  if (!on && net.hover !== id) return;
  net.hover = on ? id : null;
  applyFocus();
  showTip(net.hover);
}

export function showTip(id) {
  const wrap = document.getElementById('map-wrap');
  wrap.querySelector('.map-tip')?.remove();
  const topology = shownTopology();
  if (id === null || !topology) return;
  const tree = meshTree(topology);
  const node = tree.byId.get(id);
  const el = [...wrap.querySelectorAll(`.node[data-node="${CSS.escape(id)}"]`)].find((e) => e.getBoundingClientRect().width > 0);
  if (!node || !el) return;
  const device = node.device_id ? state.devices.get(node.device_id) : null;
  const way = wayLink(tree, id);
  const hops = tree.hops.get(id);
  const badge = nodeBadge(node);
  const lines = device
    ? [device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? device.plant : null,
      `soil ${pct(device.soil_moisture)} · battery ${pct(device.battery)}`, badge ? badge.text : null]
    : [nodeStyle(node).label];
  if (way) lines.push(`to ${node.parent ? 'its parent' : 'the next router'}: ${linkStrength(way).text}`);
  if (!node.border_router && hops !== undefined) lines.push(`${hops} hop${hops === 1 ? '' : 's'} from the border router`);
  const rect = el.getBoundingClientRect(), frame = wrap.getBoundingClientRect();
  wrap.append(h('div', { class: 'map-tip', style: `left: ${rect.left + rect.width / 2 - frame.left}px; top: ${rect.top - frame.top}px` },
    h('b', {}, nodeLabel(node)), ...lines.filter(Boolean).map((line) => h('div', {}, line))));
}

// Selecting a node (a click in any view or the list): its details, and the highlight kept.
export function selectNode(id, reveal = false) {
  const topology = shownTopology();
  const node = topology && meshTree(topology).byId.get(String(id));
  if (node) showNodeDetails(node, reveal);
}

// The scroll wheel (or a trackpad pinch) zooms around the pointer, dragging the background
// pans, and a double click or "fit" shows the whole map again (smoothly). Each view ('mesh',
// 'tree', 'floorplan') keeps its zoom across redraws; maxIn and maxOut are how far in and out it
// can go (maxOut 1: the whole map, no more).
export function enableZoom(canvas, drawing, box, key, { maxIn = 12, maxOut = 2 } = {}) {
  const view = () => { const v = drawing.viewBox.baseVal; return [v.x, v.y, v.width, v.height]; };
  const show = (v) => { net.zoom[key] = v; drawing.setAttribute('viewBox', (v || box).join(' ')); };
  const glide = (target) => {
    const from = view(), to = target || box;
    if (calmMotion()) return show(target);
    const started = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - started) / 280);
      const ease = 1 - (1 - k) ** 3;
      drawing.setAttribute('viewBox', from.map((v, i) => v + (to[i] - v) * ease).join(' '));
      if (k < 1) requestAnimationFrame(step); else show(target);
    };
    requestAnimationFrame(step);
  };
  const isBackground = (target) => !target.closest('.node') && !target.classList.contains('link-hit');
  const toMap = (clientX, clientY) => {
    const p = drawing.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(drawing.getScreenCTM().inverse());
  };
  const zoomed = (factor, at) => {
    const [x, y, w, height] = view();
    const scale = Math.max(box[2] / maxIn, Math.min(box[2] * maxOut, w * factor)) / w;
    return [at.x - (at.x - x) * scale, at.y - (at.y - y) * scale, w * scale, height * scale];
  };
  const center = () => { const [x, y, w, height] = view(); return { x: x + w / 2, y: y + height / 2 }; };

  drawing.addEventListener('wheel', (event) => {
    event.preventDefault();
    show(zoomed(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.002), toMap(event.clientX, event.clientY)));
  }, { passive: false });
  // One pointer on the background pans; two (fingers on a touch screen) pinch to zoom.
  let pan = null, pinch = null;
  const pointers = new Map();
  const spread = () => { const [a, b] = [...pointers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  drawing.addEventListener('pointerdown', (event) => {
    if (!isBackground(event.target)) return;  // nodes drag themselves, links are clicked
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    drawing.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      pan = null;
      pinch = spread().d;
      return;
    }
    pan = { id: event.pointerId, start: toMap(event.clientX, event.clientY) };
    drawing.classList.add('panning');
  });
  drawing.addEventListener('pointermove', (event) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const now = spread();
      if (now.d > 0) show(zoomed(pinch / now.d, toMap(now.x, now.y)));
      pinch = now.d;
      return;
    }
    if (!pan || event.pointerId !== pan.id) return;
    const p = toMap(event.clientX, event.clientY);
    const [x, y, w, height] = view();
    show([x - (p.x - pan.start.x), y - (p.y - pan.start.y), w, height]);  // keeps the grabbed point under the pointer
  });
  const endPan = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    pan = null;
    drawing.classList.remove('panning');
  };
  drawing.addEventListener('pointerup', endPan);
  drawing.addEventListener('pointercancel', endPan);
  drawing.addEventListener('dblclick', (event) => { if (isBackground(event.target)) glide(null); });

  const button = (title, icon, onclick) => h('button', { type: 'button', title, 'aria-label': title, onclick },
    svg('svg', { class: 'icon' }, svg('use', { href: `#i-${icon}` })));
  canvas.querySelector('.zoom-controls')?.remove();
  canvas.append(h('div', { class: 'zoom-controls' },
    button('Zoom in', 'plus', () => glide(zoomed(1 / 1.5, center()))),
    button('Zoom out', 'minus', () => glide(zoomed(1.5, center()))),
    button('Show the whole map', 'maximize', () => glide(null))));
}

export function makeDraggable(group, n) {
  let moved = false, start = null;
  group.addEventListener('pointerdown', (event) => {
    group.setPointerCapture(event.pointerId);
    n.dragging = true;
    moved = false;
    start = { x: event.clientX, y: event.clientY };
  });
  group.addEventListener('pointermove', (event) => {
    if (!n.dragging) return;
    if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;  // a click, so far
    if (!moved) hoverNode(n.id, false);
    const point = group.ownerSVGElement.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const p = point.matrixTransform(group.ownerSVGElement.getScreenCTM().inverse());
    n.x = p.x; n.y = p.y; moved = true;
    placeNode(n);
    placeLinks(net.layout.springs.filter((s) => s.a === n || s.b === n));
    net.positions.set(n.id, { x: n.x, y: n.y });
    net.dragged.add(n.id);
  });
  group.addEventListener('pointerup', () => {
    n.dragging = false;
    if (!moved) selectNode(n.id, true);
    else redrawMeshHeatmap();
  });
}

export function detailsTable(rows) {
  return h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, rows.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => h('tr', {}, h('th', { class: 'fw-normal text-body-secondary' }, k), h('td', { class: 'text-break' }, v)))));
}

// The details slide in over the map (under it on a phone).
export function openDrawer(title) {
  document.getElementById('map-drawer-title').textContent = title;
  document.getElementById('map-drawer').classList.add('open');
}

export function closeDrawer() {
  document.getElementById('map-drawer').classList.remove('open');
  net.selected = null;
  net.selectedNode = null;
  applyFocus();
}

document.getElementById('map-drawer-close').addEventListener('click', closeDrawer);

export function showNodeDetails(node, reveal = false) {
  net.selected = String(node.id);
  net.selectedNode = node;
  openDrawer(node.device_id ? 'Board' : nodeStyle(node).label);
  applyFocus();
  // Its row in the list scrolled into sight, within the list only (the page stays where it is)
  const list = document.getElementById('net-list-body');
  const row = list.querySelector(`[data-node="${CSS.escape(net.selected)}"]`);
  if (row && row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row && row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  const topology = shownTopology();
  const nodes = new Map(topology.nodes.map((n) => [String(n.id), n]));
  const links = topology.links.filter((l) => String(l.a) === net.selected || String(l.b) === net.selected).map((l) => {
    const other = nodes.get(String(String(l.a) === net.selected ? l.b : l.a));
    const strength = linkStrength(l);
    return h('li', {}, signalBars(strength.quality, { class: `bars q${strength.quality ?? 'n'} inline` }),
      ` ${other ? nodeLabel(other) : '?'}: ${strength.text}`);
  });
  const device = node.device_id && state.devices.get(node.device_id);
  const hops = meshTree(topology).hops.get(net.selected);
  document.getElementById('network-details').replaceChildren(...[
    device ? boardCard(device) : h('h6', {}, nodeLabel(node)),
    device ? h('div', { class: 'net-section' }, 'On the network') : null,
    detailsTable([
      ['Board', node.device_id && !device ? `${node.name} (${node.device_id})` : ''],
      ['Role', node.border_router ? `border router, ${node.role}` : node.role],
      ['Type', node.kind],
      ['Hops', node.border_router || hops === undefined ? '' : `${hops} from the border router`],
      ['RLOC16', node.rloc16_hex],
      ['Extended address', node.ext_address],
      ['Parent', node.parent && nodes.get(String(node.parent)) ? nodeLabel(nodes.get(String(node.parent))) : ''],
      ['Child timeout', node.timeout ? `${node.timeout} s` : ''],
      ['Host name', node.hostname],
      ['IPv6', (node.ipv6 || []).join(', ')],
    ]),
    links.length ? h('div', { class: 'mt-2' }, h('b', {}, 'Links'), h('ul', { class: 'list-unstyled net-links mb-0' }, links)) : null,
  ].filter(Boolean));  // replaceChildren would write out a null
  // On a phone the details sit under the map: bring them up after a click.
  const card = document.getElementById('network-details');
  if (reveal && card.getBoundingClientRect().top > window.innerHeight - 80) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// One of your boards in the details: its plant, its last readings, and the way to its page.
export function boardCard(device) {
  const photo = device.photo
    ? h('img', { class: 'net-board-photo', src: photoUrl(device), alt: device.plant ? `The ${device.plant}` : `The plant of ${deviceName(device)}` })
    : h('a', { class: 'net-board-photo empty', href: `#device/${encodeURIComponent(device.device_id)}`, title: 'Add a photo on its page' },
      svg('svg', { viewBox: '0 0 512 512' }, svg('use', { href: '#hacoap-glyph' })), h('span', {}, 'no photo yet'));
  const has = (v) => v !== null && v !== undefined;
  const forecast = h('div', { class: 'net-stat-note' });
  const water = h('div', { class: 'net-stat-note' }, device.needs_water ? h('span', { class: 'badge water-badge' }, 'needs water')
    : device.water_target ? `water under ${device.water_target} %` : '');
  const stat = (label, value, note) => h('div', { class: 'net-stat' },
    h('div', { class: 'net-stat-label' }, label), h('div', { class: 'net-stat-value' }, value), note);
  const card = h('div', { class: 'net-board' }, photo,
    h('div', { class: 'net-board-name' }, deviceName(device)),
    device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase()
      ? h('div', { class: 'net-board-plant' }, device.plant) : null,
    h('div', { class: 'text-body-secondary mb-2' }, h('span', { class: `online-dot ${device.online ? 'on' : 'off'}` }),
      device.online ? 'online' : 'offline', device.last_seen ? ` · read ${ago(device.last_seen)}` : ''),
    h('div', { class: 'net-stats' },
      stat('Battery', pct(device.battery), forecast),
      stat('Soil', pct(device.soil_moisture), water),
      stat('Air humidity', pct(device.air_humidity)),
      stat('Temperature', has(device.temperature) ? `${device.temperature} °C` : '–')),
    device.last_error ? h('div', { class: 'small text-danger mt-2' }, device.last_error) : null,
    h('div', { class: 'd-flex flex-wrap gap-2 mt-2' },
      h('a', { class: 'btn btn-sm btn-primary', href: `#device/${encodeURIComponent(device.device_id)}` }, 'Open its page'),
      device.needs_water ? h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button',
        onclick: (e) => busy(e.target, () => api('POST', devicePath(device, '/pump'), { on: true })) }, 'Run the pump') : null,
      h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => pingDevice(device) }, 'Beep')));
  deviceHealth(device).then((health) => {
    if (has(device.battery)) forecast.textContent = daysText(health.battery_forecast);
    if (!device.needs_water && health.water_forecast) water.textContent = `water ${waterIn(health.water_forecast)}`;
  }, () => {});
  return card;
}

// The forecasts come with a device's details; kept a few minutes, so clicking around the map
// doesn't ask again each time.
export const forecasts = new Map();
export async function deviceHealth(device) {
  const known = forecasts.get(device.device_id);
  if (known && Date.now() - known.at < 5 * 60 * 1000) return known.health;
  const details = await api('GET', `${devicePath(device, '/details')}?days=1`, undefined, { quiet: true });
  forecasts.set(device.device_id, { at: Date.now(), health: details.health });
  return details.health;
}

// When a plant will need water, from its forecast: "now", "in about 2 days".
export function waterIn(forecast) {
  if (!forecast) return '';
  const days = forecast.days;
  if (days === null || days === undefined) return 'not drying';
  if (days === 0) return 'now';
  if (days < 0.5) return 'within hours';
  if (days < 1.5) return 'in about a day';
  return `in about ${Math.round(days)} days`;
}

export function showLinkDetails(spring) {
  net.selectedNode = null;
  openDrawer('Link');
  document.getElementById('network-details').replaceChildren(
    h('h6', {}, `${nodeLabel(spring.a.node)} ↔ ${nodeLabel(spring.b.node)}`),
    detailsTable([
      ['Kind', spring.link.kind === 'mesh' ? `router to router${spring.primary ? '' : ' (a spare: not on a way to the border router)'}` : 'child to parent'],
      ['Link margin', spring.link.link_margin !== null && spring.link.link_margin !== undefined ? `${spring.link.link_margin} dB` : ''],
      ['Average RSSI', spring.link.average_rssi !== null && spring.link.average_rssi !== undefined ? `${spring.link.average_rssi} dBm` : ''],
      ['Last RSSI', spring.link.last_rssi !== null && spring.link.last_rssi !== undefined ? `${spring.link.last_rssi} dBm` : ''],
      ['Link quality in / out', spring.link.link_quality_in !== null && spring.link.link_quality_in !== undefined
        ? `${spring.link.link_quality_in} / ${spring.link.link_quality_out ?? '?'} (of 3)` : ''],
    ]));
}

export function renderNetworkLegend() {
  const pill = (...children) => h('span', { class: 'legend-pill' }, ...children);
  const mini = (shape) => svg('svg', { class: 'legend-node', viewBox: '-28 -28 56 56' }, shape);
  const help = h('div', { class: 'legend-help d-none' },
    'Your boards show their plant photo (or the logo), ringed by their soil moisture; a badge marks one that is offline, ',
    'low on battery or needs water. A router\'s ring is the strength of its way to the border router. Lines: thick and ',
    'green is a strong link, thin and red a weak one; the moving dots flow towards the border router. Only each node\'s ',
    'way to the border router is drawn: a router\'s other links show when you point at it, or with "all links". On the ',
    'mesh, the closer a board is to its parent, the stronger its link. Point at a node to see its way to the border ',
    'router, click it for details; drag it to tidy up (Read the network puts it back). Scroll to zoom, drag the ',
    'background to move around, double-click to fit.');
  document.getElementById('network-legend').replaceChildren(
    pill(mini(nodeShape({ border_router: true }).el), 'border router'),
    pill(mini(nodeShape({ kind: 'router' }, 1, 3).el), 'router'),
    pill(mini(nodeShape({ device_id: '-' }).el), 'your board'),
    pill(mini(nodeShape({ kind: 'SED', parent: '-' }, 1.3, 3).el), 'other device'),
    pill(h('span', { class: 'legend-strength' }), 'strong → weak'),
    h('button', { class: 'legend-info', type: 'button', title: 'How to read the map', 'aria-label': 'How to read the map',
      onclick: () => help.classList.toggle('d-none') }, svg('svg', { class: 'icon' }, svg('use', { href: '#i-info' }))),
    help);
}

export async function loadNetwork() {
  net.state = await api('GET', '/api/network');
  document.getElementById('border-router-url').value = net.state.border_router_url || '';
  redrawNetwork();
  renderNetworkLegend();
  renderChannelScan(net.state.channel_scan);
  loadNetworkHistory().catch(() => {});
  renderNetworkEvents(net.state.events);
}

for (const [id, key] of [['labels-toggle', 'allNames'], ['links-toggle', 'allLinks']]) {
  try {
    const kept = localStorage.getItem(`hacoap-map-${key}`);
    if (kept !== null) net[key] = kept === '1';
  } catch (error) { /* the default */ }
  document.getElementById(id).checked = net[key];
  document.getElementById(id).addEventListener('change', (event) => {
    net[key] = event.target.checked;
    try { localStorage.setItem(`hacoap-map-${key}`, net[key] ? '1' : '0'); } catch (error) { /* not remembered */ }
    redrawNetwork();
  });
}

document.getElementById('network-refresh').addEventListener('click', (event) => busy(event.currentTarget, async () => {
  // Every node goes back where its signal puts it (the floor plan keeps its places), even if
  // the reading fails (such as when the automatic one is running)
  net.dragged.clear();
  try {
    net.state = await api('POST', '/api/network/refresh');
  } finally {
    await loadNetwork();
  }
}));

document.getElementById('border-router-form').addEventListener('submit', (event) => {
  event.preventDefault();
  api('PUT', '/api/settings', { border_router_url: document.getElementById('border-router-url').value.trim() })
    .then(() => notify('Saved', 'success', 2000), () => {});
});

document.getElementById('border-router-find').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/network/find-border-router');
  if (!result.found.length) return notify('No border router with a REST API found on this network.', 'warning');
  document.getElementById('border-router-url').value = result.border_router_url || result.found[0];
  notify(`Found: ${result.found.join(', ')}`, 'success');
}));

// ------------------------------------------------------------------ network history

export async function loadNetworkHistory() {
  net.history = await api('GET', '/api/network/history', undefined, { quiet: true });
  const slider = document.getElementById('history-slider');
  document.getElementById('network-history').classList.toggle('d-none', net.history.length < 2);
  slider.max = Math.max(0, net.history.length - 1);
  const index = net.viewing ? net.history.findIndex((s) => s.id === net.viewing.id) : -1;
  slider.value = index >= 0 ? index : slider.max;
  renderHistoryLabel();
}

export function renderHistoryLabel() {
  const slider = document.getElementById('history-slider');
  const index = Number(slider.value);
  const entry = net.history[index];
  document.getElementById('history-label').textContent = !entry ? '' :
    index === net.history.length - 1 && !net.viewing ? 'latest' : `${when(entry.time)} · ${entry.boards} boards`;
  document.getElementById('history-latest').classList.toggle('d-none', !net.viewing);
}

export function showLatestNetwork() {
  net.viewing = null;
  const slider = document.getElementById('history-slider');
  slider.value = slider.max;
  renderHistoryLabel();
  redrawNetwork();
}

document.getElementById('history-slider').addEventListener('input', renderHistoryLabel);
document.getElementById('history-slider').addEventListener('change', async (event) => {
  const index = Number(event.target.value);
  const entry = net.history[index];
  if (!entry || index === net.history.length - 1) return showLatestNetwork();
  const topology = await api('GET', `/api/network/history/${entry.id}`).catch(() => null);
  if (!topology) return;
  net.viewing = { id: entry.id, time: entry.time, topology };
  renderHistoryLabel();
  redrawNetwork();
});
document.getElementById('history-latest').addEventListener('click', showLatestNetwork);

// ------------------------------------------------------------------ signal heatmap

// The signal over the floor plan or the mesh, estimated from the placed nodes: each one counts
// with the margin of its strongest link, blended by distance (nearer nodes weigh more), and the
// colour fades out within 'reach' of every node. A guide to dead zones, not a measurement.
// area is [x, y, width, height] in map units; bands: colour in steps of 5 dB (contours), else smooth.
export function heatmapLayer(topology, points, [x0, y0, W, H], reach = Math.max(W, H) * 0.3, bands = true) {
  const samples = [];
  for (const node of topology.nodes) {
    const p = points.get(String(node.id));
    if (!p || !p.placed) continue;
    const margins = topology.links.filter((l) => l.a === node.id || l.b === node.id).map((l) => {
      if (l.link_margin !== null && l.link_margin !== undefined) return l.link_margin;
      const quality = Math.min(...[l.link_quality_in, l.link_quality_out].filter((v) => v !== null && v !== undefined));
      return Number.isFinite(quality) ? quality * 10 + 5 : null;  // link quality 0-3 as a rough margin
    }).filter((m) => m !== null);
    if (margins.length) samples.push({ x: p.x, y: p.y, margin: Math.max(...margins) });
  }
  if (samples.length < 2) return null;
  // About 220 cells across: smooth once the browser scales the picture up
  const cell = Math.max(3, Math.round(Math.max(W, H) / 220)), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(cols, rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = x0 + (col + 0.5) * cell, y = y0 + (row + 0.5) * cell;
      let sum = 0, weights = 0, nearest = Infinity;
      for (const s of samples) {
        const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
        nearest = Math.min(nearest, d2);
        const weight = 1 / Math.max(d2, 1);
        sum += weight * s.margin;
        weights += weight;
      }
      const alpha = Math.max(0, 1 - Math.sqrt(nearest) / reach);
      const margin = sum / weights;
      pixels.data.set([...marginColor(bands ? Math.round(margin / 5) * 5 : margin), Math.round(alpha * 110)], (row * cols + col) * 4);
    }
  }
  context.putImageData(pixels, 0, 0);
  return svg('image', { href: canvas.toDataURL(), x: x0, y: y0, width: cols * cell, height: rows * cell, preserveAspectRatio: 'none', class: 'heatmap' });
}

// On the mesh, distance is radio closeness rather than space: the heatmap shows which parts of
// the mesh are weak. It reaches about one link length around each node.
export const MESH_HEAT_REACH = 160;

export function meshHeatmap() {
  const { nodes, box } = net.layout;
  const points = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, placed: true }]));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const r = MESH_HEAT_REACH;
  const area = [Math.min(...xs, box[0]) - r, Math.min(...ys, box[1]) - r,
    Math.max(...xs, box[0] + box[2]) - Math.min(...xs, box[0]) + 2 * r, Math.max(...ys, box[1] + box[3]) - Math.min(...ys, box[1]) + 2 * r];
  return heatmapLayer(shownTopology(), points, area, r);
}

// After a node is dragged on the mesh, the heatmap follows.
export function redrawMeshHeatmap() {
  const drawing = document.querySelector('#network-canvas > svg');
  const old = drawing && drawing.querySelector('.heatmap');
  if (!drawing || !net.heatmap) return;
  const layer = meshHeatmap();
  if (old) old.remove();
  if (layer) drawing.querySelector('.grid').after(layer);
}

export function renderHeatmapNote() {
  const shown = net.heatmap && (net.view === 'mesh' ? !!shownTopology() : net.view === 'floorplan' && !!(net.state && net.state.floorplan));
  document.getElementById('heatmap-note').classList.toggle('d-none', !shown);
  document.getElementById('heat-scale').classList.toggle('d-none', !shown);
}

// Red (5 dB and under) to amber (15 dB) to green (25 dB and over), as for the links' colours.
export function marginColor(margin) {
  const red = [239, 68, 68], amber = [245, 158, 11], green = [34, 197, 94];
  const m = Math.max(5, Math.min(25, margin));
  const [from, to, t] = m <= 15 ? [red, amber, (m - 5) / 10] : [amber, green, (m - 15) / 10];
  return from.map((v, i) => Math.round(v + (to[i] - v) * t));
}

try { net.heatmap = localStorage.getItem('hacoap-heatmap') === '1'; } catch (error) { /* off */ }
document.getElementById('heatmap-toggle').checked = net.heatmap;
document.getElementById('heatmap-toggle').addEventListener('change', (event) => {
  net.heatmap = event.target.checked;
  try { localStorage.setItem('hacoap-heatmap', net.heatmap ? '1' : '0'); } catch (error) { /* not remembered */ }
  redrawNetwork();
});

// ------------------------------------------------------------------ a board answering, on the map

// A short pulse from the board to its parent each time it answers, so the mesh looks alive.
export const calm = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function pulseBoard(deviceId) {
  if (calm() || currentRoute().split('/')[0] !== 'network') return;
  for (const group of document.querySelectorAll(`#map-wrap g.node[data-device="${CSS.escape(deviceId)}"]`)) {
    group.classList.remove('pulse');
    void group.getBBox();  // restarts the animation
    group.classList.add('pulse');
    setTimeout(() => group.classList.remove('pulse'), 1300);
  }
  const n = net.view === 'mesh' && net.layout && net.layout.nodes.find((x) => x.node.device_id === deviceId);
  const spring = n && net.layout.springs.find((sp) => sp.a === n && sp.link.kind === 'child');
  const drawing = document.querySelector('#network-canvas > svg');
  if (!spring || !drawing || !spring.path) return;
  const length = spring.path.getTotalLength();  // the link runs from the board to its parent
  const dot = svg('circle', { r: 5, class: 'pulse-dot' });
  drawing.append(dot);
  const started = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - started) / 900);
    const at = spring.path.getPointAtLength(length * k * (2 - k));
    dot.setAttribute('cx', at.x);
    dot.setAttribute('cy', at.y);
    dot.setAttribute('opacity', 1 - k * 0.6);
    if (k < 1) requestAnimationFrame(step); else dot.remove();
  };
  requestAnimationFrame(step);
}
