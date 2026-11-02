import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp, createContext } from '../server/app.js';
import { formatCode } from '../server/competition.js';
import { loadConfig } from '../server/config.js';
import { setSetting } from '../server/db.js';
import { createFollowerChecker } from '../server/followers.js';
import { socialLink } from '../server/routes/public.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

// A real Postgres that runs in memory, so the tests need no account or network.
function memoryPostgres() {
  const pg = new PGlite({ parsers: { 20: Number, 1700: Number } });
  const shape = (result) => ({ rows: result.rows, changes: result.affectedRows ?? 0 });
  return {
    query: async (sql, params) => shape(await pg.query(sql, params)),
    transaction: (fn) => pg.transaction((t) => fn({
      query: async (sql, params) => shape(await t.query(sql, params)),
      exec: (sql) => t.exec(sql),
    })),
    close: () => pg.close(),
  };
}

// Most tests are about voting, so these sites start in the voting stage, and joining
// briefly reopens registration. `freshContest` keeps a new contest's real starting stage.
const votingSites = new Map();

async function boot(overrides = {}, { freshContest = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbgn-test-'));
  const config = loadConfig({
    nodeEnv: 'test',
    dataDir: dir,
    dbDriver: memoryPostgres(),
    uploadDir: path.join(dir, 'uploads'),
    publicUrl: 'http://localhost',
    adminEmail: 'admin@test.local',
    adminPassword: 'admin-password',
    activityWindowMs: 60,
    appSecret: 'test-secret',
    smtpUrl: null,
    paystack: null,
    followers: null,
    rateLimitScale: 1000,
    ...overrides,
  });
  const ctx = await createContext(config);
  const server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (!freshContest) {
    await setSetting(ctx.db, 'competition_phase', 'voting');
    votingSites.set(base, ctx);
  }
  return {
    ctx,
    base,
    async close() {
      ctx.activity.stop();
      ctx.bus.close();
      server.closeAllConnections();
      server.close();
      await ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A tiny cookie-keeping client, one per person.
function client(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, url, { body, form, headers } = {}) {
      const site = url === '/contestants/register' ? votingSites.get(base) : null;
      if (site) await setSetting(site.db, 'competition_phase', 'registration');
      const res = await fetch(`${base}/api${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      if (site) await setSetting(site.db, 'competition_phase', 'voting');
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
    get(url) { return this.req('GET', url); },
    post(url, body = {}) { return this.req('POST', url, { body }); },
  };
}

function registrationForm(name, overrides = {}) {
  const form = new FormData();
  const fields = {
    fullName: `${name} Private-Surname`,
    stageName: name,
    email: `${name.toLowerCase()}@test.local`,
    phone: `0803${crypto.randomInt(1000000, 9999999)}`,
    whatsapp: `0805${crypto.randomInt(1000000, 9999999)}`,
    state: 'Lagos',
    location: 'Ikeja',
    bio: 'A short biography that is certainly long enough.',
    instagram: `@${name.toLowerCase()}`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (!('noPhoto' in overrides)) form.set('photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
  return form;
}

async function makeContestant(app, admin, name) {
  const person = client(app.base);
  const res = await person.req('POST', '/contestants/register', { form: registrationForm(name) });
  assert.equal(res.status, 201);
  const { data: queue } = await admin.get(`/admin/contestants?q=${name}`);
  const id = queue[0].id;
  const { data: approved, status } = await admin.post(`/admin/contestants/${id}/approve`);
  assert.equal(status, 200);
  return { person, id, code: approved.code };
}

const emailFor = (name = 'sue') => `${name}${crypto.randomInt(1e9)}@test.local`;

// Pays through the simulated checkout, the way a supporter's browser does.
async function payForVotes(person, code, quantity) {
  const { data: started } = await person.post('/votes/pay', { code, quantity });
  await person.post(`/simulator/${started.reference}/pay`);
  const { data: verified } = await person.post(`/payments/${started.reference}/verify`);
  assert.equal(verified.status, 'paid');
  return started.reference;
}

// Listens on the SSE stream and records every event it receives.
async function listen(base, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal });
  const events = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (name) events.push({ name, data: JSON.parse(data), raw: block });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, stop: () => controller.abort() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MBGN platform', () => {
  let app;
  let admin;

  before(async () => {
    app = await boot();
    admin = client(app.base);
    const res = await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
    assert.equal(res.status, 200);
  });
  after(() => app.close());

  test('registration enters the review queue and stays private until approved', async () => {
    const person = client(app.base);
    const res = await person.req('POST', '/contestants/register', { form: registrationForm('Pending') });
    assert.equal(res.status, 201);

    const { data: board } = await client(app.base).get('/leaderboard');
    assert.ok(!board.rows.some((r) => r.name === 'Pending'));

    const { data: queue } = await admin.get('/admin/contestants?status=pending&q=Pending');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].code, null);

    // The photo is hidden from the public but visible to its owner and to admins.
    const url = `${app.base}${queue[0].photoUrl}`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { headers: { Cookie: admin.cookie } })).status, 200);
    assert.equal((await fetch(url, { headers: { Cookie: person.cookie } })).status, 200);
  });

  test('registration rejects non-images, missing photos and unsafe social links', async () => {
    const bad = registrationForm('Fake', { noPhoto: '1' });
    bad.set('photo', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
    assert.equal((await client(app.base).req('POST', '/contestants/register', { form: bad })).status, 400);

    const none = registrationForm('Nophoto', { noPhoto: '1' });
    assert.equal((await client(app.base).req('POST', '/contestants/register', { form: none })).status, 400);

    const evil = registrationForm('Evil', { tiktok: 'javascript:alert(1)' });
    assert.equal((await client(app.base).req('POST', '/contestants/register', { form: evil })).status, 400);
  });

  test('codes are sequential, permanent and never reassigned', async () => {
    assert.equal(formatCode('MBG', 7), 'MBG007');
    assert.equal(formatCode('MBG', 1234), 'MBG1234');

    const a = await makeContestant(app, admin, 'CodeA');
    const b = await makeContestant(app, admin, 'CodeB');
    assert.match(a.code, /^MBG\d{3,}$/);
    const seqOf = (code) => Number(code.replace('MBG', ''));
    assert.equal(seqOf(b.code), seqOf(a.code) + 1);

    // Disqualified contestants keep their code, and the next approval gets a fresh one.
    await admin.post(`/admin/contestants/${a.id}/disqualify`, { reason: 'Broke the rules' });
    const c = await makeContestant(app, admin, 'CodeC');
    assert.equal(seqOf(c.code), seqOf(b.code) + 1);
    const { data: list } = await admin.get('/admin/contestants?q=CodeA');
    assert.equal(list[0].code, a.code);
    assert.equal((await client(app.base).get(`/contestants/${a.code}`)).status, 404);
  });

  test('public payloads never expose private contestant details', async () => {
    const { code } = await makeContestant(app, admin, 'Privacy');
    const anon = client(app.base);
    const { data: profile } = await anon.get(`/contestants/${code.toLowerCase()}`);
    assert.equal(profile.code, code);
    const text = JSON.stringify([profile, (await anon.get('/leaderboard')).data]);
    assert.ok(!text.includes('Private-Surname'));
    assert.ok(!text.includes('@test.local'));
    assert.ok(!/0803\d{7}/.test(text));
    assert.ok(!/0805\d{7}/.test(text));
  });

  test('no public sign-up, supporter login or wallet exists', async () => {
    const anon = client(app.base);
    assert.equal((await anon.post('/auth/signup', { name: 'Sue', email: emailFor(), password: 'supporter-pass' })).status, 404);
    assert.equal((await anon.post('/auth/login', { email: emailFor(), password: 'anything-at-all' })).status, 401);
    assert.equal((await anon.get('/wallet')).status, 404);
    assert.equal((await anon.post('/wallet/purchases', { votes: 1 })).status, 404);
    assert.equal((await anon.post('/supporters/wallet', { email: emailFor(), phone: '08000000000' })).status, 404);
    assert.equal((await anon.post('/votes/fund', { code: 'MBG001', quantity: 1, fund: 1 })).status, 404);
    assert.equal((await anon.post('/votes', { code: 'MBG001', quantity: 1 })).status, 404);
  });
  test('joining is what identifies a contestant, with no password', async () => {
    const person = client(app.base);
    const form = registrationForm('Joiner', { whatsapp: '+234 803 555 0101' });
    assert.equal((await person.req('POST', '/contestants/register', { form })).status, 201);
    assert.equal((await person.get('/me/dashboard')).data.status, 'pending');

    // A new device: wrong details are refused, the right ones bring the dashboard back.
    const phone = client(app.base);
    assert.equal((await phone.get('/me/dashboard')).status, 401);
    assert.equal((await phone.post('/contestants/recognise', { email: 'joiner@test.local', whatsapp: '08000000000' })).status, 401);
    assert.equal((await phone.post('/contestants/recognise', { email: 'nobody@test.local', whatsapp: '08035550101' })).status, 401);
    assert.equal((await phone.post('/contestants/recognise', { email: 'joiner@test.local', whatsapp: '' })).status, 401);
    const back = await phone.post('/contestants/recognise', { email: 'JOINER@test.local', whatsapp: '08035550101' });
    assert.equal(back.status, 200);
    assert.equal((await phone.get('/me/dashboard')).data.name, 'Joiner');

    // A contestant is never an admin, and joining twice is refused.
    assert.equal((await phone.get('/admin/overview')).status, 403);
    assert.equal((await client(app.base).req('POST', '/contestants/register', { form: registrationForm('Joiner') })).status, 409);
  });

  test('paying needs no details, creates no account and counts once', async () => {
    const { code } = await makeContestant(app, admin, 'DirectPay');
    const anon = client(app.base);
    const { status, data: started } = await anon.post('/votes/pay', { code, quantity: 5 });
    assert.equal(status, 201);
    assert.equal(started.amount, 2500);
    assert.equal(anon.cookie, '');

    // Nothing counts until the provider says so.
    assert.equal((await anon.post(`/payments/${started.reference}/verify`)).data.status, 'pending');
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);

    await anon.post(`/simulator/${started.reference}/pay`);
    const results = await Promise.all(Array.from({ length: 6 }, () => anon.post(`/payments/${started.reference}/verify`)));
    assert.ok(results.every((r) => r.data.status === 'paid' && r.data.votesStatus === 'counted'));
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 5);
    const row = await app.ctx.db.prepare('SELECT id, email FROM payments WHERE reference = ?').get(started.reference);
    assert.equal(row.email, null);
    assert.equal((await app.ctx.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE payment_id = ?').get(row.id)).n, 1);
  });

  test('payments check the amount, contestant and voting state, and ignore any email sent', async () => {
    const { code } = await makeContestant(app, admin, 'DirectRules');
    const anon = client(app.base);
    for (const quantity of [0, -3, 1.5, '2', null]) {
      assert.equal((await anon.post('/votes/pay', { code, quantity })).status, 400);
    }
    assert.equal((await anon.post('/votes/pay', { code: 'NOPE9', quantity: 1 })).status, 404);
    await admin.post('/admin/voting/paused');
    assert.equal((await anon.post('/votes/pay', { code, quantity: 1 })).status, 409);
    await admin.post('/admin/voting/open');
    // The client cannot set its own price, or plant an address for a receipt.
    const { data: started } = await anon.post('/votes/pay', { code, quantity: 10, amount: 1, email: 'someone@test.local' });
    assert.equal(started.amount, 5000);
    assert.equal((await app.ctx.db.prepare('SELECT email FROM payments WHERE reference = ?').get(started.reference)).email, null);
  });

  test('the optional receipt email goes out once, only after payment, and stays private', async () => {
    const { code } = await makeContestant(app, admin, 'ReceiptMail');
    const anon = client(app.base);
    const email = emailFor('receiptfan');
    const { data: started } = await anon.post('/votes/pay', { code, quantity: 5 });
    const send = (address) => anon.post(`/payments/${started.reference}/receipt-email`, { email: address });

    assert.equal((await send(email)).status, 409);
    await anon.post(`/simulator/${started.reference}/pay`);
    assert.equal((await anon.post(`/payments/${started.reference}/verify`)).data.emailed, false);
    assert.equal((await send('nope')).status, 400);
    assert.equal((await send(email.toUpperCase())).status, 200);
    assert.equal((await send(emailFor('second'))).status, 409);
    assert.equal((await anon.post('/payments/MBG-WRONG/receipt-email', { email })).status, 404);

    const mail = await app.ctx.db.prepare('SELECT subject, body FROM outbox WHERE to_addr = ?').all(email);
    assert.equal(mail.length, 1);
    assert.ok(mail[0].subject.includes('5 votes'));
    assert.ok(mail[0].body.includes(`/receipt/payment/${started.reference}`));

    // The page learns that it was sent, never where.
    const { data: view } = await client(app.base).get(`/payments/${started.reference}`);
    assert.equal(view.emailed, true);
    assert.ok(!JSON.stringify(view).includes(email));
  });

  test('a contestant asking for the receipt with their own email is flagged', async () => {
    const { code } = await makeContestant(app, admin, 'SelfReceipt');
    const reference = await payForVotes(client(app.base), code, 1);
    const res = await client(app.base).post(`/payments/${reference}/receipt-email`, { email: 'selfreceipt@test.local' });
    assert.equal(res.status, 200);
    const { data: flags } = await admin.get('/admin/flags');
    assert.ok(flags.some((f) => f.code === code && f.kind === 'self_vote'));
  });

  test('a payment started before closing counts; one for a removed contestant is held', async () => {
    const late = await makeContestant(app, admin, 'LatePayer');
    const anon = client(app.base);
    const { data: started } = await anon.post('/votes/pay', { code: late.code, quantity: 6 });
    await admin.post('/admin/voting/closed');
    await anon.post(`/simulator/${started.reference}/pay`);
    assert.equal((await anon.post(`/payments/${started.reference}/verify`)).data.votesStatus, 'counted');
    await admin.post('/admin/voting/open');

    const gone = await makeContestant(app, admin, 'GoneAway');
    const { data: heldStart } = await anon.post('/votes/pay', { code: gone.code, quantity: 3 });
    await admin.post(`/admin/contestants/${gone.id}/disqualify`, { reason: 'Broke the rules' });
    await anon.post(`/simulator/${heldStart.reference}/pay`);
    const { data: held } = await anon.post(`/payments/${heldStart.reference}/verify`);
    assert.equal(held.status, 'paid');
    assert.equal(held.votesStatus, 'held');
    assert.equal((await admin.get('/admin/contestants?q=GoneAway')).data[0].totalVotes, 0);
    assert.ok((await admin.get('/admin/flags')).data.some((f) => f.kind === 'votes_held'));
    assert.ok((await admin.get('/admin/overview')).data.votesHeld >= 1);
  });

  test('a browser "success" alone never counts votes', async () => {
    const { code } = await makeContestant(app, admin, 'NoClaim');
    const anon = client(app.base);
    const { data: started } = await anon.post('/votes/pay', { code, quantity: 3 });
    assert.equal(started.amount, 1500);

    // Unpaid at the provider: asking to verify changes nothing.
    const { data: check } = await anon.post(`/payments/${started.reference}/verify`, { paymentStatus: 'PAID', status: 'PAID' });
    assert.equal(check.status, 'pending');
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);
  });

  test('paid votes recalculate ranks', async () => {
    const stella = await makeContestant(app, admin, 'Stella');
    const jennifer = await makeContestant(app, admin, 'Jennifer');
    const anon = client(app.base);
    await payForVotes(anon, stella.code, 5);
    await payForVotes(anon, jennifer.code, 7);

    const { data: board } = await anon.get('/leaderboard?q=e');
    const j = board.rows.find((r) => r.code === jennifer.code);
    const s = board.rows.find((r) => r.code === stella.code);
    assert.ok(j.position < s.position);
    assert.equal(j.totalVotes, 7);
    assert.equal(s.totalVotes, 5);
    assert.ok(s.previousPosition != null);
  });

  test('paying to vote respects pause, close and the date window', async () => {
    const { code } = await makeContestant(app, admin, 'Window');
    const anon = client(app.base);
    const vote = () => anon.post('/votes/pay', { code, quantity: 1 });

    await admin.post('/admin/voting/paused');
    assert.equal((await vote()).status, 409);
    await admin.post('/admin/voting/closed');
    assert.equal((await vote()).status, 409);
    await admin.post('/admin/voting/open');
    assert.equal((await vote()).status, 201);

    const { data: settings } = await admin.get('/admin/settings');
    await admin.req('PUT', '/admin/settings', { body: { ...settings, endsAt: new Date(Date.now() - 60000).toISOString(), startsAt: '' } });
    assert.equal((await vote()).status, 409);
    await admin.req('PUT', '/admin/settings', { body: { ...settings, endsAt: '', startsAt: '' } });
    assert.equal((await vote()).status, 201);
  });

  test('public feed is aggregated and anonymous; private alerts reach only the right contestant', async () => {
    const a = await makeContestant(app, admin, 'Alpha');
    const b = await makeContestant(app, admin, 'Bravo');
    const anon = client(app.base);
    const email = 'secretsupporter@test.local';

    const pub = await listen(app.base);
    const alpha = await listen(app.base, a.person.cookie);
    const bravo = await listen(app.base, b.person.cookie);
    await sleep(30);

    const started = await Promise.all([5, 10].map((quantity) => anon.post('/votes/pay', { code: a.code, quantity })));
    const references = started.map((r) => r.data.reference);
    await Promise.all(references.map((reference) => anon.post(`/simulator/${reference}/pay`)));
    await Promise.all(references.map((reference) => anon.post(`/payments/${reference}/verify`)));
    await anon.post(`/payments/${references[0]}/receipt-email`, { email });
    await sleep(200);

    const activity = pub.events.filter((e) => e.name === 'activity' && e.data.message.includes('Alpha received'));
    assert.deepEqual(activity.map((e) => e.data.message), ['Alpha received 15 new votes.']);
    assert.ok(pub.events.some((e) => e.name === 'leaderboard'));
    assert.ok(!pub.events.map((e) => e.raw).join('\n').includes('secretsupporter'));

    const alphaAlerts = alpha.events.filter((e) => e.name === 'notification' && e.data.kind === 'votes');
    assert.deepEqual(alphaAlerts.map((e) => e.data.message), ['Congratulations! You just received 15 new votes.']);
    assert.equal(bravo.events.filter((e) => e.name === 'notification' && e.data.kind === 'votes').length, 0);
    assert.equal(pub.events.filter((e) => e.name === 'notification').length, 0);

    // The stored alert is only on Alpha's dashboard, and the history names no supporter.
    const { data: dash } = await a.person.get('/me/dashboard');
    assert.ok(dash.notifications.some((n) => n.message.includes('15 new votes')));
    assert.ok(!JSON.stringify(dash).includes('secretsupporter'));
    const { data: bDash } = await b.person.get('/me/dashboard');
    assert.ok(!bDash.notifications.some((n) => n.message.includes('15 new votes')));

    pub.stop();
    alpha.stop();
    bravo.stop();
  });

  test('payment receipts hide the email, and vote receipts are for admins', async () => {
    const { code, person } = await makeContestant(app, admin, 'Receipt');
    const anon = client(app.base);
    const email = emailFor();
    const reference = await payForVotes(anon, code, 2);

    // A payment receipt is reached by its long reference, and hides most of any email.
    const noEmail = await client(app.base).get(`/receipts/payment/${reference}`);
    assert.equal(noEmail.status, 200);
    assert.equal(noEmail.data.customer, null);
    await anon.post(`/payments/${reference}/receipt-email`, { email });
    const paymentReceipt = await client(app.base).get(`/receipts/payment/${reference}`);
    assert.ok(paymentReceipt.data.customer.includes('***@'));
    assert.ok(!JSON.stringify(paymentReceipt.data).includes(email));
    assert.equal((await client(app.base).get('/receipts/payment/MBG-WRONG')).status, 404);

    const { data: votes } = await admin.get('/admin/votes');
    const { receiptNo } = votes.find((v) => v.code === code);
    assert.equal((await admin.get(`/receipts/vote/${receiptNo}`)).status, 200);
    assert.equal((await person.get(`/receipts/vote/${receiptNo}`)).status, 404);
    assert.equal((await client(app.base).get(`/receipts/vote/${receiptNo}`)).status, 401);
  });

  test('admin routes refuse everyone else, and cross-site writes are refused', async () => {
    const { person } = await makeContestant(app, admin, 'NotAdmin');
    assert.equal((await person.get('/admin/overview')).status, 403);
    assert.equal((await client(app.base).get('/admin/overview')).status, 401);
    assert.equal((await person.get('/admin/export/votes.csv')).status, 403);

    const res = await person.req('POST', '/votes/pay', { body: {}, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('voiding a vote updates totals and ranks', async () => {
    const { code } = await makeContestant(app, admin, 'Voided');
    const anon = client(app.base);
    await payForVotes(anon, code, 6);

    const { data: votes } = await admin.get('/admin/votes');
    const vote = votes.find((v) => v.code === code);
    assert.equal((await admin.post(`/admin/votes/${vote.id}/void`, { reason: 'Fraud confirmed' })).status, 200);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);
    assert.equal((await admin.post(`/admin/votes/${vote.id}/void`, { reason: 'Again please' })).status, 409);
  });

  test('suspicious patterns raise flags for review', async () => {
    const { code, person } = await makeContestant(app, admin, 'Flagged');
    await payForVotes(person, code, 1000);
    const { data: flags } = await admin.get('/admin/flags');
    const kinds = flags.filter((f) => f.code === code).map((f) => f.kind);
    assert.ok(kinds.includes('large_vote'));
    assert.ok(kinds.includes('self_vote'));
  });

  test('many payments from one network to one contestant raise a flag, without blocking them', async () => {
    const { code } = await makeContestant(app, admin, 'OneNetwork');
    const anon = client(app.base);
    for (let i = 0; i < 20; i += 1) await payForVotes(anon, code, 1);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 20);
    const { data: flags } = await admin.get('/admin/flags');
    assert.ok(flags.some((f) => f.code === code && f.kind === 'shared_network'));
  });

  test('CSV exports neutralise spreadsheet formulas', async () => {
    const form = registrationForm('Formula', { stageName: '=HYPERLINK("http://evil")' });
    const res = await client(app.base).req('POST', '/contestants/register', { form });
    assert.equal(res.status, 201);
    const csv = await admin.get('/admin/export/contestants.csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.data.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.equal((await admin.get('/admin/export/votes.csv')).status, 200);
    assert.equal((await admin.get('/admin/export/payments.csv')).status, 200);
  });

  test('publishing results needs voting closed, then appears on the winners page', async () => {
    await admin.post('/admin/voting/open');
    assert.equal((await admin.post('/admin/results/publish')).status, 409);
    await admin.post('/admin/voting/closed');
    assert.equal((await admin.post('/admin/results/publish')).status, 201);
    assert.equal((await admin.post('/admin/results/publish')).status, 409);
    const { data: results } = await client(app.base).get('/results');
    assert.equal(results.length, 1);
    assert.equal(results[0].standings[0].position, 1);
    await admin.post('/admin/voting/open');
  });

  test('admin password reset works once and ends old sessions', async () => {
    const adminSession = client(app.base);
    await adminSession.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
    assert.equal((await adminSession.post('/auth/forgot', { email: 'admin@test.local' })).status, 200);
    const mail = await app.ctx.db.prepare("SELECT body FROM outbox WHERE subject LIKE 'Reset%' ORDER BY id DESC").get();
    const token = mail.body.match(/\/reset\/([\w-]+)/)[1];
    assert.equal((await client(app.base).post('/auth/reset', { token, password: 'brand-new-pass' })).status, 200);
    assert.equal((await client(app.base).post('/auth/reset', { token, password: 'another-pass-1' })).status, 400);
    assert.equal((await adminSession.get('/admin/overview')).status, 401);
    assert.equal((await client(app.base).post('/auth/login', { email: 'admin@test.local', password: 'brand-new-pass' })).status, 200);
  });
});

// Runs the real Paystack client against a local server that follows Paystack's documented contract.
describe('Paystack integration (against a local stand-in)', () => {
  const SECRET = 'sk_test_fixture';
  let fake;
  let fakeUrl;
  let paidAmount;
  let status;
  let queries = 0;
  let sent;
  let app;
  let admin;

  before(async () => {
    fake = http.createServer((req, res) => {
      const send = (data) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: true, message: 'ok', data }));
      };
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
        if (url.pathname === '/transaction/initialize') {
          sent = JSON.parse(raw);
          assert.equal(sent.currency, 'NGN');
          assert.ok(sent.callback_url.endsWith(`/pay/return/${sent.reference}`));
          return send({ authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: sent.reference });
        }
        if (url.pathname.startsWith('/transaction/verify/')) {
          queries += 1;
          return send({
            id: 123,
            reference: decodeURIComponent(url.pathname.split('/').pop()),
            status,
            amount: paidAmount * 100,
            currency: 'NGN',
            channel: 'card',
          });
        }
        res.statusCode = 404;
        return res.end(JSON.stringify({ status: false, message: 'Not found' }));
      });
    }).listen(0);
    await new Promise((resolve) => fake.once('listening', resolve));
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
    app = await boot({ paystack: { secretKey: SECRET, baseUrl: fakeUrl } });
    admin = client(app.base);
    await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
  });
  after(() => {
    app.close();
    fake.closeAllConnections();
    fake.close();
  });

  const webhook = (body, signature) => fetch(`${app.base}/api/webhooks/paystack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'x-paystack-signature': signature } : {}) },
    body,
  });
  const sign = (body) => crypto.createHmac('sha512', SECRET).update(body).digest('hex');
  const eventFor = (reference) => JSON.stringify({ event: 'charge.success', data: { reference, amount: 99999900, status: 'success' } });

  test('a payment counts only what Paystack confirms', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackDirect');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 4 });
    assert.equal(data.checkoutUrl, 'https://checkout.paystack.com/abc');

    // A checkout nobody has finished stays open: it may still be paid.
    status = 'abandoned';
    paidAmount = 0;
    const body = eventFor(data.reference);
    await webhook(body, sign(body));
    await sleep(40);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);
    assert.equal((await anon.post(`/payments/${data.reference}/verify`)).data.status, 'pending');

    status = 'success';
    paidAmount = 2000;
    await webhook(body, sign(body));
    await sleep(60);
    assert.equal((await anon.post(`/payments/${data.reference}/verify`)).data.votesStatus, 'counted');
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 4);
  });

  test('starts a real checkout in kobo, and the simulator route does not exist', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackStart');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 2 });
    assert.equal(sent.amount, 100000);
    assert.equal(sent.reference, data.reference);
    assert.ok(sent.metadata.cancel_action.endsWith(`/pay/return/${data.reference}?cancelled=1`));
    // Paystack requires an email, so it gets the site's own mailbox with the reference added.
    assert.equal(sent.email, `votes+${data.reference.toLowerCase()}@${app.ctx.config.paymentEmail.split('@')[1]}`);
    assert.equal((await anon.post(`/simulator/${data.reference}/pay`)).status, 404);
  });

  test('forged or unsigned webhooks are ignored, and flagged', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackForged');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 2 });
    status = 'success';
    paidAmount = 1000;
    const body = eventFor(data.reference);
    assert.equal((await webhook(body, 'not-the-signature')).status, 401);
    assert.equal((await webhook(body)).status, 401);
    await sleep(40);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);
    assert.ok(await app.ctx.db.prepare("SELECT 1 FROM flags WHERE kind = 'bad_webhook_signature'").get());
  });

  test('a signed webhook counts once, using the amount Paystack reports rather than the webhook body', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackSigned');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 2 });

    // Signed webhook says paid, but Paystack's own answer is still pending: nothing counts.
    status = 'ongoing';
    paidAmount = 0;
    const body = eventFor(data.reference);
    assert.equal((await webhook(body, sign(body))).status, 200);
    await sleep(40);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);

    status = 'success';
    paidAmount = 1000;
    await Promise.all([webhook(body, sign(body)), webhook(body, sign(body)), webhook(body, sign(body))]);
    await sleep(60);
    await anon.post(`/payments/${data.reference}/verify`);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 2);
    assert.ok(queries > 0);
  });

  test('a webhook for a payment that is not ours is accepted and ignored', async () => {
    const before = queries;
    const body = eventFor('qitt_other_project_reference');
    assert.equal((await webhook(body, sign(body))).status, 200);
    await sleep(40);
    assert.equal(queries, before);
  });

  test('an underpayment counts no votes and goes to review', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackShort');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 10 });
    status = 'success';
    paidAmount = 100;
    const { data: result } = await anon.post(`/payments/${data.reference}/verify`);
    assert.equal(result.status, 'review');
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);
    assert.ok(await app.ctx.db.prepare("SELECT 1 FROM flags WHERE kind = 'payment_mismatch'").get());
  });

  test('failed payments are marked failed', async () => {
    const { code } = await makeContestant(app, admin, 'PaystackFailed');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 1 });
    status = 'failed';
    paidAmount = 0;
    const { data: result } = await anon.post(`/payments/${data.reference}/verify`);
    assert.equal(result.status, 'failed');
  });
});

