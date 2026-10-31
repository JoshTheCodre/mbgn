import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import {
  HttpError, endSession, hashPassword, rateLimit, requireUser, sessionUser, sha256, startSession, verifyPassword,
} from '../auth.js';
import {
  lastUpdated, movementBaseline, photoUrl, publicContestant, publicProfile, votingState,
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

// Finds this person's wallet, or quietly creates one, and remembers them in this browser.
export function openWallet(ctx, res, details) {
  const { db } = ctx;
  const email = clean(details?.email, 200).toLowerCase();
  const phone = clean(details?.phone, 20);
  if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!validPhone(phone)) throw new HttpError(400, 'Please enter a valid phone number.');

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    const contestant = db.prepare('SELECT whatsapp FROM contestants WHERE user_id = ?').get(existing.id);
    const matches = existing.role !== 'admin' && [existing.phone, contestant?.whatsapp]
      .some((known) => known && lastDigits(known) === lastDigits(phone));
    if (!matches) throw new HttpError(401, 'That phone number does not match the wallet for this email.');
    startSession(ctx, res, existing.id);
    return { user: existing, created: false };
  }
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO users (email, name, phone, role, created_at)
    VALUES (?, ?, ?, 'supporter', ?)`).run(email, email.split('@')[0], phone, nowIso());
  startSession(ctx, res, id);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), created: true };
}

export function publicRouter(ctx) {
  const { db, config } = ctx;
  const router = express.Router();
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

  function publicUser(user) {
    if (!user) return null;
    const contestant = db.prepare('SELECT code, status, stage_name FROM contestants WHERE user_id = ?').get(user.id);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      credits: user.credits,
      contestant: contestant ?? null,
    };
  }

  // ---- Payment webhook (raw body, mounted before express.json in app.js) ----
  ctx.webhookHandler = (req, res) => {
    const { accepted } = handleWebhook(ctx, req.body, req.headers['monnify-signature']);
    res.status(accepted ? 200 : 401).json({ ok: accepted });
  };

  // ---- Live stream ----
  router.get('/stream', (req, res) => {
    ctx.bus.connect(req, res, sessionUser(ctx, req)?.id ?? null);
  });

  // ---- Competition facts ----
  router.get('/competition', (_req, res) => {
    res.json({
      name: getSetting(db, 'competition_name'),
      voting: votingState(db),
      startsAt: getSetting(db, 'voting_starts_at') || null,
      endsAt: getSetting(db, 'voting_ends_at') || null,
      votePrice: Number(getSetting(db, 'vote_price')),
      packages: db.prepare('SELECT id, votes, price FROM packages WHERE active = 1 ORDER BY votes').all(),
      resultsPublishedAt: getSetting(db, 'results_published_at') || null,
      states: NIGERIAN_STATES,
      themePicker: !config.production,
    });
  });

  router.get('/leaderboard', (req, res) => {
    const q = clean(req.query.q, 60);
    const state = clean(req.query.state, 40);
    const category = clean(req.query.category, 40);
    const where = ["status = 'approved'"];
    const params = [];
    if (q) {
      where.push('(stage_name LIKE ? OR code LIKE ?)');
      params.push(`%${q}%`, `%${q.replace(/\s+/g, '')}%`);
    }
    if (state) { where.push('state = ?'); params.push(state); }
    if (category) { where.push('category = ?'); params.push(category); }
    const limit = Math.min(Number(req.query.limit) || 500, 500);
    const rows = db.prepare(`SELECT * FROM contestants WHERE ${where.join(' AND ')} ORDER BY position ASC LIMIT ?`).all(...params, limit);
    const baseline = movementBaseline(db);
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM contestants WHERE status = 'approved'").get();
    res.json({
      updatedAt: lastUpdated(db),
      total,
      rows: rows.map((row) => publicContestant(row, baseline)),
      filters: {
        states: db.prepare("SELECT DISTINCT state FROM contestants WHERE status = 'approved' ORDER BY state").all().map((r) => r.state),
        categories: db.prepare("SELECT DISTINCT category FROM contestants WHERE status = 'approved' AND category IS NOT NULL ORDER BY category").all().map((r) => r.category),
      },
    });
  });

  router.get('/contestants/:code', (req, res) => {
    const row = db.prepare("SELECT * FROM contestants WHERE code = ? AND status = 'approved'").get(normalizeCode(req.params.code));
    if (!row) throw new HttpError(404, 'No active contestant has that code.');
    res.json(publicProfile(row, movementBaseline(db)));
  });

  // Counts a visit that arrived through a contestant's shared voting link.
  router.post('/contestants/:code/visit', rateLimit({ windowMs: 60000, max: 30 }), (req, res) => {
    const row = db.prepare("SELECT id FROM contestants WHERE code = ? AND status = 'approved'").get(normalizeCode(req.params.code));
    if (row) {
      const source = ['whatsapp', 'tiktok', 'instagram', 'facebook', 'link'].includes(req.body?.source) ? req.body.source : 'link';
      db.prepare(`INSERT INTO referral_visits (contestant_id, day, source, visits) VALUES (?, ?, ?, 1)
        ON CONFLICT DO UPDATE SET visits = visits + 1`).run(row.id, nowIso().slice(0, 10), source);
    }
    res.json({ ok: true });
  });

  router.get('/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = db.prepare(`SELECT a.id, a.kind, a.message, a.amount, a.created_at, c.code, c.stage_name FROM activity a
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

  router.get('/results', (_req, res) => {
    const rows = db.prepare('SELECT * FROM results ORDER BY published_at DESC').all();
    const photoOf = db.prepare("SELECT photo_file FROM contestants WHERE code = ? AND status = 'approved'");
    res.json(rows.map((r) => ({
      id: r.id,
      competition: r.competition,
      publishedAt: r.published_at,
      standings: JSON.parse(r.standings).map((entry) => {
        const contestant = entry.code ? photoOf.get(entry.code) : null;
        return { ...entry, photoUrl: contestant?.photo_file ? photoUrl(contestant) : null };
      }),
    })));
  });

  // ---- Contestant registration ----
  router.post('/contestants/register', rateLimit({ windowMs: 3600000, max: scaled(40) }), upload.single('photo'), (req, res) => {
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

    // Someone with a wallet can still join the contest, and keeps their credits.
    const existing = db.prepare('SELECT id, role, phone FROM users WHERE email = ?').get(email);
    const fromWallet = existing?.role === 'supporter'
      && (req.user?.id === existing.id || lastDigits(existing.phone ?? '') === lastDigits(phone));
    if (existing && !fromWallet) {
      throw new HttpError(409, 'You have already joined with this email address. Open your dashboard instead.');
    }

    const photoFile = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    fs.mkdirSync(config.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(config.uploadDir, photoFile), req.file.buffer);

    const userId = tx(db, () => {
      const at = nowIso();
      let uid = existing?.id;
      if (uid) {
        db.prepare("UPDATE users SET name = ?, phone = ?, role = 'contestant' WHERE id = ?").run(fullName, phone, uid);
      } else {
        ({ lastInsertRowid: uid } = db.prepare(`INSERT INTO users (email, name, phone, role, created_at)
          VALUES (?, ?, ?, 'contestant', ?)`).run(email, fullName, phone, at));
      }
      db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio,
        photo_file, tiktok, instagram, facebook, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, fullName, stageName, email, phone, whatsapp, state, location, bio, photoFile, tiktok, instagram, facebook, at);
      return uid;
    });

    ctx.mailer.send({
      to: email,
      subject: 'We received your MBGN application',
      text: `Hello ${stageName},\n\nYour application is now with our review team. We will email you as soon as a decision is made.`,
    });
    ctx.bus.publish('admin', { type: 'registration' });

    // Joining is what identifies a contestant: this browser is recognised from now on.
    startSession(ctx, res, userId);
    res.status(201).json({ ok: true });
  });

  // On a new device, the details given when joining bring back the dashboard. It is read-only.
  router.post('/contestants/recognise', loginLimit, (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const whatsapp = lastDigits(clean(req.body?.whatsapp, 30));
    const row = db.prepare('SELECT user_id, whatsapp FROM contestants WHERE email = ?').get(email);
    if (!row || whatsapp.length < 7 || lastDigits(row.whatsapp) !== whatsapp) {
      throw new HttpError(401, 'Those details do not match anyone who has joined.');
    }
    startSession(ctx, res, row.user_id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });
  });

  // A wallet with no sign-in: the first time these details create it, and any later time,
  // on any device, the same details bring it back.
  router.post('/supporters/wallet', loginLimit, (req, res) => {
    const { user, created } = openWallet(ctx, res, req.body);
    res.status(created ? 201 : 200).json({ user: publicUser(user) });
  });

  // ---- Who this browser is, and the private admin login ----
  router.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

  router.post('/auth/login', loginLimit, (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const password = String(req.body?.password ?? '').slice(0, 200);
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'admin'").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'That email and password do not match.');
    }
    startSession(ctx, res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', requireUser, (req, res) => {
    endSession(ctx, req, res);
    ctx.bus.disconnectUser(req.user.id);
    res.json({ ok: true });
  });

  router.post('/auth/forgot', resetLimit, (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const user = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'admin'").get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + 3600000).toISOString();
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, expires);
      ctx.mailer.send({
        to: email,
        subject: 'Reset your MBGN password',
        text: `Use this link within one hour to choose a new password:\n\n${config.publicUrl}/reset/${token}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
    // Same answer either way, so this cannot be used to discover who has an account.
    res.json({ ok: true });
  });

  router.post('/auth/reset', resetLimit, (req, res) => {
    checkPassword(req.body?.password);
    const hash = sha256(String(req.body?.token ?? ''));
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, nowIso());
    if (!row) throw new HttpError(400, 'This reset link has expired. Please request a new one.');
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(nowIso(), hash);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
    res.json({ ok: true });
  });

  return router;
}

// Photos of unapproved contestants are visible only to their owner and to admins.
export function photoHandler(ctx) {
  return (req, res) => {
    const file = req.params.file;
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(file)) throw new HttpError(404, 'Not found.');
    const row = ctx.db.prepare('SELECT status, user_id FROM contestants WHERE photo_file = ?').get(file);
    if (!row) throw new HttpError(404, 'Not found.');
    const viewer = sessionUser(ctx, req);
    const allowed = row.status === 'approved' || viewer?.role === 'admin' || viewer?.id === row.user_id;
    if (!allowed) throw new HttpError(404, 'Not found.');
    res.set({
      'Cache-Control': row.status === 'approved' ? 'public, max-age=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.type(file.split('.').pop());
    res.sendFile(path.resolve(ctx.config.uploadDir, file));
  };
}
