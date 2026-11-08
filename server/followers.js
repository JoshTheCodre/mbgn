import { getSetting, nowIso, setSetting } from './db.js';

export const PLATFORMS = ['instagram', 'tiktok', 'facebook'];

const handleOf = (link) => new URL(link).pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') ?? '';

// None of the three networks lets a site read other people's counts, and they block plain requests,
// so data services do it. Each has a free plan. They are tried in this order: when one has no
// answer or has run out of credits, the next takes over, and checking by hand comes last.
const get = (path, params) => ({ method: 'GET', path: `${path}?${new URLSearchParams(params)}` });
// Apify starts a small cloud job for each lookup, so it is the slowest and goes last.
const apify = (actor, input) => ({ method: 'POST', path: `/v2/acts/${actor}/run-sync-get-dataset-items?timeout=40&memory=512`, body: input });

export const PROVIDERS = [
  {
    name: 'scrapecreators',
    label: 'ScrapeCreators',
    env: 'SCRAPECREATORS_API_KEY',
    baseUrl: 'https://api.scrapecreators.com',
    headers: (key) => ({ 'x-api-key': key }),
    requests: {
      instagram: (link) => get('/v1/instagram/profile', { handle: handleOf(link), trim: 'true' }),
      tiktok: (link) => get('/v1/tiktok/profile', { handle: handleOf(link) }),
      facebook: (link) => get('/v1/facebook/profile', { url: link }),
    },
    count: (body) => body?.data?.user?.edge_followed_by?.count ?? body?.stats?.followerCount ?? body?.followerCount,
  },
  {
    name: 'socialcrawl',
    label: 'SocialCrawl',
    env: 'SOCIALCRAWL_API_KEY',
    baseUrl: 'https://www.socialcrawl.dev',
    headers: (key) => ({ 'x-api-key': key }),
    requests: {
      instagram: (link) => get('/v1/instagram/profile', { handle: handleOf(link) }),
      tiktok: (link) => get('/v1/tiktok/profile', { handle: handleOf(link) }),
    },
    count: (body) => body?.data?.author?.followers,
  },
  {
    name: 'sociavault',
    label: 'SociaVault',
    env: 'SOCIAVAULT_API_KEY',
    baseUrl: 'https://api.sociavault.com',
    headers: (key) => ({ 'X-API-Key': key }),
    requests: {
      instagram: (link) => get('/v1/scrape/instagram/profile', { handle: handleOf(link) }),
      tiktok: (link) => get('/v1/scrape/tiktok/profile', { handle: handleOf(link) }),
    },
    count: (body) => body?.data?.follower_count ?? body?.data?.followerCount,
  },
  {
    name: 'hikerapi',
    label: 'HikerAPI',
    env: 'HIKERAPI_KEY',
    baseUrl: 'https://api.hikerapi.com',
    headers: (key) => ({ 'x-access-key': key }),
    requests: {
      instagram: (link) => get('/v2/user/by/username', { username: handleOf(link) }),
    },
    count: (body) => body?.follower_count ?? body?.user?.follower_count,
  },
  {
    name: 'apify',
    label: 'Apify',
    env: 'APIFY_TOKEN',
    baseUrl: 'https://api.apify.com',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    timeoutMs: 50000,
    requests: {
      instagram: (link) => apify('apify~instagram-profile-scraper', { usernames: [handleOf(link)] }),
      tiktok: (link) => apify('clockworks~tiktok-profile-scraper', { profiles: [handleOf(link)], resultsPerPage: 1 }),
      facebook: (link) => apify('apify~facebook-pages-scraper', { startUrls: [{ url: link }] }),
    },
    count: (body) => body?.[0]?.followersCount ?? body?.[0]?.authorMeta?.fans ?? body?.[0]?.followers,
  },
];

// Services rename fields now and then. Looks for a follower count anywhere near the top of the
// answer, nearest first, so a small change does not stop the check.
const COUNT_KEYS = /^(followers?_?count|followers|fans|fan_?count)$/i;
export function findFollowers(body) {
  let level = [body];
  for (let depth = 0; depth < 5 && level.length; depth += 1) {
    const next = [];
    for (const node of level) {
      if (!node || typeof node !== 'object') continue;
      const entries = Array.isArray(node) ? node.slice(0, 1).map((v) => [null, v]) : Object.entries(node);
      for (const [key, value] of entries) {
        if (key && COUNT_KEYS.test(key)) {
          const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
          if (Number.isInteger(n) && n >= 0) return n;
          if (Number.isInteger(value?.count)) return value.count;
        }
        if (key === 'edge_followed_by' && Number.isInteger(value?.count)) return value.count;
        if (value && typeof value === 'object') next.push(value);
      }
    }
    level = next;
  }
  return undefined;
}

const unavailable = { status: 'unavailable', followers: null };
const missing = { status: 'missing', followers: null };
// Out of credits, or a key that stopped working: skip that service for a while.
const SPENT = [401, 402, 403, 429];
const PAUSE_MS = 6 * 3600000;
// A count read recently is reused, so someone trying again does not spend more free credits.
const KEEP_FOUND_MS = 24 * 3600000;
const KEEP_MISSING_MS = 3600000;

