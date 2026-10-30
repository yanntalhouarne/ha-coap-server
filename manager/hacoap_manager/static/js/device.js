// A device's page: status, firmware, controls, form, charts, plant photos and presets.

import { ago, api, busy, h, notify, pct, photoUrl, shortHash, state, svg, when } from './core.js';
import { daysText, renderDeviceDrain } from './dashboard.js';
import { detailsTable, waterIn } from './network.js';
import { deviceName, devicePath, deviceTags, pingDevice, refreshDevice, removeDevice, runDoctor, showSlots, soilGauge } from './devices.js';
import { lineChart } from './charts.js';
import { prepareUpdate, statusClass } from './updates.js';
import { renderBoardSettings, renderDeviceHealth } from './board.js';
import { loadDeviceTimeline } from './timeline.js';
import { countTo, pumping, showPumping, startPumping, waitForBoard } from './motion.js';

// ------------------------------------------------------------------ one device

// range: the period the charts zoom into (null: all of it); compare: other devices drawn on them
export const devicePage = { id: null, details: null, range: null, compare: [] };
const COMPARE_COLORS = ['var(--t-magenta)', 'var(--t-yellow)', 'var(--t-text-secondary)'];
const compareDays = () => document.getElementById('device-days').value;

export async function loadDevicePage(id) {
  if (devicePage.id !== id) {
    devicePage.range = null;
    devicePage.compare = [];
  }
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
  // The plants compared, over the same days
  devicePage.compare = await Promise.all(devicePage.compare.map(async (c) => ({ ...c,
    readings: (await api('GET', `/api/devices/${encodeURIComponent(c.device_id)}/details?days=${days}`, undefined, { quiet: true })
      .catch(() => ({ readings: [] }))).readings })));
  renderCompareMenu();
  document.getElementById('device-csv').href = `/api/readings.csv?device_id=${encodeURIComponent(id)}`;
  renderDevicePhoto(details.device);
  renderDeviceStatus(details.device);
  renderDeviceFirmware(details);
  renderDeviceControls(details.device);
  renderDeviceHealth(details.device);
  if (!document.querySelector('#device-board-settings form') || document.getElementById('device-board-settings').dataset.id !== id) {
    renderBoardSettings(details.device);  // not over a form being edited
    document.getElementById('device-board-settings').dataset.id = id;
  }
  renderDeviceForm(details.device);
  renderDeviceCharts(details);
  loadDeviceTimeline(id).catch(() => {});
}

export function renderDeviceStatus(device) {
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
    h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: async (e) => {
      if (await refreshDevice(device, e.currentTarget)) await loadDevicePage(device.device_id);
    } }, 'Refresh'),
    h('button', { class: 'btn btn-sm btn-outline-secondary', title: 'Each step from this computer to this board, and how fast it answers',
      onclick: () => runDoctor(device) }, 'Check the connection')));
  renderDeviceHero(device);
  renderDeviceHealth(device);
}

