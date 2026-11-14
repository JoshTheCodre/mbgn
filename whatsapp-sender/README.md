# MBGN WhatsApp sender

Sends contestants their WhatsApp messages from the contest's own number:

- **When an admin accepts them:** congratulations, their contestant code, their personal voting
  link, their WhatsApp group link, and when voting opens.
- **When voting opens:** a ready-to-forward "please vote for me" message with their link and code.

The site decides what to send and to whom. It writes each message to a queue. This program collects
them over a link secured with a shared token, sends them one at a time, and reports back. Progress
shows in the admin panel under **Messages > WhatsApp messages**.

## Why it's separate from the site

WhatsApp needs a connection that stays open, and Vercel only runs code for a moment per visit.
So this runs on any machine that stays on: a small VPS (about $5 a month), a spare computer, or
a Raspberry Pi. It only makes outgoing connections, so no ports need to be opened.

## Before you start: the number

Baileys (and Evolution API in its default mode) connects the way WhatsApp Web does. WhatsApp
does not officially support this, and it can ban numbers that send a lot of messages.

- Use a **dedicated number** for the contest, not anyone's personal or main business number.
- Keep the default pace (one message every 6 seconds). About 3,000 contestants take about 5 hours.
- Only contestants who applied and gave their number are messaged, once per event.

For no ban risk at all, WhatsApp's official Cloud API is the route. Evolution API can use it too.

## Setup: the quick way (Ubuntu or Debian VPS)

The token is already in `.secrets/whatsapp-sender-token.txt` (kept out of git). From the project
folder on your PC, signed in to Vercel, run:

```bash
powershell -ExecutionPolicy Bypass -File scripts\whatsapp-vps.ps1 -Server root@YOUR_VPS_IP
```

It saves the token on Vercel, deploys the site, copies this folder to the VPS, installs Node.js
and pm2 there, starts the sender, and shows the QR code to scan with the contest phone. When the
VPS asks, give its password (twice). Run it again any time to update the sender; the WhatsApp
login on the VPS is kept. Add `-PairingNumber 2348012345678` to link with a code instead of a QR.
With Evolution API running in Coolify, add `-EvolutionUrl https://...` instead: the phone is then
linked in Evolution's manager (see [scripts/vps/README.md](../scripts/vps/README.md)).

Then do step 6 below (catch up). The steps below are the same thing by hand.

## Setup by hand

1. **Make a token** (a long random secret):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. **Give it to the site:** add it on Vercel as `WHATSAPP_SENDER_TOKEN` and redeploy.

   ```bash
   npx vercel env add WHATSAPP_SENDER_TOKEN production
   ```

   From then on, accepting a contestant or opening voting queues their WhatsApp message.

3. **On the always-on machine** (Node.js 22.13 or newer), copy this folder and install:

   ```bash
   npm install
   cp .env.example .env
   ```

   In `.env`, set `SITE_URL` and the same `WHATSAPP_SENDER_TOKEN`.

4. **Start it and link the contest phone:**

   ```bash
   npm start
   ```

   A QR code appears. On the contest phone, open WhatsApp > **Linked devices** > **Link a
   device** and scan it. The admin panel then shows "Sending from +234…".

   On a server with no screen, set `PAIRING_NUMBER` to the contest number (like
   `2348012345678`) instead. It prints an 8-character code to enter under **Link with phone
   number instead**.

   The login is saved in `auth/`, so restarts reconnect without scanning again. Keep that
   folder private: it is the login. Deleting it, or unlinking the device on the phone, means
   scanning again.

5. **Keep it running** after you log out and across restarts, for example with pm2:

   ```bash
   npm install -g pm2
   pm2 start npm --name mbgn-whatsapp -- start
   pm2 save
   pm2 startup
   ```

   `pm2 logs mbgn-whatsapp` shows what it's doing.

6. **Catch up:** contestants accepted before this was set up haven't had a message. In admin,
   under **Messages > WhatsApp messages**, press **Message accepted contestants who haven't had
   one**.

## Using Evolution API instead

If you already run an [Evolution API](https://doc.evolution-api.com) server (v2) with the contest
number connected to an instance, set:

```
TRANSPORT=evolution
EVOLUTION_URL=https://your-evolution-server
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=mbgn
```

Evolution then holds the WhatsApp connection, and you link the phone in Evolution's manager
instead of here.

## Trying it without WhatsApp

Against a copy of the site running on this computer, `TRANSPORT=dry-run` prints each message
instead of sending it. It refuses any address but localhost, because it marks messages as sent.

## When something goes wrong

- **"The site refused the sender token":** the token in `.env` and on Vercel differ.
- **"The site has no WhatsApp sender":** `WHATSAPP_SENDER_TOKEN` isn't set on Vercel yet (or the
  site wasn't redeployed), or `SITE_URL` is wrong.
- **"Could not send" in admin:** usually "This number is not on WhatsApp". The contestant gave a
  number without WhatsApp, so it won't be tried again. Other errors are retried up to 3 times;
  **Try the failed ones again** in admin resets them.
- **The admin panel says the sender is offline:** it hasn't checked in for 2 minutes. Check the
  machine and `pm2 logs`. Messages wait in the queue meanwhile; nothing is lost.
