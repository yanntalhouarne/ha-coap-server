// The wall display and the weekly summary.

import { api, h, notify, pct, photoUrl, shortHash, svg, when } from './core.js';
import { fullLasts, imageLabel, perDay } from './dashboard.js';
import { waterIn } from './network.js';

// ------------------------------------------------------------------ wall display

// Full screen for a spare monitor: every plant big, the ones that need water first, a page
// at a time when they don't all fit, turning every 15 seconds.
export const wall = { plants: [], page: 0, timers: [], soon: null };
export const WALL_PAGE = 6;

export async function loadWall() {
  wall.plants = await api('GET', '/api/wall', undefined, { quiet: true });
  if (!wall.timers.length) {
    wall.timers.push(setInterval(() => { wall.page += 1; renderWall(); }, 15000));
    wall.timers.push(setInterval(() => loadWall().catch(() => {}), 60000));
    wall.timers.push(setInterval(renderWallClock, 1000));
  }
  renderWallClock();
  renderWall();
}

export function loadWallSoon() {  // after device events, at most every few seconds
  clearTimeout(wall.soon);
  wall.soon = setTimeout(() => loadWall().catch(() => {}), 3000);
}

export function stopWall() {
  wall.timers.forEach(clearInterval);
  wall.timers = [];
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function renderWallClock() {
  const now = new Date();
  document.getElementById('wall-clock').textContent =
    `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function renderWall() {
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

// ------------------------------------------------------------------ weekly summary

export const summaryView = { weeksBack: 0 };
export const dateShort = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

export async function loadSummary() {
  const days = Number(document.getElementById('summary-days').value);
  const end = Date.now() / 1000 - summaryView.weeksBack * 7 * 86400;
  renderSummary(await api('GET', `/api/summary?days=${days}&end=${end}`));
}

export function renderSummary(r) {
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
