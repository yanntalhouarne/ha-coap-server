// Simple or advanced: which version of the app this browser shows. Simple (the plants, their
// pages, the alerts and a few settings) is the default; advanced is the whole tool. The choice is
// remembered in this browser, and theme.js marks the page with it before it's drawn.

const KEY = 'hacoap-mode';

// The routes of the simple view; every other tab is the advanced one's
export const SIMPLE_ROUTES = ['plants', 'plant', 'alerts', 'more'];

let mode = document.documentElement.classList.contains('simple-mode') ? 'simple' : 'advanced';

export const simpleMode = () => mode === 'simple';

export function setMode(next) {
  mode = next === 'advanced' ? 'advanced' : 'simple';
  document.documentElement.classList.toggle('simple-mode', mode === 'simple');
  try { localStorage.setItem(KEY, mode); } catch (error) { /* only for this visit */ }
}

// Where an empty address (or "#home") goes
export const homeRoute = () => (simpleMode() ? 'plants' : 'dashboard');
