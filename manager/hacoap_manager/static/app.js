// HA-CoAP Fleet Manager: the page. Plain JavaScript, no build step.
// Text from devices and from the user is only ever inserted as text (textContent), never as HTML.

const state = {
  devices: new Map(), selected: new Set(), images: [], jobs: new Map(), status: null,
  release: null, filter: { text: '', tag: null }, pendingImage: null, setup: null, console: null,
  alerts: [], appUpdate: null,
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
const photoUrl = (device) => `/api/devices/${encodeURIComponent(device.device_id)}/photo?t=${device.photo}`;

// ------------------------------------------------------------------ tabs

const TABS = ['dashboard', 'devices', 'network', 'updates', 'images', 'builds', 'console', 'settings'];
const PAGES = ['wall', 'summary'];  // pages without a tab

// A route is a tab name, or "device/<id>" for one device's page.
function showTab(route) {
  const [name, ...rest] = route.split('/');
  const known = name === 'device' || TABS.includes(name) || PAGES.includes(name);
  const tab = known ? name : 'dashboard';
  for (const link of document.querySelectorAll('#tabs a')) {
    link.classList.toggle('active', link.dataset.tab === (tab === 'device' ? 'devices' : tab));
  }
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('d-none', section.id !== `tab-${tab}`);
  document.body.classList.toggle('wall-mode', tab === 'wall');
  if (tab === 'wall') loadWall().catch(() => {}); else stopWall();
  if (tab === 'summary') loadSummary().catch(() => {});
  if (tab === 'dashboard') loadDashboard().catch(() => {});
  if (tab === 'device') loadDevicePage(decodeURIComponent(rest.join('/'))).catch(() => {});
  if (tab === 'console') loadConsole().catch(() => {});
  if (tab === 'updates') { renderUpdateForm(); loadHistory(); }
  if (name === 'images') { loadImages(); loadBuilds(); }
  if (name === 'builds') loadBuildsTab();
  if (tab === 'network') {
    loadNetwork().then(() => setNetworkView(rest[0] === 'floorplan' ? 'floorplan' : net.view || 'mesh'), () => {});
  }
  if (name === 'settings') { loadSettings(); loadBackups(); loadStorage().catch(() => {}); loadAutostart().catch(() => {}); loadHomeAssistant().catch(() => {}); }
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
  // The map's boards show their photo and soil: draw it again once the devices are known
  if (currentRoute().split('/')[0] === 'network' && net.state) {
    renderNetwork();
    renderFloorplan();
  }
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
    ...(tags.length ? [] : [h('span', { class: 'small text-body-secondary' }, 'none yet (add some on a device\'s page)')]));
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
  document.getElementById('bulk-button').disabled = count === 0;
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
    h('td', {}, h('div', { class: 'd-flex align-items-center gap-2' },
      device.photo ? h('img', { class: 'thumb', src: photoUrl(device), alt: '', loading: 'lazy' }) : null,
      h('div', {}, h('a', { href: `#device/${encodeURIComponent(id)}`, class: 'device-link' }, deviceName(device)),
        device.needs_water ? h('span', { class: 'badge water-badge ms-2', title: `Soil under its target of ${device.water_target} %` }, 'needs water') : null,
        (device.plant || device.location) ? h('div', { class: 'small text-body-secondary' },
          [device.plant, device.location].filter(Boolean).join(' · ')) : null,
        deviceTags(device).length ? h('div', {}, deviceTags(device).map((t) => h('span', { class: 'tag' }, t))) : null))),
    h('td', { class: 'mono' }, id),
    h('td', { class: 'mono small' }, device.address || '–'),
    firmware,
    h('td', { class: 'text-end' }, pct(device.battery)),
    h('td', { class: `text-end${device.needs_water ? ' text-warning' : ''}` }, pct(device.soil_moisture)),
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
  renderUpdateChecks();
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
  const image = state.images.find((i) => i.hash === imageHash);
  const refused = !!image && REFUSED_SIGNERS.includes(image.signer);
  if (refused && !confirm(`${image.detail}.\n\nSend it anyway? Only for the simulator, or a board with a development bootloader.`)) return;
  busy(event.submitter, async () => {
    const job = await api('POST', '/api/updates', {
      image_hash: imageHash, targets, stop_on_failure: document.getElementById('stop-on-failure').checked,
      staged: document.getElementById('staged').checked, allow_unverified: refused,
      ignore_battery: document.getElementById('ignore-battery').checked,
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
    h('td', { class: `small text-nowrap ${signerClass[image.signer] || ''}`, title: image.detail }, signerShort[image.signer] || image.signer),
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
    h('td', { class: `small text-nowrap ${signerClass[b.signer] || ''}`, title: b.detail }, signerShort[b.signer] || b.signer),
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

const net = { state: null, positions: new Map(), dragged: new Set(), selected: null, layout: null, zoom: {}, viewing: null,
  history: [], heatmap: false, allNames: false, showLinks: true };
// The reading on screen: the latest, or an earlier one picked on the history slider.
const shownTopology = () => (net.viewing ? net.viewing.topology : net.state && net.state.topology);
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
  'border router': { r: 20, color: 'var(--t-brand)', label: 'Border router', icon: 'router' },
  router: { r: 16, color: 'var(--t-blue)', label: 'Router', icon: 'radio-tower' },
  'FTD child': { r: 9, color: 'var(--t-magenta)', label: 'FTD child (can become a router)' },
  MED: { r: 8, color: 'var(--t-orange)', label: 'MED (end device, always listening)' },
  SED: { r: 8, color: 'var(--t-cyan)', label: 'SED (sleepy end device)' },
};
const qualityColors = { 3: 'var(--t-green)', 2: 'var(--t-yellow)', 1: 'var(--t-red)', 0: 'var(--t-red)' };
const calmMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function nodeStyle(node) {
  if (node.border_router) return nodeStyles['border router'];
  return nodeStyles[node.kind] || nodeStyles[node.role === 'child' ? 'SED' : 'router'];
}

const iconUse = (name, size, attrs = {}) => svg('use', { href: `#i-${name}`, x: -size / 2, y: -size / 2, width: size, height: size, ...attrs });

// A board's avatar: its plant photo (or the logo) in a circle, ringed by a gauge of its soil
// moisture: cyan when fine, amber when it needs water, grey when offline.
const AVATAR_R = 20;
let clipIds = 0;

function boardAvatar(node, r) {
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
function nodeShape(node, scale = 1) {
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

function nodeLabel(node) {
  if (node.name) return node.name;
  if (node.border_router) return 'Border router';
  if (node.hostname && node.kind === 'router') return node.hostname;
  return `${node.kind || node.role || 'node'} ${node.rloc16_hex}`.trim();
}

// A name in a small rounded chip, centred under (or beside) its node.
function nameChip(text, y, kind = '') {
  const w = text.length * 6.7 + 14;
  return svg('g', { class: `chip ${kind}`, transform: `translate(0,${y})` },
    svg('rect', { x: -w / 2, y: 0, width: w, height: 18, rx: 9 }),
    svg('text', { x: 0, y: 12.5, 'text-anchor': 'middle' }, text));
}

const shownName = (node) => !!node.device_id || node.border_router || node.kind === 'router' || net.allNames;

// How strong a link is: its signal margin (dB) if the border router gives it, else its link
// quality (0-3). Drawn as the line's colour and thickness.
function linkStrength(link) {
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
function linkPath(a, b, bend = 0.1) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return `M${a.x},${a.y} Q${(a.x + b.x) / 2 - dy * bend},${(a.y + b.y) / 2 + dx * bend} ${b.x},${b.y}`;
}

// The layout: the border router in the middle, the routers on rings by how many hops they
// are from it, and each router's children fanned out away from the middle. Distance follows
// signal strength: a child sits closer to its parent the stronger its link, and a router sits
// inside its ring with a strong link towards the border router, outside it with a weak one.
// The rings are ellipses as wide as the map is ('aspect': its width over its height), so it
// fills the view. Nodes you dragged stay where you put them until the next Read the network.
const RING_GAP = 210;

// How weak a link is, from 0 (strong) to 1 (weak); 0.5 without signal information.
function weakness(link) {
  if (!link) return 0.5;
  if (link.link_margin !== null && link.link_margin !== undefined) return Math.max(0, Math.min(1, (35 - link.link_margin) / 30));
  const quality = linkStrength(link).quality;
  return quality === null ? 0.5 : { 3: 0.1, 2: 0.45, 1: 0.8, 0: 1 }[quality];
}

function layoutNetwork(topology, aspect = 1.8) {
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
function pathToBorderRouter(layout, n) {
  const ids = new Set([n.node.id]);
  let at = n.node.parent || n.node.id;
  ids.add(at);
  while (layout.towards.has(at)) { at = layout.towards.get(at); ids.add(at); }
  const links = layout.springs.filter((s) => ids.has(s.a.node.id) && ids.has(s.b.node.id) &&
    (s.link.kind === 'child' ? s.a === n || s.b === n : true));
  return { ids, links };
}

function placeNode(n) {
  n.group.setAttribute('transform', `translate(${n.x},${n.y})`);
}

function placeLinks(springs) {
  for (const s of springs) {
    const d = linkPath(s.a, s.b, s.link.kind === 'mesh' ? 0.06 : 0.12);
    s.path.setAttribute('d', d);
    s.hit.setAttribute('d', d);
  }
}

function renderNetwork() {
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
function traceNode(n, on) {
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
function enableZoom(canvas, drawing, box, key, { maxIn = 12, maxOut = 2 } = {}) {
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

function makeDraggable(group, n) {
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

function detailsTable(rows) {
  return h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, rows.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => h('tr', {}, h('th', { class: 'fw-normal text-body-secondary' }, k), h('td', { class: 'text-break' }, v)))));
}

// The details slide in over the map (under it on a narrow screen).
function openDrawer(title) {
  document.getElementById('map-drawer-title').textContent = title;
  document.getElementById('map-drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('map-drawer').classList.remove('open');
  net.selected = null;
  net.selectedNode = null;
  if (net.layout) for (const n of net.layout.nodes) n.group.classList.remove('selected');
}

document.getElementById('map-drawer-close').addEventListener('click', closeDrawer);

function showNodeDetails(node, reveal = false) {
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
function boardCard(device) {
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
const forecasts = new Map();
async function deviceHealth(device) {
  const known = forecasts.get(device.device_id);
  if (known && Date.now() - known.at < 5 * 60 * 1000) return known.health;
  const details = await api('GET', `${devicePath(device, '/details')}?days=1`, undefined, { quiet: true });
  forecasts.set(device.device_id, { at: Date.now(), health: details.health });
  return details.health;
}

// When a plant will need water, from its forecast: "now", "in about 2 days".
function waterIn(forecast) {
  if (!forecast) return '';
  const days = forecast.days;
  if (days === null || days === undefined) return 'not drying';
  if (days === 0) return 'now';
  if (days < 0.5) return 'within hours';
  if (days < 1.5) return 'in about a day';
  return `in about ${Math.round(days)} days`;
}

function showLinkDetails(spring) {
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

function renderNetworkLegend() {
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

async function loadNetwork() {
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
  net.state = await api('POST', '/api/network/refresh');
  net.dragged.clear();  // a new reading: every node back where its signal puts it (the floor plan keeps its places)
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
  loadSwd().catch(() => {});
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

const fixLabels = { install: 'Install the build tools', keygen: 'Create my signing key', pskd: 'Set my PSKd…',
  device: 'Install the SWD flashing tools' };

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
    // Optional checks (only for flashing new boards) stay quiet when missing.
    const mark = c.ok ? ['text-success', '✓ '] : c.required ? ['text-danger', '✗ '] : c.optional ? ['text-body-secondary', '○ '] : ['text-warning', '! '];
    return h('li', { class: `mb-1${c.optional && !c.ok ? ' text-body-secondary' : ''}` },
      h('span', { class: mark[0] }, mark[1]), h('b', {}, c.name), ': ', c.detail,
      c.link ? [' ', h('a', { href: c.link, target: '_blank', rel: 'noopener' }, 'SEGGER\'s download page')] : null, fix);
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

// A number with its label, an icon, and (with 'series') a small chart of the last 7 days.
function tile(label, value, kind, hint, icon, series) {
  let spark = null;
  if (series && series.some((v) => v > 0)) {
    const W = 84, H = 26, top = Math.max(...series, 1);
    const points = series.map((v, i) => `${(i / (series.length - 1)) * W},${H - 2 - (v / top) * (H - 4)}`);
    spark = svg('svg', { class: 'tile-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('polyline', { points: `0,${H} ${points.join(' ')} ${W},${H}`, class: 'spark-area' }),
      svg('polyline', { points: points.join(' '), class: 'spark-line' }));
  }
  return h('div', { class: `tile tile-${kind}`, title: hint ? `${hint}${series ? ' (the chart: the last 7 days)' : ''}` : null },
    icon ? svg('svg', { class: 'icon tile-icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${icon}` })) : null,
    h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-label' }, label), spark);
}

async function loadDashboard() {
  const d = await api('GET', '/api/dashboard');
  const c = d.counts;
  document.getElementById('dash-tiles').replaceChildren(
    tile('online', `${c.online}/${c.devices}`, c.devices && c.online < c.devices ? 'warn' : 'ok', 'Boards that answered recently',
      'wifi', d.trends.online),
    tile('needs water', c.needs_water, c.needs_water ? 'warn' : 'ok', 'Plants whose soil is under their watering target',
      'droplet', d.trends.needs_water),
    tile('behind the release', d.release ? c.outdated : '–', c.outdated ? 'warn' : 'ok',
      d.release ? 'Devices not running the release image' : 'No release image yet: mark one on the Images tab', 'circle-arrow-up'),
    tile('firmware unknown', c.unknown, c.unknown ? 'muted' : 'ok', 'Devices whose running image was never read', 'circle-help'),
    tile('low battery', c.low_battery, c.low_battery ? 'bad' : 'ok', 'Under 20 %, or less than a month left at the current rate',
      'battery-low', d.trends.low_battery),
    tile('weak links', d.weak_links.length, d.weak_links.length ? 'warn' : 'ok',
      d.network_read ? `From the network read ${ago(d.network_read)}` : 'Read the network on the Network tab', 'signal-low',
      d.trends.weak_links));

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
  document.getElementById('dash-water').replaceChildren(...[table(d.needs_water.map((e) => h('tr', {},
    h('td', { class: 'thumb-cell' }, e.photo ? h('img', { class: 'thumb', src: photoUrl(e), alt: '' }) : null),
    h('td', {}, deviceLink(e), e.plant ? h('div', { class: 'small text-body-secondary' }, e.plant) : null),
    h('td', { class: 'text-end text-warning text-nowrap' }, pct(e.soil_moisture)),
    h('td', { class: 'small text-body-secondary text-nowrap' }, `under ${e.water_target} %`),
    h('td', { class: 'text-end' }, h('button', { class: 'btn btn-sm btn-outline-primary text-nowrap', onclick: (event) => busy(event.target, async () => {
      await api('POST', `/api/devices/${encodeURIComponent(e.device_id)}/pump`, { on: true });
      notify(`Watering ${e.name}`, 'success', 3000);
    }) }, 'Run the pump')))),
  'Every plant has enough water. Set a target per plant on its page, or the default in Settings.'),
  d.water_soon.length ? h('div', { class: 'small fw-bold mt-3 mb-1' }, 'Soon') : null,
  d.water_soon.length ? table(d.water_soon.map((e) => h('tr', {},
    h('td', { class: 'thumb-cell' }, e.photo ? h('img', { class: 'thumb', src: photoUrl(e), alt: '' }) : null),
    h('td', {}, deviceLink(e), e.plant ? h('div', { class: 'small text-body-secondary' }, e.plant) : null),
    h('td', { class: 'text-end text-nowrap' }, pct(e.soil_moisture)),
    h('td', { class: 'small text-body-secondary text-nowrap' }, `${waterIn(e.water_forecast)} (target ${e.water_target} %)`))), '') : null].filter(Boolean));
  renderGuide(d).catch(() => {});
  renderAlerts();
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
    return h('tr', {}, h('td', { class: 'small' }, ago(u.finished)), h('td', {}, device ? deviceName(device) : u.name || u.device_id),
      h('td', {}, `v${u.image_version}`), h('td', {}, h('span', { class: `badge text-bg-${statusClass[u.result] || 'secondary'}` }, u.result)));
  }), 'No updates yet.'));
  loadDrain().catch(() => {});
}

// ------------------------------------------------------------------ charts

// A small line chart in SVG: points [{t, v}], drawn in the theme's colours. events [{t, kind,
// text}] are drawn as markers across it (an update, a pump run, a parent change).
function lineChart(title, points, { unit = '', min = null, max = null, color = 'var(--t-brand)', step = false, events = [] } = {}) {
  const data = points.filter((p) => p.v !== null && p.v !== undefined);
  const head = h('div', { class: 'chart-head' }, h('span', {}, title),
    data.length ? h('b', {}, `${data[data.length - 1].v}${unit}`) : null);
  if (data.length < 2) {
    return h('div', { class: 'chart' }, head, h('div', { class: 'chart-empty' },
      'Not enough readings yet. One is stored at each refresh (every 15 minutes while the app runs).'));
  }
  const W = 600, H = 110, padX = 34, padY = 10;
  // The time axis runs to the latest event too (a pump run since the last reading), not before the first reading.
  const t0 = data[0].t, t1 = Math.max(data[data.length - 1].t, ...events.map((e) => e.t).filter((t) => t >= t0));
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
  const area = `${path}L${x(data[data.length - 1].t)},${H - padY}L${x(t0)},${H - padY}Z`;
  const date = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // Markers are HTML over the drawing (placed in %), so they keep their shape and show a tooltip.
  const markers = events.filter((e) => e.t >= t0 && e.t <= t1).map((e) =>
    h('div', { class: `chart-event event-${e.kind}`, style: `left: ${((x(e.t) - padX) / (W - padX)) * 100}%`,
      title: `${when(e.t)}: ${e.text}` }));
  // The drawing stretches to its box; the labels stay as text beside it, so they don't stretch.
  return h('div', { class: 'chart' }, head,
    h('div', { class: 'chart-body' },
      h('div', { class: 'chart-y' }, h('span', {}, `${hi}${unit}`), h('span', {}, `${lo}${unit}`)),
      h('div', { class: 'chart-plot' },
        svg('svg', { viewBox: `${padX} 0 ${W - padX} ${H}`, preserveAspectRatio: 'none' },
          svg('line', { x1: padX, y1: y(hi), x2: W, y2: y(hi), class: 'grid' }),
          svg('line', { x1: padX, y1: y(lo), x2: W, y2: y(lo), class: 'grid' }),
          svg('path', { d: area, style: `fill: ${color}; opacity: .12` }),
          svg('path', { d: path, style: `stroke: ${color}; fill: none`, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' })),
        markers)),
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
  document.getElementById('device-csv').href = `/api/readings.csv?device_id=${encodeURIComponent(id)}`;
  renderDevicePhoto(details.device);
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
  ]), h('div', { class: 'd-flex flex-wrap gap-2 mt-2' },
    h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: (e) => busy(e.target, async () => {
      await refreshDevice(device);
      await loadDevicePage(device.device_id);
    }) }, 'Refresh'),
    h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Each step from this computer to this board, and how fast it answers',
      onclick: () => runDoctor(device) }, 'Check the connection')));
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
      value: attrs.textarea ? null : value, placeholder: attrs.placeholder || null, rows: attrs.textarea ? 2 : null,
      type: attrs.type || null, min: attrs.min ?? null, max: attrs.max ?? null },
    attrs.textarea ? value : null));
  const defaultTarget = state.status ? state.status.settings.water_below_default : null;
  const form = document.getElementById('device-form');
  form.replaceChildren(
    field('name', 'Name', device.name || ''),
    field('plant', 'Plant', device.plant || '', { placeholder: 'basil' }),
    field('location', 'Location', device.location || '', { placeholder: 'kitchen window' }),
    field('tags', 'Groups', device.tags || '', { placeholder: 'greenhouse, test' }),
    field('water_below', 'Needs water below (%)', device.water_below ?? '', { type: 'number', min: 0, max: 100,
      placeholder: defaultTarget ? `default: ${defaultTarget}` : 'default: off' }),
    h('div', { class: 'col-12 small', id: 'plant-suggestion' }),
    field('notes', 'Notes', device.notes || '', { wide: true, textarea: true }),
    h('div', { class: 'col-12 d-flex gap-2' }, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn btn-sm btn-outline-danger ms-auto', type: 'button', onclick: async () => {
        await removeDevice(device);
        location.hash = '#devices';
      } }, 'Remove from the list')));
  const suggest = () => renderPlantSuggestion(form.elements.plant.value, form.elements.water_below);
  form.elements.plant.addEventListener('input', suggest);
  form.elements.water_below.addEventListener('input', suggest);
  suggest();
  form.onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, values)
      .then(() => { notify('Saved', 'success', 2000); loadDevicePage(device.device_id); }, () => {});
  };
}

// ------------------------------------------------------------------ plant presets

// Watering targets to start from: the soil moisture % (as the board reads it) under which a plant
// usually wants water. A guide: adjust each plant's target once you see its readings.
const PLANT_PRESETS = [
  [['cactus', 'cacti'], 8, 'cacti'], [['succulent', 'echeveria', 'jade', 'haworthia'], 10, 'succulents'],
  [['aloe'], 10, 'aloe'], [['snake plant', 'sansevieria'], 10, 'snake plants'], [['zz plant', 'zamioculcas'], 12, 'ZZ plants'],
  [['rosemary'], 20, 'rosemary'], [['thyme'], 20, 'thyme'], [['lavender'], 20, 'lavender'], [['sage'], 25, 'sage'],
  [['oregano', 'marjoram'], 25, 'oregano'], [['pothos', 'epipremnum'], 25, 'pothos'], [['orchid', 'phalaenopsis'], 25, 'orchids'],
  [['monstera'], 30, 'monstera'], [['ficus', 'fig'], 30, 'ficus'], [['lemon', 'lime', 'orange', 'citrus'], 30, 'citrus'],
  [['spider plant', 'chlorophytum'], 30, 'spider plants'], [['mint'], 45, 'mint'],  // before peppers: peppermint
  [['chili', 'chilli', 'pepper'], 35, 'peppers'],
  [['basil'], 40, 'basil'], [['parsley'], 40, 'parsley'], [['coriander', 'cilantro'], 40, 'coriander'],
  [['tomato'], 40, 'tomatoes'], [['strawberr'], 40, 'strawberries'], [['chive'], 40, 'chives'],
  [['lettuce', 'salad', 'spinach'], 45, 'leafy greens'], [['peace lily', 'spathiphyllum'], 45, 'peace lilies'],
  [['fern'], 50, 'ferns'], [['calathea', 'maranta', 'prayer plant'], 50, 'calatheas'],
];

function plantPreset(plant) {
  const name = (plant || '').toLowerCase();
  if (!name.trim()) return null;
  const found = PLANT_PRESETS.find(([words]) => words.some((w) => name.includes(w)));
  return found ? { target: found[1], kind: found[2] } : null;
}

function renderPlantSuggestion(plant, input) {
  const box = document.getElementById('plant-suggestion');
  if (!box) return;
  const preset = plantPreset(plant);
  if (!preset || String(preset.target) === input.value) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(h('span', { class: 'text-body-secondary' }, `Usual for ${preset.kind}: water under ${preset.target} %. `),
    h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', type: 'button', onclick: () => {
      input.value = preset.target;
      box.replaceChildren(h('span', { class: 'text-body-secondary' }, 'Set: click Save to keep it.'));
    } }, 'Use it'));
}

