// The simple view (js/mode.js): the plants as cards, a plant's page, the alerts, and a few
// settings, with tabs at the bottom; made for a phone first. Everything else is in the advanced
// view, one link away.

import { ago, api, h, linkMode, linkView, onUsb, pct, powerText, state, svg } from './core.js';
import { batteryRing } from './pages.js';
import { linkMargin, waterIn } from './network.js';
import { daysText, dismissAlert, dismissAllAlerts, notificationsOn, toggleNotifications } from './dashboard.js';
import { lineChart } from './charts.js';
import { devicePath, pingDevice } from './devices.js';
import { showPumping, startPumping, waitForBoard } from './motion.js';
import { setTheme } from './themes.js';
import { refillTank, tankBar, tankText } from './watering.js';

const simple = { route: null, plants: [], plantId: null, fromWall: false, soon: null, openWater: false };

// How the plants show: as cards, or as the Today list (what to do, then a row per plant). A
// dashboard link's address can choose (&layout=today), else this browser's choice.
const LAYOUT_KEY = 'hacoap.plants-layout';
export function plantsLayout() {
  const asked = new URLSearchParams(location.search).get('layout');
  if (asked === 'today' || asked === 'cards') return asked;
  try { return localStorage.getItem(LAYOUT_KEY) === 'today' ? 'today' : 'cards'; } catch (error) { return 'cards'; }
}
function setPlantsLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch (error) { /* private window: for this visit only */ }
}

const PUMP_SECONDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// Opened with a dashboard link: the rest of the app opens outside the dashboard (a new tab, or the
// browser from a phone app), at its address without the key, where signing in works and sticks
const fullApp = (route) => ({ href: `${location.origin}/${route}`, target: '_blank', rel: 'noopener' });  // the board's run time: one digit
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
  if (plantsLayout() === 'today' && plants.length) {
    renderToday(plants);
    return;
  }
  document.getElementById('plant-grid').classList.remove('today');
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

// ------------------------------------------------------------------ the Today list

// What to do now, the most urgent first: [{icon, text, note, kind, action}]
export function todayTasks(plants, now = Date.now() / 1000) {
  const tasks = [];
  const name = (p) => title(p);
  for (const p of plants) {
    if (p.needs_water && p.online) {
      tasks.push({ rank: 0, kind: 'water', icon: 'droplets', plant: p, text: `Water ${name(p)}`,
        note: `soil ${p.soil_moisture} %, under ${p.water_target} %${p.waters_itself ? ': it waters itself soon' : ''}` });
    }
    if (p.watering_missed) {
      tasks.push({ rank: 1, kind: 'refill', icon: 'droplet', plant: p, text: `Check ${name(p)}'s water`,
        note: "its soil didn't rise after its last waterings: is its tank empty, or the tube out of the pot?" });
    } else if (p.tank && p.tank.low) {
      tasks.push({ rank: 1, kind: 'refill', icon: 'droplet', plant: p, text: `Refill ${name(p)}'s tank`,
        note: `about ${p.tank.percent} % full, ${p.tank.left_ml} ml left` });
    }
    if (!onUsb(p) && has(p.battery) && p.battery <= 20) {
      tasks.push({ rank: 2, kind: 'charge', icon: 'battery-low', plant: p, text: `Charge ${name(p)}`, note: `battery at ${p.battery} %` });
    }
    if (!p.online) {
      tasks.push({ rank: 3, kind: 'offline', icon: 'triangle-alert', plant: p, text: `Check ${name(p)}`,
        note: p.last_seen ? `not answering since ${ago(p.last_seen)}` : 'never answered' });
    }
    if (!p.needs_water && p.online && p.water_forecast && has(p.water_forecast.days) && p.water_forecast.days <= 1) {
      tasks.push({ rank: 4, kind: 'soon', icon: 'clock', plant: p, text: `${name(p)} needs water ${waterIn(p.water_forecast)}`,
        note: `soil ${p.soil_moisture} %` });
    }
  }
  return tasks.sort((a, b) => a.rank - b.rank);
}