// The top of the page: the plant's photo, its soil as a big gauge, and the numbers that matter
// (battery and how long it lasts, when it needs water, its signal), with the quick actions.
export function renderDeviceHero(device) {
  if (device.device_id !== devicePage.id) return;
  const details = devicePage.details && devicePage.details.device.device_id === device.device_id ? devicePage.details : null;
  const health = (details && details.health) || {};
  const link = details && details.links.length ? details.links[details.links.length - 1] : null;
  const has = (v) => v !== null && v !== undefined;
  const signal = !link ? '–' : has(link.link_margin) ? `${link.link_margin} dB` : has(link.link_quality) ? `quality ${link.link_quality}/3` : '–';
  const water = device.needs_water ? 'now' : health.water_forecast && has(health.water_forecast.days) ? waterIn(health.water_forecast)
    : device.water_target ? 'not soon' : 'not watched';
  const figure = (icon, label, value, note, cls = '') => h('div', { class: `hero-figure ${cls}` },
    svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${icon}` })),
    h('div', {}, h('div', { class: 'hero-label' }, label), h('div', { class: 'hero-value' }, value), note ? h('div', { class: 'hero-note' }, note) : null));
  const id = device.device_id;
  const pump = (e) => waitForBoard(e.currentTarget, async () => {
    const result = await api('POST', devicePath(device, '/pump'), { on: true });
    startPumping(id, result.duration || 1);
    return result;
  }, id);
  // The numbers that change with a reading count to their new value
  const battery = countTo(h('span', {}), `hero:${id}:battery`, device.battery, (v) => `${v} %`);
  const air = countTo(h('span', {}), `hero:${id}:air`, device.temperature, (v) => `${v} °C`);
  const hero = document.getElementById('device-hero');
  hero.dataset.board = id;
  hero.replaceChildren(
    h('div', { class: 'hero-photo' }, device.photo ? h('img', { src: shownPhoto(device), alt: device.plant ? `The ${device.plant}` : '' })
      : svg('svg', { viewBox: '0 0 512 512', class: 'card-glyph' }, svg('use', { href: '#hacoap-glyph' }))),
    h('div', { class: 'hero-gauge' }, soilGauge(device.soil_moisture, device.water_target, 112, `hero:${id}:soil`),
      h('div', { class: 'hero-label text-center' }, device.water_target ? `soil · water under ${device.water_target} %` : 'soil')),
    h('div', { class: 'hero-figures' },
      figure('droplet', 'needs water', water, device.plant || '', device.needs_water ? 'warn' : ''),
      figure('battery-medium', 'battery', battery, has(device.battery) ? daysText(health.battery_forecast) : '',
        has(device.battery) && device.battery <= 20 ? 'bad' : ''),
      figure('signal-low', 'signal', signal, link ? `to its parent ${link.parent}` : 'read the network to see it'),
      figure('thermometer', 'air', air, `humidity ${pct(device.air_humidity)}`)),
    h('div', { class: 'hero-actions' },
      h('button', { class: `btn btn-sm ${device.needs_water ? 'btn-primary' : 'btn-outline-primary'}`, type: 'button', onclick: pump },
        svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-droplets' })), ' Run the pump'),
      h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: (e) => pingDevice(device, e.currentTarget) },
        svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-bell-ring' })), ' Beep'),
      h('a', { class: 'btn btn-sm btn-outline-secondary', href: `#console/${encodeURIComponent(device.device_id)}`,
        title: 'Its log over the air, in the console' },
        svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-terminal' })), ' Log'),
      h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: async (e) => {
        if (await refreshDevice(device, e.currentTarget)) await loadDevicePage(device.device_id);
      } }, svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-refresh-cw' })), ' Refresh')));
  showPumping();
}

export function renderDeviceFirmware(details) {
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

export function renderDeviceControls(device) {
  const id = encodeURIComponent(device.device_id);
  const result = h('div', { class: 'small text-body-secondary mt-2' });
  const known = device.pump_s !== null && device.pump_s !== undefined;
  const show = (state) => { result.textContent = `Pump ${state.running ? 'running' : 'off'} · run time ${state.duration} s`; };
  // The run time the board last reported (it keeps it), or a blank until it's known
  const seconds = h('select', { class: 'form-select form-select-sm w-auto', 'aria-label': 'Pump run time' },
    known ? null : h('option', { value: '', selected: true, disabled: true }, '? s'),
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('option', { value: n, selected: known && n === device.pump_s }, `${n} s`)));
  if (!known) result.textContent = 'The run time isn\'t known yet: set it, or run the pump, to read it from the board.';
  const call = (body) => (e) => waitForBoard(e.currentTarget, async () => {
    const state = await api('POST', `/api/devices/${id}/pump`, body);
    show(state);
    if (body.on === true) startPumping(device.device_id, state.duration || 1);
    if (body.on === false) {
      pumping.delete(device.device_id);
      showPumping();
    }
    return state;
  }, device.device_id);
  document.getElementById('device-controls').replaceChildren(
    h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: call({ on: true }) }, 'Run the pump'),
      h('button', { class: 'btn btn-sm btn-outline-danger', onclick: call({ on: false }) }, 'Stop'),
      h('span', { class: 'small text-body-secondary ms-2' }, 'run time'), seconds,
      h('button', { class: 'btn btn-sm btn-outline-secondary', onclick: (e) => {
        if (!seconds.value) return notify('Choose a run time', 'warning');
        call({ seconds: Number(seconds.value) })(e);
      } }, 'Set'),
      h('button', { class: 'btn btn-sm btn-outline-secondary ms-auto', onclick: (e) => pingDevice(device, e.currentTarget) }, 'Beep')),
    result,
    h('div', { class: 'form-text' }, 'Commands reach a sleeping board at its next poll: up to 3 s.'));
}

