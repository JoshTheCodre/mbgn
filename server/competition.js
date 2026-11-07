import { nowIso, tx } from './db.js';

export async function votingState(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('competition_phase', 'voting_status', 'voting_starts_at', 'voting_ends_at')").all();
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (settings.competition_phase === 'registration') {
    return { open: false, status: 'registration', message: 'Voting opens when registration closes.' };
  }
  const status = settings.voting_status;
  const startsAt = settings.voting_starts_at;
  const endsAt = settings.voting_ends_at;
  const now = nowIso();

  if (status === 'paused') return { open: false, status: 'paused', message: 'Voting is paused right now.' };
  if (status === 'closed') return { open: false, status: 'closed', message: 'Voting has closed.' };
  if (startsAt && now < startsAt) return { open: false, status: 'upcoming', message: 'Voting has not started yet.' };
  if (endsAt && now >= endsAt) return { open: false, status: 'closed', message: 'Voting has closed.' };
  return { open: true, status: 'open', message: 'Voting is open.' };
}

// Applications stop at the deadline, or once voting has started. Voting itself starts at the
// deadline too unless an admin turned that off (see stages.js).
export async function registrationState(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('competition_phase', 'registration_ends_at')").all();
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const endsAt = settings.registration_ends_at || null;
  return { open: settings.competition_phase === 'registration' && (!endsAt || nowIso() < endsAt), endsAt };
}

export function formatCode(prefix, seq) {
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// Codes come from a counter that only moves forward, so a code can never be
// handed to a second contestant even if the first is rejected or disqualified.
export async function allocateCode(ctx) {
  const { value } = await ctx.db.prepare(`UPDATE settings SET value = (value::int + 1)::text
    WHERE key = 'next_code_seq' RETURNING value`).get();
  const seq = Number(value) - 1;
  return { seq, code: formatCode(ctx.config.codePrefix, seq) };
}

// Highest total first; on a tie, whoever reached that total first stays ahead.
export async function recomputeRanks(db) {
  await db.prepare(`WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY total_votes DESC, COALESCE(last_vote_at, approved_at) ASC, code_seq ASC) AS place
      FROM contestants WHERE status = 'approved'
    ), wanted AS (
      SELECT c.id, ranked.place FROM contestants c LEFT JOIN ranked ON ranked.id = c.id
    )
    UPDATE contestants c
    SET previous_position = CASE WHEN wanted.place IS NULL THEN c.previous_position ELSE c.position END, position = wanted.place
    FROM wanted
    WHERE c.id = wanted.id AND c.position IS DISTINCT FROM wanted.place`).run();
}

export async function takeRankSnapshot(db, takenAt = nowIso()) {
  await tx(db, async () => {
    await db.prepare(`INSERT INTO rank_snapshots (taken_at, contestant_id, position)
      SELECT ?, id, position FROM contestants WHERE status = 'approved' AND position IS NOT NULL
      ON CONFLICT DO NOTHING`).run(takenAt);
    const cutoff = new Date(Date.now() - 3 * 864e5).toISOString();
    await db.prepare('DELETE FROM rank_snapshots WHERE taken_at < ?').run(cutoff);
  });
}

// Positions gained (+) or lost (-) in the last 24 hours, from the snapshot closest
// to 24h ago; a young competition falls back to its earliest snapshot.
export async function movementBaseline(db) {
  const cutoff = new Date(Date.now() - 864e5).toISOString();
  const takenAt = (await db.prepare('SELECT MAX(taken_at) AS t FROM rank_snapshots WHERE taken_at <= ?').get(cutoff)).t
    ?? (await db.prepare('SELECT MIN(taken_at) AS t FROM rank_snapshots').get()).t;
  if (!takenAt) return new Map();
  const rows = await db.prepare('SELECT contestant_id, position FROM rank_snapshots WHERE taken_at = ?').all(takenAt);
  return new Map(rows.map((r) => [r.contestant_id, r.position]));
}

export const photoUrl = (row) => (row.photo_file ? `/photos/${row.photo_file}` : null);

// The only contestant shape the public ever sees. No email, phone, WhatsApp or legal name.
export function publicContestant(row, baseline) {
  const before = baseline?.get(row.id);
  return {
    code: row.code,
    name: row.stage_name,
    photoUrl: photoUrl(row),
    state: row.state,
    location: row.location,
    category: row.category,
    totalVotes: row.total_votes,
    position: row.position,
    previousPosition: row.previous_position,
    movement24h: before == null || row.position == null ? null : before - row.position,
  };
}

export function publicProfile(row, baseline) {
  return {
    ...publicContestant(row, baseline),
    bio: row.bio,
    tiktok: row.tiktok,
    instagram: row.instagram,
    facebook: row.facebook,
  };
}

export async function lastUpdated(db) {
  return (await db.prepare("SELECT MAX(last_vote_at) AS t FROM contestants WHERE status = 'approved'").get()).t;
}

export async function audit(ctx, actorId, action, details) {
  await ctx.db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
    .run(actorId ?? null, action, details ?? null, nowIso());
}

export async function notifyUser(ctx, userId, kind, message) {
  const createdAt = nowIso();
  const { lastInsertRowid: id } = await ctx.db
    .prepare('INSERT INTO notifications (user_id, kind, message, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .run(userId, kind, message, createdAt);
  ctx.bus.sendToUser(userId, 'notification', { id, kind, message, createdAt });
}

export async function publishActivity(ctx, { kind, contestantId = null, message, code = null, amount = null }) {
  const createdAt = nowIso();
  const { lastInsertRowid: id } = await ctx.db
    .prepare('INSERT INTO activity (kind, contestant_id, message, amount, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(kind, contestantId, message, amount, createdAt);
  const contestant = contestantId
    ? await ctx.db.prepare('SELECT stage_name FROM contestants WHERE id = ?').get(contestantId)
    : null;
  ctx.bus.publish('activity', {
    id,
    kind,
    message,
    code,
    amount,
    name: contestant?.stage_name ?? null,
    createdAt,
  });
}

export async function raiseFlag(ctx, { kind, severity = 'medium', details, contestantId = null, paymentId = null }) {
  // One open flag per subject is enough for a reviewer.
  const existing = await ctx.db.prepare(`SELECT id FROM flags WHERE status = 'open' AND kind = ?
    AND contestant_id IS NOT DISTINCT FROM ?::int AND payment_id IS NOT DISTINCT FROM ?::int`).get(kind, contestantId, paymentId);
  if (existing) return;
  await ctx.db.prepare(`INSERT INTO flags (kind, severity, details, contestant_id, payment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(kind, severity, details, contestantId, paymentId, nowIso());
}
