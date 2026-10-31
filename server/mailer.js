import nodemailer from 'nodemailer';
import { nowIso } from './db.js';

// Every message lands in the outbox table. With SMTP_URL set it is delivered too;
// without it, admins can still read what would have gone out.
export function createMailer(config, db) {
  const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  const record = db.prepare('INSERT INTO outbox (to_addr, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?)');
  const setStatus = db.prepare('UPDATE outbox SET status = ? WHERE id = ?');

  return {
    send({ to, subject, text }) {
      const { lastInsertRowid: id } = record.run(to, subject, text, transport ? 'sending' : 'logged', nowIso());
      if (!transport) return;
      transport.sendMail({ from: config.mailFrom, to, subject, text })
        .then(() => setStatus.run('sent', id))
        .catch((err) => {
          console.error('Email failed:', err.message);
          setStatus.run('failed', id);
        });
    },
  };
}
