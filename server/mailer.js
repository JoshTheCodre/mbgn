import nodemailer from 'nodemailer';
import { nowIso } from './db.js';

// Every message lands in the outbox table. With SMTP_URL set it is delivered too;
// without it, admins can still read what would have gone out.
export function createMailer(config, db) {
  const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

  return {
    async send({ to, subject, text }) {
      const { lastInsertRowid: id } = await db.prepare(`INSERT INTO outbox (to_addr, subject, body, status, created_at)
        VALUES (?, ?, ?, ?, ?) RETURNING id`).run(to, subject, text, transport ? 'sending' : 'logged', nowIso());
      if (!transport) return;
      // Waited for, because a serverless function can freeze as soon as it has responded.
      const status = await transport.sendMail({ from: config.mailFrom, to, subject, text })
        .then(() => 'sent')
        .catch((err) => {
          console.error('Email failed:', err.message);
          return 'failed';
        });
      await db.prepare('UPDATE outbox SET status = ? WHERE id = ?').run(status, id);
    },
  };
}