// What happened to the device, for the charts' markers.
function deviceEvents(details) {
  const updates = details.updates.filter((u) => u.finished && (u.result === 'updated' || u.result === 'failed')).map((u) => ({
    t: u.finished, kind: u.result === 'updated' ? 'update' : 'failed',
    text: u.result === 'updated' ? `updated to v${u.image_version}` : `update failed: ${u.message}` }));
  const pumps = (details.activity || []).filter((a) => a.kind === 'pump').map((a) => ({ t: a.time, kind: 'pump', text: a.message }));
  const parents = details.network_events.map((e) => ({ t: e.time, kind: 'parent', text: e.message }));
  return { updates, pumps, parents };
}

function renderDeviceCharts(details) {
  const r = details.readings.map((x) => ({ t: x.time, ...x }));
  const pick = (key) => r.map((x) => ({ t: x.t, v: x[key] }));
  const links = details.links;
  const margins = links.filter((l) => l.link_margin !== null && l.link_margin !== undefined);
  const { updates, pumps, parents: moves } = deviceEvents(details);
  const charts = [
    lineChart('Battery', pick('battery'), { unit: ' %', min: 0, max: 100, color: 'var(--t-green)', events: updates }),
    lineChart('Soil moisture', pick('soil_moisture'), { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)', events: pumps }),
    lineChart('Air humidity', pick('air_humidity'), { unit: ' %', min: 0, max: 100, color: 'var(--t-blue)' }),
    lineChart('Temperature', pick('temperature'), { unit: ' °C', color: 'var(--t-orange)' }),
    margins.length
      ? lineChart('Link to its parent', margins.map((l) => ({ t: l.time, v: l.link_margin })), { unit: ' dB', min: 0, color: 'var(--t-magenta)', step: true, events: [...moves, ...updates] })
      : lineChart('Link quality to its parent', links.map((l) => ({ t: l.time, v: l.link_quality })), { min: 0, max: 3, color: 'var(--t-magenta)', step: true, events: [...moves, ...updates] }),
  ];
  const parents = [...new Set(links.map((l) => l.parent))];
  const legend = h('div', { class: 'chart-legend small text-body-secondary mt-2' }, 'Markers: ',
    h('span', { class: 'legend-event event-update' }), 'update ', h('span', { class: 'legend-event event-failed' }), 'failed update ',
    h('span', { class: 'legend-event event-pump' }), 'pump run (from the app) ', h('span', { class: 'legend-event event-parent' }),
    'parent change. Point at one for details.');
  document.getElementById('device-charts').replaceChildren(h('div', { class: 'charts' }, charts), legend,
    parents.length ? h('div', { class: 'small text-body-secondary mt-1' }, `Parents in this period: ${parents.join(', ')}`) : null);
  renderDeviceDrain(details.drain || []);
}

// ------------------------------------------------------------------ battery drain per firmware

const perDay = (rate) => `${rate.per_day.toFixed(rate.per_day < 1 ? 2 : 1)} %/day`;
const fullLasts = (days) => !days ? 'no measurable drain' : days >= 60 ? `≈ ${Math.round(days / 30)} months from full` : `≈ ${Math.round(days)} days from full`;

function imageLabel(hash, version) {
  return hash ? `v${version || '?'} · ${shortHash(hash)}` : 'the image before its first update here';
}

function renderDeviceDrain(periods) {
  const measured = periods.filter((p) => p.rate);
  document.getElementById('device-drain').replaceChildren(measured.length ? h('div', { class: 'mb-3' },
    h('div', { class: 'small fw-bold mb-1' }, 'Battery drain by firmware'),
    h('table', { class: 'table table-sm mb-0 small' }, h('tbody', {}, measured.map((p) => h('tr', {},
      h('td', {}, imageLabel(p.image_hash, p.version)),
      h('td', { class: 'text-nowrap' }, `${when(p.start)} → ${p.end ? when(p.end) : 'now'}`),
      h('td', { class: 'text-end text-nowrap' }, perDay(p.rate)),
      h('td', { class: 'text-body-secondary text-nowrap' }, fullLasts(p.rate.per_day > 0.01 ? 100 / p.rate.per_day : null)),
      h('td', { class: 'text-body-secondary text-nowrap' }, `over ${p.rate.days.toFixed(1)} days`)))))) : '');
}

async function loadDrain() {
  const groups = await api('GET', '/api/battery-drain', undefined, { quiet: true });
  document.getElementById('dash-drain').replaceChildren(groups.length ? h('table', { class: 'table table-sm mb-0' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Image'), h('th', { class: 'text-end' }, 'Devices'),
      h('th', { class: 'text-end' }, 'Median'), h('th', {}, ''))),
    h('tbody', {}, groups.map((g) => h('tr', { title: g.devices.map((d) => `${d.name}: ${d.per_day.toFixed(2)} %/day`).join('\n') },
      h('td', {}, imageLabel(g.image_hash, g.version), g.release ? h('span', { class: 'badge text-bg-primary ms-2' }, '★') : null),
      h('td', { class: 'text-end' }, g.devices.length),
      h('td', { class: 'text-end text-nowrap' }, perDay({ per_day: g.median })),
      h('td', { class: 'small text-body-secondary text-nowrap' }, fullLasts(g.days_full)))))) :
    h('p', { class: 'text-body-secondary mb-0' }, 'Not enough battery readings yet: each device needs 3 or more over 6 hours ' +
      'on an image. Import Home Assistant\'s history (Settings) to start with more.'));
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
  renderHeatmapNote();
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
const PIN_LIFT = 32;

function floorShape(node) {
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

function drawFloorplanNodes(stage, img) {
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
      'data-device': node.device_id || null },
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
function dragOntoPlan(event, chip, drop) {
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
  if (fix === 'device' && !confirm('Install nrfutil\'s "device" command, to flash boards over SWD? A small download, ' +
    'into nrfutil\'s own folder. It also needs SEGGER\'s J-Link software, which you install yourself.')) return;
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
    loadSwd().catch(() => {});
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

// ------------------------------------------------------------------ flashing a board over SWD

const swd = { state: null, probesFound: false };
// A build's merged.hex holds MCUboot made with the same key that signed its application: the
// key the board will then accept updates from.
const swdSigners = {
  yours: ['text-success', '✓ Its bootloader takes your key: the board will accept updates signed with it.'],
  development: ['text-danger', '⚠ Its bootloader takes MCUboot\'s public development key: anyone could then update the board. Only for testing.'],
  other: ['text-danger', '⚠ Its bootloader takes a key that isn\'t yours: the board would refuse your updates.'],
  unsigned: ['text-danger', '⚠ Its application isn\'t signed: the board won\'t boot it.'],
  unknown: ['text-body-secondary', '? This computer has no copy of your signing key, so it can\'t tell which key the bootloader takes.'],
};

async function loadSwd() {
  const st = swd.state = await api('GET', '/api/swd', undefined, { quiet: true });
  const missing = [];
  if (!st.tools) missing.push('the SWD flashing tools');
  if (!st.jlink) missing.push('SEGGER\'s J-Link software');
  if (!st.builds.length) missing.push('a build (Build with this profile)');
  const ready = st.tools && st.builds.length > 0;
  document.getElementById('swd-missing').classList.toggle('d-none', !missing.length);
  document.getElementById('swd-missing').textContent = missing.length
    ? `Needs ${missing.join(', ')}: see Set up this computer above.` : '';
  document.getElementById('swd-form').classList.toggle('d-none', !ready);
  const select = document.getElementById('swd-build');
  const keep = select.value;
  select.replaceChildren(...st.builds.map((b) => h('option', { value: b.variant }, `${b.variant} · built ${ago(b.modified)}`)));
  if (st.builds.some((b) => b.variant === keep)) select.value = keep;
  renderSwdSigner();
  if (ready && !swd.probesFound) findProbes().catch(() => {});
}

function renderSwdSigner() {
  const build = swd.state && swd.state.builds.find((b) => b.variant === document.getElementById('swd-build').value);
  const [cls, text] = build ? swdSigners[build.signer] || swdSigners.unknown : ['', ''];
  const line = document.getElementById('swd-signer');
  line.className = `form-text mb-2 ${cls}`;
  line.textContent = text;
}

async function findProbes() {
  const select = document.getElementById('swd-probe');
  select.replaceChildren(h('option', { value: '' }, 'looking…'));
  let probes;
  try {
    probes = await api('GET', '/api/swd/probes', undefined, { quiet: true });
  } catch (error) {
    select.replaceChildren(h('option', { value: '' }, 'couldn\'t list them'));
    notify(error.message, 'warning');
    return;
  }
  swd.probesFound = true;
  select.replaceChildren(...(probes.length
    ? probes.map((p) => h('option', { value: p.serial }, `J-Link ${p.serial}${p.devkit ? ' (development kit)' : ''}`))
    : [h('option', { value: '' }, 'none found: plug it in, then Find')]));
}

document.getElementById('swd-build').addEventListener('change', renderSwdSigner);
document.getElementById('swd-probes-find').addEventListener('click', (event) => busy(event.target, findProbes));
document.getElementById('swd-flash').addEventListener('click', async (event) => {
  const variant = document.getElementById('swd-build').value;
  const serial = document.getElementById('swd-probe').value;
  const erase = document.querySelector('input[name="swd-erase"]:checked').value;
  if (!serial) return notify('Choose a J-Link: plug it in, then click Find', 'warning');
  const build = swd.state.builds.find((b) => b.variant === variant);
  let allow = false;
  if (build && REFUSED_SIGNERS.includes(build.signer)) {
    if (!confirm(`${swdSigners[build.signer][1].slice(2)}\n\nFlash it anyway?`)) return;
    allow = true;
  }
  const question = erase === 'all'
    ? `Erase the board on J-Link ${serial} completely, then flash the ${variant} build?\n\n` +
      'It loses its Thread network, and has to join again (with your PSKd).'
    : `Flash the ${variant} build to the board on J-Link ${serial}?\n\nIt keeps its Thread network.`;
  if (!confirm(question)) return;
  await busy(event.target, async () => {
    await api('POST', '/api/swd/flash', { variant, serial, erase, allow_development_key: allow });
    document.getElementById('setup-log').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});

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
  min_battery_for_update: ['Lowest battery for an update (%)', 'Over the air, a device whose battery is under this is skipped (an update can include it anyway). 0: no check.'],
  water_below_default: ['Needs water below (%)', 'The soil moisture under which a plant needs water, unless its page sets its own. 0: off.'],
  check_app_updates: ['Check GitHub for app updates', 'Once a day, asks GitHub whether a newer fleet manager is out.'],
  keep_readings_days: ['Keep readings (days)', 'Readings, link samples and pump runs older than this are deleted, once a day. 0: keep everything.'],
  keep_network_readings: ['Keep network readings', 'How many network readings the history slider keeps'],
  keep_backups: ['Keep backups', 'How many automatic daily backups are kept'],
};
const SETTINGS_ELSEWHERE = new Set(['home_assistant_url']);  // set in their own cards

async function loadSettings() {
  const status = await api('GET', '/api/status');
  state.status = status;
  const form = document.getElementById('settings-form');
  form.replaceChildren(...Object.entries(status.settings).filter(([key]) => !SETTINGS_ELSEWHERE.has(key)).map(([key, value]) => {
    const [label, help] = settingLabels[key] || [key, ''];
    if (typeof value === 'boolean') {
      return h('div', { class: 'col-12' }, h('div', { class: 'form-check form-switch' },
        h('input', { class: 'form-check-input', type: 'checkbox', id: `setting-${key}`, name: key, checked: value }),
        h('label', { class: 'form-check-label', for: `setting-${key}` }, label)),
      help ? h('div', { class: 'form-text' }, help) : null);
    }
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
  renderNotificationState();
  checkAppUpdate().catch(() => {});
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
  const values = {};
  for (const [key, value] of Object.entries(current)) {
    const input = event.target.elements[key];
    if (!input) continue;
    values[key] = typeof value === 'boolean' ? input.checked : typeof value === 'string' ? input.value.trim() : Number(input.value);
  }
  api('PUT', '/api/settings', values).then((settings) => {
    state.status.settings = settings;
    notify('Saved', 'success', 2000);
    checkAppUpdate().catch(() => {});
  }, () => {});
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
    loadStatus().catch(() => {});
    loadAlerts().catch(() => {});
    api('GET', '/api/setup').then((setup) => { state.setup = setup.current; renderActivity(); }, () => {});
  });
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'device') {
      const before = state.devices.get(event.device.device_id);
      if (before && event.device.last_seen && event.device.last_seen !== before.last_seen) pulseBoard(event.device.device_id);
      state.devices.set(event.device.device_id, event.device);
      if (currentRoute() === 'wall') loadWallSoon();
      renderDevices();
      if (currentRoute() === `device/${encodeURIComponent(event.device.device_id)}`) {
        renderDeviceStatus(event.device);
        renderDevicePhoto(event.device);
      }
      if (net.selectedNode && net.selectedNode.device_id === event.device.device_id) showNodeDetails(net.selectedNode);
    } else if (event.type === 'devices') {
      loadDevices().catch(() => {});
    } else if (event.type === 'network') {
      if (!document.getElementById('tab-network').classList.contains('d-none')) loadNetwork().catch(() => {});
    } else if (event.type === 'alert') {
      onAlert(event.alert);
    } else if (event.type === 'alerts') {
      loadAlerts().catch(() => {});
      if (currentRoute() === 'dashboard') loadDashboard().catch(() => {});
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
  element.parentElement.classList.toggle('busy', text !== 'idle');  // the whole segment, with its icon
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
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault();
    openPalette();
    return;
  }
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

// ------------------------------------------------------------------ status

async function loadStatus() {
  state.status = await api('GET', '/api/status', undefined, { quiet: true });
  document.getElementById('demo-banner').classList.toggle('d-none', !state.status.demo);
  document.title = state.status.demo ? 'Demo · HA-CoAP Fleet Manager' : 'HA-CoAP Fleet Manager';
  return state.status;
}

// ------------------------------------------------------------------ who signed an image

const signerShort = { yours: 'your key', development: 'dev key', other: 'other key', unsigned: 'unsigned', unknown: 'not checked' };
const signerClass = { yours: 'text-success', development: 'text-danger', other: 'text-danger', unsigned: 'text-warning', unknown: 'text-body-secondary' };
const signerIcon = { yours: '✓', development: '✗', other: '✗', unsigned: '✗', unknown: '?' };
const REFUSED_SIGNERS = ['development', 'other', 'unsigned'];  // boards with your bootloader won't boot these

// Under the image choice: who signed it, and which selected devices have a low battery.
function renderUpdateChecks() {
  const image = state.images.find((i) => i.hash === document.getElementById('update-image').value);
  const signer = document.getElementById('update-image-signer');
  signer.className = `form-text ${image ? signerClass[image.signer] || '' : ''}`;
  signer.textContent = image && image.signer ? `${signerIcon[image.signer] || ''} ${image.detail}` : '';
  const limit = state.status ? state.status.settings.min_battery_for_update : 20;
  const low = [...state.selected].map((id) => state.devices.get(id))
    .filter((d) => d && limit && d.battery !== null && d.battery !== undefined && d.battery < limit);
  const warning = document.getElementById('update-low-batteries');
  warning.classList.toggle('d-none', !low.length);
  warning.textContent = low.length ? `Battery under ${limit} %: ${low.map((d) => `${deviceName(d)} (${d.battery} %)`).join(', ')}. ` +
    'Over the air, they\'re skipped unless the box above is ticked: a battery that dies mid-update costs a battery change.' : '';
  document.getElementById('ignore-battery-label').textContent = limit ? `Update batteries under ${limit} % too` : 'Update low batteries too';
}

document.getElementById('update-image').addEventListener('change', renderUpdateChecks);

// ------------------------------------------------------------------ actions for the ticked devices

async function forSelected(label, work) {
  const devices = [...state.selected].map((id) => state.devices.get(id)).filter(Boolean);
  let failed = 0;
  for (const device of devices) {
    try { await work(device); } catch (error) { failed++; }
  }
  notify(`${label}: ${devices.length - failed} of ${devices.length}${failed ? ` (${failed} didn't work)` : ''}`,
    failed ? 'warning' : 'success');
  await loadDevices();
}

const devicePath = (device, rest = '') => `/api/devices/${encodeURIComponent(device.device_id)}${rest}`;
const patchDevice = (device, values) => api('PATCH', devicePath(device), values, { quiet: true });

const bulkActions = [
  ['Refresh', () => forSelected('Refreshed', (d) => api('POST', devicePath(d, '/refresh'), undefined, { quiet: true }))],
  ['Read firmware', () => forSelected('Read', (d) => api('POST', devicePath(d, '/slots'), { transport: 'udp' }, { quiet: true }))],
  ['Beep', () => forSelected('Beeped', (d) => api('POST', devicePath(d, '/ping'), undefined, { quiet: true }))],
  null,
  ['Add to a group…', () => {
    const tag = prompt('The group to add them to (for example greenhouse)');
    if (tag && tag.trim()) forSelected('Added to the group', (d) => patchDevice(d, { tags: [...deviceTags(d), tag.trim()] }));
  }],
  ['Remove from a group…', () => {
    const tags = [...new Set([...state.selected].flatMap((id) => deviceTags(state.devices.get(id) || {})))];
    const tag = prompt(`The group to remove them from${tags.length ? ` (${tags.join(', ')})` : ''}`);
    if (tag && tag.trim()) forSelected('Removed from the group', (d) => patchDevice(d, { tags: deviceTags(d).filter((t) => t !== tag.trim().toLowerCase()) }));
  }],
  ['Set the location…', () => {
    const location_ = prompt('Location (for example kitchen window)');
    if (location_ !== null) forSelected('Location set', (d) => patchDevice(d, { location: location_ }));
  }],
  ['Set the watering target…', () => {
    const value = prompt('They need water below this soil moisture (%). Leave it empty for the default (Settings).', '');
    if (value !== null) forSelected('Watering target set', (d) => patchDevice(d, { water_below: value.trim() }));
  }],
  null,
  ['Remove from the list', () => {
    if (!confirm(`Remove ${state.selected.size} device(s) from the list? They stay on the network and come back with Find devices.`)) return;
    forSelected('Removed', async (d) => {
      await api('DELETE', devicePath(d), undefined, { quiet: true });
      state.selected.delete(d.device_id);
    });
  }],
];

document.getElementById('bulk-menu').replaceChildren(...bulkActions.map((action) => action
  ? h('li', {}, h('a', { class: 'dropdown-item', href: '#', onclick: (e) => { e.preventDefault(); action[1](); } }, action[0]))
  : h('li', {}, h('hr', { class: 'dropdown-divider' }))));

// ------------------------------------------------------------------ the plant's photo

// Phone photos are large: shrink them to 1600 px at most (JPEG) before sending, so the page,
// the database folder and the backups stay light.
async function shrinkPhoto(file) {
  const MAX = 1600;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    return file;  // a format the browser can't draw: the app says whether it takes it
  }
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.85));
}

// The plant card: its photos over time (a slider steps through them, with the soil at each
// date), whether it needs water, when it will, and what a pump run does.
const timeline = { device: null, photo: null, taken: [], index: -1 };

async function loadTimeline(device) {
  timeline.taken = (await api('GET', devicePath(device, '/photos'), undefined, { quiet: true })).map((p) => p.taken);
  timeline.device = device.device_id;
  timeline.photo = device.photo;
  timeline.index = timeline.taken.length - 1;
}

function renderDevicePhoto(device) {
  if (device.device_id !== devicePage.id) return;
  if (timeline.device !== device.device_id || timeline.photo !== device.photo) {
    loadTimeline(device).then(() => renderDevicePhoto(device), () => {});
    if (timeline.device !== device.device_id) return;
  }
  const input = h('input', { type: 'file', class: 'd-none', accept: 'image/png,image/jpeg,image/webp' });
  const choose = h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => input.click() },
    'Add a photo');
  input.addEventListener('change', () => {
    const file = input.files[0];
    // When it was taken: the file's date (a phone keeps it), sent along; the app checks it.
    if (file) busy(choose, async () => api('POST', devicePath(device, `/photo?taken=${Math.round(file.lastModified / 1000)}`), await shrinkPhoto(file)));
  });
  const taken = timeline.taken[timeline.index];
  const alt = device.plant ? `The ${device.plant}` : `The plant of ${deviceName(device)}`;
  const picture = taken
    ? h('img', { class: 'plant-photo', src: `${devicePath(device, `/photos/${taken}`)}`, alt })
    : h('button', { class: 'plant-photo-empty', type: 'button', onclick: () => input.click() },
      'Add a photo of the plant this device looks after');

  // The slider, with the soil at that date and a chart marking it
  let steps = null;
  if (timeline.taken.length > 1) {
    const readings = (devicePage.details && devicePage.details.readings) || [];
    const near = readings.filter((r) => r.soil_moisture !== null && r.soil_moisture !== undefined)
      .reduce((best, r) => (!best || Math.abs(r.time - taken) < Math.abs(best.time - taken) ? r : best), null);
    const slider = h('input', { type: 'range', class: 'form-range', min: 0, max: timeline.taken.length - 1, value: timeline.index,
      'aria-label': 'Photo date' });
    slider.addEventListener('input', () => { timeline.index = Number(slider.value); renderDevicePhoto(device); });
    const soil = readings.map((r) => ({ t: r.time, v: r.soil_moisture }));
    steps = h('div', { class: 'mt-2' }, slider,
      h('div', { class: 'small d-flex justify-content-between' },
        h('span', {}, new Date(taken * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })),
        h('span', { class: 'text-body-secondary' }, `photo ${timeline.index + 1} of ${timeline.taken.length}` +
          (near && Math.abs(near.time - taken) < 2 * 86400 ? ` · soil then ${near.soil_moisture} %` : ''))),
      lineChart('Soil moisture', soil, { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)',
        events: [{ t: taken, kind: 'photo', text: 'this photo' }] }));
  }

  const target = device.water_target;
  let water = 'No soil reading yet.';
  if (device.soil_moisture !== null && device.soil_moisture !== undefined) {
    water = !target ? `Soil at ${device.soil_moisture} % (no watering target).`
      : device.needs_water ? `Soil at ${device.soil_moisture} %: under its target of ${target} %, it needs water.`
        : `Soil at ${device.soil_moisture} %: fine (it needs water under ${target} %).`;
  }
  const health = devicePage.details && devicePage.details.device.device_id === device.device_id ? devicePage.details.health : {};
  const forecast = health.water_forecast;
  const effect = health.pump_effect;
  document.getElementById('device-photo').replaceChildren(...[picture, steps,
    device.plant ? h('div', { class: 'fw-bold mt-2' }, device.plant) : null,
    h('div', { class: `small mt-1 ${device.needs_water ? 'text-warning' : 'text-body-secondary'}` }, water),
    forecast && !device.needs_water && forecast.days !== null ? h('div', { class: 'small text-body-secondary' },
      `It dries about ${forecast.per_day.toFixed(1)} % a day: it will need water ${waterIn(forecast)}.`) : null,
    effect ? h('div', { class: 'small text-body-secondary' }, `A pump run${effect.seconds ? ` of ${effect.seconds} s` : ''} ` +
      `raises its soil by about ${Math.round(effect.rise)} % (from ${effect.runs} run${effect.runs > 1 ? 's' : ''} started here).`) : null,
    h('div', { class: 'd-flex flex-wrap gap-2 mt-2' }, choose,
      taken ? h('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', onclick: async () => {
        if (confirm('Remove this photo?')) await api('DELETE', devicePath(device, `/photos/${taken}`)).catch(() => {});
      } }, timeline.taken.length > 1 ? 'Remove this one' : 'Remove') : null),
    input].filter(Boolean));
}

