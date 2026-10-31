# MBGN voting platform

Most Beautiful Girl Online Nigeria: contestant registration and approval, permanent contestant
codes, a voting-credit wallet paid through Monnify, a live leaderboard, public and private real-time
notifications, contestant dashboards and an admin control panel.

Node.js, Express and SQLite on the server; React on the client; server-sent events for live updates.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npm run seed
npm run build
npm start
```

Then open http://localhost:3000. Use `npm run dev` instead of build and start for hot reloading.
`npm test` runs the backend test suite.

### Demo details (from `npm run seed`, development only)

Nobody signs in. Only the admin panel has a password.

| Who | How | Details |
| --- | --- | --- |
| Supporter (no details needed) | Open any contestant and choose votes | Pay directly, or fund a wallet |
| Supporter with a wallet (40 credits) | Go to `/wallet` and enter email and phone | supporter@mbgn.local / 08030000000 |
| Contestant | Go to `/dashboard` and enter email and WhatsApp number | stella@mbgn.local / 08030000001 (jennifer is ...0002, and so on) |
| Pending applicant | Same | ngozi@mbgn.local / 08031000001 |
| Admin | Go to `/admin` (not linked publicly) | admin@mbgn.local / admin-demo-pass |

Seeded people, totals and the sample past winner are invented. The five photos in `demo-photos/`
are AI-generated images of fictional adults, for demonstration only: never present them as real
contestants. Seeded contestants without a photo show a lettered placeholder. To add one, drop
`<stage name>.webp` into that folder and reseed. Real registrations must upload a photo.

## Going live

1. Copy `.env.example` to `.env`. Set `NODE_ENV=production`, `PUBLIC_URL`, `APP_SECRET`,
   `TRUST_PROXY=1` if behind a proxy, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Do not run the seed.
2. Add your Monnify keys and contract code. The server refuses to start in production without them.
   Test on `MONNIFY_ENV=sandbox` first, then switch to `live`.
3. In the Monnify dashboard (Developer > Webhook URLs), set Transaction Completion to
   `https://your-domain/api/webhooks/monnify`.
4. Set `SMTP_URL` so emails are delivered. Without it they only reach the admin email log.
5. Host somewhere with a persistent disk, running one server process, behind HTTPS. `DATA_DIR` holds
   the database and the photos, so back it up. Serverless hosts such as Vercel will not work:
   live updates need a long-running process.

## How the important guarantees work

- **Two ways to vote, no sign-in.** Pay directly (email for the receipt, nothing stored as a wallet)
  or fund a wallet and vote. A wallet is created silently the first time someone funds one, from
  their email and phone number, and that browser is recognised for 30 days. The same details reopen
  it on any device, so anyone who knows both could spend its credits on votes (never withdraw them).
- **Payments can be followed by reference.** Each payment has a long random reference. Whoever holds
  it can see that payment's status and receipt, with the email masked.
- **Late payments.** A payment started while voting was open still counts if Monnify confirms it after
  closing. Publish final results at least 40 minutes after closing, when checkouts expire. If votes
  can no longer be cast, wallet credits stay in the wallet, and a direct payment is flagged for a refund.
- **Payments credit only after server-to-server verification.** `settlePayment` in
  [server/payments.js](server/payments.js) is the only path to credits. It asks Monnify directly
  and checks status, amount and currency. Browser redirects and webhooks only trigger that check.
- **No double credits.** One atomic status change decides who credits a payment, and a unique
  database index refuses a second purchase entry for it. A job also rechecks pending payments every
  five minutes in case a webhook was missed.
- **No double votes or overdrafts.** Each vote carries a unique request id, and the balance check
  and deduction are one atomic statement inside a transaction.
- **Recognising contestants.** Joining identifies the contestant and keeps that browser recognised.
  On a new device, their email and WhatsApp number reopen the read-only dashboard, and anyone who
  knows both can view it. Someone who already has a wallet keeps their credits when they join.
- **Codes are never reused.** They come from a counter that only moves forward. Rejected,
  suspended and disqualified contestants keep theirs.
- **Supporter privacy.** Public messages and contestant dashboards carry vote counts and times
  only. Contestants' private alerts go only to connections logged in as that contestant.
- **Ranking.** Most valid votes first; on a tie, whoever reached that total first stays ahead.
  Movement compares with hourly rank snapshots from 24 hours ago.

## Limits to know about

- Real-time updates run in one process. Scaling to several servers needs Redis pub/sub in
  [server/realtime.js](server/realtime.js) and moving from SQLite to Postgres.
- Contestant alerts are delivered in-app and live. Web push and SMS (optional in the spec) are not
  built. Email covers applications, approval, status changes and announcements, not every vote.
- Starting a new edition has no one-click reset. Past results stay on the Winners page, and past
  winners can be added by hand.
- A payment reversed by Monnify after being credited is not taken back automatically.
