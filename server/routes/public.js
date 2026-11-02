import crypto from 'node:crypto';
import multer from 'multer';
import {
  HttpError, asyncRouter, endSession, hashPassword, rateLimit, requireUser, sessionUser, sha256, startSession, verifyPassword,
} from '../auth.js';
import {
  lastUpdated, movementBaseline, photoUrl, publicContestant, publicProfile, registrationState, votingState,
} from '../competition.js';
import { getSetting, nowIso, tx } from '../db.js';
import { handleWebhook } from '../payments.js';

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi',
  'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

const IMAGE_TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

// Vercel's edge answers repeat requests for up to 5 seconds, worldwide and without touching the
// database, and keeps answering while it fetches a fresh copy. None of these vary by visitor.
// Browsers must not join in, or they would show a stale answer right after a change.
const shortCache = (_req, res, next) => {
  res.set({
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Vercel-CDN-Cache-Control': 's-maxage=5, stale-while-revalidate=10',
  });
  next();
};

const clean = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value) => /^\+?[0-9 ()-]{7,20}$/.test(value);
// 0803... and +234803... are the same number.
const lastDigits = (value) => value.replace(/\D/g, '').slice(-10);

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'Choose a password of at least 8 characters.');
  }
}

// Accepts a full link or a bare handle and only ever stores an https URL for that platform.
export function socialLink(value, host) {
  const input = clean(value, 300);
  if (!input) return null;
  const label = { tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook' }[host];
  const handle = input.replace(/^@/, '');
  const url = /^https?:\/\//i.test(input) ? input : /\./.test(handle) && handle.includes('/') ? `https://${handle}` : null;
  if (!url) {
    if (!/^[\w.-]{1,60}$/.test(handle)) throw new HttpError(400, `That ${label} handle does not look right.`);
    return host === 'tiktok' ? `https://www.tiktok.com/@${handle}` : `https://www.${host}.com/${handle}`;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `That ${label} link does not look right.`);
  }
  if (!parsed.hostname.toLowerCase().endsWith(`${host}.com`)) throw new HttpError(400, `Please use a ${host}.com link for ${label}.`);
  parsed.protocol = 'https:';
  return parsed.toString();
}

export const normalizeCode = (value) => clean(value, 30).toUpperCase().replace(/\s+/g, '');

