import {
  HttpError, asyncRouter, hashPassword, requireAdmin, sessionHash, startSession, verifyPassword,
} from '../auth.js';
import { approveContestant, tellApproved } from '../approval.js';
import { broadcastHistory, previewAudience, sendBroadcast } from '../broadcasts.js';
import {
  audit, notifyMany, notifyUser, photoUrl, publishActivity, recomputeRanks, votingState,
} from '../competition.js';
import { getSetting, nowIso, setSetting, tx } from '../db.js';
import { PLATFORMS, PROVIDERS } from '../followers.js';
import { countWaiting, placeWaiting } from '../groups.js';
import { closeRound, roundStanding, roundView } from '../rounds.js';
import { changeStage, startVotingIfDue, tellContestantsVotingOpened } from '../stages.js';
import { recordInPersonSale } from '../payments.js';
import { voidVote } from '../votes.js';
import {
  messageSettings, queueMissingAccepted, retryFailed, saveMessage, sendDueWhatsApp, whatsappOverview,
} from '../whatsapp.js';
import { normalizeCode, socialLink, themeSettings } from './public.js';
import { THEME_IDS } from '../../shared/themes.js';
import { COUNTRIES, COUNTRY_IDS, formatCount } from '../../shared/countries.js';

const clean = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Spreadsheet apps execute cells that begin with these characters.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, filename, header, rows) {
  const body = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(`﻿${body}`);
}

const contestantView = (c) => ({
  id: c.id,
  code: c.code,
  fullName: c.full_name,
  stageName: c.stage_name,
  email: c.email,
  phone: c.phone,
  whatsapp: c.whatsapp,
  state: c.state,
  location: c.location,
  bio: c.bio,
  photoUrl: photoUrl(c),
  tiktok: c.tiktok,
  instagram: c.instagram,
  facebook: c.facebook,
  verification: c.verification,
  followerResults: c.follower_results ? JSON.parse(c.follower_results) : [],
  whatsappGroupName: c.group_name ?? null,
  adjustedVotes: c.adjusted_votes ?? 0,
  pendingStageName: c.pending_stage_name,
  pendingPhotoUrl: c.pending_photo_file ? `/photos/${c.pending_photo_file}` : null,
  onProbation: Boolean(c.on_probation),
  hasPin: Boolean(c.pin_hash),
  category: c.category,
  status: c.status,
  statusReason: c.status_reason,
  totalVotes: c.total_votes,
  position: c.position,
  createdAt: c.created_at,
  approvedAt: c.approved_at,
});

// Only real invite links: this one goes out to every contestant in a batch.
function groupInvite(value) {
  let url;
  try {
    url = new URL(clean(value, 300));
  } catch {
    url = null;
  }
  const code = url?.pathname.split('/').filter(Boolean)[0] ?? '';
  if (url?.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || !/^\w+$/.test(code)) {
    throw new HttpError(400, 'Please paste a WhatsApp group invite link, starting https://chat.whatsapp.com/');
  }
  return `https://chat.whatsapp.com/${code}`;
}

function groupCapacity(value) {
  const capacity = Number(value);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new HttpError(400, 'Group size must be a whole number up to 1,024, the most WhatsApp allows.');
  return capacity;
}

const sameInvite = (err) => (err.code === '23505' ? new HttpError(409, 'That invite link is already on the list.') : err);

