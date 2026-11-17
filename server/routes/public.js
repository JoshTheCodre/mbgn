import crypto from 'node:crypto';
import multer from 'multer';
import {
  HttpError, asyncRouter, endSession, hashPassword, rateLimit, requireUser, sessionUser, sha256, startSession, verifyPassword,
} from '../auth.js';
import {
  lastUpdated, movementBaseline, photoUrl, publicContestant, publicProfile, registrationState, votingState,
} from '../competition.js';
import { getSetting, nowIso, tx } from '../db.js';
import { PLATFORMS } from '../followers.js';
import { approveContestant } from '../approval.js';
import { groupById } from '../groups.js';
import { pushAdmins } from '../push.js';
import { shareImage } from '../share.js';
import { queueRegistered, sendDueWhatsApp } from '../whatsapp.js';
import { handleWebhook } from '../payments.js';
import { closeRoundsIfDue, currentRound, roundView } from '../rounds.js';
import { startVotingIfDue } from '../stages.js';
import { THEME_IDS } from '../../shared/themes.js';

export const ENQUIRY_KINDS = ['Sponsorship', 'Partnership', 'Media and press', 'General enquiry'];

// The themes on offer, in the site's own order, and the default, which is always one of them.
export async function themeSettings(db) {
  const wanted = (await getSetting(db, 'themes_offered')).split(',');
  const offered = THEME_IDS.filter((id) => wanted.includes(id));
  const chosen = await getSetting(db, 'default_theme');
  const list = offered.length ? offered : [THEME_IDS[0]];
  return { offered: list, default: list.includes(chosen) ? chosen : list[0] };
}

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi',
  'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

export const IMAGE_TYPES = [
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

export const clean = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
export const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validPhone = (value) => /^\+?[0-9 ()-]{7,20}$/.test(value);
// 0803... and +234803... are the same number.
export const lastDigits = (value) => value.replace(/\D/g, '').slice(-10);
// The same comparison inside the database.
export const DIGITS_SQL = (column) => `RIGHT(regexp_replace(${column}, '\\D', '', 'g'), 10)`;

// Four digits is not much, so the obvious ones are refused and wrong guesses lock the account.
const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1212', '2580', '0123', '9876', '1122', '1004', '2000', '6969']);
export function checkPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new HttpError(400, 'Your PIN must be exactly 4 digits.');
  if (WEAK_PINS.has(pin)) throw new HttpError(400, 'That PIN is too easy to guess. Please choose another.');
}

