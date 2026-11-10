// The Border router tab: OpenThread's border router in Docker on this computer (borderrouter.py):
// its status, restart, safe updates with a way back, its log, its network's settings (kept in
// the app's backups, shown and imported here), and setting it up on a new computer.

import { api, busy, h, notify, when } from './core.js';

const br = { status: null, network: null, revealed: null, reloadTimer: null };
const $ = (id) => document.getElementById(id);

// Disabled while it works (busy() would put back only the text: these buttons have an icon)
async function during(button, work) {
  button.disabled = true;
  try { return await work(); } catch (error) { return undefined; } finally { button.disabled = false; }
}

const ROLE_TONE = { leader: 'text-bg-success', router: 'text-bg-success', child: 'text-bg-warning',
  detached: 'text-bg-danger', disabled: 'text-bg-secondary' };

export async function loadBorderRouter() {
  const [status] = await Promise.all([
    api('GET', '/api/border-router', undefined, { quiet: true }),
    loadNetworkSettings(),
    loadCandidates(),
  ]);
  br.status = status;
  renderStatus();
  loadLog();
}

// Again soon after a change (a job's steps come one after another)
export function borderRouterChanged() {
  if ($('tab-border-router').classList.contains('d-none')) return;
  clearTimeout(br.reloadTimer);
  br.reloadTimer = setTimeout(() => {
    api('GET', '/api/border-router', undefined, { quiet: true }).then((status) => {
      const finished = br.status?.job?.state === 'running' && status.job?.state !== 'running';
      br.status = status;
      renderStatus();
      if (finished) {
        notify(status.job.message, status.job.state === 'done' ? 'success' : 'warning', 12000);
        loadNetworkSettings();
        loadCandidates();
        loadLog();
      }
    }, () => {});
  }, 400);
}

function row(label, value, title) {
  if (value === undefined || value === null || value === '') return null;
  return [h('dt', { class: 'col-sm-5 text-body-secondary fw-normal' }, label), h('dd', { class: 'col-sm-7 mb-1', title }, value)];
}

const short = (digest) => (digest || '').replace(/^sha256:/, '').slice(0, 12);
const imageShort = (image) => (image.includes('@sha256:') ? short(image.split('@')[1]) : image.split(':').pop());

function renderStatus() {
  const s = br.status;
  const missing = $('br-docker-missing');
  missing.classList.toggle('d-none', s.docker.ok);
  missing.textContent = s.docker.ok ? '' : `${s.docker.error} The border router runs in Docker on this computer.`;
  const role = $('br-role');
  const thread = s.thread && !s.thread.error ? s.thread : null;
  role.className = `badge ${thread ? (ROLE_TONE[thread.state] || 'text-bg-secondary') : 'text-bg-secondary'}`;
  role.textContent = thread ? thread.state : (s.container ? (s.container.running ? 'not answering' : s.container.status) : 'not set up');

  const box = $('br-status');
  if (!s.docker.ok) {
    box.replaceChildren(h('span', { class: 'text-body-secondary' }, 'Docker isn\'t available here.'));
  } else if (!s.container) {
    box.replaceChildren(h('p', { class: 'mb-0' }, `No border router container (${s.config.container}) on this computer yet. `,
      'Choose its radio and network interface under ', h('b', {}, 'Set up'), '.'));
  } else {
    const c = s.config;
    const image = s.image || {};
    const built = image.created ? new Date(image.created).toLocaleString() : '';
    box.replaceChildren(h('dl', { class: 'row mb-0 small' }, [
      thread ? [
        row('Network', thread.network_name),
        row('Channel', thread.channel),
        row('PAN ID', thread.pan_id),
        row('Extended PAN ID', h('code', {}, thread.ext_pan_id)),
        row('Boards\' home-network prefix', thread.omr_prefix ? h('code', {}, thread.omr_prefix) : '',
          'The prefix of the boards\' addresses on your network (OMR)'),
        row('Border routing', thread.border_routing),
        row('Routers · its children', `${thread.routers} · ${thread.children}`),
        row('Leader', thread.leader_router_id ? `router ${thread.leader_router_id} (partition ${thread.partition_id})` : ''),
        row('Radio firmware', thread.rcp_version),
        row('Border router', thread.version),
      ] : row('Thread', s.thread?.error || 'not answering yet'),
      row('Image', h('span', {}, h('code', {}, imageShort(c.image)), built ? ` · built ${built}` : '',
        image.revision ? [' · ', h('a', { href: `https://github.com/openthread/ot-br-posix/commit/${image.revision}`,
          target: '_blank', rel: 'noopener' }, image.revision.slice(0, 7))] : ''), c.image),
      row('Earlier build', c.previous_image ? h('code', {}, imageShort(c.previous_image)) : ''),
      row('Container', `${s.container.name}: ${s.container.status}${s.container.started && s.container.running
        ? ` since ${new Date(s.container.started).toLocaleString()}` : ''}`),
      row('Radio', c.rcp_device ? c.rcp_device.split('/').pop() : '', c.rcp_device),
      row('Network interface', c.infra_if),
    ].flat(2)));  // label and value pairs (h() flattens one level)
  }
  const busyJob = s.job && s.job.state === 'running';
  for (const id of ['br-restart', 'br-update', 'br-rollback', 'br-setup-button']) $(id).disabled = busyJob || !s.docker.ok;
  $('br-restart').disabled ||= !s.container;
  $('br-update').disabled ||= !s.container;
  $('br-rollback').classList.toggle('d-none', !s.config.previous_image);
  $('br-setup-button').textContent = s.container ? 'Start it again with these' : 'Start the border router';
  renderJob(s.job);
}

