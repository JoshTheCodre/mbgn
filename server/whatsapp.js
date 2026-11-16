import crypto from 'node:crypto';
import { HttpError, asyncRouter, rateLimit } from './auth.js';
import { DEFAULT_MESSAGES, MESSAGE_KINDS, renderMessage } from '../shared/whatsapp-messages.js';
import { getSetting, nowIso, setSetting } from './db.js';
import { groupById } from './groups.js';

// WhatsApp messages to contestants, from the contest's own number. They're written down here
// first, then sent one of two ways:
// - Through Evolution API (EVOLUTION_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE): Evolution holds
//   the WhatsApp connection on the VPS, and this site sends through it itself, a few at a time and
//   spaced out (sendDueWhatsApp), with its other periodic work and right after an approval.
// - Or a separate sender (whatsapp-sender/) collects them over a link secured by
//   WHATSAPP_SENDER_TOKEN.
// Nothing is written down until one is set up, so switching it on later doesn't flood anyone with
// old news; "Message accepted contestants" in admin catches up the ones accepted before.

const MAX_ATTEMPTS = 3;
const STALE_MS = 10 * 60000;

// As WhatsApp wants it: country code and digits. 0803..., 803... and +234803... are one number.
export function waNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('234')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.length === 10 && !digits.startsWith('0')) return `234${digits}`;
  // Numbers from elsewhere, already with their country code.
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith('0')) return digits;
  return null;
}

export const whatsappEnabled = (ctx) => Boolean(ctx.config.whatsappSenderToken || ctx.config.evolution);
const enabled = whatsappEnabled;

function lagosDate(iso) {
  return new Date(iso).toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' });
}

async function votingNote(db) {
  if (await getSetting(db, 'competition_phase') === 'voting') {
    return 'Voting is open now! Send your link to your friends, family and followers and ask them to vote for you. They can also search your code on the site.';
  }
  const endsAt = await getSetting(db, 'registration_ends_at');
  const when = await getSetting(db, 'auto_start_voting') === '1' && endsAt && new Date(endsAt) > new Date()
    ? `on ${lagosDate(endsAt)}` : 'soon';
  return `Voting opens ${when}, and we'll message you when it does. Then send your link to your friends, family and followers and ask them to vote for you. They can also search your code on the site.`;
}

// ---- The wording, as edited in admin (or the default) ----

const messageKey = (kind) => `whatsapp_message_${kind}`;
const template = async (db, kind) => (await getSetting(db, messageKey(kind))) || DEFAULT_MESSAGES[kind];
const groupLine = (url) => `Join the contestants' WhatsApp group for updates:\n${url}`;

function fills(ctx, c) {
  return { name: c.stage_name, code: c.code, link: `${ctx.config.publicUrl}/c/${c.code}`, dashboard: `${ctx.config.publicUrl}/dashboard` };
}

export async function acceptedText(ctx, c) {
  const group = await groupById(ctx.db, c.whatsapp_group_id);
  return renderMessage(await template(ctx.db, 'accepted'), {
    ...fills(ctx, c), group: group ? groupLine(group.invite_url) : '', voting: await votingNote(ctx.db),
  });
}

// For admin: each message's wording, whether it was changed, and example fill-ins for the preview.
export async function messageSettings(ctx) {
  const messages = {};
  for (const kind of Object.keys(MESSAGE_KINDS)) {
    const saved = await getSetting(ctx.db, messageKey(kind));
    messages[kind] = { text: saved || DEFAULT_MESSAGES[kind], custom: Boolean(saved) };
  }
  const example = fills(ctx, { stage_name: 'Ada Queen', code: `${ctx.config.codePrefix}0001` });
  const groupUrl = 'https://chat.whatsapp.com/ExampleInvite';
  return { messages, example: { ...example, group: groupLine(groupUrl), group_link: groupUrl, voting: await votingNote(ctx.db) } };
}

// Empty (or the default again) goes back to the default.
export async function saveMessage(ctx, kind, text) {
  if (!MESSAGE_KINDS[kind]) throw new HttpError(404, 'There is no such message.');
  const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (value.length > 3000) throw new HttpError(400, 'Keep the message under 3,000 characters.');
  await setSetting(ctx.db, messageKey(kind), value === DEFAULT_MESSAGES[kind] ? '' : value);
}

