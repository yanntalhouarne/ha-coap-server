// The Devices tab: the list, groups, actions on the ticked devices, labels, the connection check.

import { ago, api, busy, h, notify, pct, photoUrl, shortHash, state, svg, undoable, when } from './core.js';
import { changedFrom, countTo, pulse, reducedMotion, showPumping, slide, waitForBoard } from './motion.js';
import { currentRoute, showTab } from './tabs.js';
import { net, redrawNetwork } from './network.js';
import { renderStatusDevices } from './live.js';
import { renderConsoleBoards } from './console.js';
import { openFleetSettings } from './board.js';
import { statusClass } from './updates.js';

// ------------------------------------------------------------------ devices

export async function loadDevices() {
  const [devices, images] = await Promise.all([api('GET', '/api/devices'), api('GET', '/api/images')]);
  state.images = images;
  state.release = images.find((i) => i.release) || null;
  state.devices = new Map(devices.filter((d) => !removing.has(d.device_id)).map((d) => [d.device_id, d]));
  for (const id of [...state.selected]) if (!state.devices.has(id)) state.selected.delete(id);
  renderDevices();
  // The map's boards show their photo and soil: draw it again once the devices are known
  if (currentRoute().split('/')[0] === 'network' && net.state) {
    redrawNetwork();
  }
  if (currentRoute().split('/')[0] === 'console') renderConsoleBoards();
}

export function deviceName(device) { return device.name || device.device_id; }

// Boards removed from the list, during the seconds their removal can be undone
export const removing = new Set();

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

