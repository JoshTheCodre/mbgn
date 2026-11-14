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

Supporters never sign in. Contestants use their phone number and a 4-digit PIN, and admins a password.

| Who | How | Details |
| --- | --- | --- |
| Supporter | Open any contestant, choose votes and pay | None |
| Contestant | Go to `/dashboard`. Seeded contestants have no PIN yet, so open "No PIN yet?", enter email and WhatsApp number, and choose a PIN | stella@mbgn.local / 08030000001 (jennifer is ...0002, and so on) |
| Pending applicant | Same | ngozi@mbgn.local / 08031000001 |
| Admin | Go to `/admin` (not linked publicly) | admin@mbgn.local / admin-demo-pass |

Seeded people, totals and the sample past winner are invented. The five photos in `demo-photos/`
are AI-generated images of fictional adults, for demonstration only: never present them as real
contestants. Seeded contestants without a photo show a lettered placeholder. To add one, drop
`<stage name>.webp` into that folder and reseed. Real registrations must upload a photo.

## Demo mode

`DEMO_MODE=1` in `.env` fills an empty database with invented contestants, allows simulated payments, and
uses the public demo admin login above. It is for trying the site out on your own computer. Vercel
runs the site in Frankfurt, next to the Neon database, **without** demo mode: there it is the live site.

Vercel needs these environment variables: `DATABASE_URL` (the `main` branch), `APP_SECRET`, the `R2_`
settings, a live `PAYSTACK_SECRET_KEY` and `PAYMENT_EMAIL`. Without demo mode, the server refuses to start
without them, or with a Paystack test key. `APP_SECRET` must stay the same on every server copy, because
the network-based fraud checks compare values made with it.

The database and WhatsApp can run on our VPS under Coolify instead: see
[scripts/vps/README.md](scripts/vps/README.md). `scripts\switch-db-to-vps.ps1` copies the data from
Neon and switches the site, all from this PC. The site reaches the database encrypted
(`sslmode=no-verify` in `DATABASE_URL`). For a stricter connection, `DATABASE_CA_CERT` can hold
the certificate of the database's own certificate authority, like Coolify's (line breaks may be
written as `\n`), and the site then only connects to a server that authority signed.
`DB_POOL_MAX` (default 5) is how many connections each server keeps.

## Going live

The site ran as a demo until November 2026. To switch it to real money:

1. **Back up the database.** In the Neon console, create a branch from `main` (Branches > Create
   branch). That keeps a copy of everything as it was, in case anything needs to come back.
2. **Run `scripts\paystack-live.ps1`** (`powershell -ExecutionPolicy Bypass -File scripts\paystack-live.ps1`).
   It asks for the live Paystack secret and public keys, the payment mailbox, and optionally a new admin
   email and password (it offers the one in `.secrets/admin-login.txt`), sets the site's address to
   https://www.mbgn.com.ng, saves it all on Vercel, and deploys. Use a Paystack account of MBGN's own: its
   business name shows on checkout, and the money settles to its bank.
3. **On its first start as the live site, the server clears the test data, once:** the invented demo
   contestants (their emails end `@mbgn.local`) and their accounts go, as do every vote, payment and
   admin vote change so far, since none of it was real money. Real applicants stay, with their details,
   PINs, codes and WhatsApp groups, back at zero votes. The contest goes back to registration with a fresh
   7-day countdown, which an admin can change. The audit log records what was removed.
4. **The admin login comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on Vercel** whenever they change, which
   is also the way back in after a forgotten password. In between, changes under **Your login** stay.
