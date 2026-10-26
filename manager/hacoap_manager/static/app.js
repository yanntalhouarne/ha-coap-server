// HA-CoAP Fleet Manager: the page. Plain JavaScript, no build step.
// Text from devices and from the user is only ever inserted as text (textContent), never as HTML.

const state = {
  devices: new Map(), selected: new Set(), images: [], jobs: new Map(), status: null,
  release: null, filter: { text: '', tag: null }, pendingImage: null, setup: null, console: null,
};

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

const TABS = ['dashboard', 'devices', 'network', 'updates', 'images', 'builds', 'console', 'settings'];

// A route is a tab name, or "device/<id>" for one device's page.
function showTab(route) {
  const [name, ...rest] = route.split('/');
  const known = name === 'device' || TABS.includes(name);
  const tab = known ? name : 'dashboard';
  for (const link of document.querySelectorAll('#tabs a')) {
    link.classList.toggle('active', link.dataset.tab === (tab === 'device' ? 'devices' : tab));
  }
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('d-none', section.id !== `tab-${tab}`);
  if (tab === 'dashboard') loadDashboard().catch(() => {});
  if (tab === 'device') loadDevicePage(decodeURIComponent(rest.join('/'))).catch(() => {});
  if (tab === 'console') loadConsole().catch(() => {});
  if (tab === 'updates') { renderUpdateForm(); loadHistory(); }
  if (name === 'images') { loadImages(); loadBuilds(); }
  if (name === 'builds') loadBuildsTab();
  if (tab === 'network') {
    loadNetwork().then(() => setNetworkView(rest[0] === 'floorplan' ? 'floorplan' : net.view || 'mesh'), () => {});
  }
  if (name === 'settings') { loadSettings(); loadBackups(); }
}

for (const link of document.querySelectorAll('#tabs a')) {
  link.addEventListener('click', (event) => { event.preventDefault(); history.replaceState(null, '', `#${link.dataset.tab}`); showTab(link.dataset.tab); });
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'dashboard'));
const currentRoute = () => location.hash.slice(1) || 'dashboard';

// ------------------------------------------------------------------ devices

async function loadDevices() {
  const [devices, images] = await Promise.all([api('GET', '/api/devices'), api('GET', '/api/images')]);
  state.images = images;
  state.release = images.find((i) => i.release) || null;
  state.devices = new Map(devices.map((d) => [d.device_id, d]));
  for (const id of [...state.selected]) if (!state.devices.has(id)) state.selected.delete(id);
  renderDevices();
}

function deviceName(device) { return device.name || device.device_id; }

const deviceTags = (device) => (device.tags || '').split(',').filter(Boolean);

function visibleDevices() {
  const text = state.filter.text.toLowerCase();
  return [...state.devices.values()].filter((d) => {
    if (state.filter.tag && !deviceTags(d).includes(state.filter.tag)) return false;
    if (!text) return true;
    return [d.name, d.device_id, d.address, d.plant, d.location, d.notes, d.tags].some((v) => (v || '').toLowerCase().includes(text));
  });
}

function imageStatus(device) {
  if (!state.release) return null;
  if (!device.image_hash) return 'unknown';
  return device.image_hash === state.release.hash ? 'current' : 'outdated';
}
const imageStatusClass = { current: 'success', outdated: 'warning', unknown: 'secondary' };

function renderTagFilter() {
  const tags = [...new Set([...state.devices.values()].flatMap(deviceTags))].sort();
  const chip = (label, tag) => h('button', { type: 'button',
    class: `btn btn-sm ${state.filter.tag === tag ? 'btn-primary' : 'btn-outline-secondary'}`,
    onclick: () => { state.filter.tag = tag; renderDevices(); } }, label);
  document.getElementById('tag-filter').replaceChildren(chip('all', null), ...tags.map((t) => chip(t, t)),
    tags.length ? null : h('span', { class: 'small text-body-secondary' }, 'none yet (add some on a device\'s page)'));
}

function renderDevices() {
  const body = document.querySelector('#devices-table tbody');
  const visible = visibleDevices();
  body.replaceChildren(...visible.map(deviceRow));
  document.getElementById('devices-empty').classList.toggle('d-none', state.devices.size > 0);
  document.querySelector('.empty-logo').classList.toggle('d-none', state.devices.size > 0);
  const count = state.selected.size;
  document.getElementById('selection-count').textContent = count ? `${count} selected` : '';
  document.getElementById('update-selected').disabled = count === 0;
  document.getElementById('select-all').checked = visible.length > 0 && visible.every((d) => state.selected.has(d.device_id));
  renderTagFilter();
  renderStatusDevices();
}

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

function deviceRow(device) {
  const id = device.device_id;
  const status = imageStatus(device);
  const firmware = h('td', {},
    h('span', { class: 'mono', title: 'Git commit of the firmware' }, device.fw_version || '–'),
    status ? h('span', { class: `badge text-bg-${imageStatusClass[status]} ms-2`,
      title: 'Compared with the release image (Images tab)' }, status) : null,
    device.image_version ? h('div', { class: 'small text-body-secondary', title: `Image ${device.image_hash}` },
      `v${device.image_version} · ${shortHash(device.image_hash)}`) : null);
  const action = (label, handler) => h('li', {}, h('a', { class: 'dropdown-item', href: '#', onclick: (e) => { e.preventDefault(); handler(device); } }, label));
  return h('tr', { 'data-id': id },
    h('td', {}, h('input', { class: 'form-check-input', type: 'checkbox', checked: state.selected.has(id),
      onchange: (e) => { e.target.checked ? state.selected.add(id) : state.selected.delete(id); renderDevices(); } })),
    h('td', {}, h('a', { href: `#device/${encodeURIComponent(id)}`, class: 'device-link' }, deviceName(device)),
      (device.plant || device.location) ? h('div', { class: 'small text-body-secondary' },
        [device.plant, device.location].filter(Boolean).join(' · ')) : null,
      deviceTags(device).length ? h('div', {}, deviceTags(device).map((t) => h('span', { class: 'tag' }, t))) : null),
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
        action('Open', (d) => { location.hash = `#device/${encodeURIComponent(d.device_id)}`; }),
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
  for (const device of visibleDevices()) {
    if (event.target.checked) state.selected.add(device.device_id); else state.selected.delete(device.device_id);
  }
  renderDevices();
});

document.getElementById('device-search').addEventListener('input', (event) => {
  state.filter.text = event.target.value.trim();
  renderDevices();
});

