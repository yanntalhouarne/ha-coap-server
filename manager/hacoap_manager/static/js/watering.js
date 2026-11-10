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

// What its rule does now, in words (from its details): kept for the live updates in between
const explained = { id: null, why: '' };

export function renderWatering(device, autowater) {
  const box = document.getElementById('device-watering');
  if (!box) return;
  if (autowater) Object.assign(explained, { id: device.device_id, why: autowater.why });
  // A live update while one of its forms is being filled in: only the tank's level
  if (box.dataset.id === device.device_id && box.contains(document.activeElement) && document.activeElement.matches('input, select')) {
    const level = box.querySelector('.tank-level');
    if (level) level.replaceWith(tankLevel(device));
    return;
  }
  box.dataset.id = device.device_id;
  box.replaceChildren(tankLevel(device), tankForm(device), h('hr'), ruleForm(device));
}

// Its automatic watering: when its soil is under its target, within limits
function ruleForm(device) {
  const rule = device.watering_rule || {};
  const target = device.water_target;
  const number = (name, value, attrs) => h('input', { class: 'form-control form-control-sm d-inline-block mx-1 rule-number',
    type: 'number', name, value: value ?? '', ...attrs });
  const on = h('input', { class: 'form-check-input', type: 'checkbox', id: 'rule-on', checked: !!rule.on });
  const seconds = h('select', { class: 'form-select form-select-sm d-inline-block w-auto mx-1', name: 'seconds', 'aria-label': 'For how long' },
    h('option', { value: '', selected: !rule.seconds }, device.pump_s ? `its run time (${device.pump_s} s)` : 'its run time'),
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('option', { value: n, selected: rule.seconds === n }, `${n} s`)));
  const maxPerDay = number('max_per_day', rule.max_per_day, { min: 1, max: 12, 'aria-label': 'Times a day, at most' });
  const fromHour = number('from_hour', rule.from_hour, { min: 0, max: 23, 'aria-label': 'From (hour)' });
  const toHour = number('to_hour', rule.to_hour, { min: 1, max: 24, 'aria-label': 'Until (hour)' });
  const wait = number('wait_h', rule.wait_h, { min: 0.5, max: 72, step: 0.5, 'aria-label': 'Hours apart, at least' });
  const why = explained.id === device.device_id ? explained.why : '';
  const form = h('form', { class: 'rule-form' },
    h('div', { class: 'fw-bold mb-1' }, 'Automatic watering'),
    h('div', { class: 'form-check' }, on, h('label', { class: 'form-check-label', for: 'rule-on' },
      target ? `Water it when its soil is under its target (${target} %)` : 'Water it when its soil is under its target (set one first, in About this device)')),
    h('div', { class: 'small mt-2 rule-line' }, 'At most', maxPerDay, 'times a day, between', fromHour, ':00 and', toHour,
      ':00, at least', wait, 'hours apart, for', seconds, '.'),
    why ? h('div', { class: `small mt-2 ${/^Paused/.test(why) ? 'text-warning' : 'text-body-secondary'}` }, `Now: ${why}.`) : null,
    h('div', { class: 'form-text' }, "Hours in this browser's time. It doesn't water a board that isn't answering, whose last " +
      "waterings didn't raise the soil, or whose tank is too low; each automatic watering shows in its timeline."),
    h('button', { class: 'btn btn-sm btn-primary mt-2', type: 'submit' }, 'Save'));
  form.onsubmit = async (event) => {
    event.preventDefault();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const watering = { on: on.checked, max_per_day: maxPerDay.value, from_hour: fromHour.value, to_hour: toHour.value,
      wait_h: wait.value, seconds: seconds.value, tz: zone, utc_offset_min: -new Date().getTimezoneOffset() };
    await api('PATCH', devicePath(device), { watering }).then(() => notify('Saved', 'success', 2000), () => {});
  };
  return form;
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
  const defaultFlow = (state.status && state.status.settings.pump_flow_ml_s) || (device.tank && device.tank.flow_ml_s) || null;
  const size = h('input', { class: 'form-control form-control-sm', type: 'number', min: 10, step: 'any', id: 'tank-size',
    value: device.tank_ml ?? '', placeholder: 'not tracked' });
  const flow = h('input', { class: 'form-control form-control-sm', type: 'number', min: 0.1, step: 'any', id: 'tank-flow',
    value: device.pump_ml_s ?? '', placeholder: defaultFlow ? `default: ${defaultFlow}` : 'default' });
  const seconds = device.pump_s || 1;  // not known yet: the run time it starts with
  const runTime = device.pump_s ? `its run time is ${device.pump_s} s` : 'for 1 s: set it under Controls first';
  const measured = h('input', { class: 'form-control form-control-sm', type: 'number', min: 1, step: 'any', style: 'width: 6rem',
    'aria-label': 'How much water came out (ml)', placeholder: 'ml' });
  const form = h('form', { class: 'row g-2' },
    h('div', { class: 'col-sm-6' }, h('label', { class: 'form-label', for: 'tank-size' }, 'Tank size (ml)'), size),
    h('div', { class: 'col-sm-6' }, h('label', { class: 'form-label', for: 'tank-flow' }, 'Pump flow (ml per second)'), flow),
    h('div', { class: 'col-12 small text-body-secondary' },
      `To measure its pump: put the tube in a measuring cup and run the pump once (${runTime}), then say how much came out: `,
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
