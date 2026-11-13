// The Network tab, more: a wall mode (full screen, the lens changing by itself, a clock), a "what
// if" router to drag where a new one might go, a live message log beside the map, each board's
// signal over the week, boards gliding to their new router when they move, and flying to a node.
// Nothing here asks a board for anything.

import { api, h, state, svg } from './core.js';
import { currentRoute } from './tabs.js';
import { deviceName } from './devices.js';
import { LENSES, calm, linkMargin, meshTree, net, nodeLabel, redrawNetwork, selectNode, shownTopology } from './network.js';
import { weakPoints } from './netlive.js';

const onNetwork = () => currentRoute().split('/')[0] === 'network';

// ------------------------------------------------------------------ the live message log

const log = [];
const LOG_SHOWN = 7;
const ARROWS = { push: '←', read: '↔', command: '→', update: '→', move: '↻', offline: '✕', online: '✓', network: '•' };
const lastUpdateLine = new Map();

export function logLine(kind, text, deviceId = null) {
  log.unshift({ time: new Date(), kind, text, deviceId });
  log.length = Math.min(log.length, 50);
  renderLog();
  if (wall.on && ['move', 'offline', 'online'].includes(kind)) wallBanner(text, kind);
}

// A message the app saw (its traffic events), in words.
export function trafficLine(deviceId, what) {
  const device = state.devices.get(deviceId);
  const name = device ? deviceName(device) : deviceId;
  if (what === 'update') {  // one line per update, not one per chunk
    if (Date.now() - (lastUpdateLine.get(deviceId) || 0) < 60000) return;
    lastUpdateLine.set(deviceId, Date.now());
  }
  const text = { push: `${name} pushed its readings`, read: `the app read ${name}`, command: `the app told ${name}`,
    update: `${name} is being updated` }[what] || `${name}: ${what}`;
  logLine(what, text, deviceId);
}

// A board that came online or went offline (its device events).
export function onlineLine(before, after) {
  if (!before || before.online === after.online) return;
  logLine(after.online ? 'online' : 'offline', `${deviceName(after)} ${after.online ? 'answers again' : 'stopped answering'}`, after.device_id);
}

export function renderLog() {
  const wrap = document.getElementById('map-wrap');
  let box = document.getElementById('net-log');
  if (!net.showLog) { box?.remove(); return; }
  if (!box) {
    box = h('div', { class: 'net-log', id: 'net-log', role: 'log', 'aria-label': 'Messages, live' });
    wrap.append(box);
  }
  const lines = log.slice(0, wall.on ? 12 : LOG_SHOWN);
  box.replaceChildren(h('div', { class: 'net-log-head' }, svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-terminal' })), 'live'),
    ...(lines.length ? lines.map((l, i) => h('button', { class: `net-log-line ${l.kind}`, type: 'button', style: `--age:${i}`,
      onclick: () => l.deviceId && flyToDevice(l.deviceId) },
    h('span', { class: 'net-log-time' }, l.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    h('span', { class: 'net-log-arrow' }, ARROWS[l.kind] || '•'), h('span', { class: 'net-log-text' }, l.text)))
      : [h('div', { class: 'net-log-line empty' }, 'Waiting for a board to talk…')]));
}

// ------------------------------------------------------------------ flying to a node

const viewKey = () => (net.view === 'floorplan' ? 'floorplan' : net.view === 'tree' ? 'tree' : 'mesh');
const viewRoot = () => (net.view === 'floorplan' ? document.querySelector('#floorplan svg.plan')
  : net.view === 'tree' ? document.querySelector('#tree-view > svg') : document.querySelector('#network-canvas > svg'));

function nodeAt(root, id) {
  const el = root && root.querySelector(`[data-node="${CSS.escape(String(id))}"]`);
  const matrix = el && el.transform && el.transform.baseVal.consolidate();
  return matrix ? { x: matrix.matrix.e, y: matrix.matrix.f } : null;
}

// The map glides to a node, zoomed in around it.
export function flyTo(id) {
  const root = viewRoot();
  const at = nodeAt(root, id);
  if (!at) return;
  const v = root.viewBox.baseVal;
  const from = [v.x, v.y, v.width, v.height];
  const width = Math.min(from[2], 520), height = width * (from[3] / from[2]);
  const to = [at.x - width / 2, at.y - height / 2, width, height];
  const key = viewKey();
  if (calm()) { net.zoom[key] = to; root.setAttribute('viewBox', to.join(' ')); return; }
  const started = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - started) / 550);
    const ease = 1 - (1 - k) ** 3;
    root.setAttribute('viewBox', from.map((value, i) => value + (to[i] - value) * ease).join(' '));
    if (k < 1) requestAnimationFrame(step); else net.zoom[key] = to;
  };
  requestAnimationFrame(step);
}