export function adminRouter(ctx) {
  const { db, config } = ctx;
  const router = asyncRouter();
  router.use(requireAdmin);

  const getContestant = async (id) => {
    const row = await db.prepare('SELECT * FROM contestants WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Contestant not found.');
    return row;
  };
  const changed = () => ctx.bus.publish('leaderboard', { updatedAt: nowIso() });

  // ---- The countries this admin runs ----
  // One admin for every country's site. Switching signs the same admin in to the other country,
  // on this domain, with that country's own sign-in cookie: the same email there, created with this
  // admin's password if it doesn't exist yet.
  router.get('/countries', (_req, res) => {
    res.json({ current: config.countryId, countries: COUNTRY_IDS.map((id) => ({ id, name: COUNTRIES[id].name, short: COUNTRIES[id].short })) });
  });

  router.post('/switch-country', async (req, res) => {
    const target = String(req.body?.country ?? '').toLowerCase();
    if (!COUNTRY_IDS.includes(target)) throw new HttpError(400, 'Choose a country.');
    if (target === config.countryId) return res.json({ country: target });
    if (!ctx.siteFor) throw new HttpError(404, 'Only one country runs here.');
    let other;
    try {
      other = await ctx.siteFor(target);
    } catch (err) {
      console.error(`Could not open the ${target.toUpperCase()} site:`, err.message);
      throw new HttpError(503, `The ${COUNTRIES[target].name} site isn't ready yet. Please try again later.`);
    }
    const me = await db.prepare('SELECT email, name, phone, password_hash FROM users WHERE id = ?').get(req.user.id);
    let there = await other.db.prepare('SELECT id, role FROM users WHERE lower(email) = lower(?)').get(me.email);
    if (there && there.role !== 'admin') throw new HttpError(403, `Your email is a contestant's account on the ${COUNTRIES[target].name} site.`);
    if (!there) {
      const { lastInsertRowid } = await other.db.prepare(`INSERT INTO users (email, name, phone, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, 'admin', ?) RETURNING id`).run(me.email, me.name, me.phone, me.password_hash, nowIso());
      there = { id: lastInsertRowid };
    }
    await startSession(other, res, there.id);
    res.json({ country: target });
  });

  // ---- Overview ----
  router.get('/overview', async (_req, res) => {
    const one = async (sql, ...args) => (await db.prepare(sql).get(...args)).n;
    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const [voting, totalVotes, votes24h, revenue, revenue24h, votesHeld, contestants, pending, openFlags, paymentsInReview, waitingForGroup, newEnquiries, adjustedVotes] = await Promise.all([
      votingState(db),
      one("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE status = 'valid'"),
      one("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE status = 'valid' AND created_at >= ?", dayAgo),
      one("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'paid' AND paid_at >= ?", dayAgo),
      one("SELECT COUNT(*) AS n FROM payments WHERE votes_status = 'held'"),
      one("SELECT COUNT(*) AS n FROM contestants WHERE status = 'approved'"),
      one("SELECT COUNT(*) AS n FROM contestants WHERE status = 'pending'"),
      one("SELECT COUNT(*) AS n FROM flags WHERE status = 'open'"),
      one("SELECT COUNT(*) AS n FROM payments WHERE status = 'review'"),
      countWaiting(db),
      one("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'"),
      one("SELECT COALESCE(SUM(quantity), 0) AS n FROM vote_adjustments"),
    ]);
    const revenueInPerson = await one("SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'paid' AND provider = 'in_person'");
    res.json({
      voting, totalVotes, votes24h, revenue, revenue24h, revenueInPerson, votesHeld, contestants, pending, openFlags, paymentsInReview, waitingForGroup, newEnquiries, adjustedVotes,
    });
  });

  // ---- The contest's stage: taking applications, then voting ----
  router.post('/phase/:phase(registration|voting)', async (req, res) => {
    const { phase } = req.params;
    if (phase === 'registration') {
      if (await getSetting(db, 'competition_phase') === 'registration') throw new HttpError(409, 'The contest is already in its registration stage.');
      // Reopening needs a new countdown. With the old one already passed, voting would start again
      // by itself on the next visit. Blank means no deadline.
      const endsAt = isoOrEmpty(req.body?.endsAt, 'Countdown end');
      if (endsAt && endsAt <= nowIso()) throw new HttpError(400, 'Choose a countdown end in the future.');
      await setSetting(db, 'registration_ends_at', endsAt);
    }
    if (!(await changeStage(ctx, phase, req.user.id))) throw new HttpError(409, `The contest is already in its ${phase} stage.`);
    const notified = phase === 'voting' ? await tellContestantsVotingOpened(ctx) : 0;
    res.json({ phase, notified });
  });

  // The voting countdown. Voting stops by itself at this time. Blank means no end.
  router.put('/voting-ends', async (req, res) => {
    const endsAt = isoOrEmpty(req.body?.endsAt, 'Voting end');
    if (endsAt && endsAt <= nowIso()) throw new HttpError(400, 'Choose a time in the future, or use Close voting to stop now.');
    await setSetting(db, 'voting_ends_at', endsAt);
    await audit(ctx, req.user.id, 'voting.ends_at', endsAt || 'none');
    ctx.bus.publish('competition', {});
    res.json({ endsAt: endsAt || null });
  });

  // ---- Contestants ----
  router.get('/contestants',async (req, res) => {
    const status = clean(req.query.status, 20);
    const q = clean(req.query.q, 60);
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (q) { where.push('(stage_name ILIKE ? OR full_name ILIKE ? OR code ILIKE ? OR email ILIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
    const rows = await db.prepare(`SELECT *, (SELECT name FROM whatsapp_groups g WHERE g.id = contestants.whatsapp_group_id) AS group_name,
      (SELECT COALESCE(SUM(quantity), 0) FROM vote_adjustments a WHERE a.contestant_id = contestants.id) AS adjusted_votes
      FROM contestants ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(position, 999999), id DESC LIMIT ?`).all(...params, Math.min(Number(req.query.limit) || 200, 5000));
    res.json(rows.map(contestantView));
  });

  router.post('/contestants/:id/approve', async (req, res) => {
    const { id } = await getContestant(req.params.id);
    res.json(contestantView(await approveContestant(ctx, id, req.user.id)));
  });

  router.post('/contestants/:id/resend-code', async (req, res) => {
    const c = await getContestant(req.params.id);
    if (c.status !== 'approved') throw new HttpError(409, 'Only approved contestants have an active code.');
    await tellApproved(ctx, c, { whatsapp: false });
    await audit(ctx, req.user.id, 'contestant.resend_code', c.code);
    res.json({ ok: true });
  });

  const STATUS_ACTIONS = {
    reject: { to: 'rejected', from: ['pending'], subject: 'Your MBGN application', notice: 'Your application was not approved.' },
    suspend: { to: 'suspended', from: ['approved'], subject: 'Your MBGN profile is suspended', notice: 'Your profile has been suspended.' },
    disqualify: { to: 'disqualified', from: ['approved', 'suspended'], subject: 'You have been disqualified from MBGN', notice: 'You have been disqualified.' },
    reinstate: { to: 'approved', from: ['suspended', 'disqualified', 'eliminated'], subject: 'Your MBGN profile is active again', notice: 'Your profile is active again.' },
  };

  router.post('/contestants/:id/:action(reject|suspend|disqualify|reinstate)', async (req, res) => {
    const action = STATUS_ACTIONS[req.params.action];
    const reason = clean(req.body?.reason);
    if (req.params.action !== 'reinstate' && reason.length < 3) throw new HttpError(400, 'Please give a reason. The contestant will see it.');
    const updated = await tx(db, async () => {
      const c = await getContestant(req.params.id);
      if (!action.from.includes(c.status)) throw new HttpError(409, `Cannot ${req.params.action} a contestant who is ${c.status}.`);
      await db.prepare('UPDATE contestants SET status = ?, status_reason = ? WHERE id = ?').run(action.to, reason || null, c.id);
      await recomputeRanks(db);
      await audit(ctx, req.user.id, `contestant.${req.params.action}`, `#${c.id} ${c.stage_name}: ${reason}`);
      return await getContestant(c.id);
    });
    const message = reason ? `${action.notice} Reason: ${reason}` : action.notice;
    await notifyUser(ctx, updated.user_id, 'status', message);
    await ctx.mailer.send({ to: updated.email, subject: action.subject, text: `Hello ${updated.stage_name},\n\n${message}` });
    changed();
    res.json(contestantView(updated));
  });

  router.patch('/contestants/:id', async (req, res) => {
    const c = await getContestant(req.params.id);
    const category = clean(req.body?.category, 40) || null;
    await db.prepare('UPDATE contestants SET category = ? WHERE id = ?').run(category, c.id);
    await audit(ctx, req.user.id, 'contestant.category', `${c.stage_name}: ${category}`);
    res.json(contestantView(await getContestant(c.id)));
  });

  // A new public name or photo an approved contestant asked for.
  router.post('/contestants/:id/profile-changes/:decision(approve|reject)', async (req, res) => {
    const c = await getContestant(req.params.id);
    if (!c.pending_stage_name && !c.pending_photo_file) throw new HttpError(409, 'There are no changes waiting.');
    const approve = req.params.decision === 'approve';
    await db.prepare('UPDATE contestants SET stage_name = ?, photo_file = ?, pending_stage_name = NULL, pending_photo_file = NULL WHERE id = ?')
      .run(approve && c.pending_stage_name ? c.pending_stage_name : c.stage_name, approve && c.pending_photo_file ? c.pending_photo_file : c.photo_file, c.id);
    await audit(ctx, req.user.id, `contestant.profile_${req.params.decision}`, `#${c.id} ${c.stage_name}`);
    await notifyUser(ctx, c.user_id, 'status', approve ? 'Your profile changes have been approved and are now on the site.' : 'Your requested name or photo change was not approved. Contact the organisers if you have questions.');
    if (approve) changed();
    res.json(contestantView(await getContestant(c.id)));
  });

  // Clears a forgotten PIN. The contestant then opens the dashboard once with email and WhatsApp
  // number, and chooses a new one.
  router.post('/contestants/:id/reset-pin', async (req, res) => {
    const c = await getContestant(req.params.id);
    await db.prepare('UPDATE contestants SET pin_hash = NULL, pin_failures = 0, pin_locked_until = NULL WHERE id = ?').run(c.id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(c.user_id);
    await audit(ctx, req.user.id, 'contestant.reset_pin', `#${c.id} ${c.stage_name}`);
    res.json(contestantView(await getContestant(c.id)));
  });

  router.post('/contestants/:id/probation', async (req, res) => {
    const c = await getContestant(req.params.id);
    if (c.status !== 'approved') throw new HttpError(409, 'Only approved contestants can be on probation.');
    const on = Boolean(req.body?.on);
    await db.prepare('UPDATE contestants SET on_probation = ? WHERE id = ?').run(on ? 1 : 0, c.id);
    await audit(ctx, req.user.id, on ? 'contestant.probation' : 'contestant.probation_end', `#${c.id} ${c.stage_name}`);
    await notifyUser(ctx, c.user_id, 'status', on
      ? 'You are on probation. If you miss the next round\'s target you will be eliminated. Share your voting link now.'
      : 'You are no longer on probation.');
    changed();
    res.json(contestantView(await getContestant(c.id)));
  });

  // ---- Rounds and eliminations ----
  const roundInput = (b, from) => {
    const name = clean(b?.name, 60);
    const startsAt = isoOrEmpty(b?.startsAt, 'Start') || from;
    const endsAt = isoOrEmpty(b?.endsAt, 'End');
    const whole = (value, label) => {
      if (value === '' || value === null || value === undefined) return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${label} must be a whole number above zero.`);
      return n;
    };
    const keepTop = whole(b?.keepTop, 'Contestants kept');
    const minVotes = whole(b?.minVotes, 'Minimum votes');
    const probation = whole(b?.probation, 'Probation places') ?? 0;
    if (name.length < 2) throw new HttpError(400, 'Please name the round, like Round 1.');
    if (!endsAt) throw new HttpError(400, 'Please choose when the round ends.');
    if (endsAt <= startsAt) throw new HttpError(400, 'The round must end after it starts.');
    if (!keepTop && !minVotes) throw new HttpError(400, 'Choose how many contestants stay, a minimum number of votes, or both.');
    return { name, startsAt, endsAt, keepTop, minVotes, probation, votesCounted: b?.votesCounted === 'total' ? 'total' : 'round' };
  };

  router.get('/rounds', async (_req, res) => {
    const rounds = await db.prepare('SELECT * FROM rounds ORDER BY starts_at, id').all();
    const current = rounds.find((r) => !r.closed_at);
    let preview = null;
    if (current) {
      const standing = await roundStanding(db, current);
      const brief = (list) => list.map((c) => ({ code: c.code, name: c.stage_name, position: c.position, votes: c.counted, onProbation: Boolean(c.on_probation) }));
      preview = { roundId: current.id, safe: standing.safe.length, probation: brief(standing.probation), eliminated: brief(standing.eliminated) };
    }
    res.json({ rounds: rounds.map(roundView), preview });
  });

  router.post('/rounds', async (req, res) => {
    // A new round follows the last one, from when it really ended if an admin ended it early.
    const last = await db.prepare('SELECT LEAST(COALESCE(closed_at, ends_at), ends_at) AS ended FROM rounds ORDER BY starts_at DESC, id DESC LIMIT 1').get();
    const r = roundInput(req.body, last?.ended ?? nowIso());
    await db.prepare(`INSERT INTO rounds (name, starts_at, ends_at, keep_top, min_votes, votes_counted, probation)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(r.name, r.startsAt, r.endsAt, r.keepTop, r.minVotes, r.votesCounted, r.probation);
    await audit(ctx, req.user.id, 'round.add', `${r.name}: ends ${r.endsAt}, keep top ${r.keepTop ?? '-'}, min votes ${r.minVotes ?? '-'}, probation ${r.probation}`);
    ctx.bus.publish('competition', {});
    res.status(201).json({ ok: true });
  });

  router.put('/rounds/:id', async (req, res) => {
    const round = await db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
    if (!round) throw new HttpError(404, 'Round not found.');
    if (round.closed_at) throw new HttpError(409, 'This round has already ended.');
    const r = roundInput(req.body, round.starts_at);
    await db.prepare('UPDATE rounds SET name = ?, starts_at = ?, ends_at = ?, keep_top = ?, min_votes = ?, votes_counted = ?, probation = ? WHERE id = ?')
      .run(r.name, r.startsAt, r.endsAt, r.keepTop, r.minVotes, r.votesCounted, r.probation, round.id);
    await audit(ctx, req.user.id, 'round.update', `${r.name}: ends ${r.endsAt}`);
    ctx.bus.publish('competition', {});
    res.json({ ok: true });
  });

  router.delete('/rounds/:id', async (req, res) => {
    const { changes } = await db.prepare('DELETE FROM rounds WHERE id = ? AND closed_at IS NULL').run(req.params.id);
    if (!changes) throw new HttpError(409, 'Only a round that has not ended can be removed.');
    await audit(ctx, req.user.id, 'round.delete', `#${req.params.id}`);
    ctx.bus.publish('competition', {});
    res.json({ ok: true });
  });

  router.post('/rounds/:id/close', async (req, res) => {
    if (await getSetting(db, 'competition_phase') !== 'voting') throw new HttpError(409, 'Rounds end during voting. Start voting first.');
    const done = await closeRound(ctx, Number(req.params.id), req.user.id);
    if (!done) throw new HttpError(409, 'This round has already ended.');
    const round = await db.prepare('SELECT * FROM rounds WHERE id = ?').get(done.round.id);
    res.json(roundView(round));
  });

  // A blank date means no deadline. Moving it later reopens applications. With autoStart on,
  // voting begins by itself when this countdown ends.
  router.put('/registration', async (req, res) => {
    const endsAt = isoOrEmpty(req.body?.endsAt, 'Closing date');
    const autoStart = req.body?.autoStart === undefined ? await getSetting(db, 'auto_start_voting') === '1' : Boolean(req.body.autoStart);
    await setSetting(db, 'registration_ends_at', endsAt);
    await setSetting(db, 'auto_start_voting', autoStart ? '1' : '0');
    await audit(ctx, req.user.id, 'registration.deadline', `${endsAt || 'none'}, voting starts ${autoStart ? 'automatically' : 'by hand'}`);
    // A date already in the past starts voting straight away.
    const started = await startVotingIfDue(ctx);
    ctx.bus.publish('competition', {});
    res.json({ endsAt: endsAt || null, autoStart, started });
  });

  // ---- Votes added or taken away by hand ----
  router.get('/contestants/:id/adjustments', async (req, res) => {
    const rows = await db.prepare(`SELECT a.*, u.name AS admin_name FROM vote_adjustments a
      LEFT JOIN users u ON u.id = a.admin_id WHERE a.contestant_id = ? ORDER BY a.id DESC LIMIT 100`).all(req.params.id);
    res.json(rows.map((a) => ({ id: a.id, quantity: a.quantity, reason: a.reason, admin: a.admin_name, createdAt: a.created_at })));
  });

  router.post('/contestants/:id/adjustments', async (req, res) => {
    const quantity = Number(req.body?.quantity);
    const reason = clean(req.body?.reason, 300);
    if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 1000000) throw new HttpError(400, 'Enter a whole number of votes to add, or a minus number to take away.');
    if (reason.length < 3) throw new HttpError(400, 'Please give a reason. It is kept in the log.');
    const updated = await tx(db, async () => {
      const c = await getContestant(req.params.id);
      if (c.status !== 'approved') throw new HttpError(409, 'Votes can only be changed for approved contestants.');
      if (c.total_votes + quantity < 0) throw new HttpError(400, `${c.stage_name} only has ${formatCount(c.total_votes, config.countryId)} votes to take away.`);
      const at = nowIso();
      await db.prepare('INSERT INTO vote_adjustments (contestant_id, quantity, reason, admin_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, quantity, reason, req.user.id, at);
      // Added votes count as reaching the new total now, which decides ties.
      await db.prepare(`UPDATE contestants SET total_votes = total_votes + ?, last_vote_at = CASE WHEN ? > 0 THEN ? ELSE last_vote_at END WHERE id = ?`)
        .run(quantity, quantity, at, c.id);
      await recomputeRanks(db);
      await audit(ctx, req.user.id, 'votes.adjust', `${c.code} ${quantity > 0 ? '+' : ''}${quantity}: ${reason}`);
      return getContestant(c.id);
    });
    changed();
    res.status(201).json(contestantView(updated));
  });

  // ---- Sponsorship and other enquiries ----
  router.get('/enquiries', async (_req, res) => {
    const [rows, phone, email] = await Promise.all([
      db.prepare("SELECT * FROM enquiries ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, id DESC LIMIT 300").all(),
      getSetting(db, 'contact_phone'),
      getSetting(db, 'contact_email'),
    ]);
    res.json({
      contact: { phone, email },
      enquiries: rows.map((e) => ({
        id: e.id, kind: e.kind, name: e.name, organisation: e.organisation, email: e.email, phone: e.phone, message: e.message, status: e.status, createdAt: e.created_at,
      })),
    });
  });

  router.post('/enquiries/:id/:status(new|done)', async (req, res) => {
    const { changes } = await db.prepare('UPDATE enquiries SET status = ? WHERE id = ?').run(req.params.status, req.params.id);
    if (!changes) throw new HttpError(404, 'Enquiry not found.');
    ctx.bus.publish('admin', { type: 'enquiry' });
    res.json({ ok: true });
  });

  router.put('/contact', async (req, res) => {
    const phone = clean(req.body?.phone, 30);
    const email = clean(req.body?.email, 200).toLowerCase();
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) throw new HttpError(400, 'That phone number does not look right.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email address does not look right.');
    await setSetting(db, 'contact_phone', phone);
    await setSetting(db, 'contact_email', email);
    await audit(ctx, req.user.id, 'contact.update', `${phone || 'no phone'}, ${email || 'no email'}`);
    ctx.bus.publish('competition', {});
    res.json({ phone, email });
  });

  // ---- The site's look ----
  router.put('/themes', async (req, res) => {
    const wanted = Array.isArray(req.body?.offered) ? req.body.offered : [];
    const offered = THEME_IDS.filter((id) => wanted.includes(id));
    if (!offered.length) throw new HttpError(400, 'Keep at least one theme.');
    const chosen = THEME_IDS.includes(req.body?.default) ? req.body.default : null;
    if (!chosen || !offered.includes(chosen)) throw new HttpError(400, 'The default theme must be one of the themes on offer.');
    await setSetting(db, 'themes_offered', offered.join(','));
    await setSetting(db, 'default_theme', chosen);
    await audit(ctx, req.user.id, 'themes.update', `${offered.join(', ')}; default ${chosen}`);
    ctx.bus.publish('competition', {});
    res.json(await themeSettings(db));
  });

  // ---- Who can join: the follower check and the WhatsApp groups ----
  router.get('/joining', async (_req, res) => {
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
    const [minFollowers, groups, waiting, followerSettings, usage] = await Promise.all([
      getSetting(db, 'min_followers'),
      db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM contestants c WHERE c.whatsapp_group_id = g.id) AS used
        FROM whatsapp_groups g ORDER BY g.id`).all(),
      countWaiting(db),
      db.prepare("SELECT key, value FROM settings WHERE key LIKE 'follower\\_%'").all(),
      db.prepare('SELECT source, COUNT(*) AS n FROM follower_lookups WHERE checked_at > ? GROUP BY source').all(monthAgo),
    ]);
    const setting = Object.fromEntries(followerSettings.map((s) => [s.key, s.value]));
    const used = Object.fromEntries(usage.map((u) => [u.source, u.n]));
    // Every key that is set, in the order tried, then the services with no key yet.
    const slots = PROVIDERS.flatMap((p) => {
      const keyed = ctx.followers.providers.filter((k) => k.service === p.name);
      return keyed.length ? keyed.map((k) => ({ ...k, configured: true })) : [{ ...p, configured: false }];
    });
    // The same rule that decides who is placed next: the oldest open group with room.
    const current = groups.find((g) => !g.closed && g.used < g.capacity);
    res.json({
      minFollowers: Number(minFollowers),
      checkMode: ctx.followers.mode,
      checkSetting: setting.follower_check_mode || 'auto',
      providers: slots.map((p) => {
        const until = setting[`follower_pause_${p.name}`];
        return {
          name: p.name,
          label: p.label,
          env: p.env,
          platforms: Object.keys(p.requests),
          configured: p.configured,
          pausedUntil: until && new Date(until) > new Date() ? until : null,
          credits: setting[`follower_credits_${p.name}`] ? Number(setting[`follower_credits_${p.name}`]) : null,
          used30d: used[p.name] ?? 0,
        };
      }),
      waiting,
      groups: groups.map((g) => ({
        id: g.id, name: g.name, url: g.invite_url, capacity: g.capacity, used: g.used, closed: Boolean(g.closed), current: g.id === current?.id,
      })),
    });
  });

  router.put('/joining', async (req, res) => {
    const minFollowers = Number(req.body?.minFollowers);
    if (!Number.isInteger(minFollowers) || minFollowers < 0) throw new HttpError(400, 'Followers needed must be a whole number.');
    const checkMode = req.body?.checkMode === 'manual' ? 'manual' : 'auto';
    await setSetting(db, 'min_followers', minFollowers);
    await setSetting(db, 'follower_check_mode', checkMode);
    await audit(ctx, req.user.id, 'joining.follower_check', `${minFollowers} followers, checked ${checkMode === 'manual' ? 'by hand' : 'automatically'}`);
    ctx.bus.publish('competition', {});
    res.json({ minFollowers, checkMode });
  });

  // Tries one account through the services, ignoring saved answers, and shows what each said.
  router.post('/followers/test', async (req, res) => {
    const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : null;
    if (!platform) throw new HttpError(400, 'Choose Instagram, TikTok or Facebook.');
    const link = socialLink(req.body?.account, platform);
    if (!link) throw new HttpError(400, 'Enter a username or link to test.');
    const result = await ctx.followers.lookupAccount(platform, link, { fresh: true });
    res.json({ platform, link, mode: ctx.followers.mode, ...result });
  });

  router.post('/followers/providers/:name/resume', async (req, res) => {
    if (!ctx.followers.providers.some((p) => p.name === req.params.name)) throw new HttpError(404, 'Unknown service.');
    await setSetting(db, `follower_pause_${req.params.name}`, '');
    await audit(ctx, req.user.id, 'followers.resume', req.params.name);
    res.json({ ok: true });
  });

  router.post('/whatsapp-groups', async (req, res) => {
    const name = clean(req.body?.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Please name this group, like Batch 2.');
    const url = groupInvite(req.body?.url);
    const capacity = groupCapacity(req.body?.capacity);
    await db.prepare('INSERT INTO whatsapp_groups (name, invite_url, capacity, created_at) VALUES (?, ?, ?, ?)')
      .run(name, url, capacity, nowIso()).catch((err) => { throw sameInvite(err); });
    await audit(ctx, req.user.id, 'whatsapp_group.add', name);
    res.status(201).json({ placed: await placeWaiting(ctx) });
  });

  router.put('/whatsapp-groups/:id', async (req, res) => {
    const name = clean(req.body?.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Please name this group, like Batch 2.');
    const url = groupInvite(req.body?.url);
    const capacity = groupCapacity(req.body?.capacity);
    const { changes } = await db.prepare('UPDATE whatsapp_groups SET name = ?, invite_url = ?, capacity = ?, closed = ? WHERE id = ?')
      .run(name, url, capacity, req.body?.closed ? 1 : 0, req.params.id).catch((err) => { throw sameInvite(err); });
    if (!changes) throw new HttpError(404, 'That group was not found.');
    await audit(ctx, req.user.id, 'whatsapp_group.update', name);
    res.json({ placed: await placeWaiting(ctx) });
  });

  // ---- Money and votes ----
  router.get('/payments', async (req, res) => {
    const status = clean(req.query.status, 20);
    const rows = await db.prepare(`SELECT p.*, u.name AS recorded_by_name, c.code, c.stage_name FROM payments p
      LEFT JOIN users u ON u.id = p.recorded_by
      LEFT JOIN contestants c ON c.id = p.vote_contestant_id
      ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 300`).all(...(status ? [status] : []));
    res.json(rows.map((p) => ({
      reference: p.reference, voterName: p.voter_name, email: p.email, votes: p.vote_quantity, votesStatus: p.votes_status, amount: p.amount, status: p.status,
      provider: p.provider, providerRef: p.provider_ref, paidAmount: p.paid_amount, createdAt: p.created_at, paidAt: p.paid_at,
      method: p.payment_method, recordedBy: p.recorded_by_name, contestant: p.code ? `${p.stage_name} (${p.code})` : null,
    })));
  });

  // Votes someone buys in person, with cash, a transfer or POS, recorded by the admin who took the money.
  router.post('/in-person-votes', async (req, res) => {
    const b = req.body ?? {};
    const payment = await recordInPersonSale(ctx, {
      code: normalizeCode(b.code),
      quantity: Number(b.quantity),
      amount: Number(b.amount),
      method: b.method,
      voterName: b.voterName,
      email: b.email,
      note: b.note,
      adminId: req.user.id,
    });
    changed();
    res.status(201).json({ reference: payment.reference, votesStatus: payment.votes_status, amount: payment.amount, votes: payment.vote_quantity });
  });

  router.get('/votes', async (_req, res) => {
    const rows = await db.prepare(`SELECT v.*, c.code, c.stage_name, p.email FROM votes v
      JOIN contestants c ON c.id = v.contestant_id
      LEFT JOIN payments p ON p.id = v.payment_id
      ORDER BY v.id DESC LIMIT 300`).all();
    res.json(rows.map((v) => ({
      id: v.id, receiptNo: v.receipt_no, email: v.email, code: v.code, name: v.stage_name, quantity: v.quantity,
      status: v.status, voidReason: v.void_reason, viaLink: Boolean(v.via_link), createdAt: v.created_at,
    })));
  });

  router.post('/votes/:id/void', async (req, res) => {
    const reason = clean(req.body?.reason);
    if (reason.length < 3) throw new HttpError(400, 'Please give a reason for voiding this vote.');
    await voidVote(ctx, { voteId: Number(req.params.id), reason, adminId: req.user.id });
    changed();
    res.json({ ok: true });
  });

  // ---- Fraud review ----
  router.get('/flags', async (req, res) => {
    const status = clean(req.query.status, 20) || 'open';
    const rows = await db.prepare(`SELECT f.*, c.code FROM flags f
      LEFT JOIN contestants c ON c.id = f.contestant_id
      WHERE f.status = ? ORDER BY f.id DESC LIMIT 200`).all(status);
    res.json(rows.map((f) => ({
      id: f.id, kind: f.kind, severity: f.severity, details: f.details, code: f.code, status: f.status, createdAt: f.created_at,
    })));
  });

  router.post('/flags/:id/:outcome(resolved|dismissed)', async (req, res) => {
    await db.prepare("UPDATE flags SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(req.params.outcome, nowIso(), req.params.id);
    await audit(ctx, req.user.id, `flag.${req.params.outcome}`, `#${req.params.id}`);
    res.json({ ok: true });
  });

  // ---- Competition settings ----
  router.get('/settings', async (_req, res) => {
    const [settings, packages, counts] = await Promise.all([
      db.prepare('SELECT key, value FROM settings').all(),
      db.prepare('SELECT * FROM packages ORDER BY votes').all(),
      db.prepare(`SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved FROM contestants`).get(),
    ]);
    const setting = Object.fromEntries(settings.map((row) => [row.key, row.value]));
    res.json({
      phase: setting.competition_phase,
      registrationEndsAt: setting.registration_ends_at,
      autoStartVoting: setting.auto_start_voting === '1',
      pendingApplications: counts.pending,
      approvedContestants: counts.approved,
      name: setting.competition_name,
      votePrice: Number(setting.vote_price),
      votingStatus: setting.voting_status,
      startsAt: setting.voting_starts_at,
      endsAt: setting.voting_ends_at,
      largeVoteThreshold: Number(setting.large_vote_threshold),
      resultsPublishedAt: setting.results_published_at,
      packages: packages.map((p) => ({ ...p, active: Boolean(p.active) })),
    });
  });

  const isoOrEmpty = (value, label) => {
    const text = clean(value, 40);
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is not a valid date.`);
    return date.toISOString();
  };

  router.put('/settings', async (req, res) => {
    const b = req.body ?? {};
    const name = clean(b.name, 120);
    const votePrice = Number(b.votePrice);
    const threshold = Number(b.largeVoteThreshold);
    const startsAt = isoOrEmpty(b.startsAt, 'Start date');
    const endsAt = isoOrEmpty(b.endsAt, 'End date');
    if (name.length < 3) throw new HttpError(400, 'Please enter the competition name.');
    if (!Number.isInteger(votePrice) || votePrice < 1) throw new HttpError(400, `Vote price must be a whole number of ${config.countryId === 'gh' ? 'cedis' : 'naira'}.`);
    if (!Number.isInteger(threshold) || threshold < 0) throw new HttpError(400, 'Large-vote alert must be a whole number.');
    if (startsAt && endsAt && startsAt >= endsAt) throw new HttpError(400, 'Voting must end after it starts.');
    await tx(db, async () => {
      await setSetting(db, 'competition_name', name);
      await setSetting(db, 'vote_price', votePrice);
      await setSetting(db, 'voting_starts_at', startsAt);
      await setSetting(db, 'voting_ends_at', endsAt);
      await setSetting(db, 'large_vote_threshold', threshold);
      await audit(ctx, req.user.id, 'settings.update', `price=${votePrice} starts=${startsAt} ends=${endsAt}`);
    });
    ctx.bus.publish('competition', {});
    res.json({ ok: true });
  });

  router.post('/voting/:status(open|paused|closed)', async (req, res) => {
    if (await getSetting(db, 'competition_phase') === 'registration') throw new HttpError(409, 'End registration first to start voting.');
    await setSetting(db, 'voting_status', req.params.status);
    if (req.params.status === 'open') await setSetting(db, 'results_published_at', '');
    await audit(ctx, req.user.id, 'voting.status', req.params.status);
    ctx.bus.publish('competition', {});
    res.json({ voting: await votingState(db) });
  });

  router.post('/packages', async (req, res) => {
    const votes = Number(req.body?.votes);
    const price = Number(req.body?.price);
    if (!Number.isInteger(votes) || votes < 1 || !Number.isInteger(price) || price < 1) {
      throw new HttpError(400, 'Votes and price must be whole numbers above zero.');
    }
    const { lastInsertRowid: id } = await db.prepare('INSERT INTO packages (votes, price) VALUES (?, ?) RETURNING id').run(votes, price);
    await audit(ctx, req.user.id, 'package.create', `${votes} votes for ${price}`);
    ctx.bus.publish('competition', {});
    res.status(201).json({ id });
  });

  router.patch('/packages/:id', async (req, res) => {
    const pack = await db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
    if (!pack) throw new HttpError(404, 'Package not found.');
    const votes = req.body?.votes ?? pack.votes;
    const price = req.body?.price ?? pack.price;
    const active = req.body?.active === undefined ? pack.active : req.body.active ? 1 : 0;
    if (!Number.isInteger(votes) || votes < 1 || !Number.isInteger(price) || price < 1) {
      throw new HttpError(400, 'Votes and price must be whole numbers above zero.');
    }
    await db.prepare('UPDATE packages SET votes = ?, price = ?, active = ? WHERE id = ?').run(votes, price, active, pack.id);
    await audit(ctx, req.user.id, 'package.update', `#${pack.id}: ${votes} votes for ${price}, active=${active}`);
    ctx.bus.publish('competition', {});
    res.json({ ok: true });
  });

  // ---- Announcements and public notifications ----
  // ---- WhatsApp messages (sent through Evolution API, or by whatsapp-sender/) ----
  router.get('/whatsapp', async (_req, res) => {
    res.json(await whatsappOverview(ctx));
  });

  router.post('/whatsapp/send-accepted', async (req, res) => {
    const queued = await queueMissingAccepted(ctx);
    await audit(ctx, req.user.id, 'whatsapp.accepted', `Queued ${queued} acceptance messages`);
    ctx.background(sendDueWhatsApp(ctx));
    res.json({ queued });
  });

  // Admins' own messages: who they'd reach, sending, and what was sent.
  router.post('/whatsapp/audience', async (req, res) => {
    res.json(await previewAudience(ctx, req.body?.audience));
  });

  router.post('/whatsapp/broadcasts', async (req, res) => {
    res.status(201).json(await sendBroadcast(ctx, req.body?.audience, req.body?.text, req.user.id));
  });

  router.get('/whatsapp/broadcasts', async (_req, res) => {
    res.json(await broadcastHistory(ctx));
  });

  router.get('/whatsapp/messages', async (_req, res) => {
    res.json(await messageSettings(ctx));
  });

  // New wording for one message; empty goes back to the default. Messages already waiting keep theirs.
  router.put('/whatsapp/messages/:kind', async (req, res) => {
    await saveMessage(ctx, req.params.kind, req.body?.text);
    await audit(ctx, req.user.id, 'whatsapp.message', req.params.kind);
    res.json(await messageSettings(ctx));
  });

  router.post('/whatsapp/retry-failed', async (req, res) => {
    const retried = await retryFailed(ctx);
    await audit(ctx, req.user.id, 'whatsapp.retry', `Retrying ${retried} messages`);
    ctx.background(sendDueWhatsApp(ctx));
    res.json({ retried });
  });

  router.get('/announcements', async (_req, res) => {
    res.json(await db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 100').all());
  });

  router.post('/announcements', async (req, res) => {
    const title = clean(req.body?.title, 120);
    const body = clean(req.body?.body, 2000);
    const isPublic = Boolean(req.body?.public);
    if (title.length < 3 || body.length < 3) throw new HttpError(400, 'An announcement needs a title and a message.');
    await db.prepare('INSERT INTO announcements (title, body, public, created_at) VALUES (?, ?, ?, ?)').run(title, body, isPublic ? 1 : 0, nowIso());
    const recipients = await db.prepare("SELECT user_id, email, stage_name FROM contestants WHERE status = 'approved'").all();
    // Saved all at once; the emails go out in batches, so thousands of contestants is fine.
    await notifyMany(ctx, recipients.map((r) => ({ userId: r.user_id, message: `${title}: ${body}` })), 'announcement');
    await ctx.mailer.queue(recipients.map((r) => ({ to: r.email, subject: title, text: `Hello ${r.stage_name},\n\n${body}` })));
    ctx.background(ctx.mailer.sendQueued());
    if (isPublic) await publishActivity(ctx, { kind: 'announcement', message: `${title}: ${body}` });
    await audit(ctx, req.user.id, 'announcement.send', title);
    res.status(201).json({ recipients: recipients.length });
  });

  router.get('/activity', async (_req, res) => {
    const rows = await db.prepare('SELECT id, kind, message, hidden, created_at FROM activity ORDER BY id DESC LIMIT 200').all();
    res.json(rows.map((r) => ({ id: r.id, kind: r.kind, message: r.message, hidden: Boolean(r.hidden), createdAt: r.created_at })));
  });

  router.post('/activity', async (req, res) => {
    const message = clean(req.body?.message, 200);
    if (message.length < 3) throw new HttpError(400, 'Please write the notification.');
    await publishActivity(ctx, { kind: 'announcement', message });
    await audit(ctx, req.user.id, 'activity.post', message);
    res.status(201).json({ ok: true });
  });

  router.post('/activity/:id/visibility', async (req, res) => {
    await db.prepare('UPDATE activity SET hidden = ? WHERE id = ?').run(req.body?.hidden ? 1 : 0, req.params.id);
    await audit(ctx, req.user.id, 'activity.visibility', `#${req.params.id} hidden=${Boolean(req.body?.hidden)}`);
    ctx.bus.publish('activity_refresh', {});
    res.json({ ok: true });
  });

  // ---- Results ----
  router.post('/results/publish', async (req, res) => {
    if (await getSetting(db, 'competition_phase') === 'registration') throw new HttpError(409, 'Voting has not happened yet.');
    if ((await votingState(db)).open) throw new HttpError(409, 'Close voting before publishing results.');
    if (await getSetting(db, 'results_published_at')) throw new HttpError(409, 'Results for this round are already published.');
    const standings = await db.prepare(`SELECT position, code, stage_name AS name, total_votes AS votes FROM contestants
      WHERE status = 'approved' ORDER BY position`).all();
    if (standings.length === 0) throw new HttpError(409, 'There are no contestants to publish.');
    const at = nowIso();
    await tx(db, async () => {
      await setSetting(db, 'voting_status', 'closed');
      await db.prepare('INSERT INTO results (competition, published_at, standings) VALUES (?, ?, ?)')
        .run(await getSetting(db, 'competition_name'), at, JSON.stringify(standings));
      await setSetting(db, 'results_published_at', at);
      await audit(ctx, req.user.id, 'results.publish', `${standings.length} contestants`);
    });
    await publishActivity(ctx, { kind: 'announcement', message: `Final results are in. Congratulations to ${standings[0].name}!` });
    ctx.bus.publish('competition', {});
    res.status(201).json({ publishedAt: at });
  });

  // Records of earlier editions, so past winners stay on the history page.
  router.post('/results/history', async (req, res) => {
    const competition = clean(req.body?.competition, 120);
    const winner = clean(req.body?.winner, 100);
    const date = isoOrEmpty(req.body?.date, 'Date');
    if (competition.length < 3 || winner.length < 2 || !date) throw new HttpError(400, 'Enter the edition, its winner and the date.');
    const standings = [{ position: 1, code: null, name: winner, votes: null }];
    await db.prepare('INSERT INTO results (competition, published_at, standings) VALUES (?, ?, ?)').run(competition, date, JSON.stringify(standings));
    await audit(ctx, req.user.id, 'results.history', `${competition}: ${winner}`);
    res.status(201).json({ ok: true });
  });

  router.delete('/results/:id', async (req, res) => {
    await db.prepare('DELETE FROM results WHERE id = ?').run(req.params.id);
    await audit(ctx, req.user.id, 'results.delete', `#${req.params.id}`);
    res.json({ ok: true });
  });

  // ---- Reports ----
  router.get('/export/contestants.csv', async (req, res) => {
    const rows = await db.prepare(`SELECT *, (SELECT COALESCE(SUM(quantity), 0) FROM vote_adjustments a WHERE a.contestant_id = contestants.id) AS adjusted_votes
      FROM contestants ORDER BY COALESCE(position, 999999), id`).all();
    await audit(ctx, req.user.id, 'export.contestants');
    sendCsv(res, 'mbgn-contestants.csv',
      ['Position', 'Code', 'Stage name', 'Full name', 'Status', 'Total votes', 'Votes added by admins', 'Email', 'Phone', 'WhatsApp', 'State', 'Location', 'Category', 'Registered', 'Approved'],
      rows.map((c) => [c.position, c.code, c.stage_name, c.full_name, c.status, c.total_votes, c.adjusted_votes, c.email, c.phone, c.whatsapp, c.state, c.location, c.category, c.created_at, c.approved_at]));
  });

  router.get('/export/votes.csv', async (req, res) => {
    const rows = await db.prepare(`SELECT v.*, c.code, c.stage_name, p.email FROM votes v
      JOIN contestants c ON c.id = v.contestant_id
      LEFT JOIN payments p ON p.id = v.payment_id ORDER BY v.id`).all();
    await audit(ctx, req.user.id, 'export.votes');
    sendCsv(res, 'mbgn-votes.csv',
      ['Receipt', 'Date', 'Contestant code', 'Contestant', 'Votes', 'Status', 'Via voting link', 'Receipt email', 'Void reason'],
      rows.map((v) => [v.receipt_no, v.created_at, v.code, v.stage_name, v.quantity, v.status, v.via_link ? 'yes' : 'no', v.email, v.void_reason]));
  });

  router.get('/export/payments.csv', async (req, res) => {
    const rows = await db.prepare('SELECT p.* FROM payments p ORDER BY p.id').all();
    await audit(ctx, req.user.id, 'export.payments');
    sendCsv(res, 'mbgn-payments.csv',
      ['Reference', 'Created', 'Paid', 'Voter name', 'Receipt email', 'Votes', 'Amount (NGN)', 'Status', 'Votes counted', 'Provider', 'Provider reference'],
      rows.map((p) => [p.reference, p.created_at, p.paid_at, p.voter_name, p.email, p.vote_quantity, p.amount, p.status, p.votes_status, p.provider, p.provider_ref]));
  });

  router.get('/outbox', async (_req, res) => {
    res.json(await db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 100').all());
  });

  // ---- The signed-in admin's own login ----
  router.put('/account', async (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase();
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const current = String(req.body?.currentPassword ?? '').slice(0, 200);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, user.password_hash)) throw new HttpError(400, 'Your current password is not right.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (newPassword && (newPassword.length < 8 || newPassword.length > 200)) throw new HttpError(400, 'Choose a password of at least 8 characters.');

    await db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?')
      .run(email, newPassword ? hashPassword(newPassword) : user.password_hash, user.id)
      .catch((err) => { throw err.code === '23505' ? new HttpError(409, 'Another account already uses that email address.') : err; });
    // A new password signs out every other browser, in case the old one had leaked.
    if (newPassword) await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, sessionHash(ctx, req));
    const changes = [email !== user.email ? `email changed to ${email}` : null, newPassword ? 'password changed' : null].filter(Boolean);
    await audit(ctx, user.id, 'account.update', changes.join(', ') || 'no change');
    res.json({ email });
  });

  router.get('/audit', async (_req, res) => {
    const rows = await db.prepare(`SELECT a.action, a.details, a.created_at, u.email FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200`).all();
    res.json(rows);
  });

  return router;
}
