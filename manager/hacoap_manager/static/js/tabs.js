// The tabs, and which page the address shows.

import { loadAutostart, loadBackups, loadHomeAssistant, loadRemoteAccess, loadSettings, loadStorage, renderSimulatedCount } from './settings.js';
import { loadBuilds, loadImages } from './images.js';
import { loadBuildsTab } from './builds.js';
import { loadCoapTab } from './coap.js';
import { loadBorderRouter } from './borderrouter.js';
import { loadConsole } from './console.js';
import { loadDashboard } from './dashboard.js';
import { loadDevicePage } from './device.js';
import { loadGraph } from './graphs.js';
import { loadHistory, renderUpdateForm } from './updates.js';
import { loadNetwork, net } from './network.js';
import { loadSummary, loadWall, stopWall, wall } from './pages.js';
import { setNetworkView } from './floorplan.js';
import { SIMPLE_ROUTES, homeRoute, setMode } from './mode.js';
import { loadSimple } from './simple.js';

// ------------------------------------------------------------------ tabs

// The first ten have the keys 1 to 9, then 0 (themes.js); the border router has no key
export const TABS = ['dashboard', 'devices', 'network', 'charts', 'updates', 'images', 'builds', 'console', 'coap', 'settings',
  'border-router'];
export const PAGES = ['wall', 'summary'];  // pages without a tab

// Device pages opened from the wall display get a button back to it, until another tab is shown
let previousTab = null;
let fromWall = false;

// A route is a tab name, or "device/<id>" for one device's page; in the simple view (mode.js),
// "plants", "plant/<id>", "alerts" or "more". A route of one view switches to it; "home" (or
// nothing) is the current view's first page.
export function showTab(route) {
  if (route === 'home' || route === '') route = homeRoute();
  const [name, ...rest] = route.split('/');
  if (SIMPLE_ROUTES.includes(name)) setMode('simple');
  else if (name === 'device' || TABS.includes(name)) setMode('advanced');
  const known = name === 'device' || TABS.includes(name) || PAGES.includes(name) || SIMPLE_ROUTES.includes(name);
  const tab = known ? name : homeRoute();
  if (previousTab === 'wall' && tab !== 'wall') wall.wasFullscreen = Boolean(document.fullscreenElement);
  fromWall = ['device', 'plant'].includes(tab) && (fromWall || previousTab === 'wall');
  document.getElementById('device-to-wall').classList.toggle('d-none', !(fromWall && tab === 'device'));
  previousTab = tab;
  for (const link of document.querySelectorAll('#tabs a')) {
    link.classList.toggle('active', link.dataset.tab === (tab === 'device' ? 'devices' : tab));
  }
  for (const link of document.querySelectorAll('#simple-nav a')) {
    link.classList.toggle('active', link.dataset.route === (tab === 'plant' ? 'plants' : tab));
  }
  for (const section of document.querySelectorAll('.tab')) section.classList.toggle('d-none', section.id !== `tab-${tab}`);
  if (SIMPLE_ROUTES.includes(tab)) loadSimple(tab, rest, fromWall).catch(() => {});
  document.body.classList.toggle('wall-mode', tab === 'wall');
  if (tab === 'wall') loadWall().catch(() => {}); else stopWall();
  if (tab === 'summary') loadSummary().catch(() => {});
  if (tab === 'dashboard') loadDashboard().catch(() => {});
  if (tab === 'device') loadDevicePage(decodeURIComponent(rest.join('/'))).catch(() => {});
  if (tab === 'charts') loadGraph().catch(() => {});
  if (tab === 'coap') loadCoapTab().catch(() => {});
  if (tab === 'border-router') loadBorderRouter().catch(() => {});
  if (tab === 'console') loadConsole(rest.length ? decodeURIComponent(rest.join('/')) : null).catch(() => {});
  if (tab === 'updates') { renderUpdateForm(); loadHistory(); }
  if (name === 'images') { loadImages(); loadBuilds(); }
  if (name === 'builds') loadBuildsTab();
  if (tab === 'network') {
    loadNetwork().then(() => setNetworkView(['mesh', 'tree', 'floorplan'].includes(rest[0]) ? rest[0] : net.view || 'mesh'), () => {});
  }
  if (name === 'settings') { loadSettings(); loadBackups(); loadStorage().catch(() => {}); loadAutostart().catch(() => {}); loadHomeAssistant().catch(() => {}); loadRemoteAccess().catch(() => {}); renderSimulatedCount(); }
}

for (const link of document.querySelectorAll('#tabs a')) {
  link.addEventListener('click', (event) => { event.preventDefault(); history.replaceState(null, '', `#${link.dataset.tab}`); showTab(link.dataset.tab); });
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
export const currentRoute = () => location.hash.slice(1) || homeRoute();
