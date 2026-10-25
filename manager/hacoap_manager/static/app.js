// HA-CoAP Fleet Manager: the page. Plain JavaScript, no build step.
// Text from devices and from the user is only ever inserted as text (textContent), never as HTML.

const state = { devices: new Map(), selected: new Set(), images: [], jobs: new Map(), status: null };

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(method, path, body, options = {}) {
  const init = { method, headers: {} };
  if (method !== 'GET') init.headers['X-HACoap'] = '1';
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
    init.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || response.statusText);
    if (!options.quiet) notify(detail, 'danger');
    throw new Error(detail);
  }
  return data;
}

function notify(message, kind = 'info', timeout = 6000) {
  const alert = h('div', { class: `alert alert-${kind} alert-dismissible fade show`, role: 'alert' },
    message, h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'alert' }));
  document.getElementById('alerts').append(alert);
  if (timeout) setTimeout(() => alert.remove(), timeout);
}

async function busy(button, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = label.replace(/…$/, '') + '…';
  try { return await work(); } catch (error) { return undefined; } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function ago(seconds) {
  if (!seconds) return 'never';
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

const when = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString() : '';
const pct = (value) => (value === null || value === undefined) ? '–' : `${value} %`;
const shortHash = (hash) => hash ? hash.slice(0, 8) : '';

// ------------------------------------------------------------------ tabs

function showTab(name) {
  for (const link of document.querySelectorAll('#tabs .nav-link')) link.classList.toggle('active', link.dataset.tab === name);
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('d-none', section.id !== `tab-${name}`);
  if (name === 'updates') { renderUpdateForm(); loadHistory(); }
  if (name === 'images') { loadImages(); loadBuilds(); }
  if (name === 'builds') loadBuildsTab();
  if (name === 'network') loadNetwork();
  if (name === 'settings') { loadSettings(); loadBackups(); }
}

for (const link of document.querySelectorAll('#tabs .nav-link')) {
  link.addEventListener('click', (event) => { event.preventDefault(); history.replaceState(null, '', `#${link.dataset.tab}`); showTab(link.dataset.tab); });
}

// ------------------------------------------------------------------ devices

async function loadDevices() {
  const devices = await api('GET', '/api/devices');
  state.devices = new Map(devices.map((d) => [d.device_id, d]));
  for (const id of [...state.selected]) if (!state.devices.has(id)) state.selected.delete(id);
  renderDevices();
}

function deviceName(device) { return device.name || device.device_id; }

function renderDevices() {
  const body = document.querySelector('#devices-table tbody');
  body.replaceChildren(...[...state.devices.values()].map(deviceRow));
  document.getElementById('devices-empty').classList.toggle('d-none', state.devices.size > 0);
  const count = state.selected.size;
  document.getElementById('selection-count').textContent = count ? `${count} selected` : '';
  document.getElementById('update-selected').disabled = count === 0;
  async function showDeviceHistory(device) {
  document.getElementById('slots-title').textContent = `Update history: ${deviceName(device)}`;
  const body = document.getElementById('slots-body');
  body.replaceChildren(h('p', {}, 'Loading…'));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('slots-modal')).show();
  const rows = await api('GET', `/api/history?device_id=${encodeURIComponent(device.device_id)}`);
  body.replaceChildren(rows.length ? h('table', { class: 'table table-sm' },
    h('thead', {}, h('tr', {}, ['Finished', 'Via', 'Image', 'Result', 'Message'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { class: 'small' }, when(r.finished)),
      h('td', {}, r.transport === 'serial' ? 'USB' : 'air'), h('td', {}, `v${r.image_version} · ${shortHash(r.image_hash)}`),
      h('td', {}, h('span', { class: `badge text-bg-${statusClass[r.result] || 'secondary'}` }, r.result)),
      h('td', { class: 'small' }, r.message)))))
    : h('p', { class: 'text-body-secondary' }, 'No updates yet.'));
}

document.getElementById('select-all').checked = count > 0 && count === state.devices.size;
}

function deviceRow(device) {
  const id = device.device_id;
  const firmware = h('td', {},
    h('span', { class: 'mono', title: 'Git commit of the firmware' }, device.fw_version || '–'),
    device.image_version ? h('div', { class: 'small text-body-secondary', title: `Image ${device.image_hash}` },
      `v${device.image_version} · ${shortHash(device.image_hash)}`) : null);
  const action = (label, handler) => h('li', {}, h('a', { class: 'dropdown-item', href: '#', onclick: (e) => { e.preventDefault(); handler(device); } }, label));
  return h('tr', { 'data-id': id },
    h('td', {}, h('input', { class: 'form-check-input', type: 'checkbox', checked: state.selected.has(id),
      onchange: (e) => { e.target.checked ? state.selected.add(id) : state.selected.delete(id); renderDevices(); } })),
    h('td', {}, deviceName(device), device.notes ? h('div', { class: 'small text-body-secondary' }, device.notes) : null),
    h('td', { class: 'mono' }, id),
    h('td', { class: 'mono small' }, device.address || '–'),
    firmware,
    h('td', { class: 'text-end' }, pct(device.battery)),
    h('td', { class: 'text-end' }, pct(device.soil_moisture)),
    h('td', { class: 'text-end' }, pct(device.air_humidity)),
    h('td', { class: 'text-end' }, (device.temperature === null || device.temperature === undefined) ? '–' : `${device.temperature} °C`),
    h('td', { title: device.last_error || '' },
      h('span', { class: `online-dot ${device.online ? 'on' : 'off'}` }), ago(device.last_seen),
      device.last_error ? h('div', { class: 'small text-danger' }, device.last_error) : null),
    h('td', {}, h('div', { class: 'dropdown' },
      h('button', { class: 'btn btn-sm btn-outline-secondary dropdown-toggle', 'data-bs-toggle': 'dropdown' }, 'Actions'),
      h('ul', { class: 'dropdown-menu dropdown-menu-end' },
        action('Refresh', refreshDevice),
        action('Firmware slots', showSlots),
        action('Update history', showDeviceHistory),
        action('Beep (ping)', pingDevice),
        action('Rename…', renameDevice),
        action('Notes…', editNotes),
        h('li', {}, h('hr', { class: 'dropdown-divider' })),
        action('Remove from the list', removeDevice)))));
}