export function renderDeviceForm(device) {
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
export const PLANT_PRESETS = [
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

export function plantPreset(plant) {
  const name = (plant || '').toLowerCase();
  if (!name.trim()) return null;
  const found = PLANT_PRESETS.find(([words]) => words.some((w) => name.includes(w)));
  return found ? { target: found[1], kind: found[2] } : null;
}

export function renderPlantSuggestion(plant, input) {
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
export function deviceEvents(details) {
  const updates = details.updates.filter((u) => u.finished && (u.result === 'updated' || u.result === 'failed')).map((u) => ({
    t: u.finished, kind: u.result === 'updated' ? 'update' : 'failed',
    text: u.result === 'updated' ? `updated to v${u.image_version}` : `update failed: ${u.message}` }));
  const pumps = (details.activity || []).filter((a) => a.kind === 'pump').map((a) => ({ t: a.time, kind: 'pump', text: a.message }));
  const parents = details.network_events.map((e) => ({ t: e.time, kind: 'parent', text: e.message }));
  const restarts = (details.activity || []).filter((a) => a.kind === 'restart').map((a) => ({ t: a.time, kind: 'restart', text: a.message }));
  return { updates, pumps, parents, restarts };
}

export function renderDeviceCharts(details) {
  const r = details.readings.map((x) => ({ t: x.time, ...x }));
  const pick = (key) => r.map((x) => ({ t: x.t, v: x[key] }));
  const links = details.links;
  const margins = links.filter((l) => l.link_margin !== null && l.link_margin !== undefined);
  const { updates, pumps, parents: moves, restarts } = deviceEvents(details);
  // Zoom: every chart shows the period dragged across one of them
  const zoom = { range: devicePage.range, onZoom: (t0, t1) => { devicePage.range = [t0, t1]; renderDeviceCharts(details); } };
  const name = deviceName(details.device);
  const others = (key) => devicePage.compare.map((c, i) => ({ name: c.name, color: COMPARE_COLORS[i],
    points: c.readings.map((x) => ({ t: x.time, v: x[key] })) }));
  const charts = [
    lineChart('Battery', pick('battery'), { unit: ' %', min: 0, max: 100, color: 'var(--t-green)', events: [...updates, ...restarts], overlays: others('battery'), name, ...zoom }),
    lineChart('Soil moisture', pick('soil_moisture'), { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)', events: pumps, overlays: others('soil_moisture'), name, ...zoom }),
    lineChart('Air humidity', pick('air_humidity'), { unit: ' %', min: 0, max: 100, color: 'var(--t-blue)', overlays: others('air_humidity'), name, ...zoom }),
    lineChart('Temperature', pick('temperature'), { unit: ' °C', color: 'var(--t-orange)', overlays: others('temperature'), name, ...zoom }),
    margins.length
      ? lineChart('Link to its parent', margins.map((l) => ({ t: l.time, v: l.link_margin })), { unit: ' dB', min: 0, color: 'var(--t-magenta)', step: true, events: [...moves, ...updates], name, ...zoom })
      : lineChart('Link quality to its parent', links.map((l) => ({ t: l.time, v: l.link_quality })), { min: 0, max: 3, color: 'var(--t-magenta)', step: true, events: [...moves, ...updates], name, ...zoom }),
  ];
  document.getElementById('device-zoom-reset').classList.toggle('d-none', !devicePage.range);
  const parents = [...new Set(links.map((l) => l.parent))];
  const legend = h('div', { class: 'chart-legend small text-body-secondary mt-2' }, 'Markers: ',
    h('span', { class: 'legend-event event-update' }), 'update ', h('span', { class: 'legend-event event-failed' }), 'failed update ',
    h('span', { class: 'legend-event event-pump' }), 'pump run (from the app) ', h('span', { class: 'legend-event event-parent' }),
    'parent change ', h('span', { class: 'legend-event event-restart' }), 'restart. Point at one for details.');
  const compared = devicePage.compare.length ? h('div', { class: 'chart-legend small text-body-secondary mt-1' }, 'Compared: ',
    h('span', { class: 'legend-line' }), `${name} (solid) `, ...devicePage.compare.flatMap((c, i) =>
      [h('span', { class: 'legend-line dashed', style: `--line: ${COMPARE_COLORS[i]}` }), `${c.name} `])) : null;
  const help = h('div', { class: 'small text-body-secondary mt-1' }, 'Point at a chart to read its values; drag across one to zoom into a period.');
  document.getElementById('device-charts').replaceChildren(...[h('div', { class: 'charts' }, charts), legend, compared, help,
    parents.length ? h('div', { class: 'small text-body-secondary mt-1' }, `Parents in this period: ${parents.join(', ')}`) : null].filter(Boolean));
  renderDeviceDrain(details.drain || []);
}

// The plants to compare with: up to 3, drawn dashed on the same charts
export function renderCompareMenu() {
  const menu = document.getElementById('device-compare-menu');
  const others = [...state.devices.values()].filter((d) => d.device_id !== devicePage.id)
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  const chosen = new Set(devicePage.compare.map((c) => c.device_id));
  menu.replaceChildren(...[h('div', { class: 'text-body-secondary mb-1' }, 'Draw with this one (up to 3):'), ...others.map((d) =>
    h('label', { class: 'dropdown-item d-flex gap-2 align-items-center' },
      h('input', { class: 'form-check-input m-0', type: 'checkbox', checked: chosen.has(d.device_id),
        disabled: !chosen.has(d.device_id) && chosen.size >= 3,
        onchange: (e) => compareWith(d, e.target.checked) }), deviceName(d))),
  others.length ? null : h('div', { class: 'text-body-secondary' }, 'No other devices.')].filter(Boolean));
  document.getElementById('device-compare-button').textContent = chosen.size ? `compare (${chosen.size})` : 'compare';
}

async function compareWith(device, on) {
  if (on) {
    const details = await api('GET', `/api/devices/${encodeURIComponent(device.device_id)}/details?days=${compareDays()}`, undefined, { quiet: true });
    devicePage.compare.push({ device_id: device.device_id, name: deviceName(device), readings: details.readings });
  } else {
    devicePage.compare = devicePage.compare.filter((c) => c.device_id !== device.device_id);
  }
  renderCompareMenu();
  if (devicePage.details) renderDeviceCharts(devicePage.details);
}

document.getElementById('device-zoom-reset').addEventListener('click', () => {
  devicePage.range = null;
  if (devicePage.details) renderDeviceCharts(devicePage.details);
});
document.getElementById('device-days').addEventListener('change', () => {
  devicePage.range = null;
  if (devicePage.id) loadDevicePage(devicePage.id);
});

// ------------------------------------------------------------------ the plant's photo

// Phone photos are large: shrink them to 1600 px at most (JPEG) before sending, so the page,
// the database folder and the backups stay light.
export async function shrinkPhoto(file) {
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

// The plant card: its photos over time (a slider steps through them in the photo at the top of
// the page, with the soil at each date), whether it needs water, when it will, and what a pump
// run does.
export const timeline = { device: null, photo: null, taken: [], index: -1 };

// The photo at the top of the page: the one the slider is on, or the newest.
function shownPhoto(device) {
  const taken = timeline.device === device.device_id ? timeline.taken[timeline.index] : null;
  return taken ? devicePath(device, `/photos/${taken}`) : photoUrl(device);
}

export async function loadTimeline(device) {
  timeline.taken = (await api('GET', devicePath(device, '/photos'), undefined, { quiet: true })).map((p) => p.taken);
  timeline.device = device.device_id;
  timeline.photo = device.photo;
  timeline.index = timeline.taken.length - 1;
}

export function renderDevicePhoto(device) {
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
    steps = h('div', { class: 'mb-2' }, slider,
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
  document.getElementById('device-photo').replaceChildren(...[steps,
    device.plant ? h('div', { class: 'fw-bold' }, device.plant) : null,
    h('div', { class: `small mt-1 ${device.needs_water ? 'text-warning' : 'text-body-secondary'}` }, water),
    forecast && !device.needs_water && forecast.days !== null ? h('div', { class: 'small text-body-secondary' },
      `It dries about ${forecast.per_day.toFixed(1)} % a day: it will need water ${waterIn(forecast)}.`) : null,
    effect ? h('div', { class: 'small text-body-secondary' }, `A pump run${effect.seconds ? ` of ${effect.seconds} s` : ''} ` +
      `raises its soil by about ${Math.round(effect.rise)} % (from ${effect.runs} run${effect.runs > 1 ? 's' : ''} started here).`) : null,
    h('div', { class: 'd-flex flex-wrap gap-2 mt-2' }, choose,
      taken ? h('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', onclick: async () => {
        if (confirm('Remove this photo?')) await api('DELETE', devicePath(device, `/photos/${taken}`)).catch(() => {});
      } }, timeline.taken.length > 1 ? 'Remove this one' : 'Remove photo') : null),
    input].filter(Boolean));
  renderDeviceHero(device);
}
