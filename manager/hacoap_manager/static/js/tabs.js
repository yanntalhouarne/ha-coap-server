// The tabs, and which page the address shows.

import { loadAutostart, loadBackups, loadHomeAssistant, loadSettings, loadStorage, renderSimulatedCount } from './settings.js';
import { loadBuilds, loadImages } from './images.js';
import { loadBuildsTab } from './builds.js';
import { loadConsole } from './console.js';
import { loadDashboard } from './dashboard.js';
import { loadDevicePage } from './device.js';
import { loadHistory, renderUpdateForm } from './updates.js';
import { loadNetwork, net } from './network.js';
import { loadSummary, loadWall, stopWall } from './pages.js';
import { setNetworkView } from './floorplan.js';

// ------------------------------------------------------------------ tabs

export const TABS = ['dashboard', 'devices', 'network', 'updates', 'images', 'builds', 'console', 'settings'];
export const PAGES = ['wall', 'summary'];  // pages without a tab

// A route is a tab name, or "device/<id>" for one device's page.
export function showTab(route) {
  const [name, ...rest] = route.split('/');
  const known = name === 'device' || TABS.includes(name) || PAGES.includes(name);
  const tab = known ? name : 'dashboard';
  for (const link of document.querySelectorAll('#tabs a')) {
    link.classList.toggle('active', link.dataset.tab === (tab === 'device' ? 'devices' : tab));
  }
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('d-none', section.id !== `tab-${tab}`);
  document.body.classList.toggle('wall-mode', tab === 'wall');
  if (tab === 'wall') loadWall().catch(() => {}); else stopWall();
  if (tab === 'summary') loadSummary().catch(() => {});
  if (tab === 'dashboard') loadDashboard().catch(() => {});
  if (tab === 'device') loadDevicePage(decodeURIComponent(rest.join('/'))).catch(() => {});
  if (tab === 'console') loadConsole(rest.length ? decodeURIComponent(rest.join('/')) : null).catch(() => {});
  if (tab === 'updates') { renderUpdateForm(); loadHistory(); }
  if (name === 'images') { loadImages(); loadBuilds(); }
  if (name === 'builds') loadBuildsTab();
  if (tab === 'network') {
    loadNetwork().then(() => setNetworkView(['mesh', 'tree', 'floorplan'].includes(rest[0]) ? rest[0] : net.view || 'mesh'), () => {});
  }
  if (name === 'settings') { loadSettings(); loadBackups(); loadStorage().catch(() => {}); loadAutostart().catch(() => {}); loadHomeAssistant().catch(() => {}); renderSimulatedCount(); }
}

for (const link of document.querySelectorAll('#tabs a')) {
  link.addEventListener('click', (event) => { event.preventDefault(); history.replaceState(null, '', `#${link.dataset.tab}`); showTab(link.dataset.tab); });
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'dashboard'));
export const currentRoute = () => location.hash.slice(1) || 'dashboard';
