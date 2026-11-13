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
  ping_every_minutes: ['Ping every (min)', 'A silent ping (no beep) to every board this often, for each one\'s round trip over the week (the Network tab, a board\'s details): a board getting slower shows before it drops off. Each ping is one small message a board answers at its next poll: at 60 min, 24 a day per board. 0: off (Ping all still records them).'],
  reboot_timeout_s: ['Reboot timeout (s)', 'How long an updated device has to come back'],
  border_router_url: ['Border router REST API', 'For the Network page, such as http://192.168.1.20:8081 (the ot-br-posix REST server). Empty: not used.'],
  min_battery_for_update: ['Lowest battery for an update (%)', 'Over the air, a device whose battery is under this is skipped (an update can include it anyway). 0: no check.'],
  water_below_default: ['Needs water below (%)', 'The soil moisture under which a plant needs water, unless its page sets its own. 0: off.'],
  pump_flow_ml_s: ['Pump flow (ml per second)', "How much water a pump moves per second, to know how full the water tanks are, unless a board's page sets its own."],
  check_app_updates: ['Check GitHub for app updates', 'Once a day, asks GitHub whether a newer fleet manager is out.'],
  keep_readings_days: ['Keep readings (days)', 'Readings, link samples and pump runs older than this are deleted, once a day. 0: keep everything.'],
  keep_network_readings: ['Keep network readings', 'How many network readings the history slider keeps'],
  keep_backups: ['Keep backups', 'How many automatic daily backups are kept'],
  backup_copy_dir: ['Copy backups to', 'A folder on this computer (its full path) where each daily backup is also copied: a mounted NAS share or USB disk, such as /mnt/nas/hacoap-backups. Empty: no copies.'],
};
export const SETTINGS_ELSEWHERE = new Set(['home_assistant_url']);  // set in their own cards
export const SETTING_GROUPS = [
  ['Devices and plants', ['online_minutes', 'auto_refresh_minutes', 'water_below_default', 'pump_flow_ml_s', 'min_battery_for_update']],
  ['Network and timing', ['border_router_url', 'ping_every_minutes', 'coap_port', 'smp_port', 'udp_mtu', 'serial_buffer', 'coap_timeout_s',
    'mcumgr_timeout_s', 'discovery_timeout_s', 'reboot_timeout_s']],
  ['Keeping data', ['keep_readings_days', 'keep_network_readings', 'keep_backups', 'backup_copy_dir']],
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

// Where the daily backups are copied to, and how the last copy went
function renderBackupCopy(copy) {
  const box = document.getElementById('backup-copy-state');
  document.getElementById('backup-copy-now').disabled = !copy.folder;
  box.className = `small ${copy.ok === false ? 'text-danger' : 'text-body-secondary'}`;
  box.textContent = !copy.folder ? 'No folder chosen: Settings, Copy backups to.'
    : !copy.time ? `To ${copy.folder}: none copied yet (the next one goes with the next daily backup).`
      : copy.ok ? `Last copied ${when(copy.time)}: ${copy.message}.` : `Last try ${when(copy.time)} failed: ${copy.message}.`;
}

document.getElementById('backup-copy-now').addEventListener('click', (event) => busy(event.target, async () => {
  const copy = await api('POST', '/api/backups/copy');
  renderBackupCopy(copy);
  if (copy.ok) notify('Copied', 'success', 2500);
  await loadBackups();
}));

// Your signing key in the backups, encrypted with a passphrase (keybackup.py)
function renderKeyBackup(key) {
  const box = document.getElementById('signing-key-backup');
  const input = (id, placeholder) => h('input', { class: 'form-control form-control-sm', type: 'password', id,
    placeholder, autocomplete: 'new-password', style: 'max-width: 18rem' });
  const encryptForm = (label) => h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' },
    input('key-pass', 'Passphrase (12 characters or more)'), input('key-pass-again', 'The same again'),
    h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: (e) => busy(e.target, async () => {
      const result = await api('POST', '/api/signing-key/backup', { passphrase: document.getElementById('key-pass').value,
        again: document.getElementById('key-pass-again').value });
      notify('Your key is in the backups, encrypted. Keep the passphrase in your password manager.', 'success', 8000);
      renderKeyBackup(result);
      loadBackups();
    }) }, label));
  const parts = [];
  if (key.saved) {
    parts.push(h('div', { class: key.matches || !key.here ? 'text-success mb-1' : 'text-warning mb-1' },
      key.matches || !key.here ? `✓ In the backups, encrypted: key ${key.saved.fingerprint}, since ${when(key.saved.created)}.`
        : `⚠ The backups hold another key (${key.saved.fingerprint}) than this computer's (${key.here}): add this one again.`),
    h('div', { class: 'd-flex flex-wrap gap-2 mb-2' },
      h('a', { class: 'btn btn-sm btn-outline-secondary', href: '/api/signing-key/backup/file', download: '' }, 'Download the encrypted key'),
      h('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', onclick: (e) => {
        if (!confirm('Remove the encrypted key from the next backups? (Those already made keep it.)')) return;
        busy(e.target, async () => renderKeyBackup(await api('DELETE', '/api/signing-key/backup')));
      } }, 'Remove it from the backups')));
  }
  if (key.can_restore) {
    parts.push(h('div', { class: 'mb-1' }, 'This computer has no private key: put it back from the backups.'),
      h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' }, input('key-restore-pass', 'Its passphrase'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (e) => busy(e.target, async () => {
          const result = await api('POST', '/api/signing-key/restore', { passphrase: document.getElementById('key-restore-pass').value });
          notify('Your key is back: builds are signed with it again.', 'success', 6000);
          renderKeyBackup(result);
        }) }, 'Put the key back')));
  } else if (key.here && !key.matches) {
    parts.push(encryptForm(key.saved ? 'Add this key instead' : 'Add it to the backups, encrypted'));
  } else if (!key.here && !key.saved) {
    parts.push(h('div', { class: 'text-body-secondary' }, 'This computer has no private signing key (application/keys/).'));
  }
  box.replaceChildren(...parts);
}

