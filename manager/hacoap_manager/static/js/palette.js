// The search box (Ctrl+K).

import { TABS } from './tabs.js';
import { checkAppUpdate, notificationsOn, toggleNotifications } from './dashboard.js';
import { cycleTheme, setTheme, showShortcuts } from './themes.js';
import { deviceName, runDoctor } from './devices.js';
import { h, state } from './core.js';

// ------------------------------------------------------------------ search (Ctrl+K)

export const palette = { items: [], shown: [], index: 0 };

// Shows a tab, then clicks one of its buttons.
export function runOnTab(tab, buttonId) {
  return () => {
    location.hash = `#${tab}`;
    setTimeout(() => document.getElementById(buttonId).click(), 100);
  };
}

export const download = (url) => () => { window.location.href = url; };

export function paletteItems() {
  const items = TABS.map((tab, i) => ({ kind: 'tab', label: tab, hint: `key ${i + 1}`, run: () => { location.hash = `#${tab}`; } }));
  for (const device of [...state.devices.values()].sort((a, b) => deviceName(a).localeCompare(deviceName(b)))) {
    items.push({ kind: 'device', label: deviceName(device), hint: [device.plant, device.location, device.device_id].filter(Boolean).join(' · '),
      run: () => { location.hash = `#device/${encodeURIComponent(device.device_id)}`; } });
  }
  const action = (label, hint, run) => items.push({ kind: 'action', label, hint, run });
  action('Find devices', 'devices', runOnTab('devices', 'discover'));
  action('Refresh all devices', 'devices', runOnTab('devices', 'refresh-all'));
  action('Read all firmware', 'which image each device runs', runOnTab('devices', 'read-all-slots'));
  action('Check my connection', 'each step from this computer to the boards', () => runDoctor());
  action('Print labels', 'for the pots or the boards', runOnTab('devices', 'labels-open'));
  action('Wall display', 'full screen, for a spare monitor', () => { location.hash = '#wall'; });
  action('Weekly summary', 'what happened this week, to print', () => { location.hash = '#summary'; });
  if (!(state.status && state.status.demo)) action('Start the demo', 'simulated boards, in a new tab', runOnTab('settings', 'demo-start'));
  action('Read the network', 'network', runOnTab('network', 'network-refresh'));
  action('Scan the channels', 'radio noise per channel', runOnTab('network', 'channel-scan'));
  action('Download a backup', 'settings', download('/api/backup'));
  action('Download a problem report', 'settings', download('/api/report'));
  action('Export readings (CSV)', 'every device', download('/api/readings.csv'));
  action('Export devices (CSV)', 'the device list', download('/api/devices.csv'));
  action('Next colour theme', 'T', () => cycleTheme(1));
  action('Keyboard shortcuts', '?', () => showShortcuts());
  action('Follow the computer\'s light or dark theme', 'System theme', () => setTheme('auto'));
  action(notificationsOn() ? 'Turn off notifications' : 'Turn on notifications', 'alerts in the browser', toggleNotifications);
  action('Check for an app update', 'GitHub', () => { location.hash = '#settings'; checkAppUpdate(true).catch(() => {}); });
  return items;
}

export function filterPalette() {
  const words = document.getElementById('palette-input').value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = palette.items.filter((item) => {
    const text = `${item.label} ${item.hint} ${item.kind}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  // Labels that start with what was typed come first
  const first = words[0] || '';
  palette.shown = [...matches.filter((i) => i.label.toLowerCase().startsWith(first)),
    ...matches.filter((i) => !i.label.toLowerCase().startsWith(first))].slice(0, 14);
  palette.index = 0;
  renderPalette();
}

export function renderPalette() {
  const list = document.getElementById('palette-list');
  list.replaceChildren(...(palette.shown.length ? palette.shown.map((item, i) => h('li', {
    class: i === palette.index ? 'active' : null, role: 'option', 'aria-selected': i === palette.index ? 'true' : 'false',
    onmousedown: (e) => { e.preventDefault(); runPaletteItem(item); },
    onmousemove: () => { if (palette.index !== i) { palette.index = i; renderPalette(); } },
  }, h('span', { class: 'kind' }, item.kind), h('span', {}, item.label), h('span', { class: 'hint' }, item.hint)))
    : [h('li', { class: 'empty' }, 'Nothing matches')]));
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  palette.items = paletteItems();
  const input = document.getElementById('palette-input');
  input.value = '';
  document.getElementById('palette').classList.remove('d-none');
  filterPalette();
  input.focus();
}

export function closePalette() {
  document.getElementById('palette').classList.add('d-none');
}

export function runPaletteItem(item) {
  closePalette();
  if (item) item.run();
}

document.getElementById('palette-input').addEventListener('input', filterPalette);
document.getElementById('palette-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const count = palette.shown.length;
    if (count) palette.index = (palette.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPaletteItem(palette.shown[palette.index]);
  } else if (event.key === 'Escape') {
    closePalette();
  }
});
document.getElementById('palette').addEventListener('mousedown', (event) => {
  if (event.target.id === 'palette') closePalette();  // a click beside the box
});
document.getElementById('palette-button').addEventListener('click', openPalette);
