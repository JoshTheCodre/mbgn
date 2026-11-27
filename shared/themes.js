// The site's looks. The colours themselves live in client/styles.css under :root[data-theme].
// Admins choose which are offered to visitors, and which one new visitors see.
export const THEMES = [
  { id: 'owambe', name: 'Owambe', vibe: 'Party magenta, purple, gold', swatch: ['#d60f75', '#5f1aa0'], bar: '#1d0a2b' },
  { id: 'royal', name: 'Royal Gold', vibe: 'Navy and gold, premium', swatch: ['#14234d', '#d9b44a'], bar: '#fbf8f0' },
  { id: 'ankara', name: 'Ankara', vibe: 'Bold blue and marigold', swatch: ['#1d3fd8', '#ffc61a'], bar: '#fffdf6' },
  { id: 'naija', name: 'Naija Green', vibe: 'Flag green and lime', swatch: ['#008751', '#c6f432'], bar: '#f2fbf5' },
  { id: 'glam', name: 'Glam Pink', vibe: 'Hot pink, elegant serif', swatch: ['#cc1169', '#ffc2dc'], bar: '#fff0f6' },
  { id: 'midnight', name: 'Midnight', vibe: 'Dark violet', swatch: ['#24222e', '#7b4be8'], bar: '#24222e' },
  // Ghana's.
  { id: 'kente', name: 'Kente', vibe: 'Kente gold, green and red', swatch: ['#e0a526', '#0b6b3a'], bar: '#15100a' },
  { id: 'blackstar', name: 'Black Star', vibe: 'Flag red, gold and green', swatch: ['#ce1126', '#006b3f'], bar: '#04231a' },
  { id: 'goldcoast', name: 'Gold Coast', vibe: 'Cream and gold, green', swatch: ['#f2c230', '#006b3f'], bar: '#fdf7e9' },
];

export const THEME_IDS = THEMES.map((t) => t.id);