function renderToday(plants) {
  document.getElementById('plants-banner').replaceChildren();
  const tasks = todayTasks(plants);
  const view = linkView();
  const action = (task) => {
    const p = task.plant;
    if (task.kind === 'water' && !view) {
      return h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => {
        simple.openWater = true;  // its page, with How long? open
        location.hash = plantHref(p.device_id);
      } }, 'Water');
    }
    if (task.kind === 'refill' && p.tank && !view) {
      return h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: async (e) => {
        await refillTank(p, e.currentTarget);
        await loadPlants();
      } }, 'Refilled');
    }
    return null;
  };
  const grid = document.getElementById('plant-grid');
  grid.classList.add('today');
  grid.replaceChildren(
    h('h2', { class: 'simple-h' }, 'Today'),
    tasks.length
      ? h('ul', { class: 'simple-list today-list' }, tasks.map((task) => h('li', { class: `today-${task.kind}` }, icon(task.icon),
        h('a', { href: plantHref(task.plant.device_id) }, h('div', {}, task.text), h('div', { class: 'small text-body-secondary' }, task.note)),
        action(task))))
      : h('p', { class: 'today-done' }, icon('check'), ' Nothing to do today: every plant is fine.'),
    h('h2', { class: 'simple-h' }, 'All plants'),
    h('ul', { class: 'plant-rows' }, plants.map((p) => h('li', {},
      h('a', { class: `plant-row${p.needs_water ? ' thirsty' : ''}${p.online ? '' : ' offline'}`, href: plantHref(p.device_id) },
        h('div', { class: 'plant-row-name' }, h('b', {}, title(p)), h('span', {}, boardName(p) || plantNote(p))),
        h('div', { class: 'plant-row-soil' }, h('span', {}, has(p.soil_moisture) ? `${p.soil_moisture} %` : '–'),
          h('div', { class: 'soil-bar' }, h('i', { style: `width: ${has(p.soil_moisture) ? Math.max(0, Math.min(100, p.soil_moisture)) : 0}%` }),
            p.water_target ? h('b', { style: `left: ${p.water_target}%` }) : null)),
        h('span', { class: 'plant-row-battery', title: 'battery' }, has(p.battery)
          ? [icon(p.power === 'charging' ? 'battery-charging' : p.battery <= 20 ? 'battery-low' : 'battery-medium'), ` ${p.battery} %`] : ''))))));
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
  const selfWatering = device.watering_rule && device.watering_rule.on && target
    ? ` · it waters itself (up to ${device.watering_rule.max_per_day} times a day)` : '';
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
      h('div', { class: 'soil-status' }, status + selfWatering),
      h('div', { class: 'soil-actions' },
        waterButton,
        h('button', { class: 'btn btn-outline-secondary beep', type: 'button', title: 'It beeps, so you can find it',
          onclick: (e) => pingDevice(device, e.currentTarget) }, icon('bell-ring'), ' Beep')),
      waterMenu),
    device.tank ? h('section', { class: `tank-row${device.tank.low ? ' low' : ''}` },
      h('div', { class: 'tank-row-text' }, h('span', {}, 'water tank'), h('b', {}, tankText(device.tank)), tankBar(device.tank)),
      h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: async (e) => {
        await refillTank(device, e.currentTarget);
        await loadPlant(id, simple.fromWall);
      } }, 'Refilled')) : null,
    device.watering_missed ? h('p', { class: 'tank-missed' }, icon('triangle-alert'),
      " Its soil didn't rise after its last waterings: is its tank empty, or the tube out of the pot?") : null,
    h('section', { class: 'plant-facts' },
      fact('battery', pct(device.battery), onUsb(device) ? powerText(device) : has(device.battery) ? daysText(health.battery_forecast) : '', low ? 'bad' : ''),
      fact('air', has(device.temperature) ? `${device.temperature} °C` : '–', has(device.air_humidity) ? `${device.air_humidity} % humid` : ''),
      fact('signal', signalWord(link), device.last_seen ? `heard ${ago(device.last_seen)}` : '')),
    h('section', { class: 'plant-chart' }, lineChart('Soil, last 7 days', points, { unit: ' %', min: 0, max: 100, color: 'var(--t-cyan)',
      overlays: target ? [{ name: 'target', color: 'var(--t-text-muted)', points: span }] : [], name })),
    h('a', { class: 'plant-advanced', ...(linkMode() ? fullApp(`#device/${encodeURIComponent(id)}`) : { href: `#device/${encodeURIComponent(id)}` }) },
      'Advanced details: firmware, network, log ›'));
  showPumping();
  if (simple.openWater) {
    simple.openWater = false;
    toggleWaterMenu(true);
  }
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
  document.getElementById('simple-alerts').replaceChildren(...(alerts.length ? [
    h('ul', { class: 'simple-list' }, alerts.map((a) => h('li', { class: 'warn' }, icon('triangle-alert'),
      a.device_id ? h('a', { href: plantHref(a.device_id) }, a.message) : h('span', {}, a.message),
      h('time', {}, ago(a.raised)),
      h('button', { type: 'button', class: 'alert-dismiss', title: 'Dismiss', 'aria-label': `Dismiss: ${a.message}`,
        onclick: () => dismissAlert(a) }, icon('x'))))),
    alerts.length > 1 ? h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary mt-2', onclick: dismissAllAlerts },
      `Dismiss all ${alerts.length}`) : null,
  ] : [h('p', { class: 'text-body-secondary' }, 'Nothing needs attention.')]).filter(Boolean));
}