async function refreshDevice(device) {
  const updated = await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/refresh`).catch(() => null);
  if (updated && updated.last_error) notify(`${deviceName(device)}: ${updated.last_error}`, 'warning');
}

async function pingDevice(device) {
  await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/ping`).then(
    () => notify(`${deviceName(device)} beeped`, 'success', 3000), () => {});
}

async function renameDevice(device) {
  const name = prompt('Name', deviceName(device));
  if (name === null) return;
  await api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, { name }).catch(() => {});
}

async function editNotes(device) {
  const notes = prompt('Notes (location, plant, ...)', device.notes || '');
  if (notes === null) return;
  await api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, { notes }).catch(() => {});
}

async function removeDevice(device) {
  if (!confirm(`Remove ${deviceName(device)} from the list? It stays on the network and comes back with Find devices.`)) return;
  await api('DELETE', `/api/devices/${encodeURIComponent(device.device_id)}`).catch(() => {});
  state.selected.delete(device.device_id);
  await loadDevices();
}

async function showSlots(device) {
  const body = document.getElementById('slots-body');
  document.getElementById('slots-title').textContent = `Firmware slots: ${deviceName(device)}`;
  body.replaceChildren(h('p', {}, `Asking ${deviceName(device)} over the air… A sleepy device can take a few seconds to answer.`));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('slots-modal')).show();
  let slots;
  try {
    slots = await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/slots`, { transport: 'udp' }, { quiet: true });
  } catch (error) {
    body.replaceChildren(h('div', { class: 'alert alert-danger' }, error.message));
    return;
  }
  const flags = (s) => ['active', 'confirmed', 'pending', 'permanent'].filter((f) => s[f]).join(', ');
  body.replaceChildren(h('table', { class: 'table table-sm' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Slot'), h('th', {}, 'Version'), h('th', {}, 'Hash'), h('th', {}, 'State'))),
    h('tbody', {}, slots.map((s) => h('tr', {},
      h('td', {}, s.slot === 0 ? '0 (running)' : '1 (update)'), h('td', {}, s.version),
      h('td', { class: 'mono small' }, s.hash), h('td', {}, flags(s)))))));
}

document.getElementById('select-all').addEventListener('change', (event) => {
  state.selected = event.target.checked ? new Set(state.devices.keys()) : new Set();
  renderDevices();
});

document.getElementById('discover').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/discover');
  notify(result.found.length ? `Found ${result.found.length} device(s)` :
    'No devices found. Check that this computer is on the same network as the border router.',
  result.found.length ? 'success' : 'warning');
  await loadDevices();
}));

document.getElementById('refresh-all').addEventListener('click', (event) => busy(event.target, async () => {
  await api('POST', '/api/refresh');
  await loadDevices();
}));

document.getElementById('add-device').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('add-address');
  busy(event.submitter, async () => {
    const device = await api('POST', '/api/devices', { address: input.value.trim() });
    notify(`Added ${deviceName(device)}`, 'success', 3000);
    input.value = '';
    await loadDevices();
  });
});

document.getElementById('update-selected').addEventListener('click', () => {
  document.getElementById('transport-udp').checked = true;
  history.replaceState(null, '', '#updates');
  showTab('updates');
});

// ------------------------------------------------------------------ updates

async function renderUpdateForm() {
  state.images = await api('GET', '/api/images');
  const select = document.getElementById('update-image');
  const previous = select.value;
  select.replaceChildren(...(state.images.length ? state.images.map((image) =>
    h('option', { value: image.hash }, `v${image.version} · ${shortHash(image.hash)} · ${image.notes || image.filename}`))
    : [h('option', { value: '' }, 'No images in the library')]));
  if (previous) select.value = previous;
  const names = [...state.selected].map((id) => deviceName(state.devices.get(id) || { device_id: id }));
  document.getElementById('update-selection').textContent = names.length ? names.join(', ') : 'no devices selected';
  if (!document.getElementById('serial-port').options.length) loadPorts();
}

async function loadPorts() {
  const ports = await api('GET', '/api/serial-ports');
  const select = document.getElementById('serial-port');
  select.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.port },
    `${p.port} – ${p.description}${p.board ? ' (board)' : ''}`)) : [h('option', { value: '' }, 'No serial ports')]));
}

document.getElementById('refresh-ports').addEventListener('click', loadPorts);

document.getElementById('update-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const transport = document.querySelector('input[name="update-transport"]:checked').value;
  let targets;
  if (transport === 'serial') {
    const port = document.getElementById('serial-port').value;
    if (!port) return notify('Choose a serial port', 'warning');
    targets = [{ transport: 'serial', serial_port: port }];
  } else {
    if (!state.selected.size) return notify('Select devices on the Devices tab first', 'warning');
    targets = [...state.selected].map((id) => ({ device_id: id, transport: 'udp' }));
  }
  const imageHash = document.getElementById('update-image').value;
  if (!imageHash) return notify('Add an image on the Images tab first', 'warning');
  busy(event.submitter, async () => {
    const job = await api('POST', '/api/updates', {
      image_hash: imageHash, targets, stop_on_failure: document.getElementById('stop-on-failure').checked,
    });
    state.jobs.set(job.id, job);
    renderJobs();
  });
});

const statusClass = {
  queued: 'secondary', running: 'primary', updated: 'success', 'already-current': 'success',
  failed: 'danger', skipped: 'warning', cancelled: 'warning', done: 'success',
};

function renderJobs() {
  const container = document.getElementById('jobs');
  const jobs = [...state.jobs.values()].sort((a, b) => b.created - a.created);
  if (!jobs.length) return;
  container.replaceChildren(...jobs.map((job) => h('div', { class: 'card mb-3 job' },
    h('div', { class: 'card-header d-flex align-items-center gap-2' },
      h('span', {}, `Image v${job.image_version} · ${shortHash(job.image_hash)}`),
      h('span', { class: `badge text-bg-${statusClass[job.state] || 'secondary'}` }, job.state),
      h('span', { class: 'small text-body-secondary' }, when(job.created)),
      job.state === 'running' ? h('button', { class: 'btn btn-sm btn-outline-danger ms-auto',
        onclick: () => api('POST', `/api/updates/${job.id}/cancel`).catch(() => {}) }, 'Cancel the rest') : null),
    h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, job.targets.map((t) => h('tr', {},
      h('td', {}, t.label), h('td', {}, t.transport === 'serial' ? 'USB' : 'air'),
      h('td', {}, h('span', { class: `badge text-bg-${statusClass[t.status] || 'secondary'}` }, t.status)),
      h('td', {}, t.step),
      h('td', {}, t.status === 'running' && t.step === 'uploading' ? h('div', { class: 'progress' },
        h('div', { class: 'progress-bar', style: `width: ${Math.round(t.progress * 100)}%` })) : null),
      h('td', { class: t.status === 'failed' ? 'error-text' : 'small' }, t.message))))))));
}

async function loadJobs() {
  for (const job of await api('GET', '/api/updates')) state.jobs.set(job.id, job);
  renderJobs();
}

async function loadHistory() {
  const rows = await api('GET', '/api/history');
  if (!state.devices.size) await loadDevices();
  document.querySelector('#history-table tbody').replaceChildren(...rows.map((r) => {
    const device = state.devices.get(r.device_id);
    return h('tr', {}, h('td', {}, when(r.finished)), h('td', {}, device ? deviceName(device) : r.device_id),
      h('td', {}, r.transport === 'serial' ? 'USB' : 'air'), h('td', {}, `v${r.image_version} · ${shortHash(r.image_hash)}`),
      h('td', {}, h('span', { class: `badge text-bg-${statusClass[r.result] || 'secondary'}` }, r.result)),
      h('td', { class: 'small' }, r.message));
  }));
}

// ------------------------------------------------------------------ images

async function loadImages() {
  state.images = await api('GET', '/api/images');
  document.querySelector('#images-table tbody').replaceChildren(...state.images.map((image) => h('tr', {},
    h('td', {}, `v${image.version}`), h('td', { class: 'mono small', title: image.hash }, shortHash(image.hash)),
    h('td', {}, `${Math.round(image.size / 1024)} KB`), h('td', { class: 'small' }, when(image.added)),
    h('td', { class: 'small' }, image.notes || image.filename),
    h('td', {}, h('button', { class: 'btn btn-sm btn-outline-danger', onclick: async () => {
      if (!confirm('Delete this image from the library?')) return;
      await api('DELETE', `/api/images/${image.hash}`).catch(() => {});
      loadImages();
    } }, 'Delete')))));
}

async function loadBuilds() {
  const container = document.getElementById('builds');
  const builds = await api('GET', '/api/build-outputs');
  if (!builds.length) {
    container.replaceChildren(h('p', { class: 'text-body-secondary mb-0' },
      'None found. Builds show here when the app runs from the ha-coap-server folder after a build (scripts/build).'));
    return;
  }
  container.replaceChildren(h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, builds.map((b) => h('tr', {},
    h('td', {}, b.variant), h('td', {}, `v${b.version}`), h('td', { class: 'mono small' }, shortHash(b.hash)),
    h('td', { class: 'small' }, when(b.modified)),
    h('td', {}, b.in_library ? h('span', { class: 'text-body-secondary small' }, 'in library') :
      h('button', { class: 'btn btn-sm btn-outline-primary', onclick: async (e) => busy(e.target, async () => {
        await api('POST', `/api/build-outputs/${encodeURIComponent(b.variant)}/import`);
        loadImages(); loadBuilds();
      }) }, 'Add')))))));
}

document.getElementById('upload-image').addEventListener('click', (event) => busy(event.target, async () => {
  const file = document.getElementById('image-file').files[0];
  if (!file) return notify('Choose a file first', 'warning');
  const notes = document.getElementById('image-notes').value;
  const query = new URLSearchParams({ filename: file.name, notes });
  const image = await api('POST', `/api/images?${query}`, file);
  notify(`Added image v${image.version}`, 'success', 3000);
  document.getElementById('image-file').value = '';
  document.getElementById('image-notes').value = '';
  loadImages(); loadBuilds();
}));

// ------------------------------------------------------------------ network

const net = { state: null, positions: new Map(), selected: null, layout: null };
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const nodeStyles = {
  'border router': { r: 18, color: '#212529', label: 'Border router' },
  router: { r: 15, color: '#0d6efd', label: 'Router' },
  'FTD child': { r: 11, color: '#6f42c1', label: 'FTD child (can become a router)' },
  MED: { r: 9, color: '#fd7e14', label: 'MED (end device, always listening)' },
  SED: { r: 9, color: '#198754', label: 'SED (sleepy end device)' },
};
const qualityColors = { 3: '#198754', 2: '#e0a800', 1: '#dc3545', 0: '#dc3545' };

function nodeStyle(node) {
  if (node.border_router) return nodeStyles['border router'];
  return nodeStyles[node.kind] || nodeStyles[node.role === 'child' ? 'SED' : 'router'];
}

function nodeLabel(node) {
  if (node.name) return node.name;
  if (node.border_router) return 'Border router';
  return `${node.kind || node.role || 'node'} ${node.rloc16_hex}`.trim();
}

// How strong a link is: its signal margin (dB) if the border router gives it, else its link
// quality (0-3). Stronger links get shorter lines.
function linkStrength(link) {
  if (link.link_margin !== null && link.link_margin !== undefined) {
    const margin = link.link_margin;
    const quality = margin > 20 ? 3 : margin > 10 ? 2 : margin > 2 ? 1 : 0;
    const rssi = link.average_rssi !== null && link.average_rssi !== undefined ? `, ${link.average_rssi} dBm` : '';
    return { length: Math.max(60, Math.min(320, 330 - margin * 4)), quality, text: `${margin} dB margin${rssi}` };
  }
  const values = [link.link_quality_in, link.link_quality_out].filter((v) => v !== null && v !== undefined);
  if (values.length) {
    const quality = Math.min(...values);
    return { length: { 3: 110, 2: 190, 1: 270, 0: 300 }[quality], quality, text: `link quality ${quality} of 3` };
  }
  return { length: 170, quality: null, text: 'no signal information' };
}

// A small force layout: lines pull their two ends towards their length, nodes push each
// other apart, and the border router stays in the middle.
function layoutNetwork(topology) {
  // Start from where nodes were, else routers on a circle and each child next to its parent,
  // so the forces only have to settle the details.
  const nodes = topology.nodes.map((node) => ({ node, x: 0, y: 0, vx: 0, vy: 0, pinned: node.border_router }));
  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const routers = nodes.filter((n) => !n.node.parent && !n.pinned);
  routers.forEach((n, i) => {
    const angle = (i / Math.max(1, routers.length)) * 2 * Math.PI;
    n.x = Math.cos(angle) * 180; n.y = Math.sin(angle) * 180;
  });
  const childCount = new Map();
  for (const n of nodes.filter((n) => n.node.parent)) {
    const parent = byId.get(n.node.parent) || { x: 0, y: 0 };
    const k = childCount.get(n.node.parent) || 0;
    childCount.set(n.node.parent, k + 1);
    const outward = Math.atan2(parent.y, parent.x) + (k - 1) * 0.7;
    const link = topology.links.find((l) => l.a === n.node.id || l.b === n.node.id);
    const distance = link ? linkStrength(link).length : 120;
    n.x = parent.x + Math.cos(outward) * distance; n.y = parent.y + Math.sin(outward) * distance;
  }
  for (const n of nodes) {
    const known = net.positions.get(n.node.id);
    if (known) { n.x = known.x; n.y = known.y; }
  }
  const springs = topology.links.map((link) => ({ a: byId.get(link.a), b: byId.get(link.b), link, ...linkStrength(link) }))
    .filter((s) => s.a && s.b);
  const fresh = nodes.some((n) => !net.positions.has(n.node.id));
  for (let step = 0, heat = 1; step < (fresh ? 500 : 150); step++, heat *= 0.992) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d2 = Math.max(dx * dx + dy * dy, 25), d = Math.sqrt(d2);
        const force = 6000 / d2;
        dx /= d; dy /= d;
        a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force;
      }
    }
    for (const s of springs) {
      let dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (d - s.length) * 0.08;
      dx /= d; dy /= d;
      s.a.vx += dx * force; s.a.vy += dy * force; s.b.vx -= dx * force; s.b.vy -= dy * force;
    }
    for (const n of nodes) {
      if (n.pinned || n.dragged) { n.vx = n.vy = 0; continue; }
      n.vx -= n.x * 0.002; n.vy -= n.y * 0.002;
      n.x += Math.max(-30, Math.min(30, n.vx * heat)); n.y += Math.max(-30, Math.min(30, n.vy * heat));
      n.vx *= 0.5; n.vy *= 0.5;
    }
  }
  for (const n of nodes) net.positions.set(n.node.id, { x: n.x, y: n.y });
  return { nodes, springs, byId };
}

function renderNetwork() {
  const canvas = document.getElementById('network-canvas');
  const topology = net.state && net.state.topology;
  document.getElementById('network-empty').classList.toggle('d-none', !!topology);
  canvas.querySelector('svg')?.remove();
  document.getElementById('network-warnings').replaceChildren(...((topology && topology.warnings) || []).map((w) =>
    h('div', { class: 'alert alert-warning py-1 small mb-2' }, w)));
  if (!topology) return;

  const layout = net.layout = layoutNetwork(topology);
  const xs = layout.nodes.map((n) => n.x), ys = layout.nodes.map((n) => n.y);
  const pad = 60;
  const box = [Math.min(...xs, -100) - pad, Math.min(...ys, -100) - pad,
    Math.max(...xs, 100) - Math.min(...xs, -100) + 2 * pad, Math.max(...ys, 100) - Math.min(...ys, -100) + 2 * pad];
  const lines = layout.springs.map((s) => {
    const color = s.quality === null ? '#adb5bd' : qualityColors[s.quality];
    const line = svg('line', { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, stroke: color,
      'stroke-width': s.link.kind === 'mesh' ? 3 : 2, 'stroke-dasharray': s.link.kind === 'child' ? '6 4' : null,
      onclick: () => showLinkDetails(s) }, svg('title', {}, s.text));
    s.line = line;
    return line;
  });
  const groups = layout.nodes.map((n) => {
    const style = nodeStyle(n.node);
    const shape = n.node.border_router
      ? svg('rect', { x: -style.r, y: -style.r, width: 2 * style.r, height: 2 * style.r, rx: 4, fill: style.color })
      : svg('circle', { r: style.r, fill: style.color, stroke: n.node.device_id ? '#ffc107' : 'none', 'stroke-width': 3 });
    const group = svg('g', { class: `node${net.selected === n.node.id ? ' selected' : ''}`, transform: `translate(${n.x},${n.y})` },
      shape, svg('text', { y: style.r + 14, 'text-anchor': 'middle' }, nodeLabel(n.node)), svg('title', {}, nodeLabel(n.node)));
    n.group = group;
    makeDraggable(group, n);
    return group;
  });
  const drawing = svg('svg', { viewBox: box.join(' '), preserveAspectRatio: 'xMidYMid meet' }, ...lines, ...groups);
  canvas.append(drawing);

  const counts = { routers: 0, children: 0, sleepy: 0, boards: 0 };
  for (const n of topology.nodes) {
    if (n.kind === 'router' || n.border_router) counts.routers++; else counts.children++;
    if (n.kind === 'SED') counts.sleepy++;
    if (n.device_id) counts.boards++;
  }
  document.getElementById('network-summary').textContent =
    `${counts.routers} router(s), ${counts.children} child(ren) (${counts.sleepy} sleepy), ${counts.boards} of your boards. ` +
    `Read ${ago(topology.fetched)} (${topology.source === 'api' ? 'with signal strength' : 'link quality only'}).`;
}

function makeDraggable(group, n) {
  let moved = false;
  group.addEventListener('pointerdown', (event) => {
    group.setPointerCapture(event.pointerId);
    n.dragged = true;
    moved = false;
  });
  group.addEventListener('pointermove', (event) => {
    if (!n.dragged) return;
    const point = group.ownerSVGElement.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const p = point.matrixTransform(group.ownerSVGElement.getScreenCTM().inverse());
    n.x = p.x; n.y = p.y; moved = true;
    group.setAttribute('transform', `translate(${n.x},${n.y})`);
    for (const s of net.layout.springs) {
      if (s.a === n) { s.line.setAttribute('x1', n.x); s.line.setAttribute('y1', n.y); }
      if (s.b === n) { s.line.setAttribute('x2', n.x); s.line.setAttribute('y2', n.y); }
    }
    net.positions.set(n.node.id, { x: n.x, y: n.y });
  });
  group.addEventListener('pointerup', () => {
    n.dragged = false;
    if (!moved) showNodeDetails(n.node);
  });
}

function detailsTable(rows) {
  return h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, rows.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => h('tr', {}, h('th', { class: 'fw-normal text-body-secondary' }, k), h('td', { class: 'text-break' }, v)))));
}

function showNodeDetails(node) {
  net.selected = node.id;
  for (const n of net.layout.nodes) n.group.classList.toggle('selected', n.node.id === node.id);
  const topology = net.state.topology;
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const links = topology.links.filter((l) => l.a === node.id || l.b === node.id).map((l) => {
    const other = nodes.get(l.a === node.id ? l.b : l.a);
    return h('li', {}, `${other ? nodeLabel(other) : '?'}: ${linkStrength(l).text}`);
  });
  document.getElementById('network-details').replaceChildren(
    h('h6', {}, nodeLabel(node)),
    detailsTable([
      ['Board', node.device_id ? `${node.name} (${node.device_id})` : ''],
      ['Role', node.border_router ? `border router, ${node.role}` : node.role],
      ['Type', node.kind],
      ['RLOC16', node.rloc16_hex],
      ['Extended address', node.ext_address],
      ['Parent', node.parent && nodes.get(node.parent) ? nodeLabel(nodes.get(node.parent)) : ''],
      ['Child timeout', node.timeout ? `${node.timeout} s` : ''],
      ['Host name', node.hostname],
      ['IPv6', node.ipv6.join(', ')],
    ]),
    links.length ? h('div', { class: 'mt-2' }, h('b', {}, 'Links'), h('ul', { class: 'mb-0 ps-3' }, links)) : null);
}

function showLinkDetails(spring) {
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

function renderNetworkLegend() {
  const kinds = ['border router', 'router', 'FTD child', 'MED', 'SED'].map((k) => [nodeStyles[k].color, nodeStyles[k].label]);
  document.getElementById('network-legend').replaceChildren(
    ...kinds.flatMap(([color, label]) => [h('span', { class: 'legend-swatch', style: `background:${color}` }), label]),
    h('span', { class: 'legend-swatch', style: 'background:#fff;border:3px solid #ffc107' }), 'your board',
    h('div', { class: 'mt-1' }, 'Solid lines: router to router. Dashed: child to its parent. Green, amber, red: strong, ',
      'fair, weak. Shorter lines are stronger links: it shows radio closeness, not distance (walls and antennas count). ',
      'Your boards never link to each other: each one talks only to its parent. Drag nodes to tidy up.'));
}

async function loadNetwork() {
  net.state = await api('GET', '/api/network');
  document.getElementById('border-router-url').value = net.state.border_router_url || '';
  renderNetwork();
  renderNetworkLegend();
  document.getElementById('network-events').replaceChildren(...(net.state.events.length
    ? net.state.events.map((e) => h('li', { class: 'mb-1' }, h('span', { class: 'text-body-secondary' }, `${when(e.time)} `), e.message))
    : [h('li', { class: 'text-body-secondary' }, 'No changes seen yet. Boards changing parent show here.')]));
}

document.getElementById('network-refresh').addEventListener('click', (event) => busy(event.target, async () => {
  net.state = await api('POST', '/api/network/refresh');
  await loadNetwork();
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

// ------------------------------------------------------------------ builds

const builds = { schema: [], variants: [], profiles: [], profile: null, buildId: null };

async function loadBuildsTab() {
  const [schema, profiles, checks, history] = await Promise.all([
    api('GET', '/api/kconfig'), api('GET', '/api/profiles'), api('GET', '/api/build-checks'), api('GET', '/api/firmware-builds')]);
  builds.schema = schema.schema;
  builds.variants = schema.variants;
  builds.profiles = profiles;
  const select = document.getElementById('profile-select');
  const keep = builds.profile ? builds.profile.name : (profiles[0] && profiles[0].name);
  select.replaceChildren(...profiles.map((p) => h('option', { value: p.name }, p.name)));
  if (keep && profiles.some((p) => p.name === keep)) select.value = keep;
  document.getElementById('profile-variant').replaceChildren(...builds.variants.map((v) => h('option', { value: v }, v)));
  showProfile(select.value);
  renderChecks(checks);
  renderBuildHistory(history);
  const running = history.find((b) => b.result === 'running');
  if (running) showBuildLog(running.id);
}

function showProfile(name) {
  builds.profile = builds.profiles.find((p) => p.name === name) || null;
  const container = document.getElementById('profile-settings');
  if (!builds.profile) { container.replaceChildren(h('p', {}, 'No profile.')); return; }
  document.getElementById('profile-variant').value = builds.profile.variant;
  document.getElementById('profile-notes').value = builds.profile.notes || '';
  const groups = new Map();
  for (const symbol of builds.schema) {
    if (!groups.has(symbol.menu)) groups.set(symbol.menu, []);
    groups.get(symbol.menu).push(symbol);
  }
  container.replaceChildren(...[...groups.entries()].map(([menu, symbols]) =>
    h('fieldset', {}, h('legend', {}, menu), h('div', { class: 'row g-3' }, symbols.map(settingField)))));
  updateChangeCount();
}

function defaultText(symbol) {
  if (symbol.type === 'bool') return symbol.default ? 'yes' : 'no';
  if (symbol.type === 'choice') return (symbol.options.find((o) => o.name === symbol.default) || {}).prompt || symbol.default;
  return String(symbol.default);
}

function settingField(symbol) {
  const value = builds.profile.settings[symbol.name];
  const id = `setting-${symbol.name}`;
  let input;
  if (symbol.type === 'int') {
    input = h('input', { class: 'form-control', type: 'number', step: 1, id, placeholder: defaultText(symbol),
      min: symbol.range ? symbol.range[0] : null, max: symbol.range ? symbol.range[1] : null,
      value: value === undefined ? null : value });
  } else if (symbol.type === 'string') {
    input = h('input', { class: 'form-control', id, placeholder: defaultText(symbol), maxlength: 64,
      value: value === undefined ? null : value });
  } else {
    const options = symbol.type === 'bool' ? [{ name: 'true', prompt: 'Yes' }, { name: 'false', prompt: 'No' }] : symbol.options;
    input = h('select', { class: 'form-select', id },
      h('option', { value: '' }, `Default (${defaultText(symbol)})`),
      options.map((o) => h('option', { value: o.name, selected: value !== undefined && String(value) === o.name }, o.prompt)));
  }
  input.dataset.symbol = symbol.name;
  input.addEventListener('input', updateChangeCount);
  const dependency = symbol.depends_on ? builds.schema.flatMap((s) => s.options || []).find((o) => o.name === symbol.depends_on) : null;
  return h('div', { class: 'col-md-6' },
    h('label', { class: 'form-label small', for: id, title: `CONFIG_${symbol.name}` }, symbol.prompt),
    input,
    symbol.help ? h('div', { class: 'form-text' }, symbol.help) : null,
    dependency ? h('div', { class: 'form-text fst-italic' }, `Only used with: ${dependency.prompt}`) : null);
}

function profileSettings() {
  const settings = {};
  for (const input of document.querySelectorAll('#profile-settings [data-symbol]')) {
    if (input.value === '') continue;
    const symbol = builds.schema.find((s) => s.name === input.dataset.symbol);
    settings[symbol.name] = symbol.type === 'int' ? Number(input.value) : symbol.type === 'bool' ? input.value === 'true' : input.value;
  }
  return settings;
}

function updateChangeCount() {
  let count = 0;
  for (const input of document.querySelectorAll('#profile-settings [data-symbol]')) {
    input.classList.toggle('setting-changed', input.value !== '');
    if (input.value !== '') count++;
  }
  document.getElementById('profile-changes').textContent =
    count ? `${count} setting(s) changed from the firmware's defaults` : 'All settings at the firmware\'s defaults';
}

