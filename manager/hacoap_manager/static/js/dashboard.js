// The dashboard: tiles, lists, battery drain, alerts and notifications, app updates, getting started.

import { ago, api, busy, h, notify, pct, photoUrl, shortHash, state, svg, when } from './core.js';
import { deviceName, runDoctor } from './devices.js';
import { devicePage, loadDevicePage } from './device.js';
import { loadStatus } from './live.js';
import { prepareUpdate, statusClass } from './updates.js';
import { runOnTab } from './palette.js';
import { waterIn } from './network.js';

// ------------------------------------------------------------------ dashboard

export const daysText = (forecast) => {
  if (!forecast) return 'no trend yet';
  const days = forecast.days_left;
  return days >= 60 ? `≈ ${Math.round(days / 30)} months left` : `≈ ${Math.round(days)} days left`;
};

export function linkText(link) {
  if (link.link_margin !== null && link.link_margin !== undefined) {
    return `${link.link_margin} dB margin${link.average_rssi !== null && link.average_rssi !== undefined ? `, ${link.average_rssi} dBm` : ''}`;
  }
  return link.link_quality !== null && link.link_quality !== undefined ? `link quality ${link.link_quality} of 3` : 'no signal information';
}

export const deviceLink = (entry) => h('a', { href: `#device/${encodeURIComponent(entry.device_id)}` }, entry.name || entry.device_id);

// A number with its label, an icon, and (with 'series') a small chart of the last 7 days.
export function tile(label, value, kind, hint, icon, series) {
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

export async function loadDashboard() {
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

// ------------------------------------------------------------------ battery drain per firmware

export const perDay = (rate) => `${rate.per_day.toFixed(rate.per_day < 1 ? 2 : 1)} %/day`;
export const fullLasts = (days) => !days ? 'no measurable drain' : days >= 60 ? `≈ ${Math.round(days / 30)} months from full` : `≈ ${Math.round(days)} days from full`;

export function imageLabel(hash, version) {
  return hash ? `v${version || '?'} · ${shortHash(hash)}` : 'the image before its first update here';
}

export function renderDeviceDrain(periods) {
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

export async function loadDrain() {
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

// ------------------------------------------------------------------ alerts and notifications

export async function loadAlerts() {
  state.alerts = (await api('GET', '/api/alerts', undefined, { quiet: true })).open;
  renderAlerts();
}

export function renderAlerts() {
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
export const pendingAlerts = [];

export function onAlert(alert) {
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

export function notificationsOn() {
  try {
    return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem('hacoap-notify') === '1';
  } catch (error) {
    return false;
  }
}

export async function toggleNotifications() {
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

export function renderNotificationState() {
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

export async function checkAppUpdate(force = false) {
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

// ------------------------------------------------------------------ getting started

// A checklist on the dashboard until it's done (or hidden): each step ticks itself off.
export async function renderGuide(d) {
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
