// Fills a development database with demo data. Refuses to touch production.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './app.js';
import { allocateCode, recomputeRanks } from './competition.js';
import { loadConfig } from './config.js';
import { nowIso, setSetting, tx } from './db.js';

const config = loadConfig({
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@mbgn.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin-demo-pass',
});
if (config.production) throw new Error('The demo seed never runs in production.');

const ctx = createContext(config);
const { db } = ctx;
if (db.prepare('SELECT COUNT(*) AS n FROM contestants').get().n > 0) {
  console.log('Database already has contestants; nothing to do. Delete the data folder to start over.');
  process.exit(0);
}

const PEOPLE = [
  ['Stella Okafor', 'Stella', 'Anambra', 'Awka', 'Pageant', 1860],
  ['Jennifer Adeyemi', 'Jennifer', 'Lagos', 'Lekki', 'Pageant', 1725],
  ['Cynthia Eze', 'Cynthia', 'Enugu', 'Enugu', 'Pageant', 1490],
  ['Deborah Bassey', 'Deborah', 'Akwa Ibom', 'Uyo', 'Runway', 1215],
  ['Amanda Ibrahim', 'Amanda', 'Kaduna', 'Zaria', 'Runway', 1100],
  ['Temilade Balogun', 'Temi', 'Oyo', 'Ibadan', 'Runway', 960],
  ['Zainab Musa', 'Zee', 'Kano', 'Kano', 'Pageant', 845],
  ['Ifeoma Nwosu', 'Ify', 'Imo', 'Owerri', 'Influencer', 720],
  ['Ese Omatseye', 'Ese', 'Delta', 'Warri', 'Influencer', 605],
  ['Blessing Danjuma', 'Blessing', 'Plateau', 'Jos', 'Influencer', 410],
  ['Tamuno Briggs', 'Tamuno', 'Rivers', 'Port Harcourt', 'Runway', 275],
  ['Halima Yusuf', 'Halima', 'FCT Abuja', 'Gwarinpa', 'Influencer', 130],
];

// Optional AI-generated portraits of fictional people, named after the stage name (stella.webp).
const DEMO_PHOTOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo-photos');

function copyDemoPhoto(stageName) {
  const source = path.join(DEMO_PHOTOS, `${stageName.toLowerCase()}.webp`);
  if (!fs.existsSync(source)) return null;
  const file = `${crypto.randomBytes(16).toString('hex')}.webp`;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.copyFileSync(source, path.join(config.uploadDir, file));
  return file;
}

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

