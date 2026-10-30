// A board's health (restarts, crashes and its link to its parent, from its 'diag' resource) and
// its own settings (the firmware's 'hacoap' mcumgr group), on its page.

import { api, busy, h, notify, state, when } from './core.js';
import { deviceName } from './devices.js';
import { detailsTable } from './network.js';
import { devicePage } from './device.js';

// As inventory.py's RESET_CAUSES says them
export const RESETS = {
  power: 'power on (a battery change, the USB plugged in, or a brownout)', pin: 'the reset button',
  soft: 'a software reset (after an update, or a reset from the app)', watchdog: 'the watchdog: it stopped responding',
  lockup: 'a CPU lockup', crash: 'a crash', other: 'another reason',
};
export const BAD_RESETS = ['watchdog', 'lockup', 'crash'];

// The settings, in the order shown, with what they are
export const BOARD_SETTINGS = [
  { name: 'sample_s', label: 'Sampling period (s)', help: 'How often it reads its sensors. Shorter: fresher readings, more battery.' },
  { name: 'pump_s', label: 'Pump run time (s)', help: 'How long the pump runs, from the app, Home Assistant or the button.' },
  { name: 'poll_ms', label: 'Poll period (ms)', help: 'How often it asks its parent for messages: commands take up to this long. Shorter uses more battery.' },
  { name: 'soil_dry_mv', label: 'Soil sensor when dry (mV)', help: 'Its output in dry soil: 0 %.' },
  { name: 'soil_wet_mv', label: 'Soil sensor when wet (mV)', help: 'Its output in water: 100 %.' },
];

export function resetText(cause, fault) {
  let text = RESETS[cause] || cause || 'unknown';
  if (cause === 'crash' && fault) {
    const [reason, address] = fault.split('@');
    text += ` (fatal error ${reason} at 0x${address})`;
  }
  return text;
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} days ${Math.floor((s % 86400) / 3600)} h`;
}

// ------------------------------------------------------------------ health

export function renderDeviceHealth(device) {
  if (device.device_id !== devicePage.id) return;
  const box = document.getElementById('device-health');
  const restarts = (devicePage.details && devicePage.details.device.device_id === device.device_id && devicePage.details.restarts) || [];
  if (device.diag_time === null || device.diag_time === undefined) {
    box.replaceChildren(h('p', { class: 'small text-body-secondary mb-0' }, device.no_diag_fw
      ? 'This board\'s firmware doesn\'t report its restarts or its link. A newer firmware does: update it.'
      : 'Not read yet: Refresh the board.'));
    return;
  }
  // Its uptime, counted on from its last answer
  const up = device.uptime_s + (device.online ? Date.now() / 1000 - device.diag_time : 0);
  const bad = BAD_RESETS.includes(device.reset_cause);
  const has = (v) => v !== null && v !== undefined;
  box.replaceChildren(detailsTable([
    ['Running for', `${duration(up)}, since ${when(device.diag_time - device.uptime_s)}`],
    ['Last restart', h('span', { class: bad ? 'text-danger' : '' }, resetText(device.reset_cause, device.fault))],
    ['Boots', `${device.boots} in all`],
    ['Its parent', device.parent_rloc16 ? [device.parent_rloc16, has(device.parent_rssi) ? `${device.parent_rssi} dBm` : null,
      has(device.link_quality) ? `quality ${device.link_quality}/3` : null].filter(Boolean).join(' · ') : (device.role || '')],
    ['Its address', device.rloc16 ? `${device.rloc16} (${device.role})` : ''],
  ]), h('div', { class: 'small fw-bold mt-3 mb-1' }, 'Restarts'),
  restarts.length ? h('ul', { class: 'list-unstyled small mb-0 restart-list' }, restarts.map((r) =>
    h('li', { class: /watchdog|lockup|crash/.test(r.message) ? 'text-danger' : '' },
      h('span', { class: 'text-body-secondary' }, `${when(r.time)} `), r.message.replace(/^Restarted: /, ''))))
    : h('p', { class: 'small text-body-secondary mb-0' }, 'None since the app started following it.'));
}

// ------------------------------------------------------------------ settings on the board

export function renderBoardSettings(device) {
  if (device.device_id !== devicePage.id) return;
  const box = document.getElementById('device-board-settings');
  const transport = h('select', { class: 'form-select form-select-sm w-auto', 'aria-label': 'How' },
    h('option', { value: 'udp' }, 'over the air'),
    device.serial_port ? h('option', { value: 'serial' }, `USB (${device.serial_port})`) : null);
  const read = h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: (e) => busy(e.target, async () => {
    const how = { transport: transport.value, serial_port: device.serial_port };
    renderSettingsForm(device, await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/board-settings/read`, how), how);
  }) }, 'Read from the board');
  const forget = h('button', { class: 'btn btn-sm btn-outline-danger ms-auto', type: 'button',
    title: 'To move it to another Thread network', onclick: (e) => {
      if (!confirm(`${device.name || device.device_id} forgets its Thread network and restarts. It drops off the network ` +
        'until a commissioner lets it join again (on your border router: commissioner start, then joiner add with its PSKd). ' +
        'Its settings stay. Go ahead?')) return;
      busy(e.target, async () => {
        await api('POST', `/api/devices/${encodeURIComponent(device.device_id)}/forget-network`,
          { transport: transport.value, serial_port: device.serial_port });
        notify('It forgot its network: open a commissioner for it to join again', 'success', 6000);
      });
    } }, 'Forget its network…');
  box.replaceChildren(
    h('p', { class: 'small text-body-secondary' }, 'The board keeps these through restarts and updates. Reading or ',
      'changing them makes it poll fast for 30 s, like an update.'),
    h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' }, read, transport, forget));
}