export async function loadBackups() {
  api('GET', '/api/backups/copy', undefined, { quiet: true }).then(renderBackupCopy, () => {});
  api('GET', '/api/signing-key/backup', undefined, { quiet: true }).then(renderKeyBackup, () => {});
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

const simulated = () => [...state.devices.values()].filter((d) => /^(127\.|::1$|localhost$)/.test(d.address || ''));

export function renderSimulatedCount() {
  const count = simulated().length;
  document.getElementById('simulated-count').textContent = count ? `${count} in the list` : 'none in the list';
  document.getElementById('remove-simulated').disabled = !count;
}

document.getElementById('remove-simulated').addEventListener('click', (event) => {
  const count = simulated().length;
  if (!count || !confirm(`Remove the ${count} simulated board(s), with their readings and history?`)) return;
  busy(event.target, async () => {
    const result = await api('POST', '/api/devices/remove-simulated');
    notify(`Removed ${result.removed.length} simulated board(s)`, 'success', 3000);
    await loadDevices();
    renderSimulatedCount();
  });
});

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

// ------------------------------------------------------------------ other devices

const NETWORK_KINDS = { lan: 'home network', zerotier: 'ZeroTier' };

// "Edge on Windows" from a browser's User-Agent
function browserName(agent) {
  const os = (agent.match(/iPhone|iPad|Android/) || [])[0]
    || (/Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '');
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' on ') || 'a browser';
}

