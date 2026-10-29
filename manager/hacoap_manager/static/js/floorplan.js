// The Network tab's floor plan, and the channel scan.

import { ago, api, busy, h, notify, photoUrl, state, svg } from './core.js';
import { boardAvatar, enableZoom, heatmapLayer, linkPath, linkStrength, loadNetwork, nameChip, net, nodeLabel, nodeShape, qualityColors, renderHeatmapNote, showNodeDetails, shownName, shownTopology } from './network.js';

// ------------------------------------------------------------------ network: floor plan and channels


export function setNetworkView(view) {
  net.view = view;
  document.getElementById('view-mesh').classList.toggle('active', view === 'mesh');
  document.getElementById('view-floorplan').classList.toggle('active', view === 'floorplan');
  document.getElementById('network-canvas').classList.toggle('d-none', view !== 'mesh');
  document.getElementById('floorplan').classList.toggle('d-none', view !== 'floorplan');
  document.getElementById('floorplan-tools').classList.toggle('d-none', view !== 'floorplan');
  renderHeatmapNote();
  if (view === 'floorplan') renderFloorplan();
}

document.getElementById('view-mesh').addEventListener('click', () => setNetworkView('mesh'));
document.getElementById('view-floorplan').addEventListener('click', () => setNetworkView('floorplan'));

export const nodeKey = (node) => node.device_id || node.ext_address || node.id;

export function renderFloorplan() {
  const container = document.getElementById('floorplan');
  const st = net.state;
  const plan = st && st.floorplan;
  container.querySelectorAll('.floorplan-stage').forEach((e) => e.remove());
  document.getElementById('floorplan-empty').classList.toggle('d-none', !!plan);
  document.getElementById('floorplan-remove').classList.toggle('d-none', !plan);
  if (!plan) document.getElementById('place-list').classList.add('d-none');
  renderHeatmapNote();
  if (!plan || net.view !== 'floorplan') return;
  const img = new Image();
  img.src = `/api/network/floorplan?t=${plan.time}`;
  const stage = h('div', { class: 'floorplan-stage' });
  container.append(stage);
  img.addEventListener('load', () => {
    // Shown as large as fits, but no taller than 75 % of the window or twice the picture's own
    // height: a small screenshot stretched further only gets blurrier (zoom in to see detail).
    const aspect = img.naturalHeight / img.naturalWidth;
    const maxHeight = Math.min(window.innerHeight * 0.75, img.naturalHeight * 2);
    const W = Math.round(Math.min(stage.clientWidth || 1000, maxHeight / aspect));
    const size = { W, H: Math.round(W * aspect) };
    if (!net.floorplanSize || net.floorplanSize.W !== size.W) net.zoom.floorplan = null;  // a zoom in other units
    net.floorplanSize = size;
    drawFloorplanNodes(stage, img);
  });
}

// On the floor plan, your boards are pins (their photo above the spot they mark), the routers
// icons on the spot itself. PIN_LIFT: how far above its spot a pin's photo sits.
export const PIN_LIFT = 32;

export function floorShape(node) {
  if (node.device_id) {
    const R = 17;
    const body = `M0,0 C-6,-10 -${R},-${PIN_LIFT - R * 0.6} -${R},-${PIN_LIFT} A${R},${R} 0 1 1 ${R},-${PIN_LIFT} ` +
      `C${R},-${PIN_LIFT - R * 0.6} 6,-10 0,0Z`;
    return { lift: PIN_LIFT, chipY: 5, el: svg('g', { class: 'pin' }, svg('path', { class: 'pin-body', d: body }),
      svg('g', { transform: `translate(0,-${PIN_LIFT})` }, boardAvatar(node, 11))) };
  }
  const shape = nodeShape(node, 0.8);
  return { lift: 0, chipY: shape.r + 4, el: shape.el };
}