document.addEventListener('hacoap-alerts', renderSimpleAlerts);

const FEED_ICONS = { update: 'upload', alert: 'triangle-alert', parent: 'network', pump: 'droplets', tank: 'droplet', photo: 'camera', build: 'hammer',
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
  const layout = plantsLayout();
  const layoutRow = row('Plants as', layout === 'today' ? 'Today: what to do, then a row per plant' : 'Cards: a card per plant',
    ...[['cards', 'Cards'], ['today', 'Today list']].map(([id, label]) => h('button', {
      class: `btn btn-sm ${id === layout ? 'btn-primary' : 'btn-outline-secondary'}`, type: 'button', 'aria-pressed': String(id === layout),
      onclick: () => { setPlantsLayout(id); renderSimpleMore(); } }, label)));
  if (linkMode()) {
    // A dashboard link: the plants only, so nothing that leads elsewhere
    document.getElementById('simple-more').replaceChildren(
      h('h2', { class: 'simple-h' }, 'View'),
      h('ul', { class: 'simple-list' }, layoutRow,
        row('The full app', 'Devices, network, updates, settings… In a new tab: sign in there once, it’s remembered',
          h('a', { class: 'btn btn-sm btn-outline-secondary', ...fullApp('#dashboard') }, 'Open')),
        row('Wall display', 'Every plant big, for a spare screen', h('a', { class: 'btn btn-sm btn-outline-secondary', href: '#wall' }, 'Open'))),
      h('h2', { class: 'simple-h' }, 'Colours'),
      h('div', { class: 'theme-pick' }, themes.map((t) => h('button', {
        class: `btn btn-sm ${t.id === current ? 'btn-primary' : 'btn-outline-secondary'}`, type: 'button', 'aria-pressed': String(t.id === current),
        onclick: () => { setTheme(t.id); renderSimpleMore(); } }, t.name))),
      h('p', { class: 'small text-body-secondary mt-3' }, 'Opened with a dashboard link: the plants only. The rest of the app opens on its ',
        'computer, or after signing in on a network it allows.'));
    return;
  }
  document.getElementById('simple-more').replaceChildren(
    h('h2', { class: 'simple-h' }, 'View'),
    h('ul', { class: 'simple-list' }, layoutRow,
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
