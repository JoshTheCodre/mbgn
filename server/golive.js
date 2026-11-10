import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { audit, recomputeRanks } from './competition.js';
import { getSetting, setSetting, tx } from './db.js';
import { DEMO_PASSWORD } from './demo-data.js';

// Runs once, the first time the site starts outside demo mode, so the real contest starts clean:
// - the invented demo contestants go, with their accounts (they all have @mbgn.local emails);
// - every vote, payment and admin vote change goes, since none of it was real money;
// - real applicants stay, with their details, PINs, codes and WhatsApp groups, back at zero votes;
// - the contest goes back to registration, with a fresh 7-day countdown an admin can change.
export async function clearTestData(ctx) {
  const { db, config } = ctx;
  if (!config.production || await getSetting(db, 'test_data_cleared')) return null;
  const counts = await tx(db, async () => {
    // Another server starting at the same moment may have got there first.
    if (await getSetting(db, 'test_data_cleared')) return null;
    const run = async (sql, ...args) => (await db.prepare(sql).run(...args)).changes;
    const demo = (await db.prepare("SELECT id, user_id FROM contestants WHERE email LIKE '%@mbgn.local'").all());
    const done = {
      votes: await run('DELETE FROM votes'),
      flags: await run('DELETE FROM flags'),
      payments: await run('DELETE FROM payments'),
    };
    done.voteChanges = await run('DELETE FROM vote_adjustments');
    await run('DELETE FROM simulated_provider');
    await run('DELETE FROM rank_snapshots');
    await run('DELETE FROM referral_visits');
    await run('DELETE FROM activity');
    await run('DELETE FROM notifications');
    await run('DELETE FROM results');
    await run('DELETE FROM rounds');
    if (demo.length) {
      await run(`DELETE FROM contestants WHERE id IN (${demo.map(() => '?').join(', ')})`, ...demo.map((c) => c.id));
      await run(`DELETE FROM users WHERE id IN (${demo.map(() => '?').join(', ')})`, ...demo.map((c) => c.user_id));
    }
    done.demoContestants = demo.length;
    done.realContestantsKept = await run(`UPDATE contestants SET total_votes = 0, last_vote_at = NULL, position = NULL, previous_position = NULL,
      on_probation = 0, eliminated_round_id = NULL,
      status = CASE WHEN status = 'eliminated' THEN 'approved' ELSE status END,
      status_reason = CASE WHEN status = 'eliminated' THEN NULL ELSE status_reason END`);
    await recomputeRanks(db);
    for (const [key, value] of [['competition_phase', 'registration'], ['registration_ends_at', new Date(Date.now() + 7 * 864e5).toISOString()], ['voting_status', 'open'],
      ['voting_starts_at', ''], ['voting_ends_at', ''], ['results_published_at', ''], ['test_data_cleared', new Date().toISOString()]]) {
      await setSetting(db, key, value);
    }
    await audit(ctx, null, 'golive.clear_test_data', Object.entries(done).map(([k, v]) => `${k}: ${v}`).join(', '));
    return done;
  });
  if (counts) console.log('Going live: cleared the demo and test data.', counts);
  return counts;
}

// ADMIN_EMAIL and ADMIN_PASSWORD on Vercel set the main admin's login whenever they change, so a
// forgotten or weak login can always be reset from there. In between, changes made under "Your login"
// stay. Only a fingerprint of the settings is kept, never the password itself.
export async function applyAdminLogin(ctx) {
  const { db, config } = ctx;
  if (!config.production) return false;
  const admin = await db.prepare("SELECT id, email, password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) return false;
  const usable = config.adminEmail && config.adminPassword && config.adminPassword.length >= 8 && config.adminPassword !== DEMO_PASSWORD;
  if (!usable) {
    if (verifyPassword(DEMO_PASSWORD, admin.password_hash)) {
      console.warn('The admin still uses the public demo password. Set ADMIN_EMAIL and ADMIN_PASSWORD, or change it under "Your login" now.');
    }
    return false;
  }
  const fingerprint = crypto.createHmac('sha256', config.appSecret).update(`${config.adminEmail.toLowerCase()}\n${config.adminPassword}`).digest('hex');
  if (await getSetting(db, 'admin_login_applied') === fingerprint) return false;
  const email = config.adminEmail.toLowerCase();
  if (await db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, admin.id)) {
    console.error(`ADMIN_EMAIL ${email} already belongs to another account, so the admin login was not changed.`);
    return false;
  }
  await tx(db, async () => {
    await db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(email, hashPassword(config.adminPassword), admin.id);
    // Anyone signed in with the old login is signed out.
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
    await setSetting(db, 'admin_login_applied', fingerprint);
    await audit(ctx, admin.id, 'admin.login_from_settings', `login set to ${email} from ADMIN_EMAIL and ADMIN_PASSWORD`);
  });
  return true;
}
