import {
  HttpError, asyncRouter, rateLimit, requireUser,
} from '../auth.js';
import { movementBaseline, photoUrl } from '../competition.js';
import { nowIso } from '../db.js';
import { groupById } from '../groups.js';
import {
  emailReceipt, paymentView, settlePayment, startPayment,
} from '../payments.js';
import { normalizeCode } from './public.js';

function maskEmail(email) {
  if (!email) return null;
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

export function votingRouter(ctx) {
  const { db, config } = ctx;
  const router = asyncRouter();
  const scaled = (max) => max * config.rateLimitScale;

  // Anyone holding this long random reference may follow the payment, because supporters have no accounts.
  const findPayment = async (req) => {
    const payment = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(req.params.reference);
    if (!payment) throw new HttpError(404, 'Payment not found.');
    return payment;
  };

  // ---- Voting ----
  router.post('/votes/pay', rateLimit({ windowMs: 60000, max: scaled(60) }), async (req, res) => {
    const { code, quantity, voterName, viaLink } = req.body ?? {};
    res.status(201).json(await startPayment(ctx, {
      code: normalizeCode(code), quantity, voterName, email: req.user?.email, viaLink: Boolean(viaLink), ip: req.ip,
    }));
  });

  // ---- Following a payment ----
  router.get('/payments/:reference', async (req, res) => {
    res.json(await paymentView(db, await findPayment(req)));
  });

  // Called by the return page. Reports what the provider says, whatever the browser claims.
  router.post('/payments/:reference/verify', rateLimit({ windowMs: 60000, max: scaled(120) }), async (req, res, next) => {
    try {
      await findPayment(req);
      res.json(await paymentView(db, await settlePayment(ctx, req.params.reference)));
    } catch (err) {
      next(err instanceof HttpError ? err : new HttpError(502, 'We could not reach the payment provider. Please try again shortly.'));
    }
  });

  router.post('/payments/:reference/receipt-email', rateLimit({ windowMs: 3600000, max: scaled(20) }), async (req, res) => {
    await emailReceipt(ctx, await findPayment(req), req.body?.email);
    res.json({ ok: true });
  });

  router.get('/receipts/payment/:reference', async (req, res) => {
    const payment = await findPayment(req);
    if (payment.status !== 'paid') throw new HttpError(404, 'A receipt is issued once payment is confirmed.');
    const contestant = await db.prepare('SELECT code, stage_name FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
    const outcomes = { counted: 'Counted', held: 'Held for refund' };
    res.json({
      kind: 'payment',
      number: payment.reference,
      date: payment.paid_at,
      customer: maskEmail(payment.email),
      lines: [
        ...(payment.voter_name ? [['Voter', payment.voter_name]] : []),
        ['Contestant', `${contestant.stage_name} (${contestant.code})`],
        ['Votes', String(payment.vote_quantity)],
        ['Status', outcomes[payment.votes_status] ?? 'Pending'],
        ['Amount paid', `NGN ${payment.amount.toLocaleString('en-NG')}`],
        ['Paid with', payment.payment_method ?? payment.provider],
      ],
    });
  });

  // For the admin panel. Supporters get the payment receipt.
  router.get('/receipts/vote/:receiptNo', requireUser, async (req, res) => {
    const vote = await db.prepare(`SELECT v.*, c.code, c.stage_name, p.email FROM votes v
      JOIN contestants c ON c.id = v.contestant_id
      LEFT JOIN payments p ON p.id = v.payment_id WHERE v.receipt_no = ?`).get(req.params.receiptNo);
    if (!vote || req.user.role !== 'admin') throw new HttpError(404, 'Receipt not found.');
    res.json({
      kind: 'vote',
      number: vote.receipt_no,
      date: vote.created_at,
      customer: maskEmail(vote.email),
      lines: [
        ['Contestant', `${vote.stage_name} (${vote.code})`],
        ['Votes cast', String(vote.quantity)],
        ['Status', vote.status === 'valid' ? 'Counted' : `Voided: ${vote.void_reason}`],
      ],
    });
  });

  // Simulated checkout, only when no real provider is configured.
  if (ctx.provider.name === 'simulator') {
    router.post('/simulator/:reference/pay', async (req, res) => {
      await findPayment(req);
      await db.prepare('UPDATE simulated_provider SET paid_at = ? WHERE reference = ? AND paid_at IS NULL').run(nowIso(), req.params.reference);
      res.json({ ok: true });
    });
  }

  return router;
}

// The contestant dashboard: only ever the recognised contestant's own data.
export function contestantRouter(ctx) {
  const { db } = ctx;
  const router = asyncRouter();
  router.use(requireUser);

  async function ownContestant(req) {
    const row = await db.prepare('SELECT * FROM contestants WHERE user_id = ?').get(req.user.id);
    if (!row) throw new HttpError(403, 'This area is for contestants.');
    return row;
  }

  router.get('/dashboard', async (req, res) => {
    const c = await ownContestant(req);
    const group = ['pending', 'approved'].includes(c.status) ? await groupById(db, c.whatsapp_group_id) : null;
    const base = {
      status: c.status,
      statusReason: c.status_reason,
      verification: c.verification,
      followerResults: c.follower_results ? JSON.parse(c.follower_results) : [],
      whatsappGroup: group ? { name: group.name, url: group.invite_url } : null,
      name: c.stage_name,
      fullName: c.full_name,
      photoUrl: photoUrl(c),
      state: c.state,
      location: c.location,
      code: c.code,
    };
    const notifications = (await db.prepare('SELECT id, kind, message, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id))
      .map((n) => ({ id: n.id, kind: n.kind, message: n.message, read: Boolean(n.read_at), createdAt: n.created_at }));
    if (c.status !== 'approved' && !c.code) return res.json({ ...base, notifications });

    const dayAgo = new Date(Date.now() - 864e5).toISOString();
    const newVotes = (await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE contestant_id = ? AND status = 'valid' AND created_at >= ?").get(c.id, dayAgo)).n;
    // Quantities and times only. Never who voted.
    const history = (await db.prepare("SELECT quantity, created_at, via_link FROM votes WHERE contestant_id = ? AND status = 'valid' ORDER BY id DESC LIMIT 30").all(c.id))
      .map((v) => ({ quantity: v.quantity, createdAt: v.created_at, viaLink: Boolean(v.via_link) }));

    const days = [];
    for (let i = 13; i >= 0; i -= 1) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    const byDay = new Map((await db.prepare(`SELECT substr(created_at, 1, 10) AS day, SUM(quantity) AS votes FROM votes
      WHERE contestant_id = ? AND status = 'valid' AND created_at >= ? GROUP BY day`).all(c.id, days[0])).map((r) => [r.day, r.votes]));
    const daily = days.map((day) => ({ day, votes: byDay.get(day) ?? 0 }));

    const { grand } = await db.prepare("SELECT COALESCE(SUM(total_votes), 0) AS grand FROM contestants WHERE status = 'approved'").get();
    const ahead = c.position > 1
      ? await db.prepare("SELECT total_votes FROM contestants WHERE status = 'approved' AND position = ?").get(c.position - 1)
      : null;
    const fromLink = (await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM votes WHERE contestant_id = ? AND status = 'valid' AND via_link = 1").get(c.id)).n;
    const visits = (await db.prepare('SELECT COALESCE(SUM(visits), 0) AS n FROM referral_visits WHERE contestant_id = ?').get(c.id)).n;
    const before = (await movementBaseline(db)).get(c.id);

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

  router.post('/notifications/read', async (req, res) => {
    await db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
    res.json({ ok: true });
  });

  return router;
}