export function flyToDevice(deviceId) {
  const node = (shownTopology()?.nodes || []).find((n) => n.device_id === deviceId);
  if (!node) return;
  selectNode(String(node.id), false);
  flyTo(String(node.id));
}

// Arrow keys: to the node that way from the one selected (its neighbours first)
function onArrow(event) {
  if (!onNetwork() || !net.selected || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.target.closest('input, select, textarea')) return;
  const root = viewRoot();
  const from = nodeAt(root, net.selected);
  const topology = shownTopology();
  if (!from || !topology) return;
  const want = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  const neighbours = new Set(topology.links.flatMap((l) => (String(l.a) === net.selected ? [String(l.b)] : String(l.b) === net.selected ? [String(l.a)] : [])));
  let best = null;
  for (const node of topology.nodes) {
    const id = String(node.id);
    const at = id !== net.selected && nodeAt(root, id);
    if (!at) continue;
    const dx = at.x - from.x, dy = at.y - from.y, d = Math.hypot(dx, dy);
    const along = (dx * want[0] + dy * want[1]) / (d || 1);
    if (along < 0.5) continue;  // within about 60° of the way asked
    const score = d * (2 - along) * (neighbours.has(id) ? 0.6 : 1);
    if (!best || score < best.score) best = { id, score };
  }
  if (!best) return;
  event.preventDefault();
  selectNode(best.id, false);
  flyTo(best.id);
}

// ------------------------------------------------------------------ boards moving to another router

// At a redraw: each board whose parent changed since the drawing before glides there (the
// layout does), with a fading trail from where it was, and a line in the log.
export function noteMoves(topology, before) {
  const parents = new Map(topology.nodes.filter((n) => n.device_id).map((n) => [String(n.id), String(n.parent)]));
  const previous = net.lastParents;
  net.lastParents = parents;
  if (!previous || !before) return [];
  const moved = [];
  for (const [id, parent] of parents) {
    if (previous.has(id) && previous.get(id) !== parent && parent !== 'null' && previous.get(id) !== 'null') {
      const node = topology.nodes.find((n) => String(n.id) === id);
      const to = topology.nodes.find((n) => String(n.id) === parent);
      moved.push({ id, from: before.get(id) });  // where it goes: once it's laid out
      if (!net.viewing) logLine('move', `${nodeLabel(node)} moved to ${to ? nodeLabel(to) : 'another router'}`, node.device_id);
    }
  }
  return moved;
}

export function drawTrails(drawing, moved) {
  if (!drawing || calm()) return;
  for (const m of moved) {
    if (!m.from || !m.to) continue;
    const trail = svg('path', { class: 'move-trail', d: `M ${m.from.x} ${m.from.y} Q ${(m.from.x + m.to.x) / 2} ${Math.min(m.from.y, m.to.y) - 60} ${m.to.x} ${m.to.y}` });
    drawing.querySelector('.links')?.after(trail);
    drawing.querySelector(`[data-node="${CSS.escape(m.id)}"]`)?.classList.add('moved');
    setTimeout(() => trail.remove(), 3000);
  }
}

// ------------------------------------------------------------------ the week's signal

export async function loadSignalHistory() {
  net.signalHistory = await api('GET', '/api/network/signal-history?days=7', undefined, { quiet: true }).catch(() => ({}));
}

// A board's signal over the week as a small line (dB to its parent): green over 20, amber 10-20, red under.
export function signalSpark(deviceId, { width = 64, height = 18, axis = false } = {}) {
  const points = (net.signalHistory || {})[deviceId];
  if (!points || points.length < 2) return null;
  const t0 = Date.now() / 1000 - 7 * 86400, t1 = Date.now() / 1000;
  const hi = Math.max(40, ...points.map((p) => p[1]));
  const x = (t) => ((t - t0) / (t1 - t0)) * width;
  const y = (v) => height - 2 - (Math.max(0, v) / hi) * (height - 4);
  const line = points.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1][1];
  const tone = last > 20 ? 'ok' : last > 10 ? 'warn' : 'bad';
  const lows = points.filter((p) => p[1] <= 10).length;
  return svg('svg', { class: `signal-spark ${tone}${axis ? ' big' : ''}`, viewBox: `0 0 ${width} ${height}`, width, height,
    preserveAspectRatio: 'none', 'aria-label': `signal over the week, now ${last} dB` },
  svg('title', {}, `Signal to its parent over the week: now ${last} dB, from ${Math.min(...points.map((p) => p[1]))} to ${Math.max(...points.map((p) => p[1]))} dB${lows ? ` (weak ${lows} h)` : ''}`),
  axis ? svg('line', { x1: 0, x2: width, y1: y(10), y2: y(10), class: 'spark-weak' }) : null,
  svg('polyline', { points: line }));
}

