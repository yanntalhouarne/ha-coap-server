// Care tasks (fertilize, repot, rotate the pot…): each comes back so many days after it's done.
// On a plant's page (its Care section) and in the Today list when they're due.

import { api, busy, h, linkMode, linkView, notify, svg } from './core.js';
import { devicePath } from './devices.js';

// What people usually do, offered while typing
const IDEAS = ['Fertilize', 'Repot', 'Rotate the pot', 'Clean the leaves', 'Prune', 'Check for pests', 'Mist the leaves',
  'Flush the soil'];
const DAY_MS = 86400000;
const icon = (name) => svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#i-${name}` }));

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Days from today to the day it's due, in this browser's time: 0 today, below 0 late
export function dueIn(task, now = Date.now()) {
  return Math.round((startOfDay(task.due * 1000) - startOfDay(now)) / DAY_MS);
}
export const isDue = (task, now) => dueIn(task, now) <= 0;

export function dueText(task, now) {
  const days = dueIn(task, now);
  if (days === 0) return 'due today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'due since yesterday';
  return days < 0 ? `due ${-days} days ago` : `in ${days} days`;
}

export function everyText(task) {
  const n = task.every_days;
  if (n === 1) return 'every day';
  if (n % 7 === 0) return n === 7 ? 'every week' : `every ${n / 7} weeks`;
  return `every ${n} days`;
}

// Done: it comes back its number of days from now
export async function careDone(task, button) {
  await busy(button, () => api('POST', `/api/care/${task.id}/done`));
  const next = new Date(Date.now() + task.every_days * DAY_MS).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  notify(`Done. Next time: ${next}`, 'success', 3000);
}

// The plant page's Care section: its tasks with Done, and from the full app adding and removing
// them. Nothing from a dashboard link when it has none.
export function careSection(device, tasks, onChange) {
  const full = !linkMode();
  const view = linkView();
  if (!tasks.length && !full) return null;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const what = h('input', { class: 'form-control form-control-sm', type: 'text', maxlength: 60, list: 'care-ideas',
    placeholder: 'Fertilize', 'aria-label': 'What to do', required: true });
  const every = h('input', { class: 'form-control form-control-sm care-every', type: 'number', min: 1, max: 365, value: 14,
    'aria-label': 'Every how many days', required: true });
  const first = h('input', { class: 'form-control form-control-sm w-auto', type: 'date', value: iso(new Date()), 'aria-label': 'First on' });
  const form = h('form', { class: 'care-form d-none' },
    h('datalist', { id: 'care-ideas' }, IDEAS.map((idea) => h('option', { value: idea }))),
    what,
    h('div', { class: 'd-flex flex-wrap align-items-center gap-2 small' }, 'every', every, 'days, first on', first),
    h('div', { class: 'd-flex gap-2' }, h('button', { class: 'btn btn-sm btn-primary', type: 'submit' }, 'Add'),
      h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => form.classList.add('d-none') }, 'Cancel')));
  form.onsubmit = async (event) => {
    event.preventDefault();
    const [y, m, d] = (first.value || iso(new Date())).split('-').map(Number);
    await busy(form.querySelector('[type=submit]'), () => api('POST', devicePath(device, '/care'),
      { what: what.value, every_days: every.value, due: new Date(y, m - 1, d).getTime() / 1000 }));
    onChange();
  };
  const add = full ? h('button', { class: 'btn btn-sm btn-link p-0 care-add', type: 'button', onclick: () => {
    form.classList.remove('d-none');
    what.focus();
  } }, '+ Add a task') : null;
  return h('section', { class: 'care-card' },
    h('div', { class: 'care-head' }, h('span', {}, 'care'), add),
    tasks.length ? h('ul', { class: 'care-list' }, tasks.map((task) => h('li', { class: isDue(task) ? 'due' : '' },
      icon('sprout'),
      h('div', {}, h('b', {}, task.what), h('span', {}, `${everyText(task)} · ${dueText(task)}`)),
      view ? null : h('button', { class: `btn btn-sm ${isDue(task) ? 'btn-primary' : 'btn-outline-secondary'}`, type: 'button',
        onclick: async (e) => { await careDone(task, e.currentTarget); onChange(); } }, 'Done'),
      full ? h('button', { class: 'alert-dismiss', type: 'button', title: 'Remove', 'aria-label': `Remove ${task.what}`,
        onclick: async () => {
          if (!confirm(`Remove “${task.what}”?`)) return;
          await api('DELETE', `/api/care/${task.id}`);
          onChange();
        } }, icon('x')) : null)))
      : h('p', { class: 'small text-body-secondary mb-0' }, 'Fertilizing, repotting, turning the pot… Add what this plant needs now and then: it shows in the Today list when it’s due.'),
    full ? form : null);
}