const JOB_NAMES = { setup: 'Setting up', restart: 'Restarting', update: 'Updating', rollback: 'Going back', import: 'Joining a network' };

function renderJob(job) {
  const box = $('br-job');
  box.classList.toggle('d-none', !job);
  if (!job) return;
  const tone = job.state === 'running' ? 'info' : job.state === 'done' ? 'success' : 'danger';
  box.className = `br-job mt-3 alert alert-${tone} small mb-0`;
  box.replaceChildren(
    h('div', { class: 'fw-semibold' }, job.state === 'running' ? `${JOB_NAMES[job.action] || job.action}…` : job.message),
    h('ol', { class: 'mb-0 mt-1 ps-3' }, job.steps.map((step) =>
      h('li', {}, h('span', { class: 'text-body-secondary' }, new Date(step.time * 1000).toLocaleTimeString()), ' ', step.message))));
}

// ------------------------------------------------------------------ the network's settings

const FIELDS = [['network_name', 'Network name'], ['channel', 'Channel'], ['pan_id', 'PAN ID'],
  ['ext_pan_id', 'Extended PAN ID'], ['mesh_local_prefix', 'Mesh-local prefix'], ['network_key', 'Network key'],
  ['pskc', 'PSKc']];

async function loadNetworkSettings() {
  br.network = await api('GET', '/api/border-router/network', undefined, { quiet: true }).catch(() => null);
  br.revealed = null;
  renderNetworkSettings();
}

function renderNetworkSettings() {
  const box = $('br-network');
  const network = br.revealed || br.network;
  if (!network || !network.source) {
    box.replaceChildren(h('p', { class: 'mb-0 text-body-secondary' }, 'No network settings yet: the border router isn\'t on a ',
      'network, and none were saved here. Import them below, or restore a backup that has them.'));
    return;
  }
  const v = network.values;
  const secret = (name) => (v[name] === null
    ? h('span', { class: 'text-body-secondary' }, '•••••••• hidden')
    : h('code', { class: 'text-break' }, v[name]));
  box.replaceChildren(
    h('dl', { class: 'row mb-2 small' }, FIELDS.filter(([name]) => name in v).flatMap(([name, label]) => [
      h('dt', { class: 'col-sm-5 text-body-secondary fw-normal' }, label),
      h('dd', { class: 'col-sm-7 mb-1' }, ['network_key', 'pskc'].includes(name) ? secret(name)
        : (['ext_pan_id', 'mesh_local_prefix'].includes(name) ? h('code', {}, v[name]) : String(v[name])))])),
    h('div', { class: 'd-flex flex-wrap gap-2' },
      br.revealed
        ? [h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: copyDataset }, 'Copy (hex)'),
          h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => { br.revealed = null; renderNetworkSettings(); } }, 'Hide')]
        : h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: (e) => busy(e.currentTarget, reveal) }, 'Show the network key')),
    h('div', { class: 'form-text' }, network.source === 'border router' ? 'Read from the border router. ' : 'As saved here (the border router isn\'t answering). ',
      network.saved ? `Saved in this app's backups (since ${when(network.saved)}): ` : 'They go into this app\'s backups: ',
      'a backup restored on another computer brings the border router back on this network. ',
      'The network key lets anything join your network: keep backups private.'));
}