// ------------------------------------------------------------------ alerts and notifications

async function loadAlerts() {
  state.alerts = (await api('GET', '/api/alerts', undefined, { quiet: true })).open;
  renderAlerts();
}

function renderAlerts() {
  const count = state.alerts.length;
  document.getElementById('status-alerts').classList.toggle('d-none', !count);
  document.getElementById('status-alerts-link').textContent = `${count} alert${count === 1 ? '' : 's'}`;
  document.getElementById('dash-alerts').replaceChildren(count
    ? h('ul', { class: 'list-unstyled mb-0 alerts-list' }, state.alerts.map((a) => h('li', { class: `alert-${a.kind}` },
      h('span', { class: 'small text-body-secondary text-nowrap' }, ago(a.raised)),
      a.device_id ? h('a', { href: `#device/${encodeURIComponent(a.device_id)}` }, a.message) : h('span', {}, a.message),
      h('button', { class: 'btn-close ms-auto', title: 'Dismiss', 'aria-label': 'Dismiss',
        onclick: () => api('POST', `/api/alerts/${a.id}/dismiss`).then(loadAlerts, () => {}) }))))
    : h('p', { class: 'text-body-secondary mb-0' }, 'Nothing needs attention.'));
}

// New alerts arrive one by one; a burst (at start, say) becomes one message.
const pendingAlerts = [];