describe('Contest stages', () => {
  test('registration closes by itself at its deadline, which an admin can change', async () => {
    const app = await boot({}, { freshContest: true });
    try {
      const admin = client(app.base);
      await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
      const anon = client(app.base);
      const join = (name) => client(app.base).req('POST', '/contestants/register', { form: registrationForm(name) });

      // A new contest gets about a week.
      const { registration } = (await anon.get('/competition')).data;
      assert.equal(registration.open, true);
      const daysLeft = (new Date(registration.endsAt) - Date.now()) / 864e5;
      assert.ok(daysLeft > 6.9 && daysLeft <= 7);
      assert.equal((await admin.get('/admin/settings')).data.registrationEndsAt, registration.endsAt);
      assert.equal((await join('InTime')).status, 201);

      const setDeadline = (endsAt) => admin.req('PUT', '/admin/registration', { body: { endsAt } });
      assert.equal((await anon.req('PUT', '/admin/registration', { body: { endsAt: '' } })).status, 401);
      assert.equal((await setDeadline('not a date')).status, 400);

      // Past the deadline: applications stop, voting has still not started.
      const past = new Date(Date.now() - 60000).toISOString();
      assert.equal((await setDeadline(past)).status, 200);
      const closed = (await anon.get('/competition')).data;
      assert.equal(closed.registration.open, false);
      assert.equal(closed.phase, 'registration');
      assert.equal(closed.voting.open, false);
      assert.equal((await join('TooLateNow')).status, 409);

      // A later date reopens applications, and no deadline at all stays open.
      assert.equal((await setDeadline(new Date(Date.now() + 864e5).toISOString())).status, 200);
      assert.equal((await join('ReopenedOne')).status, 201);
      assert.equal((await setDeadline('')).status, 200);
      const noDeadline = (await anon.get('/competition')).data.registration;
      assert.deepEqual(noDeadline, { open: true, endsAt: null });

      // The deadline being reached doesn't stop an admin from starting voting, and a restart keeps their date.
      await setDeadline(past);
      const restarted = await createContext(app.ctx.config);
      assert.equal((await restarted.db.prepare("SELECT value FROM settings WHERE key = 'registration_ends_at'").get()).value, past);
      assert.equal((await admin.post('/admin/phase/voting')).status, 200);
      assert.equal((await anon.get('/competition')).data.voting.open, true);
      assert.equal((await anon.get('/competition')).data.registration.open, false);
    } finally {
      await app.close();
    }
  });

  test('a contest takes applications first, then an admin ends registration and voting opens', async () => {
    const app = await boot({}, { freshContest: true });
    try {
      const admin = client(app.base);
      await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
      const anon = client(app.base);

      // Registration stage: joining works, and everything to do with voting is off.
      const before = (await anon.get('/competition')).data;
      assert.equal(before.phase, 'registration');
      assert.equal(before.voting.open, false);
      assert.equal(before.voting.status, 'registration');
      const { code, person, id } = await makeContestant(app, admin, 'EarlyBird');
      const earlyMail = (await app.ctx.db.prepare("SELECT body FROM outbox WHERE subject LIKE 'You''re in%'").get()).body;
      assert.ok(earlyMail.includes('Voting opens when registration closes'));
      const waiting = await client(app.base).req('POST', '/contestants/register', { form: registrationForm('StillWaiting') });
      assert.equal(waiting.status, 201);

      const vote = () => anon.post('/votes/pay', { code, quantity: 1 });
      assert.equal((await vote()).status, 409);
      assert.equal((await admin.post('/admin/voting/open')).status, 409);
      assert.equal((await admin.post('/admin/results/publish')).status, 409);

      // Only an admin can move the contest on.
      assert.equal((await anon.post('/admin/phase/voting')).status, 401);
      assert.equal((await person.post('/admin/phase/voting')).status, 403);
      assert.equal((await admin.post('/admin/phase/registration')).status, 409);

      const { data: stages } = await admin.get('/admin/settings');
      assert.equal(stages.phase, 'registration');
      assert.equal(stages.approvedContestants, 1);
      assert.equal(stages.pendingApplications, 1);

      // Ending registration: approved contestants hear about it, and voting is live.
      const started = await admin.post('/admin/phase/voting');
      assert.equal(started.status, 200);
      assert.equal(started.data.notified, 1);
      assert.equal((await admin.post('/admin/phase/voting')).status, 409);
      const after = (await anon.get('/competition')).data;
      assert.equal(after.phase, 'voting');
      assert.equal(after.voting.open, true);
      assert.ok((await person.get('/me/dashboard')).data.notifications.some((n) => n.message.startsWith('Voting is open!')));
      assert.ok(await app.ctx.db.prepare("SELECT 1 FROM outbox WHERE subject = 'Voting is open!' AND to_addr = 'earlybird@test.local'").get());
      assert.ok((await anon.get('/activity')).data.some((a) => a.message.includes('Voting is now open')));
      assert.equal((await vote()).status, 201);
      await payForVotes(anon, code, 3);
      assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 3);

      // Registration is closed to new people, though waiting applications can still be approved.
      const late = await client(app.base).req('POST', '/contestants/register', { form: registrationForm('TooLate') });
      assert.equal(late.status, 409);
      const { data: [pending] } = await admin.get('/admin/contestants?q=StillWaiting');
      assert.equal((await admin.post(`/admin/contestants/${pending.id}/approve`)).status, 200);

      // Reopening stops voting and keeps the votes.
      assert.equal((await admin.post('/admin/phase/registration')).status, 200);
      assert.equal((await vote()).status, 409);
      assert.equal((await admin.get(`/admin/contestants?q=EarlyBird`)).data.find((c) => c.id === id).totalVotes, 3);
    } finally {
      await app.close();
    }
  });
});

