// Shared state and helpers: building elements, calling the app, notices, dates and numbers.

export const state = {
  devices: new Map(), selected: new Set(), images: [], jobs: new Map(), status: null,
  release: null, filter: { text: '', tag: null }, pendingImage: null, setup: null, console: null,
  alerts: [], appUpdate: null,
};

// ------------------------------------------------------------------ helpers

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export async function api(method, path, body, options = {}) {
  const init = { method, headers: {} };
  if (method !== 'GET') init.headers['X-HACoap'] = '1';
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
    init.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || response.statusText);
    if (!options.quiet) notify(detail, 'danger');
    throw new Error(detail);
  }
  return data;
}

export function notify(message, kind = 'info', timeout = 6000) {
  const alert = h('div', { class: `alert alert-${kind} alert-dismissible fade show`, role: 'alert' },
    message, h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'alert' }));
  document.getElementById('alerts').append(alert);
  if (timeout) setTimeout(() => alert.remove(), timeout);
}

export async function busy(button, work) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = label.replace(/…$/, '') + '…';
  try { return await work(); } catch (error) { return undefined; } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export function ago(seconds) {
  if (!seconds) return 'never';
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

export const when = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString() : '';
export const pct = (value) => (value === null || value === undefined) ? '–' : `${value} %`;
export const shortHash = (hash) => hash ? hash.slice(0, 8) : '';
export const photoUrl = (device) => `/api/devices/${encodeURIComponent(device.device_id)}/photo?t=${device.photo}`;
