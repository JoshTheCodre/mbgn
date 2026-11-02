import { tx } from './db.js';

const OPEN_WITH_ROOM = `SELECT g.* FROM whatsapp_groups g
  WHERE g.closed = 0 AND (SELECT COUNT(*) FROM contestants c WHERE c.whatsapp_group_id = g.id) < g.capacity
  ORDER BY g.id LIMIT 1`;

// The oldest group with room, so a new group only takes over once the one before it fills up.
// Call inside a transaction: writers take turns, so two people cannot take the last place.
export async function assignGroup(db, contestantId) {
  const group = await db.prepare(OPEN_WITH_ROOM).get();
  if (group) await db.prepare('UPDATE contestants SET whatsapp_group_id = ? WHERE id = ?').run(group.id, contestantId);
  return group ?? null;
}

export const groupById = (db, id) => (id ? db.prepare('SELECT * FROM whatsapp_groups WHERE id = ?').get(id) : null);

// Everyone who has earned a group link. Those the check could not read wait for approval.
const WAITING = `whatsapp_group_id IS NULL AND verification IS NOT NULL
  AND (status = 'approved' OR (status = 'pending' AND verification = 'passed'))`;

export const countWaiting = async (db) => (await db.prepare(`SELECT COUNT(*) AS n FROM contestants WHERE ${WAITING}`).get()).n;

// Runs when an admin makes room, for anyone who joined while every group was full.
export async function placeWaiting(ctx) {
  const { db } = ctx;
  const waiting = await db.prepare(`SELECT id, email, stage_name FROM contestants WHERE ${WAITING} ORDER BY id LIMIT 200`).all();
  let placed = 0;
  for (const c of waiting) {
    const group = await tx(db, () => assignGroup(db, c.id));
    if (!group) break;
    placed += 1;
    await ctx.mailer.send({
      to: c.email,
      subject: 'Your MBGN WhatsApp group',
      text: `Hello ${c.stage_name},\n\nYour WhatsApp group is ready. Join it here:\n\n${group.invite_url}`,
    });
  }
  return placed;
}
