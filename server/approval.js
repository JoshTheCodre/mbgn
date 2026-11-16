import { HttpError } from './auth.js';
import { allocateCode, audit, notifyUser, recomputeRanks } from './competition.js';
import { getSetting, nowIso, tx } from './db.js';
import { assignGroup, groupById } from './groups.js';
import { queueAccepted, sendDueWhatsApp } from './whatsapp.js';

// Approving a contestant: her permanent code and voting link, a WhatsApp group, her place on the
// leaderboard, and word of it. Done by an admin, or straight after applying for anyone who passes
// the follower check (actorId null).
export async function approveContestant(ctx, id, actorId = null) {
  const { db } = ctx;
  const c = await tx(db, async () => {
    const row = await db.prepare('SELECT * FROM contestants WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Contestant not found.');
    if (!['pending', 'rejected'].includes(row.status)) throw new HttpError(409, `This contestant is already ${row.status}.`);
    if (!row.code) {
      const { seq, code } = await allocateCode(ctx);
      await db.prepare('UPDATE contestants SET code = ?, code_seq = ? WHERE id = ?').run(code, seq, id);
    }
    await db.prepare("UPDATE contestants SET status = 'approved', status_reason = NULL, approved_at = ? WHERE id = ?").run(nowIso(), id);
    if (!row.whatsapp_group_id) await assignGroup(db, id);
    await recomputeRanks(db);
    await audit(ctx, actorId, 'contestant.approve', `#${id} ${row.stage_name}${actorId ? '' : ' (passed the follower check)'}`);
    return db.prepare('SELECT * FROM contestants WHERE id = ?').get(id);
  });
  await tellApproved(ctx, c);
  ctx.bus.publish('leaderboard', { updatedAt: nowIso() });
  return c;
}

// In her dashboard (and on her phone), and on WhatsApp; by email only where WhatsApp isn't set up,
// or when asked (an admin resending her code).
export async function tellApproved(ctx, c, { whatsapp = true } = {}) {
  const { db, config } = ctx;
  const link = `${config.publicUrl}/c/${c.code}`;
  const notYet = await getSetting(db, 'competition_phase') === 'registration' ? ' Voting opens when registration closes, so get your supporters ready.' : '';
  await notifyUser(ctx, c.user_id, 'approval', `You're in! Your contestant code is ${c.code}. Share your voting link: ${link}.${notYet}`);
  if (whatsapp && await queueAccepted(ctx, c)) {
    ctx.background(sendDueWhatsApp(ctx, { max: 1 }));
    return;
  }
  const group = await groupById(db, c.whatsapp_group_id);
  await ctx.mailer.send({
    to: c.email,
    subject: `You're in! Your MBGN code is ${c.code}`,
    text: `Congratulations ${c.stage_name},\n\nYour application has been approved.\n\nYour permanent contestant code: ${c.code}\nYour personal voting link: ${link}\n${notYet ? `\n${notYet.trim()}\n` : ''}${group ? `\nYour WhatsApp group: ${group.invite_url}\n` : ''}\nLog in to your dashboard to follow your votes and ranking: ${config.publicUrl}/dashboard`,
  });
}