function onAlert(alert) {
  pendingAlerts.push(alert);
  if (pendingAlerts.length > 1) return;
  setTimeout(() => {
    const batch = pendingAlerts.splice(0);
    const text = batch.length === 1 ? batch[0].message
      : `${batch.length} new alerts: ${batch.slice(0, 3).map((a) => a.message).join('; ')}${batch.length > 3 ? '…' : ''}`;
    notify(text, 'warning', 10000);
    if (notificationsOn()) {
      try {
        new Notification('ha-coap', { body: text, icon: '/static/icon.svg', tag: batch.length === 1 ? batch[0].key : 'hacoap-alerts' });
      } catch (error) { /* not shown */ }
    }
  }, 800);
}

function notificationsOn() {
  try {
    return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem('hacoap-notify') === '1';
  } catch (error) {
    return false;
  }
}

async function toggleNotifications() {
  if (notificationsOn()) {
    try { localStorage.removeItem('hacoap-notify'); } catch (error) { /* nothing kept */ }
    renderNotificationState();
    return;
  }
  if (!('Notification' in window)) return notify('This browser can\'t show notifications', 'warning');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    notify('The browser blocked notifications for this page: allow them in its site settings', 'warning');
  } else {
    try { localStorage.setItem('hacoap-notify', '1'); } catch (error) { /* only for this visit */ }
    new Notification('ha-coap', { body: 'Notifications are on: alerts pop up here.', icon: '/static/icon.svg' });
  }
  renderNotificationState();
}

