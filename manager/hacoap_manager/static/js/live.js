// Live events from the app, the status bar, and the app's status.

import { api, notify, state } from './core.js';
import { currentRoute } from './tabs.js';
import { loadAlerts, loadDashboard, onAlert } from './dashboard.js';
import { loadDevices, renderDevices } from './devices.js';
import { loadHistory, loadJobs, renderJobs } from './updates.js';
import { loadNetwork, net, pulseBoard, showNodeDetails } from './network.js';
import { loadWallSoon } from './pages.js';
import { onBuild, onBuildLog, onSetup, onSetupLog } from './builds.js';
import { onConsoleLine, onConsoleState } from './console.js';
import { renderDevicePhoto, renderDeviceStatus } from './device.js';

// ------------------------------------------------------------------ live events

export function connectEvents(delay = 1000) {
  const indicator = document.getElementById('connection');
  const socket = new WebSocket(`ws://${location.host}/api/events`);
  socket.addEventListener('open', () => {
    indicator.className = 'live';
    indicator.title = 'Connected to the app';
    document.getElementById('connection-text').textContent = 'live';
    delay = 1000;
    loadDevices().catch(() => {});
    loadJobs().catch(() => {});
    loadStatus().catch(() => {});
    loadAlerts().catch(() => {});
    api('GET', '/api/setup').then((setup) => { state.setup = setup.current; renderActivity(); }, () => {});
  });
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'device') {
      const before = state.devices.get(event.device.device_id);
      if (before && event.device.last_seen && event.device.last_seen !== before.last_seen) pulseBoard(event.device.device_id);
      state.devices.set(event.device.device_id, event.device);
      if (currentRoute() === 'wall') loadWallSoon();
      renderDevices();
      if (currentRoute() === `device/${encodeURIComponent(event.device.device_id)}`) {
        renderDeviceStatus(event.device);
        renderDevicePhoto(event.device);
      }
      if (net.selectedNode && net.selectedNode.device_id === event.device.device_id) showNodeDetails(net.selectedNode);
    } else if (event.type === 'devices') {
      loadDevices().catch(() => {});
    } else if (event.type === 'network') {
      if (!document.getElementById('tab-network').classList.contains('d-none')) loadNetwork().catch(() => {});
    } else if (event.type === 'alert') {
      onAlert(event.alert);
    } else if (event.type === 'alerts') {
      loadAlerts().catch(() => {});
      if (currentRoute() === 'dashboard') loadDashboard().catch(() => {});
    } else if (event.type === 'setup') {
      onSetup(event.setup);
    } else if (event.type === 'setup-log') {
      onSetupLog(event.line);
    } else if (event.type === 'console') {
      onConsoleLine(event.line);
    } else if (event.type === 'console-state') {
      onConsoleState(event.state);
    } else if (event.type === 'build-log') {
      onBuildLog(event);
    } else if (event.type === 'build') {
      onBuild(event);
      state.build = event.build;
      renderActivity();
    } else if (event.type === 'job') {
      const finished = ['running', 'paused'].includes(state.jobs.get(event.job.id)?.state) && !['running', 'paused'].includes(event.job.state);
      state.jobs.set(event.job.id, event.job);
      renderJobs();
      renderActivity();
      if (finished) {
        loadHistory().catch(() => {});
        notify(`Update ${event.job.state}`, event.job.state === 'done' ? 'success' : 'warning');
      }
    }
  });
  socket.addEventListener('close', () => {
    indicator.className = 'down';
    indicator.title = 'Not connected to the app: is it still running?';
    document.getElementById('connection-text').textContent = 'offline';
    setTimeout(() => connectEvents(Math.min(delay * 2, 15000)), delay);
  });
}

// ------------------------------------------------------------------ status bar

export function renderStatusDevices() {
  const devices = [...state.devices.values()];
  const online = devices.filter((d) => d.online).length;
  document.getElementById('status-devices').textContent =
    devices.length ? `${online}/${devices.length} online` : 'no devices';
}

export function renderActivity() {
  const job = [...state.jobs.values()].find((j) => ['running', 'paused'].includes(j.state));
  const element = document.getElementById('status-activity');
  let text = 'idle';
  if (job && job.state === 'paused') {
    text = 'update paused: check the first device';
  } else if (job) {
    const target = job.targets.find((t) => t.status === 'running');
    const done = job.targets.filter((t) => !['queued', 'running'].includes(t.status)).length;
    text = `updating ${done + 1}/${job.targets.length}` + (target ? ` · ${target.label} · ${target.step}` : '') +
      (target && target.step === 'uploading' ? ` ${Math.round(target.progress * 100)}%` : '');
  } else if (state.build && state.build.result === 'running') {
    text = `building ${state.build.profile}`;
  } else if (state.setup && state.setup.state === 'running') {
    text = state.setup.name;
  }
  if (state.console && state.console.open) text += ` · console ${state.console.port}`;
  element.textContent = text;
  element.parentElement.classList.toggle('busy', text !== 'idle');  // the whole segment, with its icon
}

export function renderClock() {
  document.getElementById('status-clock').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ status

export async function loadStatus() {
  state.status = await api('GET', '/api/status', undefined, { quiet: true });
  document.getElementById('demo-banner').classList.toggle('d-none', !state.status.demo);
  document.title = state.status.demo ? 'Demo · HA-CoAP Fleet Manager' : 'HA-CoAP Fleet Manager';
  return state.status;
}