document.getElementById('read-all-slots').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/slots/read-all');
  const failed = Object.entries(result).filter(([, error]) => error);
  notify(failed.length ? `${failed.length} device(s) didn't answer: ${failed.map(([id]) => id).join(', ')}`
    : `Read ${Object.keys(result).length} device(s)`, failed.length ? 'warning' : 'success');
  await loadDevices();
}));

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
    h('option', { value: image.hash }, `${image.release ? '★ ' : ''}v${image.version} · ${shortHash(image.hash)} · ${image.notes || image.filename}`))
    : [h('option', { value: '' }, 'No images in the library')]));
  if (state.pendingImage) { select.value = state.pendingImage; state.pendingImage = null; } else if (previous) select.value = previous;
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
      staged: document.getElementById('staged').checked,
    });
    state.jobs.set(job.id, job);
    renderJobs();
  });
});

const statusClass = {
  queued: 'secondary', running: 'primary', updated: 'success', 'already-current': 'success',
  failed: 'danger', skipped: 'warning', cancelled: 'warning', done: 'success', paused: 'warning',
};

// Opens the Updates tab with an image and devices chosen.
function prepareUpdate(imageHash, deviceIds, staged) {
  state.selected = new Set(deviceIds);
  state.pendingImage = imageHash;
  document.getElementById('transport-udp').checked = true;
  document.getElementById('staged').checked = !!staged;
  location.hash = '#updates';
}

document.getElementById('whats-new').addEventListener('click', async () => {
  const imageHash = document.getElementById('update-image').value;
  const image = state.images.find((i) => i.hash === imageHash);
  const devices = [...state.selected].map((id) => state.devices.get(id)).filter(Boolean);
  const body = document.getElementById('slots-body');
  document.getElementById('slots-title').textContent = "What's new";
  bootstrap.Modal.getOrCreateInstance(document.getElementById('slots-modal')).show();
  if (!image || !devices.length) {
    body.replaceChildren(h('p', {}, 'Choose an image, and devices on the Devices tab.'));
    return;
  }
  if (!image.git_commit) {
    body.replaceChildren(h('p', {}, 'This image has no git commit recorded (it was added as a file), so the changes are unknown.'));
    return;
  }
  const byCommit = new Map();
  for (const device of devices) {
    const key = device.fw_version || '?';
    if (!byCommit.has(key)) byCommit.set(key, []);
    byCommit.get(key).push(device);
  }
  body.replaceChildren(h('p', {}, 'Loading…'));
  const sections = [];
  for (const [commit, group] of byCommit) {
    const title = `${group.map(deviceName).join(', ')}: ${commit} → ${image.git_commit}`;
    try {
      const result = await api('GET', `/api/images/${image.hash}/changes?device_id=${encodeURIComponent(group[0].device_id)}`, undefined, { quiet: true });
      const list = (entries, sign) => entries.map((c) => h('li', {}, h('span', { class: 'mono text-body-secondary' }, `${sign} ${c.commit} `),
        h('span', { class: 'small text-body-secondary' }, `${c.date} `), c.subject));
      sections.push(h('h6', {}, title), result.added.length || result.removed.length
        ? h('ul', { class: 'list-unstyled small' }, list(result.added, '+'), list(result.removed, '−'))
        : h('p', { class: 'small' }, 'Same firmware: nothing changes.'),
      result.removed.length ? h('p', { class: 'small text-warning' }, 'Lines with − are removed: this goes back to an older firmware.') : null);
    } catch (error) {
      sections.push(h('h6', {}, title), h('p', { class: 'small text-body-secondary' }, error.message));
    }
  }
  body.replaceChildren(...sections);
});