function renderNotificationState() {
  const on = notificationsOn();
  document.getElementById('notifications-enable').textContent = on ? 'Notifications on' : 'Notify me';
  document.getElementById('settings-notifications').textContent = on ? 'Turn off' : 'Turn on';
  let text = on ? 'On, in this browser' : 'Off';
  if (!('Notification' in window)) text = 'Not available in this browser';
  else if (!on && Notification.permission === 'denied') text = 'Blocked: allow notifications for this page in the browser';
  document.getElementById('notifications-state').textContent = text;
}

document.getElementById('notifications-enable').addEventListener('click', toggleNotifications);
document.getElementById('settings-notifications').addEventListener('click', toggleNotifications);

// ------------------------------------------------------------------ app updates

async function checkAppUpdate(force = false) {
  const result = await api('GET', `/api/app-update${force ? '?force=true' : ''}`, undefined, { quiet: !force });
  state.appUpdate = result;
  const url = typeof result.url === 'string' && result.url.startsWith('https://github.com/') ? result.url : null;
  document.getElementById('status-app-update').classList.toggle('d-none', !(result.newer && url));
  if (result.newer && url) {
    const link = document.getElementById('status-app-update-link');
    link.href = url;
    link.textContent = `app v${result.latest} is out`;
  }
  let text = 'Not checked (turn on the check above, or click Check now).';
  if (result.checking !== false) {
    text = result.error || (result.newer ? `Version ${result.latest} is out (this is ${result.current}).`
      : result.latest ? `Up to date: ${result.current} (newest release ${result.latest}).`
        : `No fleet manager release published yet (this is ${result.current}).`);
  }
  document.getElementById('app-update-state').textContent = text;
}