async function reveal() {
  if (!confirm('Show the network key? With it, any device can join your Thread network.')) return;
  br.revealed = await api('POST', '/api/border-router/network/reveal');
  renderNetworkSettings();
}

async function copyDataset() {
  try {
    await navigator.clipboard.writeText(br.revealed.dataset);
    notify('Copied: the whole dataset (hex), network key included', 'success', 3000);
  } catch (error) {
    prompt('Copy the dataset (hex):', br.revealed.dataset);
  }
}

$('br-import').addEventListener('submit', (event) => {
  event.preventDefault();
  const dataset = $('br-import-dataset').value.trim();
  if (!dataset) return;
  if (!confirm('The border router leaves the network it\'s on and joins this one. Continue?')) return;
  busy(event.submitter, async () => {
    br.status = { ...br.status, job: await api('POST', '/api/border-router/network', { dataset }) };
    $('br-import-dataset').value = '';
    renderStatus();
  });
});

// ------------------------------------------------------------------ setting up

async function loadCandidates() {
  const found = await api('GET', '/api/border-router/candidates', undefined, { quiet: true }).catch(() => null);
  if (!found) return;
  const config = found.config;
  const radio = $('br-radio');
  const radios = [...found.radios];
  if (config.rcp_device && !radios.some((r) => r.path === config.rcp_device)) {
    radios.unshift({ path: config.rcp_device, name: `${config.rcp_device.split('/').pop()} (not plugged in)`, rcp: true });
  }
  radio.replaceChildren(...(radios.length
    ? radios.map((r) => h('option', { value: r.path }, `${r.name}${r.rcp ? '' : ' (not a radio co-processor?)'}`))
    : [h('option', { value: '' }, 'No serial device found: plug the dongle in (or pass it to this VM)')]));
  radio.value = config.rcp_device || (radios.find((r) => r.rcp) || radios[0] || {}).path || '';
  const iface = $('br-interface');
  iface.replaceChildren(...found.interfaces.map((i) => h('option', { value: i.name },
    `${i.name}${i.default ? ' (the default route)' : ''}${i.up ? '' : ' (down)'}`)));
  iface.value = config.infra_if || (found.interfaces.find((i) => i.default) || found.interfaces[0] || {}).name || '';
}

$('br-setup').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = { rcp_device: $('br-radio').value, infra_if: $('br-interface').value };
  if (br.status?.container && !confirm('The border router container is made again with these. Its network stays '
    + '(its data is kept), and it\'s off the network for a minute or two. Continue?')) return;
  busy(event.submitter, async () => {
    br.status = { ...br.status, job: await api('POST', '/api/border-router/setup', body) };
    renderStatus();
  });
});

// ------------------------------------------------------------------ actions and log

function action(id, name, question) {
  $(id).addEventListener('click', (event) => {
    if (question && !confirm(question)) return;
    during(event.currentTarget, async () => {
      br.status = { ...br.status, job: await api('POST', `/api/border-router/${name}`) };
      renderStatus();
    });
  });
}

action('br-restart', 'restart', 'Restart the border router? Your boards can\'t be reached for a minute or so.');
action('br-update', 'update', 'Update the border router to OpenThread\'s newest build? It\'s off the network for a '
  + 'minute or two, and goes back to this build by itself if the new one doesn\'t come back.');
action('br-rollback', 'rollback', 'Go back to the earlier build?');

async function loadLog() {
  const warnings = $('br-log-warnings').checked;
  const log = $('br-log');
  try {
    const result = await api('GET', `/api/border-router/logs?lines=400&warnings=${warnings}`, undefined, { quiet: true });
    log.textContent = result.lines.length ? result.lines.join('\n') : (warnings ? 'No warnings.' : 'Empty.');
  } catch (error) {
    log.textContent = br.status?.container ? error.message : 'No border router container yet.';
  }
  log.scrollTop = log.scrollHeight;
}

$('br-log-warnings').addEventListener('change', loadLog);
$('br-log-reload').addEventListener('click', loadLog);
$('br-reload').addEventListener('click', (event) => during(event.currentTarget, loadBorderRouter));