// One of each kind per contestant, however many times something asks.
export async function queue(db, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const at = nowIso();
    await db.prepare(`INSERT INTO whatsapp_outbox (contestant_id, kind, to_number, body, created_at)
      VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')} ON CONFLICT (contestant_id, kind) DO NOTHING`)
      .run(...chunk.flatMap((r) => [r.contestantId, r.kind, r.to, r.body, at]));
  }
}

async function acceptedRows(ctx, contestants) {
  const rows = [];
  for (const c of contestants) {
    const to = waNumber(c.whatsapp);
    if (to && c.code) rows.push({ contestantId: c.id, kind: 'accepted', to, body: await acceptedText(ctx, c) });
  }
  return rows;
}

export async function queueAccepted(ctx, contestant) {
  if (!enabled(ctx)) return 0;
  const rows = await acceptedRows(ctx, [contestant]);
  await queue(ctx.db, rows);
  return rows.length;
}

// Approved contestants who have not had their acceptance message: everyone accepted before
// WhatsApp was set up.
export async function queueMissingAccepted(ctx) {
  if (!enabled(ctx)) throw new HttpError(409, 'WhatsApp messages are not set up yet.');
  const missing = await ctx.db.prepare(`SELECT * FROM contestants c WHERE status = 'approved'
    AND NOT EXISTS (SELECT 1 FROM whatsapp_outbox o WHERE o.contestant_id = c.id AND o.kind = 'accepted')`).all();
  const rows = await acceptedRows(ctx, missing);
  await queue(ctx.db, rows);
  return rows.length;
}

// Right after applying (once past the follower check). False if it can't go on WhatsApp.
export async function queueRegistered(ctx, c, group) {
  const to = waNumber(c.whatsapp);
  if (!enabled(ctx) || !to) return false;
  const body = renderMessage(await template(ctx.db, 'registered'), {
    name: c.stage_name, group: group ? groupLine(group.invite_url) : '', dashboard: `${ctx.config.publicUrl}/dashboard`,
  });
  await queue(ctx.db, [{ contestantId: c.id, kind: 'registered', to, body }]);
  return true;
}

// For someone who waited for a group with room. False if it can't go on WhatsApp.
export async function queueGroupLink(ctx, c, group) {
  const to = waNumber(c.whatsapp);
  if (!enabled(ctx) || !to) return false;
  // She may not have a code yet, so only her name and the link.
  const body = renderMessage(await template(ctx.db, 'group_link'), { name: c.stage_name, group_link: group.invite_url });
  await queue(ctx.db, [{ contestantId: c.id, kind: 'group_link', to, body }]);
  return true;
}

export async function queueVotingOpen(ctx) {
  if (!enabled(ctx)) return 0;
  const wording = await template(ctx.db, 'voting_open');
  const recipients = await ctx.db.prepare("SELECT id, stage_name, code, whatsapp FROM contestants WHERE status = 'approved'").all();
  const rows = recipients.map((c) => ({ contestantId: c.id, kind: 'voting_open', to: waNumber(c.whatsapp), body: renderMessage(wording, fills(ctx, c)) }))
    .filter((r) => r.to);
  await queue(ctx.db, rows);
  return rows.length;
}

// ---- What the admin panel shows ----