function renderJobs() {
  const container = document.getElementById('jobs');
  const jobs = [...state.jobs.values()].sort((a, b) => b.created - a.created);
  if (!jobs.length) return;
  container.replaceChildren(...jobs.map((job) => h('div', { class: 'card mb-3 job' },
    h('div', { class: 'card-header d-flex align-items-center gap-2' },
      h('span', {}, `Image v${job.image_version} · ${shortHash(job.image_hash)}`),
      h('span', { class: `badge text-bg-${statusClass[job.state] || 'secondary'}` }, job.state),
      h('span', { class: 'small text-body-secondary' }, when(job.created)),
      job.state === 'paused' ? h('span', { class: 'ms-auto small text-warning' }, 'Check the first device, then:') : null,
      job.state === 'paused' ? h('button', { class: 'btn btn-sm btn-success',
        onclick: () => api('POST', `/api/updates/${job.id}/continue`).catch(() => {}) }, 'Continue with the rest') : null,
      ['running', 'paused'].includes(job.state) ? h('button', { class: `btn btn-sm btn-outline-danger${job.state === 'running' ? ' ms-auto' : ''}`,
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
    h('td', {}, `v${image.version}`, image.release ? h('span', { class: 'badge text-bg-primary ms-2' }, '★ release') : null),
    h('td', { class: 'mono small', title: image.hash }, shortHash(image.hash)),
    h('td', { class: 'mono small' }, image.git_commit || '–'),
    h('td', {}, `${Math.round(image.size / 1024)} KB`), h('td', { class: 'small' }, when(image.added)),
    h('td', { class: 'small' }, image.notes || image.filename),
    h('td', { class: 'text-nowrap' }, h('button', { class: 'btn btn-sm btn-outline-primary me-1', onclick: async () => {
      await api('POST', '/api/release', { image_hash: image.release ? null : image.hash }).catch(() => {});
      loadImages();
    } }, image.release ? 'Unset release' : 'Make release'), h('button', { class: 'btn btn-sm btn-outline-danger', onclick: async () => {
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

const net = { state: null, positions: new Map(), selected: null, layout: null, zoom: {} };
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
  'border router': { r: 18, color: 'var(--bs-emphasis-color)', label: 'Border router' },
  router: { r: 15, color: 'var(--t-blue)', label: 'Router' },
  'FTD child': { r: 11, color: 'var(--t-magenta)', label: 'FTD child (can become a router)' },
  MED: { r: 9, color: 'var(--t-orange)', label: 'MED (end device, always listening)' },
  SED: { r: 9, color: 'var(--t-cyan)', label: 'SED (sleepy end device)' },
};
const qualityColors = { 3: 'var(--t-green)', 2: 'var(--t-yellow)', 1: 'var(--t-red)', 0: 'var(--t-red)' };

function nodeStyle(node) {
  if (node.border_router) return nodeStyles['border router'];
  return nodeStyles[node.kind] || nodeStyles[node.role === 'child' ? 'SED' : 'router'];
}

// Your boards are drawn larger, with the ha-coap logo, ringed in the colour of their kind.
const BOARD_R = 15;

function nodeShape(node, scale = 1) {
  const style = nodeStyle(node);
  if (node.border_router) {
    const r = style.r * scale;
    return { r, el: svg('rect', { x: -r, y: -r, width: 2 * r, height: 2 * r, rx: 4, style: `fill: ${style.color}` }) };
  }
  if (!node.device_id) {
    const r = style.r * scale;
    return { r, el: svg('circle', { r, style: `fill: ${style.color}` }) };
  }
  const r = BOARD_R * scale;
  return { r, el: svg('g', { class: 'board' },
    svg('circle', { r, class: 'board-disc', style: `stroke: ${style.color}` }),
    svg('use', { href: '#hacoap-glyph', x: -r, y: -r, width: 2 * r, height: 2 * r })) };
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
    const color = s.quality === null ? 'var(--t-text-muted)' : qualityColors[s.quality];
    const line = svg('line', { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, style: `stroke: ${color}`,
      'stroke-width': s.link.kind === 'mesh' ? 3 : 2, 'stroke-dasharray': s.link.kind === 'child' ? '6 4' : null,
      onclick: () => showLinkDetails(s) }, svg('title', {}, s.text));
    s.line = line;
    return line;
  });
  const groups = layout.nodes.map((n) => {
    const shape = nodeShape(n.node);
    const group = svg('g', { class: `node${net.selected === n.node.id ? ' selected' : ''}`, transform: `translate(${n.x},${n.y})` },
      shape.el, svg('text', { y: shape.r + 14, 'text-anchor': 'middle' }, nodeLabel(n.node)), svg('title', {}, nodeLabel(n.node)));
    n.group = group;
    makeDraggable(group, n);
    return group;
  });
  const drawing = svg('svg', { viewBox: (net.zoom.mesh || box).join(' '), preserveAspectRatio: 'xMidYMid meet' }, ...lines, ...groups);
  canvas.append(drawing);
  enableZoom(canvas, drawing, box, 'mesh');

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

// The scroll wheel (or a trackpad pinch) zooms around the pointer, dragging the background
// pans, and a double click or "fit" shows the whole map again. Each view ('mesh', 'floorplan')
// keeps its zoom across redraws; maxIn and maxOut are how far in and out it can go (maxOut 1:
// the whole map, no more).
function enableZoom(canvas, drawing, box, key, { maxIn = 12, maxOut = 2 } = {}) {
  const view = () => { const v = drawing.viewBox.baseVal; return [v.x, v.y, v.width, v.height]; };
  const show = (v) => { net.zoom[key] = v; drawing.setAttribute('viewBox', (v || box).join(' ')); };
  const isBackground = (target) => !target.closest('.node') && target.tagName !== 'line';
  const toMap = (clientX, clientY) => {
    const p = drawing.createSVGPoint();
    p.x = clientX; p.y = clientY;
    return p.matrixTransform(drawing.getScreenCTM().inverse());
  };
  const zoomBy = (factor, at) => {
    const [x, y, w, height] = view();
    const scale = Math.max(box[2] / maxIn, Math.min(box[2] * maxOut, w * factor)) / w;
    show([at.x - (at.x - x) * scale, at.y - (at.y - y) * scale, w * scale, height * scale]);
  };
  const center = () => { const [x, y, w, height] = view(); return { x: x + w / 2, y: y + height / 2 }; };

  drawing.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomBy(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.002), toMap(event.clientX, event.clientY));
  }, { passive: false });
  let pan = null;
  drawing.addEventListener('pointerdown', (event) => {
    if (!isBackground(event.target)) return;  // nodes drag themselves, lines are clicked
    pan = { id: event.pointerId, start: toMap(event.clientX, event.clientY) };
    drawing.setPointerCapture(event.pointerId);
    drawing.classList.add('panning');
  });
  drawing.addEventListener('pointermove', (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    const p = toMap(event.clientX, event.clientY);
    const [x, y, w, height] = view();
    show([x - (p.x - pan.start.x), y - (p.y - pan.start.y), w, height]);  // keeps the grabbed point under the pointer
  });
  const endPan = () => { pan = null; drawing.classList.remove('panning'); };
  drawing.addEventListener('pointerup', endPan);
  drawing.addEventListener('pointercancel', endPan);
  drawing.addEventListener('dblclick', (event) => { if (isBackground(event.target)) show(null); });

  canvas.querySelector('.zoom-controls')?.remove();
  canvas.append(h('div', { class: 'zoom-controls' },
    h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Zoom in', onclick: () => zoomBy(1 / 1.4, center()) }, '+'),
    h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Zoom out', onclick: () => zoomBy(1.4, center()) }, '−'),
    h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Show the whole map', onclick: () => show(null) }, 'fit')));
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
    svg('svg', { class: 'legend-board', viewBox: '-18 -18 36 36' }, nodeShape({ device_id: 'legend', kind: 'SED' }).el),
    'your board (ringed in its kind\'s colour)',
    h('div', { class: 'mt-1' }, 'Solid lines: router to router. Dashed: child to its parent. Green, amber, red: strong, ',
      'fair, weak. Shorter lines are stronger links: it shows radio closeness, not distance (walls and antennas count). ',
      'Your boards never link to each other: each one talks only to its parent. Drag nodes to tidy up. ',
      'Scroll to zoom, drag the background to move around, double-click it to see the whole map.'));
}

async function loadNetwork() {
  net.state = await api('GET', '/api/network');
  document.getElementById('border-router-url').value = net.state.border_router_url || '';
  renderNetwork();
  renderNetworkLegend();
  renderFloorplan();
  renderChannelScan(net.state.channel_scan);
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
  loadSetupState().catch(() => {});
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

const fixLabels = { install: 'Install the build tools', keygen: 'Create my signing key', pskd: 'Set my PSKd…' };

function renderChecks(checks) {
  const toolchain = checks.find((c) => c.name === 'nRF Connect toolchain');
  const shown = new Set();
  document.getElementById('build-checks').replaceChildren(...checks.map((c) => {
    let fix = null;
    if (!c.ok && c.fix && !shown.has(c.fix)) {
      shown.add(c.fix);
      const blocked = c.fix === 'keygen' && toolchain && !toolchain.ok;
      fix = h('div', { class: 'mt-1 mb-2' }, h('button', { class: 'btn btn-sm btn-primary', disabled: blocked || (state.setup && state.setup.state === 'running'),
        title: blocked ? 'Install the build tools first: the key is made with them' : null,
        onclick: (e) => runFix(c.fix, e.target) }, fixLabels[c.fix]),
      blocked ? h('span', { class: 'small text-body-secondary ms-2' }, 'after the build tools') : null);
    }
    return h('li', { class: 'mb-1' },
      h('span', { class: c.ok ? 'text-success' : (c.required ? 'text-danger' : 'text-warning') }, c.ok ? '✓ ' : (c.required ? '✗ ' : '! ')),
      h('b', {}, c.name), ': ', c.detail, fix);
  }));
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

// ------------------------------------------------------------------ dashboard

const daysText = (forecast) => {
  if (!forecast) return 'no trend yet';
  const days = forecast.days_left;
  return days >= 60 ? `≈ ${Math.round(days / 30)} months left` : `≈ ${Math.round(days)} days left`;
};

function linkText(link) {
  if (link.link_margin !== null && link.link_margin !== undefined) {
    return `${link.link_margin} dB margin${link.average_rssi !== null && link.average_rssi !== undefined ? `, ${link.average_rssi} dBm` : ''}`;
  }
  return link.link_quality !== null && link.link_quality !== undefined ? `link quality ${link.link_quality} of 3` : 'no signal information';
}

const deviceLink = (entry) => h('a', { href: `#device/${encodeURIComponent(entry.device_id)}` }, entry.name || entry.device_id);

function tile(label, value, kind, hint) {
  return h('div', { class: `tile tile-${kind}`, title: hint || null },
    h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-label' }, label));
}

async function loadDashboard() {
  const d = await api('GET', '/api/dashboard');
  const c = d.counts;
  document.getElementById('dash-tiles').replaceChildren(
    tile('online', `${c.online}/${c.devices}`, c.devices && c.online < c.devices ? 'warn' : 'ok'),
    tile('behind the release', d.release ? c.outdated : '–', c.outdated ? 'warn' : 'ok',
      d.release ? 'Devices not running the release image' : 'No release image yet: mark one on the Images tab'),
    tile('firmware unknown', c.unknown, c.unknown ? 'muted' : 'ok', 'Devices whose running image was never read'),
    tile('low battery', c.low_battery, c.low_battery ? 'bad' : 'ok', 'Under 20 %, or less than a month left at the current rate'),
    tile('weak links', d.weak_links.length, d.weak_links.length ? 'warn' : 'ok',
      d.network_read ? `From the network read ${ago(d.network_read)}` : 'Read the network on the Network tab'));

  // Firmware: the release, and what runs where
  const maxCount = Math.max(1, ...d.firmware.map((g) => g.count));
  const firmware = [];
  if (d.release) {
    firmware.push(h('p', {}, 'Release: ', h('b', {}, `v${d.release.version}`), ` · ${shortHash(d.release.hash)} · ${d.release.notes || d.release.filename}`));
  } else {
    firmware.push(h('p', { class: 'text-body-secondary' }, 'No release image: on the Images tab, mark the image your fleet should run as the release.'));
  }
  const actions = h('div', { class: 'd-flex flex-wrap gap-2 mb-3' });
  if (d.release && d.outdated.length) {
    actions.append(h('button', { class: 'btn btn-sm btn-success', onclick: () => prepareUpdate(d.release.hash, d.outdated.map((e) => e.device_id), d.outdated.length > 1) },
      `Update the ${d.outdated.length} behind…`));
  }
  if (d.unknown.length) {
    actions.append(h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: (e) => busy(e.target, async () => {
      await api('POST', '/api/slots/read-all');
      await loadDashboard();
    }) }, `Read the firmware of ${d.unknown.length} device(s)`));
  }
  if (actions.children.length) firmware.push(actions);
  firmware.push(...d.firmware.map((g) => h('div', { class: 'bar-row' },
    h('div', { class: 'bar-label' }, g.image_hash ? `v${g.version} · ${shortHash(g.image_hash)}` : 'not read yet',
      g.release ? h('span', { class: 'badge text-bg-primary ms-2' }, '★ release') : null,
      g.notes ? h('span', { class: 'small text-body-secondary ms-2' }, g.notes) : null),
    h('div', { class: 'bar' }, h('div', { class: `bar-fill${g.release ? ' release' : ''}`, style: `width: ${(g.count / maxCount) * 100}%` })),
    h('div', { class: 'bar-count' }, g.count))));
  if (!d.firmware.length) firmware.push(h('p', { class: 'text-body-secondary mb-0' }, 'No devices yet.'));
  document.getElementById('dash-firmware').replaceChildren(...firmware);

  const table = (rows, empty) => rows.length ? h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, rows)) :
    h('p', { class: 'text-body-secondary mb-0' }, empty);
  document.getElementById('dash-batteries').replaceChildren(table(d.low_battery.map((e) => h('tr', {},
    h('td', {}, deviceLink(e)), h('td', { class: 'text-end' }, pct(e.battery)), h('td', { class: 'small' }, daysText(e.battery_forecast)))),
  'No battery is low. Forecasts appear once a device has a few readings over several hours.'));
  document.getElementById('dash-offline').replaceChildren(table(d.offline.map((e) => h('tr', {},
    h('td', {}, deviceLink(e)), h('td', { class: 'small' }, `last seen ${ago(e.last_seen)}`))), 'Every device answered recently.'));
  document.getElementById('dash-links').replaceChildren(table(d.weak_links.map((l) => h('tr', {},
    h('td', {}, l.device_id ? deviceLink({ device_id: l.device_id, name: l.from }) : l.from, ' ↔ ', l.to),
    h('td', { class: 'small' }, linkText(l)))),
  d.network_read ? 'No weak links in the last network read.' : 'Read the network (Network tab) to see the links.'));
  document.getElementById('dash-updates').replaceChildren(table(d.recent_updates.map((u) => {
    const device = state.devices.get(u.device_id);
    return h('tr', {}, h('td', { class: 'small' }, ago(u.finished)), h('td', {}, device ? deviceName(device) : u.device_id),
      h('td', {}, `v${u.image_version}`), h('td', {}, h('span', { class: `badge text-bg-${statusClass[u.result] || 'secondary'}` }, u.result)));
  }), 'No updates yet.'));
}

// ------------------------------------------------------------------ charts

// A small line chart in SVG: points [{t, v}], drawn in the theme's colours.
function lineChart(title, points, { unit = '', min = null, max = null, color = 'var(--t-brand)', step = false } = {}) {
  const data = points.filter((p) => p.v !== null && p.v !== undefined);
  const head = h('div', { class: 'chart-head' }, h('span', {}, title),
    data.length ? h('b', {}, `${data[data.length - 1].v}${unit}`) : null);
  if (data.length < 2) {
    return h('div', { class: 'chart' }, head, h('div', { class: 'chart-empty' },
      'Not enough readings yet. One is stored at each refresh (every 15 minutes while the app runs).'));
  }
  const W = 600, H = 110, padX = 34, padY = 10;
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const lo = min ?? Math.min(...data.map((p) => p.v)), hi = max ?? Math.max(...data.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (t) => padX + ((t - t0) / ((t1 - t0) || 1)) * (W - padX - 4);
  const y = (v) => H - padY - ((v - lo) / span) * (H - 2 * padY);
  let path = '';
  data.forEach((p, i) => {
    if (i === 0) path += `M${x(p.t)},${y(p.v)}`;
    else if (step) path += `H${x(p.t)}V${y(p.v)}`;
    else path += `L${x(p.t)},${y(p.v)}`;
  });
  const area = `${path}L${x(t1)},${H - padY}L${x(t0)},${H - padY}Z`;
  const date = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // The drawing stretches to its box; the labels stay as text beside it, so they don't stretch.
  return h('div', { class: 'chart' }, head,
    h('div', { class: 'chart-body' },
      h('div', { class: 'chart-y' }, h('span', {}, `${hi}${unit}`), h('span', {}, `${lo}${unit}`)),
      svg('svg', { viewBox: `${padX} 0 ${W - padX} ${H}`, preserveAspectRatio: 'none' },
        svg('line', { x1: padX, y1: y(hi), x2: W, y2: y(hi), class: 'grid' }),
        svg('line', { x1: padX, y1: y(lo), x2: W, y2: y(lo), class: 'grid' }),
        svg('path', { d: area, style: `fill: ${color}; opacity: .12` }),
        svg('path', { d: path, style: `stroke: ${color}; fill: none`, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }))),
    h('div', { class: 'chart-x' }, h('span', {}, date(t0)), h('span', {}, date(t1))));
}

// ------------------------------------------------------------------ one device

const devicePage = { id: null, details: null };

async function loadDevicePage(id) {
  devicePage.id = id;
  const days = document.getElementById('device-days').value;
  let details;
  try {
    details = await api('GET', `/api/devices/${encodeURIComponent(id)}/details?days=${days}`, undefined, { quiet: true });
  } catch (error) {
    document.getElementById('device-title').textContent = 'Unknown device';
    return;
  }
  devicePage.details = details;
  renderDeviceStatus(details.device);
  renderDeviceFirmware(details);
  renderDeviceControls(details.device);
  renderDeviceForm(details.device);
  renderDeviceCharts(details);
  const updates = details.updates;
  document.getElementById('device-updates').replaceChildren(updates.length ? h('table', { class: 'table table-sm mb-0' },
    h('tbody', {}, updates.map((r) => h('tr', {}, h('td', { class: 'small' }, when(r.finished)),
      h('td', {}, r.transport === 'serial' ? 'USB' : 'air'), h('td', {}, `v${r.image_version} · ${shortHash(r.image_hash)}`),
      h('td', {}, h('span', { class: `badge text-bg-${statusClass[r.result] || 'secondary'}` }, r.result)),
      h('td', { class: 'small' }, r.message)))))
    : h('p', { class: 'text-body-secondary mb-0' }, 'No updates yet.'));
  const events = details.network_events;
  document.getElementById('device-events').replaceChildren(events.length ? h('ul', { class: 'list-unstyled small mb-0' },
    events.map((e) => h('li', {}, h('span', { class: 'text-body-secondary' }, `${when(e.time)} `), e.message)))
    : h('p', { class: 'text-body-secondary mb-0' }, 'No parent changes seen. Read the network now and then (Network tab) to follow them.'));
}

function renderDeviceStatus(device) {
  if (device.device_id !== devicePage.id) return;
  const forecast = devicePage.details && devicePage.details.health.battery_forecast;
  document.getElementById('device-title').textContent = deviceName(device);
  document.getElementById('device-badges').replaceChildren(
    h('span', { class: `online-dot ${device.online ? 'on' : 'off'}` }), device.online ? 'online' : 'offline',
    ...deviceTags(device).map((t) => h('span', { class: 'tag ms-2' }, t)));
  document.getElementById('device-status').replaceChildren(detailsTable([
    ['Last seen', ago(device.last_seen)],
    ['Battery', device.battery !== null && device.battery !== undefined ? `${device.battery} % · ${daysText(forecast)}` : ''],
    ['Soil moisture', pct(device.soil_moisture)],
    ['Air humidity', pct(device.air_humidity)],
    ['Temperature', device.temperature !== null && device.temperature !== undefined ? `${device.temperature} °C` : ''],
    ['Device ID', device.device_id],
    ['Address', device.address],
    ['Problem', device.last_error],
  ]), h('button', { class: 'btn btn-sm btn-outline-secondary mt-2', onclick: (e) => busy(e.target, async () => {
    await refreshDevice(device);
    await loadDevicePage(device.device_id);
  }) }, 'Refresh'));
}

function renderDeviceFirmware(details) {
  const device = details.device;
  const status = details.health.image_status;
  const rows = detailsTable([
    ['Firmware', device.fw_version ? `commit ${device.fw_version}` : ''],
    ['Image', device.image_version ? `v${device.image_version} · ${shortHash(device.image_hash)}` : 'not read yet'],
    ['Hardware', device.hw_version],
    ['Compared with the release', { current: 'running it', outdated: 'behind it', unknown: 'not known yet', 'no-release': 'no release image chosen' }[status]],
  ]);
  const buttons = h('div', { class: 'd-flex flex-wrap gap-2 mt-2' },
    h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: () => showSlots(device) }, 'Firmware slots'),
    status === 'outdated' && state.release ? h('button', { class: 'btn btn-sm btn-success',
      onclick: () => prepareUpdate(state.release.hash, [device.device_id], false) }, 'Update to the release…') : null);
  document.getElementById('device-firmware').replaceChildren(rows, buttons);
}

function renderDeviceControls(device) {
  const id = encodeURIComponent(device.device_id);
  const result = h('div', { class: 'small text-body-secondary mt-2' });
  const show = (state) => { result.textContent = `Pump ${state.running ? 'running' : 'off'} · run time ${state.duration} s`; };
  const seconds = h('select', { class: 'form-select form-select-sm w-auto' },
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('option', { value: n }, `${n} s`)));
  const call = (body) => (e) => busy(e.target, async () => show(await api('POST', `/api/devices/${id}/pump`, body)));
  document.getElementById('device-controls').replaceChildren(
    h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: call({ on: true }) }, 'Run the pump'),
      h('button', { class: 'btn btn-sm btn-outline-danger', onclick: call({ on: false }) }, 'Stop'),
      h('span', { class: 'small text-body-secondary ms-2' }, 'run time'), seconds,
      h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: (e) => call({ seconds: Number(seconds.value) })(e) }, 'Set'),
      h('button', { class: 'btn btn-sm btn-outline-secondary ms-auto', onclick: () => pingDevice(device) }, 'Beep')),
    result,
    h('div', { class: 'form-text' }, 'Commands reach a sleeping board at its next poll: up to 3 s.'));
}

