// Looks being trialled. The colours themselves live in styles.css under :root[data-theme].
export const THEMES = [
  { id: 'owambe', name: 'Owambe', vibe: 'Party magenta, purple, gold', swatch: ['#d60f75', '#5f1aa0'], bar: '#1d0a2b' },
  { id: 'royal', name: 'Royal Gold', vibe: 'Navy and gold, premium', swatch: ['#14234d', '#d9b44a'], bar: '#fbf8f0' },
  { id: 'ankara', name: 'Ankara', vibe: 'Bold blue and marigold', swatch: ['#1d3fd8', '#ffc61a'], bar: '#fffdf6' },
  { id: 'naija', name: 'Naija Green', vibe: 'Flag green and lime', swatch: ['#008751', '#c6f432'], bar: '#f2fbf5' },
  { id: 'glam', name: 'Glam Pink', vibe: 'Hot pink, elegant serif', swatch: ['#cc1169', '#ffc2dc'], bar: '#fff0f6' },
  { id: 'midnight', name: 'Midnight', vibe: 'The previous dark violet', swatch: ['#24222e', '#7b4be8'], bar: '#24222e' },
];

const KEY = 'mbgn-theme';
const DEFAULT_THEME = 'owambe';

export function currentTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === saved)) return saved;
  } catch { /* storage blocked: fall back to the default */ }
  return DEFAULT_THEME;
}

export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bar);
  try {
    localStorage.setItem(KEY, theme.id);
  } catch { /* the choice just won't be remembered */ }
}
