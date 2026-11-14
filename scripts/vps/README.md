# Database and WhatsApp on the VPS

The site stays on Vercel. The VPS runs, under Coolify, the database (instead of Neon) and Evolution
API (for WhatsApp messages). The VPS is in New Jersey, so when the database moves, Vercel's server
code moves from Frankfurt to Washington DC (`iad1`), a few milliseconds away. Pages and photos still
load from Vercel's worldwide network.

The two parts are independent: do WhatsApp first, the database first, or only one.

## The database

Everything runs from your PC with one script. Nothing needs doing on the VPS itself.

### 1. Set it up in Coolify (once)

In Coolify, open the PostgreSQL database:

1. **A new password.** The first one was shared in a chat, so change it before the database is
   reachable from the internet.
2. **SSL on.** The site connects encrypted, so passwords, phone numbers and payments never cross
   the internet readable.
3. **Make it publicly available**, on a public port other than 5432 (for example 54321). Vercel's
   servers have no fixed address, so the database can't be limited to them; the password and
   SSL protect it.
4. **Save, then restart** the database.

Any PostgreSQL version Coolify offers is fine. Recommended too:

- **Custom PostgreSQL configuration** (then restart):

  ```
  max_connections = 200
  idle_session_timeout = '10min'
  ```

  Every Vercel server keeps up to 5 connections, and the second line clears any left behind by
  servers Vercel froze.
- **Backups.** Under Backups, add a daily schedule, saved to S3 storage: add your R2 bucket in
  Coolify's S3 Storages (endpoint `https://<account id>.r2.cloudflarestorage.com`). Neon kept
  backups for you; here, this is what does it.

### 2. Switch the site to it

The site hasn't launched, so it starts on the VPS database empty: nothing comes over from Neon.
From the project folder:

```bash
powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1
```

The first time, it asks for Coolify's **Postgres URL (public)** (shown on the database page once
it's publicly available) and keeps it in `.secrets\`, which never leaves your PC. It asks once more
before doing anything, then:

1. empties the VPS database (a database called `mbgn`, made if needed) and builds the site's
   tables in it with the site's own code;
2. saves `DATABASE_URL` on Vercel (encrypted: `sslmode=no-verify`), moves the site's server code
   to Washington DC, deploys, and checks the live site.

Then log in to admin with the usual login (it comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on
Vercel) and set up the contest: prices, dates, WhatsApp groups. Commit `vercel.json` (it now says
`iad1`), so later deploys keep the site next to the VPS.

Once switched, running the script again does nothing, so live data can't be wiped by accident.

**After changing the database's password** in Coolify (save, restart), give the site the new
address. Nothing is emptied:

```bash
powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -NewAddress
```

It asks for the new **Postgres URL (public)**, checks it works, saves it on Vercel and deploys.

## WhatsApp, through Evolution API

Evolution holds the WhatsApp connection; the site sends through it itself. No ssh, no extra app.

1. **Evolution API in Coolify:** New > Service > **Evolution API**. Its domain must start with
   `https://` and end with its port, for example `https://mbgn.useqitt.app:8080`, or it gets no
   certificate. Deploy. Its API key is in the service's environment variables
   (`AUTHENTICATION_API_KEY`). The key opens everything, so keep it private.
2. **Link the contest phone:** open `https://<its domain>/manager`, sign in with the API key,
   create an instance (Baileys), and scan its QR code from the contest phone: WhatsApp > Linked
   devices > Link a device. Use a dedicated number (see `whatsapp-sender/README.md` on ban risk).
3. **Connect the site.** From the project folder:

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\whatsapp-site.ps1
   ```

   It asks for the API key and instance name, checks them, saves `EVOLUTION_URL`,
   `EVOLUTION_API_KEY` and `EVOLUTION_INSTANCE` on Vercel, and deploys.
4. **Catch up:** in admin, Messages > WhatsApp messages shows "Connected". Press **Message accepted
   contestants who haven't had one**.

From then on, an accepted contestant gets their message straight away. Bigger sends (like "voting
is open" to everyone) go out about 8 a minute, spaced out to protect the number, while the site has
visitors.
