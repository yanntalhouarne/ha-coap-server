// The CoAP tab: any request to a board's resources (application/src/coap_resources.c): a
// method, the resources that take it (or another path), a payload, and the answer decoded.

import { api, busy, h, state } from './core.js';
import { deviceName } from './devices.js';

const OTHER = '__other__';
const HISTORY_MAX = 30;
const coapView = { resources: [], methods: ['GET', 'POST', 'PUT', 'DELETE'], method: 'GET', history: [], last: null };

export async function loadCoapTab() {
  if (!coapView.resources.length) {
    const catalog = await api('GET', '/api/coap/resources', undefined, { quiet: true });
    coapView.resources = catalog.resources;
    coapView.methods = catalog.methods;
  }
  renderBoards();
  renderMethods();
  renderResources();
  renderHistory();
}

function renderBoards() {
  const select = document.getElementById('coap-device');
  const previous = select.value || [...state.selected][0] || '';
  const devices = [...state.devices.values()].filter((d) => d.address)
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  // Its plant too, unless the board is already named after it
  const plant = (d) => (d.plant && d.plant.toLowerCase() !== deviceName(d).toLowerCase() ? ` · ${d.plant}` : '');
  select.replaceChildren(...(devices.length ? devices.map((d) => h('option', { value: d.device_id },
    `${deviceName(d)}${plant(d)}${d.online ? '' : ' (offline)'}`)) : [h('option', { value: '' }, 'No boards with an address')]));
  if (devices.some((d) => d.device_id === previous)) select.value = previous;
}

function renderMethods() {
  document.getElementById('coap-methods').replaceChildren(...coapView.methods.map((method) => h('button', {
    type: 'button', class: `btn ${method === coapView.method ? 'btn-primary' : 'btn-outline-secondary'}`,
    onclick: () => { coapView.method = method; renderMethods(); renderResources(); },
  }, method)));
}

// The resources that take the method chosen, then another path
function renderResources() {
  const select = document.getElementById('coap-resource');
  const previous = select.value;
  const compatible = coapView.resources.filter((r) => r.methods.includes(coapView.method));
  select.replaceChildren(
    ...compatible.map((r) => h('option', { value: r.path }, r.path)),
    h('option', { value: OTHER }, compatible.length ? 'another path…' : `another path… (none of the board's takes ${coapView.method})`));
  select.value = [...compatible.map((r) => r.path), OTHER].includes(previous) ? previous : (compatible[0] ? compatible[0].path : OTHER);
  renderResourceDetails(true);
}

const resourceFor = (path) => coapView.resources.find((r) => r.path === path);

function renderResourceDetails(changed) {
  const chosen = document.getElementById('coap-resource').value;
  const resource = resourceFor(chosen);
  document.getElementById('coap-path-wrap').classList.toggle('d-none', chosen !== OTHER);
  document.getElementById('coap-about').textContent = resource
    ? `${resource.about}. Takes ${resource.methods.join(' and ')}.`
    : 'Any path. The board doesn\'t answer a path it doesn\'t have, or a method a resource doesn\'t take: the request times out (about 30 s).';
  const query = document.getElementById('coap-query');
  if (changed) query.value = (resource && resource.query) || '';
  const sends = coapView.method !== 'GET' && coapView.method !== 'DELETE';
  document.getElementById('coap-payload-wrap').classList.toggle('d-none', !sends);
  document.getElementById('coap-values').replaceChildren(...((sends && resource && resource.values) || []).map((value) =>
    h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: () => {
      document.getElementById('coap-payload').value = value;
      document.getElementById('coap-payload-format').value = 'text';
    } }, value)));
  if (changed && resource && resource.values && sends) document.getElementById('coap-payload').value = resource.values[0];
}

document.getElementById('coap-resource').addEventListener('change', () => renderResourceDetails(true));

function currentRequest() {
  const chosen = document.getElementById('coap-resource').value;
  const format = document.getElementById('coap-payload-format').value;
  const payload = document.getElementById('coap-payload-wrap').classList.contains('d-none') ? '' : document.getElementById('coap-payload').value;
  return {
    device_id: document.getElementById('coap-device').value,
    method: coapView.method,
    path: chosen === OTHER ? document.getElementById('coap-path').value.trim() : chosen,
    query: document.getElementById('coap-query').value.split('&').map((q) => q.trim()).filter(Boolean),
    payload: format === 'text' ? payload : '',
    payload_hex: format === 'hex' ? payload.trim() : '',
    confirmable: document.getElementById('coap-confirmable').checked,
  };
}

