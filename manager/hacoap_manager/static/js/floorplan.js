// The Network tab's floor plan, switching between the views, and the channel scan.

import { ago, api, busy, h, photoUrl, state, svg } from './core.js';
import { applyFocus, boardAvatar, enableZoom, heatmapLayer, linkKey, linkPath, linkStrength, meshTree, nameChip, net, nodeEvents,
  nodeLabel, nodeShape, qualityColors, renderHeatmapNote, renderNetwork, selectNode, shownName, shownTopology, wayLink } from './network.js';
import { showMore } from './netframe.js';
import { renderTree } from './tree.js';

// ------------------------------------------------------------------ network: the views

const VIEWS = ['mesh', 'tree', 'floorplan'];

export function setNetworkView(view) {
  net.view = VIEWS.includes(view) ? view : 'mesh';
  for (const name of VIEWS) document.getElementById(`view-${name}`).classList.toggle('active', name === net.view);
  document.getElementById('network-canvas').classList.toggle('d-none', net.view !== 'mesh');
  document.getElementById('tree-view').classList.toggle('d-none', net.view !== 'tree');
  document.getElementById('floorplan').classList.toggle('d-none', net.view !== 'floorplan');
  document.getElementById('map-wrap').dataset.view = net.view;
  document.getElementById('map-wrap').querySelector('.map-tip')?.remove();
  renderHeatmapNote();
  if (net.view === 'mesh') renderNetwork();
  if (net.view === 'tree') renderTree();
  if (net.view === 'floorplan') renderFloorplan();
}

for (const name of VIEWS) document.getElementById(`view-${name}`).addEventListener('click', () => setNetworkView(name));

// ------------------------------------------------------------------ the floor plan

export const nodeKey = (node) => node.device_id || node.ext_address || node.id;

export function renderFloorplan() {
  const container = document.getElementById('floorplan');
  const st = net.state;
  const plan = st && st.floorplan;
  document.getElementById('floorplan-empty').classList.toggle('d-none', !!plan);
  document.getElementById('floorplan-remove').classList.toggle('d-none', !plan);
  document.getElementById('floorplan-choose-label').textContent = plan ? 'Replace the picture' : 'Choose a picture';
  if (!plan) document.getElementById('place-list').classList.add('d-none');
  renderHeatmapNote();
  if (!plan || net.view !== 'floorplan') {
    container.querySelectorAll('.floorplan-stage').forEach((e) => e.remove());
    return;
  }
  const img = new Image();
  img.src = `/api/network/floorplan?t=${plan.time}`;
  img.addEventListener('load', () => {
    container.querySelectorAll('.floorplan-stage').forEach((e) => e.remove());
    const stage = h('div', { class: 'floorplan-stage' });
    container.append(stage);
    drawFloorplanNodes(stage, img);
  });
}

// How light the picture is, from 0 (black) to 1 (white): a plan drawn light on dark (a dark-mode
// screenshot) or dark on light (an architect's drawing) is shown inverted when it doesn't match the theme.
const lightness = new WeakMap();
function pictureLightness(img) {
  if (!lightness.has(img)) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0, 48, 48);
    const data = context.getImageData(0, 0, 48, 48).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    lightness.set(img, sum / (data.length / 4));
  }
  return lightness.get(img);
}

