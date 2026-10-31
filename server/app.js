import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { HttpError, attachUser, hashPassword, sameOriginWrites } from './auth.js';
import { recomputeRanks, takeRankSnapshot } from './competition.js';
import { nowIso, openDb } from './db.js';
import { createMailer } from './mailer.js';
import { createMonnify, createSimulator, reconcilePending } from './payments.js';
import { createBus } from './realtime.js';
import { adminRouter } from './routes/admin.js';
import { contestantRouter, walletRouter } from './routes/member.js';
import { photoHandler, publicRouter } from './routes/public.js';
import { createActivityAggregator } from './votes.js';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

export function createContext(config) {
  const db = openDb(config.dbPath);
  const ctx = {
    config,
    db,
    bus: createBus(),
    mailer: createMailer(config, db),
    provider: config.monnify ? createMonnify(config) : createSimulator(db),
  };
  ctx.activity = createActivityAggregator(ctx);
  ensureAdmin(ctx);
  recomputeRanks(db);
  return ctx;
}

function ensureAdmin(ctx) {
  const { db, config } = ctx;
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const email = config.adminEmail ?? 'admin@mbgn.local';
  let password = config.adminPassword;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    console.log(`\nFirst run: created admin ${email} with password ${password}\nChange it by setting ADMIN_PASSWORD before first run or using "Forgot password".\n`);
  }
  db.prepare(`INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Administrator', ?, 'admin', ?)`)
    .run(email, hashPassword(password), nowIso());
}

export function startBackgroundJobs(ctx) {
  // Hourly rank snapshots drive the "movement within 24hrs" column.
  takeRankSnapshot(ctx.db);
  const snapshots = setInterval(() => takeRankSnapshot(ctx.db), 3600000);
  const reconcile = setInterval(() => reconcilePending(ctx), 5 * 60000);
  snapshots.unref();
  reconcile.unref();
  return () => {
    clearInterval(snapshots);
    clearInterval(reconcile);
  };
}

export function createApp(ctx, { serveClient = true } = {}) {
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

  // Needs the raw bytes for signature checking, and comes from Monnify rather than a browser.
  app.post('/api/webhooks/monnify', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => ctx.webhookHandler(req, res));

  app.use('/api', sameOriginWrites(ctx), express.json({ limit: '100kb' }), attachUser(ctx));
  app.use('/api', router);
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', walletRouter(ctx));
  app.use('/api/me', contestantRouter(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.get('/photos/:file', photoHandler(ctx));

  if (serveClient && fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  if (ctx.attachDev) ctx.attachDev(app);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'The photograph must be smaller than 5 MB.' : 'That upload could not be read.';
      return res.status(400).json({ error: message });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}
