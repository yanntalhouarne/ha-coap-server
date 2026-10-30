// The Updates tab: starting updates, their progress and history, and who signed an image.

import { api, busy, h, notify, shortHash, state, svg, when } from './core.js';
import { deviceName, loadDevices } from './devices.js';

// ------------------------------------------------------------------ updates

export async function renderUpdateForm() {
  state.images = await api('GET', '/api/images');
  const select = document.getElementById('update-image');
  const previous = select.value;
  select.replaceChildren(...(state.images.length ? state.images.map((image) =>
    h('option', { value: image.hash }, `${image.release ? '★ ' : ''}v${image.version} · ${shortHash(image.hash)} · ${image.notes || image.filename}`))
    : [h('option', { value: '' }, 'No images in the library')]));
  if (state.pendingImage) { select.value = state.pendingImage; state.pendingImage = null; } else if (previous) select.value = previous;
  const names = [...state.selected].map((id) => deviceName(state.devices.get(id) || { device_id: id }));
  document.getElementById('update-selection').textContent = names.length ? names.join(', ') : 'no devices selected';
  renderUpdateChecks();
  if (!document.getElementById('serial-port').options.length) loadPorts();
}

export async function loadPorts() {
  const ports = await api('GET', '/api/serial-ports');
  const select = document.getElementById('serial-port');
  select.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.port },
    `${p.port} – ${p.description}${p.board ? ' (board)' : ''}`)) : [h('option', { value: '' }, 'No serial ports')]));
}

document.getElementById('refresh-ports').addEventListener('click', loadPorts);

document.getElementById('update-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const transport = document.querySelector('input[name="update-transport"]:checked').value;
  let targets;
  if (transport === 'serial') {
    const port = document.getElementById('serial-port').value;
    if (!port) return notify('Choose a serial port', 'warning');
    targets = [{ transport: 'serial', serial_port: port }];
  } else {
    if (!state.selected.size) return notify('Select devices on the Devices tab first', 'warning');
    targets = [...state.selected].map((id) => ({ device_id: id, transport: 'udp' }));
  }
  const imageHash = document.getElementById('update-image').value;
  if (!imageHash) return notify('Add an image on the Images tab first', 'warning');
  const image = state.images.find((i) => i.hash === imageHash);
  const refused = !!image && REFUSED_SIGNERS.includes(image.signer);
  if (refused && !confirm(`${image.detail}.\n\nSend it anyway? Only for the simulator, or a board with a development bootloader.`)) return;
  busy(event.submitter, async () => {
    const job = await api('POST', '/api/updates', {
      image_hash: imageHash, targets, stop_on_failure: document.getElementById('stop-on-failure').checked,
      staged: document.getElementById('staged').checked, allow_unverified: refused,
      ignore_battery: document.getElementById('ignore-battery').checked,
    });
    state.jobs.set(job.id, job);
    renderJobs();
  });
});

export const statusClass = {
  queued: 'secondary', running: 'primary', updated: 'success', 'already-current': 'success',
  failed: 'danger', skipped: 'warning', cancelled: 'warning', done: 'success', paused: 'warning',
};

// Opens the Updates tab with an image and devices chosen.
export function prepareUpdate(imageHash, deviceIds, staged) {
  state.selected = new Set(deviceIds);
  state.pendingImage = imageHash;
  document.getElementById('transport-udp').checked = true;
  document.getElementById('staged').checked = !!staged;
  location.hash = '#updates';
}

document.getElementById('whats-new').addEventListener('click', async () => {
  const imageHash = document.getElementById('update-image').value;
  const image = state.images.find((i) => i.hash === imageHash);
  const devices = [...state.selected].map((id) => state.devices.get(id)).filter(Boolean);
  const body = document.getElementById('slots-body');
  document.getElementById('slots-title').textContent = "What's new";
  bootstrap.Modal.getOrCreateInstance(document.getElementById('slots-modal')).show();
  if (!image || !devices.length) {
    body.replaceChildren(h('p', {}, 'Choose an image, and devices on the Devices tab.'));
    return;
  }
  if (!image.git_commit) {
    body.replaceChildren(h('p', {}, 'This image has no git commit recorded (it was added as a file), so the changes are unknown.'));
    return;
  }
  const byCommit = new Map();
  for (const device of devices) {
    const key = device.fw_version || '?';
    if (!byCommit.has(key)) byCommit.set(key, []);
    byCommit.get(key).push(device);
  }
  body.replaceChildren(h('p', {}, 'Loading…'));
  const sections = [];
  for (const [commit, group] of byCommit) {
    const title = `${group.map(deviceName).join(', ')}: ${commit} → ${image.git_commit}`;
    try {
      const result = await api('GET', `/api/images/${image.hash}/changes?device_id=${encodeURIComponent(group[0].device_id)}`, undefined, { quiet: true });
      const list = (entries, sign) => entries.map((c) => h('li', {}, h('span', { class: 'mono text-body-secondary' }, `${sign} ${c.commit} `),
        h('span', { class: 'small text-body-secondary' }, `${c.date} `), c.subject));
      sections.push(h('h6', {}, title), result.added.length || result.removed.length
        ? h('ul', { class: 'list-unstyled small' }, list(result.added, '+'), list(result.removed, '−'))
        : h('p', { class: 'small' }, 'Same firmware: nothing changes.'),
      result.removed.length ? h('p', { class: 'small text-warning' }, 'Lines with − are removed: this goes back to an older firmware.') : null);
    } catch (error) {
      sections.push(h('h6', {}, title), h('p', { class: 'small text-body-secondary' }, error.message));
    }
  }
  body.replaceChildren(...sections);
});

