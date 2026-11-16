import { HttpError } from './auth.js';
import { audit } from './competition.js';
import { nowIso } from './db.js';
import { renderMessage } from '../shared/whatsapp-messages.js';
import { queue, sendDueWhatsApp, waNumber, whatsappEnabled } from './whatsapp.js';

// Admins' own WhatsApp messages: to chosen contestants, or to everyone who matches what they pick
// (status, votes, rank, state, category, follower check). Written in Markdown, with fill-ins.

const STATUSES = ['approved', 'pending', 'rejected', 'suspended', 'eliminated'];
const CHECKS = ['passed', 'review', 'failed'];
const wholeNumber = (v) => (v === '' || v == null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);

function audienceWhere(a = {}) {
  const ids = Array.isArray(a.ids) ? a.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length) return { sql: 'id = ANY(?)', params: [ids] };
  const where = [];
  const params = [];
  const add = (sql, value) => { where.push(sql); params.push(value); };
  if (a.status !== 'any') add('status = ?', STATUSES.includes(a.status) ? a.status : 'approved');
  if (wholeNumber(a.minVotes) !== null) add('total_votes >= ?', wholeNumber(a.minVotes));
  if (wholeNumber(a.maxVotes) !== null) add('total_votes <= ?', wholeNumber(a.maxVotes));
  if (wholeNumber(a.top)) add('position <= ?', wholeNumber(a.top));
  if (typeof a.state === 'string' && a.state) add('state = ?', a.state);
  if (typeof a.category === 'string' && a.category) add('category = ?', a.category);
  if (CHECKS.includes(a.verification)) add('verification = ?', a.verification);
  return { sql: where.length ? where.join(' AND ') : 'TRUE', params };
}

async function audience(ctx, a) {
  const { sql, params } = audienceWhere(a);
  return ctx.db.prepare(`SELECT id, stage_name, code, whatsapp, total_votes, position FROM contestants WHERE ${sql} ORDER BY COALESCE(position, 999999), id LIMIT 10000`).all(...params);
}

const fillsFor = (ctx, c) => ({
  name: c.stage_name,
  code: c.code ?? '',
  link: c.code ? `${ctx.config.publicUrl}/c/${c.code}` : '',
  dashboard: `${ctx.config.publicUrl}/dashboard`,
  votes: String(c.total_votes ?? 0),
  position: c.position ? String(c.position) : '',
});

// How many it would reach, and an example to preview with.
export async function previewAudience(ctx, a) {
  const people = await audience(ctx, a);
  const reachable = people.filter((c) => waNumber(c.whatsapp));
  return {
    count: reachable.length,
    noWhatsApp: people.length - reachable.length,
    names: reachable.slice(0, 6).map((c) => c.stage_name),
    example: fillsFor(ctx, reachable[0] ?? { stage_name: 'Ada Queen', code: `${ctx.config.codePrefix}0001`, total_votes: 120, position: 3 }),
  };
}

export async function sendBroadcast(ctx, a, text, adminId) {
  if (!whatsappEnabled(ctx)) throw new HttpError(409, 'WhatsApp messages are not set up yet.');
  const wording = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (wording.length < 2) throw new HttpError(400, 'Write the message first.');
  if (wording.length > 3000) throw new HttpError(400, 'Keep the message under 3,000 characters.');
  const people = (await audience(ctx, a)).filter((c) => waNumber(c.whatsapp));
  if (!people.length) throw new HttpError(400, 'Nobody matches, so there is no one to send it to.');
  const { lastInsertRowid: id } = await ctx.db.prepare(`INSERT INTO whatsapp_broadcasts (body, audience, recipients, created_by, created_at)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).run(wording, JSON.stringify(a ?? {}), people.length, adminId, nowIso());
  await queue(ctx.db, people.map((c) => ({ contestantId: c.id, kind: `custom_${id}`, to: waNumber(c.whatsapp), body: renderMessage(wording, fillsFor(ctx, c)) })));
  await audit(ctx, adminId, 'whatsapp.broadcast', `#${id} to ${people.length} contestants`);
  ctx.background(sendDueWhatsApp(ctx));
  return { id, queued: people.length };
}

export async function broadcastHistory(ctx) {
  const rows = await ctx.db.prepare(`SELECT b.id, b.body, b.recipients, b.created_at,
      COUNT(o.id) FILTER (WHERE o.status = 'sent') AS sent,
      COUNT(o.id) FILTER (WHERE o.status IN ('queued', 'sending')) AS waiting,
      COUNT(o.id) FILTER (WHERE o.status = 'failed') AS failed
    FROM whatsapp_broadcasts b LEFT JOIN whatsapp_outbox o ON o.kind = 'custom_' || b.id
    GROUP BY b.id ORDER BY b.id DESC LIMIT 30`).all();
  return rows.map((r) => ({
    id: r.id, body: r.body, recipients: r.recipients, createdAt: r.created_at, sent: Number(r.sent), waiting: Number(r.waiting), failed: Number(r.failed),
  }));
}
