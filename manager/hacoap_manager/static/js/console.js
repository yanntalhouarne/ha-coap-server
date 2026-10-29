// The Console tab: a board's serial output.

import { api, busy, h, notify, state } from './core.js';
import { renderActivity } from './live.js';

// ------------------------------------------------------------------ console

export const consoleLines = [];

export async function loadConsole() {
  const [ports, current] = await Promise.all([api('GET', '/api/serial-ports'), api('GET', '/api/console')]);
  const select = document.getElementById('console-port');
  const previous = current.port || select.value;
  select.replaceChildren(...(ports.length ? ports.map((p) => h('option', { value: p.port },
    `${p.port} – ${p.description}${p.board ? ' (board)' : ''}`)) : [h('option', { value: '' }, 'No serial ports')]));
  if (previous && ports.some((p) => p.port === previous)) select.value = previous;
  consoleLines.length = 0;
  consoleLines.push(...current.lines);
  document.getElementById('console-log').textContent = consoleLines.join('\n');
  onConsoleState(current);
}

export function onConsoleState(current) {
  state.console = current;
  renderActivity();
  document.getElementById('console-open').classList.toggle('d-none', current.open);
  document.getElementById('console-close').classList.toggle('d-none', !current.open);
  document.getElementById('console-port').disabled = current.open;
}

export function onConsoleLine(line) {
  consoleLines.push(line);
  if (consoleLines.length > 2000) consoleLines.splice(0, consoleLines.length - 2000);
  const log = document.getElementById('console-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = consoleLines.join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

document.getElementById('console-ports-refresh').addEventListener('click', () => loadConsole().catch(() => {}));
document.getElementById('console-open').addEventListener('click', (event) => busy(event.target, async () => {
  const port = document.getElementById('console-port').value;
  if (!port) return notify('Choose a port', 'warning');
  onConsoleState(await api('POST', '/api/console/open', { port, baudrate: Number(document.getElementById('console-baud').value) }));
}));
document.getElementById('console-close').addEventListener('click', async () => {
  onConsoleState(await api('POST', '/api/console/close').catch(() => ({ open: false })));
});
document.getElementById('console-clear').addEventListener('click', () => {
  consoleLines.length = 0;
  document.getElementById('console-log').textContent = '';
});
document.getElementById('console-send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('console-input');
  api('POST', '/api/console/send', { text: input.value }).then(() => { input.value = ''; }, () => {});
});