// A ring gauge: the soil moisture, with the watering target marked. With a 'key', a new value
// sweeps from the one shown before under that key, and its number counts to it.
export function soilGauge(soil, target, size = 64, key = null) {
  const r = size / 2 - 5, around = 2 * Math.PI * r;
  const at = (v) => (Math.max(0, Math.min(100, v)) / 100) * around;
  const before = key ? changedFrom(key, soil) : null;
  const arc = missing(soil) ? null : svg('circle', { r, class: 'gauge', transform: 'rotate(-90)',
    'stroke-dasharray': `${at(before ?? soil)} ${around}` });
  const value = svg('text', { x: 0, y: 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'gauge-value' },
    missing(soil) ? '–' : `${soil}%`);
  const gauge = svg('svg', { class: 'soil-gauge', viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
    svg('circle', { r, class: 'gauge-track' }), arc,
    target ? svg('line', { x1: 0, y1: -r - 4, x2: 0, y2: -r + 4, class: 'gauge-target', transform: `rotate(${(target / 100) * 360})` }) : null,
    value);
  if (before !== null && arc) {
    // Drawn at the old value, then (once on the page) swept to the new one
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dasharray', `${at(soil)} ${around}`)));
    if (!reducedMotion()) {
      const from = before, start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / 700);
        value.textContent = `${Math.round(from + (soil - from) * (1 - (1 - k) ** 3))}%`;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    gauge.classList.add('just-changed');
  }
  return gauge;
}

function deviceCard(device) {
  const id = device.device_id;
  const open = () => { location.hash = `#device/${encodeURIComponent(id)}`; };
  const forecast = (deviceView.forecasts.get(id) || {}).water_forecast;
  const status = imageStatus(device);
  const water = device.needs_water ? 'needs water now'
    : forecast && forecast.days !== null && forecast.days !== undefined ? `water ${waterWhen(forecast.days)}` : '';
  const battery = h('b', {});
  countTo(battery, `card:${id}:battery`, device.battery, (v) => `${v} %`);
  const fwChanged = changedFrom(`card:${id}:image`, device.image_hash || null) !== null;
  return h('article', { class: `device-card${state.selected.has(id) ? ' selected' : ''}${device.needs_water ? ' dry' : ''}${device.online ? '' : ' offline'}`,
    'data-id': id, 'data-board': id },
    h('input', { class: 'form-check-input card-check', type: 'checkbox', checked: state.selected.has(id), 'aria-label': `Select ${deviceName(device)}`,
      onchange: (e) => { e.target.checked ? state.selected.add(id) : state.selected.delete(id); renderDevices(); } }),
    h('button', { class: 'card-photo', type: 'button', onclick: open, 'aria-label': `Open ${deviceName(device)}` },
      device.photo ? h('img', { src: photoUrl(device), alt: '', loading: 'lazy' })
        : svg('svg', { viewBox: '0 0 512 512', class: 'card-glyph' }, svg('use', { href: '#hacoap-glyph' }))),
    h('div', { class: 'card-main' },
      h('a', { class: 'card-name', href: `#device/${encodeURIComponent(id)}` }, deviceName(device)),
      h('div', { class: 'card-sub' }, [device.plant && device.plant.toLowerCase() !== deviceName(device).toLowerCase() ? device.plant : null,
        device.location].filter(Boolean).join(' · ') || '\u00a0'),
      h('div', { class: 'card-stats' }, soilGauge(device.soil_moisture, device.water_target, 64, `card:${id}:soil`),
        h('div', { class: 'card-figures' },
          h('div', {}, h('span', { class: 'card-label' }, 'battery'), battery),
          h('div', { class: 'card-bar' }, h('i', { style: `width: ${missing(device.battery) ? 0 : device.battery}%`,
            class: !missing(device.battery) && device.battery <= 20 ? 'low' : '' })),
          h('div', { class: `card-water${device.needs_water ? ' now' : ''}` }, water))),
      h('div', { class: 'card-foot' }, h('span', { class: `online-dot ${device.online ? 'on' : 'off'}` }), ago(device.last_seen),
        status === 'outdated' ? h('span', { class: 'badge text-bg-warning ms-auto' }, 'behind') : null,
        fwChanged && status === 'current' ? h('span', { class: 'badge text-bg-success ms-auto flip' }, 'updated') : null)));
}

const waterWhen = (days) => (days === 0 ? 'now' : days < 0.5 ? 'within hours' : days < 1.5 ? 'in about a day' : `in about ${Math.round(days)} days`);

export function setDeviceView(mode) {
  deviceView.mode = mode;
  remember('hacoap-devices-view', mode);
  renderDevices();
}

document.getElementById('view-table').addEventListener('click', () => setDeviceView('table'));
document.getElementById('view-cards').addEventListener('click', () => setDeviceView('cards'));
document.getElementById('view-health').addEventListener('click', () => setDeviceView('health'));
document.getElementById('device-sort').value = deviceView.sort;
document.getElementById('device-sort').addEventListener('change', (event) => {
  deviceView.sort = event.target.value;
  remember('hacoap-devices-sort', deviceView.sort);
  renderDevices();
});

export function renderDevices() {
  const body = document.querySelector('#devices-table tbody');
  const visible = sortDevices(visibleDevices());
  const mode = ['cards', 'health'].includes(deviceView.mode) ? deviceView.mode : 'table';
  const cards = mode === 'cards';
  if (cards || deviceView.sort === 'water') loadForecasts().catch(() => {});
  if (mode === 'health') loadFleetHealth().catch(() => {});
  for (const view of ['table', 'cards', 'health']) document.getElementById(`view-${view}`).classList.toggle('active', mode === view);
  document.getElementById('devices-table-wrap').classList.toggle('d-none', mode !== 'table');
  document.getElementById('device-cards').classList.toggle('d-none', !cards);
  document.getElementById('device-health-wrap').classList.toggle('d-none', mode !== 'health');
  body.replaceChildren(...visible.map(deviceRow));
  if (cards) {
    const container = document.getElementById('device-cards');
    slide(container, () => container.replaceChildren(...visible.map(deviceCard)));
  }
  if (mode === 'health') renderFleetHealth(visible);
  showPumping();
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
  const firmware = h('td', { class: changedFrom(`row:${id}:image`, device.image_hash || null) !== null ? 'flip' : null },
    h('span', { class: 'mono', title: 'Git commit of the firmware' }, device.fw_version || '–'),
    status ? h('span', { class: `badge text-bg-${imageStatusClass[status]} ms-2`,
      title: 'Compared with the release image (Images tab)' }, status) : null,
    device.image_version ? h('div', { class: 'small text-body-secondary', title: `Image ${device.image_hash}` },
      `v${device.image_version} · ${shortHash(device.image_hash)}`) : null);
  const action = (label, handler) => h('li', {}, h('a', { class: 'dropdown-item', href: '#', onclick: (e) => { e.preventDefault(); handler(device); } }, label));
  return h('tr', { 'data-id': id, 'data-board': id },
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

// Asks the board for its status. With a button, it waits for the board on it (see motion.js).
export async function refreshDevice(device, button = null) {
  const ask = () => api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/refresh`);
  const updated = button ? await waitForBoard(button, ask, device.device_id) : await ask().catch(() => null);
  if (updated && !button) pulse(device.device_id);
  if (updated && updated.last_error) notify(`${deviceName(device)}: ${updated.last_error}`, 'warning');
  return updated;
}

export async function pingDevice(device, button = null) {
  const ask = () => api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/ping`);
  if (button) {
    await waitForBoard(button, ask, device.device_id);
    return;
  }
  await ask().then(() => {
    pulse(device.device_id);
    notify(`${deviceName(device)} beeped`, 'success', 3000);
  }, () => {});
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
  removeDevices([device]);
}

// Takes boards off the list at once, and removes them for good after a few seconds, unless
// undone. They stay on the network, and come back with Find devices.
export function removeDevices(devices) {
  const removed = devices.filter(Boolean);
  if (!removed.length) return;
  for (const device of removed) {
    removing.add(device.device_id);
    state.devices.delete(device.device_id);
    state.selected.delete(device.device_id);
  }
  renderDevices();
  undoable(removed.length === 1 ? `${deviceName(removed[0])} is off the list.` : `${removed.length} devices are off the list.`,
    async () => {
      for (const device of removed) {
        await api('DELETE', devicePath(device), undefined, { quiet: true, keepalive: true }).catch(() => {});
        removing.delete(device.device_id);
      }
      loadDevices().catch(() => {});
    },
    () => {
      for (const device of removed) {
        removing.delete(device.device_id);
        state.devices.set(device.device_id, device);
      }
      renderDevices();
    });
}

// ------------------------------------------------------------------ the health view: one row per board, to spot the one that struggles

const health = { rows: new Map(), fetched: 0, sort: remembered('hacoap-health-sort', 'restarts') };

async function loadFleetHealth() {
  if (Date.now() - health.fetched < 30000) return;
  health.fetched = Date.now();
  const rows = await api('GET', '/api/fleet-health', undefined, { quiet: true });
  health.rows = new Map(rows.map((r) => [r.device_id, r]));
  if (deviceView.mode === 'health') renderFleetHealth(sortDevices(visibleDevices()));
}

const HEALTH_COLUMNS = [
  ['name', 'board', null],
  ['restarts', 'restarts (7 days)', (d, r) => -((r.bad_restarts || 0) * 1000 + (r.restarts || 0))],
  ['srp', 'name on the LAN', (d) => ({ failed: 0, pending: 1, off: 2, registered: 3 }[d.srp_state] ?? 4)],
  ['signal', 'signal', (d) => (missing(d.parent_rssi) ? Infinity : d.parent_rssi)],
  ['battery', 'battery', (d) => lastly(d.battery)],
  ['drain', 'drain', (d, r) => -(r.drain_per_day ?? -Infinity)],
  ['firmware', 'firmware', (d, r) => ({ outdated: 0, unknown: 1, 'no-release': 2, current: 3 }[r.image_status] ?? 4)],
  ['seen', 'last seen', (d) => -(d.last_seen || 0)],
];

export function renderFleetHealth(visible) {
  const column = HEALTH_COLUMNS.find(([key]) => key === health.sort) || HEALTH_COLUMNS[1];
  const rowOf = (d) => health.rows.get(d.device_id) || {};
  const rows = column[2] ? [...visible].sort((a, b) => (column[2](a, rowOf(a)) - column[2](b, rowOf(b))) ||
    deviceName(a).localeCompare(deviceName(b))) : visible;
  const signal = (d) => missing(d.parent_rssi) ? '–'
    : `${d.parent_rssi} dBm${missing(d.link_quality) ? '' : ` · ${d.link_quality}/3`}`;
  const srp = { registered: ['registered', 'text-success'], pending: ['registering…', 'text-warning'],
    failed: ['refused', 'text-danger'], off: ['not on a network', 'text-body-secondary'] };
  const firmware = { current: ['release', 'success'], outdated: ['behind', 'warning'], unknown: ['not read', 'secondary'],
    'no-release': ['no release', 'secondary'] };
  const head = h('tr', {}, HEALTH_COLUMNS.map(([key, label]) => h('th', { class: `sortable${key === health.sort ? ' sorted' : ''}`,
    scope: 'col', onclick: () => { health.sort = key; remember('hacoap-health-sort', key); renderFleetHealth(visible); } }, label)));
  document.getElementById('device-health-table').replaceChildren(h('thead', {}, head), h('tbody', {}, rows.map((d) => {
    const r = rowOf(d);
    const [srpText, srpClass] = srp[d.srp_state] || ['–', 'text-body-secondary'];
    const [fwText, fwClass] = firmware[r.image_status] || ['–', 'secondary'];
    return h('tr', { 'data-board': d.device_id },
      h('td', {}, h('a', { href: `#device/${encodeURIComponent(d.device_id)}`, class: 'device-link' }, deviceName(d))),
      h('td', { class: r.bad_restarts ? 'text-danger' : '' }, r.restarts ? `${r.restarts}${r.bad_restarts ? ` (${r.bad_restarts} bad)` : ''}` : '0',
        d.reset_cause ? h('div', { class: 'small text-body-secondary' }, `last: ${d.reset_cause}`) : null),
      h('td', { class: srpClass }, srpText),
      h('td', { class: 'text-nowrap' }, signal(d)),
      h('td', { class: !missing(d.battery) && d.battery <= 20 ? 'text-danger' : '' }, pct(d.battery)),
      h('td', { class: 'text-nowrap' }, missing(r.drain_per_day) ? '–' : `${r.drain_per_day.toFixed(2)} %/day`),
      h('td', {}, h('span', { class: `badge text-bg-${fwClass}` }, fwText), d.image_version ? h('span', { class: 'small text-body-secondary ms-1' }, `v${d.image_version}`) : null),
      h('td', { class: 'text-nowrap' }, h('span', { class: `online-dot ${d.online ? 'on' : 'off'}` }), ago(d.last_seen)));
  })));
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
  ['Change the boards\' settings…', () => openFleetSettings([...state.selected])],
  ['Set the watering target…', () => {
    const value = prompt('They need water below this soil moisture (%). Leave it empty for the default (Settings).', '');
    if (value !== null) forSelected('Watering target set', (d) => patchDevice(d, { water_below: value.trim() }));
  }],
  null,
  ['Remove from the list', () => removeDevices([...state.selected].map((id) => state.devices.get(id)))],
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
