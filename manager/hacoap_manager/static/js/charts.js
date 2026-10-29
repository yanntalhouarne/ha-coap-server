// Small line charts in SVG.

import { h, svg, when } from './core.js';

// ------------------------------------------------------------------ charts

// A small line chart in SVG: points [{t, v}], drawn in the theme's colours. events [{t, kind,
// text}] are drawn as markers across it (an update, a pump run, a parent change).
export function lineChart(title, points, { unit = '', min = null, max = null, color = 'var(--t-brand)', step = false, events = [] } = {}) {
  const data = points.filter((p) => p.v !== null && p.v !== undefined);
  const head = h('div', { class: 'chart-head' }, h('span', {}, title),
    data.length ? h('b', {}, `${data[data.length - 1].v}${unit}`) : null);
  if (data.length < 2) {
    return h('div', { class: 'chart' }, head, h('div', { class: 'chart-empty' },
      'Not enough readings yet. One is stored at each refresh (every 15 minutes while the app runs).'));
  }
  const W = 600, H = 110, padX = 34, padY = 10;
  // The time axis runs to the latest event too (a pump run since the last reading), not before the first reading.
  const t0 = data[0].t, t1 = Math.max(data[data.length - 1].t, ...events.map((e) => e.t).filter((t) => t >= t0));
  const lo = min ?? Math.min(...data.map((p) => p.v)), hi = max ?? Math.max(...data.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (t) => padX + ((t - t0) / ((t1 - t0) || 1)) * (W - padX - 4);
  const y = (v) => H - padY - ((v - lo) / span) * (H - 2 * padY);
  let path = '';
  data.forEach((p, i) => {
    if (i === 0) path += `M${x(p.t)},${y(p.v)}`;
    else if (step) path += `H${x(p.t)}V${y(p.v)}`;
    else path += `L${x(p.t)},${y(p.v)}`;
  });
  const area = `${path}L${x(data[data.length - 1].t)},${H - padY}L${x(t0)},${H - padY}Z`;
  const date = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // Markers are HTML over the drawing (placed in %), so they keep their shape and show a tooltip.
  const markers = events.filter((e) => e.t >= t0 && e.t <= t1).map((e) =>
    h('div', { class: `chart-event event-${e.kind}`, style: `left: ${((x(e.t) - padX) / (W - padX)) * 100}%`,
      title: `${when(e.t)}: ${e.text}` }));
  // The drawing stretches to its box; the labels stay as text beside it, so they don't stretch.
  return h('div', { class: 'chart' }, head,
    h('div', { class: 'chart-body' },
      h('div', { class: 'chart-y' }, h('span', {}, `${hi}${unit}`), h('span', {}, `${lo}${unit}`)),
      h('div', { class: 'chart-plot' },
        svg('svg', { viewBox: `${padX} 0 ${W - padX} ${H}`, preserveAspectRatio: 'none' },
          svg('line', { x1: padX, y1: y(hi), x2: W, y2: y(hi), class: 'grid' }),
          svg('line', { x1: padX, y1: y(lo), x2: W, y2: y(lo), class: 'grid' }),
          svg('path', { d: area, style: `fill: ${color}; opacity: .12` }),
          svg('path', { d: path, style: `stroke: ${color}; fill: none`, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' })),
        markers)),
    h('div', { class: 'chart-x' }, h('span', {}, date(t0)), h('span', {}, date(t1))));
}