async function saveProfile(name, variant, settings, notes) {
  const saved = await api('PUT', `/api/profiles/${encodeURIComponent(name)}`, { variant, settings, notes });
  builds.profile = saved;
  await loadBuildsTab();
  return saved;
}

document.getElementById('profile-select').addEventListener('change', (e) => showProfile(e.target.value));

document.getElementById('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!builds.profile) return;
  busy(event.submitter, async () => {
    await saveProfile(builds.profile.name, document.getElementById('profile-variant').value, profileSettings(),
      document.getElementById('profile-notes').value);
    notify('Profile saved', 'success', 2000);
  });
});

document.getElementById('profile-new').addEventListener('click', async () => {
  const name = prompt('Name of the new profile (for example "Greenhouse" or "Debug logs")');
  if (!name) return;
  await saveProfile(name.trim(), 'battery', {}, '').catch(() => {});
});

document.getElementById('profile-copy').addEventListener('click', async () => {
  if (!builds.profile) return;
  const name = prompt('Name of the copy', `${builds.profile.name} copy`);
  if (!name) return;
  await saveProfile(name.trim(), builds.profile.variant, builds.profile.settings, builds.profile.notes).catch(() => {});
});

document.getElementById('profile-delete').addEventListener('click', async () => {
  if (!builds.profile || !confirm(`Delete the profile ${builds.profile.name}?`)) return;
  await api('DELETE', `/api/profiles/${encodeURIComponent(builds.profile.name)}`).catch(() => {});
  builds.profile = null;
  loadBuildsTab();
});