export function drawFloorplanNodes(stage, img) {
  const topology = shownTopology();
  stage.querySelector('svg')?.remove();
  stage.querySelector('.floorplan-hint')?.remove();
  const placeList = document.getElementById('place-list');
  if (!topology) {
    placeList.classList.add('d-none');
    stage.append(h('div', { class: 'floorplan-hint' }, 'Read the network first: the nodes come from it.'));
    return;
  }
  const { W, H } = net.floorplanSize;  // map units are screen pixels at the full view
  const positions = net.state.positions || {};
  const points = new Map();
  const unplaced = [];
  for (const node of topology.nodes) {
    const p = positions[nodeKey(node)];
    if (p) points.set(node.id, { x: p.x * W, y: p.y * H, placed: true });
    else unplaced.push(node);
  }
  const shapes = new Map(topology.nodes.map((node) => [node.id, floorShape(node)]));
  // Links start where each node is drawn: a pin's photo, a router's icon
  const anchor = (id) => { const p = points.get(id); return { x: p.x, y: p.y - shapes.get(id).lift }; };
  const links = net.showLinks ? topology.links.filter((l) => points.has(l.a) && points.has(l.b)).map((link) => {
    const strength = linkStrength(link);
    const color = strength.quality === null ? 'var(--t-text-muted)' : qualityColors[strength.quality];
    return svg('path', { class: `link plan-link ${link.kind}`, d: linkPath(anchor(link.a), anchor(link.b), 0.12),
      style: `stroke: ${color}`, 'stroke-width': Math.max(1.5, strength.width * 0.7), 'data-a': link.a, 'data-b': link.b },
    svg('title', {}, strength.text));
  }) : [];
  const box = [0, 0, W, H];
  const drawing = svg('svg', { viewBox: (net.zoom.floorplan || box).join(' '), width: W, height: H,
    preserveAspectRatio: 'xMidYMid meet', class: 'plan' },
    svg('image', { href: img.src, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'floorplan-picture' }),
    svg('rect', { x: 0, y: 0, width: W, height: H, class: 'plan-dim' }),
    net.heatmap ? heatmapLayer(topology, points, [0, 0, W, H]) : null,
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
  for (const node of topology.nodes.filter((n) => points.has(n.id))) {
    const p = points.get(node.id);
    const shape = shapes.get(node.id);
    const group = svg('g', { class: `node${node.device_id ? ' board' : ''}`, transform: `translate(${p.x},${p.y})`,
      'data-device': node.device_id || null, tabindex: 0, role: 'button', 'aria-label': nodeLabel(node),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          showNodeDetails(node, true);
        }
      } },
      shape.el, shownName(node) ? nameChip(nodeLabel(node), shape.chipY, node.device_id ? 'board' : '') : null,
      svg('title', {}, `${nodeLabel(node)}: drag it where it is (off the picture to take it off the plan)`));
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
      if (!moved) return showNodeDetails(node, true);
      save(node, p);
    });
    drawing.append(group);
  }
  stage.append(drawing);
  // In until each of the picture's pixels is 4 screen pixels (at least 3×): beyond, it's only blur
  enableZoom(stage, drawing, box, 'floorplan', { maxIn: Math.max(3, 4 * img.naturalWidth / W), maxOut: 1 });

  // The nodes not on the plan yet, as chips to drag onto it
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
    chip.addEventListener('pointerdown', (event) => dragOntoPlan(event, chip, (x, y) => {
      const rect = drawing.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      save(node, toMap(x, y));
    }));
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

document.getElementById('floorplan-upload').addEventListener('click', (event) => busy(event.target, async () => {
  const file = document.getElementById('floorplan-file').files[0];
  if (!file) return notify('Choose a picture first', 'warning');
  await api('POST', `/api/network/floorplan?name=${encodeURIComponent(file.name)}`, file);
  document.getElementById('floorplan-file').value = '';
  await loadNetwork();
}));

document.getElementById('floorplan-remove').addEventListener('click', async () => {
  if (!confirm('Remove the floor plan picture? The positions are kept.')) return;
  await api('DELETE', '/api/network/floorplan').catch(() => {});
  await loadNetwork();
});

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
  renderChannelScan(await api('POST', '/api/network/channel-scan'));
}));