export async function whatsappOverview(ctx) {
  const { db } = ctx;
  const counts = await db.prepare(`SELECT
    COUNT(*) FILTER (WHERE status IN ('queued', 'sending')) AS waiting,
    COUNT(*) FILTER (WHERE status = 'sent') AS sent,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM whatsapp_outbox`).get();
  const failures = await db.prepare(`SELECT o.id, o.kind, o.to_number, o.error, o.created_at, c.code, c.stage_name
    FROM whatsapp_outbox o JOIN contestants c ON c.id = o.contestant_id
    WHERE o.status = 'failed' ORDER BY o.id DESC LIMIT 20`).all();
  const missing = (await db.prepare(`SELECT COUNT(*) AS n FROM contestants c WHERE status = 'approved'
    AND NOT EXISTS (SELECT 1 FROM whatsapp_outbox o WHERE o.contestant_id = c.id AND o.kind = 'accepted')`).get()).n;
  let sender = null;
  if (ctx.config.evolution) {
    // Asked live, so admin always sees whether the phone is linked right now.
    const { state, error } = await evolutionState(ctx.config.evolution);
    sender = { state, error: error ?? null, account: null, transport: 'evolution', direct: true, seenAt: nowIso() };
  } else {
    try { sender = JSON.parse(await getSetting(db, 'whatsapp_sender') || 'null'); } catch { /* shown as never seen */ }
  }
  return {
    configured: enabled(ctx),
    sender,
    waiting: Number(counts.waiting),
    sent: Number(counts.sent),
    failed: Number(counts.failed),
    missingAccepted: Number(missing),
    failures: failures.map((f) => ({
      id: f.id, kind: f.kind, to: f.to_number, error: f.error, createdAt: f.created_at, contestant: { code: f.code, name: f.stage_name },
    })),
  };
}

export async function retryFailed(ctx) {
  const { changes } = await ctx.db.prepare("UPDATE whatsapp_outbox SET status = 'queued', attempts = 0, error = NULL WHERE status = 'failed'").run();
  return changes;
}

// ---- Taking messages to send, and recording how it went (both ways of sending) ----

async function claimMessages(db, limit) {
  // A message taken and never reported on (a sender or server that stopped) goes back in the queue.
  await db.prepare("UPDATE whatsapp_outbox SET status = 'queued' WHERE status = 'sending' AND claimed_at < ?")
    .run(new Date(Date.now() - STALE_MS).toISOString());
  return db.prepare(`UPDATE whatsapp_outbox SET status = 'sending', claimed_at = ?, attempts = attempts + 1
    WHERE id IN (SELECT id FROM whatsapp_outbox WHERE status = 'queued' ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
    RETURNING id, to_number, body, attempts`).all(nowIso(), limit);
}

