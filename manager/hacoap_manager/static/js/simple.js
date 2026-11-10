// The simple view (js/mode.js): the plants as cards, a plant's page, the alerts, and a few
// settings, with tabs at the bottom; made for a phone first. Everything else is in the advanced
// view, one link away.

import { ago, api, h, onUsb, pct, powerText, state, svg } from './core.js';
import { batteryRing } from './pages.js';
import { linkMargin, waterIn } from './network.js';
import { daysText, notificationsOn, toggleNotifications } from './dashboard.js';
import { lineChart } from './charts.js';
import { devicePath, pingDevice } from './devices.js';
import { showPumping, startPumping, waitForBoard } from './motion.js';
import { setTheme } from './themes.js';

const simple = { route: null, plants: [], plantId: null, fromWall: false, soon: null };

const PUMP_SECONDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];  // the board's run time: one digit
const icon = (name) => svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${name}` }));
const plantHref = (id) => `#plant/${encodeURIComponent(id)}`;
const has = (v) => v !== null && v !== undefined;

// What a plant is called: the name given to it (its plant field), big; the board's own name
// (often ha-coap-<ID>) small under it, when it's another one
// The name given to it, and the board's own one (the wall's list has it as 'board'; a device, as 'name')
const title = (p) => (p.plant || '').trim() || p.name || p.device_id;
const own = (p) => p.board || p.name || p.device_id;
const boardName = (p) => (own(p) !== title(p) ? own(p) : '');

// A simple route was shown: draw it
export async function loadSimple(route, rest, fromWall) {
  simple.route = route;
  renderSimpleAlerts();
  if (route === 'plants') await loadPlants();
  if (route === 'plant') await loadPlant(decodeURIComponent(rest.join('/')), fromWall);
  if (route === 'alerts') await loadSimpleFeed();
  if (route === 'more') renderSimpleMore();
}

// A board's readings changed: the plants or its page again, at most every few seconds
export function refreshSimple(deviceId) {
  const route = location.hash.slice(1);
  const onPlants = route === 'plants' || (route === '' && simple.route === 'plants');
  const onPlant = route === `plant/${encodeURIComponent(deviceId)}`;
  if (!onPlants && !onPlant) return;
  clearTimeout(simple.soon);
  simple.soon = setTimeout(() => {
    if (onPlants) loadPlants().catch(() => {});
    // Not while a button waits for the board, or the watering menu is open: drawing the page again would lose it
    else if (!document.querySelector('#plant-page .waiting, #plant-page .water-menu:not(.d-none)')) {
      loadPlant(deviceId, simple.fromWall).catch(() => {});
    }
  }, 2000);
}

// ------------------------------------------------------------------ the plants

export async function loadPlants() {
  simple.plants = await api('GET', '/api/wall', undefined, { quiet: true });
  renderPlants();
}

function plantNote(p) {
  if (!p.online) return 'offline';
  if (p.needs_water) return 'needs water now';
  if (p.water_forecast && has(p.water_forecast.days)) return `water ${waterIn(p.water_forecast)}`;
  return p.power === 'charging' ? 'charging' : '';
}

function renderPlants() {
  const plants = simple.plants;
  document.getElementById('plants-banner').replaceChildren(...plants.filter((p) => p.needs_water).map((p) =>
    h('a', { class: 'plants-banner', href: plantHref(p.device_id) }, icon('droplet'),
      h('span', {}, h('b', {}, title(p)), ' needs water'), h('span', { 'aria-hidden': 'true' }, '›'))));
  document.getElementById('plant-grid').replaceChildren(...(plants.length ? plants.map((p) =>
    h('a', { class: `plant-card${p.needs_water ? ' thirsty' : ''}${p.online ? '' : ' offline'}`, href: plantHref(p.device_id) },
      batteryRing(p, 'plant-ring'),
      h('div', { class: 'plant-card-name' }, title(p)),
      h('div', { class: 'plant-card-board' }, boardName(p)),
      h('div', { class: 'plant-card-soil' }, has(p.soil_moisture) ? `${p.soil_moisture} %` : '–', h('small', {}, ' soil')),
      h('div', { class: 'plant-card-note' }, plantNote(p))))
    : [h('div', { class: 'simple-empty' }, h('p', {}, 'No plants yet. Find your boards in the advanced view, then give each one a name and a plant.'),
      h('a', { class: 'btn btn-primary', href: '#devices' }, 'Find my boards'))]));
}

