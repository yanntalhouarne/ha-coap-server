// The Devices tab: the list, groups, actions on the ticked devices, labels, the connection check.

import { ago, api, busy, h, notify, pct, photoUrl, shortHash, state, svg, when } from './core.js';
import { currentRoute, showTab } from './tabs.js';
import { net, redrawNetwork } from './network.js';
import { renderStatusDevices } from './live.js';
import { statusClass } from './updates.js';

// ------------------------------------------------------------------ devices

export async function loadDevices() {
  const [devices, images] = await Promise.all([api('GET', '/api/devices'), api('GET', '/api/images')]);
  state.images = images;
  state.release = images.find((i) => i.release) || null;
  state.devices = new Map(devices.map((d) => [d.device_id, d]));
  for (const id of [...state.selected]) if (!state.devices.has(id)) state.selected.delete(id);
  renderDevices();
  // The map's boards show their photo and soil: draw it again once the devices are known
  if (currentRoute().split('/')[0] === 'network' && net.state) {
    redrawNetwork();
  }
}

export function deviceName(device) { return device.name || device.device_id; }

export const deviceTags = (device) => (device.tags || '').split(',').filter(Boolean);

export function visibleDevices() {
  const text = state.filter.text.toLowerCase();
  return [...state.devices.values()].filter((d) => {
    if (state.filter.tag && !deviceTags(d).includes(state.filter.tag)) return false;
    if (!text) return true;
    return [d.name, d.device_id, d.address, d.plant, d.location, d.notes, d.tags].some((v) => (v || '').toLowerCase().includes(text));
  });
}

export function imageStatus(device) {
  if (!state.release) return null;
  if (!device.image_hash) return 'unknown';
  return device.image_hash === state.release.hash ? 'current' : 'outdated';
}
export const imageStatusClass = { current: 'success', outdated: 'warning', unknown: 'secondary' };

export function renderTagFilter() {
  const tags = [...new Set([...state.devices.values()].flatMap(deviceTags))].sort();
  const chip = (label, tag) => h('button', { type: 'button',
    class: `btn btn-sm ${state.filter.tag === tag ? 'btn-primary' : 'btn-outline-secondary'}`,
    onclick: () => { state.filter.tag = tag; renderDevices(); } }, label);
  document.getElementById('tag-filter').replaceChildren(chip('all', null), ...tags.map((t) => chip(t, t)),
    ...(tags.length ? [] : [h('span', { class: 'small text-body-secondary' }, 'none yet (add some on a device\'s page)')]));
}

// ------------------------------------------------------------------ table or cards, and the order

const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (error) { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* not remembered */ } };
export const deviceView = { mode: remembered('hacoap-devices-view', 'table'), sort: remembered('hacoap-devices-sort', 'name'),
  forecasts: new Map(), fetched: 0 };

// When each plant will need water: from the wall display's data, asked again after a minute
async function loadForecasts() {
  if (Date.now() - deviceView.fetched < 60000) return;
  deviceView.fetched = Date.now();
  const plants = await api('GET', '/api/wall', undefined, { quiet: true });
  deviceView.forecasts = new Map(plants.map((p) => [p.device_id, p]));
  renderDevices();
}

const missing = (v) => v === null || v === undefined;
const lastly = (v) => (missing(v) ? Infinity : v);

function sortDevices(list) {
  const by = {
    name: (a, b) => deviceName(a).localeCompare(deviceName(b)),
    driest: (a, b) => lastly(a.soil_moisture - (a.water_target || 0)) - lastly(b.soil_moisture - (b.water_target || 0)),
    battery: (a, b) => lastly(a.battery) - lastly(b.battery),
    seen: (a, b) => (b.last_seen || 0) - (a.last_seen || 0),
    water: (a, b) => {
      const days = (d) => (d.needs_water ? -1 : lastly(((deviceView.forecasts.get(d.device_id) || {}).water_forecast || {}).days));
      return days(a) - days(b);
    },
  }[deviceView.sort] || ((a, b) => deviceName(a).localeCompare(deviceName(b)));
  return [...list].sort((a, b) => by(a, b) || deviceName(a).localeCompare(deviceName(b)));
}