// ------------------------------------------------------------------ an update's steps, as a timeline

const STEPS = [['connecting', 'connect'], ['uploading', 'upload'], ['testing', 'test'], ['rebooting', 'reboot'],
  ['waiting for the device', 'back online'], ['confirming', 'confirm']];
const uploads = new Map();  // when each upload started showing progress: for the time left

// Where each step stands for this device: done, active, failed, skipped or (by default) waiting
function stepStates(t) {
  const at = STEPS.findIndex(([step]) => step === (t.status === 'failed' ? t.failed_at : t.step));
  if (t.status === 'updated') return STEPS.map(() => 'done');
  if (t.status === 'already-current') return STEPS.map((_, i) => (i === 0 ? 'done' : 'skipped'));
  if (t.status === 'running') return STEPS.map((_, i) => (i < at ? 'done' : i === at ? 'active' : 'waiting'));
  if (t.status === 'failed' && at >= 0) return STEPS.map((_, i) => (i < at ? 'done' : i === at ? 'failed' : 'waiting'));
  return STEPS.map(() => 'waiting');
}

function timeLeft(key, progress) {
  if (progress <= 0) return '';
  const now = Date.now() / 1000;
  if (!uploads.has(key)) uploads.set(key, { t: now, p: progress });
  const first = uploads.get(key);
  const rate = (progress - first.p) / Math.max(1, now - first.t);
  if (rate <= 0 || progress >= 1) return '';
  const seconds = (1 - progress) / rate;
  return seconds < 90 ? `≈ ${Math.round(seconds)} s left` : `≈ ${Math.round(seconds / 60)} min left`;
}

function ring(progress) {
  const r = 9, around = 2 * Math.PI * r;
  return svg('svg', { class: 'step-ring', viewBox: '-12 -12 24 24', 'aria-hidden': 'true' },
    svg('circle', { r, class: 'gauge-track' }),
    svg('circle', { r, class: 'gauge', transform: 'rotate(-90)', 'stroke-dasharray': `${progress * around} ${around}` }));
}

const stepIcon = { done: 'check', failed: 'x', skipped: 'minus', waiting: 'circle', active: 'loader-circle' };

// The updates seen finished, so that the last step's checkmark draws itself once
const finishedSeen = new Set();

