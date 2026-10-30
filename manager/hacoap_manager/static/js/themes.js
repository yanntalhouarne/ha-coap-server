// Colour themes and keyboard shortcuts.

import { TABS, showTab } from './tabs.js';
import { h, svg } from './core.js';
import { net, redrawNetwork } from './network.js';
import { openPalette } from './palette.js';

// ------------------------------------------------------------------ themes and keys

// The keyboard shortcuts, on ?
export function showShortcuts() {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('keys-modal')).show();
}

export function setTheme(id) {
  const theme = window.hacoapApplyTheme(id === null ? document.documentElement.getAttribute('data-theme-choice') : id);
  try { localStorage.setItem('hacoap-theme', theme.id); } catch (error) { /* not remembered */ }
  document.getElementById('theme-button').textContent = theme.name.toLowerCase();
  document.getElementById('status-theme').textContent = theme.name.toLowerCase();
  for (const item of document.querySelectorAll('#theme-menu .dropdown-item')) {
    item.classList.toggle('active', item.dataset.themeId === theme.id);
  }
  if (net.state && net.state.topology) redrawNetwork();
}

// The computer switched between light and dark, with the System theme chosen
window.addEventListener('hacoap-theme', () => setTheme('auto'));

export function cycleTheme(step) {
  const themes = window.HACOAP_THEMES;
  const current = themes.findIndex((t) => t.id === document.documentElement.getAttribute('data-theme'));
  setTheme(themes[(current + step + themes.length) % themes.length].id);
}

const auto = window.HACOAP_AUTO;
document.getElementById('theme-menu').replaceChildren(h('li', {},
  h('a', { class: 'dropdown-item', href: '#', 'data-theme-id': 'auto', onclick: (e) => { e.preventDefault(); setTheme('auto'); } },
    svg('svg', { class: 'icon swatch-icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-sun-moon' })),
    h('span', {}, `${auto.name}: Tokyo Night or White, like the computer`))),
h('li', {}, h('hr', { class: 'dropdown-divider' })), ...window.HACOAP_THEMES.map((theme) => h('li', {},
  h('a', { class: 'dropdown-item', href: '#', 'data-theme-id': theme.id, onclick: (e) => { e.preventDefault(); setTheme(theme.id); } },
    h('span', { class: 'swatch', 'data-theme': theme.id, style: 'background: linear-gradient(90deg, var(--t-bg) 0 40%, var(--t-magenta) 40% 70%, var(--t-green) 70%); outline: 1px solid var(--t-border-strong)' }),
    h('span', {}, theme.name)))));

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (target.closest('input, textarea, select, [contenteditable]')) return;
  if (event.key >= '1' && event.key <= String(TABS.length)) {
    const name = TABS[Number(event.key) - 1];
    history.replaceState(null, '', `#${name}`);
    showTab(name);
  } else if (event.key === 't' || event.key === 'T') {
    cycleTheme(event.shiftKey ? -1 : 1);
  } else if (event.key === '?') {
    showShortcuts();
  }
});
