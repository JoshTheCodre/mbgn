import { getSetting, nowIso, setSetting, tx } from './db.js';

export function votingState(db) {
  const status = getSetting(db, 'voting_status');
  const startsAt = getSetting(db, 'voting_starts_at');
  const endsAt = getSetting(db, 'voting_ends_at');
  const now = nowIso();

  if (status === 'paused') return { open: false, status: 'paused', message: 'Voting is paused right now.' };
  if (status === 'closed') return { open: false, status: 'closed', message: 'Voting has closed.' };
  if (startsAt && now < startsAt) return { open: false, status: 'upcoming', message: 'Voting has not started yet.' };
  if (endsAt && now >= endsAt) return { open: false, status: 'closed', message: 'Voting has closed.' };
  return { open: true, status: 'open', message: 'Voting is open.' };
}

export function formatCode(prefix, seq) {
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// Codes come from a counter that only moves forward, so a code can never be
// handed to a second contestant even if the first is rejected or disqualified.
export function allocateCode(ctx) {
  const seq = Number(getSetting(ctx.db, 'next_code_seq'));
  setSetting(ctx.db, 'next_code_seq', seq + 1);
  return { seq, code: formatCode(ctx.config.codePrefix, seq) };
}

// Highest total first; on a tie, whoever reached that total first stays ahead.
export function recomputeRanks(db) {
  const rows = db.prepare(`
    SELECT id, position FROM contestants WHERE status = 'approved'
    ORDER BY total_votes DESC, COALESCE(last_vote_at, approved_at) ASC, code_seq ASC`).all();
  const move = db.prepare('UPDATE contestants SET previous_position = position, position = ? WHERE id = ?');
  rows.forEach((row, index) => {
    if (row.position !== index + 1) move.run(index + 1, row.id);
  });
  db.prepare("UPDATE contestants SET position = NULL WHERE status <> 'approved' AND position IS NOT NULL").run();
}

export function takeRankSnapshot(db, takenAt = nowIso()) {
  tx(db, () => {
    db.prepare(`INSERT OR IGNORE INTO rank_snapshots (taken_at, contestant_id, position)
      SELECT ?, id, position FROM contestants WHERE status = 'approved' AND position IS NOT NULL`).run(takenAt);
    const cutoff = new Date(Date.now() - 3 * 864e5).toISOString();
    db.prepare('DELETE FROM rank_snapshots WHERE taken_at < ?').run(cutoff);
  });
}

// Positions gained (+) or lost (-) in the last 24 hours, from the snapshot closest
// to 24h ago; a young competition falls back to its earliest snapshot.
export function movementBaseline(db) {
  const cutoff = new Date(Date.now() - 864e5).toISOString();
  const takenAt = db.prepare('SELECT MAX(taken_at) AS t FROM rank_snapshots WHERE taken_at <= ?').get(cutoff).t
    ?? db.prepare('SELECT MIN(taken_at) AS t FROM rank_snapshots').get().t;
  if (!takenAt) return new Map();
  const rows = db.prepare('SELECT contestant_id, position FROM rank_snapshots WHERE taken_at = ?').all(takenAt);
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

export function lastUpdated(db) {
  return db.prepare("SELECT MAX(last_vote_at) AS t FROM contestants WHERE status = 'approved'").get().t;
}

export function audit(ctx, actorId, action, details) {
  ctx.db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
    .run(actorId ?? null, action, details ?? null, nowIso());
}

export function notifyUser(ctx, userId, kind, message) {
  const createdAt = nowIso();
  const { lastInsertRowid: id } = ctx.db
    .prepare('INSERT INTO notifications (user_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, kind, message, createdAt);
  ctx.bus.sendToUser(userId, 'notification', { id, kind, message, createdAt });
}

export function publishActivity(ctx, { kind, contestantId = null, message, code = null, amount = null }) {
  const createdAt = nowIso();
  const { lastInsertRowid: id } = ctx.db
    .prepare('INSERT INTO activity (kind, contestant_id, message, amount, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, contestantId, message, amount, createdAt);
  const contestant = contestantId
    ? ctx.db.prepare('SELECT stage_name FROM contestants WHERE id = ?').get(contestantId)
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

export function raiseFlag(ctx, { kind, severity = 'medium', details, userId = null, contestantId = null, paymentId = null }) {
  // One open flag per subject is enough for a reviewer.
  const existing = ctx.db.prepare(`SELECT id FROM flags WHERE status = 'open' AND kind = ?
    AND user_id IS ? AND contestant_id IS ? AND payment_id IS ?`).get(kind, userId, contestantId, paymentId);
  if (existing) return;
  ctx.db.prepare(`INSERT INTO flags (kind, severity, details, user_id, contestant_id, payment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(kind, severity, details, userId, contestantId, paymentId, nowIso());
}
