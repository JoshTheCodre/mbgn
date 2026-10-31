import crypto from 'node:crypto';
import { HttpError, hashIp } from './auth.js';
import {
  notifyUser, publishActivity, raiseFlag, recomputeRanks, votingState,
} from './competition.js';
import { getSetting, nowIso, tx } from './db.js';

export const MAX_VOTES_PER_ACTION = 100000;

const plural = (n, word) => `${n.toLocaleString('en-NG')} ${word}${n === 1 ? '' : 's'}`;

function positions(db) {
  const rows = db.prepare("SELECT id, position FROM contestants WHERE status = 'approved'").all();
  return new Map(rows.map((r) => [r.id, r.position]));
}

function insertVote(ctx, { contestant, quantity, userId, email, idempotencyKey, paymentId, viaLink, ipHash, createdAt }) {
  const { db } = ctx;
  const receiptNo = `VOTE-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const { lastInsertRowid: voteId } = db.prepare(`
    INSERT INTO votes (receipt_no, user_id, supporter_email, payment_id, contestant_id, quantity, idempotency_key, via_link, ip_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(receiptNo, userId, email, paymentId, contestant.id, quantity, idempotencyKey, viaLink ? 1 : 0, ipHash, createdAt);
  db.prepare('UPDATE contestants SET total_votes = total_votes + ?, last_vote_at = ? WHERE id = ?')
    .run(quantity, createdAt, contestant.id);
  recomputeRanks(db);
  screenVote(ctx, { email, phone: null, userId, contestant, quantity, ipHash, createdAt });
  return voteId;
}

// Spends wallet credits. `payment` is set when a confirmed payment is voting for itself: it was
// started while voting was open, so it still counts if voting closes before the provider confirms.
export function castVote(ctx, { user, code, quantity, idempotencyKey, viaLink, ip, ipHash: givenIpHash, payment = null }) {
  const { db } = ctx;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_VOTES_PER_ACTION) {
    throw new HttpError(400, `Choose between 1 and ${MAX_VOTES_PER_ACTION.toLocaleString('en-NG')} votes.`);
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 80) {
    throw new HttpError(400, 'Missing vote request id.');
  }
  if (user.frozen) throw new HttpError(403, 'This wallet is under review and cannot vote right now.');

  const ipHash = givenIpHash ?? hashIp(ctx.config, ip);

  const outcome = tx(db, () => {
    // A retried request returns the original vote instead of spending credits twice.
    const repeat = db.prepare('SELECT * FROM votes WHERE user_id = ? AND idempotency_key = ?').get(user.id, idempotencyKey);
    if (repeat) return { vote: repeat, duplicate: true };

    if (payment) {
      if (getSetting(db, 'results_published_at')) throw new HttpError(409, 'Results are already final.');
    } else {
      const state = votingState(db);
      if (!state.open) throw new HttpError(409, state.message);
    }

    const contestant = db.prepare('SELECT * FROM contestants WHERE code = ?').get(code);
    if (!contestant || contestant.status !== 'approved') {
      throw new HttpError(404, 'No active contestant has that code.');
    }

    const spent = db.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
      .run(quantity, user.id, quantity);
    if (spent.changes !== 1) {
      const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
      throw new HttpError(402, 'You do not have enough voting credits.', { balance: credits, needed: quantity - credits });
    }

    const baseline = ctx.activity.needsBaseline() ? positions(db) : null;
    const createdAt = nowIso();
    const voteId = insertVote(ctx, {
      contestant, quantity, userId: user.id, email: user.email, idempotencyKey, paymentId: payment?.id ?? null, viaLink, ipHash, createdAt,
    });

    const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
    db.prepare(`INSERT INTO wallet_ledger (user_id, delta, balance_after, kind, vote_id, created_at)
      VALUES (?, ?, ?, 'vote', ?, ?)`).run(user.id, -quantity, credits, voteId, createdAt);

    return {
      vote: db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId),
      contestantId: contestant.id,
      baseline,
    };
  });

  if (!outcome.duplicate) ctx.activity.add(outcome.contestantId, quantity, outcome.baseline);

  const contestant = db.prepare('SELECT code, stage_name, total_votes, position FROM contestants WHERE id = ?').get(outcome.vote.contestant_id);
  const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
  return {
    receiptNo: outcome.vote.receipt_no,
    quantity: outcome.vote.quantity,
    balance: credits,
    contestant: {
      code: contestant.code,
      name: contestant.stage_name,
      totalVotes: contestant.total_votes,
      position: contestant.position,
    },
  };
}