function renderDeviceForm(device) {
  const field = (name, label, value, attrs = {}) => h('div', { class: attrs.wide ? 'col-12' : 'col-sm-6' },
    h('label', { class: 'form-label', for: `device-${name}` }, label),
    h(attrs.textarea ? 'textarea' : 'input', { class: 'form-control form-control-sm', id: `device-${name}`, name,
      value: attrs.textarea ? null : value, placeholder: attrs.placeholder || null, rows: attrs.textarea ? 2 : null },
    attrs.textarea ? value : null));
  const form = document.getElementById('device-form');
  form.replaceChildren(
    field('name', 'Name', device.name || ''),
    field('plant', 'Plant', device.plant || '', { placeholder: 'basil' }),
    field('location', 'Location', device.location || '', { placeholder: 'kitchen window' }),
    field('tags', 'Groups', device.tags || '', { placeholder: 'greenhouse, test' }),
    field('notes', 'Notes', device.notes || '', { wide: true, textarea: true }),
    h('div', { class: 'col-12 d-flex gap-2' }, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn btn-sm btn-outline-danger ms-auto', type: 'button', onclick: async () => {
        await removeDevice(device);
        location.hash = '#devices';
      } }, 'Remove from the list')));
  form.onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, values)
      .then(() => { notify('Saved', 'success', 2000); loadDevicePage(device.device_id); }, () => {});
  };
}

