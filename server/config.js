import path from 'node:path';
import crypto from 'node:crypto';

// Everything environment-specific lives here. Tests pass overrides directly.
export function loadConfig(overrides = {}) {
  const env = process.env;
  // Written out in full so next.config can set it at build time.
  const demo = process.env.DEMO_MODE === '1';
  const production = !demo && (overrides.nodeEnv ?? env.NODE_ENV) === 'production';
  // Vercel's only writable folder. It is temporary and separate for each server instance.
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? (env.VERCEL ? '/tmp/mbgn' : path.resolve('data'));
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;

  const paystack = overrides.paystack ?? (env.PAYSTACK_SECRET_KEY
    ? { secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: 'https://api.paystack.co' }
    : null);

  if (paystack && !/^sk_(test|live)_/.test(paystack.secretKey)) {
    throw new Error('PAYSTACK_SECRET_KEY must be a secret key, starting sk_test_ or sk_live_.');
  }
  // The simulator and Paystack's test mode both count votes without real money,
  // so neither may run in production.
  if (production && !paystack) {
    throw new Error('Refusing to start in production without a Paystack key: the payment simulator is dev-only.');
  }
  if (production && !paystack.secretKey.startsWith('sk_live_')) {
    throw new Error('Refusing to start in production with a Paystack test key: votes would be free.');
  }

  const appSecret = overrides.appSecret ?? env.APP_SECRET;
  if (production && !appSecret) throw new Error('APP_SECRET is required in production.');

  const paymentEmail = overrides.paymentEmail ?? env.PAYMENT_EMAIL;
  if (production && !paymentEmail) throw new Error('PAYMENT_EMAIL is required in production: Paystack needs a customer email on every payment.');

  const databaseUrl = overrides.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl && !overrides.dbDriver) throw new Error('DATABASE_URL is required. See the README.');

  const r2 = overrides.r2 ?? (env.R2_ACCOUNT_ID
    ? {
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
      }
    : null);
  if (r2 && !(r2.accessKeyId && r2.secretAccessKey && r2.bucket)) {
    throw new Error('R2_ACCOUNT_ID is set, so R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required too.');
  }
  // Vercel has no permanent disk, so uploaded photos would vanish.
  if (env.VERCEL && !r2) throw new Error('The R2_ settings are required on Vercel: photos need permanent storage.');

  return {
    production,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    publicUrl: (overrides.publicUrl ?? env.PUBLIC_URL ?? vercelUrl ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
    dataDir,
    databaseUrl,
    dbDriver: overrides.dbDriver ?? null,
    r2,
    uploadDir: overrides.uploadDir ?? path.join(dataDir, 'uploads'),
    appSecret: appSecret ?? crypto.randomBytes(32).toString('hex'),
    // Vercel always sits behind its own proxy, which reports the visitor's real address.
    trustProxy: env.TRUST_PROXY === '1' || Boolean(env.VERCEL),
    codePrefix: overrides.codePrefix ?? env.CODE_PREFIX ?? 'MBG',
    paystack,
    // A reserved domain that Paystack accepts, for testing only.
    paymentEmail: paymentEmail ?? 'votes@example.com',
    smtpUrl: overrides.smtpUrl ?? env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM ?? 'MBGN <no-reply@mbgn.example>',
    adminEmail: overrides.adminEmail ?? env.ADMIN_EMAIL ?? null,
    adminPassword: overrides.adminPassword ?? env.ADMIN_PASSWORD ?? null,
    // How long votes are gathered into one public/private notification.
    // Zero on Vercel, where a timer may never fire once the request has finished.
    activityWindowMs: overrides.activityWindowMs ?? (env.VERCEL ? 0 : 2000),
    rateLimitScale: overrides.rateLimitScale ?? 1,
  };
}