// Runs the real S3 client against a local server that answers the way R2 does.
describe('Cloudflare R2 photos (against a local stand-in)', () => {
  test('photos are stored in the bucket, stay private until approval, and a missing one is a 404', async () => {
    const stored = new Map();
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        if (req.method === 'PUT') {
          stored.set(req.url.split('?')[0], { body: Buffer.concat(chunks), type: req.headers['content-type'] });
          res.setHeader('ETag', '"abc"');
          return res.end();
        }
        const object = stored.get(req.url.split('?')[0]);
        if (!object) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/xml');
          return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>');
        }
        res.setHeader('Content-Type', object.type);
        return res.end(object.body);
      });
    }).listen(0);
    await new Promise((resolve) => fake.once('listening', resolve));
    const app = await boot({
      r2: { endpoint: `http://127.0.0.1:${fake.address().port}`, accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'photos' },
    });
    try {
      const admin = client(app.base);
      await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
      const person = client(app.base);
      assert.equal((await person.req('POST', '/contestants/register', { form: registrationForm('Bucket') })).status, 201);

      const { data: [row] } = await admin.get('/admin/contestants?q=Bucket');
      const key = `/photos/${row.photoUrl.split('/').pop()}`;
      assert.deepEqual(stored.get(key).body, PNG);
      assert.equal(stored.get(key).type, 'image/png');

      // Going through the site, so the bucket itself never has to be public.
      const url = `${app.base}${row.photoUrl}`;
      assert.equal((await fetch(url)).status, 404);
      const seen = await fetch(url, { headers: { Cookie: admin.cookie } });
      assert.equal(seen.status, 200);
      assert.deepEqual(Buffer.from(await seen.arrayBuffer()), PNG);
      await admin.post(`/admin/contestants/${row.id}/approve`);
      assert.equal((await fetch(url)).status, 200);

      stored.delete(key);
      assert.equal((await fetch(url)).status, 404);
    } finally {
      await app.close();
      fake.closeAllConnections();
      fake.close();
    }
  });
});

