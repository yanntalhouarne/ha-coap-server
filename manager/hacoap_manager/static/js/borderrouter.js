// The Border router tab: OpenThread's border router in Docker on this computer (borderrouter.py):
// its status, restart, safe updates with a way back, its log, its network's settings (kept in
// the app's backups, shown and imported here), and setting it up on a new computer.

import { ago, api, busy, h, notify, when } from './core.js';

const br = { status: null, network: null, revealed: null, reloadTimer: null, scan: null };
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
    loadScan(),
  ]);
  br.status = status;
  renderStatus();
  loadLog();
  loadNewest(false);
}

// Is there a newer build? Docker Hub's list of builds, asked at most every 6 hours (or now)
async function loadNewest(refresh) {
  const newest = await api('GET', `/api/border-router/newest${refresh ? '?refresh=true' : ''}`, undefined, { quiet: true })
    .catch(() => null);
  if (!newest || !br.status) return;
  br.status = { ...br.status, newest };
  renderNewest(newest);
}

const buildDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const commitLink = (commit) => (commit ? h('a', { href: `https://github.com/openthread/ot-br-posix/commit/${commit}`,
  target: '_blank', rel: 'noopener' }, commit) : null);

function renderNewest(newest) {
  const box = $('br-newest');
  const update = $('br-update');
  const available = Boolean(newest && newest.update_available);
  update.classList.toggle('btn-primary', available);
  update.classList.toggle('btn-outline-primary', !available);
  if (!br.status || !br.status.container) { box.replaceChildren(); return; }
  const check = h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', type: 'button',
    onclick: (event) => during(event.currentTarget, () => loadNewest(true)) }, 'check now');
  const checked = newest && newest.checked ? [` · checked ${ago(newest.checked)} · `, check] : [' · ', check];
  let text;
  if (!newest || !newest.checked) {
    text = [h('span', { class: 'text-body-secondary' }, 'Checking Docker Hub for a newer build…')];
  } else if (newest.error) {
    text = [h('span', { class: 'text-warning' }, newest.error)];
  } else if (newest.update_available === null) {
    text = [h('span', { class: 'text-body-secondary' }, 'It runs "latest", not a pinned build: an update pins it.')];
  } else if (newest.update_available) {
    const count = newest.newer_builds;
    text = [h('span', { class: 'badge text-bg-info me-1' }, 'newer build'),
      `OpenThread published a newer build on ${buildDate(newest.latest_date)}`,
      newest.latest_commit ? [' (', commitLink(newest.latest_commit), ')'] : '',
      count ? `: ${count} build${count > 1 ? 's' : ''} since yours` : '', '.'];
  } else {
    text = [h('span', { class: 'badge text-bg-success me-1' }, 'up to date'),
      `This is the newest build (${buildDate(newest.latest_date)}`,
      newest.latest_commit ? [', ', commitLink(newest.latest_commit)] : '', ').'];
  }
  box.replaceChildren(...text.flat(), ...(newest && newest.checked ? checked : [' · ', check]));
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
        row('Moving to channel', thread.pending ? `${thread.pending.channel}${thread.pending.delay_s !== null
          ? `, in ${Math.max(0, Math.round(thread.pending.delay_s / 60))} min` : ''} (every device has it)` : ''),
        row('Commissioner', thread.commissioner && thread.commissioner !== 'disabled' ? thread.commissioner : ''),
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
  const onNetwork = Boolean(thread && ['router', 'leader', 'child'].includes(thread.state));
  for (const id of ['br-restart', 'br-update', 'br-rollback', 'br-setup-button', 'br-join-start', 'br-channel-move']) {
    $(id).disabled = busyJob || !s.docker.ok;
  }
  $('br-restart').disabled ||= !s.container;
  $('br-update').disabled ||= !s.container;
  $('br-join-start').disabled ||= !onNetwork;
  $('br-channel-move').disabled ||= !onNetwork || Boolean(thread.pending);
  $('br-join-stop').classList.toggle('d-none', !(busyJob && s.job.action === 'commission'));
  renderChannelChoices(thread);
  // A long job (boards joining, a channel change on its way): read again now and then
  clearTimeout(br.pollTimer);
  if (busyJob || (thread && thread.pending)) br.pollTimer = setTimeout(borderRouterChanged, 15000);
  $('br-rollback').classList.toggle('d-none', !s.config.previous_image);
  renderNewest(s.newest);
  $('br-setup-button').textContent = s.container ? 'Start it again with these' : 'Start the border router';
  renderJob(s.job);
}