function renderChecks(checks) {
  document.getElementById('build-checks').replaceChildren(...checks.map((c) => h('li', { class: 'mb-1' },
    h('span', { class: c.ok ? 'text-success' : (c.required ? 'text-danger' : 'text-warning') }, c.ok ? '✓ ' : (c.required ? '✗ ' : '! ')),
    h('b', {}, c.name), ': ', c.detail)));
}

const buildBadge = { running: 'primary', done: 'success', failed: 'danger', cancelled: 'warning' };

function renderBuildHistory(history) {
  document.querySelector('#builds-table tbody').replaceChildren(...history.map((b) => h('tr', {},
    h('td', { class: 'small' }, when(b.started)), h('td', {}, `${b.profile} (${b.variant})`),
    h('td', {}, h('span', { class: `badge text-bg-${buildBadge[b.result] || 'secondary'}`, title: b.message }, b.result)),
    h('td', { class: b.signing === 'development' ? 'text-danger small' : 'small' }, b.signing),
    h('td', { class: 'mono small' }, shortHash(b.image_hash)),
    h('td', {}, h('button', { class: 'btn btn-sm btn-link p-0', onclick: () => showBuildLog(b.id) }, 'Log')))));
}

async function showBuildLog(id) {
  const build = await api('GET', `/api/firmware-builds/${id}`);
  builds.buildId = build.id;
  const log = document.getElementById('build-log');
  log.textContent = build.log || '';
  log.scrollTop = log.scrollHeight;
  renderBuildStatus(build);
}

