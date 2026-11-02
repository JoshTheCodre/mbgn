import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { HttpError, attachUser, hashPassword, sameOriginWrites, wrap } from './auth.js';
import { takeRankSnapshot } from './competition.js';
import { nowIso, openDb } from './db.js';
import { createFollowerChecker } from './followers.js';
import { createMailer } from './mailer.js';
import { createPhotoStore } from './photos.js';
import { createPaystack, createSimulator, reconcilePending } from './payments.js';
import { createBus } from './realtime.js';
import { adminRouter } from './routes/admin.js';
import { contestantRouter, votingRouter } from './routes/member.js';
import { photoHandler, publicRouter } from './routes/public.js';
import { createActivityAggregator } from './votes.js';

export async function createContext(config) {
  const db = await openDb(config);
  const ctx = {
    config,
    db,
    bus: createBus(),
    mailer: createMailer(config, db),
    photos: createPhotoStore(config),
    provider: config.paystack ? createPaystack(config) : createSimulator(db),
    followers: createFollowerChecker(config),
  };
  ctx.activity = createActivityAggregator(ctx);
  // A new contest gets a week to take applications. Only set once, so an admin's change stays.
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
    .run('registration_ends_at', new Date(Date.now() + 7 * 864e5).toISOString());
  await ensureAdmin(ctx);
  return ctx;
}

async function ensureAdmin(ctx) {
  const { db, config } = ctx;
  if (await db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const email = (config.adminEmail ?? 'admin@mbgn.local').toLowerCase();
  let password = config.adminPassword;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    console.log(`\nFirst run: created admin ${email} with password ${password}\nChange it by setting ADMIN_PASSWORD before first run or using "Forgot password".\n`);
  }
  // Another server starting at the same moment may have got there first.
  await db.prepare(`INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Administrator', ?, 'admin', ?)
    ON CONFLICT (email) DO NOTHING`).run(email, hashPassword(password), nowIso());
}

// Claims a job in the database, so only one server runs it however many are up.
async function claimJob(db, key, everyMs) {
  const cutoff = new Date(Date.now() - everyMs).toISOString();
  const { changes } = await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value < ?`).run(key, nowIso(), cutoff);
  return changes === 1;
}

export async function runDueJobs(ctx) {
  // Hourly rank snapshots drive the "movement within 24hrs" column.
  if (await claimJob(ctx.db, 'job_rank_snapshot', 3600000)) await takeRankSnapshot(ctx.db);
  if (await claimJob(ctx.db, 'job_reconcile', 5 * 60000)) await reconcilePending(ctx);
}

export function createApp(ctx) {
  const { config } = ctx;
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    if (config.production) {
      res.set('Strict-Transport-Security', 'max-age=31536000');
      res.set('Content-Security-Policy', [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '));
    }
    next();
  });

  const router = publicRouter(ctx);

  app.get(['/photos/:file', '/api/photos/:file'], wrap(photoHandler(ctx)));

  // Needs the raw bytes for signature checking, and comes from Paystack rather than a browser.
  app.post('/api/webhooks/paystack', express.raw({ type: '*/*', limit: '256kb' }), wrap((req, res) => ctx.webhookHandler(req, res)));

  app.use('/api', sameOriginWrites(ctx), express.json({ limit: '100kb' }), attachUser(ctx));
  app.use('/api', router);
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', votingRouter(ctx));
  app.use('/api/me', contestantRouter(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // An error must never be kept by the edge cache.
    res.set('Cache-Control', 'no-store');
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'The photograph must be smaller than 5 MB.' : 'That upload could not be read.';
      return res.status(400).json({ error: message });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
    // An id in the address that isn't a number.
    if (err.code === '22P02') return res.status(404).json({ error: 'Not found.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}
