// The Network tab's mesh: layout, drawing, zoom, details, history, heatmap, pulses.

import { ago, api, busy, h, notify, pct, photoUrl, state, svg, when } from './core.js';
import { currentRoute } from './tabs.js';
import { daysText } from './dashboard.js';
import { deviceName, devicePath, pingDevice } from './devices.js';
import { renderChannelScan, renderFloorplan } from './floorplan.js';

// ------------------------------------------------------------------ network

export const net = { state: null, positions: new Map(), dragged: new Set(), selected: null, layout: null, zoom: {}, viewing: null,
  history: [], heatmap: false, allNames: false, showLinks: true, view: 'mesh' };
// The reading on screen: the latest, or an earlier one picked on the history slider.
export const shownTopology = () => (net.viewing ? net.viewing.topology : net.state && net.state.topology);
export const nodeStyles = {
  'border router': { r: 20, color: 'var(--t-brand)', label: 'Border router', icon: 'router' },
  router: { r: 16, color: 'var(--t-blue)', label: 'Router', icon: 'radio-tower' },
  'FTD child': { r: 9, color: 'var(--t-magenta)', label: 'FTD child (can become a router)' },
  MED: { r: 8, color: 'var(--t-orange)', label: 'MED (end device, always listening)' },
  SED: { r: 8, color: 'var(--t-cyan)', label: 'SED (sleepy end device)' },
};
export const qualityColors = { 3: 'var(--t-green)', 2: 'var(--t-yellow)', 1: 'var(--t-red)', 0: 'var(--t-red)' };
export const calmMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function nodeStyle(node) {
  if (node.border_router) return nodeStyles['border router'];
  return nodeStyles[node.kind] || nodeStyles[node.role === 'child' ? 'SED' : 'router'];
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

// The node's drawing, centred on 0,0: { r (its radius, for what goes under it), el }.
export function nodeShape(node, scale = 1) {
  const style = nodeStyle(node);
  if (node.device_id) {
    const r = AVATAR_R * scale;
    return { r: r + 5, el: boardAvatar(node, r) };
  }
  const r = style.r * scale;
  if (node.border_router) {
    return { r, el: svg('g', { class: 'shape-br' }, svg('circle', { r: r * 1.9, class: 'br-glow' }),
      svg('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: r * 0.4 }), iconUse(style.icon, r * 1.15)) };
  }
  if (style.icon) {
    return { r, el: svg('g', { class: 'shape-router' }, svg('circle', { r }), iconUse(style.icon, r * 1.1)) };
  }
  return { r, el: svg('circle', { r, class: 'shape-child', style: `fill: ${style.color}` }) };
}

export function nodeLabel(node) {
  if (node.name) return node.name;
  if (node.border_router) return 'Border router';
  if (node.hostname && node.kind === 'router') return node.hostname;
  return `${node.kind || node.role || 'node'} ${node.rloc16_hex}`.trim();
}

// A name in a small rounded chip, centred under (or beside) its node.
export function nameChip(text, y, kind = '') {
  const w = text.length * 6.7 + 14;
  return svg('g', { class: `chip ${kind}`, transform: `translate(0,${y})` },
    svg('rect', { x: -w / 2, y: 0, width: w, height: 18, rx: 9 }),
    svg('text', { x: 0, y: 12.5, 'text-anchor': 'middle' }, text));
}

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

// A gentle curve from a to b.
export function linkPath(a, b, bend = 0.1) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return `M${a.x},${a.y} Q${(a.x + b.x) / 2 - dy * bend},${(a.y + b.y) / 2 + dx * bend} ${b.x},${b.y}`;
}

// The layout: the border router in the middle, the routers on rings by how many hops they
// are from it, and each router's children fanned out away from the middle. Distance follows
// signal strength: a child sits closer to its parent the stronger its link, and a router sits
// inside its ring with a strong link towards the border router, outside it with a weak one.
// The rings are ellipses as wide as the map is ('aspect': its width over its height), so it
// fills the view. Nodes you dragged stay where you put them until the next Read the network.
export const RING_GAP = 210;

// How weak a link is, from 0 (strong) to 1 (weak); 0.5 without signal information.
export function weakness(link) {
  if (!link) return 0.5;
  if (link.link_margin !== null && link.link_margin !== undefined) return Math.max(0, Math.min(1, (35 - link.link_margin) / 30));
  const quality = linkStrength(link).quality;
  return quality === null ? 0.5 : { 3: 0.1, 2: 0.45, 1: 0.8, 0: 1 }[quality];
}

export function layoutNetwork(topology, aspect = 1.8) {
  const sx = Math.sqrt(Math.max(0.5, Math.min(3, aspect))), sy = 1 / sx;
  const nodes = topology.nodes.map((node) => ({ node, x: 0, y: 0 }));
  const between = new Map();
  for (const link of topology.links) {
    between.set(`${link.a} ${link.b}`, link);
    between.set(`${link.b} ${link.a}`, link);
  }
  const linkOf = (a, b) => between.get(`${a} ${b}`);
  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const center = nodes.find((n) => n.node.border_router) || nodes.find((n) => !n.node.parent) || nodes[0];
  const routers = nodes.filter((n) => !n.node.parent);
  // Hops from the border router over router-to-router links, and the way back to it
  const neighbours = new Map(routers.map((n) => [n.node.id, []]));
  for (const link of topology.links.filter((l) => l.kind === 'mesh')) {
    if (neighbours.has(link.a) && neighbours.has(link.b)) {
      neighbours.get(link.a).push(link.b);
      neighbours.get(link.b).push(link.a);
    }
  }
  const hops = new Map(center ? [[center.node.id, 0]] : []);
  const towards = new Map();
  const queue = center ? [center.node.id] : [];
  while (queue.length) {
    const id = queue.shift();
    for (const next of neighbours.get(id) || []) {
      if (!hops.has(next)) { hops.set(next, hops.get(id) + 1); towards.set(next, id); queue.push(next); }
    }
  }
  const deepest = Math.max(1, ...hops.values());
  const rings = new Map();
  for (const n of routers) {
    if (n === center) continue;
    const ring = hops.get(n.node.id) || deepest + 1;
    if (!rings.has(ring)) rings.set(ring, []);
    rings.get(ring).push(n);
  }
  const radii = [];
  let radius = 0;
  for (const ring of [...rings.keys()].sort((a, b) => a - b)) {
    const members = rings.get(ring).sort((a, b) => (a.node.rloc16 || 0) - (b.node.rloc16 || 0));
    radius = Math.max(radius + RING_GAP, (members.length * 170) / (2 * Math.PI));
    radii.push({ ring, rx: radius * sx, ry: radius * sy });
    members.forEach((n, i) => {
      const angle = (ring % 2 ? -Math.PI / 2 : 0) + (i / members.length) * 2 * Math.PI;
      // Inside the ring with a strong link to the router before it (towards the border router), outside with a weak one
      const r = radius * (0.8 + 0.4 * weakness(linkOf(n.node.id, towards.get(n.node.id))));
      n.x = Math.cos(angle) * r * sx; n.y = Math.sin(angle) * r * sy;
    });
  }
  // Children: around the border router on a small ring, else fanned out away from the middle
  const children = new Map();
  for (const n of nodes.filter((n) => n.node.parent)) {
    if (!children.has(n.node.parent)) children.set(n.node.parent, []);
    children.get(n.node.parent).push(n);
  }
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId);
    kids.sort((a, b) => nodeLabel(a.node).localeCompare(nodeLabel(b.node)));
    if (!parent || parent === center) {
      kids.forEach((n, i) => {
        const angle = -Math.PI / 2 + ((i + 0.5) / kids.length) * 2 * Math.PI;
        const r = parent ? 85 + 130 * weakness(linkOf(n.node.id, parentId)) : radius + RING_GAP;
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
      const r = 75 + 150 * weakness(linkOf(n.node.id, parentId));  // strong: close to its parent
      n.x = parent.x + Math.cos(angle) * r; n.y = parent.y + Math.sin(angle) * r;
    });
  }
  for (const n of nodes) {
    const moved = net.dragged.has(n.node.id) && net.positions.get(n.node.id);
    if (moved) { n.x = moved.x; n.y = moved.y; }
    net.positions.set(n.node.id, { x: n.x, y: n.y });
  }
  // Links, drawn from a child towards its parent (the flow runs that way)
  const springs = topology.links.map((link) => {
    let a = byId.get(link.a), b = byId.get(link.b);
    if (link.kind === 'child' && b && b.node.parent === a.node.id) [a, b] = [b, a];
    return { a, b, link, ...linkStrength(link) };
  }).filter((s) => s.a && s.b);
  return { nodes, springs, byId, radii, center, towards };
}

// The way from a node to the border router: the nodes and links on it.
export function pathToBorderRouter(layout, n) {
  const ids = new Set([n.node.id]);
  let at = n.node.parent || n.node.id;
  ids.add(at);
  while (layout.towards.has(at)) { at = layout.towards.get(at); ids.add(at); }
  const links = layout.springs.filter((s) => ids.has(s.a.node.id) && ids.has(s.b.node.id) &&
    (s.link.kind === 'child' ? s.a === n || s.b === n : true));
  return { ids, links };
}

export function placeNode(n) {
  n.group.setAttribute('transform', `translate(${n.x},${n.y})`);
}

export function placeLinks(springs) {
  for (const s of springs) {
    const d = linkPath(s.a, s.b, s.link.kind === 'mesh' ? 0.06 : 0.12);
    s.path.setAttribute('d', d);
    s.hit.setAttribute('d', d);
  }
}

export function renderNetwork() {
  const canvas = document.getElementById('network-canvas');
  const topology = shownTopology();
  document.getElementById('network-empty').classList.toggle('d-none', !!topology);
  const before = net.layout ? new Map(net.layout.nodes.map((n) => [n.node.id, { x: n.x, y: n.y }])) : new Map();
  canvas.querySelector('svg')?.remove();
  canvas.querySelector('.map-tip')?.remove();
  document.getElementById('network-warnings').replaceChildren(...((topology && topology.warnings) || []).map((w) =>
    h('div', { class: 'alert alert-warning py-1 small mb-2' }, w)));
  if (!topology) return;

  const aspect = canvas.clientWidth && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1.8;
  const layout = net.layout = layoutNetwork(topology, aspect);
  const xs = layout.nodes.map((n) => n.x), ys = layout.nodes.map((n) => n.y);
  const pad = 90;
  const box = [Math.min(...xs, -140) - pad, Math.min(...ys, -140) - pad,
    Math.max(...xs, 140) - Math.min(...xs, -140) + 2 * pad, Math.max(...ys, 140) - Math.min(...ys, -140) + 2 * pad];
  layout.box = box;

  // Rings for the hops, behind everything
  const rings = layout.radii.map(({ ring, rx, ry }) => svg('g', { class: 'hop-ring' },
    svg('ellipse', { rx, ry }),
    svg('text', { x: rx * 0.72 + 6, y: -ry * 0.72 - 6 }, `${ring} hop${ring > 1 ? 's' : ''}`)));  // on the ring, up right
  const links = layout.springs.map((s) => {
    const color = s.quality === null ? 'var(--t-text-muted)' : qualityColors[s.quality];
    s.path = svg('path', { class: `link ${s.link.kind}`, style: `stroke: ${color}`, 'stroke-width': s.width });
    s.hit = svg('path', { class: 'link-hit', onclick: () => showLinkDetails(s) }, svg('title', {}, s.text));
    return svg('g', { class: 'link-group' }, s.path, s.hit);
  });
  const groups = layout.nodes.map((n) => {
    const shape = nodeShape(n.node);
    const group = svg('g', { class: `node${net.selected === n.node.id ? ' selected' : ''}${n.node.device_id ? ' board' : ''}`,
      'data-device': n.node.device_id || null, 'data-node': n.node.id },
      svg('circle', { r: shape.r + 6, class: 'select-ring' }), shape.el,
      shownName(n.node) ? nameChip(nodeLabel(n.node), shape.r + 6, n.node.device_id ? 'board' : '') : null);
    n.group = group;
    makeDraggable(group, n);
    group.addEventListener('pointerenter', () => traceNode(n, true));
    group.addEventListener('pointerleave', () => traceNode(n, false));
    return group;
  });
  const drawing = svg('svg', { viewBox: (net.zoom.mesh || box).join(' '), preserveAspectRatio: 'xMidYMid meet',
    class: `mesh${net.showLinks ? '' : ' no-links'}` },
    net.heatmap ? meshHeatmap() : null, ...rings, svg('g', { class: 'links' }, links), ...groups);
  canvas.append(drawing);
  if (canvas.clientWidth && canvas.clientWidth < 768) {  // a phone: as tall as the drawing needs, no letterbox
    drawing.style.height = `${Math.max(280, Math.min(window.innerHeight * 0.75, canvas.clientWidth * box[3] / box[2]))}px`;
  }
  enableZoom(canvas, drawing, box, 'mesh');

  // Glide from where the nodes were (after a new reading), else just place them
  const moving = layout.nodes.filter((n) => before.has(n.node.id) &&
    Math.hypot(before.get(n.node.id).x - n.x, before.get(n.node.id).y - n.y) > 1);
  if (moving.length && !calmMotion()) {
    const target = new Map(layout.nodes.map((n) => [n, { x: n.x, y: n.y }]));
    const started = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - started) / 600);
      const ease = 1 - (1 - k) ** 3;
      for (const n of layout.nodes) {
        const from = before.get(n.node.id) || target.get(n);
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

  const counts = { routers: 0, children: 0, sleepy: 0, boards: 0 };
  for (const n of topology.nodes) {
    if (n.kind === 'router' || n.border_router) counts.routers++; else counts.children++;
    if (n.kind === 'SED') counts.sleepy++;
    if (n.device_id) counts.boards++;
  }
  document.getElementById('network-summary').textContent = (net.viewing ? 'Earlier reading: ' : '') +
    `${counts.routers} router(s), ${counts.children} child(ren) (${counts.sleepy} sleepy), ${counts.boards} of your boards. ` +
    `Read ${ago(topology.fetched)} (${topology.source === 'api' ? 'with signal strength' : 'link quality only'}).`;
}

// Pointing at a node: its way to the border router lights up, the rest dims, and a small card
// says what it is.
export function traceNode(n, on) {
  const drawing = n.group.ownerSVGElement;
  const canvas = document.getElementById('network-canvas');
  canvas.querySelector('.map-tip')?.remove();
  drawing.classList.toggle('tracing', on);
  for (const el of drawing.querySelectorAll('.on-path')) el.classList.remove('on-path');
  if (!on || n.dragging) return;
  const { ids, links } = pathToBorderRouter(net.layout, n);
  for (const m of net.layout.nodes) if (ids.has(m.node.id)) m.group.classList.add('on-path');
  for (const s of links) s.path.parentNode.classList.add('on-path');
  const device = n.node.device_id ? state.devices.get(n.node.device_id) : null;
  const toParent = net.layout.springs.find((s) => s.a === n && s.link.kind === 'child');
  const hops = Math.max(0, ids.size - 1);
  const lines = device
    ? [device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? device.plant : null,
      `soil ${pct(device.soil_moisture)} · battery ${pct(device.battery)}${device.online ? '' : ' · offline'}`]
    : [nodeStyle(n.node).label];
  if (toParent) lines.push(`to its parent: ${toParent.text}`);
  if (!n.node.border_router) lines.push(`${hops} hop${hops === 1 ? '' : 's'} from the border router`);
  const point = drawing.createSVGPoint();
  point.x = n.x; point.y = n.y;
  const screen = point.matrixTransform(drawing.getScreenCTM());
  const frame = canvas.getBoundingClientRect();
  canvas.append(h('div', { class: 'map-tip', style: `left: ${screen.x - frame.left}px; top: ${screen.y - frame.top}px` },
    h('b', {}, nodeLabel(n.node)), ...lines.filter(Boolean).map((line) => h('div', {}, line))));
}

// The scroll wheel (or a trackpad pinch) zooms around the pointer, dragging the background
// pans, and a double click or "fit" shows the whole map again (smoothly). Each view ('mesh',
// 'floorplan') keeps its zoom across redraws; maxIn and maxOut are how far in and out it can go
// (maxOut 1: the whole map, no more).
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
    if (!moved) traceNode(n, false);
    const point = group.ownerSVGElement.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const p = point.matrixTransform(group.ownerSVGElement.getScreenCTM().inverse());
    n.x = p.x; n.y = p.y; moved = true;
    placeNode(n);
    placeLinks(net.layout.springs.filter((s) => s.a === n || s.b === n));
    net.positions.set(n.node.id, { x: n.x, y: n.y });
    net.dragged.add(n.node.id);
  });
  group.addEventListener('pointerup', () => {
    n.dragging = false;
    if (!moved) showNodeDetails(n.node, true);
    else redrawMeshHeatmap();
  });
}