// A ring gauge: the soil moisture, with the watering target marked
export function soilGauge(soil, target, size = 64) {
  const r = size / 2 - 5, around = 2 * Math.PI * r;
  const at = (v) => (Math.max(0, Math.min(100, v)) / 100) * around;
  return svg('svg', { class: 'soil-gauge', viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
    svg('circle', { r, class: 'gauge-track' }),
    missing(soil) ? null : svg('circle', { r, class: 'gauge', transform: 'rotate(-90)', 'stroke-dasharray': `${at(soil)} ${around}` }),
    target ? svg('line', { x1: 0, y1: -r - 4, x2: 0, y2: -r + 4, class: 'gauge-target', transform: `rotate(${(target / 100) * 360})` }) : null,
    svg('text', { x: 0, y: 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'gauge-value' }, missing(soil) ? '–' : `${soil}%`));
}

function deviceCard(device) {
  const id = device.device_id;
  const open = () => { location.hash = `#device/${encodeURIComponent(id)}`; };
  const forecast = (deviceView.forecasts.get(id) || {}).water_forecast;
  const status = imageStatus(device);
  const water = device.needs_water ? 'needs water now'
    : forecast && forecast.days !== null && forecast.days !== undefined ? `water ${waterWhen(forecast.days)}` : '';
  return h('article', { class: `device-card${state.selected.has(id) ? ' selected' : ''}${device.needs_water ? ' dry' : ''}${device.online ? '' : ' offline'}` },
    h('input', { class: 'form-check-input card-check', type: 'checkbox', checked: state.selected.has(id), 'aria-label': `Select ${deviceName(device)}`,
      onchange: (e) => { e.target.checked ? state.selected.add(id) : state.selected.delete(id); renderDevices(); } }),
    h('button', { class: 'card-photo', type: 'button', onclick: open, 'aria-label': `Open ${deviceName(device)}` },
      device.photo ? h('img', { src: photoUrl(device), alt: '', loading: 'lazy' })
        : svg('svg', { viewBox: '0 0 512 512', class: 'card-glyph' }, svg('use', { href: '#hacoap-glyph' }))),
    h('div', { class: 'card-main' },
      h('a', { class: 'card-name', href: `#device/${encodeURIComponent(id)}` }, deviceName(device)),
      h('div', { class: 'card-sub' }, [device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? device.plant : null,
        device.location].filter(Boolean).join(' · ') || '\u00a0'),
      h('div', { class: 'card-stats' }, soilGauge(device.soil_moisture, device.water_target),
        h('div', { class: 'card-figures' },
          h('div', {}, h('span', { class: 'card-label' }, 'battery'), h('b', {}, pct(device.battery))),
          h('div', { class: 'card-bar' }, h('i', { style: `width: ${missing(device.battery) ? 0 : device.battery}%`,
            class: !missing(device.battery) && device.battery <= 20 ? 'low' : '' })),
          h('div', { class: `card-water${device.needs_water ? ' now' : ''}` }, water))),
      h('div', { class: 'card-foot' }, h('span', { class: `online-dot ${device.online ? 'on' : 'off'}` }), ago(device.last_seen),
        status === 'outdated' ? h('span', { class: 'badge text-bg-warning ms-auto' }, 'behind') : null)));
}

const waterWhen = (days) => (days === 0 ? 'now' : days < 0.5 ? 'within hours' : days < 1.5 ? 'in about a day' : `in about ${Math.round(days)} days`);

export function setDeviceView(mode) {
  deviceView.mode = mode;
  remember('hacoap-devices-view', mode);
  renderDevices();
}

document.getElementById('view-table').addEventListener('click', () => setDeviceView('table'));
document.getElementById('view-cards').addEventListener('click', () => setDeviceView('cards'));
document.getElementById('device-sort').value = deviceView.sort;
document.getElementById('device-sort').addEventListener('change', (event) => {
  deviceView.sort = event.target.value;
  remember('hacoap-devices-sort', deviceView.sort);
  renderDevices();
});

export function renderDevices() {
  const body = document.querySelector('#devices-table tbody');
  const visible = sortDevices(visibleDevices());
  const cards = deviceView.mode === 'cards';
  if (cards || deviceView.sort === 'water') loadForecasts().catch(() => {});
  document.getElementById('view-table').classList.toggle('active', !cards);
  document.getElementById('view-cards').classList.toggle('active', cards);
  document.getElementById('devices-table-wrap').classList.toggle('d-none', cards);
  document.getElementById('device-cards').classList.toggle('d-none', !cards);
  body.replaceChildren(...visible.map(deviceRow));
  if (cards) document.getElementById('device-cards').replaceChildren(...visible.map(deviceCard));
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

export async function showDeviceHistory(device) {
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

export function deviceRow(device) {
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

export async function refreshDevice(device) {
  const updated = await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/refresh`).catch(() => null);
  if (updated && updated.last_error) notify(`${deviceName(device)}: ${updated.last_error}`, 'warning');
}

export async function pingDevice(device) {
  await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/ping`).then(
    () => notify(`${deviceName(device)} beeped`, 'success', 3000), () => {});
}

export async function renameDevice(device) {
  const name = prompt('Name', deviceName(device));
  if (name === null) return;
  await api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, { name }).catch(() => {});
}

export async function editNotes(device) {
  const notes = prompt('Notes (location, plant, ...)', device.notes || '');
  if (notes === null) return;
  await api('PATCH', `/api/devices/${encodeURIComponent(device.device_id)}`, { notes }).catch(() => {});
}

export async function removeDevice(device) {
  if (!confirm(`Remove ${deviceName(device)} from the list? It stays on the network and comes back with Find devices.`)) return;
  await api('DELETE', `/api/devices/${encodeURIComponent(device.device_id)}`).catch(() => {});
  state.selected.delete(device.device_id);
  await loadDevices();
}

export async function showSlots(device) {
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

// ------------------------------------------------------------------ actions for the ticked devices

export async function forSelected(label, work) {
  const devices = [...state.selected].map((id) => state.devices.get(id)).filter(Boolean);
  let failed = 0;
  for (const device of devices) {
    try { await work(device); } catch (error) { failed++; }
  }
  notify(`${label}: ${devices.length - failed} of ${devices.length}${failed ? ` (${failed} didn't work)` : ''}`,
    failed ? 'warning' : 'success');
  await loadDevices();
}

export const devicePath = (device, rest = '') => `/api/devices/${encodeURIComponent(device.device_id)}${rest}`;
export const patchDevice = (device, values) => api('PATCH', devicePath(device), values, { quiet: true });

export const bulkActions = [
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

// ------------------------------------------------------------------ check my connection

export const doctorMarks = { ok: ['text-success', '✓'], warn: ['text-warning', '!'], fail: ['text-danger', '✗'], skip: ['text-body-secondary', '○'] };
export const millis = (v) => v === null || v === undefined ? '–' : v < 1 ? '< 1 ms' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
export const roughly = (s) => s === null || s === undefined ? '–' : s < 1 ? '< 1 s' : s < 90 ? `≈ ${Math.round(s)} s` : `≈ ${Math.round(s / 60)} min`;

export async function runDoctor(device = null) {
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
export const LABEL_SHEETS = {
  a4: { page: 'A4', margin: '15.1mm 7.2mm' },
  letter: { page: 'letter', margin: '12.7mm 4.8mm' },
  roll: { page: '62mm 29mm', margin: '0' },
};

export function labelDevices() {
  const all = [...state.devices.values()];
  const which = document.getElementById('labels-which').value;
  return (which === 'all' ? all : all.filter((d) => state.selected.has(d.device_id)))
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
}

export function labelCard(device) {
  return h('div', { class: 'label' },
    svg('svg', { class: 'label-logo', viewBox: '0 0 512 512' }, svg('use', { href: '#hacoap-glyph' })),
    h('div', { class: 'label-text' },
      h('div', { class: 'label-name' }, deviceName(device)),
      device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? h('div', { class: 'label-plant' }, device.plant) : null,
      device.location ? h('div', { class: 'label-detail' }, device.location) : null,
      h('div', { class: 'label-id' }, `ID ${device.device_id}`)));
}

export function renderLabelPreview() {
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