// Someone else's number must not open a second account, or sign in to the wrong one.
export async function whatsappTaken(db, whatsapp, exceptId = 0) {
  return Boolean(await db.prepare(`SELECT 1 FROM contestants WHERE ${DIGITS_SQL('whatsapp')} = ? AND status <> 'rejected' AND id <> ?`)
    .get(lastDigits(whatsapp), exceptId));
}

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
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== `${host}.com` && !hostname.endsWith(`.${host}.com`)) throw new HttpError(400, `Please use a ${host}.com link for ${label}.`);
  parsed.protocol = 'https:';
  if (host === 'facebook') return parsed.toString();
  // Instagram and TikTok accounts are read by username, so a link to a post or a short link will not do.
  const first = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  const name = first.replace(/^@/, '');
  const isProfile = host === 'tiktok' ? first.startsWith('@') : !['p', 'reel', 'reels', 'stories', 'explore', 'tv'].includes(name.toLowerCase());
  if (!isProfile || !/^[\w.-]{1,60}$/.test(name)) throw new HttpError(400, `Please enter your ${label} username, like @yourname.`);
  return host === 'tiktok' ? `https://www.tiktok.com/@${name}` : `https://www.instagram.com/${name}`;
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
    // Every page asks for this, so it is where the end of a countdown or a round is noticed.
    await startVotingIfDue(ctx);
    await closeRoundsIfDue(ctx);
    const [phase, registration, name, voting, startsAt, endsAt, votePrice, packages, resultsPublishedAt, minFollowers, autoStart, contactPhone, contactEmail, round] = await Promise.all([
      getSetting(db, 'competition_phase'),
      registrationState(db),
      getSetting(db, 'competition_name'),
      votingState(db),
      getSetting(db, 'voting_starts_at'),
      getSetting(db, 'voting_ends_at'),
      getSetting(db, 'vote_price'),
      db.prepare('SELECT id, votes, price FROM packages WHERE active = 1 ORDER BY votes').all(),
      getSetting(db, 'results_published_at'),
      getSetting(db, 'min_followers'),
      getSetting(db, 'auto_start_voting'),
      getSetting(db, 'contact_phone'),
      getSetting(db, 'contact_email'),
      currentRound(db),
    ]);
    res.json({
      phase,
      registration,
      round: round ? roundView(round) : null,
      autoStartVoting: autoStart === '1',
      contact: { phone: contactPhone || null, email: contactEmail || null },
      minFollowers: Number(minFollowers),
      followerCheckIsTest: ctx.followers.mode === 'test',
      name,
      voting,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      votePrice: Number(votePrice),
      packages,
      resultsPublishedAt: resultsPublishedAt || null,
      // Winners only makes sense once there is a result, from this contest or an earlier one.
      hasResults: Boolean(await db.prepare('SELECT 1 FROM results LIMIT 1').get()),
      states: NIGERIAN_STATES,
      themes: await themeSettings(db),
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
    // Pages ask for more as people scroll through, up to every contestant there could be.
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
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
    const row = await db.prepare("SELECT * FROM contestants WHERE code = ? AND status IN ('approved', 'eliminated')").get(normalizeCode(req.params.code));
    if (!row) throw new HttpError(404, 'No active contestant has that code.');
    // Old voting links still say what happened, instead of "not found".
    if (row.status === 'eliminated') {
      const round = row.eliminated_round_id ? await db.prepare('SELECT name FROM rounds WHERE id = ?').get(row.eliminated_round_id) : null;
      throw new HttpError(410, `${row.stage_name} was eliminated${round ? ` at the end of ${round.name}` : ''}, so she can no longer receive votes.`);
    }
    res.json(publicProfile(row, await movementBaseline(db)));
  });

  // The picture in a voting link's preview (see share.js).
  router.get('/share/:code.jpg', async (req, res) => {
    const image = await shareImage(ctx, normalizeCode(req.params.code));
    if (!image) throw new HttpError(404, 'No picture for that code.');
    // Kept by Vercel's network too, so WhatsApp gets it at once instead of waiting for the server.
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400' }).send(image);
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
  // Generous, because many Nigerians share one mobile network address. Each still needs a new email,
  // a new WhatsApp number and its own social account.
  router.post('/contestants/register', rateLimit({ windowMs: 3600000, max: scaled(300) }), upload.single('photo'), async (req, res) => {
    if (!(await registrationState(db)).open) throw new HttpError(409, 'Registration has closed.');
    const b = req.body ?? {};
    const fullName = clean(b.fullName, 100);
    const stageName = clean(b.stageName, 60) || fullName;
    const email = clean(b.email, 200).toLowerCase();
    const phone = clean(b.phone, 20);
    const whatsapp = clean(b.whatsapp, 20);
    const state = clean(b.state, 40);
    const location = clean(b.location, 100);
    const bio = clean(b.bio, 2000);

    if (fullName.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (!validPhone(phone)) throw new HttpError(400, 'Please enter a valid phone number.');
    if (!validPhone(whatsapp)) throw new HttpError(400, 'Please enter a valid WhatsApp number.');
    if (!NIGERIAN_STATES.includes(state)) throw new HttpError(400, 'Please choose your state.');
    if (location.length < 2) throw new HttpError(400, 'Please enter your town or city.');
    if (bio.length < 20) throw new HttpError(400, 'Please write a short biography of at least 20 characters.');
    if (bio.length > 150) throw new HttpError(400, 'Please keep your biography to 150 characters or fewer.');
    checkPin(b.pin);
    // Using someone else's account means disqualification, and applicants say so before the check.
    if (b.ownAccount !== 'yes') throw new HttpError(400, 'Please confirm the social media account belongs to you.');
    const tiktok = socialLink(b.tiktok, 'tiktok');
    const instagram = socialLink(b.instagram, 'instagram');
    const facebook = socialLink(b.facebook, 'facebook');
    const links = { tiktok, instagram, facebook };
    const given = PLATFORMS.filter((platform) => links[platform]);
    if (given.length === 0) throw new HttpError(400, 'Please add at least one of your Instagram, TikTok or Facebook accounts.');

    if (!req.file) throw new HttpError(400, 'Please add a profile photograph.');
    const type = IMAGE_TYPES.find((t) => t.test(req.file.buffer));
    if (!type) throw new HttpError(400, 'The photograph must be a JPG, PNG or WebP image.');

    const alreadyJoined = () => new HttpError(409, 'You have already joined with this email address. Open your dashboard instead.');
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw alreadyJoined();
    if (await whatsappTaken(db, whatsapp)) throw new HttpError(409, 'That WhatsApp number is already registered. Log in with it and your PIN instead.');

    // Someone else's popular account should not get a second person through.
    for (const platform of given) {
      const taken = await db.prepare(`SELECT 1 FROM contestants WHERE LOWER(${platform}) = LOWER(?) AND status <> 'rejected'`).get(links[platform]);
      if (taken) throw new HttpError(409, `That ${platform === 'tiktok' ? 'TikTok' : platform === 'instagram' ? 'Instagram' : 'Facebook'} account is already part of another application.`);
    }

    // Every application is kept, pass or not: one below the follower minimum waits as pending
    // (verification 'failed') for an admin to approve or reject by hand.
    const minFollowers = Number(await getSetting(db, 'min_followers'));
    const { outcome, results } = await ctx.followers.check(links, minFollowers);

    const photoFile = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    await ctx.photos.put(photoFile, req.file.buffer, type.mime);

    const { userId, contestantId } = await tx(db, async () => {
      const at = nowIso();
      const { lastInsertRowid: uid } = await db.prepare(`INSERT INTO users (email, name, phone, role, created_at)
        VALUES (?, ?, ?, 'contestant', ?) RETURNING id`).run(email, fullName, phone, at);
      const { lastInsertRowid: contestantId } = await db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio,
        photo_file, tiktok, instagram, facebook, verification, follower_results, pin_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .run(uid, fullName, stageName, email, phone, whatsapp, state, location, bio, photoFile, tiktok, instagram, facebook, outcome, JSON.stringify(results), hashPassword(b.pin), at);
      return { userId: uid, contestantId };
    }).catch((err) => {
      // The same email submitted twice at once.
      throw err.code === '23505' ? alreadyJoined() : err;
    });

    // Past the follower check: approved straight away, with her code, link and group, all sent to
    // her on WhatsApp. Otherwise she waits for an admin, and hears that her application is in.
    let contestant = null;
    if (outcome === 'passed') {
      contestant = await approveContestant(ctx, contestantId);
    } else if (await queueRegistered(ctx, { id: contestantId, stage_name: stageName, whatsapp }, null)) {
      ctx.background(sendDueWhatsApp(ctx, { max: 1 }));
    } else {
      await ctx.mailer.send({
        to: email,
        subject: 'We received your MBGN application',
        text: `Hello ${stageName},\n\n${outcome === 'review' ? 'We could not finish checking your followers automatically' : 'Your accounts are below our follower minimum'}, so our team will look at your application. We will let you know as soon as a decision is made.`,
      });
    }
    const group = contestant ? await groupById(db, contestant.whatsapp_group_id) : null;
    ctx.bus.publish('admin', { type: 'registration' });
    ctx.background(pushAdmins(ctx, contestant
      ? { title: 'New contestant', body: `${stageName} from ${state} passed the follower check and is in (${contestant.code}).`, url: '/admin' }
      : { title: 'New application to review', body: `${stageName} from ${state}: ${outcome === 'review' ? 'the follower check could not finish' : 'below the follower minimum'}.`, url: '/admin' }));

    // Joining is what identifies a contestant: this browser is recognised from now on.
    await startSession(ctx, res, userId);
    res.status(201).json({
      outcome,
      results,
      minFollowers,
      name: stageName,
      code: contestant?.code ?? null,
      link: contestant ? `${config.publicUrl}/c/${contestant.code}` : null,
      whatsappGroup: group ? { name: group.name, url: group.invite_url } : null,
    });
  });

  // ---- Sponsorship and other enquiries ----
  router.post('/enquiries', rateLimit({ windowMs: 3600000, max: scaled(10) }), async (req, res) => {
    const b = req.body ?? {};
    // A hidden field people never see. Bots fill it in, and get the same answer as everyone else.
    if (clean(b.website)) return res.status(201).json({ ok: true });
    const kind = ENQUIRY_KINDS.includes(b.kind) ? b.kind : 'General enquiry';
    const name = clean(b.name, 100);
    const organisation = clean(b.organisation, 120) || null;
    const email = clean(b.email, 200).toLowerCase() || null;
    const phone = clean(b.phone, 20);
    const message = clean(b.message, 2000);
    if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
    if (!validPhone(phone)) throw new HttpError(400, 'Please enter a phone or WhatsApp number we can reach you on.');
    if (email && !validEmail(email)) throw new HttpError(400, 'That email address does not look right.');
    if (message.length < 10) throw new HttpError(400, 'Please tell us a little more in your message.');

    await db.prepare('INSERT INTO enquiries (kind, name, organisation, email, phone, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, name, organisation, email, phone, message, nowIso());
    const admins = await db.prepare("SELECT email FROM users WHERE role = 'admin'").all();
    for (const admin of admins) {
      await ctx.mailer.send({
        to: admin.email,
        subject: `New ${kind.toLowerCase()} enquiry from ${name}`,
        text: `${name}${organisation ? ` (${organisation})` : ''}\nPhone: ${phone}${email ? `\nEmail: ${email}` : ''}\n\n${message}\n\nSee every enquiry on the Enquiries tab of the control panel.`,
      });
    }
    ctx.bus.publish('admin', { type: 'enquiry' });
    res.status(201).json({ ok: true });
  });

  // Contestants sign in on any device with the phone or WhatsApp number they joined with and their PIN.
  // Five wrong PINs lock the account for 30 minutes, counted in the database so every server agrees.
  router.post('/contestants/login', rateLimit({ windowMs: 15 * 60000, max: scaled(30) }), async (req, res) => {
    const digits = lastDigits(clean(req.body?.phone, 30));
    const pin = String(req.body?.pin ?? '').slice(0, 10);
    const noMatch = () => new HttpError(401, 'That phone number and PIN do not match.');
    if (digits.length < 7 || !/^\d{4}$/.test(pin)) throw noMatch();
    const rows = await db.prepare(`SELECT id, user_id, pin_hash, pin_failures, pin_locked_until FROM contestants
      WHERE (${DIGITS_SQL('whatsapp')} = ? OR ${DIGITS_SQL('phone')} = ?) AND status <> 'rejected' AND pin_hash IS NOT NULL`).all(digits, digits);
    const now = nowIso();
    const locked = rows.find((r) => r.pin_locked_until && r.pin_locked_until > now);
    if (locked) {
      throw new HttpError(429, `Too many wrong PINs. Try again at ${new Date(locked.pin_locked_until).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}, or ask the organisers to reset your PIN.`);
    }
    const match = rows.find((r) => verifyPassword(pin, r.pin_hash));
    if (!match) {
      for (const r of rows) {
        const failures = r.pin_failures + 1;
        await db.prepare('UPDATE contestants SET pin_failures = ?, pin_locked_until = ? WHERE id = ?')
          .run(failures >= 5 ? 0 : failures, failures >= 5 ? new Date(Date.now() + 30 * 60000).toISOString() : null, r.id);
      }
      throw noMatch();
    }
    await db.prepare('UPDATE contestants SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?').run(match.id);
    await startSession(ctx, res, match.user_id);
    res.json({ user: await publicUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(match.user_id)) });
  });

  // For contestants who joined before PINs existed, or whose PIN an admin reset: their email and
  // WhatsApp number open the dashboard once, where they choose a PIN. After that, only the PIN works.
  router.post('/contestants/recognise', loginLimit, async (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const whatsapp = lastDigits(clean(req.body?.whatsapp, 30));
    const row = await db.prepare('SELECT user_id, whatsapp, pin_hash FROM contestants WHERE email = ?').get(email);
    if (!row || whatsapp.length < 7 || lastDigits(row.whatsapp) !== whatsapp) {
      throw new HttpError(401, 'Those details do not match anyone who has joined.');
    }
    if (row.pin_hash) throw new HttpError(401, 'This account has a PIN. Log in with your phone number and PIN instead.');
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
    const row = await ctx.db.prepare('SELECT status, user_id, photo_file FROM contestants WHERE photo_file = ? OR pending_photo_file = ?').get(file, file);
    if (!row) throw new HttpError(404, 'Not found.');
    // A new photo waiting for an admin is private, even for an approved contestant.
    const isPublic = row.status === 'approved' && row.photo_file === file;
    const viewer = await sessionUser(ctx, req);
    const allowed = isPublic || viewer?.role === 'admin' || viewer?.id === row.user_id;
    if (!allowed) throw new HttpError(404, 'Not found.');
    const photo = await ctx.photos.get(file);
    if (!photo) throw new HttpError(404, 'Not found.');
    res.set({
      'Cache-Control': isPublic ? 'public, max-age=86400, s-maxage=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.type(file.split('.').pop());
    res.send(photo);
  };
}
