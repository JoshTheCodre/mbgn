import path from 'node:path';
import crypto from 'node:crypto';

// Everything environment-specific lives here. Tests pass overrides directly.
export function loadConfig(overrides = {}) {
  const env = process.env;
  const production = (overrides.nodeEnv ?? env.NODE_ENV) === 'production';
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? path.resolve('data');

  const monnify = overrides.monnify ?? (env.MONNIFY_API_KEY
    ? {
        apiKey: env.MONNIFY_API_KEY,
        secretKey: env.MONNIFY_SECRET_KEY,
        contractCode: env.MONNIFY_CONTRACT_CODE,
        live: env.MONNIFY_ENV === 'live',
        baseUrl: env.MONNIFY_ENV === 'live' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com',
      }
    : null);

  if (monnify && !(monnify.secretKey && monnify.contractCode)) {
    throw new Error('MONNIFY_API_KEY is set, so MONNIFY_SECRET_KEY and MONNIFY_CONTRACT_CODE are required too.');
  }
  // The simulator hands out credits without real money, so it must never run in production.
  if (production && !monnify) {
    throw new Error('Refusing to start in production without Monnify keys: the payment simulator is dev-only.');
  }

  const appSecret = overrides.appSecret ?? env.APP_SECRET;
  if (production && !appSecret) throw new Error('APP_SECRET is required in production.');

  return {
    production,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    publicUrl: (overrides.publicUrl ?? env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'mbgn.sqlite'),
    uploadDir: overrides.uploadDir ?? path.join(dataDir, 'uploads'),
    appSecret: appSecret ?? crypto.randomBytes(32).toString('hex'),
    trustProxy: env.TRUST_PROXY === '1',
    codePrefix: overrides.codePrefix ?? env.CODE_PREFIX ?? 'MBG',
    monnify,
    smtpUrl: overrides.smtpUrl ?? env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM ?? 'MBGN <no-reply@mbgn.example>',
    adminEmail: overrides.adminEmail ?? env.ADMIN_EMAIL ?? null,
    adminPassword: overrides.adminPassword ?? env.ADMIN_PASSWORD ?? null,
    // How long votes are gathered into one public/private notification.
    activityWindowMs: overrides.activityWindowMs ?? 2000,
    rateLimitScale: overrides.rateLimitScale ?? 1,
  };
}