export function detailsTable(rows) {
  return h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, rows.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => h('tr', {}, h('th', { class: 'fw-normal text-body-secondary' }, k), h('td', { class: 'text-break' }, v)))));
}

// The details slide in over the map (under it on a narrow screen).
export function openDrawer(title) {
  document.getElementById('map-drawer-title').textContent = title;
  document.getElementById('map-drawer').classList.add('open');
}

export function closeDrawer() {
  document.getElementById('map-drawer').classList.remove('open');
  net.selected = null;
  net.selectedNode = null;
  if (net.layout) for (const n of net.layout.nodes) n.group.classList.remove('selected');
}

document.getElementById('map-drawer-close').addEventListener('click', closeDrawer);

export function showNodeDetails(node, reveal = false) {
  net.selected = node.id;
  net.selectedNode = node;
  openDrawer(node.device_id ? 'Board' : nodeStyle(node).label);
  if (net.layout) for (const n of net.layout.nodes) n.group.classList.toggle('selected', n.node.id === node.id);
  const topology = shownTopology();
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const links = topology.links.filter((l) => l.a === node.id || l.b === node.id).map((l) => {
    const other = nodes.get(l.a === node.id ? l.b : l.a);
    return h('li', {}, `${other ? nodeLabel(other) : '?'}: ${linkStrength(l).text}`);
  });
  const device = node.device_id && state.devices.get(node.device_id);
  document.getElementById('network-details').replaceChildren(...[
    device ? boardCard(device) : h('h6', {}, nodeLabel(node)),
    device ? h('div', { class: 'net-section' }, 'On the network') : null,
    detailsTable([
      ['Board', node.device_id && !device ? `${node.name} (${node.device_id})` : ''],
      ['Role', node.border_router ? `border router, ${node.role}` : node.role],
      ['Type', node.kind],
      ['RLOC16', node.rloc16_hex],
      ['Extended address', node.ext_address],
      ['Parent', node.parent && nodes.get(node.parent) ? nodeLabel(nodes.get(node.parent)) : ''],
      ['Child timeout', node.timeout ? `${node.timeout} s` : ''],
      ['Host name', node.hostname],
      ['IPv6', node.ipv6.join(', ')],
    ]),
    links.length ? h('div', { class: 'mt-2' }, h('b', {}, 'Links'), h('ul', { class: 'mb-0 ps-3' }, links)) : null,
  ].filter(Boolean));  // replaceChildren would write out a null
  // On a narrow screen the details sit under the map: bring them up after a click.
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
      ['Kind', spring.link.kind === 'mesh' ? 'router to router' : 'child to parent'],
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
    'Your boards show their plant photo (or the logo), ringed by their soil moisture. Rings mark the hops from the ',
    'border router. The closer a board is to its parent, the stronger its link; a router inside its ring has a strong ',
    'link towards the border router. Lines: thick and green is a strong link, thin and red a weak one; the dashes flow from each child ',
    'to its parent. Your boards never link to each other. Point at a node to see its way to the border router, click ',
    'it for details, drag it to tidy up (Read the network puts it back). Scroll to zoom, drag the background to move around, double-click to fit.');
  document.getElementById('network-legend').replaceChildren(
    pill(mini(nodeShape({ border_router: true }).el), 'border router'),
    pill(mini(nodeShape({ kind: 'router' }).el), 'router'),
    pill(mini(nodeShape({ device_id: '-' }).el), 'your board · ring: soil'),
    pill(h('span', { class: 'legend-strength' }), 'strong → weak'),
    h('button', { class: 'legend-info', type: 'button', title: 'How to read the map', 'aria-label': 'How to read the map',
      onclick: () => help.classList.toggle('d-none') }, svg('svg', { class: 'icon' }, svg('use', { href: '#i-info' }))),
    help);
}