tx(db, () => {
  const addUser = db.prepare(`INSERT INTO users (email, name, phone, role, credits, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const addContestant = db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio,
    tiktok, instagram, facebook, category, status, code, code_seq, approved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`);
  const addVote = db.prepare(`INSERT INTO votes (receipt_no, user_id, supporter_email, contestant_id, quantity, idempotency_key, via_link, ip_hash, created_at)
    VALUES (?, ?, 'supporter@mbgn.local', ?, ?, ?, ?, 'seed', ?)`);
  const setTotal = db.prepare('UPDATE contestants SET total_votes = ?, last_vote_at = ? WHERE id = ?');

  const { lastInsertRowid: supporterId } = addUser.run('supporter@mbgn.local', 'Demo Supporter', '08030000000', 'supporter', 40, at(400));

  PEOPLE.forEach(([full, stage, state, city, category, total], index) => {
    const slug = stage.toLowerCase();
    const phone = `0803000${String(index + 1).padStart(4, '0')}`;
    const { lastInsertRowid: uid } = addUser.run(`${slug}@mbgn.local`, full, phone, 'contestant', 0, at(400));
    const { seq, code } = allocateCode(ctx);
    const { lastInsertRowid: cid } = addContestant.run(
      uid, full, stage, `${slug}@mbgn.local`, phone, phone, state, city,
      `${stage} is a ${state} State model and content creator. Demo profile: replace with a real biography.`,
      `https://www.tiktok.com/@${slug}`, `https://www.instagram.com/${slug}`, null,
      category, code, seq, at(380), at(390),
    );
    db.prepare('UPDATE contestants SET photo_file = ? WHERE id = ?').run(copyDemoPhoto(stage), cid);
    // Spread the demo total across 14 days, in several votes per day, right up to the last few hours.
    const slots = [];
    for (let h = 330; h >= 6; h -= 6) slots.push({ h, weight: 0.5 + ((h * (index + 3)) % 7) / 6 });
    const weightSum = slots.reduce((sum, slot) => sum + slot.weight, 0);
    let remaining = total;
    slots.forEach(({ h, weight }, i) => {
      const quantity = i === slots.length - 1 ? remaining : Math.min(remaining, Math.round((total * weight) / weightSum));
      remaining -= quantity;
      if (quantity > 0) {
        addVote.run(`VOTE-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, supporterId, cid, quantity, crypto.randomUUID(), h % 12 === 0 ? 1 : 0, at(h - (index % 5)));
      }
    });
    setTotal.run(total, at(1 + index), cid);
    db.prepare(`INSERT INTO referral_visits (contestant_id, day, source, visits) VALUES (?, ?, 'whatsapp', ?)`).run(cid, nowIso().slice(0, 10), 40 + index * 7);
  });
  recomputeRanks(db);

  // A rank snapshot from 26 hours ago, shuffled so the movement column has something to show.
  const baselineOrder = [3, 1, 4, 5, 2, 6, 7, 9, 8, 10, 12, 11];
  const rows = db.prepare("SELECT id, position FROM contestants WHERE status = 'approved' ORDER BY position").all();
  const takenAt = at(26);
  rows.forEach((row, i) => {
    db.prepare('INSERT INTO rank_snapshots (taken_at, contestant_id, position) VALUES (?, ?, ?)').run(takenAt, row.id, baselineOrder[i]);
    db.prepare('UPDATE contestants SET previous_position = ? WHERE id = ?').run(baselineOrder[i], row.id);
  });

  // Two applications waiting in the admin queue.
  [['Ngozi Umeh', 'Ngozi', 'Abia', 'Umuahia'], ['Rukayat Salami', 'Rukky', 'Kwara', 'Ilorin']].forEach(([full, stage, state, city], i) => {
    const slug = stage.toLowerCase();
    const phone = `0803100${String(i + 1).padStart(4, '0')}`;
    const { lastInsertRowid: uid } = addUser.run(`${slug}@mbgn.local`, full, phone, 'contestant', 0, at(8));
    db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, full, stage, `${slug}@mbgn.local`, phone, phone, state, city,
      `${stage} is applying from ${state} State. Demo application: replace with a real biography.`, at(8 - i));
  });

  const addActivity = db.prepare('INSERT INTO activity (kind, contestant_id, message, amount, created_at) VALUES (?, ?, ?, ?, ?)');
  const byName = (name) => db.prepare('SELECT id FROM contestants WHERE stage_name = ?').get(name).id;
  addActivity.run('votes', byName('Deborah'), 'Deborah received 20 new votes.', 20, at(0.9));
  addActivity.run('climb', byName('Deborah'), 'Deborah just moved up 1 position.', 1, at(0.89));
  addActivity.run('votes', byName('Jennifer'), 'Jennifer received 10 new votes.', 10, at(0.5));
  addActivity.run('votes', byName('Stella'), 'Stella received 5 new votes.', 5, at(0.2));

  setSetting(db, 'voting_ends_at', new Date(Date.now() + 18 * 864e5).toISOString());
  db.prepare('INSERT INTO results (competition, published_at, standings) VALUES (?, ?, ?)').run(
    'Sample edition',
    at(24 * 200),
    JSON.stringify([
      { position: 1, code: 'MBG004', name: 'Deborah', votes: 12840 },
      { position: 2, code: 'MBG005', name: 'Amanda', votes: 11095 },
      { position: 3, code: 'MBG001', name: 'Stella', votes: 9720 },
    ]),
  );
});

console.log('Demo data ready. Demo details are listed in the README.');
process.exit(0);