async function ask(provider, key, platform, link) {
  const req = provider.requests[platform](link);
  const started = Date.now();
  const note = (status, detail, extra = {}) => ({ status, detail, ms: Date.now() - started, ...extra });
  try {
    const res = await fetch(`${provider.baseUrl}${req.path}`, {
      method: req.method,
      headers: { ...provider.headers(key), ...(req.body ? { 'Content-Type': 'application/json' } : {}) },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(provider.timeoutMs ?? 15000),
    });
    if (res.status === 404) return note('missing', 'Account not found');
    if (SPENT.includes(res.status)) return note('spent', `HTTP ${res.status}: out of credits or the key was refused`);
    if (!res.ok) return note('unavailable', `HTTP ${res.status}`);
    const body = await res.json();
    const followers = provider.count(body) ?? findFollowers(body);
    const credits = Number.isFinite(body?.credits_remaining) ? body.credits_remaining : null;
    // A private page or an unexpected answer: the next service, or a person, can look.
    return Number.isInteger(followers)
      ? note('found', null, { followers, credits })
      : note('unavailable', 'No follower count in the answer', { credits });
  } catch (err) {
    return note('unavailable', err.name === 'TimeoutError' ? 'Took too long' : err.message);
  }
}

// For testing without any service. A handle ending in _ and a number has that many followers:
// @ada_500 fails and @ada_1200 passes. Others have enough, unless named notfound or offline.
function testLookup(platform, link) {
  const handle = (platform === 'facebook' ? new URL(link).pathname : handleOf(link)).toLowerCase();
  if (handle.includes('notfound')) return missing;
  if (handle.includes('offline')) return unavailable;
  const digits = handle.match(/_(\d+)\/?$/);
  return { status: 'found', followers: digits ? Number(digits[1]) : 1000 + handle.length * 137 };
}

// `test` invents counts, so it never runs in production. With no service set up there, every
// application goes to the admins to check by hand, as it does when an admin chooses that.
export function createFollowerChecker(config, db = null) {
  const keys = config.followerKeys ?? {};
  // One entry per key, so a second key for the same service is tried, and paused, on its own.
  const providers = PROVIDERS.flatMap((p) => [keys[p.name] ?? []].flat().filter(Boolean).map((key, i) => ({
    ...p,
    service: p.name,
    name: i ? `${p.name}_${i + 1}` : p.name,
    label: i ? `${p.label} (key ${i + 1})` : p.label,
    env: i ? `${p.env}_${i + 1}` : p.env,
    key,
    baseUrl: config.followerBaseUrls?.[p.name] ?? p.baseUrl,
  })));
  const mode = providers.length ? 'live' : config.production ? 'manual' : 'test';
  const accountKey = (platform, link) => (platform === 'facebook' ? link.toLowerCase().replace(/\/$/, '') : handleOf(link).toLowerCase());

  const pausedUntil = async (name) => (db ? await getSetting(db, `follower_pause_${name}`) : '');
  const record = async (platform, link, source, result) => {
    if (!db) return;
    await db.prepare('INSERT INTO follower_lookups (platform, account, source, status, followers, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(platform, accountKey(platform, link), source, result.status, result.followers ?? null, result.detail ?? null, nowIso());
    if (result.status === 'spent') await setSetting(db, `follower_pause_${source}`, new Date(Date.now() + PAUSE_MS).toISOString());
    if (result.credits !== null && result.credits !== undefined) await setSetting(db, `follower_credits_${source}`, result.credits);
  };

  // Asks each service in turn until one knows. `fresh` skips the saved answers, for the admin's test.
  async function lookupAccount(platform, link, { fresh = false } = {}) {
    if (mode === 'test') return { ...testLookup(platform, link), source: 'test', attempts: [] };
    if (db && !fresh) {
      const saved = await db.prepare(`SELECT status, followers, source FROM follower_lookups
        WHERE platform = ? AND account = ? AND ((status = 'found' AND checked_at > ?) OR (status = 'missing' AND checked_at > ?))
        ORDER BY id DESC LIMIT 1`).get(platform, accountKey(platform, link), new Date(Date.now() - KEEP_FOUND_MS).toISOString(), new Date(Date.now() - KEEP_MISSING_MS).toISOString());
      if (saved) return { status: saved.status, followers: saved.followers, source: saved.source, saved: true, attempts: [] };
    }
    const attempts = [];
    for (const provider of providers.filter((p) => p.requests[platform])) {
      const until = await pausedUntil(provider.name);
      if (until && new Date(until) > new Date()) {
        attempts.push({ provider: provider.name, status: 'skipped', detail: `Paused until ${until}` });
        continue;
      }
      const result = await ask(provider, provider.key, platform, link);
      attempts.push({ provider: provider.name, ...result });
      await record(platform, link, provider.name, result);
      if (result.status === 'found' || result.status === 'missing') {
        return { status: result.status, followers: result.followers ?? null, source: provider.name, attempts };
      }
    }
    return { ...unavailable, source: null, attempts };
  }

  return {
    mode,
    providers,
    lookupAccount,
    async check(links, minimum) {
      const byHand = db && await getSetting(db, 'follower_check_mode') === 'manual';
      const given = PLATFORMS.filter((platform) => links[platform]);
      // One account at a time, stopping at the first with enough followers, so the others spend no credits.
      const results = [];
      for (const platform of given) {
        if (results.some((r) => r.status === 'found' && r.followers >= minimum)) {
          results.push({ platform, status: 'skipped', followers: null });
        } else if (byHand || mode === 'manual') {
          results.push({ platform, ...unavailable });
        } else {
          const { status, followers, source } = await lookupAccount(platform, links[platform]);
          results.push({ platform, status, followers, source });
        }
      }
      const passed = results.some((r) => r.status === 'found' && r.followers >= minimum);
      // Never fail someone over a lookup that could not be finished.
      const outcome = passed ? 'passed' : results.some((r) => r.status === 'unavailable') ? 'review' : 'failed';
      return { outcome, results };
    },
  };
}
