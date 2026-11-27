// Invented people and votes for demonstrations and test deployments. Never used on a live site.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { allocateCode, recomputeRanks } from './competition.js';
import { nowIso, setSetting, tx } from './db.js';

// Public, in the README. Never accepted on a live site: see golive.js.
export const DEMO_PASSWORD = 'admin-demo-pass';

export const DEMO_ADMIN = {
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@mbgn.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? DEMO_PASSWORD,
};

// Invented contestants for each country's site. The photos are shared, by position.
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

const GHANA_PEOPLE = [
  ['Akosua Mensah', 'Akosua', 'Greater Accra', 'East Legon', 'Pageant', 1860],
  ['Ama Owusu', 'Ama', 'Ashanti', 'Kumasi', 'Pageant', 1725],
  ['Efua Asante', 'Efua', 'Central', 'Cape Coast', 'Pageant', 1490],
  ['Abena Boateng', 'Abena', 'Eastern', 'Koforidua', 'Runway', 1215],
  ['Adwoa Agyeman', 'Adwoa', 'Western', 'Takoradi', 'Runway', 1100],
  ['Esi Quaye', 'Esi', 'Volta', 'Ho', 'Runway', 960],
  ['Afia Darko', 'Afia', 'Bono', 'Sunyani', 'Pageant', 845],
  ['Yaa Amponsah', 'Yaa', 'Northern', 'Tamale', 'Influencer', 720],
  ['Akua Sarpong', 'Akua', 'Ashanti', 'Obuasi', 'Influencer', 605],
  ['Nana Ama Ofori', 'Nana', 'Greater Accra', 'Tema', 'Influencer', 410],
  ['Dzifa Kpodo', 'Dzifa', 'Volta', 'Hohoe', 'Runway', 275],
  ['Mansa Antwi', 'Mansa', 'Upper East', 'Bolgatanga', 'Influencer', 130],
];

const DEMO = {
  ng: {
    people: PEOPLE,
    waiting: [['Ngozi Umeh', 'Ngozi', 'Abia', 'Umuahia'], ['Rukayat Salami', 'Rukky', 'Kwara', 'Ilorin']],
    phone: '0803000', waitingPhone: '0803100', domain: 'mbgn.local',
  },
  gh: {
    people: GHANA_PEOPLE,
    waiting: [['Adjoa Frimpong', 'Adjoa', 'Oti', 'Dambai'], ['Serwaa Bediako', 'Serwaa', 'Ahafo', 'Goaso']],
    phone: '024400', waitingPhone: '024410', domain: 'mbgg.local',
  },
};

// Optional AI-generated portraits of fictional people, named after the stage name (stella.webp).
const DEMO_PHOTOS = path.resolve(process.cwd(), 'demo-photos');

async function copyDemoPhoto(ctx, stageName) {
  const source = path.join(DEMO_PHOTOS, `${stageName.toLowerCase()}.webp`);
  if (!fs.existsSync(source)) return null;
  const file = `${crypto.randomBytes(16).toString('hex')}.webp`;
  await ctx.photos.put(file, fs.readFileSync(source), 'image/webp');
  return file;
}

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