async function send(request, button) {
  if (!request.device_id) return;
  await busy(button, async () => {
    const result = await api('POST', `/api/devices/${encodeURIComponent(request.device_id)}/coap`, request);
    const entry = { time: Date.now() / 1000, request, result };
    coapView.history.unshift(entry);
    coapView.history.length = Math.min(coapView.history.length, HISTORY_MAX);
    coapView.last = entry;
    renderResponse(entry);
    renderHistory();
  });
}

document.getElementById('coap-form').addEventListener('submit', (event) => {
  event.preventDefault();
  send(currentRequest(), document.getElementById('coap-send')).catch(() => {});
});

const shown = (request) => `${request.method} ${request.path}${request.query.length ? `?${request.query.join('&')}` : ''}`
  + `${request.payload ? ` '${request.payload}'` : request.payload_hex ? ` 0x${request.payload_hex}` : ''}`;
const boardName = (id) => deviceName(state.devices.get(id) || { device_id: id });

function renderResponse(entry) {
  const { request, result } = entry;
  const box = document.getElementById('coap-response');
  const head = h('div', { class: 'd-flex flex-wrap align-items-center gap-2 mb-2' },
    result.answered
      ? h('span', { class: `badge text-bg-${result.ok ? 'success' : 'danger'} coap-code` }, `${result.code} ${result.code_name}`.trim())
      : h('span', { class: 'badge text-bg-secondary coap-code' }, 'no answer'),
    h('span', { class: 'small text-body-secondary' }, `${shown(request)} · ${boardName(request.device_id)} · ${result.elapsed_ms} ms`
      + `${result.answered ? ` · ${result.bytes ? `${result.bytes} byte${result.bytes === 1 ? '' : 's'}` : 'no payload'}` : ''}`
      + `${request.confirmable ? '' : ' · non-confirmable'}`));
  if (!result.answered) {
    box.replaceChildren(head, h('div', { class: 'small' }, result.detail));
    return;
  }
  const parts = [head];
  if (result.decoded.length) {
    parts.push(h('table', { class: 'table table-sm mb-2 coap-decoded' }, h('tbody', {},
      result.decoded.map(([name, value]) => h('tr', {}, h('th', {}, name), h('td', { class: 'mono' }, value))))));
  }
  if (result.text) parts.push(h('div', { class: 'small text-body-secondary' }, 'text'), h('pre', { class: 'coap-payload' }, result.text));
  if (result.hex) parts.push(h('div', { class: 'small text-body-secondary' }, 'hex'), h('pre', { class: 'coap-payload coap-hex' }, result.hex));
  if (!result.text && !result.hex) parts.push(h('div', { class: 'small text-body-secondary' }, 'No payload.'));
  // The log: read on from where this answer stopped
  const next = result.decoded.find(([name]) => name === 'next: from=');
  if (request.path === 'log' && next) {
    parts.push(h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: (e) => {
      send({ ...request, query: [`from=${next[1]}`] }, e.currentTarget).catch(() => {});
    } }, `Read on (from=${next[1]})`));
  }
  box.replaceChildren(...parts);
}

function renderHistory() {
  const box = document.getElementById('coap-history');
  if (!coapView.history.length) {
    box.replaceChildren(h('span', { class: 'text-body-secondary small' }, 'The requests sent from this page show here: click one to send it again.'));
    return;
  }
  box.replaceChildren(h('ul', { class: 'list-unstyled mb-0 coap-history' }, coapView.history.map((entry) => {
    const { request, result } = entry;
    return h('li', {}, h('button', { type: 'button', class: 'coap-history-row', title: 'Fill the form with this request',
      onclick: () => refill(entry) },
      h('span', { class: 'text-body-secondary' }, new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span', { class: 'mono' }, shown(request)),
      h('span', { class: 'text-body-secondary' }, boardName(request.device_id)),
      h('span', { class: `ms-auto ${result.answered ? (result.ok ? 'text-success' : 'text-danger') : 'text-body-secondary'}` },
        result.answered ? result.code : 'no answer')));
  })));
}

function refill(entry) {
  const { request } = entry;
  coapView.method = request.method;
  renderMethods();
  renderResources();
  document.getElementById('coap-device').value = request.device_id;
  const known = coapView.resources.some((r) => r.path === request.path && r.methods.includes(request.method));
  document.getElementById('coap-resource').value = known ? request.path : OTHER;
  renderResourceDetails(false);
  document.getElementById('coap-path').value = known ? '' : request.path;
  document.getElementById('coap-query').value = request.query.join('&');
  document.getElementById('coap-payload').value = request.payload || request.payload_hex;
  document.getElementById('coap-payload-format').value = request.payload_hex ? 'hex' : 'text';
  document.getElementById('coap-confirmable').checked = request.confirmable;
  renderResponse(entry);
}

document.getElementById('coap-clear').addEventListener('click', () => {
  coapView.history = [];
  renderHistory();
});