// The picture as large as the map's space allows, but no more than twice its own size: a small
// screenshot stretched further only gets blurrier (zoom in to see detail).
function planSize(stage, img) {
  const aspect = img.naturalHeight / img.naturalWidth;
  const style = getComputedStyle(stage);  // its padding keeps the picture clear of the toolbar and the legend
  const room = { w: Math.max(200, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
    h: Math.max(200, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) };
  const W = Math.round(Math.min(room.w, room.h / aspect, img.naturalWidth * 2));
  return { W, H: Math.round(W * aspect) };
}

// On the floor plan, your boards are small pins (their photo above the spot they mark), the
// other nodes their circle on the spot itself. PIN_LIFT: how far above its spot a pin's photo sits.
export const PIN_LIFT = 26;

export function floorShape(node, quality) {
  if (node.device_id) {
    const R = 13;
    const body = `M0,0 C-5,-8 -${R},-${PIN_LIFT - R * 0.6} -${R},-${PIN_LIFT} A${R},${R} 0 1 1 ${R},-${PIN_LIFT} ` +
      `C${R},-${PIN_LIFT - R * 0.6} 5,-8 0,0Z`;
    return { lift: PIN_LIFT, chipY: 5, el: svg('g', { class: 'pin' }, svg('path', { class: 'pin-body', d: body }),
      svg('g', { transform: `translate(0,-${PIN_LIFT})` }, boardAvatar(node, 8.5))) };
  }
  const shape = nodeShape(node, node.border_router ? 0.6 : 0.75, quality);
  return { lift: 0, chipY: shape.r + 4, el: shape.el };
}

export function drawFloorplanNodes(stage, img) {
  const topology = shownTopology();
  stage.querySelector(':scope > svg')?.remove();
  stage.querySelector('.floorplan-hint')?.remove();
  const placeList = document.getElementById('place-list');
  if (!topology) {
    placeList.classList.add('d-none');
    stage.append(h('div', { class: 'floorplan-hint' }, 'Read the network first: the nodes come from it.'));
    return;
  }
  const tree = meshTree(topology);
  const positions = net.state.positions || {};
  const unplaced = topology.nodes.filter((node) => !positions[nodeKey(node)]);
  // The list of nodes to place sits above the picture: lay it out first, then size the picture to the room left
  renderPlaceList(placeList, unplaced, stage, img);
  const size = planSize(stage, img);
  if (!net.floorplanSize || net.floorplanSize.W !== size.W) net.zoom.floorplan = null;  // a zoom in other units
  net.floorplanSize = size;
  const { W, H } = size;  // map units are screen pixels at the full view
  const points = new Map();
  for (const node of topology.nodes) {
    const p = positions[nodeKey(node)];
    if (p) points.set(String(node.id), { x: p.x * W, y: p.y * H, placed: true });
  }
  const quality = (id) => { const way = wayLink(tree, id); return way ? linkStrength(way).quality : undefined; };
  const shapes = new Map(topology.nodes.map((node) => [String(node.id), floorShape(node, quality(String(node.id)))]));
  // Links start where each node is drawn: a pin's photo, a router's circle. Only the one in focus
  // shows its way to the border router (or every link, with "all links").
  const anchor = (id) => { const p = points.get(id); return { x: p.x, y: p.y - shapes.get(id).lift }; };
  const links = topology.links.filter((l) => points.has(String(l.a)) && points.has(String(l.b))).map((link) => {
    const a = String(link.a), b = String(link.b);
    const strength = linkStrength(link);
    const color = strength.quality === null ? 'var(--t-text-muted)' : qualityColors[strength.quality];
    const key = linkKey(a, b);
    return svg('g', { class: `link-group ${tree.primary.has(key) ? 'primary' : 'spare'}`, 'data-key': key, 'data-a': a, 'data-b': b },
      svg('path', { class: 'link plan-link', d: linkPath(anchor(a), anchor(b), 0.12), style: `stroke: ${color}`,
        'stroke-width': Math.max(1.5, strength.width * 0.7) }, svg('title', {}, strength.text)));
  });
  const box = [0, 0, W, H];
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const invert = (pictureLightness(img) > 0.5) === dark;
  const drawing = svg('svg', { viewBox: (net.zoom.floorplan || box).join(' '), width: W, height: H,
    preserveAspectRatio: 'xMidYMid meet', class: `plan${invert ? ' invert' : ''}${net.allLinks ? ' all-links' : ''}${net.allNames ? ' all-names' : ''}` },
    svg('image', { href: img.src, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'floorplan-picture' }),
    svg('rect', { x: 0, y: 0, width: W, height: H, class: 'plan-dim' }),
    net.heatmap ? heatmapLayer(topology, points, [0, 0, W, H], Math.max(W, H) * 0.3, false) : null,
    svg('g', { class: 'links' }, links));
  const toMap = (clientX, clientY) => {
    const point = drawing.createSVGPoint();
    point.x = clientX; point.y = clientY;
    return point.matrixTransform(drawing.getScreenCTM().inverse());
  };
  const save = async (node, at) => {
    const off = !at || at.x < 0 || at.y < 0 || at.x > W || at.y > H;  // dropped off the picture: unplaced
    const body = off ? { x: null, y: null } : { x: at.x / W, y: at.y / H };
    await api('PUT', `/api/network/positions/${encodeURIComponent(nodeKey(node))}`, body).catch(() => {});
    net.state.positions = net.state.positions || {};
    if (off) delete net.state.positions[nodeKey(node)]; else net.state.positions[nodeKey(node)] = body;
    drawFloorplanNodes(stage, img);
  };
  for (const node of topology.nodes.filter((n) => points.has(String(n.id)))) {
    const id = String(node.id);
    const p = points.get(id);
    const shape = shapes.get(id);
    // Names show for the node pointed at or selected, and its way (always for your boards with "all names")
    const group = svg('g', { class: `node${node.device_id ? ' board' : ''}${shownName(node) ? ' named' : ''}`, transform: `translate(${p.x},${p.y})`,
      'data-device': node.device_id || null, 'data-node': id, tabindex: 0, role: 'button', 'aria-label': nodeLabel(node) },
    svg('circle', { r: 16, cy: -shape.lift, class: 'select-ring' }),
    shape.el, nameChip(nodeLabel(node), shape.chipY, node.device_id ? 'board' : ''),
    svg('title', {}, `${nodeLabel(node)}: drag it where it is (off the picture to take it off the plan)`));
    nodeEvents(group, id);
    let start = null;
    group.addEventListener('pointerdown', (event) => {
      group.setPointerCapture(event.pointerId);
      start = { x: event.clientX, y: event.clientY, moved: false };
    });
    group.addEventListener('pointermove', (event) => {
      if (!start) return;
      if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;  // a click, so far
      start.moved = true;
      const q = toMap(event.clientX, event.clientY);
      p.x = q.x; p.y = q.y;
      group.setAttribute('transform', `translate(${p.x},${p.y})`);
      group.classList.toggle('leaving', q.x < 0 || q.y < 0 || q.x > W || q.y > H);
    });
    group.addEventListener('pointerup', () => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      if (!moved) return selectNode(id, true);
      save(node, p);
    });
    drawing.append(group);
  }
  stage.append(drawing);
  // In until each of the picture's pixels is 4 screen pixels (at least 3×): beyond, it's only blur
  enableZoom(stage, drawing, box, 'floorplan', { maxIn: Math.max(3, 4 * img.naturalWidth / W), maxOut: 1 });
  stage.dropOnPlan = (node, x, y) => {
    const rect = drawing.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    save(node, toMap(x, y));
  };
  applyFocus();
}

