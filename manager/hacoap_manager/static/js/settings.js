// The Settings tab: settings, data, background running, Home Assistant, the demo.

import { api, busy, h, notify, state, when } from './core.js';
import { checkAppUpdate, renderNotificationState } from './dashboard.js';
import { loadDevices } from './devices.js';

// ------------------------------------------------------------------ settings

export const settingLabels = {
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
export const SETTINGS_ELSEWHERE = new Set(['home_assistant_url']);  // set in their own cards
export const SETTING_GROUPS = [
  ['Devices and plants', ['online_minutes', 'auto_refresh_minutes', 'water_below_default', 'min_battery_for_update']],
  ['Network and timing', ['border_router_url', 'coap_port', 'smp_port', 'udp_mtu', 'serial_buffer', 'coap_timeout_s',
    'mcumgr_timeout_s', 'discovery_timeout_s', 'reboot_timeout_s']],
  ['Keeping data', ['keep_readings_days', 'keep_network_readings', 'keep_backups']],
  ['App', ['check_app_updates']],
];

// The side menu: one entry per group of settings and per card, the one in view lit up
let navWatch = null;
export function renderSettingsNav() {
  const targets = [...document.querySelectorAll('#tab-settings [data-nav]')];
  const links = new Map(targets.map((el) => [el, h('a', { href: `#settings`, class: 'settings-nav-link', onclick: (e) => {
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, el.dataset.nav)]));
  document.getElementById('settings-nav').replaceChildren(...links.values());
  if (navWatch) navWatch.disconnect();
  navWatch = new IntersectionObserver((seen) => {
    const visible = seen.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    for (const [el, link] of links) link.classList.toggle('active', el === visible.target);
  }, { rootMargin: '-10% 0px -70% 0px' });
  targets.forEach((el) => navWatch.observe(el));
}

export async function loadSettings() {
  const status = await api('GET', '/api/status');
  state.status = status;
  const form = document.getElementById('settings-form');
  const field = ([key, value]) => {
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
  };
  // In groups, each with its heading (and its entry in the side menu); a setting in no group goes last
  const entries = Object.entries(status.settings).filter(([key]) => !SETTINGS_ELSEWHERE.has(key));
  const grouped = new Set(SETTING_GROUPS.flatMap(([, keys]) => keys));
  const groups = [...SETTING_GROUPS, ['Other', entries.map(([k]) => k).filter((k) => !grouped.has(k))]];
  form.replaceChildren(...groups.filter(([, keys]) => keys.some((k) => k in status.settings)).flatMap(([title, keys]) => [
    h('h6', { class: 'col-12 settings-group', id: `group-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`, 'data-nav': title }, title),
    ...entries.filter(([key]) => keys.includes(key)).map(field)]),
  h('div', { class: 'col-12' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
  renderSettingsNav();
  const about = [['Version', status.version], ['Data folder', status.data_dir],
    ['Firmware checkout', status.repository || 'not found (builds can still be added as files)'],
    ['Discovery', status.discovery_available ? 'available' : 'unavailable (zeroconf missing)'],
    ['Listening on', `${location.host} (this computer only)`]];
  document.getElementById('about').replaceChildren(...about.flatMap(([k, v]) =>
    [h('dt', { class: 'col-sm-4' }, k), h('dd', { class: 'col-sm-8 text-break' }, v)]));
  renderNotificationState();
  checkAppUpdate().catch(() => {});
}

export async function loadBackups() {
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

// ------------------------------------------------------------------ data: space used, keeping it in bounds

export const megabytes = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

export function renderStorage(usage) {
  const names = { database: 'database', images: 'images', photos: 'photos', backups: 'backups', builds: 'build settings', other: 'other' };
  const parts = Object.entries(usage.parts).filter(([, size]) => size > 0)
    .map(([name, size]) => `${names[name] || name} ${megabytes(size)}`);
  const rows = usage.rows;
  document.getElementById('storage').replaceChildren(
    h('div', {}, h('b', {}, megabytes(usage.total)), parts.length ? ` · ${parts.join(' · ')}` : ''),
    h('div', { class: 'text-body-secondary' }, `${rows.readings.toLocaleString()} readings, ${rows.link_samples.toLocaleString()} link ` +
      `samples, ${rows.network_snapshots.toLocaleString()} network readings, ${rows.activity.toLocaleString()} pump runs`));
}

export async function loadStorage() {
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

export async function loadAutostart() {
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

export async function loadHomeAssistant() {
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
