# MBGN voting platform

Most Beautiful Girl Online Nigeria: contestant registration and approval, permanent contestant
codes, voting paid per vote through Paystack, a live leaderboard, public and private real-time
notifications, contestant dashboards and an admin control panel.

Next.js and Express on the server, Neon Postgres for data, Cloudflare R2 for photos, React on the
client, and server-sent events for live updates.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:3000. `npm test` runs the backend test suite on an in-memory Postgres, so
it needs no account.

The site itself needs `DATABASE_URL` in `.env`: a pooled Neon connection string. Use the `dev` branch of
the Neon project locally and keep `main` for the deployed site. Without the `R2_` settings, photos stay
in `data/uploads` on this machine.

Payments use a built-in simulator until `PAYSTACK_SECRET_KEY` is set in `.env`. With an `sk_test_` key,
checkout runs on Paystack's real test page, and no real money moves.

### Demo details (from `npm run seed`, development only)

Nobody signs in. Only the admin panel has a password.

| Who | How | Details |
| --- | --- | --- |
| Supporter | Open any contestant, choose votes and pay | None |
| Contestant | Go to `/dashboard` and enter email and WhatsApp number | stella@mbgn.local / 08030000001 (jennifer is ...0002, and so on) |
| Pending applicant | Same | ngozi@mbgn.local / 08031000001 |
| Admin | Go to `/admin` (not linked publicly) | admin@mbgn.local / admin-demo-pass |

Seeded people, totals and the sample past winner are invented. The five photos in `demo-photos/`
are AI-generated images of fictional adults, for demonstration only: never present them as real
contestants. Seeded contestants without a photo show a lettered placeholder. To add one, drop
`<stage name>.webp` into that folder and reseed. Real registrations must upload a photo.

## The test deployment on Vercel

The project runs on Next.js, with the server under `pages/api`, in Vercel's Frankfurt region next to
the Neon database. `next.config.mjs` sets `DEMO_MODE`, which loads the demo data and allows simulated
payments, so **it is for testing only**. The demo admin password above is public, so anyone can open the
admin panel of a demo deployment.

Vercel needs these environment variables: `DATABASE_URL` (the `main` branch), `APP_SECRET`,
`PAYSTACK_SECRET_KEY`, and all four `R2_` settings. `APP_SECRET` must stay the same on every server copy,
because the network-based fraud checks compare values made with it.

## Going live

Remove `DEMO_MODE` from `next.config.mjs` first, then:

1. Set `NODE_ENV=production`, `DATABASE_URL`, the `R2_` settings, `PUBLIC_URL`, `APP_SECRET`,
   `ADMIN_EMAIL` and `ADMIN_PASSWORD` (see `.env.example`). Do not run the seed, and start from a clean
   database rather than the demo one.
2. Set `PAYSTACK_SECRET_KEY` to a live key (`sk_live_`), and `PAYMENT_EMAIL` to a mailbox on your own
   domain. The server refuses to start in production without them, or with a test key. Use a Paystack
   account of MBGN's own: its business name shows on checkout, and the money settles to its bank.
3. In the Paystack dashboard (Settings > API Keys & Webhooks), set the webhook URL to
   `https://your-domain/api/webhooks/paystack`. An account has one webhook URL for each mode.
4. Set `SMTP_URL` so emails are delivered. Without it they only reach the admin email log.
5. Back up the database. Neon's free plan can only restore the last 6 hours, and a busy site can use up
   its monthly compute hours, so move to a paid plan for the live contest.

## How a contest runs

1. **Registration** is the starting stage. The home page promotes joining and the prize, with a countdown,
   and voting pages are hidden. Approved contestants get their code and voting link, ready to share.
   A new contest gets a 7-day deadline, which an admin can change or remove on the Competition tab. At the
   deadline new applications stop by themselves. A later date reopens them.
2. **Voting** only starts when an admin presses **End registration and start voting** on the Competition tab,
   whether or not the deadline has passed, which leaves time to finish reviewing.
   New applications stop, approved contestants are told by email, and the voting pages appear. Waiting
   applications can still be approved afterwards. An admin can reopen registration, which stops voting
   and keeps the votes.

The prize amount on the registration page is set in [client/pages/public.jsx](client/pages/public.jsx).

## How the important guarantees work

- **Pay to vote, no sign-in and no email.** A supporter picks a number of votes and pays. Paystack
  requires a customer email, so each payment sends `PAYMENT_EMAIL` with its reference added. An
  optional "Email me this receipt" on the confirmation page sends one receipt per payment.
- **Fraud checks lean on the network.** Without supporter emails, the flags for rapid or repeated
  payments compare hashed IP addresses. Mobile carriers share these, so limits are high and flags only
  ask for review. A self-vote is only spotted from the browser a contestant joined on, or if they
  ask for the receipt with their own email.
- **Payments can be followed by reference.** Each payment has a long random reference. Whoever holds
  it can see that payment's status and receipt, with any email masked.
- **Late payments.** A payment started while voting was open still counts if Paystack confirms it after
  closing. Leave some time between closing and publishing final results, so open checkouts can finish.
  If votes can no longer be counted, the payment is flagged for a refund.
- **Votes count only after server-to-server verification.** `settlePayment` in
  [server/payments.js](server/payments.js) is the only path to votes. It asks Paystack directly
  and checks status, amount and currency. Browser redirects and webhooks only trigger that check.
- **No double votes.** One atomic status change decides who records a payment's votes, and the
  database allows only one vote record per payment. Changes to votes and ranks take turns across every
  server copy, through a database lock. Visits to the site also trigger a recheck of pending payments
  every five minutes, in case a webhook was missed.
- **Photos stay private until approval.** The R2 bucket is private. Every photo goes through the site,
  which only serves an unapproved contestant's photo to that contestant and to admins.
- **Refunds happen in Paystack.** Voiding a vote removes it from the totals. Returning the money is
  done separately in Paystack, and the site does not track it.
- **Recognising contestants.** Joining identifies the contestant and keeps that browser recognised.
  On a new device, their email and WhatsApp number reopen the read-only dashboard, and anyone who
  knows both can view it.
- **Codes are never reused.** They come from a counter that only moves forward. Rejected,
  suspended and disqualified contestants keep theirs.
- **Supporter privacy.** Public messages and contestant dashboards carry vote counts and times
  only. Contestants' private alerts go only to connections logged in as that contestant.
- **Ranking.** Most valid votes first; on a tie, whoever reached that total first stays ahead.
  Movement compares with hourly rank snapshots from 24 hours ago.

## Limits to know about

- Instant updates only reach people connected to the same server copy. Pages also refresh every 20
  seconds, so on Vercel the leaderboard is at most that far behind, but a live pop-up can be missed.
  Instant updates everywhere would need Redis pub/sub in [server/realtime.js](server/realtime.js).
- Rate limits are counted per server copy, so on Vercel they are looser than their numbers suggest.
- Contestant alerts are delivered in-app and live. Web push and SMS (optional in the spec) are not
  built. Email covers applications, approval, status changes and announcements, not every vote.
- Starting a new edition has no one-click reset. Past results stay on the Winners page, and past
  winners can be added by hand.
- A payment reversed by Paystack after its votes were counted is not taken back automatically.
