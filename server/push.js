import webpush from 'web-push';
import { HttpError, asyncRouter } from './auth.js';
import { getSetting, nowIso } from './db.js';

// Phone and browser notifications (Web Push), for admins (new applications) and contestants
// (everything in their dashboard's notifications). Each person turns them on once per device.
// The keys that sign them are made on first use and kept in settings, so there's nothing to set up.

async function keys(db) {
  if (!await getSetting(db, 'push_keys')) {
    // Two servers starting at once keep whichever pair was saved first.
    await db.prepare("INSERT INTO settings (key, value) VALUES ('push_keys', ?) ON CONFLICT (key) DO NOTHING")
      .run(JSON.stringify(webpush.generateVAPIDKeys()));
  }
  return JSON.parse(await getSetting(db, 'push_keys'));
}

// To these people's devices. Devices that have gone (uninstalled, turned off) are forgotten.
export async function pushTo(ctx, userIds, { title, body, url = '/' }) {
  const { db, config } = ctx;
  if (!userIds.length) return 0;
  const devices = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ANY(?)').all([...new Set(userIds)]);
  if (!devices.length) return 0;
  const { publicKey, privateKey } = await keys(db);
  const subject = config.publicUrl.startsWith('https://') ? config.publicUrl : 'mailto:admin@localhost';
  const options = { vapidDetails: { subject, publicKey, privateKey }, TTL: 86400 };
  const payload = JSON.stringify({ title, body, url });
  const send = config.pushSend ?? webpush.sendNotification;
  let sent = 0;
  for (let i = 0; i < devices.length; i += 20) {
    await Promise.all(devices.slice(i, i + 20).map(async (d) => {
      try {
        await send({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, options);
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(d.id);
        else console.error('Push notification failed:', err.statusCode ?? err.message);
      }
    }));
  }
  return sent;
}

export async function pushAdmins(ctx, message) {
  const admins = await ctx.db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  return pushTo(ctx, admins.map((a) => a.id), message);
}

export function pushRouter(ctx) {
  const { db } = ctx;
  const router = asyncRouter();

  router.get('/key', async (_req, res) => res.json({ publicKey: (await keys(db)).publicKey }));

  // This device, for whoever is signed in on it.
  router.post('/subscribe', async (req, res) => {
    if (!req.user) throw new HttpError(401, 'Sign in first.');
    const { endpoint, keys: k } = req.body ?? {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1000
      || typeof k?.p256dh !== 'string' || typeof k?.auth !== 'string') throw new HttpError(400, 'That is not a notification subscription.');
    await db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`)
      .run(req.user.id, endpoint, k.p256dh.slice(0, 200), k.auth.slice(0, 100), nowIso());
    res.json({ ok: true });
  });

  router.post('/unsubscribe', async (req, res) => {
    if (typeof req.body?.endpoint === 'string') await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(req.body.endpoint);
    res.json({ ok: true });
  });

  return router;
}
