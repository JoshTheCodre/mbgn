import { waitUntil } from '@vercel/functions';
import { COUNTRY_IDS, DEFAULT_COUNTRY } from '../shared/countries.js';
import { createApp, createContext, runDueJobs } from './app.js';
import { loadConfig } from './config.js';
import { DEMO_ADMIN, seedDemoData } from './demo-data.js';

const JOB_CHECK_MS = 60000;

// One site per country (Nigeria on mbgn.com.ng, Ghana on its own domain), from this one codebase.
// Each has its own settings, its own tables in the shared database, and its own Express app. Each
// request goes to the country of the domain it came to; the admin's country switch can ask for the
// other one (the X-Country header, or ?_country= for the live updates stream).

const demo = () => process.env.DEMO_MODE === '1';
const configFor = (country) => loadConfig({ ...(demo() ? DEMO_ADMIN : {}), country });

async function startSite(country) {
  const config = configFor(country);
  const ctx = await createContext(config);
  ctx.background = (promise) => waitUntil(promise.catch((err) => console.error('Background work failed:', err.message)));
  // So the admin can be signed in to another country's site from this one.
  ctx.siteFor = async (other) => (await getSite(other)).ctx;
  if (demo()) await seedDemoData(ctx);
  return { ctx, app: createApp(ctx), lastJobCheck: 0 };
}

// One server per country per process. Kept on globalThis so hot reloads in development don't open
// a second one. A site starts on its first request; one that fails to start (a database still
// waking up, a missing setting) tries again next time, and never stops the other country's site.
function getSite(country) {
  globalThis.mbgnSites ??= new Map();
  const sites = globalThis.mbgnSites;
  if (!sites.has(country)) {
    sites.set(country, startSite(country).catch((err) => {
      sites.delete(country);
      throw err;
    }));
  }
  return sites.get(country);
}

// Which country each domain shows. Anything not listed is Nigeria.
let hostMap = null;
function countryOfHost(host = '') {
  if (!hostMap) {
    hostMap = new Map();
    for (const country of COUNTRY_IDS.filter((id) => id !== DEFAULT_COUNTRY)) {
      try {
        for (const h of configFor(country).hosts) hostMap.set(h, country);
      } catch (err) {
        console.error(`The ${country.toUpperCase()} site's settings are incomplete:`, err.message);
      }
    }
  }
  const name = String(host).toLowerCase();
  return hostMap.get(name) ?? hostMap.get(name.replace(/:\d+$/, '')) ?? DEFAULT_COUNTRY;
}

export function countryForRequest(req) {
  const asked = String(req.headers['x-country'] ?? new URL(req.url ?? '/', 'http://local').searchParams.get('_country') ?? '').toLowerCase();
  return COUNTRY_IDS.includes(asked) ? asked : countryOfHost(req.headers.host);
}

// For pages rendered on the server (link previews): the database and settings of the domain asked.
export async function getContext(req = null) {
  const country = req ? countryOfHost(req.headers?.host) : DEFAULT_COUNTRY;
  return (await getSite(country)).ctx;
}

// Serverless functions have no timers to rely on, so visits drive the periodic work, for every
// country that is running.
function runJobs() {
  for (const country of COUNTRY_IDS) {
    getSite(country).then((site) => {
      if (Date.now() - site.lastJobCheck <= JOB_CHECK_MS) return;
      site.lastJobCheck = Date.now();
      waitUntil(runDueJobs(site.ctx).catch((err) => console.error(`Background job failed (${country}):`, err.message)));
    }).catch(() => { /* that country's site isn't running; its own requests say why */ });
  }
}

export async function handleRequest(req, res) {
  const country = countryForRequest(req);
  let site;
  try {
    site = await getSite(country);
  } catch (err) {
    if (country === DEFAULT_COUNTRY) throw err;
    console.error(`The ${country.toUpperCase()} site could not start:`, err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'This site is being set up. Please try again later.' }));
    return undefined;
  }
  runJobs();
  return site.app(req, res);
}