function renderDeviceCharts(details) {
  const r = details.readings.map((x) => ({ t: x.time, ...x }));
  const pick = (key) => r.map((x) => ({ t: x.t, v: x[key] }));
  const links = details.links;
  const margins = links.filter((l) => l.link_margin !== null && l.link_margin !== undefined);
  const charts = [
    lineChart('Battery', pick('battery'), { unit: ' %', min: 0, max: 100, color: 'var(--t-green)' }),
    lineChart('Soil moisture', pick('soil_moisture'), { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)' }),
    lineChart('Air humidity', pick('air_humidity'), { unit: ' %', min: 0, max: 100, color: 'var(--t-blue)' }),
    lineChart('Temperature', pick('temperature'), { unit: ' °C', color: 'var(--t-orange)' }),
    margins.length
      ? lineChart('Link to its parent', margins.map((l) => ({ t: l.time, v: l.link_margin })), { unit: ' dB', min: 0, color: 'var(--t-magenta)', step: true })
      : lineChart('Link quality to its parent', links.map((l) => ({ t: l.time, v: l.link_quality })), { min: 0, max: 3, color: 'var(--t-magenta)', step: true }),
  ];
  const parents = [...new Set(links.map((l) => l.parent))];
  document.getElementById('device-charts').replaceChildren(h('div', { class: 'charts' }, charts),
    parents.length ? h('div', { class: 'small text-body-secondary mt-2' }, `Parents in this period: ${parents.join(', ')}`) : null);
}

document.getElementById('device-days').addEventListener('change', () => { if (devicePage.id) loadDevicePage(devicePage.id); });

// ------------------------------------------------------------------ network: floor plan and channels

net.view = 'mesh';

function setNetworkView(view) {
  net.view = view;
  document.getElementById('view-mesh').classList.toggle('active', view === 'mesh');
  document.getElementById('view-floorplan').classList.toggle('active', view === 'floorplan');
  document.getElementById('network-canvas').classList.toggle('d-none', view !== 'mesh');
  document.getElementById('floorplan').classList.toggle('d-none', view !== 'floorplan');
  document.getElementById('floorplan-tools').classList.toggle('d-none', view !== 'floorplan');
  if (view === 'floorplan') renderFloorplan();
}

document.getElementById('view-mesh').addEventListener('click', () => setNetworkView('mesh'));
document.getElementById('view-floorplan').addEventListener('click', () => setNetworkView('floorplan'));

const nodeKey = (node) => node.device_id || node.ext_address || node.id;

function renderFloorplan() {
  const container = document.getElementById('floorplan');
  const st = net.state;
  const plan = st && st.floorplan;
  container.querySelectorAll('.floorplan-stage').forEach((e) => e.remove());
  document.getElementById('floorplan-empty').classList.toggle('d-none', !!plan);
  document.getElementById('floorplan-remove').classList.toggle('d-none', !plan);
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

function drawFloorplanNodes(stage, img) {
  const topology = net.state.topology;
  stage.querySelector('svg')?.remove();
  if (!topology) {
    stage.append(h('div', { class: 'floorplan-hint' }, 'Read the network first: the nodes come from it.'));
    return;
  }
  const { W, H } = net.floorplanSize;  // map units are screen pixels at the full view
  const positions = net.state.positions || {};
  const tray = [];
  const points = new Map();
  for (const node of topology.nodes) {
    const p = positions[nodeKey(node)];
    if (p) points.set(node.id, { x: p.x * W, y: p.y * H, placed: true });
    else tray.push(node);
  }
  // The tray of unplaced nodes wraps into more columns when they don't fit in one; their labels
  // then only show on hover, or they would cover the next column.
  const perColumn = Math.max(1, Math.floor((H - 70) / 40));
  const columns = Math.max(1, Math.ceil(tray.length / perColumn));
  const trayWidth = 70 * columns;
  tray.forEach((node, i) => points.set(node.id,
    { x: 35 + 70 * Math.floor(i / perColumn), y: 30 + (i % perColumn) * 40, placed: false }));
  const lines = topology.links.map((link) => {
    const a = points.get(link.a), b = points.get(link.b);
    if (!a || !b || !a.placed || !b.placed) return null;
    const strength = linkStrength(link);
    const color = strength.quality === null ? 'var(--t-text-muted)' : qualityColors[strength.quality];
    return svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, style: `stroke: ${color}`, 'stroke-width': link.kind === 'mesh' ? 4 : 3,
      'stroke-dasharray': link.kind === 'child' ? '8 6' : null, 'data-a': link.a, 'data-b': link.b }, svg('title', {}, strength.text));
  });
  const box = [0, 0, W, H];
  const drawing = svg('svg', { viewBox: (net.zoom.floorplan || box).join(' '), width: W, height: H,
    preserveAspectRatio: 'xMidYMid meet', class: columns > 1 ? 'tray-compact' : null },
    svg('image', { href: img.src, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'floorplan-picture' }),
    svg('rect', { x: 0, y: 0, width: trayWidth, height: H, class: 'tray' }),
    svg('text', { x: trayWidth / 2, y: H - 28, 'text-anchor': 'middle', class: 'tray-label' }, 'not'),
    svg('text', { x: trayWidth / 2, y: H - 12, 'text-anchor': 'middle', class: 'tray-label' }, 'placed'),
    ...lines.filter(Boolean));
  for (const node of topology.nodes) {
    const p = points.get(node.id);
    const shape = nodeShape(node, 1.1);
    const group = svg('g', { class: `node${p.placed ? '' : ' unplaced'}`, transform: `translate(${p.x},${p.y})` },
      shape.el, svg('text', { x: shape.r + 6, y: 4 }, nodeLabel(node)), svg('title', {}, `${nodeLabel(node)}: drag it to where it is`));
    group.addEventListener('pointerdown', (event) => {
      group.setPointerCapture(event.pointerId);
      group.dataset.drag = '1';
    });
    group.addEventListener('pointermove', (event) => {
      if (!group.dataset.drag) return;
      const point = drawing.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      const q = point.matrixTransform(drawing.getScreenCTM().inverse());
      p.x = Math.max(0, Math.min(W, q.x)); p.y = Math.max(0, Math.min(H, q.y));
      group.setAttribute('transform', `translate(${p.x},${p.y})`);
    });
    group.addEventListener('pointerup', async () => {
      if (!group.dataset.drag) return;
      delete group.dataset.drag;
      const inTray = p.x < trayWidth;
      const body = inTray ? { x: null, y: null } : { x: p.x / W, y: p.y / H };
      await api('PUT', `/api/network/positions/${encodeURIComponent(nodeKey(node))}`, body).catch(() => {});
      net.state.positions = net.state.positions || {};
      if (inTray) delete net.state.positions[nodeKey(node)]; else net.state.positions[nodeKey(node)] = body;
      drawFloorplanNodes(stage, img);
    });
    drawing.append(group);
  }
  stage.append(drawing);
  // In until each of the picture's pixels is 4 screen pixels (at least 3×): beyond, it's only blur
  enableZoom(stage, drawing, box, 'floorplan', { maxIn: Math.max(3, 4 * img.naturalWidth / W), maxOut: 1 });
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

function renderChannelScan(scan) {
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

// ------------------------------------------------------------------ setting up this computer

async function runFix(fix, button) {
  if (fix === 'pskd') {
    const value = prompt('Your joiner PSKd: 6 to 32 characters, A-Z and 0-9, without I, O, Q or Z.\n' +
      'Leave it empty for a random one. It goes into application/local.conf (not in git).', '');
    if (value === null) return;
    await busy(button, async () => {
      const result = await api('POST', '/api/setup/pskd', { pskd: value.trim() || null });
      notify(`PSKd set: ${result.pskd}. Keep it somewhere safe; you need it to commission boards.`, 'success', 15000);
      renderChecks(result.checks);
    });
    return;
  }
  if (fix === 'keygen' && !confirm('Create your private signing key?\n\nBack it up afterwards (application/keys/): ' +
    'boards flashed with it only accept updates signed with it. Losing it means reflashing every board over SWD.')) return;
  if (fix === 'install' && !confirm('Install the nRF Connect toolchain and fetch the SDK? About 1 GB, 5 to 15 minutes.')) return;
  await api('POST', `/api/setup/${fix}`).catch(() => {});
}

function onSetup(setup) {
  state.setup = setup;
  renderActivity();
  const status = document.getElementById('setup-status');
  if (!status) return;
  const running = setup && setup.state === 'running';
  document.getElementById('setup-cancel').classList.toggle('d-none', !running);
  document.getElementById('setup-log').classList.toggle('d-none', !setup);
  status.replaceChildren(setup ? h('span', { class: `badge text-bg-${buildBadge[setup.state] || 'secondary'} me-1` }, setup.state) : '',
    setup ? `${setup.name}: ${setup.message || 'running…'}` : '');
  if (setup && setup.state !== 'running') {
    notify(`${setup.name[0].toUpperCase()}${setup.name.slice(1)}: ${setup.message}`, setup.state === 'done' ? 'success' : 'warning');
    api('GET', '/api/build-checks').then(renderChecks, () => {});
  }
}

function onSetupLog(line) {
  const log = document.getElementById('setup-log');
  log.classList.remove('d-none');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line + '\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function loadSetupState() {
  const setup = await api('GET', '/api/setup');
  state.setup = setup.current;
  const log = document.getElementById('setup-log');
  log.textContent = setup.log.join('\n') + (setup.log.length ? '\n' : '');
  log.classList.toggle('d-none', !setup.current);
  const status = document.getElementById('setup-status');
  status.replaceChildren(setup.current ? h('span', { class: `badge text-bg-${buildBadge[setup.current.state] || 'secondary'} me-1` }, setup.current.state) : '',
    setup.current ? `${setup.current.name}: ${setup.current.message || 'running…'}` : '');
  document.getElementById('setup-cancel').classList.toggle('d-none', !(setup.current && setup.current.state === 'running'));
}

document.getElementById('setup-cancel').addEventListener('click', () => api('POST', '/api/setup/cancel').catch(() => {}));

// ------------------------------------------------------------------ console

const consoleLines = [];

async function loadConsole() {
  const [ports, current] = await Promise.all([api('GET', '/api/serial-ports'), api('GET', '/api/console')]);
  const select = document.getElementById('console-port');
  const previous = current.port || select.value;
  select.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.port },
    `${p.port} – ${p.description}${p.board ? ' (board)' : ''}`)) : [h('option', { value: '' }, 'No serial ports')]));
  if (previous && ports.some((p) => p.port === previous)) select.value = previous;
  consoleLines.length = 0;
  consoleLines.push(...current.lines);
  document.getElementById('console-log').textContent = consoleLines.join('\n');
  onConsoleState(current);
}

