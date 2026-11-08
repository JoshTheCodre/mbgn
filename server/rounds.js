import { audit, notifyUser, publishActivity, recomputeRanks } from './competition.js';
import { getSetting, nowIso, tx } from './db.js';

export function roundView(r) {
  return {
    id: r.id,
    name: r.name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    keepTop: r.keep_top,
    minVotes: r.min_votes,
    votesCounted: r.votes_counted,
    probation: r.probation,
    closedAt: r.closed_at,
    result: r.result ? JSON.parse(r.result) : null,
  };
}

export const currentRound = (db) => db.prepare('SELECT * FROM rounds WHERE closed_at IS NULL ORDER BY ends_at LIMIT 1').get();

// Who would go through, go on probation or be eliminated if this round ended now. Positions are the
// leaderboard's. "Votes in this round" counts paid votes and admin changes made during the round.
export async function roundStanding(db, round) {
  const rows = await db.prepare(`SELECT c.id, c.user_id, c.code, c.stage_name, c.email, c.position, c.total_votes, c.on_probation,
      COALESCE((SELECT SUM(v.quantity) FROM votes v WHERE v.contestant_id = c.id AND v.status = 'valid' AND v.created_at >= ? AND v.created_at < ?), 0)
      + COALESCE((SELECT SUM(a.quantity) FROM vote_adjustments a WHERE a.contestant_id = c.id AND a.created_at >= ? AND a.created_at < ?), 0) AS round_votes
    FROM contestants c WHERE c.status = 'approved' ORDER BY c.position`).all(round.starts_at, round.ends_at, round.starts_at, round.ends_at);
  const counted = (c) => (round.votes_counted === 'total' ? c.total_votes : c.round_votes);
  const passes = (c) => (!round.keep_top || c.position <= round.keep_top) && (!round.min_votes || counted(c) >= round.min_votes);
  const safe = [];
  const probation = [];
  const eliminated = [];
  for (const c of rows) {
    const entry = { ...c, counted: counted(c) };
    if (passes(c)) safe.push(entry);
    // A second miss in a row is not forgiven.
    else if (!c.on_probation && probation.length < round.probation) probation.push(entry);
    else eliminated.push(entry);
  }
  return { safe, probation, eliminated };
}

const brief = (list) => list.map((c) => ({ code: c.code, name: c.stage_name, position: c.position, votes: c.counted }));

// Ends a round once, however many servers notice at the same time.
export async function closeRound(ctx, roundId, actorId = null) {
  const { db } = ctx;
  const outcome = await tx(db, async () => {
    const round = await db.prepare('SELECT * FROM rounds WHERE id = ? AND closed_at IS NULL').get(roundId);
    if (!round) return null;
    const standing = await roundStanding(db, round);
    for (const c of standing.eliminated) {
      await db.prepare("UPDATE contestants SET status = 'eliminated', status_reason = ?, eliminated_round_id = ?, on_probation = 0 WHERE id = ?")
        .run(`Eliminated at the end of ${round.name}.`, round.id, c.id);
    }
    for (const c of standing.probation) await db.prepare('UPDATE contestants SET on_probation = 1 WHERE id = ?').run(c.id);
    // Getting through a round clears an earlier probation.
    for (const c of standing.safe.filter((s) => s.on_probation)) await db.prepare('UPDATE contestants SET on_probation = 0 WHERE id = ?').run(c.id);
    await recomputeRanks(db);
    const result = { safe: standing.safe.length, probation: brief(standing.probation), eliminated: brief(standing.eliminated) };
    await db.prepare('UPDATE rounds SET closed_at = ?, result = ? WHERE id = ?').run(nowIso(), JSON.stringify(result), round.id);
    await audit(ctx, actorId, 'round.close', `${round.name}${actorId ? '' : ' (time ran out)'}: ${result.safe} through, ${result.probation.length} on probation, ${result.eliminated.length} eliminated`);
    return { round, standing };
  });
  if (!outcome) return null;
  const { round, standing } = outcome;
  await publishActivity(ctx, { kind: 'announcement', message: `${round.name} has ended. ${standing.safe.length + standing.probation.length} contestants go through to the next round.` });
  ctx.bus.publish('leaderboard', {});
  ctx.bus.publish('competition', {});
  ctx.background(tellContestants(ctx, round, standing));
  return outcome;
}

async function tellContestants(ctx, round, { safe, probation, eliminated }) {
  const messages = [
    ...safe.map((c) => [c, `You made it through ${round.name}! Keep sharing your voting link.`]),
    ...probation.map((c) => [c, `You are on probation after ${round.name}. You stay in, but if you miss the next round's target you will be eliminated. Share your voting link now.`]),
    ...eliminated.map((c) => [c, `You have been eliminated at the end of ${round.name}. Thank you for taking part.`]),
  ];
  for (const [c, message] of messages) {
    await notifyUser(ctx, c.user_id, 'round', message);
    await ctx.mailer.send({ to: c.email, subject: `${round.name} results`, text: `Hello ${c.stage_name},\n\n${message}` });
  }
}

// Rounds end on visits, since the site has no clock of its own. Only while voting is on.
export async function closeRoundsIfDue(ctx) {
  if (await getSetting(ctx.db, 'competition_phase') !== 'voting') return;
  const due = await ctx.db.prepare('SELECT id FROM rounds WHERE closed_at IS NULL AND ends_at <= ? ORDER BY ends_at').all(nowIso());
  for (const r of due) await closeRound(ctx, r.id);
}
