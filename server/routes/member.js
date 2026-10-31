import express from 'express';
import { HttpError, rateLimit, requireUser } from '../auth.js';
import { movementBaseline, photoUrl } from '../competition.js';
import { nowIso } from '../db.js';
import {
  paymentView, settlePayment, startDirectPayment, startFundAndVote, startPurchase,
} from '../payments.js';
import { castVote } from '../votes.js';
import { normalizeCode, openWallet } from './public.js';

function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

export function walletRouter(ctx) {
  const { db, config } = ctx;
  const router = express.Router();
  const scaled = (max) => max * config.rateLimitScale;

  // Anyone holding this long random reference may follow the payment. That keeps the return
  // page working for direct payers, who have no wallet, and if a cookie has gone missing.
  const findPayment = (req) => {
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(req.params.reference);
    if (!payment) throw new HttpError(404, 'Payment not found.');
    return payment;
  };

  // ---- Voting choices ----
  router.post('/votes/pay', rateLimit({ windowMs: 60000, max: scaled(60) }), async (req, res, next) => {
    try {
      const { code, quantity, email, viaLink } = req.body ?? {};
      res.status(201).json(await startDirectPayment(ctx, {
        code: normalizeCode(code), quantity, email: req.user?.email ?? email, viaLink: Boolean(viaLink), ip: req.ip,
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/votes/fund', rateLimit({ windowMs: 60000, max: scaled(60) }), async (req, res, next) => {
    try {
      const { code, quantity, fund, email, phone, viaLink } = req.body ?? {};
      const user = req.user ?? openWallet(ctx, res, { email, phone }).user;
      res.status(201).json(await startFundAndVote(ctx, {
        user, code: normalizeCode(code), quantity, fund, viaLink: Boolean(viaLink), ip: req.ip,
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/votes', requireUser, rateLimit({ windowMs: 60000, max: 60, key: (req) => `vote:${req.user.id}` }), (req, res) => {
    const { code, quantity, idempotencyKey, viaLink } = req.body ?? {};
    res.status(201).json(castVote(ctx, {
      user: req.user,
      code: normalizeCode(code),
      quantity,
      idempotencyKey,
      viaLink: Boolean(viaLink),
      ip: req.ip,
    }));
  });

  // ---- Following a payment ----
  router.get('/payments/:reference', (req, res) => {
    res.json(paymentView(db, findPayment(req), req.user));
  });

  // Called by the return page. Reports what the provider says, whatever the browser claims.
  router.post('/payments/:reference/verify', rateLimit({ windowMs: 60000, max: scaled(120) }), async (req, res, next) => {
    try {
      findPayment(req);
      res.json(paymentView(db, await settlePayment(ctx, req.params.reference), req.user));
    } catch (err) {
      next(err instanceof HttpError ? err : new HttpError(502, 'We could not reach the payment provider. Please try again shortly.'));
    }
  });

  router.get('/receipts/payment/:reference', (req, res) => {
    const payment = findPayment(req);
    if (payment.status !== 'paid') throw new HttpError(404, 'A receipt is issued once payment is confirmed.');
    const contestant = payment.vote_contestant_id
      ? db.prepare('SELECT code, stage_name FROM contestants WHERE id = ?').get(payment.vote_contestant_id)
      : null;
    const outcomes = { counted: 'Counted', kept: 'Could not be cast: credits kept in wallet', held: 'Held for refund' };
    res.json({
      kind: 'payment',
      number: payment.reference,
      date: payment.paid_at,
      customer: maskEmail(payment.email),
      lines: [
        ...(contestant ? [
          ['Contestant', `${contestant.stage_name} (${contestant.code})`],
          ['Votes', String(payment.vote_quantity)],
          ['Status', outcomes[payment.votes_status] ?? 'Pending'],
        ] : []),
        ...(payment.mode === 'wallet' ? [['Credits added to wallet', String(payment.credits)]] : []),
        ['Amount paid', `NGN ${payment.amount.toLocaleString('en-NG')}`],
        ['Paid with', payment.payment_method ?? payment.provider],
      ],
    });
  });

  router.get('/receipts/vote/:receiptNo', requireUser, (req, res) => {
    const vote = db.prepare(`SELECT v.*, c.code, c.stage_name FROM votes v
      JOIN contestants c ON c.id = v.contestant_id WHERE v.receipt_no = ?`).get(req.params.receiptNo);
    if (!vote || (vote.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Receipt not found.');
    res.json({
      kind: 'vote',
      number: vote.receipt_no,
      date: vote.created_at,
      customer: maskEmail(vote.supporter_email),
      lines: [
        ['Contestant', `${vote.stage_name} (${vote.code})`],
        ['Votes cast', String(vote.quantity)],
        ['Status', vote.status === 'valid' ? 'Counted' : `Voided: ${vote.void_reason}`],
      ],
    });
  });

  // ---- The wallet itself ----
  router.get('/wallet', requireUser, (req, res) => {
    const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
    const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    const votes = db.prepare(`SELECT v.receipt_no, v.quantity, v.status, v.created_at, c.code, c.stage_name FROM votes v
      JOIN contestants c ON c.id = v.contestant_id WHERE v.user_id = ? ORDER BY v.id DESC LIMIT 100`).all(req.user.id);
    res.json({
      balance: credits,
      email: req.user.email,
      payments: payments.map((p) => paymentView(db, p)),
      votes: votes.map((v) => ({
        receiptNo: v.receipt_no, quantity: v.quantity, status: v.status, createdAt: v.created_at, code: v.code, name: v.stage_name,
      })),
    });
  });

  router.post('/wallet/purchases', requireUser, rateLimit({ windowMs: 60000, max: 15, key: (req) => `buy:${req.user.id}` }), async (req, res, next) => {
    try {
      const { packageId, votes, returnTo } = req.body ?? {};
      res.status(201).json(await startPurchase(ctx, { user: req.user, packageId, votes, returnTo, ip: req.ip }));
    } catch (err) {
      next(err);
    }
  });

  // Simulated checkout, only when no real provider is configured.
  if (ctx.provider.name === 'simulator') {
    router.post('/simulator/:reference/pay', (req, res) => {
      findPayment(req);
      db.prepare('UPDATE simulated_provider SET paid_at = ? WHERE reference = ? AND paid_at IS NULL').run(nowIso(), req.params.reference);
      res.json({ ok: true });
    });
  }

  return router;
}

// The contestant dashboard: only ever the recognised contestant's own data.
export function contestantRouter(ctx) {
  const { db } = ctx;
  const router = express.Router();
  router.use(requireUser);

  function ownContestant(req) {
    const row = db.prepare('SELECT * FROM contestants WHERE user_id = ?').get(req.user.id);
    if (!row) throw new HttpError(403, 'This area is for contestants.');
    return row;
  }

  router.get('/dashboard', (req, res) => {
    const c = ownContestant(req);
    const base = {
      status: c.status,
      statusReason: c.status_reason,
      name: c.stage_name,
      fullName: c.full_name,
      photoUrl: photoUrl(c),
      state: c.state,
      location: c.location,
      code: c.code,
    };
    const notifications = db.prepare('SELECT id, kind, message, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id)
      .map((n) => ({ id: n.id, kind: n.kind, message: n.message, read: Boolean(n.read_at), createdAt: n.created_at }));
    if (c.status !== 'approved' && !c.code) return res.json({ ...base, notifications });

    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const newVotes = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE contestant_id = ? AND status = 'valid' AND created_at >= ?").get(c.id, dayAgo).n;
    // Quantities and times only. Never who voted.
    const history = db.prepare("SELECT quantity, created_at, via_link FROM votes WHERE contestant_id = ? AND status = 'valid' ORDER BY id DESC LIMIT 30").all(c.id)
      .map((v) => ({ quantity: v.quantity, createdAt: v.created_at, viaLink: Boolean(v.via_link) }));

    const days = [];
    for (let i = 13; i >= 0; i -= 1) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    const byDay = new Map(db.prepare(`SELECT substr(created_at, 1, 10) AS day, SUM(quantity) AS votes FROM votes
      WHERE contestant_id = ? AND status = 'valid' AND created_at >= ? GROUP BY day`).all(c.id, days[0]).map((r) => [r.day, r.votes]));
    const daily = days.map((day) => ({ day, votes: byDay.get(day) ?? 0 }));

    const { grand } = db.prepare("SELECT COALESCE(SUM(total_votes), 0) AS grand FROM contestants WHERE status = 'approved'").get();
    const ahead = c.position > 1
      ? db.prepare("SELECT total_votes FROM contestants WHERE status = 'approved' AND position = ?").get(c.position - 1)
      : null;
    const fromLink = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE contestant_id = ? AND status = 'valid' AND via_link = 1").get(c.id).n;
    const visits = db.prepare('SELECT COALESCE(SUM(visits), 0) AS n FROM referral_visits WHERE contestant_id = ?').get(c.id).n;
    const before = movementBaseline(db).get(c.id);

    res.json({
      ...base,
      votingLink: `${ctx.config.publicUrl}/c/${c.code}`,
      totalVotes: c.total_votes,
      position: c.position,
      previousPosition: c.previous_position,
      movement24h: before == null || c.position == null ? null : before - c.position,
      newVotes,
      history,
      daily,
      stats: {
        shareOfVotes: grand > 0 ? c.total_votes / grand : 0,
        votesToNextPosition: ahead ? ahead.total_votes - c.total_votes + 1 : 0,
        bestDay: Math.max(...daily.map((d) => d.votes)),
        linkVisits: visits,
        votesFromLink: fromLink,
      },
      notifications,
    });
  });

  router.post('/notifications/read', (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
    res.json({ ok: true });
  });

  return router;
}