// ------------------------------------------------------------------ one plant

export async function loadPlant(id, fromWall) {
  simple.plantId = id;
  simple.fromWall = fromWall;
  const box = document.getElementById('plant-page');
  const details = await api('GET', `/api/devices/${encodeURIComponent(id)}/details?days=7`, undefined, { quiet: true }).catch(() => null);
  if (simple.plantId !== id) return;  // another plant was opened meanwhile
  if (!details) {
    box.replaceChildren(backLink(), h('p', { class: 'text-body-secondary' }, 'There is no such plant.'));
    return;
  }
  renderPlant(details);
}

const backLink = () => (simple.fromWall
  ? h('a', { class: 'plant-back', href: '#wall' }, '← wall display')
  : h('a', { class: 'plant-back', href: '#plants' }, '← Plants'));

// Signal in words: the link margin (the border router's, or worked out from the board's RSSI),
// else its link quality (0 to 3)
function signalWord(link) {
  if (!link) return '–';
  const margin = linkMargin(link);
  const quality = margin !== null ? (margin > 20 ? 3 : margin > 10 ? 2 : margin > 2 ? 1 : 0) : link.link_quality;
  return { 3: 'good', 2: 'fair', 1: 'weak', 0: 'poor' }[quality] || '–';
}

function renderPlant(details) {
  const device = details.device, health = details.health || {};
  const id = device.device_id;
  const name = title(device);
  const target = device.water_target;
  const soil = device.soil_moisture;
  const forecast = health.water_forecast;
  const status = !device.online ? `Offline: last heard ${ago(device.last_seen)}`
    : device.needs_water ? `Needs water now${target ? ` (target ${target} %)` : ''}`
      : target ? (forecast && has(forecast.days) ? `Water ${waterIn(forecast)} (target ${target} %)` : `Waters under ${target} %`)
        : 'No watering target yet (set one in the advanced view)';
  // Water now: how long (1 to 9 s, the board's last run time marked), then a confirmation
  const waterButton = h('button', { class: 'btn btn-primary water', type: 'button', 'aria-haspopup': 'menu',
    'aria-expanded': 'false', onclick: () => toggleWaterMenu() }, icon('droplets'), ' Water now', icon('chevron-down'));
  const waterMenu = h('div', { class: 'water-menu d-none', role: 'menu', 'aria-label': `How long to water ${name}` },
    h('div', { class: 'water-menu-title' }, 'How long?'),
    h('div', { class: 'water-menu-choices' }, PUMP_SECONDS.map((seconds) => h('button', {
      type: 'button', role: 'menuitem', class: `btn ${seconds === device.pump_s ? 'btn-primary' : 'btn-outline-secondary'}`,
      title: seconds === device.pump_s ? 'Its last run time' : null, onclick: () => water(seconds) }, `${seconds} s`))));
  const closeOutside = (event) => { if (!waterMenu.contains(event.target) && !waterButton.contains(event.target)) toggleWaterMenu(false); };
  const closeOnEscape = (event) => { if (event.key === 'Escape') { toggleWaterMenu(false); waterButton.focus(); } };
  function toggleWaterMenu(open = waterMenu.classList.contains('d-none')) {
    waterMenu.classList.toggle('d-none', !open);
    waterButton.setAttribute('aria-expanded', String(open));
    document.removeEventListener('click', closeOutside, true);
    document.removeEventListener('keydown', closeOnEscape);
    if (open) {
      document.addEventListener('click', closeOutside, true);
      document.addEventListener('keydown', closeOnEscape);
      (waterMenu.querySelector('.btn-primary') || waterMenu.querySelector('button')).focus({ preventScroll: true });
      waterMenu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });  // above the bottom bar (scroll-margin)
    }
  }
  function water(seconds) {
    toggleWaterMenu(false);
    if (!confirm(`Water ${name} for ${seconds} second${seconds === 1 ? '' : 's'}?`)) return;
    waitForBoard(waterButton, async () => {
      const result = await api('POST', devicePath(device, '/pump'), { seconds, on: true });
      startPumping(id, result.duration || seconds);
      return result;
    }, id);
  }
  const link = details.links && details.links.length ? details.links[details.links.length - 1] : null;
  const low = !onUsb(device) && has(device.battery) && device.battery <= 20;
  const fact = (label, value, note, cls = '') => h('div', { class: `plant-fact ${cls}` },
    h('span', {}, label), h('b', {}, value), h('span', {}, note));
  const readings = details.readings || [];
  const points = readings.map((r) => ({ t: r.time, v: r.soil_moisture }));
  const span = points.length ? [{ t: points[0].t, v: target }, { t: points[points.length - 1].t, v: target }] : [];
  document.getElementById('plant-page').replaceChildren(
    backLink(),
    h('section', { class: 'plant-hero' },
      batteryRing(device, 'plant-hero-ring'),
      h('h1', {}, name),
      h('div', { class: 'plant-sub' }, [boardName(device), device.location].filter(Boolean).join(' · '),
        boardName(device) || device.location ? ' · ' : '', h('span', { class: device.online ? 'text-success' : 'text-body-secondary' }, device.online ? 'online' : 'offline')),
      h('button', { class: 'btn btn-sm btn-link plant-rename', type: 'button', onclick: () => renamePlant(device) },
        device.plant ? 'Rename' : 'Give it a name')),
    h('section', { class: `soil-card${device.needs_water ? ' thirsty' : ''}`, 'data-board': id },
      h('div', { class: 'd-flex align-items-baseline gap-2' }, h('span', { class: 'soil-big' }, has(soil) ? `${soil} %` : '–'),
        h('span', { class: 'small text-body-secondary' }, 'soil moisture')),
      h('div', { class: 'soil-bar' }, h('i', { style: `width: ${has(soil) ? Math.max(0, Math.min(100, soil)) : 0}%` }),
        target ? h('b', { style: `left: ${target}%`, title: `water under ${target} %` }) : null),
      h('div', { class: 'soil-status' }, status),
      h('div', { class: 'soil-actions' },
        waterButton,
        h('button', { class: 'btn btn-outline-secondary beep', type: 'button', title: 'It beeps, so you can find it',
          onclick: (e) => pingDevice(device, e.currentTarget) }, icon('bell-ring'), ' Beep')),
      waterMenu),
    h('section', { class: 'plant-facts' },
      fact('battery', pct(device.battery), onUsb(device) ? powerText(device) : has(device.battery) ? daysText(health.battery_forecast) : '', low ? 'bad' : ''),
      fact('air', has(device.temperature) ? `${device.temperature} °C` : '–', has(device.air_humidity) ? `${device.air_humidity} % humid` : ''),
      fact('signal', signalWord(link), device.last_seen ? `heard ${ago(device.last_seen)}` : '')),
    h('section', { class: 'plant-chart' }, lineChart('Soil, last 7 days', points, { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)',
      overlays: target ? [{ name: 'target', color: 'var(--t-text-muted)', points: span }] : [], name })),
    h('a', { class: 'plant-advanced', href: `#device/${encodeURIComponent(id)}` }, 'Advanced details: firmware, network, log ›'));
  showPumping();
}

