export const PLATFORMS = ['instagram', 'tiktok', 'facebook'];

const handleOf = (link) => new URL(link).pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') ?? '';

// None of the three networks lets a site read other people's counts, so a data provider does it.
const READERS = {
  instagram: {
    path: '/v1/instagram/profile',
    params: (link) => ({ handle: handleOf(link), trim: 'true' }),
    count: (body) => body?.data?.user?.edge_followed_by?.count,
  },
  tiktok: {
    path: '/v1/tiktok/profile',
    params: (link) => ({ handle: handleOf(link) }),
    count: (body) => body?.stats?.followerCount,
  },
  facebook: {
    path: '/v1/facebook/profile',
    params: (link) => ({ url: link }),
    count: (body) => body?.followerCount,
  },
};

const unavailable = { status: 'unavailable', followers: null };
const missing = { status: 'missing', followers: null };

async function liveLookup(settings, platform, link) {
  const reader = READERS[platform];
  try {
    const res = await fetch(`${settings.baseUrl}${reader.path}?${new URLSearchParams(reader.params(link))}`, {
      headers: { 'x-api-key': settings.apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return missing;
    if (!res.ok) {
      console.error(`Follower lookup failed on ${platform}: HTTP ${res.status}`);
      return unavailable;
    }
    const followers = reader.count(await res.json());
    // A private page or a changed response: a person can still look at it.
    return Number.isInteger(followers) ? { status: 'found', followers } : unavailable;
  } catch (err) {
    console.error(`Follower lookup failed on ${platform}:`, err.message);
    return unavailable;
  }
}

// For testing without a provider. A handle ending in _ and a number has that many followers:
// @ada_500 fails and @ada_1200 passes. Others have enough, unless named notfound or offline.
function testLookup(platform, link) {
  const handle = (platform === 'facebook' ? new URL(link).pathname : handleOf(link)).toLowerCase();
  if (handle.includes('notfound')) return missing;
  if (handle.includes('offline')) return unavailable;
  const digits = handle.match(/_(\d+)\/?$/);
  return { status: 'found', followers: digits ? Number(digits[1]) : 1000 + handle.length * 137 };
}

// `test` invents counts, so it never runs in production. With no provider there, every
// application goes to the admins to check by hand.
export function createFollowerChecker(config) {
  const mode = config.followers ? 'live' : config.production ? 'manual' : 'test';
  const lookup = {
    live: (platform, link) => liveLookup(config.followers, platform, link),
    test: testLookup,
    manual: () => unavailable,
  }[mode];

  return {
    mode,
    async check(links, minimum) {
      const given = PLATFORMS.filter((platform) => links[platform]);
      const results = await Promise.all(given.map(async (platform) => ({ platform, ...(await lookup(platform, links[platform])) })));
      const passed = results.some((r) => r.status === 'found' && r.followers >= minimum);
      // Never fail someone over a lookup that could not be finished.
      const outcome = passed ? 'passed' : results.some((r) => r.status === 'unavailable') ? 'review' : 'failed';
      return { outcome, results };
    },
  };
}