function targetTimeline(job, t) {
  const states = stepStates(t);
  const key = `${job.id}:${t.label}`;
  const justFinished = t.status === 'updated' && !finishedSeen.has(key);
  if (t.status === 'updated') finishedSeen.add(key);
  return h('ol', { class: `steps${justFinished ? ' just-finished' : ''}` }, STEPS.map(([step, label], i) => {
    if (justFinished && i === STEPS.length - 1) {
      // Drawn as a path, so that its stroke can be drawn in
      return h('li', { class: 'step done' },
        h('span', { class: 'step-mark' }, svg('svg', { class: 'icon check-draw', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
          svg('path', { d: 'M5 12.5l4.5 4.5L19 7.5', pathLength: 1 }))),
        h('span', { class: 'step-label' }, label));
    }
    const uploading = states[i] === 'active' && step === 'uploading';
    return h('li', { class: `step ${states[i]}` },
      h('span', { class: 'step-mark' }, uploading ? ring(t.progress)
        : svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${stepIcon[states[i]]}` }))),
      h('span', { class: 'step-label' }, uploading ? `${label} ${Math.round(t.progress * 100)} %` : label),
      uploading ? h('span', { class: 'step-note' }, timeLeft(key, t.progress)) : null);
  }));
}

const elapsed = (t) => {
  if (!t.started) return '';
  const seconds = (t.finished || Date.now() / 1000) - t.started;
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
};

export function renderJobs() {
  const container = document.getElementById('jobs');
  const jobs = [...state.jobs.values()].sort((a, b) => b.created - a.created);
  if (!jobs.length) return;
  container.replaceChildren(...jobs.map((job) => h('div', { class: 'card mb-3 job' },
    h('div', { class: 'card-header d-flex align-items-center gap-2' },
      h('span', {}, `Image v${job.image_version} · ${shortHash(job.image_hash)}`),
      h('span', { class: `badge text-bg-${statusClass[job.state] || 'secondary'}` }, job.state),
      h('span', { class: 'small text-body-secondary' }, when(job.created)),
      job.state === 'paused' ? h('span', { class: 'ms-auto small text-warning' }, 'Check the first device, then:') : null,
      job.state === 'paused' ? h('button', { class: 'btn btn-sm btn-success',
        onclick: () => api('POST', `/api/updates/${job.id}/continue`).catch(() => {}) }, 'Continue with the rest') : null,
      ['running', 'paused'].includes(job.state) ? h('button', { class: `btn btn-sm btn-outline-danger${job.state === 'running' ? ' ms-auto' : ''}`,
        onclick: () => api('POST', `/api/updates/${job.id}/cancel`).catch(() => {}) }, 'Cancel the rest') : null),
    h('div', { class: 'card-body job-targets' }, job.targets.map((t) => h('div', { class: `job-target ${t.status}` },
      h('div', { class: 'job-who' }, h('b', {}, t.label),
        h('div', { class: 'small text-body-secondary' }, `${t.transport === 'serial' ? 'USB' : 'over the air'}${t.started ? ` · ${elapsed(t)}` : ''}`)),
      targetTimeline(job, t),
      h('div', { class: 'job-result' }, h('span', { class: `badge text-bg-${statusClass[t.status] || 'secondary'}` }, t.status),
        t.message ? h('div', { class: t.status === 'failed' ? 'error-text small' : 'small text-body-secondary' }, t.message) : null)))))));
}

export async function loadJobs() {
  for (const job of await api('GET', '/api/updates')) state.jobs.set(job.id, job);
  renderJobs();
}

export async function loadHistory() {
  const rows = await api('GET', '/api/history');
  if (!state.devices.size) await loadDevices();
  document.querySelector('#history-table tbody').replaceChildren(...rows.map((r) => {
    const device = state.devices.get(r.device_id);
    return h('tr', {}, h('td', {}, when(r.finished)), h('td', {}, device ? deviceName(device) : r.device_id),
      h('td', {}, r.transport === 'serial' ? 'USB' : 'air'), h('td', {}, `v${r.image_version} · ${shortHash(r.image_hash)}`),
      h('td', {}, h('span', { class: `badge text-bg-${statusClass[r.result] || 'secondary'}` }, r.result)),
      h('td', { class: 'small' }, r.message));
  }));
}

// ------------------------------------------------------------------ who signed an image

export const signerShort = { yours: 'your key', development: 'dev key', other: 'other key', unsigned: 'unsigned', unknown: 'not checked' };
export const signerClass = { yours: 'text-success', development: 'text-danger', other: 'text-danger', unsigned: 'text-warning', unknown: 'text-body-secondary' };
export const signerIcon = { yours: '✓', development: '✗', other: '✗', unsigned: '✗', unknown: '?' };
export const REFUSED_SIGNERS = ['development', 'other', 'unsigned'];  // boards with your bootloader won't boot these

// Under the image choice: who signed it, and which selected devices have a low battery.
export function renderUpdateChecks() {
  const image = state.images.find((i) => i.hash === document.getElementById('update-image').value);
  const signer = document.getElementById('update-image-signer');
  signer.className = `form-text ${image ? signerClass[image.signer] || '' : ''}`;
  signer.textContent = image && image.signer ? `${signerIcon[image.signer] || ''} ${image.detail}` : '';
  const limit = state.status ? state.status.settings.min_battery_for_update : 20;
  const low = [...state.selected].map((id) => state.devices.get(id))
    .filter((d) => d && limit && d.battery !== null && d.battery !== undefined && d.battery < limit);
  const warning = document.getElementById('update-low-batteries');
  warning.classList.toggle('d-none', !low.length);
  warning.textContent = low.length ? `Battery under ${limit} %: ${low.map((d) => `${deviceName(d)} (${d.battery} %)`).join(', ')}. ` +
    'Over the air, they\'re skipped unless the box above is ticked: a battery that dies mid-update costs a battery change.' : '';
  document.getElementById('ignore-battery-label').textContent = limit ? `Update batteries under ${limit} % too` : 'Update low batteries too';
}

document.getElementById('update-image').addEventListener('change', renderUpdateChecks);