// The plant's name (its plant field), from its page
async function renamePlant(device) {
  const value = prompt('What should this plant be called?', device.plant || '');
  if (value === null) return;
  await api('PATCH', devicePath(device), { plant: value.trim() });
  await loadPlant(device.device_id, simple.fromWall);
}

// ------------------------------------------------------------------ alerts

// The open alerts, and their count on the Alerts tab (also when another tab is shown)
export function renderSimpleAlerts() {
  const alerts = state.alerts || [];
  const badge = document.getElementById('simple-alert-count');
  badge.textContent = alerts.length;
  badge.classList.toggle('d-none', !alerts.length);
  document.getElementById('simple-alerts').replaceChildren(alerts.length
    ? h('ul', { class: 'simple-list' }, alerts.map((a) => h('li', { class: 'warn' }, icon('triangle-alert'),
      a.device_id ? h('a', { href: plantHref(a.device_id) }, a.message) : h('span', {}, a.message),
      h('time', {}, ago(a.raised)))))
    : h('p', { class: 'text-body-secondary' }, 'Nothing needs attention.'));
}

document.addEventListener('hacoap-alerts', renderSimpleAlerts);

const FEED_ICONS = { update: 'upload', alert: 'triangle-alert', parent: 'network', pump: 'droplets', photo: 'camera', build: 'hammer',
  restart: 'power', settings: 'sliders-horizontal', network: 'network' };