describe('production safety', () => {
  test('repeated bad attempts for one email are locked out without blocking others on that network', async () => {
    const app = await boot({ rateLimitScale: 1 });
    try {
      const attempt = (email) => client(app.base).post('/auth/login', { email, password: 'wrong-password' });
      const statuses = [];
      for (let i = 0; i < 11; i += 1) statuses.push((await attempt('victim@test.local')).status);
      assert.equal(statuses[9], 401);
      assert.equal(statuses[10], 429);
      assert.equal((await attempt('someone-else@test.local')).status, 401);
    } finally {
      await app.close();
    }
  });

  test('the site does not hand out a photo it cannot find, or crash on a bad id', async () => {
    const app = await boot();
    try {
      const admin = client(app.base);
      await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
      assert.equal((await admin.post('/admin/contestants/not-a-number/approve')).status, 404);
      assert.equal((await fetch(`${app.base}/photos/${'a'.repeat(32)}.png`)).status, 404);
    } finally {
      await app.close();
    }
  });

  test('refuses to boot in production with the simulator, a test key, or without a secret or payment email', () => {
    const paystack = { secretKey: 'sk_live_x', baseUrl: 'x' };
    assert.throws(() => loadConfig({ nodeEnv: 'production', appSecret: 'x', paystack: null }), /simulator/);
    assert.throws(() => loadConfig({ nodeEnv: 'production', appSecret: 'x', paystack: { ...paystack, secretKey: 'sk_test_x' } }), /test key/);
    assert.throws(() => loadConfig({ nodeEnv: 'test', paystack: { ...paystack, secretKey: 'pk_test_x' } }), /secret key/);
    assert.throws(() => loadConfig({ nodeEnv: 'production', appSecret: undefined, paystack }), /APP_SECRET/);
    assert.throws(() => loadConfig({ nodeEnv: 'production', appSecret: 'x', paystack }), /PAYMENT_EMAIL/);
    assert.throws(() => loadConfig({ nodeEnv: 'test', databaseUrl: null }), /DATABASE_URL/);
  });
});