// The week's signal in a link's details (a board's link to its parent).
export function linkHistory(spring) {
  const board = [spring.a.node, spring.b.node].find((n) => n.device_id);
  if (!board || spring.link.kind !== 'child') return null;
  const chart = signalSpark(board.device_id, { width: 300, height: 70, axis: true });
  if (!chart) return null;
  return h('div', { class: 'mt-2' }, h('b', {}, 'Signal over the week'), h('div', { class: 'link-week' }, chart),
    h('div', { class: 'd-flex justify-content-between small text-body-secondary' }, h('span', {}, '7 days ago'), h('span', {}, 'the dashed line: weak (10 dB)'), h('span', {}, 'now')));
}

// ------------------------------------------------------------------ what if: a new router here?

// Where it is (map units of the view it's in), how far a router reaches, and what it would change:
// the boards within its reach (an estimate from the map's distances: the mesh's are radio
// closeness, the floor plan's are your home's), those that would get a second router, and those
// that would hear it better than their parent.
const WHAT_IF_MARGIN = 30;  // dB: about what a router near a board gives

export function whatIfReach(view, size) {
  return view === 'floorplan' ? Math.max(size.W, size.H) * 0.3 : 220;
}

export function whatIfSamples(view) {
  const at = net.whatIf && net.whatIf[view];
  return at ? [{ x: at.x, y: at.y, margin: WHAT_IF_MARGIN }] : [];
}

function whatIfEffect(view, points, reach) {
  const at = net.whatIf[view];
  const topology = shownTopology();
  const tree = meshTree(topology);
  const spof = new Set(weakPoints(topology).routers.filter((p) => p.boards.length).flatMap((p) => p.boards.map((b) => String(b.id))));
  const effects = [];
  for (const node of topology.nodes.filter((n) => n.device_id)) {
    const p = points.get(String(node.id));
    if (!p) continue;
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d > reach) continue;
    const estimate = Math.round(WHAT_IF_MARGIN * (1 - d / reach) + 5);
    const link = tree.linkOf(String(node.id), String(node.parent));
    const now = link ? linkMargin(link) : null;
    effects.push({ node, p, estimate, now, backup: spof.has(String(node.id)), better: now !== null && estimate > now + 5 });
  }
  return effects;
}

export function drawWhatIf(drawing, view, points, size = {}) {
  if (!net.whatIf || !drawing) return;
  const reach = whatIfReach(view, size);
  if (!net.whatIf[view]) {
    const v = drawing.viewBox.baseVal;
    net.whatIf[view] = { x: v.x + v.width * 0.62, y: v.y + v.height * 0.5 };
  }
  const at = net.whatIf[view];
  const layer = svg('g', { class: 'what-if' });
  const render = () => {
    const effects = whatIfEffect(view, points, reach);
    layer.replaceChildren(
      svg('circle', { cx: at.x, cy: at.y, r: reach, class: 'what-if-reach' }),
      ...effects.map((e) => svg('line', { x1: at.x, y1: at.y, x2: e.p.x, y2: e.p.y, class: `what-if-link ${e.estimate > 20 ? 'ok' : e.estimate > 10 ? 'warn' : 'bad'}` })),
      svg('g', { class: 'what-if-router', transform: `translate(${at.x},${at.y})` },
        svg('circle', { r: 18 }), svg('use', { href: '#i-router', x: -10, y: -10, width: 20, height: 20 }),
        svg('text', { y: 34, 'text-anchor': 'middle' }, 'a new router?')));
    renderWhatIfNote(effects);
  };
  render();
  drawing.querySelector('.links')?.after(layer);
  // Drag it around
  let dragging = false;
  layer.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.what-if-router')) return;
    event.stopPropagation();
    dragging = true;
    layer.setPointerCapture(event.pointerId);
  });
  layer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const point = drawing.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const p = point.matrixTransform(drawing.getScreenCTM().inverse());
    at.x = p.x; at.y = p.y;
    render();
  });
  layer.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (net.heatmap) redrawNetwork();  // the heatmap with it
  });
}

