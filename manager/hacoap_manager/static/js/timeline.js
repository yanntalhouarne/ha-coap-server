// A board's timeline, on its page: everything that happened to it, newest first, in one list
// grouped by day, with a filter by kind.

import { api, h, shortHash, svg } from './core.js';
import { statusClass } from './updates.js';

const KINDS = [
  ['all', 'everything'], ['update', 'updates'], ['restart', 'restarts'], ['pump', 'pump runs'], ['settings', 'settings'],
  ['network', 'network'], ['photo', 'photos'], ['alert', 'alerts'],
];
const ICONS = { update: 'upload', restart: 'power', pump: 'droplets', settings: 'sliders-horizontal', parent: 'network',
  network: 'network', photo: 'camera', alert: 'triangle-alert' };

const view = { id: null, entries: [], filter: 'all' };

export async function loadDeviceTimeline(deviceId) {
  if (view.id !== deviceId) view.filter = 'all';
  view.id = deviceId;
  view.entries = await api('GET', `/api/devices/${encodeURIComponent(deviceId)}/timeline`, undefined, { quiet: true }).catch(() => []);
  renderTimeline();
}

// 'network' covers its parent changes and its network forgotten
const kindOf = (entry) => (entry.kind === 'parent' ? 'network' : entry.kind);

function entryDetail(entry) {
  const d = entry.detail;
  if (entry.kind === 'update' && d) {
    return h('div', { class: 'tl-detail' },
      h('span', { class: `badge text-bg-${statusClass[d.result] || 'secondary'} me-2` }, d.result),
      `v${d.version} · ${shortHash(d.hash)} · ${d.transport === 'serial' ? 'USB' : 'over the air'}`,
      d.message ? h('div', { class: 'text-body-secondary' }, d.message) : null);
  }
  if (entry.kind === 'alert' && d) {
    return h('div', { class: 'tl-detail text-body-secondary' }, d.cleared ? 'cleared' : 'still open');
  }
  return null;
}

function renderTimeline() {
  const counts = new Map();
  for (const entry of view.entries) counts.set(kindOf(entry), (counts.get(kindOf(entry)) || 0) + 1);
  const chips = KINDS.filter(([kind]) => kind === 'all' || counts.has(kind)).map(([kind, label]) =>
    h('button', { type: 'button', class: `btn btn-sm ${view.filter === kind ? 'btn-primary' : 'btn-outline-secondary'}`,
      onclick: () => { view.filter = kind; renderTimeline(); } },
    label, kind === 'all' ? null : h('span', { class: 'tl-count' }, counts.get(kind))));
  const shown = view.entries.filter((e) => view.filter === 'all' || kindOf(e) === view.filter);

  // Grouped by day, newest first
  const days = [];
  for (const entry of shown) {
    const day = new Date(entry.time * 1000).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, entries: [] });
    days[days.length - 1].entries.push(entry);
  }
  const bad = (e) => (e.kind === 'restart' && /watchdog|lockup|crash/.test(e.text)) || (e.kind === 'update' && e.detail && e.detail.result === 'failed');
  document.getElementById('device-timeline').replaceChildren(
    h('div', { class: 'd-flex flex-wrap gap-1 mb-3' }, chips),
    shown.length ? h('div', { class: 'timeline' }, days.map((d) => h('section', {},
      h('h6', { class: 'tl-day' }, d.day),
      h('ul', { class: 'list-unstyled mb-0' }, d.entries.map((e) => h('li', { class: `tl-entry tl-${kindOf(e)}${bad(e) ? ' bad' : ''}` },
        h('span', { class: 'tl-icon' }, svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${ICONS[e.kind] || 'circle'}` }))),
        h('time', { class: 'tl-time' }, new Date(e.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        h('div', { class: 'tl-text' }, e.text, entryDetail(e))))))))
      : h('p', { class: 'text-body-secondary mb-0' }, view.entries.length ? 'Nothing of this kind.'
        : 'Nothing yet: its updates, restarts, pump runs from the app, settings changes, network changes, photos and alerts show here.'));
}