// The nodes not on the plan yet, as chips to drag onto it.
function renderPlaceList(placeList, unplaced, stage) {
  placeList.classList.toggle('d-none', !unplaced.length);
  unplaced.sort((a, b) => (b.device_id ? 1 : 0) - (a.device_id ? 1 : 0) || nodeLabel(a).localeCompare(nodeLabel(b)));
  placeList.replaceChildren(h('span', { class: 'place-title' }, 'Drag onto the plan:'), ...unplaced.map((node) => {
    const device = node.device_id ? state.devices.get(node.device_id) : null;
    const chip = h('button', { class: `place-chip${node.device_id ? ' board' : ''}`, type: 'button', title: 'Drag it onto the plan' },
      device && device.photo ? h('img', { src: photoUrl(device), alt: '' })
        : svg('svg', { class: 'place-icon', viewBox: '-14 -14 28 28' }, node.device_id
          ? svg('use', { href: '#hacoap-glyph', x: -11, y: -11, width: 22, height: 22 })
          : nodeShape(node, 0.6).el),
      nodeLabel(node));
    chip.addEventListener('pointerdown', (event) => dragOntoPlan(event, chip, (x, y) => stage.dropOnPlan && stage.dropOnPlan(node, x, y)));
    return chip;
  }));
}

// Dragging a chip from the list: a copy follows the pointer, and dropping calls drop(x, y).
export function dragOntoPlan(event, chip, drop) {
  event.preventDefault();
  const ghost = chip.cloneNode(true);
  ghost.classList.add('place-ghost');
  document.body.append(ghost);
  const follow = (e) => { ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`; };
  follow(event);
  const up = (e) => {
    document.removeEventListener('pointermove', follow);
    document.removeEventListener('pointerup', up);
    ghost.remove();
    drop(e.clientX, e.clientY);
  };
  document.addEventListener('pointermove', follow);
  document.addEventListener('pointerup', up);
}

// ------------------------------------------------------------------ channels

export function renderChannelScan(scan) {
  const container = document.getElementById('channel-scan-result');
  if (!scan || !scan.channels || !scan.channels.length) return;
  const W = 320, H = 120, bar = W / scan.channels.length;
  const height = (rssi) => Math.max(2, Math.min(H - 18, ((rssi + 100) / 60) * (H - 18)));
  const color = (rssi) => rssi < -85 ? 'var(--t-green)' : rssi < -70 ? 'var(--t-yellow)' : 'var(--t-red)';
  const bars = scan.channels.map((c, i) => svg('g', {},
    svg('rect', { x: i * bar + 2, y: H - 14 - height(c.max_rssi), width: bar - 4, height: height(c.max_rssi),
      style: `fill: ${color(c.max_rssi)}`, class: c.channel === scan.current_channel ? 'current' : null },
    svg('title', {}, `channel ${c.channel}: up to ${c.max_rssi} dBm, average ${c.average_rssi} dBm`)),
    svg('text', { x: i * bar + bar / 2, y: H - 2, 'text-anchor': 'middle', class: `axis${c.channel === scan.current_channel ? ' current-label' : ''}` }, c.channel)));
  const quiet = [...scan.channels].sort((a, b) => a.max_rssi - b.max_rssi).slice(0, 3).map((c) => c.channel);
  const current = scan.channels.find((c) => c.channel === scan.current_channel);
  container.replaceChildren(
    svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scan' }, ...bars),
    h('p', { class: 'mb-1' }, scan.current_channel ? `Your network uses channel ${scan.current_channel}` +
      (current ? ` (noise up to ${current.max_rssi} dBm).` : '.') : ''),
    h('p', { class: 'mb-1' }, `Quietest: ${quiet.join(', ')}. Taller bars are noisier; Wi-Fi channels 1, 6 and 11 cover Thread channels 11–14, 16–19 and 21–24.`),
    h('p', { class: 'text-body-secondary mb-0' }, `Scanned ${ago(scan.time)}. Changing the channel is done on the border router, and moves the whole network.`));
}

document.getElementById('channel-scan').addEventListener('click', (event) => busy(event.target, async () => {
  showMore('channels');
  renderChannelScan(await api('POST', '/api/network/channel-scan'));
}));