function onConsoleState(current) {
  state.console = current;
  renderActivity();
  document.getElementById('console-open').classList.toggle('d-none', current.open);
  document.getElementById('console-close').classList.toggle('d-none', !current.open);
  document.getElementById('console-port').disabled = current.open;
}

function onConsoleLine(line) {
  consoleLines.push(line);
  if (consoleLines.length > 2000) consoleLines.splice(0, consoleLines.length - 2000);
  const log = document.getElementById('console-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = consoleLines.join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

document.getElementById('console-ports-refresh').addEventListener('click', () => loadConsole().catch(() => {}));
document.getElementById('console-open').addEventListener('click', (event) => busy(event.target, async () => {
  const port = document.getElementById('console-port').value;
  if (!port) return notify('Choose a port', 'warning');
  onConsoleState(await api('POST', '/api/console/open', { port, baudrate: Number(document.getElementById('console-baud').value) }));
}));
document.getElementById('console-close').addEventListener('click', async () => {
  onConsoleState(await api('POST', '/api/console/close').catch(() => ({ open: false })));
});
document.getElementById('console-clear').addEventListener('click', () => {
  consoleLines.length = 0;
  document.getElementById('console-log').textContent = '';
});
document.getElementById('console-send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('console-input');
  api('POST', '/api/console/send', { text: input.value }).then(() => { input.value = ''; }, () => {});
});

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
    indicator.className = 'live';
    indicator.title = 'Connected to the app';
    document.getElementById('connection-text').textContent = 'live';
    delay = 1000;
    loadDevices().catch(() => {});
    loadJobs().catch(() => {});
    api('GET', '/api/setup').then((setup) => { state.setup = setup.current; renderActivity(); }, () => {});
  });
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'device') {
      state.devices.set(event.device.device_id, event.device);
      renderDevices();
      if (currentRoute() === `device/${encodeURIComponent(event.device.device_id)}`) renderDeviceStatus(event.device);
    } else if (event.type === 'devices') {
      loadDevices().catch(() => {});
    } else if (event.type === 'network') {
      if (!document.getElementById('tab-network').classList.contains('d-none')) loadNetwork().catch(() => {});
    } else if (event.type === 'setup') {
      onSetup(event.setup);
    } else if (event.type === 'setup-log') {
      onSetupLog(event.line);
    } else if (event.type === 'console') {
      onConsoleLine(event.line);
    } else if (event.type === 'console-state') {
      onConsoleState(event.state);
    } else if (event.type === 'build-log') {
      onBuildLog(event);
    } else if (event.type === 'build') {
      onBuild(event);
      state.build = event.build;
      renderActivity();
    } else if (event.type === 'job') {
      const finished = ['running', 'paused'].includes(state.jobs.get(event.job.id)?.state) && !['running', 'paused'].includes(event.job.state);
      state.jobs.set(event.job.id, event.job);
      renderJobs();
      renderActivity();
      if (finished) {
        loadHistory().catch(() => {});
        notify(`Update ${event.job.state}`, event.job.state === 'done' ? 'success' : 'warning');
      }
    }
  });
  socket.addEventListener('close', () => {
    indicator.className = 'down';
    indicator.title = 'Not connected to the app: is it still running?';
    document.getElementById('connection-text').textContent = 'offline';
    setTimeout(() => connectEvents(Math.min(delay * 2, 15000)), delay);
  });
}

