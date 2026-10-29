// Colour themes (see themes.css): Tokyo Night unless the viewer picked another, remembered
// in this browser. Loaded in <head>, before the page is drawn, so it never flashes.
window.HACOAP_THEMES = [
  { id: 'tokyo-night', name: 'Tokyo Night', scheme: 'dark' },
  { id: 'catppuccin', name: 'Catppuccin', scheme: 'dark' },
  { id: 'gruvbox', name: 'Gruvbox', scheme: 'dark' },
  { id: 'nord', name: 'Nord', scheme: 'dark' },
  { id: 'everforest', name: 'Everforest', scheme: 'dark' },
  { id: 'kanagawa', name: 'Kanagawa', scheme: 'dark' },
  { id: 'osaka-jade', name: 'Osaka Jade', scheme: 'dark' },
  { id: 'ristretto', name: 'Ristretto', scheme: 'dark' },
  { id: 'matte-black', name: 'Matte Black', scheme: 'dark' },
  { id: 'rose-pine', name: 'Rosé Pine', scheme: 'light' },
  { id: 'flexoki-light', name: 'Flexoki Light', scheme: 'light' },
  { id: 'white', name: 'White', scheme: 'light' },
];

// 'auto' follows the computer's light or dark setting: Tokyo Night by dark, White by light.
window.HACOAP_AUTO = { id: 'auto', name: 'System', dark: 'tokyo-night', light: 'white' };
const systemDark = () => !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;

window.hacoapApplyTheme = function (id) {
  const auto = id === 'auto';
  const wanted = auto ? (systemDark() ? window.HACOAP_AUTO.dark : window.HACOAP_AUTO.light) : id;
  const theme = window.HACOAP_THEMES.find((t) => t.id === wanted) || window.HACOAP_THEMES[0];
  document.documentElement.setAttribute('data-theme', theme.id);
  document.documentElement.setAttribute('data-bs-theme', theme.scheme);
  document.documentElement.setAttribute('data-theme-choice', auto ? 'auto' : theme.id);
  return auto ? { ...theme, id: 'auto', name: `System · ${theme.name}` } : theme;
};

// With 'auto', switch when the computer does (and tell the page, which redraws what it draws itself)
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.getAttribute('data-theme-choice') !== 'auto') return;
    window.hacoapApplyTheme('auto');
    window.dispatchEvent(new Event('hacoap-theme'));
  });
}

(function () {
  let saved = null;
  try {
    saved = localStorage.getItem('hacoap-theme');
  } catch (error) { /* storage unavailable: the default */ }
  // Earlier versions stored 'dark' or 'light'
  if (saved === 'dark') saved = 'tokyo-night';
  if (saved === 'light') saved = 'white';
  // ?theme=<id> in the address picks one too (for a link, or a screenshot)
  const asked = new URLSearchParams(location.search).get('theme');
  window.hacoapApplyTheme(asked || saved);
})();
