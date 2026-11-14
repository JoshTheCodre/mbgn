import path from 'node:path';
import { createSiteClient, runSender } from './sender.js';

// Settings come from .env (see .env.example) or the environment.
const env = process.env;
const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const siteUrl = env.SITE_URL?.trim();
const token = env.WHATSAPP_SENDER_TOKEN?.trim();
const transportName = (env.TRANSPORT ?? 'baileys').trim();
if (!siteUrl) fail('Set SITE_URL, for example https://www.mbgn.com.ng');
if (!token) fail('Set WHATSAPP_SENDER_TOKEN to the same value as on the site (Vercel).');
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(siteUrl.replace(/\/$/, ''));
// The token travels with every request, so only over HTTPS.
if (!siteUrl.startsWith('https://') && !local) fail('SITE_URL must start with https:// (http is only for a copy on this computer).');
if (transportName === 'dry-run' && !local) fail('A dry run marks messages as sent without sending them, so it only runs against a copy of the site on this computer.');

let transport;
if (transportName === 'baileys') {
  const { createBaileys } = await import('./transports/baileys.js');
  const pairingNumber = env.PAIRING_NUMBER?.replace(/\D/g, '') || null;
  transport = await createBaileys({ authDir: path.resolve(env.AUTH_DIR ?? 'auth'), pairingNumber, log });
} else if (transportName === 'evolution') {
  const { createEvolution } = await import('./transports/evolution.js');
  const { EVOLUTION_URL: url, EVOLUTION_API_KEY: apiKey, EVOLUTION_INSTANCE: instance } = env;
  if (!url || !apiKey || !instance) fail('For TRANSPORT=evolution, set EVOLUTION_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE.');
  transport = await createEvolution({ url, apiKey, instance, log });
} else if (transportName === 'dry-run') {
  const { createDryRun } = await import('./transports/dry-run.js');
  transport = createDryRun({ log });
  log.warn('Dry run: messages are printed here and marked as sent. Nothing goes out on WhatsApp.');
} else {
  fail('TRANSPORT must be baileys, evolution or dry-run.');
}

const seconds = (value, fallback, min) => Math.max(Number(value) || fallback, min) * 1000;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info('Stopping after the current message…');
    controller.abort();
    await transport.stop();
    setTimeout(() => process.exit(0), 500);
  });
}

log.info(`MBGN WhatsApp sender: ${transport.name}, collecting from ${siteUrl}`);
await runSender({
  site: createSiteClient({ siteUrl, token }),
  transport,
  pollMs: seconds(env.POLL_SECONDS, 15, 5),
  gapMs: seconds(env.SEND_GAP_SECONDS, 6, 2),
  log,
  signal: controller.signal,
});