// ------------------------------------------------------------------ status bar

function renderStatusDevices() {
  const devices = [...state.devices.values()];
  const online = devices.filter((d) => d.online).length;
  document.getElementById('status-devices').textContent =
    devices.length ? `${online}/${devices.length} online` : 'no devices';
}

function renderActivity() {
  const job = [...state.jobs.values()].find((j) => ['running', 'paused'].includes(j.state));
  const element = document.getElementById('status-activity');
  let text = 'idle';
  if (job && job.state === 'paused') {
    text = 'update paused: check the first device';
  } else if (job) {
    const target = job.targets.find((t) => t.status === 'running');
    const done = job.targets.filter((t) => !['queued', 'running'].includes(t.status)).length;
    text = `updating ${done + 1}/${job.targets.length}` + (target ? ` · ${target.label} · ${target.step}` : '') +
      (target && target.step === 'uploading' ? ` ${Math.round(target.progress * 100)}%` : '');
  } else if (state.build && state.build.result === 'running') {
    text = `building ${state.build.profile}`;
  } else if (state.setup && state.setup.state === 'running') {
    text = state.setup.name;
  }
  if (state.console && state.console.open) text += ` · console ${state.console.port}`;
  element.textContent = text;
  element.classList.toggle('busy', text !== 'idle');
}

