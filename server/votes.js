import crypto from 'node:crypto';
import { HttpError } from './auth.js';
import {
  notifyUser, publishActivity, raiseFlag, recomputeRanks,
} from './competition.js';
import { getSetting, nowIso, tx } from './db.js';

const plural = (n, word) => `${n.toLocaleString('en-NG')} ${word}${n === 1 ? '' : 's'}`;

async function positions(db) {
  const rows = await db.prepare("SELECT id, position FROM contestants WHERE status = 'approved'").all();
  return new Map(rows.map((r) => [r.id, r.position]));
}

async function insertVote(ctx, { contestant, quantity, paymentId, viaLink, ipHash, createdAt }) {
  const { db } = ctx;
  const receiptNo = `VOTE-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  await db.prepare(`
    INSERT INTO votes (receipt_no, payment_id, contestant_id, quantity, via_link, ip_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(receiptNo, paymentId, contestant.id, quantity, viaLink ? 1 : 0, ipHash, createdAt);
  await db.prepare('UPDATE contestants SET total_votes = total_votes + ?, last_vote_at = ? WHERE id = ?')
    .run(quantity, createdAt, contestant.id);
  await recomputeRanks(db);
}

// Votes from a confirmed payment. Runs once per payment, however many webhooks and browser
// checks race. A payment started while voting was open still counts if voting has since closed.
// If the contestant has since been removed, or results are already final, the money is held
// for an admin to refund.
export async function recordPaidVotes(ctx, payment, result) {
  const { db } = ctx;
  const outcome = await tx(db, async () => {
    const at = nowIso();
    const flip = await db.prepare(`UPDATE payments SET status = 'paid', paid_amount = ?, paid_at = ?, payment_method = ?,
      provider_ref = COALESCE(?, provider_ref) WHERE id = ? AND status IN ('pending', 'failed')`)
      .run(result.amountPaid, at, result.method, result.providerRef, payment.id);
    if (flip.changes !== 1) return null;

    const contestant = await db.prepare('SELECT * FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
    if (contestant.status !== 'approved' || await getSetting(db, 'results_published_at')) {
      await db.prepare("UPDATE payments SET votes_status = 'held' WHERE id = ?").run(payment.id);
      await raiseFlag(ctx, {
        kind: 'votes_held',
        severity: 'high',
        details: `${payment.reference}: NGN ${payment.amount} was paid for ${contestant.code}, but the votes could not be counted. Refund it in Paystack.`,
        contestantId: contestant.id,
        paymentId: payment.id,
      });
      return { held: true, contestant };
    }

    const baseline = ctx.activity.needsBaseline() ? await positions(db) : null;
    await insertVote(ctx, {
      contestant,
      quantity: payment.vote_quantity,
      paymentId: payment.id,
      viaLink: Boolean(payment.via_link),
      ipHash: payment.ip_hash,
      createdAt: at,
    });
    await db.prepare("UPDATE payments SET votes_status = 'counted' WHERE id = ?").run(payment.id);
    return { contestant, baseline, at };
  });

  // Done after the writer's turn ends, so other payments aren't kept waiting. The votes are
  // already safely counted, so a failure here must not make the payment look like it failed.
  if (outcome && !outcome.held) {
    try {
      await screenVote(ctx, {
        email: payment.email, contestant: outcome.contestant, quantity: payment.vote_quantity, ipHash: payment.ip_hash, createdAt: outcome.at,
      });
      await ctx.activity.add(outcome.contestant.id, payment.vote_quantity, outcome.baseline);
    } catch (err) {
      console.error(`After counting ${payment.reference}:`, err.message);
    }
  }
  return outcome;
}

// Rule-based anti-fraud. Flags go to the admin review queue; nothing is blocked automatically.
// Supporters give no details, so the network is the main signal. Mobile carriers put many
// people behind one address, so these limits are high and a flag only asks for a closer look.
async function screenVote(ctx, { email, contestant, quantity, ipHash, createdAt }) {
  const { db } = ctx;
  const minuteAgo = new Date(Date.parse(createdAt) - 60000).toISOString();
  const hourAgo = new Date(Date.parse(createdAt) - 3600000).toISOString();

  const recent = (await db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ? AND created_at >= ?').get(ipHash, minuteAgo)).n;
  if (recent >= 30) {
    await raiseFlag(ctx, {
      kind: 'rapid_voting',
      details: `${recent} separate payments from one network within a minute.`,
    });
  }

  const threshold = Number(await getSetting(db, 'large_vote_threshold'));
  if (threshold > 0 && quantity >= threshold) {
    await raiseFlag(ctx, {
      kind: 'large_vote',
      severity: 'low',
      details: `${quantity} votes paid for at once for ${contestant.code}.`,
      contestantId: contestant.id,
    });
  }

  const sharedIp = (await db.prepare(`SELECT COUNT(*) AS n FROM votes
    WHERE contestant_id = ? AND ip_hash = ? AND created_at >= ?`).get(contestant.id, ipHash, hourAgo)).n;
  if (sharedIp >= 20) {
    await raiseFlag(ctx, {
      kind: 'shared_network',
      details: `${sharedIp} separate payments from one network went to ${contestant.code} within an hour.`,
      contestantId: contestant.id,
    });
  }

  // Only known when the contestant paid from the browser they joined on.
  if (email && email.toLowerCase() === contestant.email.toLowerCase()) {
    await raiseFlag(ctx, {
      kind: 'self_vote',
      details: `${email} belongs to ${contestant.code}, who received ${quantity} votes from it.`,
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

  async function flush() {
    timer = null;
    const batch = pending;
    const before = baseline;
    pending = new Map();
    baseline = null;
    if (batch.size === 0) return;

    const { db } = ctx;
    const after = await db.prepare("SELECT id, user_id, code, stage_name, position FROM contestants WHERE status = 'approved'").all();

    for (const row of after) {
      const votes = batch.get(row.id);
      const was = before?.get(row.id);
      const moved = was != null && row.position != null ? was - row.position : 0;

      if (votes) {
        await publishActivity(ctx, {
          kind: 'votes',
          contestantId: row.id,
          code: row.code,
          amount: votes,
          message: `${row.stage_name} received ${plural(votes, 'new vote')}.`,
        });
        await notifyUser(ctx, row.user_id, 'votes', `Congratulations! You just received ${plural(votes, 'new vote')}.`);
        if (moved > 0) {
          await publishActivity(ctx, {
            kind: 'climb',
            contestantId: row.id,
            code: row.code,
            amount: moved,
            message: `${row.stage_name} just moved up ${plural(moved, 'position')}.`,
          });
        }
      }

      if (moved > 0) await notifyUser(ctx, row.user_id, 'rank', `You climbed to position ${row.position}. Up ${plural(moved, 'place')}!`);
      if (moved < 0) await notifyUser(ctx, row.user_id, 'rank', `You slipped to position ${row.position}. Share your link to climb back.`);
    }
    ctx.bus.publish('leaderboard', { updatedAt: nowIso() });
  }

  return {
    needsBaseline: () => baseline === null,
    async add(contestantId, quantity, ranksBeforeVote) {
      if (ranksBeforeVote && baseline === null) baseline = ranksBeforeVote;
      pending.set(contestantId, (pending.get(contestantId) ?? 0) + quantity);
      if (!ctx.config.activityWindowMs) {
        await flush();
        return;
      }
      if (!timer) timer = setTimeout(() => flush().catch((err) => console.error('Activity failed:', err.message)), ctx.config.activityWindowMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function voidVote(ctx, { voteId, reason, adminId }) {
  const { db } = ctx;
  return tx(db, async () => {
    const vote = await db.prepare('SELECT * FROM votes WHERE id = ?').get(voteId);
    if (!vote) throw new HttpError(404, 'Vote not found.');
    if (vote.status === 'void') throw new HttpError(409, 'This vote is already void.');
    const at = nowIso();
    await db.prepare("UPDATE votes SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?").run(at, reason, voteId);
    await db.prepare('UPDATE contestants SET total_votes = total_votes - ? WHERE id = ?').run(vote.quantity, vote.contestant_id);
    await recomputeRanks(db);
    await db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
      .run(adminId, 'vote.void', `${vote.receipt_no}: ${reason}`, at);
    return vote;
  });
}