// Votes from a direct payment, with no wallet involved. Runs once per payment, however many
// webhooks and browser checks race. If the contestant has since been removed, or results are
// already final, the money is held for an admin to refund.
export function recordDirectVotes(ctx, payment, result) {
  const { db } = ctx;
  const outcome = tx(db, () => {
    const at = nowIso();
    const flip = db.prepare(`UPDATE payments SET status = 'paid', paid_amount = ?, paid_at = ?, payment_method = ?,
      provider_ref = COALESCE(?, provider_ref) WHERE id = ? AND status IN ('pending', 'failed')`)
      .run(result.amountPaid, at, result.method, result.providerRef, payment.id);
    if (flip.changes !== 1) return null;

    const contestant = db.prepare('SELECT * FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
    if (contestant.status !== 'approved' || getSetting(db, 'results_published_at')) {
      db.prepare("UPDATE payments SET votes_status = 'held' WHERE id = ?").run(payment.id);
      raiseFlag(ctx, {
        kind: 'votes_held',
        severity: 'high',
        details: `${payment.reference}: NGN ${payment.amount} from ${payment.email} was paid for ${contestant.code}, but the votes could not be counted. Refund it in Monnify.`,
        contestantId: contestant.id,
        paymentId: payment.id,
      });
      return { held: true, contestant };
    }

    const baseline = ctx.activity.needsBaseline() ? positions(db) : null;
    insertVote(ctx, {
      contestant,
      quantity: payment.vote_quantity,
      userId: null,
      email: payment.email,
      idempotencyKey: null,
      paymentId: payment.id,
      viaLink: Boolean(payment.via_link),
      ipHash: payment.ip_hash,
      createdAt: at,
    });
    db.prepare("UPDATE payments SET votes_status = 'counted' WHERE id = ?").run(payment.id);
    return { contestant, baseline };
  });

  if (outcome && !outcome.held) ctx.activity.add(outcome.contestant.id, payment.vote_quantity, outcome.baseline);
  return outcome;
}

// Rule-based anti-fraud. Flags go to the admin review queue; nothing is blocked automatically.
function screenVote(ctx, { email, userId, contestant, quantity, ipHash, createdAt }) {
  const { db } = ctx;
  const minuteAgo = new Date(Date.parse(createdAt) - 60000).toISOString();
  const hourAgo = new Date(Date.parse(createdAt) - 3600000).toISOString();

  const recent = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE supporter_email = ? AND created_at >= ?').get(email, minuteAgo).n;
  if (recent >= 15) {
    raiseFlag(ctx, {
      kind: 'rapid_voting',
      details: `${recent} separate votes from ${email} within a minute.`,
      userId,
    });
  }

  const threshold = Number(getSetting(db, 'large_vote_threshold'));
  if (threshold > 0 && quantity >= threshold) {
    raiseFlag(ctx, {
      kind: 'large_vote',
      severity: 'low',
      details: `${quantity} votes cast at once for ${contestant.code} by ${email}.`,
      userId,
      contestantId: contestant.id,
    });
  }

  const sharedIp = db.prepare(`SELECT COUNT(DISTINCT supporter_email) AS n FROM votes
    WHERE contestant_id = ? AND ip_hash = ? AND created_at >= ?`).get(contestant.id, ipHash, hourAgo).n;
  if (sharedIp >= 5) {
    raiseFlag(ctx, {
      kind: 'shared_network',
      severity: 'high',
      details: `${sharedIp} different supporters on one network voted for ${contestant.code} within an hour.`,
      contestantId: contestant.id,
    });
  }

  const user = userId ? db.prepare('SELECT phone FROM users WHERE id = ?').get(userId) : null;
  const samePerson = userId === contestant.user_id
    || email.toLowerCase() === contestant.email.toLowerCase()
    || (user?.phone && (user.phone === contestant.phone || user.phone === contestant.whatsapp));
  if (samePerson) {
    raiseFlag(ctx, {
      kind: 'self_vote',
      details: `${email} appears to belong to ${contestant.code}, who received ${quantity} votes from it.`,
      userId,
      contestantId: contestant.id,
    });
  }
}

// Gathers votes over a short window so the public sees "Stella received 15 new votes"
// instead of a stream of single votes, and nothing can tie a message to one supporter.
export function createActivityAggregator(ctx) {
  let pending = new Map();
  let baseline = null;
  let timer = null;

  function flush() {
    timer = null;
    const batch = pending;
    const before = baseline;
    pending = new Map();
    baseline = null;
    if (batch.size === 0) return;

    const { db } = ctx;
    const after = db.prepare("SELECT id, user_id, code, stage_name, position FROM contestants WHERE status = 'approved'").all();

    for (const row of after) {
      const votes = batch.get(row.id);
      const was = before?.get(row.id);
      const moved = was != null && row.position != null ? was - row.position : 0;

      if (votes) {
        publishActivity(ctx, {
          kind: 'votes',
          contestantId: row.id,
          code: row.code,
          amount: votes,
          message: `${row.stage_name} received ${plural(votes, 'new vote')}.`,
        });
        notifyUser(ctx, row.user_id, 'votes', `Congratulations! You just received ${plural(votes, 'new vote')}.`);
        if (moved > 0) {
          publishActivity(ctx, {
            kind: 'climb',
            contestantId: row.id,
            code: row.code,
            amount: moved,
            message: `${row.stage_name} just moved up ${plural(moved, 'position')}.`,
          });
        }
      }

      if (moved > 0) notifyUser(ctx, row.user_id, 'rank', `You climbed to position ${row.position}. Up ${plural(moved, 'place')}!`);
      if (moved < 0) notifyUser(ctx, row.user_id, 'rank', `You slipped to position ${row.position}. Share your link to climb back.`);
    }
    ctx.bus.publish('leaderboard', { updatedAt: nowIso() });
  }

  return {
    needsBaseline: () => baseline === null,
    add(contestantId, quantity, ranksBeforeVote) {
      if (ranksBeforeVote && baseline === null) baseline = ranksBeforeVote;
      pending.set(contestantId, (pending.get(contestantId) ?? 0) + quantity);
      if (!timer) timer = setTimeout(flush, ctx.config.activityWindowMs);
    },
    flushNow() {
      if (timer) clearTimeout(timer);
      flush();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function voidVote(ctx, { voteId, reason, refund, adminId }) {
  const { db } = ctx;
  return tx(db, () => {
    const vote = db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId);
    if (!vote) throw new HttpError(404, 'Vote not found.');
    if (vote.status === 'void') throw new HttpError(409, 'This vote is already void.');
    const at = nowIso();
    db.prepare("UPDATE votes SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?").run(at, reason, voteId);
    db.prepare('UPDATE contestants SET total_votes = total_votes - ? WHERE id = ?').run(vote.quantity, vote.contestant_id);
    if (refund && vote.user_id) {
      db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(vote.quantity, vote.user_id);
      const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(vote.user_id);
      db.prepare(`INSERT INTO wallet_ledger (user_id, delta, balance_after, kind, vote_id, created_at)
        VALUES (?, ?, ?, 'refund', ?, ?)`).run(vote.user_id, vote.quantity, credits, voteId, at);
    }
    recomputeRanks(db);
    db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
      .run(adminId, 'vote.void', `${vote.receipt_no}: ${reason}${refund ? ' (credits refunded)' : ''}`, at);
    return vote;
  });
}