function renderSettingsForm(device, result, how) {
  const box = document.getElementById('device-board-settings');
  const path = `/api/devices/${encodeURIComponent(device.device_id)}/board-settings`;
  const inputs = {};
  const fields = BOARD_SETTINGS.filter((s) => result.settings[s.name]).map((s) => {
    const setting = result.settings[s.name];
    inputs[s.name] = h('input', { class: 'form-control form-control-sm', type: 'number', id: `board-${s.name}`,
      min: setting.min, max: setting.max, value: setting.value });
    return h('div', { class: 'col-sm-6' },
      h('label', { class: 'form-label small mb-1', for: `board-${s.name}` }, s.label),
      inputs[s.name],
      h('div', { class: 'form-text' }, `${s.help} Default ${setting.default}.`));
  });

  // Calibrating the soil sensor: its output now, in dry soil, then in water
  const soil = h('span', { class: 'fw-bold' }, result.soil_mv !== null ? `${result.soil_mv} mV` : 'not read');
  let soilMv = result.soil_mv;
  const measure = h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: (e) => busy(e.target, async () => {
    const fresh = await api('POST', `${path}/sample`, how);
    soilMv = fresh.soil_mv;
    soil.textContent = soilMv !== null ? `${soilMv} mV` : 'not read';
  }) }, 'Measure now');
  const use = (name) => h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => {
    if (soilMv === null) return notify('Measure the soil sensor first', 'warning');
    inputs[name].value = soilMv;
  } }, name === 'soil_dry_mv' ? 'Use as dry' : 'Use as wet');

  const save = h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save on the board');
  const form = h('form', { class: 'row g-2' }, fields,
    h('div', { class: 'col-12 calibrate' },
      h('div', { class: 'small' }, 'Soil sensor now: ', soil, ' ', measure, ' ', use('soil_dry_mv'), ' ', use('soil_wet_mv')),
      h('div', { class: 'form-text' }, 'To calibrate it: put the sensor in dry soil, Measure now, Use as dry; then in a glass of ',
        'water, Measure now, Use as wet; then Save.')),
    h('div', { class: 'col-12 d-flex flex-wrap gap-2' }, save,
      h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => {
        for (const [name, input] of Object.entries(inputs)) input.value = result.settings[name].default;
      } }, 'Defaults'),
      h('span', { class: 'small text-body-secondary align-self-center ms-auto' }, `read ${when(Date.now() / 1000)}`)));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, input] of Object.entries(inputs)) {
      if (input.value !== '' && Number(input.value) !== result.settings[name].value) values[name] = Number(input.value);
    }
    if (!Object.keys(values).length) return notify('Nothing changed', 'info', 2000);
    busy(save, async () => {
      const saved = await api('PUT', path, { values, ...how });
      notify('Saved on the board', 'success', 2500);
      renderSettingsForm(device, saved, how);
    });
  });
  box.replaceChildren(form);
}

// ------------------------------------------------------------------ the same settings on several boards

const FLEET_LIMITS = { sample_s: [10, 86400], pump_s: [1, 9], poll_ms: [101, 600000], soil_dry_mv: [1, 3600], soil_wet_mv: [0, 3599] };

export function openFleetSettings(deviceIds) {
  const body = document.getElementById('fleet-settings-body');
  const inputs = {};
  const fields = BOARD_SETTINGS.map((s) => {
    const [min, max] = FLEET_LIMITS[s.name];
    inputs[s.name] = h('input', { class: 'form-control form-control-sm', type: 'number', id: `fleet-${s.name}`, min, max,
      placeholder: 'unchanged' });
    return h('div', { class: 'col-sm-6' }, h('label', { class: 'form-label small mb-1', for: `fleet-${s.name}` }, s.label),
      inputs[s.name]);
  });
  const result = h('div', { class: 'small mt-3' });
  const save = h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save on the boards');
  const form = h('form', { class: 'row g-2' },
    h('p', { class: 'small text-body-secondary col-12 mb-1' }, `On ${deviceIds.length} board(s), over the air, one after the `,
      'other. Leave a setting empty to keep each board\'s own. A board refuses values out of its range, and then changes ',
      'nothing. The soil calibration is usually per board: see a board\'s page.'),
    fields, h('div', { class: 'col-12' }, save), result);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, input] of Object.entries(inputs)) if (input.value !== '') values[name] = Number(input.value);
    if (!Object.keys(values).length) return notify('Nothing to change', 'info', 2000);
    busy(save, async () => {
      result.textContent = 'Saving…';
      const answer = await api('POST', '/api/board-settings', { device_ids: deviceIds, values });
      result.replaceChildren(h('ul', { class: 'list-unstyled mb-0' }, Object.entries(answer.results).map(([id, error]) => {
        const device = state.devices.get(id);
        return h('li', { class: error ? 'text-danger' : 'text-success' }, `${error ? '✗' : '✓'} ${device ? deviceName(device) : id}`,
          error ? h('span', { class: 'text-body-secondary' }, `: ${error}`) : null);
      })));
    });
  });
  body.replaceChildren(form);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('fleet-settings-modal')).show();
}
