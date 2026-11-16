import path from 'node:path';
import crypto from 'node:crypto';

// Everything environment-specific lives here. Tests pass overrides directly.
export function loadConfig(overrides = {}) {
  const env = process.env;
  // Set in .env to try the site out with invented contestants. Never on the live site.
  const demo = process.env.DEMO_MODE === '1';
  const production = !demo && (overrides.nodeEnv ?? env.NODE_ENV) === 'production';
  // Vercel's only writable folder. It is temporary and separate for each server instance.
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? (env.VERCEL ? '/tmp/mbgn' : path.resolve('data'));
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;

  // Trimmed, since a key pasted into a dashboard or terminal often brings a line break with it.
  const paystackKey = env.PAYSTACK_SECRET_KEY?.trim();
  const paystack = overrides.paystack ?? (paystackKey
    ? { secretKey: paystackKey, baseUrl: 'https://api.paystack.co' }
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

  const paymentEmail = overrides.paymentEmail ?? env.PAYMENT_EMAIL?.trim();
  if (production && !paymentEmail) throw new Error('PAYMENT_EMAIL is required in production: Paystack needs a customer email on every payment.');

  const databaseUrl = overrides.databaseUrl ?? (env.DATABASE_URL?.trim() || undefined);
  if (!databaseUrl && !overrides.dbDriver) throw new Error('DATABASE_URL is required. See the README.');
  // For a database with its own certificate authority, like the one Coolify runs on the VPS: that
  // authority's certificate, so the connection is encrypted and the server checked. Neon needs none.
  // Accepts the certificate as is, or with its line breaks written as \n.
  const databaseCa = overrides.databaseCa ?? (env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim() || null);
  if (databaseCa && !databaseCa.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('DATABASE_CA_CERT must be a certificate, starting with -----BEGIN CERTIFICATE-----.');
  }
  // Evolution API, for WhatsApp messages sent by this site (see server/whatsapp.js).
  const evo = { url: env.EVOLUTION_URL?.trim().replace(/\/+$/, ''), apiKey: env.EVOLUTION_API_KEY?.trim(), instance: env.EVOLUTION_INSTANCE?.trim() };
  const evolution = overrides.evolution !== undefined ? overrides.evolution : (evo.url && evo.apiKey && evo.instance ? evo : null);
  if (!evolution && (evo.url || evo.apiKey || evo.instance)) throw new Error('EVOLUTION_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE are needed together.');
  if (production && evolution && !evolution.url.startsWith('https://')) throw new Error('EVOLUTION_URL must start with https://');
  // Connections each server keeps to the database. Every Vercel instance has its own set.
  const dbPoolMax = Number(overrides.dbPoolMax ?? env.DB_POOL_MAX ?? 5);
  if (!Number.isInteger(dbPoolMax) || dbPoolMax < 1) throw new Error('DB_POOL_MAX must be a whole number of 1 or more.');

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

  // Keys for the follower-count services, tried in order. Each has a free plan. See server/followers.js.
  // A service can have several keys: NAME, NAME_2, NAME_3, or a comma-separated list. The next key
  // takes over when one runs out.
  const keysFor = (name) => [env[name], env[`${name}_2`], env[`${name}_3`]]
    .flatMap((value) => (value ?? '').split(',')).map((key) => key.trim()).filter(Boolean);
  const followerKeys = overrides.followerKeys ?? {
    scrapecreators: keysFor('SCRAPECREATORS_API_KEY'),
    socialcrawl: keysFor('SOCIALCRAWL_API_KEY'),
    sociavault: keysFor('SOCIAVAULT_API_KEY'),
    hikerapi: keysFor('HIKERAPI_KEY'),
    apify: keysFor('APIFY_TOKEN'),
  };

  return {
    production,
    followerKeys,
    followerBaseUrls: overrides.followerBaseUrls ?? null,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    publicUrl: (overrides.publicUrl ?? env.PUBLIC_URL ?? vercelUrl ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
    dataDir,
    databaseUrl,
    databaseCa,
    dbPoolMax,
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
    // Shared with whatsapp-sender/. Until it is set, no WhatsApp messages are written down.
    whatsappSenderToken: overrides.whatsappSenderToken ?? (env.WHATSAPP_SENDER_TOKEN?.trim() || null),
    evolution,
    // Tests replace how push notifications are delivered.
    pushSend: overrides.pushSend ?? null,
    // Messages sent per batch, and the gap between them: about 8 a minute.
    whatsappBatch: overrides.whatsappBatch ?? 8,
    whatsappGapMs: overrides.whatsappGapMs ?? 6000,
    mailFrom: env.MAIL_FROM ?? 'MBGN <no-reply@mbgn.example>',
    adminEmail: overrides.adminEmail ?? env.ADMIN_EMAIL ?? null,
    adminPassword: overrides.adminPassword ?? env.ADMIN_PASSWORD ?? null,
    // How long votes are gathered into one public/private notification.
    // Zero on Vercel, where a timer may never fire once the request has finished.
    activityWindowMs: overrides.activityWindowMs ?? (env.VERCEL ? 0 : 2000),
    rateLimitScale: overrides.rateLimitScale ?? 1,
  };
}