// A number not on WhatsApp ("final") is never tried again; anything else up to MAX_ATTEMPTS times.
async function recordResult(db, message, { sent, error, final }) {
  if (sent) {
    await db.prepare("UPDATE whatsapp_outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(nowIso(), message.id);
    return;
  }
  const giveUp = final === true || message.attempts >= MAX_ATTEMPTS;
  await db.prepare('UPDATE whatsapp_outbox SET status = ?, error = ? WHERE id = ?')
    .run(giveUp ? 'failed' : 'queued', String(error || 'Not sent.').slice(0, 300), message.id);
}

// ---- Sending through Evolution API, from this site ----

async function evolutionCall(evo, method, path, body) {
  const res = await fetch(`${evo.url}${path}/${encodeURIComponent(evo.instance)}`, {
    method,
    headers: { apikey: evo.apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

// connected, waiting_for_scan (the phone isn't linked), reconnecting, or unreachable.
export async function evolutionState(evo) {
  try {
    const r = await evolutionCall(evo, 'GET', '/instance/connectionState');
    let data = {};
    try { data = JSON.parse(r.text); } catch { /* not JSON */ }
    if (!r.ok) return { state: 'unreachable', error: data?.response?.message ?? data?.message ?? `Evolution API answered ${r.status}` };
    const s = data?.instance?.state ?? data?.state;
    return { state: s === 'open' ? 'connected' : s === 'connecting' ? 'waiting_for_scan' : 'reconnecting' };
  } catch (err) {
    return { state: 'unreachable', error: err.cause?.code ?? err.message };
  }
}

async function evolutionSend(evo, to, text) {
  try {
    const r = await evolutionCall(evo, 'POST', '/message/sendText', { number: to, text });
    if (r.ok) return { sent: true };
    // Evolution answers 400 with "exists": false for a number that is not on WhatsApp.
    if (r.status === 400 && /"exists"\s*:\s*false/.test(r.text)) return { sent: false, final: true, error: 'This number is not on WhatsApp.' };
    return { sent: false, error: `Evolution API answered ${r.status}: ${r.text.slice(0, 200)}` };
  } catch (err) {
    return { sent: false, error: `Couldn't reach Evolution API: ${err.cause?.code ?? err.message}` };
  }
}

// Only one batch runs at a time across every server, and the next can't start until the gap
// after the last message has passed, so messages stay spaced out however many servers run.
async function takeTurn(db, ms) {
  const row = await db.prepare(`INSERT INTO settings (key, value) VALUES ('whatsapp_turn', ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value < ? RETURNING key`)
    .get(new Date(Date.now() + ms).toISOString(), nowIso());
  return Boolean(row);
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Sends waiting messages through Evolution API, up to `max`, one every `gapMs`, the way a person
// would, so the number isn't flagged. About 8 a minute at the defaults.
export async function sendDueWhatsApp(ctx, { max = ctx.config.whatsappBatch, gapMs = ctx.config.whatsappGapMs } = {}) {
  const { db, config } = ctx;
  if (!config.evolution) return { sent: 0 };
  const due = await db.prepare("SELECT 1 FROM whatsapp_outbox WHERE status = 'queued' OR (status = 'sending' AND claimed_at < ?) LIMIT 1")
    .get(new Date(Date.now() - STALE_MS).toISOString());
  if (!due) return { sent: 0 };
  if (!await takeTurn(db, max * gapMs + 60000)) return { sent: 0, busy: true };
  let sent = 0;
  try {
    const { state } = await evolutionState(config.evolution);
    // Until the phone is linked, messages wait here.
    if (state !== 'connected') return { sent: 0, state };
    for (let i = 0; i < max; i += 1) {
      if (i > 0 && gapMs) await pause(gapMs);
      const [message] = await claimMessages(db, 1);
      if (!message) break;
      const result = await evolutionSend(config.evolution, message.to_number, message.body);
      await recordResult(db, message, result);
      if (result.sent) sent += 1;
    }
    return { sent };
  } finally {
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'whatsapp_turn'").run(new Date(Date.now() + gapMs).toISOString());
  }
}

// ---- The sender's side ----

function tokenMatches(expected, header) {
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

export function whatsappSenderRouter(ctx) {
  const { db, config } = ctx;
  const router = asyncRouter();
  router.use(rateLimit({ windowMs: 60000, max: 600 * config.rateLimitScale }));
  router.use((req, _res, next) => {
    // Switched off until the token is set, so the routes don't exist.
    if (!config.whatsappSenderToken) return next(new HttpError(404, 'Not found.'));
    if (!tokenMatches(config.whatsappSenderToken, req.headers.authorization)) return next(new HttpError(401, 'Wrong sender token.'));
    next();
  });

  // The sender says how it is (shown in admin) and, once connected, takes the next messages.
  router.post('/poll', async (req, res) => {
    const states = ['starting', 'waiting_for_scan', 'connected', 'reconnecting', 'logged_out'];
    const state = states.includes(req.body?.state) ? req.body.state : 'starting';
    const account = typeof req.body?.account === 'string' ? req.body.account.replace(/\D/g, '').slice(0, 15) : null;
    await setSetting(db, 'whatsapp_sender', JSON.stringify({ state, account, transport: String(req.body?.transport ?? '').slice(0, 20), seenAt: nowIso() }));
    if (state !== 'connected') return res.json({ messages: [] });

    const limit = Math.min(Math.max(Number(req.body?.limit) || 1, 1), 20);
    const messages = await claimMessages(db, limit);
    res.json({ messages: messages.map((m) => ({ id: m.id, to: m.to_number, text: m.body })) });
  });

  router.post('/messages/:id/result', async (req, res) => {
    const id = Number(req.params.id);
    const message = Number.isInteger(id) ? await db.prepare("SELECT * FROM whatsapp_outbox WHERE id = ? AND status = 'sending'").get(id) : null;
    if (!message) throw new HttpError(404, 'That message is not waiting for a result.');
    await recordResult(db, message, {
      sent: req.body?.sent === true,
      error: typeof req.body?.error === 'string' ? req.body.error : 'Not sent.',
      final: req.body?.final === true,
    });
    res.json({ ok: true });
  });

  return router;
}
