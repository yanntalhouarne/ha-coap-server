// Colour mode: dark unless the viewer chose light (remembered in this browser). Loaded in
// <head>, before the page is drawn, so it never flashes the other mode.
(function () {
  let mode = 'dark';
  try {
    if (localStorage.getItem('hacoap-theme') === 'light') mode = 'light';
  } catch (error) { /* storage unavailable: stay dark */ }
  document.documentElement.setAttribute('data-bs-theme', mode);
})();
