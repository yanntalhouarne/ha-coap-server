// The Builds tab: profiles, checks, builds, setting up this computer, flashing over SWD.

import { REFUSED_SIGNERS } from './updates.js';
import { ago, api, busy, h, notify, shortHash, state, when } from './core.js';
import { renderActivity } from './live.js';

// ------------------------------------------------------------------ builds

export const builds = { schema: [], variants: [], profiles: [], profile: null, buildId: null };

export async function loadBuildsTab() {
  const [schema, profiles, checks, history] = await Promise.all([
    api('GET', '/api/kconfig'), api('GET', '/api/profiles'), api('GET', '/api/build-checks'), api('GET', '/api/firmware-builds')]);
  builds.schema = schema.schema;
  builds.variants = schema.variants;
  builds.profiles = profiles;
  const select = document.getElementById('profile-select');
  const keep = builds.profile ? builds.profile.name : (profiles[0] && profiles[0].name);
  select.replaceChildren(...profiles.map((p) => h('option', { value: p.name }, p.name)));
  if (keep && profiles.some((p) => p.name === keep)) select.value = keep;
  document.getElementById('profile-variant').replaceChildren(...builds.variants.map((v) => h('option', { value: v }, v)));
  showProfile(select.value);
  renderChecks(checks);
  renderBuildHistory(history);
  loadSetupState().catch(() => {});
  loadSwd().catch(() => {});
  const running = history.find((b) => b.result === 'running');
  if (running) showBuildLog(running.id);
}

export function showProfile(name) {
  builds.profile = builds.profiles.find((p) => p.name === name) || null;
  const container = document.getElementById('profile-settings');
  if (!builds.profile) { container.replaceChildren(h('p', {}, 'No profile.')); return; }
  document.getElementById('profile-variant').value = builds.profile.variant;
  document.getElementById('profile-notes').value = builds.profile.notes || '';
  const groups = new Map();
  for (const symbol of builds.schema) {
    if (!groups.has(symbol.menu)) groups.set(symbol.menu, []);
    groups.get(symbol.menu).push(symbol);
  }
  container.replaceChildren(...[...groups.entries()].map(([menu, symbols]) =>
    h('fieldset', {}, h('legend', {}, menu), h('div', { class: 'row g-3' }, symbols.map(settingField)))));
  updateChangeCount();
}

export function defaultText(symbol) {
  if (symbol.type === 'bool') return symbol.default ? 'yes' : 'no';
  if (symbol.type === 'choice') return (symbol.options.find((o) => o.name === symbol.default) || {}).prompt || symbol.default;
  return String(symbol.default);
}

export function settingField(symbol) {
  const value = builds.profile.settings[symbol.name];
  const id = `setting-${symbol.name}`;
  let input;
  if (symbol.type === 'int') {
    input = h('input', { class: 'form-control', type: 'number', step: 1, id, placeholder: defaultText(symbol),
      min: symbol.range ? symbol.range[0] : null, max: symbol.range ? symbol.range[1] : null,
      value: value === undefined ? null : value });
  } else if (symbol.type === 'string') {
    input = h('input', { class: 'form-control', id, placeholder: defaultText(symbol), maxlength: 64,
      value: value === undefined ? null : value });
  } else {
    const options = symbol.type === 'bool' ? [{ name: 'true', prompt: 'Yes' }, { name: 'false', prompt: 'No' }] : symbol.options;
    input = h('select', { class: 'form-select', id },
      h('option', { value: '' }, `Default (${defaultText(symbol)})`),
      options.map((o) => h('option', { value: o.name, selected: value !== undefined && String(value) === o.name }, o.prompt)));
  }
  input.dataset.symbol = symbol.name;
  input.addEventListener('input', updateChangeCount);
  const dependency = symbol.depends_on ? builds.schema.flatMap((s) => s.options || []).find((o) => o.name === symbol.depends_on) : null;
  return h('div', { class: 'col-md-6' },
    h('label', { class: 'form-label small', for: id, title: `CONFIG_${symbol.name}` }, symbol.prompt),
    input,
    symbol.help ? h('div', { class: 'form-text' }, symbol.help) : null,
    dependency ? h('div', { class: 'form-text fst-italic' }, `Only used with: ${dependency.prompt}`) : null);
}

export function profileSettings() {
  const settings = {};
  for (const input of document.querySelectorAll('#profile-settings [data-symbol]')) {
    if (input.value === '') continue;
    const symbol = builds.schema.find((s) => s.name === input.dataset.symbol);
    settings[symbol.name] = symbol.type === 'int' ? Number(input.value) : symbol.type === 'bool' ? input.value === 'true' : input.value;
  }
  return settings;
}

