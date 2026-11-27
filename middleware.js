import { NextResponse } from 'next/server';
import { COUNTRY_IDS, DEFAULT_COUNTRY } from './shared/countries.js';

// The pages are the same for every country; what crawlers and link previews read first (the title,
// description, app name) isn't. On another country's domain, pages are served from that country's
// copy of the page shell (pages/site-<country>/), with its own head tags, and the app manifest from
// manifest-<country>.webmanifest. The address in the browser doesn't change.

function countryOfHost(host) {
  for (const id of COUNTRY_IDS.filter((c) => c !== DEFAULT_COUNTRY)) {
    const own = (name) => process.env[`${name}_${id.toUpperCase()}`];
    const hosts = [`${id}.localhost`, ...(own('SITE_HOSTS') ?? '').split(',')];
    try {
      if (own('PUBLIC_URL')) hosts.push(new URL(own('PUBLIC_URL')).host);
    } catch { /* a malformed address is reported by the server */ }
    if (hosts.map((h) => h.trim().toLowerCase()).filter(Boolean).some((h) => h === host || h === host.replace(/:\d+$/, ''))) return id;
  }
  return DEFAULT_COUNTRY;
}

export function middleware(req) {
  const country = countryOfHost((req.headers.get('host') ?? '').toLowerCase());
  if (country === DEFAULT_COUNTRY) return NextResponse.next();
  const url = req.nextUrl.clone();
  if (url.pathname === '/manifest.webmanifest') {
    url.pathname = `/manifest-${country}.webmanifest`;
  } else {
    url.pathname = `/site-${country}${url.pathname === '/' ? '' : url.pathname}`;
  }
  return NextResponse.rewrite(url);
}

// Only the site's own pages and the manifest: not the API, a contestant's voting link (it reads the
// domain itself; her vote page /c/CODE/vote is an ordinary page), scripts, photos or other files.
export const config = {
  matcher: ['/', '/manifest.webmanifest', '/((?!api/|_next/|c/[^/]+/?$|photos/|icons/|pay/sim|site-|.*\\.[a-z0-9]+$).*)'],
};
