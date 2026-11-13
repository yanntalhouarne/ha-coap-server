// The Network tab, alive: the messages to and from the boards on the map as they happen, a replay
// of the last day's readings, its weak points (the routers boards depend on), and how the routers'
// radios do. Nothing here asks a battery board for anything: it draws what's already said, or
// what mains-powered devices (the routers, the border router) report.

import { api, h, svg } from './core.js';
import { currentRoute } from './tabs.js';
import { calm, linkKey, linkMargin, meshTree, net, nodeLabel, redrawNetwork, renderHistoryLabel, selectNode, shownTopology,
  showLatestNetwork } from './network.js';
import { showMore } from './netframe.js';

// ------------------------------------------------------------------ live traffic

// What each kind of message is, and which way it goes: up (the board to the border router), down,
// or both (asked, then answered).
export const TRAFFIC = {
  push: { label: 'a board pushed', way: 'up' },
  read: { label: 'the app read a board', way: 'both' },
  command: { label: 'the app told a board', way: 'down' },
  update: { label: 'an update', way: 'down' },
};
const HOP_MS = 420;

// The links from a board to the border router, in order, each with its drawn path (drawn from the
// node farther from the border router).
function wayOf(deviceId) {
  const layout = net.layout;
  if (!layout) return null;
  const start = layout.nodes.find((n) => n.node.device_id === deviceId);
  if (!start) return null;
  const { towards } = meshTree(shownTopology());
  const springs = new Map(layout.springs.map((s) => [s.key, s]));
  const hops = [];
  const seen = new Set([start.id]);
  let at = start.id;
  while (towards.has(at) && !seen.has(towards.get(at))) {
    const next = towards.get(at);
    const spring = springs.get(linkKey(at, next));
    if (!spring || !spring.path) break;
    hops.push({ spring, forward: spring.a.id === at });  // the path runs a → b
    seen.add(next);
    at = next;
  }
  return hops.length ? hops : null;
}