document.getElementById('app-update-check').addEventListener('click', (event) => busy(event.target, () => checkAppUpdate(true)));

// ------------------------------------------------------------------ network history

async function loadNetworkHistory() {
  net.history = await api('GET', '/api/network/history', undefined, { quiet: true });
  const slider = document.getElementById('history-slider');
  document.getElementById('network-history').classList.toggle('d-none', net.history.length < 2);
  slider.max = Math.max(0, net.history.length - 1);
  const index = net.viewing ? net.history.findIndex((s) => s.id === net.viewing.id) : -1;
  slider.value = index >= 0 ? index : slider.max;
  renderHistoryLabel();
}

function renderHistoryLabel() {
  const slider = document.getElementById('history-slider');
  const index = Number(slider.value);
  const entry = net.history[index];
  document.getElementById('history-label').textContent = !entry ? '' :
    index === net.history.length - 1 && !net.viewing ? 'latest' : `${when(entry.time)} · ${entry.boards} boards`;
  document.getElementById('history-latest').classList.toggle('d-none', !net.viewing);
}

function showLatestNetwork() {
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
function heatmapLayer(topology, points, [x0, y0, W, H], reach = Math.max(W, H) * 0.3) {
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
const MESH_HEAT_REACH = 160;

function meshHeatmap() {
  const { nodes, box } = net.layout;
  const points = new Map(nodes.map((n) => [n.node.id, { x: n.x, y: n.y, placed: true }]));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const r = MESH_HEAT_REACH;
  const area = [Math.min(...xs, box[0]) - r, Math.min(...ys, box[1]) - r,
    Math.max(...xs, box[0] + box[2]) - Math.min(...xs, box[0]) + 2 * r, Math.max(...ys, box[1] + box[3]) - Math.min(...ys, box[1]) + 2 * r];
  return heatmapLayer(shownTopology(), points, area, r);
}

// After a node is dragged on the mesh, the heatmap follows.
function redrawMeshHeatmap() {
  const drawing = document.querySelector('#network-canvas svg');
  const old = drawing && drawing.querySelector('.heatmap');
  if (!drawing || !net.heatmap) return;
  const layer = meshHeatmap();
  if (old) old.remove();
  if (layer) drawing.prepend(layer);
}

function renderHeatmapNote() {
  const shown = net.heatmap && (net.view === 'mesh' ? !!shownTopology() : !!(net.state && net.state.floorplan));
  document.getElementById('heatmap-note').classList.toggle('d-none', !shown);
  document.getElementById('heat-scale').classList.toggle('d-none', !shown);
}

// Red (5 dB and under) to amber (15 dB) to green (25 dB and over), as for the links' colours.
function marginColor(margin) {
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

// ------------------------------------------------------------------ check my connection

const doctorMarks = { ok: ['text-success', '✓'], warn: ['text-warning', '!'], fail: ['text-danger', '✗'], skip: ['text-body-secondary', '○'] };
const millis = (v) => v === null || v === undefined ? '–' : v < 1 ? '< 1 ms' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
const roughly = (s) => s === null || s === undefined ? '–' : s < 1 ? '< 1 s' : s < 90 ? `≈ ${Math.round(s)} s` : `≈ ${Math.round(s / 60)} min`;

async function runDoctor(device = null) {
  document.getElementById('doctor-title').textContent = device ? `Check the connection to ${deviceName(device)}` : 'Check my connection';
  const body = document.getElementById('doctor-body');
  body.replaceChildren(h('p', { class: 'text-body-secondary mb-0' }, 'Checking the border router, finding boards, the route, ' +
    'then each board. A sleepy board can take a few seconds to answer…'));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('doctor-modal')).show();
  let result;
  try {
    result = await api('POST', '/api/doctor', device ? { device_id: device.device_id } : {}, { quiet: true });
  } catch (error) {
    body.replaceChildren(h('p', { class: 'text-danger mb-0' }, error.message));
    return;
  }
  if (result.ok) {
    try { localStorage.setItem('hacoap-doctor-ok', '1'); } catch (error) { /* not remembered */ }
  }
  body.replaceChildren(
    h('p', { class: `fw-bold ${result.ok ? 'text-success' : 'text-danger'}` }, result.summary),
    h('ol', { class: 'list-unstyled doctor-steps' }, result.steps.map((s) => {
      const [cls, mark] = doctorMarks[s.state] || doctorMarks.skip;
      return h('li', { class: 'mb-2' }, h('span', { class: `${cls} me-2` }, mark), h('b', {}, s.name), ': ', s.detail,
        s.advice && s.state !== 'ok' ? h('div', { class: 'small text-body-secondary ms-4' }, s.advice) : null);
    })),
    result.devices.length ? h('div', { class: 'table-responsive' }, h('table', { class: 'table table-sm small mb-2' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Board'), h('th', { class: 'text-end' }, 'CoAP'),
        h('th', { class: 'text-end' }, 'mcumgr: first'), h('th', { class: 'text-end' }, 'then'), h('th', { class: 'text-end' }, 'Update upload'))),
      h('tbody', {}, result.devices.map((d) => h('tr', {},
        h('td', {}, d.name, d.error ? h('div', { class: 'text-danger' }, d.error) : null),
        h('td', { class: 'text-end' }, millis(d.coap_ms)), h('td', { class: 'text-end' }, millis(d.mcumgr_first_ms)),
        h('td', { class: 'text-end' }, millis(d.mcumgr_ms)), h('td', { class: 'text-end' }, roughly(d.upload_s))))))) : null,
    result.devices.length ? h('p', { class: 'small text-body-secondary mb-0' }, 'The first mcumgr answer can wait for a sleepy ' +
      'board\'s next poll (up to 3 s); after it, the board polls fast, as during an update. The upload estimate is one ' +
      'packet per round trip, for the release image (or 300 KB without one).') : null);
}

document.getElementById('doctor-run').addEventListener('click', () => runDoctor());

// ------------------------------------------------------------------ labels

// Sheets: the printed page's size and margins, so the labels land on the sheet's own.
const LABEL_SHEETS = {
  a4: { page: 'A4', margin: '15.1mm 7.2mm' },
  letter: { page: 'letter', margin: '12.7mm 4.8mm' },
  roll: { page: '62mm 29mm', margin: '0' },
};

function labelDevices() {
  const all = [...state.devices.values()];
  const which = document.getElementById('labels-which').value;
  return (which === 'all' ? all : all.filter((d) => state.selected.has(d.device_id)))
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
}

function labelCard(device) {
  return h('div', { class: 'label' },
    svg('svg', { class: 'label-logo', viewBox: '0 0 512 512' }, svg('use', { href: '#hacoap-glyph' })),
    h('div', { class: 'label-text' },
      h('div', { class: 'label-name' }, deviceName(device)),
      device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? h('div', { class: 'label-plant' }, device.plant) : null,
      device.location ? h('div', { class: 'label-detail' }, device.location) : null,
      h('div', { class: 'label-id' }, `ID ${device.device_id}`)));
}

function renderLabelPreview() {
  const devices = labelDevices();
  const sheet = document.getElementById('labels-sheet').value;
  document.getElementById('labels-preview').className = `labels-preview sheet-${sheet}`;
  document.getElementById('labels-preview').replaceChildren(...(devices.length ? devices.slice(0, 6).map(labelCard)
    : [h('p', { class: 'text-body-secondary' }, 'No devices: tick some on the list, or choose All of them.')]));
  document.getElementById('labels-count').textContent = devices.length
    ? `${devices.length} label(s)${devices.length > 6 ? ', the first 6 shown' : ''}` : '';
}

document.getElementById('labels-open').addEventListener('click', () => {
  document.getElementById('labels-which').value = state.selected.size ? 'selected' : 'all';
  renderLabelPreview();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('labels-modal')).show();
});
document.getElementById('labels-which').addEventListener('change', renderLabelPreview);
document.getElementById('labels-sheet').addEventListener('change', renderLabelPreview);
document.getElementById('labels-print').addEventListener('click', () => {
  const devices = labelDevices();
  if (!devices.length) return notify('No devices to print: tick some, or choose All of them', 'warning');
  const sheet = document.getElementById('labels-sheet').value;
  const target = document.getElementById('labels-sheet-print');
  target.className = `labels-print sheet-${sheet}`;
  target.replaceChildren(...devices.map(labelCard));
  let page = document.getElementById('labels-page');
  if (!page) {
    page = h('style', { id: 'labels-page' });
    document.head.append(page);
  }
  page.textContent = `@page { size: ${LABEL_SHEETS[sheet].page}; margin: ${LABEL_SHEETS[sheet].margin}; }`;
  document.body.classList.add('printing-labels');
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-labels');
    page.textContent = '';
  }, { once: true });
  bootstrap.Modal.getOrCreateInstance(document.getElementById('labels-modal')).hide();
  setTimeout(() => window.print(), 400);  // once the dialog has closed
});

// ------------------------------------------------------------------ data: space used, keeping it in bounds

const megabytes = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

function renderStorage(usage) {
  const names = { database: 'database', images: 'images', photos: 'photos', backups: 'backups', builds: 'build settings', other: 'other' };
  const parts = Object.entries(usage.parts).filter(([, size]) => size > 0)
    .map(([name, size]) => `${names[name] || name} ${megabytes(size)}`);
  const rows = usage.rows;
  document.getElementById('storage').replaceChildren(
    h('div', {}, h('b', {}, megabytes(usage.total)), parts.length ? ` · ${parts.join(' · ')}` : ''),
    h('div', { class: 'text-body-secondary' }, `${rows.readings.toLocaleString()} readings, ${rows.link_samples.toLocaleString()} link ` +
      `samples, ${rows.network_snapshots.toLocaleString()} network readings, ${rows.activity.toLocaleString()} pump runs`));
}

async function loadStorage() {
  renderStorage(await api('GET', '/api/storage', undefined, { quiet: true }));
}

document.getElementById('storage-prune').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/storage/prune');
  notify(`Deleted ${result.removed.rows} old row(s) and ${result.removed.network} network reading(s)`, 'success');
  renderStorage(result);
}));
document.getElementById('storage-compact').addEventListener('click', (event) => busy(event.target, async () => {
  renderStorage(await api('POST', '/api/storage/compact'));
  notify('Database compacted', 'success', 3000);
}));