function renderBuildStatus(build) {
  const running = build.result === 'running';
  document.getElementById('build-start').disabled = running;
  document.getElementById('build-cancel').classList.toggle('d-none', !running);
  document.getElementById('build-status').replaceChildren(
    h('span', { class: `badge text-bg-${buildBadge[build.result] || 'secondary'} me-1` }, build.result),
    `${build.profile} (${build.variant}) `, build.message || '');
}

async function startBuild(allowDevelopmentKey = false) {
  if (!builds.profile) return;
  try {
    const build = await api('POST', '/api/firmware-builds', { profile: builds.profile.name, allow_development_key: allowDevelopmentKey },
      { quiet: true });
    builds.buildId = build.id;
    document.getElementById('build-log').textContent = '';
    renderBuildStatus(build);
  } catch (error) {
    if (!allowDevelopmentKey && error.message.startsWith('No private signing key') &&
        confirm(`${error.message}\n\nBuild with the development key?`)) {
      return startBuild(true);
    }
    notify(error.message, 'danger');
  }
}

document.getElementById('build-start').addEventListener('click', () => startBuild());
document.getElementById('build-cancel').addEventListener('click', () => api('POST', '/api/firmware-builds/cancel').catch(() => {}));

function onBuildLog(event) {
  if (event.id !== builds.buildId) return;
  const log = document.getElementById('build-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(event.line + '\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onBuild(event) {
  const build = event.build;
  if (builds.buildId === null || build.id === builds.buildId) {
    builds.buildId = build.id;
    renderBuildStatus(build);
  }
  if (build.result !== 'running') {
    notify(`Build ${build.result}: ${build.message}`, build.result === 'done' ? 'success' : 'warning');
    api('GET', '/api/firmware-builds').then(renderBuildHistory, () => {});
  }
}

// ------------------------------------------------------------------ settings

const settingLabels = {
  coap_port: ['CoAP port', 'The devices\' CoAP port (5683)'],
  smp_port: ['mcumgr UDP port', 'The devices\' mcumgr port (1337)'],
  udp_mtu: ['UDP MTU (bytes)', 'Largest mcumgr packet over the air, with IPv6 and UDP headers. 1280 avoids IP fragmentation on Thread.'],
  serial_buffer: ['USB message size (bytes)', 'Largest mcumgr message over USB serial'],
  mcumgr_timeout_s: ['mcumgr timeout (s)', 'Per request. Longer than the devices\' poll period.'],
  coap_timeout_s: ['CoAP timeout (s)', 'Before a status request is sent again (once). Longer than the devices\' poll period.'],
  discovery_timeout_s: ['Discovery time (s)', 'How long Find devices listens'],
  online_minutes: ['Online for (min)', 'A device that answered within this time shows as online'],
  auto_refresh_minutes: ['Automatic refresh (min)', 'Refreshes every device\'s status while the app runs. 0 turns it off.'],
  reboot_timeout_s: ['Reboot timeout (s)', 'How long an updated device has to come back'],
  border_router_url: ['Border router REST API', 'For the Network page, such as http://192.168.1.20:8081 (the ot-br-posix REST server). Empty: not used.'],
};

async function loadSettings() {
  const status = await api('GET', '/api/status');
  state.status = status;
  const form = document.getElementById('settings-form');
  form.replaceChildren(...Object.entries(status.settings).map(([key, value]) => {
    const [label, help] = settingLabels[key] || [key, ''];
    const text = typeof value === 'string';
    return h('div', { class: text ? 'col-12' : 'col-sm-6' }, h('label', { class: 'form-label', for: `setting-${key}` }, label),
      h('input', { class: 'form-control', id: `setting-${key}`, name: key, type: text ? 'text' : 'number', step: text ? null : 'any', value }),
      help ? h('div', { class: 'form-text' }, help) : null);
  }), h('div', { class: 'col-12' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
  const about = [['Version', status.version], ['Data folder', status.data_dir],
    ['Firmware checkout', status.repository || 'not found (builds can still be added as files)'],
    ['Discovery', status.discovery_available ? 'available' : 'unavailable (zeroconf missing)'],
    ['Listening on', `${location.host} (this computer only)`]];
  document.getElementById('about').replaceChildren(...about.flatMap(([k, v]) =>
    [h('dt', { class: 'col-sm-4' }, k), h('dd', { class: 'col-sm-8 text-break' }, v)]));
}

async function loadBackups() {
  const backups = await api('GET', '/api/backups');
  document.getElementById('backups').replaceChildren(...(backups.length ? backups.map((b) => h('li', {},
    h('a', { href: `/api/backups/${encodeURIComponent(b.name)}`, download: b.name }, b.name),
    ` · ${Math.round(b.size / 1024)} KB · ${when(b.created)}`)) : [h('li', { class: 'text-body-secondary' }, 'None yet')]));
}

document.getElementById('restore').addEventListener('click', (event) => busy(event.target, async () => {
  const file = document.getElementById('restore-file').files[0];
  if (!file) return notify('Choose a backup file first', 'warning');
  if (!confirm(`Replace all the app's data with ${file.name}? The current data is saved as a backup first.`)) return;
  const result = await api('POST', '/api/restore', file);
  notify(`Restored ${result.devices} device(s) and ${result.images} image(s). The previous data is in ${result.safety_backup}.`, 'success', 10000);
  document.getElementById('restore-file').value = '';
  await Promise.all([loadDevices(), loadBackups(), loadSettings()]);
}));

document.getElementById('import-devices').addEventListener('click', (event) => busy(event.target, async () => {
  const file = document.getElementById('import-file').files[0];
  if (!file) return notify('Choose a CSV file first', 'warning');
  const result = await api('POST', '/api/devices/import', file);
  notify(`Imported: ${result.added} added, ${result.updated} updated`, 'success');
  document.getElementById('import-file').value = '';
  loadDevices();
}));

document.getElementById('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const current = (state.status && state.status.settings) || {};
  const values = Object.fromEntries([...new FormData(event.target).entries()].map(([k, v]) =>
    [k, typeof current[k] === 'string' ? v.trim() : Number(v)]));
  api('PUT', '/api/settings', values).then(() => notify('Saved', 'success', 2000), () => {});
});

// ------------------------------------------------------------------ live events

function connectEvents(delay = 1000) {
  const indicator = document.getElementById('connection');
  const socket = new WebSocket(`ws://${location.host}/api/events`);
  socket.addEventListener('open', () => {
    indicator.className = 'navbar-text small live';
    indicator.title = 'Connected to the app';
    delay = 1000;
    loadDevices().catch(() => {});
    loadJobs().catch(() => {});
  });
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'device') {
      state.devices.set(event.device.device_id, event.device);
      renderDevices();
    } else if (event.type === 'devices') {
      loadDevices().catch(() => {});
    } else if (event.type === 'network') {
      if (!document.getElementById('tab-network').classList.contains('d-none')) loadNetwork().catch(() => {});
    } else if (event.type === 'build-log') {
      onBuildLog(event);
    } else if (event.type === 'build') {
      onBuild(event);
    } else if (event.type === 'job') {
      const finished = state.jobs.get(event.job.id)?.state === 'running' && event.job.state !== 'running';
      state.jobs.set(event.job.id, event.job);
      renderJobs();
      if (finished) {
        loadHistory().catch(() => {});
        notify(`Update ${event.job.state}`, event.job.state === 'done' ? 'success' : 'warning');
      }
    }
  });
  socket.addEventListener('close', () => {
    indicator.className = 'navbar-text small down';
    indicator.title = 'Not connected to the app: is it still running?';
    setTimeout(() => connectEvents(Math.min(delay * 2, 15000)), delay);
  });
}

// ------------------------------------------------------------------ start

showTab((location.hash || '#devices').slice(1));
connectEvents();