// Fills an empty database. Returns false if there are already contestants.
export async function seedDemoData(ctx) {
  const { db } = ctx;
  const demo = DEMO[ctx.config.countryId] ?? DEMO.ng;
  const country = ctx.config.country;
  // "Anambra State", "Ashanti Region".
  const area = (name) => `${name} ${country?.regionLabel ?? 'State'}`;
  if ((await db.prepare('SELECT COUNT(*) AS n FROM contestants').get()).n > 0) return false;

  return tx(db, async () => {
    // Checked again now this server holds the lock: another may have just finished seeding.
    if ((await db.prepare('SELECT COUNT(*) AS n FROM contestants').get()).n > 0) return false;

    const addUser = db.prepare(`INSERT INTO users (email, name, phone, role, created_at) VALUES (?, ?, ?, 'contestant', ?) RETURNING id`);
    const addContestant = db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio,
      tiktok, instagram, facebook, category, photo_file, status, code, code_seq, approved_at, total_votes, last_vote_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?) RETURNING id`);

    const votes = [];
    const ids = new Map();
    for (const [index, [full, stage, state, city, category, total]] of demo.people.entries()) {
      const slug = stage.toLowerCase().replace(/\s+/g, '');
      const phone = `${demo.phone}${String(index + 1).padStart(4, '0')}`;
      const { lastInsertRowid: uid } = await addUser.run(`${slug}@${demo.domain}`, full, phone, at(400));
      const { seq, code } = await allocateCode(ctx);
      const { lastInsertRowid: cid } = await addContestant.run(
        uid, full, stage, `${slug}@${demo.domain}`, phone, phone, state, city,
        `${stage} is a ${area(state)} model and content creator. Demo profile: replace with a real biography.`,
        `https://www.tiktok.com/@${slug}`, `https://www.instagram.com/${slug}`, null,
        category, await copyDemoPhoto(ctx, PEOPLE[index][1]), code, seq, at(380), total, at(1 + index), at(390),
      );
      ids.set(stage, cid);
      // Spread the demo total across 14 days, in several votes per day, right up to the last few hours.
      const slots = [];
      for (let h = 330; h >= 6; h -= 6) slots.push({ h, weight: 0.5 + ((h * (index + 3)) % 7) / 6 });
      const weightSum = slots.reduce((sum, slot) => sum + slot.weight, 0);
      let remaining = total;
      slots.forEach(({ h, weight }, i) => {
        const quantity = i === slots.length - 1 ? remaining : Math.min(remaining, Math.round((total * weight) / weightSum));
        remaining -= quantity;
        if (quantity > 0) {
          votes.push([`VOTE-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, cid, quantity, h % 12 === 0 ? 1 : 0, at(h - (index % 5))]);
        }
      });
      await db.prepare(`INSERT INTO referral_visits (contestant_id, day, source, visits) VALUES (?, ?, 'whatsapp', ?)`).run(cid, nowIso().slice(0, 10), 40 + index * 7);
    }
    // All at once: one by one would take too long over a network.
    await db.prepare(`INSERT INTO votes (receipt_no, contestant_id, quantity, via_link, ip_hash, created_at)
      VALUES ${votes.map(() => "(?, ?, ?, ?, 'seed', ?)").join(', ')}`).run(...votes.flat());
    await recomputeRanks(db);

    // A rank snapshot from 26 hours ago, shuffled so the movement column has something to show.
    const baselineOrder = [3, 1, 4, 5, 2, 6, 7, 9, 8, 10, 12, 11];
    const rows = await db.prepare("SELECT id, position FROM contestants WHERE status = 'approved' ORDER BY position").all();
    const takenAt = at(26);
    for (const [i, row] of rows.entries()) {
      await db.prepare('INSERT INTO rank_snapshots (taken_at, contestant_id, position) VALUES (?, ?, ?)').run(takenAt, row.id, baselineOrder[i]);
      await db.prepare('UPDATE contestants SET previous_position = ? WHERE id = ?').run(baselineOrder[i], row.id);
    }

    // Two applications waiting in the admin queue.
    for (const [i, [full, stage, state, city]] of demo.waiting.entries()) {
      const slug = stage.toLowerCase();
      const phone = `${demo.waitingPhone}${String(i + 1).padStart(4, '0')}`;
      const { lastInsertRowid: uid } = await addUser.run(`${slug}@${demo.domain}`, full, phone, at(8));
      await db.prepare(`INSERT INTO contestants (user_id, full_name, stage_name, email, phone, whatsapp, state, location, bio, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, full, stage, `${slug}@${demo.domain}`, phone, phone, state, city,
        `${stage} is applying from ${area(state)}. Demo application: replace with a real biography.`, at(8 - i));
    }

    const addActivity = db.prepare('INSERT INTO activity (kind, contestant_id, message, amount, created_at) VALUES (?, ?, ?, ?, ?)');
    const [first, second, , fourth, fifth] = demo.people.map((p) => p[1]);
    await addActivity.run('votes', ids.get(fourth), `${fourth} received 20 new votes.`, 20, at(0.9));
    await addActivity.run('climb', ids.get(fourth), `${fourth} just moved up 1 position.`, 1, at(0.89));
    await addActivity.run('votes', ids.get(second), `${second} received 10 new votes.`, 10, at(0.5));
    await addActivity.run('votes', ids.get(first), `${first} received 5 new votes.`, 5, at(0.2));

    // Always 14 to 21 days away.
    const week = 7 * 864e5;
    await setSetting(db, 'voting_ends_at', new Date((Math.ceil(Date.now() / week) + 2) * week).toISOString());
    await db.prepare('INSERT INTO results (competition, published_at, standings) VALUES (?, ?, ?)').run(
      'Sample edition',
      at(24 * 200),
      JSON.stringify([
        { position: 1, code: `${ctx.config.codePrefix}004`, name: fourth, votes: 12840 },
        { position: 2, code: `${ctx.config.codePrefix}005`, name: fifth, votes: 11095 },
        { position: 3, code: `${ctx.config.codePrefix}001`, name: first, votes: 9720 },
      ]),
    );
    return true;
  });
}