function renderWhatIfNote(effects) {
  const wrap = document.getElementById('map-wrap');
  let box = document.getElementById('what-if-note');
  if (!net.whatIf) { box?.remove(); return; }
  if (!box) {
    box = h('div', { class: 'what-if-note', id: 'what-if-note' });
    wrap.append(box);
  }
  const name = (e) => nodeLabel(e.node);
  const backups = effects.filter((e) => e.backup), better = effects.filter((e) => e.better);
  box.replaceChildren(...[h('b', {}, 'A new router here?'), ' Drag it around.',
    h('div', {}, effects.length ? `${effects.length} board${effects.length === 1 ? '' : 's'} in its reach.` : 'No board in its reach: closer.'),
    backups.length ? h('div', { class: 'ok' }, `A second router for ${backups.map(name).join(', ')} (they depend on one router now).`) : null,
    better.length ? h('div', { class: 'ok' }, `Better signal for ${better.map((e) => `${name(e)} (≈${e.estimate} dB, ${e.now} now)`).join(', ')}.`) : null,
    h('div', { class: 'small text-body-secondary mt-1' }, net.view === 'floorplan'
      ? 'An estimate from where the nodes are on your floor plan, not a measurement: walls count too.'
      : 'An estimate from the mesh\'s distances (radio closeness), not a measurement. The floor plan gives a better one.')].filter(Boolean));
}

// ------------------------------------------------------------------ wall mode

const wall = { on: false, clock: null, lens: null, lensBefore: null };

function wallBanner(text, kind) {
  const banner = document.getElementById('net-wall-banner');
  if (!banner) return;
  banner.className = `net-wall-banner show ${kind}`;
  banner.textContent = text;
  clearTimeout(wall.bannerTimer);
  wall.bannerTimer = setTimeout(() => { banner.className = 'net-wall-banner'; }, 6000);
}

function tickClock() {
  const clock = document.getElementById('net-wall-clock');
  if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lens = document.getElementById('net-wall-lens');
  if (lens) lens.textContent = `lens: ${(LENSES.find(([key]) => key === net.lens) || LENSES[0])[1]}`;
}

export function toggleWall() {
  if (wall.on) return leaveWall();
  wall.on = true;
  wall.lensBefore = net.lens;
  document.body.classList.add('net-wall');
  document.getElementById('tab-network').append(h('div', { class: 'net-wall-top', id: 'net-wall-top' },
    h('div', { class: 'net-wall-clock', id: 'net-wall-clock' }), h('div', { class: 'net-wall-lens', id: 'net-wall-lens' }),
    h('div', { class: 'net-wall-banner', id: 'net-wall-banner' }),
    h('button', { class: 'btn btn-sm btn-outline-secondary ms-auto', type: 'button', onclick: leaveWall }, 'Exit (Esc)')));
  tickClock();
  wall.clock = setInterval(tickClock, 5000);
  // The lens changes by itself, every 30 s
  wall.lens = setInterval(() => {
    const i = LENSES.findIndex(([key]) => key === net.lens);
    net.lens = LENSES[(i + 1) % LENSES.length][0];
    document.getElementById('lens-select').value = net.lens;
    tickClock();
    redrawNetwork();
  }, 30000);
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch (error) { /* a window then */ }
  setTimeout(redrawNetwork, 150);  // sized to the screen
  renderLog();
}

export function leaveWall() {
  if (!wall.on) return;
  wall.on = false;
  clearInterval(wall.clock);
  clearInterval(wall.lens);
  document.body.classList.remove('net-wall');
  document.getElementById('net-wall-top')?.remove();
  net.lens = wall.lensBefore || net.lens;
  document.getElementById('lens-select').value = net.lens;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setTimeout(redrawNetwork, 150);
  renderLog();
}

// ------------------------------------------------------------------ set up, once network.js is ready

export function initNetPlus() {
  try { net.showLog = localStorage.getItem('hacoap-map-log') !== '0'; } catch (error) { net.showLog = true; }
  const logToggle = document.getElementById('log-toggle');
  logToggle.checked = net.showLog;
  logToggle.addEventListener('change', () => {
    net.showLog = logToggle.checked;
    try { localStorage.setItem('hacoap-map-log', net.showLog ? '1' : '0'); } catch (error) { /* not remembered */ }
    renderLog();
  });
  const whatIf = document.getElementById('whatif-toggle');
  whatIf.addEventListener('change', () => {
    net.whatIf = whatIf.checked ? {} : null;
    if (!net.whatIf) document.getElementById('what-if-note')?.remove();
    redrawNetwork();
  });
  document.getElementById('net-wall-button').addEventListener('click', toggleWall);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && wall.on) leaveWall();
    else onArrow(event);
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && wall.on) leaveWall(); });
  renderLog();
}
