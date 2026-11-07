import crypto from 'node:crypto';
import express from 'express';
import { nowIso } from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'mbgn_sid';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Express 4 ignores a rejected promise, which would leave the request hanging. These pass it on.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((arg) => (typeof arg === 'function' ? wrap(arg) : arg)));
  }
  return router;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function hashIp(config, ip) {
  return crypto.createHmac('sha256', config.appSecret).update(ip ?? '').digest('hex').slice(0, 32);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function startSession(ctx, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.production,
    expires,
    path: '/',
  });
}

export function sessionHash(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return token ? sha256(token) : null;
}

export async function endSession(ctx, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export async function sessionUser(ctx, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await ctx.db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), nowIso());
  return row ?? null;
}

export const attachUser = (ctx) => wrap(async (req, _res, next) => {
  req.user = await sessionUser(ctx, req);
  next();
});

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please enter your details first.'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please enter your details first.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Administrators only.'));
  next();
}

// Session cookies are SameSite=Lax; this also rejects cross-site writes from older browsers.
export function sameOriginWrites(ctx) {
  const allowed = new URL(ctx.config.publicUrl).host;
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    const host = new URL(origin).host;
    if (host === allowed || host === req.headers.host) return next();
    next(new HttpError(403, 'Cross-site request refused.'));
  };
}

export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many attempts. Please wait a moment and try again.' }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const id = key(req);
    const entry = hits.get(id);
    if (!entry || entry.resetAt < now) {
      if (hits.size > 50000) hits.clear();
      hits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return next(new HttpError(429, message));
    next();
  };
}
