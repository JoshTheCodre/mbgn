import { audit, notifyUser, publishActivity } from './competition.js';
import { getSetting, setSetting, tx } from './db.js';

// Moves the contest between taking applications and voting. Returns false when it was already
// in that stage, so two servers reaching the countdown together only start voting once.
export async function changeStage(ctx, phase, actorId = null) {
  const { db } = ctx;
  const changed = await tx(db, async () => {
    if (await getSetting(db, 'competition_phase') === phase) return false;
    await setSetting(db, 'competition_phase', phase);
    if (phase === 'voting') {
      await setSetting(db, 'voting_status', 'open');
      await setSetting(db, 'results_published_at', '');
    }
    await audit(ctx, actorId, 'competition.phase', actorId ? phase : `${phase} (countdown ended)`);
    return true;
  });
  if (!changed) return false;
  if (phase === 'voting') await publishActivity(ctx, { kind: 'announcement', message: 'Registration has closed. Voting is now open!' });
  ctx.bus.publish('competition', {});
  ctx.bus.publish('leaderboard', {});
  return true;
}

export async function tellContestantsVotingOpened(ctx) {
  const { db, config } = ctx;
  const recipients = await db.prepare("SELECT user_id, email, stage_name, code FROM contestants WHERE status = 'approved'").all();
  for (const r of recipients) {
    const link = `${config.publicUrl}/c/${r.code}`;
    await notifyUser(ctx, r.user_id, 'announcement', `Voting is open! Share your link now: ${link}`);
    await ctx.mailer.send({
      to: r.email,
      subject: 'Voting is open!',
      text: `Hello ${r.stage_name},\n\nRegistration has closed and voting is now open. Share your voting link with your supporters now:\n\n${link}`,
    });
  }
  return recipients.length;
}

// Checked on visits, since a serverless site has no clock of its own. Admins can turn it off and
// start voting by hand instead.
export async function startVotingIfDue(ctx) {
  const rows = await ctx.db.prepare("SELECT key, value FROM settings WHERE key IN ('competition_phase', 'registration_ends_at', 'auto_start_voting')").all();
  const s = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const due = s.competition_phase === 'registration' && s.auto_start_voting === '1'
    && s.registration_ends_at && new Date(s.registration_ends_at) <= new Date();
  if (!due || !(await changeStage(ctx, 'voting'))) return false;
  // The page that noticed should not wait for every email to go out.
  ctx.background(tellContestantsVotingOpened(ctx));
  return true;
}
