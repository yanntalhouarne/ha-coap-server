// The Charts tab: one reading of every board on a single chart, to compare them. Point at a
// board in the legend to bring its line forward, click it to hide or show it, drag across the
// chart to zoom into a period.

import { api, h, svg } from './core.js';
import { lineChart } from './charts.js';

const METRICS = [
  { key: 'soil_moisture', label: 'soil', title: 'Soil moisture', unit: ' %', min: 0, max: 100 },
  { key: 'battery', label: 'battery', title: 'Battery', unit: ' %', min: 0, max: 100 },
  { key: 'air_humidity', label: 'air humidity', title: 'Air humidity', unit: ' %', min: 0, max: 100 },
  { key: 'temperature', label: 'temperature', title: 'Temperature', unit: ' °C' },
  { key: 'link_margin', label: 'signal', title: 'Link to its parent (margin, from the border router)', unit: ' dB', min: 0 },
];

// Each board keeps its colour while the page is open: by its place in the list of every board
const PALETTE = ['var(--t-cyan)', 'var(--t-green)', 'var(--t-yellow)', 'var(--t-magenta)', 'var(--t-orange)',
  'var(--t-blue)', 'var(--t-red)', 'var(--t-brand)', 'var(--t-text-secondary)'];

const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (error) { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* not remembered */ } };

const graph = {
  metric: remembered('hacoap-graph-metric', 'soil_moisture'),
  days: Number(remembered('hacoap-graph-days', '7')),
  group: null,
  hidden: new Set(),
  range: null,
  series: [],
};

export async function loadGraph() {
  renderControls();
  const metric = METRICS.find((m) => m.key === graph.metric) || METRICS[0];
  document.getElementById('graph-chart').replaceChildren(h('div', { class: 'skeleton graph-skeleton' }));
  graph.series = await api('GET', `/api/graph?metric=${metric.key}&days=${graph.days}`, undefined, { quiet: true }).catch(() => []);
  renderGraph();
}

function renderControls() {
  document.getElementById('graph-metrics').replaceChildren(...METRICS.map((m) => h('button', { type: 'button',
    class: m.key === graph.metric ? 'active' : null, onclick: () => {
      graph.metric = m.key;
      graph.range = null;
      remember('hacoap-graph-metric', m.key);
      loadGraph().catch(() => {});
    } }, m.label)));
  const days = document.getElementById('graph-days');
  days.value = String(graph.days);
}

const colorOf = (index) => PALETTE[index % PALETTE.length];

function renderGraph() {
  const metric = METRICS.find((m) => m.key === graph.metric) || METRICS[0];
  const all = [...graph.series].sort((a, b) => a.name.localeCompare(b.name)).map((s, i) => ({
    ...s, color: colorOf(i), dashed: i >= PALETTE.length,
    points: s.points.map(([t, v]) => ({ t, v })),
    tags: (s.tags || '').split(',').filter(Boolean),
  }));
  // Groups (tags), as filter chips
  const tags = [...new Set(all.flatMap((s) => s.tags))].sort();
  if (graph.group && !tags.includes(graph.group)) graph.group = null;
  document.getElementById('graph-groups').replaceChildren(...(tags.length ? [
    h('span', { class: 'small text-body-secondary me-1' }, 'groups:'),
    ...[null, ...tags].map((tag) => h('button', { type: 'button',
      class: `btn btn-sm ${graph.group === tag ? 'btn-primary' : 'btn-outline-secondary'}`,
      onclick: () => { graph.group = tag; renderGraph(); } }, tag || 'all'))] : []));

  const inGroup = all.filter((s) => !graph.group || s.tags.includes(graph.group));
  const shown = inGroup.filter((s) => !graph.hidden.has(s.device_id));
  document.getElementById('graph-zoom-reset').classList.toggle('d-none', !graph.range);
  const chart = lineChart(metric.title, [], {
    series: shown.map((s) => ({ name: s.name, points: s.points, color: s.color, dashed: s.dashed })),
    unit: metric.unit, min: metric.min ?? null, max: metric.max ?? null, tall: true, range: graph.range,
    onZoom: (t0, t1) => { graph.range = [t0, t1]; renderGraph(); },
  });
  const box = document.getElementById('graph-chart');
  box.replaceChildren(chart);

  // The legend: each board, with its latest value; point to highlight, click to hide or show
  const highlight = (name) => {
    chart.classList.toggle('highlighting', !!name);
    for (const line of chart.querySelectorAll('.chart-line')) line.classList.toggle('hot', line.dataset.name === name);
  };
  const latest = (s) => (s.points.length ? `${s.points[s.points.length - 1].v}${metric.unit}` : 'no readings');
  document.getElementById('graph-legend').replaceChildren(
    ...inGroup.map((s) => h('button', { type: 'button', class: `graph-key${graph.hidden.has(s.device_id) ? ' off' : ''}`,
      title: graph.hidden.has(s.device_id) ? 'Show its line' : 'Hide its line',
      onclick: () => {
        graph.hidden.has(s.device_id) ? graph.hidden.delete(s.device_id) : graph.hidden.add(s.device_id);
        renderGraph();
      },
      onmouseenter: () => highlight(s.name), onmouseleave: () => highlight(null),
      onfocus: () => highlight(s.name), onblur: () => highlight(null) },
    svg('svg', { class: 'graph-swatch', viewBox: '0 0 18 6', 'aria-hidden': 'true' },
      svg('line', { x1: 1, y1: 3, x2: 17, y2: 3, style: `stroke: ${s.color}`, 'stroke-dasharray': s.dashed ? '4 3' : null })),
    h('span', { class: 'graph-key-name' }, s.name), h('span', { class: 'graph-key-value' }, latest(s)))),
    inGroup.length ? h('span', { class: 'graph-legend-actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-link', onclick: () => {
        for (const s of inGroup) graph.hidden.delete(s.device_id);
        renderGraph();
      } }, 'all'),
      h('button', { type: 'button', class: 'btn btn-sm btn-link', onclick: () => {
        for (const s of inGroup) graph.hidden.add(s.device_id);
        renderGraph();
      } }, 'none')) : h('p', { class: 'text-body-secondary mb-0' }, 'No boards yet.'));
  document.getElementById('graph-note').textContent = shown.length
    ? `${shown.length} of ${inGroup.length} board${inGroup.length === 1 ? '' : 's'}` : '';
}

document.getElementById('graph-days').addEventListener('change', (event) => {
  graph.days = Number(event.target.value);
  graph.range = null;
  remember('hacoap-graph-days', event.target.value);
  loadGraph().catch(() => {});
});
document.getElementById('graph-zoom-reset').addEventListener('click', () => { graph.range = null; renderGraph(); });

