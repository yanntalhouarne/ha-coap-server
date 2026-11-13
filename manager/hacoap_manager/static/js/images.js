// The Images tab: the image library and the builds on this computer.

import { api, busy, h, notify, shortHash, state, when } from './core.js';
import { builds } from './builds.js';
import { signerClass, signerShort } from './updates.js';

// ------------------------------------------------------------------ images

export async function loadImages() {
  state.images = await api('GET', '/api/images');
  document.querySelector('#images-table tbody').replaceChildren(...state.images.map((image) => h('tr', {},
    h('td', {}, `v${image.version}`, image.release ? h('span', { class: 'badge text-bg-primary ms-2' }, '★ release') : null),
    h('td', { class: 'mono small', title: image.hash }, shortHash(image.hash)),
    h('td', { class: 'mono small' }, image.git_commit || '–'),
    h('td', { class: `small text-nowrap ${signerClass[image.signer] || ''}`, title: image.detail }, signerShort[image.signer] || image.signer),
    h('td', {}, `${Math.round(image.size / 1024)} KB`), h('td', { class: 'small' }, when(image.added)),
    h('td', { class: 'small' }, image.notes || image.filename),
    h('td', { class: 'text-nowrap' }, h('button', { class: 'btn btn-sm btn-outline-primary me-1', onclick: async () => {
      await api('POST', '/api/release', { image_hash: image.release ? null : image.hash }).catch(() => {});
      loadImages();
    } }, image.release ? 'Unset release' : 'Make release'), h('button', { class: 'btn btn-sm btn-outline-danger', onclick: async () => {
      if (!confirm('Delete this image from the library?')) return;
      await api('DELETE', `/api/images/${image.hash}`).catch(() => {});
      loadImages();
    } }, 'Delete')))));
}

export async function loadBuilds() {
  const container = document.getElementById('builds');
  const builds = await api('GET', '/api/build-outputs');
  if (!builds.length) {
    container.replaceChildren(h('p', { class: 'text-body-secondary mb-0' },
      'None found. Builds show here when the app runs from the ha-coap-server folder after a build (scripts/build).'));
    return;
  }
  container.replaceChildren(h('table', { class: 'table table-sm mb-0' }, h('tbody', {}, builds.map((b) => h('tr', {},
    h('td', {}, b.variant), h('td', {}, `v${b.version}`), h('td', { class: 'mono small' }, shortHash(b.hash)),
    h('td', { class: `small text-nowrap ${signerClass[b.signer] || ''}`, title: b.detail }, signerShort[b.signer] || b.signer),
    h('td', { class: 'small' }, when(b.modified)),
    h('td', {}, b.in_library ? h('span', { class: 'text-body-secondary small' }, 'in library') :
      h('button', { class: 'btn btn-sm btn-outline-primary', onclick: async (e) => busy(e.target, async () => {
        await api('POST', `/api/build-outputs/${encodeURIComponent(b.variant)}/import`);
        loadImages(); loadBuilds();
      }) }, 'Add')))))));
}

document.getElementById('upload-image').addEventListener('click', (event) => busy(event.target, async () => {
  const file = document.getElementById('image-file').files[0];
  if (!file) return notify('Choose a file first', 'warning');
  const notes = document.getElementById('image-notes').value;
  const query = new URLSearchParams({ filename: file.name, notes });
  const image = await api('POST', `/api/images?${query}`, file);
  notify(`Added image v${image.version}`, 'success', 3000);
  document.getElementById('image-file').value = '';
  document.getElementById('image-notes').value = '';
  loadImages(); loadBuilds();
}));