export async function loadRemoteAccess() {
  const form = document.getElementById('remote-form');
  let st;
  try {
    st = await api('GET', '/api/remote-access', undefined, { quiet: true });
  } catch {
    document.getElementById('remote-local-only').classList.remove('d-none');
    form.classList.add('d-none');
    return;
  }
  // Another device (signed in): turning it on or off, the networks and the password only change on the
  // app's computer; links and sign-outs take the password again
  const remote = st.here === 'remote';
  document.getElementById('remote-local-only').classList.toggle('d-none', !remote);
  document.getElementById('remote-confirm').classList.toggle('d-none', !remote);
  form.classList.toggle('d-none', remote);
  document.getElementById('remote-enabled').checked = st.wanted;
  const chosen = new Set(st.networks);
  const available = st.available.map((n) => n.network);
  document.getElementById('remote-networks').replaceChildren(...st.available.map((n) => h('div', { class: 'form-check' },
    h('input', { class: 'form-check-input', type: 'checkbox', id: `remote-net-${n.network}`, value: n.network,
      checked: chosen.has(n.network) }),
    h('label', { class: 'form-check-label', for: `remote-net-${n.network}` },
      h('b', {}, NETWORK_KINDS[n.kind] || n.kind), ` ${n.network}`,
      h('span', { class: 'text-body-secondary' }, ` · ${n.interface}, this computer is ${n.address}`)))));
  if (!st.available.length) {
    document.getElementById('remote-networks').replaceChildren(h('span', { class: 'small text-body-secondary' }, 'No network found on this computer.'));
  }
  document.getElementById('remote-custom').value = st.networks.filter((n) => !available.includes(n)).join(', ');
  const password = document.getElementById('remote-password');
  password.value = '';
  password.placeholder = st.password_set ? 'set (type a new one to change it)' : `at least 8 characters`;
  document.getElementById('remote-state').textContent = st.enabled ? 'On.'
    : st.wanted ? 'Not on yet: it needs a password and a network.' : 'Off: only this computer opens the app.';
  document.getElementById('remote-addresses').replaceChildren(...(st.addresses.length ? [
    'Open it from the other devices at ',
    ...st.addresses.flatMap((url, i) => [i ? ' or ' : '', h('span', { class: 'access-address' }, url)]), '.',
  ] : []));
  renderLinks(st);
  const sessions = document.getElementById('remote-sessions');
  if (!st.sessions.length) {
    sessions.replaceChildren(st.enabled ? h('span', { class: 'text-body-secondary' }, 'No device signed in.') : '');
    return;
  }
  sessions.replaceChildren(h('div', { class: 'd-flex align-items-center gap-2 mb-1' }, h('b', {}, 'Signed in'),
    h('button', { class: 'btn btn-sm btn-outline-danger ms-auto', type: 'button', onclick: (e) => busy(e.target, async () => {
      await api('DELETE', '/api/remote-access/sessions', undefined, confirmed());
      loadRemoteAccess();
    }) }, 'Sign everyone out')),
  h('ul', { class: 'list-unstyled mb-0' }, st.sessions.map((session) => h('li', { class: 'd-flex align-items-center gap-2 py-1' },
    h('div', { class: 'flex-grow-1 text-truncate', title: session.device }, `${browserName(session.device)} · ${session.address}`,
      h('div', { class: 'text-body-secondary' }, `signed in ${when(session.created)}, last used ${when(session.last_used)}`)),
    h('button', { class: 'btn btn-sm btn-outline-secondary text-nowrap', type: 'button', onclick: (e) => busy(e.target, async () => {
      await api('DELETE', `/api/remote-access/sessions/${encodeURIComponent(session.id)}`, undefined, confirmed());
      loadRemoteAccess();
    }) }, 'Sign out')))));
}

// From another device, these changes carry the password typed again (none needed on the app's computer)
function confirmed() {
  const field = document.getElementById('remote-confirm');
  const password = document.getElementById('remote-confirm-password').value;
  return field.classList.contains('d-none') ? {} : { headers: { 'X-HACoap-Password': password } };
}

