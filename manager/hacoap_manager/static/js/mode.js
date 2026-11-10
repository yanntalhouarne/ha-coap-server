// Simple or advanced: which version of the app this browser shows. Simple (the plants, their
// pages, the alerts and a few settings) is the default; advanced is the whole tool. The choice is
// remembered in this browser, and theme.js marks the page with it before it's drawn.

const KEY = 'hacoap-mode';
// A dashboard link only opens the plants (and the wall display): the simple view, always
const LINK = new URLSearchParams(location.search).has('key');
export const LINK_ROUTES = ['plants', 'plant', 'alerts', 'more', 'wall'];

// The routes of the simple view; every other tab is the advanced one's
export const SIMPLE_ROUTES = ['plants', 'plant', 'alerts', 'more'];

let mode = LINK || document.documentElement.classList.contains('simple-mode') ? 'simple' : 'advanced';
if (LINK) document.documentElement.classList.add('simple-mode');

export const simpleMode = () => mode === 'simple';

export function setMode(next) {
  mode = next === 'advanced' && !LINK ? 'advanced' : 'simple';
  document.documentElement.classList.toggle('simple-mode', mode === 'simple');
  try { localStorage.setItem(KEY, mode); } catch (error) { /* only for this visit */ }
}

// Where an empty address (or "#home") goes
export const homeRoute = () => (simpleMode() ? 'plants' : 'dashboard');
