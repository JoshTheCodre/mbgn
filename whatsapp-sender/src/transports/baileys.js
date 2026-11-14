import fs from 'node:fs';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// Connects to WhatsApp as a linked device of the contest's phone, the way WhatsApp Web does.
// The login is saved in authDir, so after the first scan it reconnects by itself.
export async function createBaileys({ authDir, pairingNumber = null, log = console }) {
  let sock = null;
  let state = 'starting';
  let account = null;
  let stopped = false;
  let pairingAsked = false;

  async function connect() {
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    // The WhatsApp Web version to present. Falls back to Baileys' own if the lookup fails.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    sock = makeWASocket({
      auth,
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('MBGN sender'),
      // The phone keeps getting its own notifications.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state = 'waiting_for_scan';
        if (pairingNumber) {
          if (!pairingAsked) {
            pairingAsked = true;
            const code = await sock.requestPairingCode(pairingNumber).catch((err) => log.error(`Could not get a pairing code: ${err.message}`));
            if (code) log.info(`\nOn the contest phone: WhatsApp > Linked devices > Link a device > Link with phone number instead, and enter:\n\n    ${code}\n`);
          }
        } else {
          log.info('\nOn the contest phone: WhatsApp > Linked devices > Link a device, and scan this code:\n');
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === 'open') {
        state = 'connected';
        account = (sock.user?.id ?? '').split(':')[0].split('@')[0] || null;
        log.info(`Connected to WhatsApp${account ? ` as +${account}` : ''}.`);
      }
      if (connection === 'close' && !stopped) {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone, or WhatsApp ended the session: start over with a new code.
          state = 'logged_out';
          account = null;
          pairingAsked = false;
          log.error('WhatsApp logged this sender out. Showing a new code to link it again.');
          fs.rmSync(authDir, { recursive: true, force: true });
        } else {
          state = 'reconnecting';
        }
        setTimeout(() => connect().catch((err) => log.error(`Could not reconnect: ${err.message}`)), 3000);
      }
    });
  }

  await connect();

  return {
    name: 'baileys',
    get state() { return state; },
    get account() { return account; },
    async send(to, text) {
      if (state !== 'connected') return { sent: false, error: 'Not connected to WhatsApp right now.' };
      const [found] = await sock.onWhatsApp(to);
      if (!found?.exists) return { sent: false, final: true, error: 'This number is not on WhatsApp.' };
      await sock.sendMessage(found.jid, { text });
      return { sent: true };
    },
    async stop() {
      stopped = true;
      sock?.end?.(undefined);
    },
  };
}