export async function loadNetwork() {
  net.state = await api('GET', '/api/network');
  document.getElementById('border-router-url').value = net.state.border_router_url || '';
  renderNetwork();
  renderNetworkLegend();
  renderFloorplan();
  renderChannelScan(net.state.channel_scan);
  loadNetworkHistory().catch(() => {});
  document.getElementById('network-events').replaceChildren(...(net.state.events.length
    ? net.state.events.map((e) => h('li', { class: 'mb-1' }, h('span', { class: 'text-body-secondary' }, `${when(e.time)} `), e.message))
    : [h('li', { class: 'text-body-secondary' }, 'No changes seen yet. Boards changing parent show here.')]));
}

for (const [id, key] of [['labels-toggle', 'allNames'], ['links-toggle', 'showLinks']]) {
  try {
    const kept = localStorage.getItem(`hacoap-map-${key}`);
    if (kept !== null) net[key] = kept === '1';
  } catch (error) { /* the default */ }
  document.getElementById(id).checked = net[key];
  document.getElementById(id).addEventListener('change', (event) => {
    net[key] = event.target.checked;
    try { localStorage.setItem(`hacoap-map-${key}`, net[key] ? '1' : '0'); } catch (error) { /* not remembered */ }
    renderNetwork();
    renderFloorplan();
  });
}