const JOB_NAMES = { setup: 'Setting up', restart: 'Restarting', update: 'Updating', rollback: 'Going back',
  import: 'Joining a network', commission: 'Letting boards join', channel: 'Moving to another channel' };

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

// ------------------------------------------------------------------ adding boards over the air

$('br-join').addEventListener('submit', (event) => {
  event.preventDefault();
  const pskd = $('br-pskd').value.trim().toUpperCase();
  if (!/^[0-9A-HJ-NPR-Y]{6,32}$/.test(pskd)) {
    notify('The PSKd is 6 to 32 digits and capital letters, without I, O, Q and Z: the one in local.conf.', 'warning');
    return;
  }
  const body = { pskd, minutes: Number($('br-join-minutes').value), eui64: $('br-join-eui64').value.trim().toLowerCase() };
  during(event.submitter, async () => {
    br.status = { ...br.status, job: await api('POST', '/api/border-router/commission', body) };
    $('br-pskd').value = '';  // not kept in the page either
    renderStatus();
  });
});

$('br-join-stop').addEventListener('click', (event) => during(event.currentTarget, async () => {
  await api('POST', '/api/border-router/commission/stop');
}));

// ------------------------------------------------------------------ moving to another channel

// The noise per channel, from the Network tab's last channel scan (if any)
async function loadScan() {
  const network = await api('GET', '/api/network', undefined, { quiet: true }).catch(() => null);
  br.scan = network && network.channel_scan;
  renderChannelChoices(br.status && br.status.thread && !br.status.thread.error ? br.status.thread : null);
}

function renderChannelChoices(thread) {
  const select = $('br-channel-new');
  const current = thread ? Number(thread.channel) : null;
  const scan = br.scan && br.scan.channels ? new Map(br.scan.channels.map((c) => [c.channel, c])) : new Map();
  const quiet = br.scan && br.scan.channels
    ? [...br.scan.channels].sort((a, b) => a.max_rssi - b.max_rssi).slice(0, 3).map((c) => c.channel) : [];
  const previous = Number(select.value) || null;
  const options = [];
  for (let channel = 11; channel <= 26; channel += 1) {
    const noise = scan.get(channel);
    const label = `${channel}${channel === current ? ' (now)' : ''}${noise ? ` · noise up to ${noise.max_rssi} dBm` : ''}`
      + `${quiet.includes(channel) ? ' · quiet' : ''}`;
    options.push(h('option', { value: channel, disabled: channel === current }, label));
  }
  select.replaceChildren(...options);
  const fallback = quiet.find((c) => c !== current) || (current === 25 ? 20 : 25);
  select.value = previous && previous !== current ? previous : fallback;
  $('br-channel-scan-hint').replaceChildren(...(br.scan
    ? [`The noise per channel is from the channel scan of ${new Date(br.scan.time * 1000).toLocaleDateString()}.`]
    : ['To see which channels are quiet: ', h('b', {}, 'Scan'), ' on the ', h('a', { href: '#network' }, 'Network tab'), ' first.']));
}

$('br-channel').addEventListener('submit', (event) => {
  event.preventDefault();
  const channel = Number($('br-channel-new').value);
  const delay = Number($('br-channel-delay').value);
  if (!confirm(`Move the whole Thread network to channel ${channel} in ${delay / 60} minutes? Every device gets it first, `
    + 'then they all switch together. A board that\'s off now finds the network again by itself later.')) return;
  during(event.submitter, async () => {
    br.status = { ...br.status, job: await api('POST', '/api/border-router/channel', { channel, delay_s: delay }) };
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
