// A board's watering, on its page (the Watering card): its water tank (its size, its pump's flow,
// how full it is, "I refilled it") and its automatic watering.

import { api, busy, h, notify, state } from './core.js';
import { devicePath } from './devices.js';

// "about 60 % full · 1200 ml left"
export function tankText(tank) {
  return `about ${tank.percent} % full · ${tank.left_ml} ml left`;
}

// Its water tank, as a bar, for the plant page and this card
export function tankBar(tank) {
  return h('div', { class: `soil-bar tank-bar${tank.low ? ' low' : ''}`, role: 'img', 'aria-label': `Water tank ${tankText(tank)}` },
    h('i', { style: `width: ${Math.max(0, Math.min(100, tank.percent))}%` }));
}

// "Refilled": its tank counts from full again
export async function refillTank(device, button) {
  await busy(button, () => api('POST', devicePath(device, '/tank/refilled')));
  notify('Its tank counts as full again', 'success', 2500);
}

export function renderWatering(device) {
  const box = document.getElementById('device-watering');
  if (!box) return;
  // A live update while its form is being filled in: only the tank's level
  if (box.dataset.id === device.device_id && box.contains(document.activeElement) && document.activeElement.matches('input, select')) {
    const level = box.querySelector('.tank-level');
    if (level) level.replaceWith(tankLevel(device));
    return;
  }
  box.dataset.id = device.device_id;
  box.replaceChildren(tankLevel(device), tankForm(device));
}

function tankLevel(device) {
  const tank = device.tank;
  if (!tank) {
    return h('p', { class: 'tank-level small text-body-secondary' },
      'Give its water tank\'s size to know how full it is: the app adds up the pump\'s runs since you last refilled it.');
  }
  const since = tank.filled ? new Date(tank.filled * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  return h('div', { class: 'tank-level mb-3' },
    h('div', { class: 'd-flex align-items-baseline gap-2 flex-wrap' },
      h('b', {}, `Water tank: ${tankText(tank)}`),
      h('span', { class: 'small text-body-secondary' },
        `${tank.runs} pump run${tank.runs === 1 ? '' : 's'}${since ? ` since it was refilled, ${since}` : ''}`)),
    tankBar(tank),
    device.watering_missed ? h('div', { class: 'small text-warning mb-1' },
      'Its soil didn\'t rise after its last waterings: is the tank empty, or the tube out of the pot?') : null,
    h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: (e) => refillTank(device, e.currentTarget) },
      'I refilled it'));
}

function tankForm(device) {
  const defaultFlow = state.status ? state.status.settings.pump_flow_ml_s : null;
  const size = h('input', { class: 'form-control form-control-sm', type: 'number', min: 10, step: 'any', id: 'tank-size',
    value: device.tank_ml ?? '', placeholder: 'not tracked' });
  const flow = h('input', { class: 'form-control form-control-sm', type: 'number', min: 0.1, step: 'any', id: 'tank-flow',
    value: device.pump_ml_s ?? '', placeholder: defaultFlow ? `default: ${defaultFlow}` : 'default' });
  const seconds = device.pump_s || 1;
  const measured = h('input', { class: 'form-control form-control-sm', type: 'number', min: 1, step: 'any', style: 'width: 6rem',
    'aria-label': 'How much water came out (ml)', placeholder: 'ml' });
  const form = h('form', { class: 'row g-2' },
    h('div', { class: 'col-sm-6' }, h('label', { class: 'form-label', for: 'tank-size' }, 'Tank size (ml)'), size),
    h('div', { class: 'col-sm-6' }, h('label', { class: 'form-label', for: 'tank-flow' }, 'Pump flow (ml per second)'), flow),
    h('div', { class: 'col-12 small text-body-secondary' },
      `To measure its pump: put the tube in a measuring cup and run the pump once (its run time is ${seconds} s), then say how much came out: `,
      h('span', { class: 'd-inline-flex gap-1 align-items-center' }, measured,
        h('button', { class: 'btn btn-sm btn-link p-0', type: 'button', onclick: () => {
          if (!(Number(measured.value) > 0)) return notify('Say how much came out, in ml', 'warning');
          flow.value = Math.round((Number(measured.value) / seconds) * 10) / 10;
        } }, 'work it out'))),
    h('div', { class: 'col-12' }, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Save')));
  form.onsubmit = async (event) => {
    event.preventDefault();
    await api('PATCH', devicePath(device), { tank_ml: size.value.trim(), pump_ml_s: flow.value.trim() }).then(
      () => notify('Saved', 'success', 2000), () => {});
  };
  return form;
}
