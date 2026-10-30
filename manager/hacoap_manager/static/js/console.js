// The Console tab: what a board prints, on a USB serial port or (its log) over the air.

import { api, busy, h, notify, state } from './core.js';
import { deviceName } from './devices.js';
import { renderActivity } from './live.js';

// ------------------------------------------------------------------ console

export const consoleLines = [];
let consoleFrom = 'usb';  // the source shown when the console is closed

// 'deviceId': a board to show over the air (from #console/<device id>)
export async function loadConsole(deviceId = null) {
  const [ports, current] = await Promise.all([api('GET', '/api/serial-ports'), api('GET', '/api/console')]);
  const select = document.getElementById('console-port');
  const previous = current.port || select.value;
  select.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.port },
    `${p.port} – ${p.description}${p.board ? ' (board)' : ''}`)) : [h('option', { value: '' }, 'No serial ports')]));
  if (previous && ports.some((p) => p.port === previous)) select.value = previous;

  if (deviceId && !current.open) consoleFrom = 'air';
  wantedBoard = current.device_id || deviceId;
  renderConsoleBoards();

  consoleLines.length = 0;
  consoleLines.push(...current.lines);
  document.getElementById('console-log').textContent = consoleLines.join('\n');
  onConsoleState(current);
}

// The boards to choose from over the air (again once the devices are loaded)
let wantedBoard = null;

export function renderConsoleBoards() {
  const boards = document.getElementById('console-device');
  const chosen = wantedBoard || boards.value;
  const devices = [...state.devices.values()].filter((d) => d.address)
    .sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  boards.replaceChildren(...(devices.length ? devices.map((d) => h('option', { value: d.device_id },
    `${deviceName(d)}${d.plant && d.plant !== deviceName(d) ? ` – ${d.plant}` : ''}`))
    : [h('option', { value: '' }, 'No boards with an address')]));
  if (chosen && devices.some((d) => d.device_id === chosen)) {
    boards.value = chosen;
    wantedBoard = null;
  }
}

function showConsoleFrom(from) {
  for (const element of document.querySelectorAll('.console-usb')) element.classList.toggle('d-none', from !== 'usb');
  for (const element of document.querySelectorAll('.console-air')) element.classList.toggle('d-none', from !== 'air');
  document.getElementById('console-from-usb').classList.toggle('active', from === 'usb');
  document.getElementById('console-from-air').classList.toggle('active', from === 'air');
}

export function onConsoleState(current) {
  state.console = current;
  renderActivity();
  if (current.open) consoleFrom = current.source;
  showConsoleFrom(consoleFrom);
  document.getElementById('console-open').classList.toggle('d-none', current.open);
  document.getElementById('console-close').classList.toggle('d-none', !current.open);
  for (const id of ['console-port', 'console-device', 'console-from-usb', 'console-from-air']) {
    document.getElementById(id).disabled = current.open;
  }
}

export function onConsoleLine(line) {
  consoleLines.push(line);
  if (consoleLines.length > 2000) consoleLines.splice(0, consoleLines.length - 2000);
  const log = document.getElementById('console-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = consoleLines.join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

for (const from of ['usb', 'air']) {
  document.getElementById(`console-from-${from}`).addEventListener('click', () => { consoleFrom = from; showConsoleFrom(from); });
}
document.getElementById('console-ports-refresh').addEventListener('click', () => loadConsole().catch(() => {}));
function clearConsole() {
  consoleLines.length = 0;
  document.getElementById('console-log').textContent = '';
}

document.getElementById('console-open').addEventListener('click', (event) => busy(event.target, async () => {
  clearConsole();  // before asking: the first lines can arrive before the answer
  if (consoleFrom === 'air') {
    const deviceId = document.getElementById('console-device').value;
    if (!deviceId) return notify('Choose a board', 'warning');
    onConsoleState(await api('POST', '/api/console/open', { device_id: deviceId }));
    return;
  }
  const port = document.getElementById('console-port').value;
  if (!port) return notify('Choose a port', 'warning');
  onConsoleState(await api('POST', '/api/console/open', { port, baudrate: Number(document.getElementById('console-baud').value) }));
}));
document.getElementById('console-close').addEventListener('click', async () => {
  onConsoleState(await api('POST', '/api/console/close').catch(() => ({ open: false })));
});
document.getElementById('console-clear').addEventListener('click', clearConsole);
document.getElementById('console-send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('console-input');
  api('POST', '/api/console/send', { text: input.value }).then(() => { input.value = ''; }, () => {});
});