export function updateChangeCount() {
  let count = 0;
  for (const input of document.querySelectorAll('#profile-settings [data-symbol]')) {
    input.classList.toggle('setting-changed', input.value !== '');
    if (input.value !== '') count++;
  }
  document.getElementById('profile-changes').textContent =
    count ? `${count} setting(s) changed from the firmware's defaults` : 'All settings at the firmware\'s defaults';
}

export async function saveProfile(name, variant, settings, notes) {
  const saved = await api('PUT', `/api/profiles/${encodeURIComponent(name)}`, { variant, settings, notes });
  builds.profile = saved;
  await loadBuildsTab();
  return saved;
}

document.getElementById('profile-select').addEventListener('change', (e) => showProfile(e.target.value));

document.getElementById('profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!builds.profile) return;
  busy(event.submitter, async () => {
    await saveProfile(builds.profile.name, document.getElementById('profile-variant').value, profileSettings(),
      document.getElementById('profile-notes').value);
    notify('Profile saved', 'success', 2000);
  });
});

document.getElementById('profile-new').addEventListener('click', async () => {
  const name = prompt('Name of the new profile (for example "Greenhouse" or "Debug logs")');
  if (!name) return;
  await saveProfile(name.trim(), 'battery', {}, '').catch(() => {});
});

document.getElementById('profile-copy').addEventListener('click', async () => {
  if (!builds.profile) return;
  const name = prompt('Name of the copy', `${builds.profile.name} copy`);
  if (!name) return;
  await saveProfile(name.trim(), builds.profile.variant, builds.profile.settings, builds.profile.notes).catch(() => {});
});

document.getElementById('profile-delete').addEventListener('click', async () => {
  if (!builds.profile || !confirm(`Delete the profile ${builds.profile.name}?`)) return;
  await api('DELETE', `/api/profiles/${encodeURIComponent(builds.profile.name)}`).catch(() => {});
  builds.profile = null;
  loadBuildsTab();
});

export const fixLabels = { install: 'Install the build tools', keygen: 'Create my signing key', pskd: 'Set my PSKd…',
  device: 'Install the SWD flashing tools' };

export function renderChecks(checks) {
  const toolchain = checks.find((c) => c.name === 'nRF Connect toolchain');
  const shown = new Set();
  document.getElementById('build-checks').replaceChildren(...checks.map((c) => {
    let fix = null;
    if (!c.ok && c.fix && !shown.has(c.fix)) {
      shown.add(c.fix);
      const blocked = c.fix === 'keygen' && toolchain && !toolchain.ok;
      fix = h('div', { class: 'mt-1 mb-2' }, h('button', { class: 'btn btn-sm btn-primary', disabled: blocked || (state.setup && state.setup.state === 'running'),
        title: blocked ? 'Install the build tools first: the key is made with them' : null,
        onclick: (e) => runFix(c.fix, e.target) }, fixLabels[c.fix]),
      blocked ? h('span', { class: 'small text-body-secondary ms-2' }, 'after the build tools') : null);
    }
    // Optional checks (only for flashing new boards) stay quiet when missing.
    const mark = c.ok ? ['text-success', '✓ '] : c.required ? ['text-danger', '✗ '] : c.optional ? ['text-body-secondary', '○ '] : ['text-warning', '! '];
    return h('li', { class: `mb-1${c.optional && !c.ok ? ' text-body-secondary' : ''}` },
      h('span', { class: mark[0] }, mark[1]), h('b', {}, c.name), ': ', c.detail,
      c.link ? [' ', h('a', { href: c.link, target: '_blank', rel: 'noopener' }, 'SEGGER\'s download page')] : null, fix);
  }));
}

export const buildBadge = { running: 'primary', done: 'success', failed: 'danger', cancelled: 'warning' };

export function renderBuildHistory(history) {
  document.querySelector('#builds-table tbody').replaceChildren(...history.map((b) => h('tr', {},
    h('td', { class: 'small' }, when(b.started)), h('td', {}, `${b.profile} (${b.variant})`),
    h('td', {}, h('span', { class: `badge text-bg-${buildBadge[b.result] || 'secondary'}`, title: b.message }, b.result)),
    h('td', { class: b.signing === 'development' ? 'text-danger small' : 'small' }, b.signing),
    h('td', { class: 'mono small' }, shortHash(b.image_hash)),
    h('td', {}, h('button', { class: 'btn btn-sm btn-link p-0', onclick: () => showBuildLog(b.id) }, 'Log')))));
}

export async function showBuildLog(id) {
  const build = await api('GET', `/api/firmware-builds/${id}`);
  builds.buildId = build.id;
  const log = document.getElementById('build-log');
  log.textContent = build.log || '';
  log.scrollTop = log.scrollHeight;
  renderBuildStatus(build);
}