function renderClock() {
  document.getElementById('status-clock').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ themes and keys

function setTheme(id) {
  const theme = window.hacoapApplyTheme(id);
  try { localStorage.setItem('hacoap-theme', theme.id); } catch (error) { /* not remembered */ }
  document.getElementById('theme-button').textContent = theme.name.toLowerCase();
  document.getElementById('status-theme').textContent = theme.name.toLowerCase();
  for (const item of document.querySelectorAll('#theme-menu .dropdown-item')) {
    item.classList.toggle('active', item.dataset.themeId === theme.id);
  }
  if (net.state && net.state.topology) renderNetwork();
}

function cycleTheme(step) {
  const themes = window.HACOAP_THEMES;
  const current = themes.findIndex((t) => t.id === document.documentElement.getAttribute('data-theme'));
  setTheme(themes[(current + step + themes.length) % themes.length].id);
}

document.getElementById('theme-menu').replaceChildren(...window.HACOAP_THEMES.map((theme) => h('li', {},
  h('a', { class: 'dropdown-item', href: '#', 'data-theme-id': theme.id, onclick: (e) => { e.preventDefault(); setTheme(theme.id); } },
    h('span', { class: 'swatch', 'data-theme': theme.id, style: 'background: linear-gradient(90deg, var(--t-bg) 0 40%, var(--t-magenta) 40% 70%, var(--t-green) 70%); outline: 1px solid var(--t-border-strong)' }),
    h('span', {}, theme.name)))));

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (target.closest('input, textarea, select, [contenteditable]')) return;
  if (event.key >= '1' && event.key <= String(TABS.length)) {
    const name = TABS[Number(event.key) - 1];
    history.replaceState(null, '', `#${name}`);
    showTab(name);
  } else if (event.key === 't' || event.key === 'T') {
    cycleTheme(event.shiftKey ? -1 : 1);
  }
});

// ------------------------------------------------------------------ start

setTheme(document.documentElement.getAttribute('data-theme'));
renderClock();
setInterval(renderClock, 30000);
showTab(currentRoute());
connectEvents();