// ------------------------------------------------------------------ running in the background

async function loadAutostart() {
  const st = await api('GET', '/api/autostart', undefined, { quiet: true });
  const toggle = document.getElementById('autostart-toggle');
  toggle.checked = st.enabled;
  toggle.disabled = !st.supported;
  document.getElementById('background-address').textContent = location.origin + '/';
  document.getElementById('background-address').href = location.origin + '/';
  document.getElementById('autostart-note').textContent = st.supported
    ? `In the background it writes its log to ${st.log}.`
    : 'Not available here.';
}

document.getElementById('autostart-toggle').addEventListener('change', async (event) => {
  try {
    const st = await api('PUT', '/api/autostart', { enabled: event.target.checked });
    event.target.checked = st.enabled;
    notify(st.enabled ? 'It will start with this computer, in the background' : 'It won\'t start with this computer', 'success');
  } catch (error) {
    event.target.checked = !event.target.checked;
  }
});
document.getElementById('quit-app').addEventListener('click', async () => {
  if (!confirm('Stop the fleet manager? It stops collecting readings until it starts again.')) return;
  try {
    await api('POST', '/api/quit');
  } catch (error) {
    return;
  }
  document.querySelector('main').replaceChildren(h('div', { class: 'p-5 text-center' },
    h('h4', {}, 'The fleet manager has stopped.'), h('p', { class: 'text-body-secondary' }, 'Start it again to use this page.')));
});

// ------------------------------------------------------------------ Home Assistant history

async function loadHomeAssistant() {
  const st = await api('GET', '/api/home-assistant', undefined, { quiet: true });
  document.getElementById('ha-url').value = st.url;
  document.getElementById('ha-token').value = '';
  document.getElementById('ha-token').placeholder = st.token_set ? 'saved (paste a new one to replace it)' : 'paste it here';
  document.getElementById('ha-token-state').textContent = st.token_set ? 'A token is saved.' : 'No token yet.';
}

document.getElementById('ha-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = document.getElementById('ha-token').value.trim();
  await api('PUT', '/api/home-assistant', { url: document.getElementById('ha-url').value.trim(), token: token || null })
    .then(() => { notify('Saved', 'success', 2000); loadHomeAssistant(); }, () => {});
});
document.getElementById('ha-check').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/home-assistant/check');
  const boards = result.boards;
  document.getElementById('ha-boards').replaceChildren(
    h('div', { class: 'text-success mb-1' }, `Connected to Home Assistant ${result.version}${result.name ? ` (${result.name})` : ''}: ` +
      `${boards.length} ha-coap board(s).`),
    boards.length ? h('ul', { class: 'mb-0 ps-3' }, boards.map((b) => h('li', {}, h('b', {}, b.ha_name), ' → ',
      b.name ? b.name : h('span', { class: 'text-warning' }, b.device_id ? `device ${b.device_id}, not in the app yet` : 'no device ID'),
      h('span', { class: 'text-body-secondary' }, ` · ${Object.keys(b.entities).length} sensor(s)`)))) : null);
}));
document.getElementById('ha-import').addEventListener('click', (event) => busy(event.target, async () => {
  const result = await api('POST', '/api/home-assistant/import', { days: Number(document.getElementById('ha-days').value) });
  notify(`Imported ${result.imported} reading(s) from Home Assistant`, 'success');
  document.getElementById('ha-boards').replaceChildren(h('ul', { class: 'mb-0 ps-3' }, result.results.map((r) => h('li', {},
    h('b', {}, r.ha_name), r.device_id ? ` → ${r.name}: ${r.imported} reading(s)` : '', r.note ? h('span', { class: 'text-warning' }, ` ${r.note}`) : null))));
  loadStorage().catch(() => {});
}));

// ------------------------------------------------------------------ wall display

// Full screen for a spare monitor: every plant big, the ones that need water first, a page
// at a time when they don't all fit, turning every 15 seconds.
const wall = { plants: [], page: 0, timers: [], soon: null };
const WALL_PAGE = 6;

async function loadWall() {
  wall.plants = await api('GET', '/api/wall', undefined, { quiet: true });
  if (!wall.timers.length) {
    wall.timers.push(setInterval(() => { wall.page += 1; renderWall(); }, 15000));
    wall.timers.push(setInterval(() => loadWall().catch(() => {}), 60000));
    wall.timers.push(setInterval(renderWallClock, 1000));
  }
  renderWallClock();
  renderWall();
}

function loadWallSoon() {  // after device events, at most every few seconds
  clearTimeout(wall.soon);
  wall.soon = setTimeout(() => loadWall().catch(() => {}), 3000);
}