// A dot along a board's way to the border router (or back), coloured by what the message is.
export function trafficPulse(deviceId, what) {
  if (calm() || net.viewing || currentRoute().split('/')[0] !== 'network') return;
  for (const group of document.querySelectorAll(`#map-wrap g.node[data-device="${CSS.escape(deviceId)}"]`)) {
    group.classList.remove('pulse');
    void group.getBBox();  // restarts the animation
    group.classList.add('pulse');
    setTimeout(() => group.classList.remove('pulse'), 1300);
  }
  const drawing = document.querySelector('#network-canvas > svg');
  const hops = net.view === 'mesh' && drawing ? wayOf(deviceId) : null;
  if (!hops) return;
  const kind = TRAFFIC[what] ? what : 'read';
  const legs = TRAFFIC[kind].way === 'up' ? [hops] : TRAFFIC[kind].way === 'down' ? [down(hops)] : [down(hops), hops];
  const dot = svg('circle', { r: 5, class: `traffic-dot ${kind}` });
  drawing.append(dot);
  const plan = legs.flat();
  const started = performance.now();
  const step = (now) => {
    const t = Math.max(0, now - started) / HOP_MS;  // a frame's time can be from just before it started
    const index = Math.floor(t);
    if (index >= plan.length || !dot.isConnected) return dot.remove();
    const { spring, forward } = plan[index];
    const k = t - index;
    const length = spring.path.getTotalLength();
    const at = spring.path.getPointAtLength(length * (forward ? k : 1 - k));
    dot.setAttribute('cx', at.x);
    dot.setAttribute('cy', at.y);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const down = (hops) => [...hops].reverse().map((hop) => ({ spring: hop.spring, forward: !hop.forward }));

// An update in progress: a dot down to the board now and then, while it uploads.
const lastUpdatePulse = new Map();
export function updateTraffic(job) {
  for (const target of job.targets || []) {
    if (target.status !== 'running' || !['upload', 'connect', 'test', 'confirm'].includes(target.step)) continue;
    const last = lastUpdatePulse.get(target.device_id) || 0;
    if (Date.now() - last < 1500) continue;
    lastUpdatePulse.set(target.device_id, Date.now());
    trafficPulse(target.device_id, 'update');
  }
}

// ------------------------------------------------------------------ replay

const replay = { playing: false, cache: new Map(), timer: null };
const REPLAY_SECONDS = 20;

function setPlayButton() {
  const button = document.getElementById('history-play');
  button.replaceChildren(svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${replay.playing ? 'pause' : 'play'}` })),
    replay.playing ? ' pause' : ' replay');
  button.title = replay.playing ? 'Stop the replay' : 'Replay the last day (or every reading kept) in about 20 seconds';
}

// What changed between two readings, in words: boards that came and went, and parent changes.
function changesBetween(before, after) {
  if (!before) return [];
  const name = (n) => nodeLabel(n);
  const old = new Map(before.nodes.map((n) => [String(n.id), n]));
  const now = new Map(after.nodes.map((n) => [String(n.id), n]));
  const lines = [];
  for (const [id, n] of now) {
    if (!n.device_id) continue;
    const was = old.get(id);
    if (!was) lines.push({ tone: 'ok', text: `${name(n)} joined` });
    else if (String(was.parent) !== String(n.parent) && n.parent && was.parent) {
      const parent = now.get(String(n.parent));
      lines.push({ tone: 'warn', text: `${name(n)} moved to ${parent ? name(parent) : 'another router'}` });
    }
  }
  for (const [id, n] of old) if (n.device_id && !now.has(id)) lines.push({ tone: 'bad', text: `${name(n)} dropped off` });
  return lines;
}

function showCaption(entry, lines, index, total) {
  const wrap = document.getElementById('map-wrap');
  let box = document.getElementById('replay-caption');
  if (!box) {
    box = h('div', { class: 'replay-caption', id: 'replay-caption', 'aria-live': 'polite' });
    wrap.append(box);
  }
  const kept = (replay.lines = [...lines.map((l) => ({ ...l, at: entry.time })), ...(replay.lines || [])].slice(0, 4));
  box.replaceChildren(
    h('div', { class: 'replay-time' }, new Date(entry.time * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })),
    h('div', { class: 'replay-bar' }, h('i', { style: `width:${Math.round(((index + 1) / total) * 100)}%` })),
    ...(kept.length ? kept.map((l) => h('div', { class: `replay-line ${l.tone}` }, l.text))
      : [h('div', { class: 'replay-line' }, 'No board moved yet')]));
}

export async function toggleReplay() {
  if (replay.playing) return stopReplay();
  const dayAgo = Date.now() / 1000 - 86400;
  let frames = net.history.filter((e) => e.time >= dayAgo);
  if (frames.length < 3) frames = net.history.slice();
  if (frames.length < 2) return;
  replay.playing = true;
  replay.lines = [];
  setPlayButton();
  const slider = document.getElementById('history-slider');
  const frameMs = Math.max(150, Math.min(700, (REPLAY_SECONDS * 1000) / frames.length));
  let previous = null;
  for (let i = 0; i < frames.length && replay.playing; i++) {
    const entry = frames[i];
    let topology = replay.cache.get(entry.id);
    if (!topology) {
      topology = await api('GET', `/api/network/history/${entry.id}`, undefined, { quiet: true }).catch(() => null);
      if (topology) replay.cache.set(entry.id, topology);
    }
    if (!topology || !replay.playing) continue;
    net.viewing = { id: entry.id, time: entry.time, topology };
    slider.value = net.history.findIndex((e) => e.id === entry.id);
    renderHistoryLabel();
    redrawNetwork();
    showCaption(entry, changesBetween(previous, topology), i, frames.length);
    previous = topology;
    await new Promise((resolve) => { replay.timer = setTimeout(resolve, frameMs); });
  }
  if (replay.playing) {
    replay.playing = false;
    setPlayButton();
    setTimeout(() => { if (!replay.playing) { document.getElementById('replay-caption')?.remove(); showLatestNetwork(); } }, 2500);
  }
}

export function stopReplay() {
  replay.playing = false;
  clearTimeout(replay.timer);
  setPlayButton();
  document.getElementById('replay-caption')?.remove();
}


// ------------------------------------------------------------------ weak points

// The routers boards depend on: for each router (not the border router), the routers that would
// lose their way to the border router without it, and every board under those. Its boards would
// have to find another router in reach (they do, if one is). And the weakest links of the boards.
export function weakPoints(topology) {
  if (!topology) return { routers: [], links: [] };
  const tree = meshTree(topology);
  const center = tree.center ? String(tree.center.id) : null;
  const routers = topology.nodes.filter((n) => !n.parent).map((n) => String(n.id));
  const mesh = new Map(routers.map((id) => [id, []]));
  for (const link of topology.links.filter((l) => l.kind === 'mesh')) {
    const a = String(link.a), b = String(link.b);
    if (mesh.has(a) && mesh.has(b)) { mesh.get(a).push(b); mesh.get(b).push(a); }
  }
  const childrenOf = (ids) => topology.nodes.filter((n) => n.parent !== null && n.parent !== undefined && ids.has(String(n.parent)));
  const result = [];
  for (const id of routers) {
    if (id === center) continue;
    const reached = new Set(center ? [center] : []);
    const queue = center ? [center] : [];
    while (queue.length) {
      for (const next of mesh.get(queue.shift()) || []) {
        if (next !== id && !reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    const cut = new Set([id, ...routers.filter((r) => r !== id && !reached.has(r))]);
    const boards = childrenOf(cut).filter((n) => n.device_id);
    if (boards.length || cut.size > 1) result.push({ node: tree.byId.get(id), boards, routers: [...cut].filter((r) => r !== id) });
  }
  result.sort((a, b) => b.boards.length - a.boards.length);
  const links = topology.nodes.filter((n) => n.device_id).map((n) => {
    const link = tree.linkOf(String(n.id), String(n.parent));
    const margin = link ? linkMargin(link) : null;
    const quality = link ? Math.min(...[link.link_quality_in, link.link_quality_out].filter((q) => q !== null && q !== undefined)) : null;
    return { node: n, parent: tree.byId.get(String(n.parent)), margin, quality: Number.isFinite(quality) ? quality : null };
  }).filter((l) => (l.margin !== null ? l.margin < 15 : l.quality !== null && l.quality <= 1))
    .sort((a, b) => (a.margin ?? a.quality * 10) - (b.margin ?? b.quality * 10));
  return { routers: result, links };
}

// On the map (with "weak points"): the routers boards depend on ringed in red, with how many.
export function markWeakPoints(root, layout) {
  if (!net.weakPoints || !root) return;
  const { routers, links } = weakPoints(shownTopology());
  for (const point of routers) {
    const n = layout && layout.nodes.find((x) => x.node === point.node);
    const group = root.querySelector(`[data-node="${CSS.escape(String(point.node.id))}"]`);
    if (!group || !point.boards.length) continue;
    group.classList.add('spof');
    group.append(svg('g', { class: 'spof-tag', transform: `translate(0,${-((n && 30) || 30)})` },
      svg('rect', { x: -44, y: -11, width: 88, height: 20, rx: 10 }),
      svg('text', { x: 0, y: 3.5, 'text-anchor': 'middle' }, `${point.boards.length} board${point.boards.length === 1 ? '' : 's'} on it`)));
  }
  for (const link of links) root.querySelector(`[data-node="${CSS.escape(String(link.node.id))}"]`)?.classList.add('weak-link');
}

export function renderWeakPoints() {
  const box = document.getElementById('net-panel-weak');
  const topology = shownTopology();
  if (!topology) return box.replaceChildren(h('div', { class: 'p-2 text-body-secondary' }, 'Read the network first.'));
  const { routers, links } = weakPoints(topology);
  const name = (n) => (n ? nodeLabel(n) : '?');
  const jump = (n, text) => h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', type: 'button',
    onclick: () => selectNode(String(n.id), true, true) }, text);
  const items = [];
  for (const point of routers.filter((p) => p.boards.length)) {
    items.push(h('li', {}, h('span', { class: 'weak-dot bad' }), jump(point.node, name(point.node)), ': ',
      `${point.boards.length} of your boards depend on it (${point.boards.map(name).join(', ')})`,
      point.routers.length ? `, and ${point.routers.length} router${point.routers.length === 1 ? '' : 's'} reach the border router only through it` : '',
      '. If it goes down they have to find another router in reach; a second powered router nearby gives them one.'));
  }
  for (const link of links) {
    items.push(h('li', {}, h('span', { class: 'weak-dot warn' }), jump(link.node, name(link.node)), ` hears ${name(link.parent)} weakly (`,
      link.margin !== null ? `${link.margin} dB` : `link quality ${link.quality} of 3`,
      '). A powered router between them, or moving one of them, would help.'));
  }
  box.replaceChildren(items.length ? h('ul', { class: 'list-unstyled small p-2 mb-0 net-events' }, items)
    : h('div', { class: 'p-2 small text-body-secondary' }, 'No weak point: no router carries boards that have nowhere else to go, and every board hears its parent well.'));
  document.getElementById('net-weak-count').textContent = routers.filter((p) => p.boards.length).length + links.length || '';
}

// ------------------------------------------------------------------ radio health

const pctText = (v) => (v === null || v === undefined ? '–' : `${v} %`);
const window_ = (s) => (s ? `over ${Math.round(s / 60)} min` : '');

export function radioRows(topology) {
  return (topology ? topology.nodes : []).filter((n) => n.radio).map((n) => ({ node: n, radio: n.radio }))
    .sort((a, b) => (b.node.border_router ? 1 : 0) - (a.node.border_router ? 1 : 0));
}

// The radio's health in a node's details: what it sent and received since the reading before.
export function radioDetails(node) {
  const r = node.radio;
  if (!r) return null;
  return h('div', { class: 'mt-2' }, h('b', {}, 'Radio'), ` ${window_(r.window_s)}`,
    h('ul', { class: 'list-unstyled net-links mb-0' },
      h('li', {}, `${r.sent} sent, ${r.received} received`),
      h('li', {}, `sends that failed: ${pctText(r.send_failed_pct)}`),
      h('li', {}, `received in error: ${pctText(r.receive_errors_pct)}`),
      r.channel_busy_pct !== undefined ? h('li', {}, `channel busy when sending: ${pctText(r.channel_busy_pct)} (interference)`) : null,
      r.undelivered_to_sleepy !== undefined ? h('li', {}, `messages its sleepy boards never collected: ${r.undelivered_to_sleepy}`) : null));
}

export function renderRadio() {
  const box = document.getElementById('net-panel-radio');
  const rows = radioRows(shownTopology());
  if (!rows.length) {
    return box.replaceChildren(h('div', { class: 'p-2 small text-body-secondary' },
      'The routers\' radio counters show here from the second reading of the network on (rates between two readings). ',
      'They come from the border router\'s command line (Docker on this computer): nothing is asked of the boards.'));
  }
  const tone = (v, warn, bad) => (v === null || v === undefined ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  box.replaceChildren(h('div', { class: 'table-responsive' }, h('table', { class: 'table table-sm small mb-0 net-radio' },
    h('thead', {}, h('tr', {}, ...['Router', 'Sent', 'Received', 'Sends failed', 'Received in error', 'Channel busy', 'Not collected by sleepy boards']
      .map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map(({ node, radio }) => h('tr', {},
      h('td', {}, h('button', { class: 'btn btn-link btn-sm p-0', type: 'button', onclick: () => selectNode(String(node.id), true, true) }, nodeLabel(node)),
        h('div', { class: 'text-body-secondary' }, window_(radio.window_s))),
      h('td', {}, radio.sent), h('td', {}, radio.received),
      h('td', { class: `tone-${tone(radio.send_failed_pct, 2, 10)}` }, pctText(radio.send_failed_pct)),
      h('td', { class: `tone-${tone(radio.receive_errors_pct, 2, 10)}` }, pctText(radio.receive_errors_pct)),
      h('td', { class: `tone-${tone(radio.channel_busy_pct, 1, 5)}` }, radio.channel_busy_pct === undefined ? '' : pctText(radio.channel_busy_pct)),
      h('td', {}, radio.undelivered_to_sleepy === undefined ? '' : String(radio.undelivered_to_sleepy))))))),
  h('div', { class: 'p-2 small text-body-secondary' }, 'From the routers and the border router (mains-powered): nothing is asked of the boards. ',
    'Channel busy is the border router finding the channel in use when it wants to send: interference, such as Wi-Fi on the same frequencies (see Channels).'));
}

// The figure for the strip above the map: the border router's channel busy, or the worst router's failed sends.
export function radioFigure() {
  const rows = radioRows(shownTopology());
  if (!rows.length) return null;
  const br = rows.find((r) => r.node.border_router);
  const busy = br && br.radio.channel_busy_pct;
  const worst = Math.max(...rows.map((r) => r.radio.send_failed_pct ?? 0));
  const value = busy !== null && busy !== undefined ? `${busy} %` : `${worst} %`;
  const kind = (busy ?? 0) >= 5 || worst >= 10 ? 'bad' : (busy ?? 0) >= 1 || worst >= 2 ? 'warn' : 'ok';
  return { label: 'radio', value, note: busy !== null && busy !== undefined ? 'channel busy, border router' : 'worst failed sends', kind,
    onclick: () => { showMore('radio'); document.querySelector('.net-more').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } };
}

// Its controls, once network.js (which this module and it import each other) is ready
export function initNetLive() {
  document.getElementById('history-play').addEventListener('click', () => toggleReplay());
  document.getElementById('history-latest').addEventListener('click', stopReplay);
  setPlayButton();
  const toggle = document.getElementById('weakpoints-toggle');
  try { net.weakPoints = localStorage.getItem('hacoap-map-weak') === '1'; } catch (error) { /* off */ }
  toggle.checked = !!net.weakPoints;
  toggle.addEventListener('change', (event) => {
    net.weakPoints = event.target.checked;
    try { localStorage.setItem('hacoap-map-weak', net.weakPoints ? '1' : '0'); } catch (error) { /* not remembered */ }
    redrawNetwork();
  });
}

