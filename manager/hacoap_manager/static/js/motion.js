// Motion that says what just happened on a board: values counting to a new reading, a pulse
// when a board answers, buttons that wait for a sleepy board, cards sliding to their new
// place, the pump running. None of it with "reduce motion" set in the OS (the end state shows
// at once).

import { h, svg } from './core.js';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ values that change

// The last value shown for each key ("hero:<id>:soil", "tile:online"...), to animate a change
const shown = new Map();

// The value shown before for 'key' if it differs from 'value' (and remembers 'value'), else null.
export function changedFrom(key, value) {
  const before = shown.get(key);
  shown.set(key, value);
  return before !== undefined && before !== null && value !== null && value !== undefined && before !== value ? before : null;
}

// Shows 'value' in 'el', counting to it from the value shown before under 'key', with a flash.
// 'format' makes the text from a number. Text that isn't a number is just shown.
export function countTo(el, key, value, format = String) {
  const before = changedFrom(key, value);
  el.textContent = value === null || value === undefined ? '–' : format(value);
  if (before === null || typeof value !== 'number' || typeof before !== 'number') return el;
  flash(el);
  if (reducedMotion()) return el;
  const start = performance.now(), length = 700;
  const step = (now) => {
    const k = Math.min(1, (now - start) / length);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = format(Math.round(before + (value - before) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = format(before);
  requestAnimationFrame(step);
  return el;
}

// A short highlight on an element whose value just changed
export function flash(el) {
  el.classList.remove('just-changed');
  void el.offsetWidth; // restart the animation
  el.classList.add('just-changed');
  setTimeout(() => el.classList.remove('just-changed'), 1500);
}

// ------------------------------------------------------------------ a board answered

// A ring around every element shown for this board ([data-board]): its card, its row, its page's top.
export function pulse(deviceId) {
  for (const el of document.querySelectorAll(`[data-board="${CSS.escape(deviceId)}"]`)) {
    el.classList.remove('answered');
    void el.offsetWidth;
    el.classList.add('answered');
    setTimeout(() => el.classList.remove('answered'), 1300);
  }
}

// Runs 'work' (a request to a sleepy board) with the button saying it waits for the board: a
// ring that fills over the board's poll period (it answers at its next poll). When it answers,
// the button shows a check and the board's elements pulse. Returns what 'work' returns, or
// undefined after an error (shown by api()).
export async function waitForBoard(button, work, deviceId, pollMs = 3000) {
  const content = [...button.childNodes];
  const width = button.offsetWidth;
  button.disabled = true;
  button.classList.add('waiting');
  button.style.setProperty('--poll', `${pollMs}ms`);
  if (width) button.style.minWidth = `${width}px`;
  button.replaceChildren(svg('svg', { class: 'wait-ring', viewBox: '-8 -8 16 16', 'aria-hidden': 'true' },
    svg('circle', { r: 6, class: 'wait-track' }), svg('circle', { r: 6, class: 'wait-fill', transform: 'rotate(-90)' })),
  h('span', {}, 'waiting for the board…'));
  let result, ok = false;
  try {
    result = await work();
    ok = true;
  } catch (error) {
    result = undefined;
  }
  button.classList.remove('waiting');
  if (ok) {
    if (deviceId) pulse(deviceId);
    button.classList.add('answered-button');
    button.replaceChildren(svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: '#i-check' })), ' answered');
    await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 600 : 1100));
    button.classList.remove('answered-button');
  }
  button.replaceChildren(...content);
  button.style.minWidth = '';
  button.disabled = false;
  return result;
}

// ------------------------------------------------------------------ cards that slide

// Re-renders the children of 'container' (with 'render'), sliding each child that has a
// [data-id] from where it was to where it is now, and fading in the new ones.
export function slide(container, render) {
  const before = new Map([...container.querySelectorAll(':scope > [data-id]')]
    .map((el) => [el.dataset.id, el.getBoundingClientRect()]));
  render();
  if (reducedMotion() || !before.size || container.offsetParent === null) return;
  for (const el of container.querySelectorAll(':scope > [data-id]')) {
    const old = before.get(el.dataset.id);
    if (!old) {
      el.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }
}

// ------------------------------------------------------------------ the pump

// The boards whose pump the app started, and when it stops (ms)
export const pumping = new Map();

// Shows the pump running on every element of this board ([data-board]) for 'seconds': water
// drops over its photo, a filling soil gauge, and the seconds left.
export function startPumping(deviceId, seconds) {
  pumping.set(deviceId, Date.now() + seconds * 1000);
  showPumping();
}

export function isPumping(deviceId) {
  return (pumping.get(deviceId) || 0) > Date.now();
}

let pumpTimer = null;

export function showPumping() {
  for (const [id, until] of pumping) if (until <= Date.now()) pumping.delete(id);
  for (const el of document.querySelectorAll('[data-board]')) {
    const id = el.dataset.board;
    const on = isPumping(id);
    el.classList.toggle('pumping', on);
    const left = el.querySelector(':scope .pump-left');
    if (on) {
      const text = `watering · ${Math.ceil((pumping.get(id) - Date.now()) / 1000)} s`;
      if (left) left.textContent = text;
      else {
        const photo = el.querySelector('.card-photo, .hero-photo');
        if (photo) photo.append(h('span', { class: 'pump-overlay', 'aria-hidden': 'true' },
          h('i'), h('i'), h('i'), h('i'), h('i'), h('span', { class: 'pump-left' }, text)));
      }
    } else {
      el.querySelector('.pump-overlay')?.remove();
    }
  }
  clearTimeout(pumpTimer);
  if (pumping.size) pumpTimer = setTimeout(showPumping, 250);
}
