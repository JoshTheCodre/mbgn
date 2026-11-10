import { THEMES } from '../shared/themes.js';

export { THEMES };

// The visitor's own pick. The admin's default is remembered apart from it, so a returning visitor
// gets the right colours before the page has even asked the server (see pages/_document.jsx).
const KEY = 'mbgn-theme';
const DEFAULT_KEY = 'mbgn-theme-default';

const read = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* the choice just won't be remembered */ }
};

// The visitor's pick if it is still on offer, otherwise the admin's default.
export function currentTheme(themes) {
  const offered = themes?.offered ?? THEMES.map((t) => t.id);
  const fallback = themes?.default ?? read(DEFAULT_KEY) ?? 'owambe';
  const saved = read(KEY);
  return offered.includes(saved) ? saved : fallback;
}

// `remember` is for a visitor choosing a theme. Showing the default never pins it, so a later change
// of default by an admin still reaches them.
export function applyTheme(id, { remember = false } = {}) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bar);
  if (remember) write(KEY, theme.id);
}

export const rememberDefaultTheme = (id) => write(DEFAULT_KEY, id);