export function renderBuildStatus(build) {
  const running = build.result === 'running';
  document.getElementById('build-start').disabled = running;
  document.getElementById('build-cancel').classList.toggle('d-none', !running);
  document.getElementById('build-status').replaceChildren(
    h('span', { class: `badge text-bg-${buildBadge[build.result] || 'secondary'} me-1` }, build.result),
    `${build.profile} (${build.variant}) `, build.message || '');
}

export async function startBuild(allowDevelopmentKey = false) {
  if (!builds.profile) return;
  try {
    const build = await api('POST', '/api/firmware-builds', { profile: builds.profile.name, allow_development_key: allowDevelopmentKey },
      { quiet: true });
    builds.buildId = build.id;
    document.getElementById('build-log').textContent = '';
    renderBuildStatus(build);
  } catch (error) {
    if (!allowDevelopmentKey && error.message.startsWith('No private signing key') &&
        confirm(`${error.message}\n\nBuild with the development key?`)) {
      return startBuild(true);
    }
    notify(error.message, 'danger');
  }
}

document.getElementById('build-start').addEventListener('click', () => startBuild());
document.getElementById('build-cancel').addEventListener('click', () => api('POST', '/api/firmware-builds/cancel').catch(() => {}));

export function onBuildLog(event) {
  if (event.id !== builds.buildId) return;
  const log = document.getElementById('build-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(event.line + '\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

export function onBuild(event) {
  const build = event.build;
  if (builds.buildId === null || build.id === builds.buildId) {
    builds.buildId = build.id;
    renderBuildStatus(build);
  }
  if (build.result !== 'running') {
    notify(`Build ${build.result}: ${build.message}`, build.result === 'done' ? 'success' : 'warning');
    api('GET', '/api/firmware-builds').then(renderBuildHistory, () => {});
  }
}

// ------------------------------------------------------------------ setting up this computer

export async function runFix(fix, button) {
  if (fix === 'pskd') {
    const value = prompt('Your joiner PSKd: 6 to 32 characters, A-Z and 0-9, without I, O, Q or Z.\n' +
      'Leave it empty for a random one. It goes into application/local.conf (not in git).', '');
    if (value === null) return;
    await busy(button, async () => {
      const result = await api('POST', '/api/setup/pskd', { pskd: value.trim() || null });
      notify(`PSKd set: ${result.pskd}. Keep it somewhere safe; you need it to commission boards.`, 'success', 15000);
      renderChecks(result.checks);
    });
    return;
  }
  if (fix === 'keygen' && !confirm('Create your private signing key?\n\nBack it up afterwards (application/keys/): ' +
    'boards flashed with it only accept updates signed with it. Losing it means reflashing every board over SWD.')) return;
  if (fix === 'install' && !confirm('Install the nRF Connect toolchain and fetch the SDK? About 1 GB, 5 to 15 minutes.')) return;
  if (fix === 'device' && !confirm('Install nrfutil\'s "device" command, to flash boards over SWD? A small download, ' +
    'into nrfutil\'s own folder. It also needs SEGGER\'s J-Link software, which you install yourself.')) return;
  await api('POST', `/api/setup/${fix}`).catch(() => {});
}

export function onSetup(setup) {
  state.setup = setup;
  renderActivity();
  const status = document.getElementById('setup-status');
  if (!status) return;
  const running = setup && setup.state === 'running';
  document.getElementById('setup-cancel').classList.toggle('d-none', !running);
  document.getElementById('setup-log').classList.toggle('d-none', !setup);
  status.replaceChildren(setup ? h('span', { class: `badge text-bg-${buildBadge[setup.state] || 'secondary'} me-1` }, setup.state) : '',
    setup ? `${setup.name}: ${setup.message || 'running…'}` : '');
  if (setup && setup.state !== 'running') {
    notify(`${setup.name[0].toUpperCase()}${setup.name.slice(1)}: ${setup.message}`, setup.state === 'done' ? 'success' : 'warning');
    api('GET', '/api/build-checks').then(renderChecks, () => {});
    loadSwd().catch(() => {});
  }
}

export function onSetupLog(line) {
  const log = document.getElementById('setup-log');
  log.classList.remove('d-none');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line + '\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

export async function loadSetupState() {
  const setup = await api('GET', '/api/setup');
  state.setup = setup.current;
  const log = document.getElementById('setup-log');
  log.textContent = setup.log.join('\n') + (setup.log.length ? '\n' : '');
  log.classList.toggle('d-none', !setup.current);
  const status = document.getElementById('setup-status');
  status.replaceChildren(setup.current ? h('span', { class: `badge text-bg-${buildBadge[setup.current.state] || 'secondary'} me-1` }, setup.current.state) : '',
    setup.current ? `${setup.current.name}: ${setup.current.message || 'running…'}` : '');
  document.getElementById('setup-cancel').classList.toggle('d-none', !(setup.current && setup.current.state === 'running'));
}

document.getElementById('setup-cancel').addEventListener('click', () => api('POST', '/api/setup/cancel').catch(() => {}));

// ------------------------------------------------------------------ flashing a board over SWD

export const swd = { state: null, probesFound: false };
// A build's merged.hex holds MCUboot made with the same key that signed its application: the
// key the board will then accept updates from.
export const swdSigners = {
  yours: ['text-success', '✓ Its bootloader takes your key: the board will accept updates signed with it.'],
  development: ['text-danger', '⚠ Its bootloader takes MCUboot\'s public development key: anyone could then update the board. Only for testing.'],
  other: ['text-danger', '⚠ Its bootloader takes a key that isn\'t yours: the board would refuse your updates.'],
  unsigned: ['text-danger', '⚠ Its application isn\'t signed: the board won\'t boot it.'],
  unknown: ['text-body-secondary', '? This computer has no copy of your signing key, so it can\'t tell which key the bootloader takes.'],
};

export async function loadSwd() {
  const st = swd.state = await api('GET', '/api/swd', undefined, { quiet: true });
  const missing = [];
  if (!st.tools) missing.push('the SWD flashing tools');
  if (!st.jlink) missing.push('SEGGER\'s J-Link software');
  if (!st.builds.length) missing.push('a build (Build with this profile)');
  const ready = st.tools && st.builds.length > 0;
  document.getElementById('swd-missing').classList.toggle('d-none', !missing.length);
  document.getElementById('swd-missing').textContent = missing.length
    ? `Needs ${missing.join(', ')}: see Set up this computer above.` : '';
  document.getElementById('swd-form').classList.toggle('d-none', !ready);
  const select = document.getElementById('swd-build');
  const keep = select.value;
  select.replaceChildren(...st.builds.map((b) => h('option', { value: b.variant }, `${b.variant} · built ${ago(b.modified)}`)));
  if (st.builds.some((b) => b.variant === keep)) select.value = keep;
  renderSwdSigner();
  if (ready && !swd.probesFound) findProbes().catch(() => {});
}

export function renderSwdSigner() {
  const build = swd.state && swd.state.builds.find((b) => b.variant === document.getElementById('swd-build').value);
  const [cls, text] = build ? swdSigners[build.signer] || swdSigners.unknown : ['', ''];
  const line = document.getElementById('swd-signer');
  line.className = `form-text mb-2 ${cls}`;
  line.textContent = text;
}

export async function findProbes() {
  const select = document.getElementById('swd-probe');
  select.replaceChildren(h('option', { value: '' }, 'looking…'));
  let probes;
  try {
    probes = await api('GET', '/api/swd/probes', undefined, { quiet: true });
  } catch (error) {
    select.replaceChildren(h('option', { value: '' }, 'couldn\'t list them'));
    notify(error.message, 'warning');
    return;
  }
  swd.probesFound = true;
  select.replaceChildren(...(probes.length
    ? probes.map((p) => h('option', { value: p.serial }, `J-Link ${p.serial}${p.devkit ? ' (development kit)' : ''}`))
    : [h('option', { value: '' }, 'none found: plug it in, then Find')]));
}

document.getElementById('swd-build').addEventListener('change', renderSwdSigner);
document.getElementById('swd-probes-find').addEventListener('click', (event) => busy(event.target, findProbes));
document.getElementById('swd-flash').addEventListener('click', async (event) => {
  const variant = document.getElementById('swd-build').value;
  const serial = document.getElementById('swd-probe').value;
  const erase = document.querySelector('input[name="swd-erase"]:checked').value;
  if (!serial) return notify('Choose a J-Link: plug it in, then click Find', 'warning');
  const build = swd.state.builds.find((b) => b.variant === variant);
  let allow = false;
  if (build && REFUSED_SIGNERS.includes(build.signer)) {
    if (!confirm(`${swdSigners[build.signer][1].slice(2)}\n\nFlash it anyway?`)) return;
    allow = true;
  }
  const question = erase === 'all'
    ? `Erase the board on J-Link ${serial} completely, then flash the ${variant} build?\n\n` +
      'It loses its Thread network, and has to join again (with your PSKd).'
    : `Flash the ${variant} build to the board on J-Link ${serial}?\n\nIt keeps its Thread network.`;
  if (!confirm(question)) return;
  await busy(event.target, async () => {
    await api('POST', '/api/swd/flash', { variant, serial, erase, allow_development_key: allow });
    document.getElementById('setup-log').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
});