async function loadSimpleFeed() {
  const entries = await api('GET', '/api/activity-feed?limit=15', undefined, { quiet: true }).catch(() => []);
  document.getElementById('simple-feed').replaceChildren(entries.length
    ? h('ul', { class: 'simple-list' }, entries.map((e) => h('li', {}, icon(FEED_ICONS[e.kind] || 'activity'),
      e.device_id ? h('a', { href: plantHref(e.device_id) }, e.text) : h('span', {}, e.text),
      h('time', {}, ago(e.time)))))
    : h('p', { class: 'text-body-secondary' }, 'Nothing yet.'));
}

// ------------------------------------------------------------------ settings

function renderSimpleMore() {
  const current = document.documentElement.getAttribute('data-theme-choice');
  const themes = [{ id: 'auto', name: 'System' }, ...window.HACOAP_THEMES];
  const row = (title, note, ...actions) => h('li', {}, h('div', {}, h('div', {}, title), note ? h('div', { class: 'small text-body-secondary' }, note) : null),
    h('div', { class: 'd-flex flex-wrap gap-2 justify-content-end flex-grow-0' }, ...actions));
  const notifications = notificationsOn();
  const signOut = document.getElementById('sign-out');
  document.getElementById('simple-more').replaceChildren(
    h('h2', { class: 'simple-h' }, 'View'),
    h('ul', { class: 'simple-list' },
      row('Simple or advanced', 'Advanced is the whole tool: devices, network, updates, builds, console…',
        h('a', { class: 'btn btn-sm btn-outline-secondary', href: '#dashboard' }, 'Advanced view')),
      row('Wall display', 'Every plant big, for a spare screen', h('a', { class: 'btn btn-sm btn-outline-secondary', href: '#wall' }, 'Open')),
      row('Weekly summary', 'To read or print', h('a', { class: 'btn btn-sm btn-outline-secondary', href: '#summary' }, 'Open'))),
    h('h2', { class: 'simple-h' }, 'Notifications'),
    h('ul', { class: 'simple-list' },
      row('Alerts pop up on this device', notifications ? 'On, in this browser' : 'Off',
        h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: async () => { await toggleNotifications(); renderSimpleMore(); } },
          notifications ? 'Turn off' : 'Turn on'))),
    h('h2', { class: 'simple-h' }, 'Colours'),
    h('div', { class: 'theme-pick' }, themes.map((t) => h('button', {
      class: `btn btn-sm ${t.id === current ? 'btn-primary' : 'btn-outline-secondary'}`, type: 'button', 'aria-pressed': String(t.id === current),
      onclick: () => { setTheme(t.id); renderSimpleMore(); } }, t.name))),
    h('h2', { class: 'simple-h' }, 'Everything else'),
    h('ul', { class: 'simple-list' },
      row('All the settings', 'Watering targets, the border router, backups, Home Assistant…',
        h('a', { class: 'btn btn-sm btn-outline-secondary', href: '#settings' }, 'Open')),
      // Signed in from another network (remote access): the advanced view's sign-out button, here too
      signOut.classList.contains('d-none') ? null : row('Signed in from another network', 'This device stays signed in until you sign it out',
        h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => signOut.click() }, 'Sign out'))));
}