function stopWall() {
  wall.timers.forEach(clearInterval);
  wall.timers = [];
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function renderWallClock() {
  const now = new Date();
  document.getElementById('wall-clock').textContent =
    `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderWall() {
  const plants = wall.plants;
  const pages = Math.max(1, Math.ceil(plants.length / WALL_PAGE));
  const page = wall.page % pages;
  const thirsty = plants.filter((p) => p.needs_water);
  document.getElementById('wall-banner').replaceChildren(thirsty.length
    ? h('span', { class: 'wall-alert' }, `💧 ${thirsty.map((p) => p.name).join(', ')} ${thirsty.length > 1 ? 'need' : 'needs'} water`)
    : h('span', { class: 'wall-ok' }, 'Every plant has enough water'));
  document.getElementById('wall-grid').replaceChildren(...plants.slice(page * WALL_PAGE, (page + 1) * WALL_PAGE).map((p) => {
    const soil = p.soil_moisture;
    const fill = soil === null || soil === undefined ? 0 : Math.max(0, Math.min(100, soil));
    return h('div', { class: `wall-card${p.needs_water ? ' thirsty' : ''}${p.online ? '' : ' offline'}` },
      p.photo ? h('img', { class: 'wall-photo', src: photoUrl(p), alt: '' })
        : h('div', { class: 'wall-photo empty' }, svg('svg', { viewBox: '0 0 512 512' }, svg('use', { href: '#hacoap-glyph' }))),
      h('div', { class: 'wall-body' },
        h('div', { class: 'wall-name' }, p.name),
        h('div', { class: 'wall-plant' }, [p.plant && p.plant.toLowerCase() !== p.name.toLowerCase() ? p.plant : null, p.location].filter(Boolean).join(' · ')),
        h('div', { class: 'wall-soil' }, h('span', { class: 'wall-value' }, soil === null || soil === undefined ? '–' : `${soil} %`), ' soil'),
        h('div', { class: 'wall-bar' }, h('div', { class: 'wall-bar-fill', style: `width: ${fill}%` }),
          p.water_target ? h('div', { class: 'wall-bar-target', style: `left: ${p.water_target}%`, title: `water under ${p.water_target} %` }) : null),
        h('div', { class: 'wall-note' }, p.needs_water ? 'needs water now'
          : p.water_forecast && p.water_forecast.days !== null ? `water ${waterIn(p.water_forecast)}` : ''),
        h('div', { class: 'wall-meta' }, `battery ${pct(p.battery)}`, p.online ? '' : ' · offline')));
  }));
  document.getElementById('wall-foot').textContent = pages > 1 ? `page ${page + 1} of ${pages}` : '';
}

document.getElementById('wall-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => notify('This browser won\'t go full screen', 'warning'));
});

// ------------------------------------------------------------------ getting started

// A checklist on the dashboard until it's done (or hidden): each step ticks itself off.
async function renderGuide(d) {
  const box = document.getElementById('dash-guide');
  let hidden = false;
  let doctorOk = false;
  try {
    hidden = localStorage.getItem('hacoap-guide-hidden') === '1';
    doctorOk = localStorage.getItem('hacoap-doctor-ok') === '1';
  } catch (error) { /* shown, unticked */ }
  const status = state.status || await loadStatus().catch(() => null);
  if (hidden || (status && status.demo)) { box.classList.add('d-none'); return; }
  const autostart = await api('GET', '/api/autostart', undefined, { quiet: true }).catch(() => ({ enabled: false }));
  const anyPhoto = [...state.devices.values()].some((dev) => dev.photo);
  const steps = [
    [doctorOk, 'Check the connection', 'each step from this computer to the boards', () => runDoctor()],
    [d.counts.devices > 0, 'Find your boards', 'Devices tab', runOnTab('devices', 'discover')],
    [!!d.network_read, 'Read the network', 'needs the border router\'s address', runOnTab('network', 'network-refresh')],
    [!!d.release, 'Mark the release', 'the image your fleet should run (Images tab)', () => { location.hash = '#images'; }],
    [anyPhoto, 'Add a plant photo', 'on a device\'s page', () => { location.hash = '#devices'; }],
    [autostart.enabled, 'Start with this computer', 'so history builds up (Settings)', () => { location.hash = '#settings'; }],
  ];
  const done = steps.filter(([ok]) => ok).length;
  if (done === steps.length) { box.classList.add('d-none'); return; }
  box.classList.remove('d-none');
  box.replaceChildren(
    h('div', { class: 'card-header d-flex align-items-center' }, `Getting started · ${done} of ${steps.length}`,
      h('button', { class: 'btn btn-sm btn-link ms-auto p-0', type: 'button', onclick: () => {
        try { localStorage.setItem('hacoap-guide-hidden', '1'); } catch (error) { /* shown again next time */ }
        box.classList.add('d-none');
      } }, 'Hide this')),
    h('div', { class: 'card-body' }, h('ol', { class: 'guide mb-0' }, steps.map(([ok, label, hint, run]) =>
      h('li', { class: ok ? 'done' : '' }, h('span', { class: 'guide-mark' }, ok ? '✓' : '○'),
        ok ? h('span', {}, label) : h('a', { href: '#', onclick: (e) => { e.preventDefault(); run(); } }, label),
        h('span', { class: 'small text-body-secondary ms-2' }, hint))))));
}

// ------------------------------------------------------------------ the demo

document.getElementById('demo-start').addEventListener('click', (event) => busy(event.target, async () => {
  // Opened first, then pointed at the demo: browsers block a tab opened after a wait
  const tab = window.open('', '_blank');
  try {
    const result = await api('POST', '/api/demo');
    if (tab) tab.location = result.url; else window.location.href = result.url;
  } catch (error) {
    if (tab) tab.close();
  }
}));
document.getElementById('demo-stop').addEventListener('click', async () => {
  if (!confirm('Stop the demo? Its data is thrown away.')) return;
  try {
    await api('POST', '/api/quit');
  } catch (error) {
    return;
  }
  document.querySelector('main').replaceChildren(h('div', { class: 'p-5 text-center' },
    h('h4', {}, 'The demo has stopped.'), h('p', { class: 'text-body-secondary' }, 'You can close this tab.')));
});

// ------------------------------------------------------------------ a board answering, on the map

// A short pulse from the board to its parent each time it answers, so the mesh looks alive.
const calm = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function pulseBoard(deviceId) {
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

// ------------------------------------------------------------------ weekly summary

const summaryView = { weeksBack: 0 };
const dateShort = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

async function loadSummary() {
  const days = Number(document.getElementById('summary-days').value);
  const end = Date.now() / 1000 - summaryView.weeksBack * 7 * 86400;
  renderSummary(await api('GET', `/api/summary?days=${days}&end=${end}`));
}

function renderSummary(r) {
  const section = (title, body) => h('section', { class: 'summary-section' }, h('h5', {}, title), body);
  const list = (rows, empty) => rows.length ? h('ul', { class: 'mb-0' }, rows) : h('p', { class: 'text-body-secondary mb-0' }, empty);
  const totalWaterings = r.plants.reduce((sum, p) => sum + p.waterings, 0);
  const numbers = [[r.devices, 'boards'], [`${r.online}`, 'online now'], [totalWaterings, 'waterings'],
    [r.alerts.length, 'alerts'], [r.updates.length, 'updates'], [r.parent_changes.length, 'parent changes']];
  document.getElementById('summary').replaceChildren(
    h('div', { class: 'summary-head' }, h('img', { src: '/static/logo.svg', alt: '', class: 'summary-logo' }),
      h('div', {}, h('h3', { class: 'mb-0' }, 'ha-coap fleet summary'),
        h('div', { class: 'text-body-secondary' }, `${dateShort(r.start)} to ${dateShort(r.end)} ${new Date(r.end * 1000).getFullYear()} · ${r.days} days`))),
    h('div', { class: 'summary-numbers' }, numbers.map(([value, label]) => h('div', {}, h('b', {}, value), h('span', {}, label)))),
    section('Plants', h('table', { class: 'table table-sm' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Plant'), h('th', { class: 'text-end' }, 'Soil (low to high)'), h('th', { class: 'text-end' }, 'Now'),
        h('th', { class: 'text-end' }, 'Waterings'), h('th', {}, 'Next'))),
      h('tbody', {}, r.plants.map((p) => h('tr', {},
        h('td', {}, h('b', {}, p.name), p.plant && p.plant.toLowerCase() !== p.name.toLowerCase() ? ` · ${p.plant}` : ''),
        h('td', { class: 'text-end' }, p.soil ? `${p.soil.min} to ${p.soil.max} %` : '–'),
        h('td', { class: 'text-end' }, p.soil ? `${p.soil.last} %` : '–'),
        h('td', { class: 'text-end' }, p.waterings ? `${p.waterings}${p.pump_runs ? ` (${p.pump_runs} from the app)` : ''}` : '0'),
        h('td', { class: p.needs_water ? 'text-warning' : '' }, p.needs_water ? 'needs water now'
          : p.water_forecast && p.water_forecast.days !== null ? `water ${waterIn(p.water_forecast)}` : '')))))),
    section('Batteries', h('table', { class: 'table table-sm' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Board'), h('th', { class: 'text-end' }, 'Start'), h('th', { class: 'text-end' }, 'End'),
        h('th', { class: 'text-end' }, 'Per day'), h('th', {}, 'Firmware'))),
      h('tbody', {}, r.batteries.map((b) => h('tr', {}, h('td', {}, b.name),
        h('td', { class: 'text-end' }, b.battery ? `${b.battery.first} %` : '–'), h('td', { class: 'text-end' }, b.battery ? `${b.battery.last} %` : '–'),
        h('td', { class: 'text-end' }, b.per_day !== null ? `${b.per_day.toFixed(2)} %` : '–'),
        h('td', {}, b.image_hash ? `v${b.image_version} · ${shortHash(b.image_hash)}` : '')))))),
    r.drain_by_image.length ? section('Battery drain by firmware', list(r.drain_by_image.map((g) => h('li', {},
      `${imageLabel(g.image_hash, g.version)}: ${perDay({ per_day: g.median })} over ${g.devices.length} board(s), ${fullLasts(g.days_full)}`)), '')) : null,
    section('Alerts', list(r.alerts.map((a) => h('li', {}, `${when(a.raised)}: ${a.message}`, a.cleared ? h('span', { class: 'text-body-secondary' }, ` (cleared ${when(a.cleared)})`) : '')),
      'No alerts.')),
    section('Updates', list(r.updates.map((u) => h('li', {}, `${when(u.started)}: ${u.name} to v${u.image_version}, ${u.result}`)), 'No updates.')),
    section('Network', list(r.parent_changes.map((e) => h('li', {}, `${when(e.time)}: ${e.message}`)),
      `No parent changes${r.network_readings ? ` in ${r.network_readings} network reading(s)` : ' (no network readings in this period)'}.`)),
    h('p', { class: 'small text-body-secondary mt-3 mb-0' }, `Made by the HA-CoAP Fleet Manager on ${when(Date.now() / 1000)}.`));
  document.getElementById('summary-later').disabled = summaryView.weeksBack === 0;
}

document.getElementById('summary-days').addEventListener('change', () => loadSummary().catch(() => {}));
document.getElementById('summary-earlier').addEventListener('click', () => { summaryView.weeksBack += 1; loadSummary().catch(() => {}); });
document.getElementById('summary-later').addEventListener('click', () => {
  summaryView.weeksBack = Math.max(0, summaryView.weeksBack - 1);
  loadSummary().catch(() => {});
});
document.getElementById('summary-print').addEventListener('click', () => window.print());

// ------------------------------------------------------------------ search (Ctrl+K)

const palette = { items: [], shown: [], index: 0 };

// Shows a tab, then clicks one of its buttons.
function runOnTab(tab, buttonId) {
  return () => {
    location.hash = `#${tab}`;
    setTimeout(() => document.getElementById(buttonId).click(), 100);
  };
}

const download = (url) => () => { window.location.href = url; };

function paletteItems() {
  const items = TABS.map((tab, i) => ({ kind: 'tab', label: tab, hint: `key ${i + 1}`, run: () => { location.hash = `#${tab}`; } }));
  for (const device of [...state.devices.values()].sort((a, b) => deviceName(a).localeCompare(deviceName(b)))) {
    items.push({ kind: 'device', label: deviceName(device), hint: [device.plant, device.location, device.device_id].filter(Boolean).join(' · '),
      run: () => { location.hash = `#device/${encodeURIComponent(device.device_id)}`; } });
  }
  const action = (label, hint, run) => items.push({ kind: 'action', label, hint, run });
  action('Find devices', 'devices', runOnTab('devices', 'discover'));
  action('Refresh all devices', 'devices', runOnTab('devices', 'refresh-all'));
  action('Read all firmware', 'which image each device runs', runOnTab('devices', 'read-all-slots'));
  action('Check my connection', 'each step from this computer to the boards', () => runDoctor());
  action('Print labels', 'for the pots or the boards', runOnTab('devices', 'labels-open'));
  action('Wall display', 'full screen, for a spare monitor', () => { location.hash = '#wall'; });
  action('Weekly summary', 'what happened this week, to print', () => { location.hash = '#summary'; });
  if (!(state.status && state.status.demo)) action('Start the demo', 'simulated boards, in a new tab', runOnTab('settings', 'demo-start'));
  action('Read the network', 'network', runOnTab('network', 'network-refresh'));
  action('Scan the channels', 'radio noise per channel', runOnTab('network', 'channel-scan'));
  action('Download a backup', 'settings', download('/api/backup'));
  action('Download a problem report', 'settings', download('/api/report'));
  action('Export readings (CSV)', 'every device', download('/api/readings.csv'));
  action('Export devices (CSV)', 'the device list', download('/api/devices.csv'));
  action('Next colour theme', 'T', () => cycleTheme(1));
  action(notificationsOn() ? 'Turn off notifications' : 'Turn on notifications', 'alerts in the browser', toggleNotifications);
  action('Check for an app update', 'GitHub', () => { location.hash = '#settings'; checkAppUpdate(true).catch(() => {}); });
  return items;
}

function filterPalette() {
  const words = document.getElementById('palette-input').value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = palette.items.filter((item) => {
    const text = `${item.label} ${item.hint} ${item.kind}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  // Labels that start with what was typed come first
  const first = words[0] || '';
  palette.shown = [...matches.filter((i) => i.label.toLowerCase().startsWith(first)),
    ...matches.filter((i) => !i.label.toLowerCase().startsWith(first))].slice(0, 14);
  palette.index = 0;
  renderPalette();
}

function renderPalette() {
  const list = document.getElementById('palette-list');
  list.replaceChildren(...(palette.shown.length ? palette.shown.map((item, i) => h('li', {
    class: i === palette.index ? 'active' : null, role: 'option', 'aria-selected': i === palette.index ? 'true' : 'false',
    onmousedown: (e) => { e.preventDefault(); runPaletteItem(item); },
    onmousemove: () => { if (palette.index !== i) { palette.index = i; renderPalette(); } },
  }, h('span', { class: 'kind' }, item.kind), h('span', {}, item.label), h('span', { class: 'hint' }, item.hint)))
    : [h('li', { class: 'empty' }, 'Nothing matches')]));
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  palette.items = paletteItems();
  const input = document.getElementById('palette-input');
  input.value = '';
  document.getElementById('palette').classList.remove('d-none');
  filterPalette();
  input.focus();
}

function closePalette() {
  document.getElementById('palette').classList.add('d-none');
}

function runPaletteItem(item) {
  closePalette();
  if (item) item.run();
}

document.getElementById('palette-input').addEventListener('input', filterPalette);
document.getElementById('palette-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const count = palette.shown.length;
    if (count) palette.index = (palette.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPaletteItem(palette.shown[palette.index]);
  } else if (event.key === 'Escape') {
    closePalette();
  }
});
document.getElementById('palette').addEventListener('mousedown', (event) => {
  if (event.target.id === 'palette') closePalette();  // a click beside the box
});
document.getElementById('palette-button').addEventListener('click', openPalette);

// ------------------------------------------------------------------ start

setTheme(document.documentElement.getAttribute('data-theme'));
renderClock();
setInterval(renderClock, 30000);
showTab(currentRoute());
connectEvents();
renderNotificationState();