document.getElementById('network-refresh').addEventListener('click', (event) => busy(event.target, async () => {
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
  renderNetwork();
  renderFloorplan();
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
  renderNetwork();
  renderFloorplan();
});
document.getElementById('history-latest').addEventListener('click', showLatestNetwork);

// ------------------------------------------------------------------ signal heatmap

// The signal over the floor plan or the mesh, estimated from the placed nodes: each one counts
// with the margin of its strongest link, blended by distance (nearer nodes weigh more), and the
// colour fades out within 'reach' of every node. A guide to dead zones, not a measurement.
// area is [x, y, width, height] in map units.
export function heatmapLayer(topology, points, [x0, y0, W, H], reach = Math.max(W, H) * 0.3) {
  const samples = [];
  for (const node of topology.nodes) {
    const p = points.get(node.id);
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
      // Colour in bands of 5 dB (contours), the fade smooth
      pixels.data.set([...marginColor(Math.round(sum / weights / 5) * 5), Math.round(alpha * 110)], (row * cols + col) * 4);
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
  const points = new Map(nodes.map((n) => [n.node.id, { x: n.x, y: n.y, placed: true }]));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const r = MESH_HEAT_REACH;
  const area = [Math.min(...xs, box[0]) - r, Math.min(...ys, box[1]) - r,
    Math.max(...xs, box[0] + box[2]) - Math.min(...xs, box[0]) + 2 * r, Math.max(...ys, box[1] + box[3]) - Math.min(...ys, box[1]) + 2 * r];
  return heatmapLayer(shownTopology(), points, area, r);
}

// After a node is dragged on the mesh, the heatmap follows.
export function redrawMeshHeatmap() {
  const drawing = document.querySelector('#network-canvas svg');
  const old = drawing && drawing.querySelector('.heatmap');
  if (!drawing || !net.heatmap) return;
  const layer = meshHeatmap();
  if (old) old.remove();
  if (layer) drawing.prepend(layer);
}

export function renderHeatmapNote() {
  const shown = net.heatmap && (net.view === 'mesh' ? !!shownTopology() : !!(net.state && net.state.floorplan));
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
  renderNetwork();
  renderFloorplan();
  renderHeatmapNote();
});

// ------------------------------------------------------------------ a board answering, on the map

// A short pulse from the board to its parent each time it answers, so the mesh looks alive.
export const calm = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function pulseBoard(deviceId) {
  if (calm() || currentRoute().split('/')[0] !== 'network') return;
  for (const group of document.querySelectorAll(`#network-canvas g.node[data-device="${CSS.escape(deviceId)}"], #floorplan g.node[data-device="${CSS.escape(deviceId)}"]`)) {
    group.classList.remove('pulse');
    void group.getBBox();  // restarts the animation
    group.classList.add('pulse');
    setTimeout(() => group.classList.remove('pulse'), 1300);
  }
  const n = net.layout && net.layout.nodes.find((x) => x.node.device_id === deviceId);
  const spring = n && net.layout.springs.find((sp) => sp.a === n && sp.link.kind === 'child');
  const drawing = document.querySelector('#network-canvas svg');
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