describe('Follower check and WhatsApp groups', () => {
  let app;
  let admin;
  const invite = (code) => `https://chat.whatsapp.com/${code}`;
  const join = (person, name, overrides) => person.req('POST', '/contestants/register', { form: registrationForm(name, overrides) });
  const mailTo = (email) => app.ctx.db.prepare('SELECT subject, body FROM outbox WHERE to_addr = ? ORDER BY id').all(email);

  before(async () => {
    app = await boot({}, { freshContest: true });
    admin = client(app.base);
    await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
  });
  after(() => app.close());

  test('not enough followers saves nothing and leaves the person free to try again', async () => {
    const person = client(app.base);
    const res = await join(person, 'Under', { instagram: '@under_799', tiktok: '@under_12' });
    assert.equal(res.status, 200);
    assert.equal(res.data.outcome, 'failed');
    assert.equal(res.data.minFollowers, 800);
    assert.deepEqual(res.data.results.map((r) => [r.platform, r.followers]), [['instagram', 799], ['tiktok', 12]]);
    assert.equal(person.cookie, '');
    assert.equal(await app.ctx.db.prepare("SELECT 1 FROM users WHERE email = 'under@test.local'").get(), undefined);

    const again = await join(person, 'Under', { instagram: '@under_800' });
    assert.equal(again.status, 201);
    assert.equal(again.data.outcome, 'passed');
  });

  test('one account with enough is a pass, and an account that does not exist is not', async () => {
    const pass = await join(client(app.base), 'OneEnough', { instagram: '@oneenough_3', tiktok: '@oneenough_notfound', facebook: 'oneenough_900' });
    assert.equal(pass.data.outcome, 'passed');
    const missing = await join(client(app.base), 'Ghost', { instagram: '@ghost_notfound' });
    assert.equal(missing.status, 200);
    assert.equal(missing.data.outcome, 'failed');
    assert.equal(missing.data.results[0].status, 'missing');
  });

  test('at least one account is required, and an account can only be used once', async () => {
    assert.equal((await join(client(app.base), 'NoSocials', { instagram: '' })).status, 400);
    assert.equal((await join(client(app.base), 'First', { instagram: '@Shared.Account' })).status, 201);
    const second = await join(client(app.base), 'Second', { instagram: 'https://instagram.com/shared.account/?igsh=abc' });
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already part of another application/);
  });

  test('a lookup that could not be finished goes to an admin, and the link waits for approval', async () => {
    const person = client(app.base);
    const res = await join(person, 'Unread', { instagram: '@unread_offline', tiktok: '@unread_5' });
    assert.equal(res.status, 201);
    assert.equal(res.data.outcome, 'review');
    assert.equal(res.data.whatsappGroup, null);

    const { data: [row] } = await admin.get('/admin/contestants?q=Unread');
    assert.equal(row.verification, 'review');
    assert.equal(row.followerResults[1].followers, 5);
    assert.equal((await person.get('/me/dashboard')).data.whatsappGroup, null);
    app.reviewId = row.id;
  });

  test('links go out from the oldest open group with room, and people wait when none has room', async () => {
    // Nobody has a group yet, so everyone who passed so far is waiting.
    const waiting = (await admin.get('/admin/joining')).data.waiting;
    assert.ok(waiting > 0);
    assert.equal((await admin.get('/admin/overview')).data.waitingForGroup, waiting);

    const added = await admin.post('/admin/whatsapp-groups', { name: 'Batch 1', url: invite('AbC1?mode=x'), capacity: waiting + 1 });
    assert.equal(added.status, 201);
    assert.equal(added.data.placed, waiting);
    assert.match((await mailTo('first@test.local')).at(-1).body, /chat\.whatsapp\.com\/AbC1/);
    await admin.post('/admin/whatsapp-groups', { name: 'Batch 2', url: invite('Next2'), capacity: 1000 });

    const last = client(app.base);
    const lastPlace = await join(last, 'LastPlace', { instagram: '@lastplace' });
    assert.equal(lastPlace.data.whatsappGroup.name, 'Batch 1');
    const overflow = await join(client(app.base), 'Overflow', { instagram: '@overflow' });
    assert.equal(overflow.data.whatsappGroup.name, 'Batch 2');

    const dashboard = (await last.get('/me/dashboard')).data;
    assert.equal(dashboard.whatsappGroup.url, invite('AbC1'));
    assert.equal(dashboard.verification, 'passed');
    assert.match((await mailTo('lastplace@test.local'))[0].body, /chat\.whatsapp\.com\/AbC1/);

    const { data } = await admin.get('/admin/joining');
    assert.deepEqual(data.groups.map((g) => [g.name, g.used === g.capacity, g.current]), [['Batch 1', true, false], ['Batch 2', false, true]]);
    assert.equal(data.waiting, 0);
  });

  test('marking a group as full moves on to the next, and approval gives waiting applicants a link', async () => {
    const { data: { groups } } = await admin.get('/admin/joining');
    const batch2 = groups.find((g) => g.name === 'Batch 2');
    await admin.req('PUT', `/admin/whatsapp-groups/${batch2.id}`, { body: { ...batch2, closed: true } });
    const noRoom = await join(client(app.base), 'NoRoom', { instagram: '@noroom' });
    assert.equal(noRoom.data.outcome, 'passed');
    assert.equal(noRoom.data.whatsappGroup, null);

    const reopened = await admin.req('PUT', `/admin/whatsapp-groups/${batch2.id}`, { body: { ...batch2, closed: false } });
    assert.equal(reopened.data.placed, 1);
    assert.match((await mailTo('noroom@test.local')).at(-1).body, /chat\.whatsapp\.com\/Next2/);

    await admin.post(`/admin/contestants/${app.reviewId}/approve`);
    const mail = await mailTo('unread@test.local');
    assert.match(mail.at(-1).subject, /You're in/);
    assert.match(mail.at(-1).body, /chat\.whatsapp\.com\/Next2/);
  });

  test('admins set the rules: bad links are refused, and only admins can change them', async () => {
    const bad = [invite(''), 'https://evil.com/AbC', 'http://chat.whatsapp.com/AbC', 'https://chat.whatsapp.com.evil.com/AbC', 'nonsense'];
    for (const url of bad) assert.equal((await admin.post('/admin/whatsapp-groups', { name: 'Bad', url, capacity: 10 })).status, 400, url);
    assert.equal((await admin.post('/admin/whatsapp-groups', { name: 'Huge', url: invite('Huge'), capacity: 5000 })).status, 400);
    assert.equal((await admin.post('/admin/whatsapp-groups', { name: 'Again', url: invite('Next2'), capacity: 10 })).status, 409);
    const stranger = client(app.base);
    assert.equal((await stranger.get('/admin/joining')).status, 401);
    assert.equal((await stranger.post('/admin/whatsapp-groups', { name: 'Mine', url: invite('Mine'), capacity: 10 })).status, 401);

    assert.equal((await admin.req('PUT', '/admin/joining', { body: { minFollowers: 2000 } })).status, 200);
    assert.equal((await stranger.get('/competition')).data.minFollowers, 2000);
    assert.equal((await join(client(app.base), 'Raised', { instagram: '@raised_1999' })).data.outcome, 'failed');
    await admin.req('PUT', '/admin/joining', { body: { minFollowers: 800 } });
  });

  test('reads each network through the data service, and treats anything unclear as unreadable', async () => {
    const seen = [];
    const service = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'] });
      const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const who = url.searchParams.get('handle') ?? url.searchParams.get('url');
      if (who.includes('gone')) return reply(404, { success: false });
      if (who.includes('broken')) return reply(500, {});
      if (url.pathname.endsWith('/instagram/profile')) return reply(200, { data: { user: { edge_followed_by: { count: 1500 } } } });
      if (url.pathname.endsWith('/tiktok/profile')) return reply(200, { user: {}, stats: { followerCount: 700 } });
      return reply(200, { isPrivate: who.includes('private'), followerCount: who.includes('private') ? undefined : 950 });
    }).listen(0);
    await new Promise((resolve) => service.once('listening', resolve));
    const checker = createFollowerChecker({ followers: { apiKey: 'key', baseUrl: `http://127.0.0.1:${service.address().port}` } });
    assert.equal(checker.mode, 'live');
    try {
      const all = await checker.check({
        instagram: 'https://www.instagram.com/ada', tiktok: 'https://www.tiktok.com/@ada', facebook: 'https://www.facebook.com/ada',
      }, 800);
      assert.equal(all.outcome, 'passed');
      assert.deepEqual(all.results.map((r) => r.followers), [1500, 700, 950]);
      assert.deepEqual(seen.map((s) => s.query.handle ?? s.query.url), ['ada', 'ada', 'https://www.facebook.com/ada']);
      assert.ok(seen.every((s) => s.key === 'key'));

      assert.equal((await checker.check({ tiktok: 'https://www.tiktok.com/@ada' }, 800)).outcome, 'failed');
      assert.equal((await checker.check({ tiktok: 'https://www.tiktok.com/@gone' }, 800)).outcome, 'failed');
      for (const facebook of ['https://www.facebook.com/broken', 'https://www.facebook.com/private']) {
        const { outcome, results } = await checker.check({ facebook }, 800);
        assert.equal(outcome, 'review');
        assert.equal(results[0].status, 'unavailable');
      }
    } finally {
      service.close();
    }
    // A provider that cannot be reached must not fail anyone.
    const down = createFollowerChecker({ followers: { apiKey: 'key', baseUrl: 'http://127.0.0.1:1' } });
    assert.equal((await down.check({ tiktok: 'https://www.tiktok.com/@ada' }, 800)).outcome, 'review');
  });

  test('production never invents follower counts', async () => {
    const checker = createFollowerChecker({ followers: null, production: true });
    assert.equal(checker.mode, 'manual');
    assert.equal((await checker.check({ instagram: 'https://www.instagram.com/ada_5000' }, 800)).outcome, 'review');
  });

  test('social links come down to one form for each account', () => {
    for (const value of ['@Ada', 'Ada', 'https://instagram.com/Ada/', 'instagram.com/Ada', 'https://www.instagram.com/Ada?igsh=x']) {
      assert.equal(socialLink(value, 'instagram'), 'https://www.instagram.com/Ada', value);
    }
    assert.equal(socialLink('https://m.tiktok.com/@ada?lang=en', 'tiktok'), 'https://www.tiktok.com/@ada');
    assert.equal(socialLink('https://www.facebook.com/profile.php?id=123', 'facebook'), 'https://www.facebook.com/profile.php?id=123');
    for (const [value, host] of [
      ['https://vm.tiktok.com/ZMabc/', 'tiktok'], ['https://www.instagram.com/p/abc/', 'instagram'],
      ['https://www.instagram.com/', 'instagram'], ['https://notinstagram.com/ada', 'instagram'],
    ]) assert.throws(() => socialLink(value, host), /username|link/, value);
  });
});