export function publicRouter(ctx) {
  const { db, config } = ctx;
  const router = asyncRouter();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  // Mobile carriers put many Nigerians behind one IP, so per-IP limits stay generous
  // and guessing is limited per person instead.
  const scaled = (max) => max * config.rateLimitScale;
  const resetLimit = rateLimit({ windowMs: 15 * 60000, max: scaled(100) });
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    max: scaled(10),
    key: (req) => `${req.ip}|${clean(req.body?.email, 200).toLowerCase()}`,
    message: 'Too many attempts. Please wait 15 minutes and try again.',
  });

  async function publicUser(user) {
    if (!user) return null;
    const contestant = await db.prepare('SELECT code, status, stage_name FROM contestants WHERE user_id = ?').get(user.id);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      contestant: contestant ?? null,
    };
  }

  // ---- Payment webhook (raw body, mounted before express.json in app.js) ----
  ctx.webhookHandler = async (req, res) => {
    const { accepted } = await handleWebhook(ctx, req.body, req.headers['x-paystack-signature']);
    res.status(accepted ? 200 : 401).json({ ok: accepted });
  };

  // ---- Live stream ----
  router.get('/stream', async (req, res) => {
    ctx.bus.connect(req, res, (await sessionUser(ctx, req))?.id ?? null);
  });

  // ---- Competition facts ----
  router.get('/competition', shortCache, async (_req, res) => {
    const [phase, registration, name, voting, startsAt, endsAt, votePrice, packages, resultsPublishedAt] = await Promise.all([
      getSetting(db, 'competition_phase'),
      registrationState(db),
      getSetting(db, 'competition_name'),
      votingState(db),
      getSetting(db, 'voting_starts_at'),
      getSetting(db, 'voting_ends_at'),
      getSetting(db, 'vote_price'),
      db.prepare('SELECT id, votes, price FROM packages WHERE active = 1 ORDER BY votes').all(),
      getSetting(db, 'results_published_at'),
    ]);
    res.json({
      phase,
      registration,
      name,
      voting,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      votePrice: Number(votePrice),
      packages,
      resultsPublishedAt: resultsPublishedAt || null,
      states: NIGERIAN_STATES,
      themePicker: !config.production,
    });
  });

  router.get('/leaderboard', shortCache, async (req, res) => {
    const q = clean(req.query.q, 60);
    const state = clean(req.query.state, 40);
    const category = clean(req.query.category, 40);
    const where = ["status = 'approved'"];
    const params = [];
    if (q) {
      where.push('(stage_name ILIKE ? OR code ILIKE ?)');
      params.push(`%${q}%`, `%${q.replace(/\s+/g, '')}%`);
    }
    if (state) { where.push('state = ?'); params.push(state); }
    if (category) { where.push('category = ?'); params.push(category); }
    const limit = Math.min(Number(req.query.limit) || 500, 500);
    const [rows, baseline, { total }, updatedAt, states, categories] = await Promise.all([
      db.prepare(`SELECT * FROM contestants WHERE ${where.join(' AND ')} ORDER BY position ASC LIMIT ?`).all(...params, limit),
      movementBaseline(db),
      db.prepare("SELECT COUNT(*) AS total FROM contestants WHERE status = 'approved'").get(),
      lastUpdated(db),
      db.prepare("SELECT DISTINCT state FROM contestants WHERE status = 'approved' ORDER BY state").all(),
      db.prepare("SELECT DISTINCT category FROM contestants WHERE status = 'approved' AND category IS NOT NULL ORDER BY category").all(),
    ]);
    res.json({
      updatedAt,
      total,
      rows: rows.map((row) => publicContestant(row, baseline)),
      filters: {
        states: states.map((r) => r.state),
        categories: categories.map((r) => r.category),
      },
    });
  });

  router.get('/contestants/:code', shortCache, async (req, res) => {
    const row = await db.prepare("SELECT * FROM contestants WHERE code = ? AND status = 'approved'").get(normalizeCode(req.params.code));
    if (!row) throw new HttpError(404, 'No active contestant has that code.');
    res.json(publicProfile(row, await movementBaseline(db)));
  });

  // Counts a visit that arrived through a contestant's shared voting link.
  router.post('/contestants/:code/visit', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
    const row = await db.prepare("SELECT id FROM contestants WHERE code = ? AND status = 'approved'").get(normalizeCode(req.params.code));
    if (row) {
      const source = ['whatsapp', 'tiktok', 'instagram', 'facebook', 'link'].includes(req.body?.source) ? req.body.source : 'link';
      await db.prepare(`INSERT INTO referral_visits (contestant_id, day, source, visits) VALUES (?, ?, ?, 1)
        ON CONFLICT (contestant_id, day, source) DO UPDATE SET visits = referral_visits.visits + 1`).run(row.id, nowIso().slice(0, 10), source);
    }
    res.json({ ok: true });
  });

  router.get('/activity', shortCache, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await db.prepare(`SELECT a.id, a.kind, a.message, a.amount, a.created_at, c.code, c.stage_name FROM activity a
      LEFT JOIN contestants c ON c.id = a.contestant_id
      WHERE a.hidden = 0 ORDER BY a.id DESC LIMIT ?`).all(limit);
    res.json(rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      code: r.code,
      amount: r.amount,
      name: r.stage_name,
      createdAt: r.created_at,
    })));
  });

  router.get('/results', shortCache, async (_req, res) => {
    const [rows, photos] = await Promise.all([
      db.prepare('SELECT * FROM results ORDER BY published_at DESC').all(),
      db.prepare("SELECT code, photo_file FROM contestants WHERE status = 'approved' AND photo_file IS NOT NULL").all(),
    ]);
    const photoOf = new Map(photos.map((p) => [p.code, p]));
    res.json(rows.map((r) => ({
      id: r.id,
      competition: r.competition,
      publishedAt: r.published_at,
      standings: JSON.parse(r.standings).map((entry) => {
        const contestant = entry.code ? photoOf.get(entry.code) : null;
        return { ...entry, photoUrl: contestant ? photoUrl(contestant) : null };
      }),
    })));
  });

  // ---- Contestant registration ----
  router.post('/contestants/register', rateLimit({ windowMs: 3600000, max: scaled(40) }), upload.single('photo'), async (req, res) => {
    if (!(await registrationState(db)).open) throw new HttpError(409, 'Registration has closed.');
    const b = req.body ?? {};
    const fullName = clean(b.fullName, 100);
    const stageName = clean(b.stageName, 60) || fullName;
    const email = clean(b.email, 200).toLowerCase();
    const phone = clean(b.phone, 20);
    const whatsapp = clean(b.whatsapp, 20);
    const state = clean(b.state, 40);
    const location = clean(b.location, 100);
    const bio = clean(b.bio, 600);

    if (fullName.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (!validPhone(phone)) throw new HttpError(400, 'Please enter a valid phone number.');
    if (!validPhone(whatsapp)) throw new HttpError(400, 'Please enter a valid WhatsApp number.');
    if (!NIGERIAN_STATES.includes(state)) throw new HttpError(400, 'Please choose your state.');
    if (location.length < 2) throw new HttpError(400, 'Please enter your town or city.');
    if (bio.length < 20) throw new HttpError(400, 'Please write a short biography of at least 20 characters.');
    const tiktok = socialLink(b.tiktok, 'tiktok');
    const instagram = socialLink(b.instagram, 'instagram');
    const facebook = socialLink(b.facebook, 'facebook');

    if (!req.file) throw new HttpError(400, 'Please add a profile photograph.');
    const type = IMAGE_TYPES.find((t) => t.test(req.file.buffer));
    if (!type) throw new HttpError(400, 'The photograph must be a JPG, PNG or WebP image.');

    const alreadyJoined = () => new HttpError(409, 'You have already joined with this email address. Open your dashboard instead.');
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw alreadyJoined();

    const photoFile = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    await ctx.photos.put(photoFile, req.file.buffer, type.mime);

    const userId = await tx(db, async () => {
      const at = nowIso();
      const { lastInsertRowid: uid } = await db.prepare(`INSERT INTO users (email, name, phone, role, created_at)
        VALUES (?, ?, ?, 'contestant', ?) RETURNING id`).run(email, fullName, phone, at);
      await db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio,
        photo_file, tiktok, instagram, facebook, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, fullName, stageName, email, phone, whatsapp, state, location, bio, photoFile, tiktok, instagram, facebook, at);
      return uid;
    }).catch((err) => {
      // The same email submitted twice at once.
      throw err.code === '23505' ? alreadyJoined() : err;
    });

    await ctx.mailer.send({
      to: email,
      subject: 'We received your MBGN application',
      text: `Hello ${stageName},\n\nYour application is now with our review team. We will email you as soon as a decision is made.`,
    });
    ctx.bus.publish('admin', { type: 'registration' });

    // Joining is what identifies a contestant: this browser is recognised from now on.
    await startSession(ctx, res, userId);
    res.status(201).json({ ok: true });
  });

  // On a new device, the details given when joining bring back the dashboard. It is read-only.
  router.post('/contestants/recognise', loginLimit, async (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const whatsapp = lastDigits(clean(req.body?.whatsapp, 30));
    const row = await db.prepare('SELECT user_id, whatsapp FROM contestants WHERE email = ?').get(email);
    if (!row || whatsapp.length < 7 || lastDigits(row.whatsapp) !== whatsapp) {
      throw new HttpError(401, 'Those details do not match anyone who has joined.');
    }
    await startSession(ctx, res, row.user_id);
    res.json({ user: await publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });
  });

  // ---- Who this browser is, and the private admin login ----
  router.get('/auth/me', async (req, res) => res.json({ user: await publicUser(req.user) }));

  router.post('/auth/login', loginLimit, async (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const password = String(req.body?.password ?? '').slice(0, 200);
    const user = await db.prepare("SELECT * FROM users WHERE email = ? AND role = 'admin'").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'That email and password do not match.');
    }
    await startSession(ctx, res, user.id);
    res.json({ user: await publicUser(user) });
  });

  router.post('/auth/logout', requireUser, async (req, res) => {
    await endSession(ctx, req, res);
    ctx.bus.disconnectUser(req.user.id);
    res.json({ ok: true });
  });

  router.post('/auth/forgot', resetLimit, async (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const user = await db.prepare("SELECT id FROM users WHERE email = ? AND role = 'admin'").get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + 3600000).toISOString();
      await db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, expires);
      await ctx.mailer.send({
        to: email,
        subject: 'Reset your MBGN password',
        text: `Use this link within one hour to choose a new password:\n\n${config.publicUrl}/reset/${token}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
    // Same answer either way, so this cannot be used to discover who has an account.
    res.json({ ok: true });
  });

  router.post('/auth/reset', resetLimit, async (req, res) => {
    checkPassword(req.body?.password);
    const hash = sha256(String(req.body?.token ?? ''));
    const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, nowIso());
    if (!row) throw new HttpError(400, 'This reset link has expired. Please request a new one.');
    await tx(db, async () => {
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), row.user_id);
      await db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(nowIso(), hash);
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
    res.json({ ok: true });
  });

  return router;
}

// Photos of unapproved contestants are visible only to their owner and to admins.
export function photoHandler(ctx) {
  return async (req, res) => {
    const file = req.params.file;
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(file)) throw new HttpError(404, 'Not found.');
    const row = await ctx.db.prepare('SELECT status, user_id FROM contestants WHERE photo_file = ?').get(file);
    if (!row) throw new HttpError(404, 'Not found.');
    const viewer = await sessionUser(ctx, req);
    const allowed = row.status === 'approved' || viewer?.role === 'admin' || viewer?.id === row.user_id;
    if (!allowed) throw new HttpError(404, 'Not found.');
    const photo = await ctx.photos.get(file);
    if (!photo) throw new HttpError(404, 'Not found.');
    res.set({
      'Cache-Control': row.status === 'approved' ? 'public, max-age=86400, s-maxage=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.type(file.split('.').pop());
    res.send(photo);
  };
}