5. In the Paystack dashboard (Settings > API Keys & Webhooks, Live mode), set the webhook URL to
   `https://www.mbgn.com.ng/api/webhooks/paystack`. An account has one webhook URL for each mode.
   Under Settings > Preferences, tick **Bank Transfer**, **Card** and **Bank** as payment channels.
   Supporters choose how to pay on the vote panel. A bank transfer shows an account number from
   Paystack on our own page, valid for 60 minutes. Card and OPay (inside Paystack's "Bank" channel)
   open Paystack's checkout on that option. If Paystack can't open a transfer account, the supporter
   goes to Paystack's transfer page instead, so voting never stops.
6. On the Competition tab, set the registration countdown, check the prices and add a WhatsApp group.
7. Set `SMTP_URL` so emails are delivered. Without it they only reach the admin email log.
   For WhatsApp messages to contestants (accepted, with code, voting link and group link; and
   "voting is open"), set `WHATSAPP_SENDER_TOKEN` and run the sender in `whatsapp-sender/` on an
   always-on machine. Its README explains each step.
8. Neon's free plan can only restore the last 6 hours, and a busy site can use up its monthly compute
   hours, so move to a paid plan for the live contest.

## How a contest runs

1. **Registration** is the starting stage. The home page promotes joining and the prize, with a countdown,
   and voting pages are hidden. Approved contestants get their code and voting link, ready to share.
   A new contest gets a 7-day deadline, which an admin can change or remove on the Competition tab. At the
   deadline new applications stop by themselves. A later date reopens them.

   **The follower check** runs when someone sends the form. Applicants choose one account, on Instagram,
   TikTok or Facebook, which needs the number of followers set on the Competition tab (800 to begin with).
   They must tick that the account is theirs: using someone else's means disqualification, as the
   Contest rules page (`/rules`) says.
   - *Passed:* the application goes to the review team, and they get their WhatsApp group link on screen,
     on their dashboard and by email.
   - *Not enough:* nothing is saved, and they can try again.
   - *Could not be read* (a private page, or no service could answer): the application goes through
     marked "Check followers by hand". They get the group link once approved.

   The networks block sites from reading follower counts themselves, so data services do it. These are
   tried in order, each only if its key is set on Vercel, and each has a free plan:

   | Service | Key | Reads | Free plan |
   | --- | --- | --- | --- |
   | ScrapeCreators | `SCRAPECREATORS_API_KEY` | Instagram, TikTok, Facebook | about 100 credits, once |
   | SocialCrawl | `SOCIALCRAWL_API_KEY` | Instagram, TikTok | 100 credits, once |
   | SociaVault | `SOCIAVAULT_API_KEY` | Instagram, TikTok | 50 credits, once |
   | HikerAPI | `HIKERAPI_KEY` | Instagram | 100 requests, once |
   | Apify | `APIFY_TOKEN` | Instagram, TikTok, Facebook | $5 of use a month (slower) |

   When a service has no answer, the next one is asked. When it runs out of credits or refuses its key,
   it is skipped for 6 hours. A count read in the last 24 hours is reused, so retries cost nothing. The
   Competition tab shows each service's status and use, has a **Test an account** tool, and lets an admin
   choose to check every application by hand instead. Free plans and their prices change, so check each
   service's site.

   **WhatsApp groups** are added on the Competition tab. Links go out from the oldest open group with room,
   so the next group takes over when one fills up, or when an admin marks it as full. If none has room,
   people wait and get the link by email as soon as an admin adds a group. WhatsApp does not report who
   actually joined, so a group's count is the number of people given its link.
2. **Voting** starts by itself when the registration countdown ends, and anyone on the home page is taken
   to the contestants. An admin can untick **Start voting automatically when the countdown ends** on the
   Competition tab, to keep time to finish reviewing, and press **End registration and start voting** instead.
   New applications stop, approved contestants are told by email, and the voting pages appear. Waiting
   applications can still be approved afterwards. An admin can reopen registration, which stops voting
   and keeps the votes. Voting stops by itself at the **Voting closes** time, if one is set.

The prize amount on the registration page is set in [client/pages/public.jsx](client/pages/public.jsx).

## What admins control

Everything below is on the control panel at `/admin`, so nobody needs to change code.

- **Countdowns:** the Contest stage panel on the Competition tab always shows the countdown that matters.
  During registration it sets when registration closes. During voting it sets when voting closes, and
  reopening registration asks for a new countdown, so voting does not start again straight away.
- **Site look:** the Site look panel picks which themes visitors can switch between with the Theme
  button, and the one new visitors see. With only one ticked, the button is hidden.
- **Prices:** the normal price per vote (₦200 to begin with) and the bulk deals. From a deal's number of
  votes upwards, every vote costs that deal's rate: with 50 votes for ₦8,000, 70 votes cost ₦160 each.
  The panel warns when a bigger deal costs more per vote than a smaller one. Before paying, every
  supporter is offered the next deal up, and can say no.
- **Votes bought in person:** on the Payments & votes tab, admins record votes someone paid for directly,
  with cash, a transfer or POS: the contestant, number of votes, how they paid and the voter's
  name. The amount is the normal price, bulk deals included. They become an ordinary paid payment, so
  they count at once, show in revenue (and separately as "in person" on the overview), and the buyer
  gets a proof of vote and receipt. Each records the admin who took the money. Only while voting is open.
- **Votes by hand:** on a contestant's details, admins can add or remove votes for corrections. Each change
  needs a reason, and stays in that contestant's log, the audit log and the contestants export. These
  votes have no payment behind them.
- **Rules and privacy:** the Contest rules (`/rules`) and Privacy (`/privacy`) pages are linked from the
  footer. Their text is in [client/pages/info.jsx](client/pages/info.jsx), and shows the live follower
  minimum, vote price and bulk deals.
- **Enquiries:** the Sponsorship / Enquiry page sends messages to the Enquiries tab and to every admin by
  email. Admins can add a phone number and email to show on that page.
- **Rounds and eliminations:** on the Competition tab, add rounds with a start and end time and their
  rules: keep the top N, a minimum number of votes (in the round, or in total), or both, plus a number
  of probation places. When a round ends, by itself at its end time or when an admin presses **End now**,
  everyone who misses the rules is eliminated, except the best few below the cut, who stay in on
  probation. Anyone already on probation who misses again is eliminated. Everyone is told by
  notification and email. The panel previews the outcome of the round that is on now. Eliminated
  contestants leave the leaderboard, their voting link says what happened, and an admin can reinstate
  them. Admins can also put a contestant on probation, or take them off it, by hand.
- **Contestant accounts:** admins approve or reject a new public name or photo, and can reset a
  forgotten PIN on the contestant's details.

A contest still on the old ₦500 prices moves to ₦200 with the 50 and 100 vote deals the first time the
new version starts. A contest whose prices an admin has already changed is left as it is.

## How the important guarantees work

- **Pay to vote, with a name and no email.** A supporter types their name, picks a number of votes and
  pays. The name goes on the proof of vote that pops up once the payment is confirmed, which they can
  save as a picture or share. Only they and the admins see it. Paystack requires a customer email, so
  each payment sends `PAYMENT_EMAIL` with its reference added. An optional "Email me this receipt" on
  the confirmation page sends one receipt per payment.
- **Fraud checks lean on the network.** Without supporter emails, the flags for rapid or repeated
  payments compare hashed IP addresses. Mobile carriers share these, so limits are high and flags only
  ask for review. A self-vote is only spotted from the browser a contestant joined on, or if they
  ask for the receipt with their own email.
- **Payments can be followed by reference.** Each payment has a long random reference. Whoever holds
  it can see that payment's status and receipt, with any email masked.
- **Late payments.** A payment started while voting was open still counts if Paystack confirms it after
  closing. Leave some time between closing and publishing final results, so open checkouts can finish.
  If votes can no longer be counted, the payment is flagged for a refund.
- **Paid votes count only after server-to-server verification.** The one exception is votes an admin
  adds by hand, which are logged with a reason. `settlePayment` in
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
- **Contestant logins.** Joining keeps that browser signed in. On any other phone, the phone or WhatsApp
  number they joined with and the 4-digit PIN they chose open the dashboard. Obvious PINs like 1234 are
  refused, PINs are stored hashed, and five wrong tries lock the account for 30 minutes. A WhatsApp
  number can only be on one application. Contestants who joined before PINs existed, or whose PIN an
  admin reset, open the dashboard once with email and WhatsApp number and choose a PIN; after that only
  the PIN works. Changing the PIN signs out every other phone.
- **Contestants can correct their details.** Before approval, any change applies at once. After it, a
  new public name or photo waits for an admin, and the old one stays on the site until then. Social
  accounts can't be changed by the contestant, because the follower check used them.
- **Codes are never reused.** They come from a counter that only moves forward. Rejected,
  suspended and disqualified contestants keep theirs.
- **Supporter privacy.** Public messages and contestant dashboards carry vote counts and times
  only. Contestants' private alerts go only to connections logged in as that contestant.
- **Ranking.** Most valid votes first; on a tie, whoever reached that total first stays ahead.
  Movement compares with hourly rank snapshots from 24 hours ago.
- **Large contests.** Built for thousands of contestants and over a hundred thousand votes. Lists load
  200 at a time with "Show more". Messages to everyone (voting opening, round results, announcements)
  are saved in a few large writes, and their emails are queued and sent in batches in the background,
  continuing on later visits, so no request runs out of time. Recording a payment's votes, re-ranking
  3,000 contestants included, took about 13 ms in testing.

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
- The follower check proves an account has the followers, not that the applicant owns it, or that the
  followers are real. One account can only be on one application, and admins see the links and counts
  when approving.
