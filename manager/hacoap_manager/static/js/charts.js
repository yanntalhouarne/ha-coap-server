// Small line charts in SVG: point at one to read its values, drag across it to zoom into a
// period, and lay other plants' lines over it to compare.

import { h, svg, when } from './core.js';

// ------------------------------------------------------------------ charts

const clean = (points) => points.filter((p) => p.v !== null && p.v !== undefined).sort((a, b) => a.t - b.t);

// The point of sorted data nearest to time t
function nearest(data, t) {
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].t < t) lo = mid; else hi = mid;
  }
  return Math.abs(data[lo].t - t) <= Math.abs(data[hi].t - t) ? data[lo] : data[hi];
}

// A line chart: points [{t, v}], drawn in the theme's colours.
// - events [{t, kind, text}]: markers across it (an update, a pump run, a parent change).
// - overlays [{name, points, color}]: other lines to compare, drawn dashed.
// - range [t0, t1]: the period shown (else all of it); onZoom(t0, t1): called when a period is
//   dragged across the chart.
export function lineChart(title, points, { unit = '', min = null, max = null, color = 'var(--t-brand)', step = false, events = [],
  overlays = [], range = null, onZoom = null, name = '' } = {}) {
  const all = [{ name, color, data: clean(points) },
    ...overlays.map((o) => ({ name: o.name, color: o.color, data: clean(o.points), dashed: true }))];
  const primary = all[0].data;
  const head = h('div', { class: 'chart-head' }, h('span', {}, title),
    primary.length ? h('b', {}, `${primary[primary.length - 1].v}${unit}`) : null);
  const firsts = all.filter((s) => s.data.length).map((s) => s.data[0].t);
  const lasts = all.filter((s) => s.data.length).map((s) => s.data[s.data.length - 1].t);
  if (primary.length < 2 && !overlays.some((o) => clean(o.points).length >= 2)) {
    return h('div', { class: 'chart' }, head, h('div', { class: 'chart-empty' },
      'Not enough readings yet. One is stored at each refresh (every 15 minutes while the app runs).'));
  }
  const W = 600, H = 110, padX = 34, padY = 10;
  // The time axis runs to the latest event too (a pump run since the last reading), not before the first reading.
  let [t0, t1] = range || [Math.min(...firsts), Math.max(...lasts)];
  if (!range) t1 = Math.max(t1, ...events.map((e) => e.t).filter((t) => t >= t0));
  const series = all.map((s) => ({ ...s, data: s.data.filter((p) => p.t >= t0 && p.t <= t1) }));
  const values = series.flatMap((s) => s.data.map((p) => p.v));
  if (!values.length) {  // zoomed into a period without readings
    return h('div', { class: 'chart' }, head, h('div', { class: 'chart-empty' }, 'No readings in this period.'));
  }
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const x = (t) => padX + ((t - t0) / ((t1 - t0) || 1)) * (W - padX - 4);
  const y = (v) => H - padY - ((v - lo) / span) * (H - 2 * padY);
  const pathOf = (data) => data.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.v)}` : step ? `H${x(p.t)}V${y(p.v)}` : `L${x(p.t)},${y(p.v)}`)).join('');
  const lines = series.filter((s) => s.data.length > 1).map((s, i) => svg('path', { d: pathOf(s.data),
    style: `stroke: ${s.color}; fill: none`, 'stroke-width': i === 0 && !s.dashed ? 2 : 1.6, 'vector-effect': 'non-scaling-stroke',
    'stroke-dasharray': s.dashed ? '5 4' : null }));
  const main = series[0].data;
  const area = main.length > 1 ? svg('path', { d: `${pathOf(main)}L${x(main[main.length - 1].t)},${H - padY}L${x(main[0].t)},${H - padY}Z`,
    style: `fill: ${color}; opacity: .12` }) : null;
  const short = t1 - t0 < 2 * 86400;
  const date = (t) => new Date(t * 1000).toLocaleString([], short ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' });
  const percent = (t) => ((x(t) - padX) / (W - padX)) * 100;
  // Markers are HTML over the drawing (placed in %), so they keep their shape and show a tooltip.
  const markers = events.filter((e) => e.t >= t0 && e.t <= t1).map((e) =>
    h('div', { class: `chart-event event-${e.kind}`, style: `left: ${percent(e.t)}%`, title: `${when(e.t)}: ${e.text}` }));

  // Pointing: a line across, and the values at that time. Dragging: a period to zoom into.
  const cross = h('div', { class: 'chart-cross d-none' });
  const tip = h('div', { class: 'chart-tip d-none' });
  const band = h('div', { class: 'chart-band d-none' });
  const hit = h('div', { class: `chart-hit${onZoom ? ' zoomable' : ''}`, title: onZoom ? 'Drag across to zoom into a period' : null });
  const timeAt = (event) => {
    const rect = hit.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return { frac, t: t0 + frac * (t1 - t0) };
  };
  let dragFrom = null;
  hit.addEventListener('pointermove', (event) => {
    const { frac, t } = timeAt(event);
    cross.classList.remove('d-none');
    cross.style.left = `${frac * 100}%`;
    const rows = series.filter((s) => s.data.length).map((s) => {
      const p = nearest(s.data, t);
      return h('div', {}, h('i', { style: `background: ${s.color}` }), s.name ? `${s.name}: ` : '', h('b', {}, `${p.v}${unit}`));
    });
    tip.replaceChildren(h('div', { class: 'chart-tip-time' }, when(t)), ...rows);
    tip.classList.remove('d-none');
    tip.style.left = frac > 0.6 ? '' : `calc(${frac * 100}% + 10px)`;
    tip.style.right = frac > 0.6 ? `calc(${(1 - frac) * 100}% + 10px)` : '';
    if (dragFrom !== null) {
      band.classList.remove('d-none');
      band.style.left = `${Math.min(dragFrom, frac) * 100}%`;
      band.style.width = `${Math.abs(frac - dragFrom) * 100}%`;
    }
  });
  hit.addEventListener('pointerleave', () => { cross.classList.add('d-none'); tip.classList.add('d-none'); });
  if (onZoom) {
    hit.addEventListener('pointerdown', (event) => {
      dragFrom = timeAt(event).frac;
      hit.setPointerCapture(event.pointerId);
    });
    hit.addEventListener('pointerup', (event) => {
      const to = timeAt(event).frac, from = dragFrom;
      dragFrom = null;
      band.classList.add('d-none');
      if (from !== null && Math.abs(to - from) > 0.02) {
        onZoom(t0 + Math.min(from, to) * (t1 - t0), t0 + Math.max(from, to) * (t1 - t0));
      }
    });
  }
  // The drawing stretches to its box; the labels stay as text beside it, so they don't stretch.
  return h('div', { class: 'chart' }, head,
    h('div', { class: 'chart-body' },
      h('div', { class: 'chart-y' }, h('span', {}, `${hi}${unit}`), h('span', {}, `${lo}${unit}`)),
      h('div', { class: 'chart-plot' },
        svg('svg', { viewBox: `${padX} 0 ${W - padX} ${H}`, preserveAspectRatio: 'none' },
          svg('line', { x1: padX, y1: y(hi), x2: W, y2: y(hi), class: 'grid' }),
          svg('line', { x1: padX, y1: y(lo), x2: W, y2: y(lo), class: 'grid' }),
          area, ...lines),
        hit, band, cross, markers, tip)),
    h('div', { class: 'chart-x' }, h('span', {}, date(t0)), h('span', {}, date(t1))));
}
