// The Network tab around the map: the figures across the top, the list of every node (searchable,
// sharing the map's highlight and selection), the gear's settings (border router, floor plan),
// and the changes and channels under the map.

import { ago, api, busy, h, notify, state, svg, when } from './core.js';
import { hoverNode, linkStrength, loadNetwork, meshTree, net, nodeLabel, nodeShape, nodeStyle, selectNode, shownTopology,
  signalBars, wayLink, weakness } from './network.js';

// ------------------------------------------------------------------ the figures

export function renderNetFrame() {
  const topology = shownTopology();
  document.getElementById('network-warnings').replaceChildren(...((topology && topology.warnings) || []).map((w) =>
    h('div', { class: 'alert alert-warning py-1 small mb-2' }, w)));
  renderFigures(topology);
  renderNetList();
  const read = document.getElementById('network-summary');
  read.classList.toggle('earlier', !!net.viewing);
  read.textContent = !topology ? '' : `${net.viewing ? 'earlier reading, ' : 'read '}${ago(topology.fetched)} · ` +
    `${topology.source === 'api' ? 'with signal strength' : 'link quality only'}`;
}

// A link's strength as words for a figure: its margin, or its link quality.
const strengthValue = (link) => (link.link_margin !== null && link.link_margin !== undefined ? `${link.link_margin} dB`
  : `${linkStrength(link).quality ?? '?'} of 3`);
const tone = (quality) => (quality === null || quality === undefined ? '' : quality >= 3 ? 'ok' : quality === 2 ? 'warn' : 'bad');

