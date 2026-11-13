import nodemailer from 'nodemailer';
import { nowIso } from './db.js';

const BATCH = 20;
const STUCK_MS = 10 * 60000;

// Every message lands in the outbox table. With SMTP_URL set it is delivered too;
// without it, admins can still read what would have gone out.
export function createMailer(config, db) {
  const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  const deliver = (m) => transport.sendMail({ from: config.mailFrom, to: m.to_addr ?? m.to, subject: m.subject, text: m.body ?? m.text })
    .then(() => 'sent')
    .catch((err) => {
      console.error('Email failed:', err.message);
      return 'failed';
    });

  return {
    async send({ to, subject, text }) {
      const { lastInsertRowid: id } = await db.prepare(`INSERT INTO outbox (to_addr, subject, body, status, created_at)
        VALUES (?, ?, ?, ?, ?) RETURNING id`).run(to, subject, text, transport ? 'sending' : 'logged', nowIso());
      if (!transport) return;
      // Waited for, because a serverless function can freeze as soon as it has responded.
      await db.prepare('UPDATE outbox SET status = ? WHERE id = ?').run(await deliver({ to, subject, text }), id);
    },

    // A message to every contestant: saved in a few large writes, then sent in batches by
    // sendQueued, so no single request runs out of time however many contestants there are.
    async queue(messages) {
      const status = transport ? 'queued' : 'logged';
      const at = nowIso();
      for (let i = 0; i < messages.length; i += 500) {
        const chunk = messages.slice(i, i + 500);
        await db.prepare(`INSERT INTO outbox (to_addr, subject, body, status, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
          .run(...chunk.flatMap((m) => [m.to, m.subject, m.text, status, at]));
      }
    },

    // Sends what is waiting, a batch at a time, until the time budget runs out. Servers can run this
    // side by side: each claims its own batch.
    async sendQueued({ budgetMs = 40000 } = {}) {
      if (!transport) return 0;
      // A server that stopped halfway leaves its batch claimed. Hand it back.
      await db.prepare("UPDATE outbox SET status = 'queued' WHERE status = 'sending' AND claimed_at < ?").run(new Date(Date.now() - STUCK_MS).toISOString());
      const until = Date.now() + budgetMs;
      let sent = 0;
      while (Date.now() < until) {
        const batch = await db.prepare(`UPDATE outbox SET status = 'sending', claimed_at = ? WHERE id IN (
          SELECT id FROM outbox WHERE status = 'queued' ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING *`).all(nowIso());
        if (!batch.length) break;
        for (const message of batch) {
          await db.prepare('UPDATE outbox SET status = ? WHERE id = ?').run(await deliver(message), message.id);
          sent += 1;
        }
      }
      return sent;
    },
  };
}