// Dashboard links: for a page that shows the app in a frame (Home Assistant), the plants only
function renderLinks(st) {
  document.getElementById('remote-links-section').classList.toggle('d-none', !st.enabled);
  const list = document.getElementById('remote-links');
  if (!st.links.length) {
    list.replaceChildren(h('span', { class: 'text-body-secondary' }, 'No dashboard link yet.'));
    return;
  }
  list.replaceChildren(h('ul', { class: 'list-unstyled mb-0' }, st.links.map((link) => h('li', { class: 'd-flex align-items-center gap-2 py-1' },
    h('div', { class: 'flex-grow-1 text-truncate' }, h('b', {}, link.name),
      link.view_only ? h('span', { class: 'tag ms-2' }, 'view only') : null,
      link.kind === 'home_assistant' ? h('span', { class: 'tag ms-2' }, 'HA CoAP: firmware, tanks, care') : null,
      h('div', { class: 'text-body-secondary' }, `made ${when(link.created)}, `,
        link.last_used ? `last used ${when(link.last_used)} from ${link.address}` : 'never used yet')),
    h('button', { class: 'btn btn-sm btn-outline-danger text-nowrap', type: 'button', onclick: (e) => {
      if (!confirm(`Revoke the link "${link.name}"? Whatever shows it stops working at once.`)) return;
      busy(e.target, async () => {
        await api('DELETE', `/api/remote-access/links/${encodeURIComponent(link.id)}`, undefined, confirmed());
        document.getElementById('remote-link-new').replaceChildren();
        loadRemoteAccess();
      });
    } }, 'Revoke')))));
}

document.getElementById('remote-link-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.getElementById('remote-link-name').value.trim();
  if (!name) return notify("Name the link: what it's for, such as Home Assistant", 'warning');
  busy(event.submitter, async () => {
    const viewOnly = document.getElementById('remote-link-view-only').checked;
    const forHa = document.getElementById('remote-link-ha').checked;
    const made = await api('POST', '/api/remote-access/links', { name, view_only: viewOnly && !forHa,
      kind: forHa ? 'home_assistant' : 'dashboard' }, confirmed());
    document.getElementById('remote-link-name').value = '';
    document.getElementById('remote-link-view-only').checked = false;
    document.getElementById('remote-link-ha').checked = false;
    if (forHa) {
      // Not a page to open: the address and the key, for the integration's form
      const key = made.link.key;
      const base = (made.link.addresses[0] || '').split('?')[0];
      document.getElementById('remote-link-new').replaceChildren(h('div', { class: 'alert alert-info py-2 small' },
        h('div', { class: 'mb-1' }, h('b', {}, 'Copy them now: '), "the key isn't shown again. In Home Assistant: ",
          'Settings → Devices & services → Add integration → HA CoAP → Connect the fleet manager.'),
        h('div', {}, 'Address: ', h('code', {}, base || '(turn on other devices first)')),
        h('div', {}, 'Key: ', h('code', { class: 'user-select-all' }, key))));
      loadRemoteAccess();
      return;
    }
    const copy = (text) => h('button', { class: 'btn btn-sm btn-outline-secondary ms-2', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(text); notify('Copied', 'success', 2000); } catch (error) { prompt('Copy the link:', text); }
    } }, 'Copy');
    document.getElementById('remote-link-new').replaceChildren(h('div', { class: 'alert alert-info py-2 small' },
      h('div', { class: 'mb-1' }, h('b', {}, 'Copy it now: '), "it isn't shown again (make another if it's lost). In Home ",
        'Assistant, put it in a Webpage card.'),
      made.link.addresses.length ? made.link.addresses.map((url) => h('div', { class: 'd-flex align-items-center' },
        h('code', { class: 'text-break' }, url), copy(url)))
        : h('div', {}, "The app isn't listening on another network yet: the link works once it is.")));
    loadRemoteAccess();
  });
});

document.getElementById('remote-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const networks = [...document.querySelectorAll('#remote-networks input:checked')].map((input) => input.value)
    .concat(document.getElementById('remote-custom').value.split(',').map((n) => n.trim()).filter(Boolean));
  const password = document.getElementById('remote-password').value;
  await api('PUT', '/api/remote-access', { enabled: document.getElementById('remote-enabled').checked, networks,
    password: password || null })
    .then(() => { notify(password ? 'Saved. The new password signed every other device out.' : 'Saved', 'success', 4000); loadRemoteAccess(); },
      () => {});
});

document.getElementById('sign-out').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  window.location.href = '/login';
});

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