function renderFigures(topology) {
  const box = document.getElementById('net-figures');
  if (!topology) return box.replaceChildren();
  const tree = meshTree(topology);
  const count = { routers: 0, children: 0, sleepy: 0, boards: 0 };
  for (const n of topology.nodes) {
    if (!n.parent) count.routers++; else count.children++;
    if (n.kind === 'SED') count.sleepy++;
    if (n.device_id) count.boards++;
  }
  const ways = topology.nodes.map((node) => ({ node, link: wayLink(tree, String(node.id)) })).filter((w) => w.link);
  const weakest = ways.sort((a, b) => weakness(b.link) - weakness(a.link))[0];
  const margins = ways.map((w) => w.link.link_margin).filter((m) => m !== null && m !== undefined);
  const average = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null;
  const dayAgo = Date.now() / 1000 - 86400;
  const changes = ((net.state && net.state.events) || []).filter((e) => e.time >= dayAgo).length;
  const online = [...state.devices.values()].filter((d) => d.online).length;

  const figure = (label, value, note, { kind = '', icon = null, onclick = null, title = null } = {}) =>
    h(onclick ? 'button' : 'div', { class: `net-figure ${kind}`, type: onclick ? 'button' : null, onclick, title },
      h('span', { class: 'net-figure-label' }, icon ? svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${icon}` })) : null, label),
      h('span', { class: 'net-figure-value' }, value),
      h('span', { class: 'net-figure-note' }, note));
  const weakQuality = weakest ? linkStrength(weakest.link).quality : null;
  box.replaceChildren(
    figure('routers', count.routers, 'the border router included', { icon: 'radio-tower' }),
    figure('children', count.children, `${count.sleepy} sleepy`, { icon: 'moon' }),
    figure('your boards', count.boards, `${online} of ${state.devices.size} online`, { icon: 'sprout' }),
    weakest ? figure('weakest link', strengthValue(weakest.link), nodeLabel(weakest.node), { kind: tone(weakQuality), icon: 'signal-low',
      onclick: () => selectNode(String(weakest.node.id), true), title: 'Show it on the map' }) : null,
    average !== null ? figure('average signal', `${average} dB`, 'margin on each way in',
      { kind: tone(average > 20 ? 3 : average > 10 ? 2 : 1), icon: 'activity' }) : null,
    figure('changes', changes, 'parent changes, 24 h', { kind: changes > 3 ? 'warn' : '', icon: 'history',
      onclick: () => { showMore('changes'); document.querySelector('.net-more').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
      title: 'Show the changes' }));
}

// ------------------------------------------------------------------ the node list

const list = { text: '', sort: 'weak' };
try { list.sort = localStorage.getItem('hacoap-net-sort') || 'weak'; } catch (error) { /* the default */ }

const GROUPS = [['routers', 'Routers'], ['boards', 'Your boards'], ['others', 'Other devices']];

export function renderNetList() {
  const body = document.getElementById('net-list-body');
  const topology = shownTopology();
  if (!topology) return body.replaceChildren(h('p', { class: 'net-list-empty' }, 'The nodes show here once the network is read.'));
  const tree = meshTree(topology);
  const text = list.text.trim().toLowerCase();
  const rows = topology.nodes.map((node) => {
    const id = String(node.id);
    const link = wayLink(tree, id);
    const device = node.device_id ? state.devices.get(node.device_id) : null;
    return { node, id, link, device, name: nodeLabel(node), hops: tree.hops.get(id) ?? 99,
      group: !node.parent ? 'routers' : node.device_id ? 'boards' : 'others' };
  }).filter((r) => !text || [r.name, r.device && r.device.plant, r.node.rloc16_hex, r.node.ext_address, r.node.hostname, r.node.device_id]
    .some((v) => v && String(v).toLowerCase().includes(text)));
  const order = {
    weak: (a, b) => (b.link ? weakness(b.link) : -1) - (a.link ? weakness(a.link) : -1) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    hops: (a, b) => a.hops - b.hops || a.name.localeCompare(b.name),
  }[list.sort] || ((a, b) => a.name.localeCompare(b.name));
  const parts = GROUPS.map(([group, title]) => {
    const members = rows.filter((r) => r.group === group).sort(order);
    if (!members.length) return null;
    return [h('div', { class: 'net-group' }, title, h('span', { class: 'net-count' }, members.length)),
      ...members.map((r) => nodeRow(r, tree))];
  }).filter(Boolean).flat();
  body.replaceChildren(...(parts.length ? parts : [h('p', { class: 'net-list-empty' }, 'No node matches.')]));
  for (const row of body.querySelectorAll('[data-node]')) {
    row.classList.toggle('selected', row.dataset.node === net.selected);
  }
}

function nodeRow(r, tree) {
  const up = tree.towards.get(r.id);
  const upNode = up && tree.byId.get(up);
  const strength = r.link ? linkStrength(r.link) : null;
  const what = r.node.border_router ? 'border router' : r.device ? (r.device.plant || 'your board') : nodeStyle(r.node).label.split(' (')[0];
  const sub = [what, r.node.border_router ? null : upNode ? `via ${nodeLabel(upNode)}` : 'not linked'].filter(Boolean).join(' · ');
  const row = h('button', { class: `net-row${r.device && !r.device.online ? ' offline' : ''}`, type: 'button', 'data-node': r.id,
    onclick: () => selectNode(r.id, true), onpointerenter: () => hoverNode(r.id, true), onpointerleave: () => hoverNode(r.id, false),
    onfocus: () => hoverNode(r.id, true), onblur: () => hoverNode(r.id, false) },
  svg('svg', { class: 'net-row-icon', viewBox: '-32 -32 64 64', 'aria-hidden': 'true' }, nodeShape(r.node, r.node.device_id ? 1 : r.node.border_router ? 1.1 : r.node.parent ? 1.9 : 1.4, strength ? strength.quality : undefined).el),
  h('span', { class: 'net-row-text' }, h('span', { class: 'net-row-name' }, r.name), h('span', { class: 'net-row-sub' }, sub)),
  strength ? h('span', { class: 'net-row-signal', title: strength.text }, signalBars(strength.quality),
    h('span', {}, r.link.link_margin !== null && r.link.link_margin !== undefined ? `${r.link.link_margin}` : '')) : null);
  return row;
}

document.getElementById('net-search').addEventListener('input', (event) => {
  list.text = event.target.value;
  renderNetList();
});
document.getElementById('net-sort').value = list.sort;
document.getElementById('net-sort').addEventListener('change', (event) => {
  list.sort = event.target.value;
  try { localStorage.setItem('hacoap-net-sort', list.sort); } catch (error) { /* not remembered */ }
  renderNetList();
});

// ------------------------------------------------------------------ the gear: border router, floor plan

const floorplanFile = document.getElementById('floorplan-file');
const chooseFloorplan = () => floorplanFile.click();
document.getElementById('floorplan-choose').addEventListener('click', chooseFloorplan);
document.getElementById('floorplan-empty-choose').addEventListener('click', chooseFloorplan);
floorplanFile.addEventListener('change', () => busy(document.getElementById('floorplan-choose'), async () => {
  const file = floorplanFile.files[0];
  if (!file) return;
  try {
    await api('POST', `/api/network/floorplan?name=${encodeURIComponent(file.name)}`, file);
  } finally {
    floorplanFile.value = '';
  }
  notify('Floor plan saved: drag the nodes onto it', 'success', 3000);
  await loadNetwork();
}));

document.getElementById('floorplan-remove').addEventListener('click', async () => {
  if (!confirm('Remove the floor plan picture? The positions are kept.')) return;
  await api('DELETE', '/api/network/floorplan').catch(() => {});
  await loadNetwork();
});

document.getElementById('network-empty-settings').addEventListener('click', (event) => {
  event.stopPropagation();  // or the dropdown closes again at once
  bootstrap.Dropdown.getOrCreateInstance(document.getElementById('net-settings-button')).show();
  document.getElementById('border-router-url').focus();
});

// ------------------------------------------------------------------ changes and channels, under the map

export function showMore(which) {
  for (const name of ['changes', 'channels']) {
    const tab = document.getElementById(`net-more-${name}`);
    tab.classList.toggle('active', name === which);
    tab.setAttribute('aria-selected', String(name === which));
    document.getElementById(`net-panel-${name}`).classList.toggle('d-none', name !== which);
  }
  document.getElementById('channel-scan').classList.toggle('d-none', which !== 'channels');
}

document.getElementById('net-more-changes').addEventListener('click', () => showMore('changes'));
document.getElementById('net-more-channels').addEventListener('click', () => showMore('channels'));

export function renderNetworkEvents(events = []) {
  const dayAgo = Date.now() / 1000 - 86400;
  const recent = events.filter((e) => e.time >= dayAgo).length;
  document.getElementById('net-changes-count').textContent = recent ? recent : '';
  document.getElementById('network-events').replaceChildren(...(events.length
    ? events.map((e) => h('li', {}, h('span', { class: 'net-event-time', title: when(e.time) }, ago(e.time)), h('span', {}, e.message)))
    : [h('li', { class: 'text-body-secondary' }, 'No changes seen yet. Boards changing parent show here.')]));
}
