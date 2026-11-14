# Database and WhatsApp on the VPS

The site stays on Vercel. The VPS runs, under Coolify, the database (instead of Neon) and Evolution
API (for WhatsApp messages). The VPS is in New Jersey, so when the database moves, Vercel's server
code moves from Frankfurt to Washington DC (`iad1`), a few milliseconds away. Pages and photos still
load from Vercel's worldwide network.

The two parts are independent: do WhatsApp first, the database first, or only one.

## The database

### 1. Set it up in Coolify (once)

In Coolify, open the PostgreSQL database:

1. **Version 18.** Under General, Image must be `postgres:18-alpine` (Neon runs 18, and the copy
   needs the same or newer). While it holds no MBGN data, it's fine to delete it and create a new
   one with that image. If version 18 won't start, change the Persistent Storage path from
   `/var/lib/postgresql/data` to `/var/lib/postgresql`.
2. **A new password.** The first one was shared in a chat, so change it before the database is
   reachable from the internet. Save, then restart the database.
3. **SSL on.** The site connects encrypted, so passwords, phone numbers and payments never cross
   the internet readable.
4. **Make it publicly available**, on a public port other than 5432 (for example 54321). Vercel's
   servers have no fixed address, so the database can't be limited to them; the password and
   SSL protect it.
5. **Custom PostgreSQL configuration:**

   ```
   max_connections = 200
   idle_session_timeout = '10min'
   ```

   Every Vercel server keeps up to 5 connections, and the second line clears any left behind by
   servers Vercel froze.
6. **Backups.** Under Backups, add a daily schedule, saved to S3 storage: add your R2 bucket in
   Coolify's S3 Storages (endpoint `https://<account id>.r2.cloudflarestorage.com`). Neon kept
   backups for you; here, this is what does it.

### 2. Copy the data (a test run is safe at any time)

From the project folder on your PC:

```bash
scp scripts/vps/copy-from-neon.sh root@162.35.44.225:
```

```bash
ssh -t root@162.35.44.225 "bash copy-from-neon.sh"
```

It asks for Neon's connection string (on Vercel: Settings > Environment Variables > `DATABASE_URL`)
and copies everything into a database called `mbgn` on the VPS. Neon is only read. The site keeps
using Neon until step 3.

Then check the site will be able to use it. This changes nothing:

```bash
powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -CheckOnly
```

It asks for Coolify's **Postgres URL (public)** and shows what it found.

### 3. Switch (a quiet hour, about 10 minutes)

1. **Pause voting** in admin. (During registration there's no voting to pause. Sign-ups in the
   minutes between the copy and the switch stay on Neon, and step 5 lists them.)
2. **Copy again**, so the VPS has everything up to now:
   `ssh -t root@162.35.44.225 "bash copy-from-neon.sh"`
   (add `FORCE=1` before `bash` if it says the VPS has newer data from your testing).
3. **Switch the site:**

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1
   ```

   It asks for Coolify's **Postgres URL (public)**, checks the connection first, keeps Neon's
   address in `.secrets\`, saves `DATABASE_URL` on Vercel (encrypted: `sslmode=no-verify`), moves
   the site to Washington DC, deploys, and checks the live site.

   For a stricter connection that also checks the server's certificate, add
   `-VerifyCertificate -Server root@162.35.44.225`: it fetches Coolify's certificate authority over
   ssh and saves it on Vercel as `DATABASE_CA_CERT`.
4. **Resume voting** in admin.
5. **Check nothing was left behind on Neon:**
   `ssh -t root@162.35.44.225 "bash copy-from-neon.sh check"`
6. **Commit** `vercel.json` (it now says `iad1`), so later deploys keep the site next to the VPS.

Keep Neon for a week. To go back to it at any point (anything that came in since the switch stays
only on the VPS):

```bash
powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -Back
```

## WhatsApp, through Evolution API

1. **In Coolify:** New > Service > **Evolution API**, then deploy. Note its address, and its API key
   (in the service's environment variables, `AUTHENTICATION_API_KEY`). The key opens everything, so
   keep it private.
2. **Link the contest phone:** open `<its address>/manager`, sign in with the API key, create an
   instance called `mbgn` (Baileys), and scan its QR code from the contest phone: WhatsApp >
   Linked devices > Link a device. Use a dedicated number (see `whatsapp-sender/README.md` on
   ban risk).
3. **Start the sender** (it takes messages from the site's queue and hands them to Evolution, one
   every 6 seconds). From the project folder:

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\whatsapp-vps.ps1 -Server root@162.35.44.225 -EvolutionUrl https://EVOLUTION_ADDRESS
   ```

   It asks for the API key (hidden), checks the instance, saves the sender token on Vercel, deploys,
   and installs the sender on the VPS.
4. **Catch up:** in admin, Messages > WhatsApp messages, press **Message accepted contestants who
   haven't had one**.
