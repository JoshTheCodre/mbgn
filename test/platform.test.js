import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp, createContext } from '../server/app.js';
import { formatCode } from '../server/competition.js';
import { loadConfig } from '../server/config.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

async function boot(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbgn-test-'));
  const config = loadConfig({
    nodeEnv: 'test',
    dataDir: dir,
    dbPath: path.join(dir, 'test.sqlite'),
    uploadDir: path.join(dir, 'uploads'),
    publicUrl: 'http://localhost',
    adminEmail: 'admin@test.local',
    adminPassword: 'admin-password',
    activityWindowMs: 20,
    appSecret: 'test-secret',
    smtpUrl: null,
    monnify: null,
    rateLimitScale: 1000,
    ...overrides,
  });
  const ctx = createContext(config);
  const server = createApp(ctx, { serveClient: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ctx,
    base,
    close() {
      ctx.activity.stop();
      ctx.bus.close();
      server.closeAllConnections();
      server.close();
      ctx.db.close();
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
      const res = await fetch(`${base}/api${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
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

// A supporter's wallet: an email and phone number, with no account or password.
async function makeSupporter(app, name = 'sue') {
  const person = client(app.base);
  const email = emailFor(name);
  const phone = `0806${crypto.randomInt(1000000, 9999999)}`;
  const res = await person.post('/supporters/wallet', { email, phone });
  assert.equal(res.status, 201);
  return Object.assign(person, { userId: res.data.user.id, email, phone });
}

async function buyCredits(person, votes) {
  const { data: started } = await person.post('/wallet/purchases', { votes });
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

  test('no public sign-up or supporter login exists', async () => {
    const anon = client(app.base);
    assert.equal((await anon.post('/auth/signup', { name: 'Sue', email: emailFor(), password: 'supporter-pass' })).status, 404);
    const sue = await makeSupporter(app);
    assert.equal((await anon.post('/auth/login', { email: sue.email, password: 'anything-at-all' })).status, 401);
  });

  test('a wallet opens with just an email and phone, and the same details bring it back', async () => {
    const sue = await makeSupporter(app);
    await buyCredits(sue, 3);

    const newPhone = client(app.base);
    assert.equal((await newPhone.get('/wallet')).status, 401);
    assert.equal((await newPhone.post('/supporters/wallet', { email: sue.email, phone: '08000000000' })).status, 401);
    assert.equal((await newPhone.get('/wallet')).status, 401);
    const back = await newPhone.post('/supporters/wallet', { email: sue.email.toUpperCase(), phone: sue.phone.replace(/^0/, '+234') });
    assert.equal(back.status, 200);
    assert.equal((await newPhone.get('/wallet')).data.balance, 3);

    // The admin's email can't be used to get in this way.
    const attempt = await client(app.base).post('/supporters/wallet', { email: 'admin@test.local', phone: '08000000000' });
    assert.equal(attempt.status, 401);
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

  test('someone with a wallet keeps their credits when they join the contest', async () => {
    const sue = await makeSupporter(app, 'walletjoiner');
    await buyCredits(sue, 4);
    const form = registrationForm('WalletJoiner', { email: sue.email, phone: sue.phone });
    assert.equal((await sue.req('POST', '/contestants/register', { form })).status, 201);
    assert.equal((await sue.get('/wallet')).data.balance, 4);
    assert.equal((await sue.get('/me/dashboard')).data.name, 'WalletJoiner');

    // A stranger who only knows the email cannot take over a wallet by joining with it.
    const other = await makeSupporter(app, 'victim');
    const stolen = registrationForm('Stranger', { email: other.email });
    assert.equal((await client(app.base).req('POST', '/contestants/register', { form: stolen })).status, 409);
  });

  test('paying directly needs only an email, creates no wallet and counts once', async () => {
    const { code } = await makeContestant(app, admin, 'DirectPay');
    const anon = client(app.base);
    const email = emailFor('directfan');
    const { status, data: started } = await anon.post('/votes/pay', { code, quantity: 5, email });
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
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM votes WHERE supporter_email = ?').get(email).n, 1);
    assert.equal(app.ctx.db.prepare('SELECT 1 AS x FROM users WHERE email = ?').get(email), undefined);

    const mail = app.ctx.db.prepare('SELECT subject, body FROM outbox WHERE to_addr = ?').get(email);
    assert.ok(mail.subject.includes('5 votes'));
    assert.ok(mail.body.includes(`/receipt/payment/${started.reference}`));
  });

  test('direct payments check the email, amount, contestant and voting state', async () => {
    const { code } = await makeContestant(app, admin, 'DirectRules');
    const anon = client(app.base);
    const email = emailFor();
    assert.equal((await anon.post('/votes/pay', { code, quantity: 1, email: 'nope' })).status, 400);
    for (const quantity of [0, -3, 1.5, '2', null]) {
      assert.equal((await anon.post('/votes/pay', { code, quantity, email })).status, 400);
    }
    assert.equal((await anon.post('/votes/pay', { code: 'NOPE9', quantity: 1, email })).status, 404);
    await admin.post('/admin/voting/paused');
    assert.equal((await anon.post('/votes/pay', { code, quantity: 1, email })).status, 409);
    await admin.post('/admin/voting/open');
    // The client cannot set its own price.
    assert.equal((await anon.post('/votes/pay', { code, quantity: 10, amount: 1, email })).data.amount, 5000);
  });

  test('a direct payment started before closing counts; one for a removed contestant is held', async () => {
    const late = await makeContestant(app, admin, 'LatePayer');
    const anon = client(app.base);
    const { data: started } = await anon.post('/votes/pay', { code: late.code, quantity: 6, email: emailFor() });
    await admin.post('/admin/voting/closed');
    await anon.post(`/simulator/${started.reference}/pay`);
    assert.equal((await anon.post(`/payments/${started.reference}/verify`)).data.votesStatus, 'counted');
    await admin.post('/admin/voting/open');

    const gone = await makeContestant(app, admin, 'GoneAway');
    const { data: heldStart } = await anon.post('/votes/pay', { code: gone.code, quantity: 3, email: emailFor() });
    await admin.post(`/admin/contestants/${gone.id}/disqualify`, { reason: 'Broke the rules' });
    await anon.post(`/simulator/${heldStart.reference}/pay`);
    const { data: held } = await anon.post(`/payments/${heldStart.reference}/verify`);
    assert.equal(held.status, 'paid');
    assert.equal(held.votesStatus, 'held');
    assert.equal((await admin.get('/admin/contestants?q=GoneAway')).data[0].totalVotes, 0);
    assert.ok((await admin.get('/admin/flags')).data.some((f) => f.kind === 'votes_held'));
    assert.ok((await admin.get('/admin/overview')).data.votesHeld >= 1);
  });

  test('funding a wallet creates it silently, votes, and keeps the rest', async () => {
    const { code } = await makeContestant(app, admin, 'FundVote');
    const fan = client(app.base);
    const email = emailFor('walletfan');
    const details = { code, quantity: 5, fund: 20, email, phone: '08091112222' };

    const { status, data: started } = await fan.post('/votes/fund', details);
    assert.equal(status, 201);
    assert.equal(started.amount, 10000);
    assert.notEqual(fan.cookie, '');
    assert.equal((await fan.get('/wallet')).data.balance, 0);
    assert.equal((await fan.get(`/contestants/${code}`)).data.totalVotes, 0);

    await fan.post(`/simulator/${started.reference}/pay`);
    const verified = await Promise.all(Array.from({ length: 6 }, () => fan.post(`/payments/${started.reference}/verify`)));
    assert.ok(verified.every((r) => r.data.status === 'paid'));
    assert.equal((await fan.post(`/payments/${started.reference}/verify`)).data.votesStatus, 'counted');
    assert.equal((await fan.get('/wallet')).data.balance, 15);
    assert.equal((await fan.get(`/contestants/${code}`)).data.totalVotes, 5);

    // The same details bring it back on another phone; a wrong number doesn't.
    const stranger = client(app.base);
    const wrong = await stranger.post('/votes/fund', { ...details, phone: '08000000000' });
    assert.equal(wrong.status, 401);
    assert.equal(stranger.cookie, '');
    const otherPhone = client(app.base);
    assert.equal((await otherPhone.post('/supporters/wallet', { email, phone: '+2348091112222' })).status, 200);
    assert.equal((await otherPhone.get('/wallet')).data.balance, 15);

    // Too little to cover the votes is refused.
    assert.equal((await fan.post('/votes/fund', { code, quantity: 50, fund: 5 })).status, 400);
  });

  test('if the vote can no longer be cast, funded credits stay safe in the wallet', async () => {
    const gone = await makeContestant(app, admin, 'FundGone');
    const sue = await makeSupporter(app);
    const { data: started } = await sue.post('/votes/fund', { code: gone.code, quantity: 5, fund: 10 });
    await admin.post(`/admin/contestants/${gone.id}/disqualify`, { reason: 'Broke the rules' });
    await sue.post(`/simulator/${started.reference}/pay`);
    const { data } = await sue.post(`/payments/${started.reference}/verify`);
    assert.equal(data.status, 'paid');
    assert.equal(data.votesStatus, 'kept');
    assert.equal(data.balance, 10);
    assert.equal((await admin.get('/admin/contestants?q=FundGone')).data[0].totalVotes, 0);
  });

  test('a browser "success" alone never creates credits', async () => {
    const sue = await makeSupporter(app);
    const { data: started } = await sue.post('/wallet/purchases', { votes: 3 });
    assert.equal(started.amount, 1500);

    // Unpaid at the provider: asking to verify changes nothing.
    const { data: check } = await sue.post(`/payments/${started.reference}/verify`, { paymentStatus: 'PAID', status: 'PAID' });
    assert.equal(check.status, 'pending');
    assert.equal(check.balance, 0);

    // Someone else holding the reference learns nothing about the wallet's balance.
    const other = await makeSupporter(app, 'other');
    assert.equal((await other.post(`/payments/${started.reference}/verify`)).data.balance, undefined);

    // The client cannot set its own price.
    const { data: cheap } = await sue.post('/wallet/purchases', { votes: 10, amount: 1, price: 1 });
    assert.equal(cheap.amount, 5000);
  });

  test('duplicate verifications and racing settlements credit exactly once', async () => {
    const sue = await makeSupporter(app);
    const { data: started } = await sue.post('/wallet/purchases', { votes: 4 });
    await sue.post(`/simulator/${started.reference}/pay`);

    const results = await Promise.all(Array.from({ length: 8 }, () => sue.post(`/payments/${started.reference}/verify`)));
    assert.ok(results.every((r) => r.data.status === 'paid'));

    const { data: wallet } = await sue.get('/wallet');
    assert.equal(wallet.balance, 4);
    const { n } = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE kind = 'purchase' AND user_id = ?").get(sue.userId);
    assert.equal(n, 1);
  });

  test('voting deducts credits, recalculates ranks, and retries do not double count', async () => {
    const stella = await makeContestant(app, admin, 'Stella');
    const jennifer = await makeContestant(app, admin, 'Jennifer');
    const sue = await makeSupporter(app);
    await buyCredits(sue, 20);

    const key = crypto.randomUUID();
    const first = await sue.post('/votes', { code: stella.code, quantity: 5, idempotencyKey: key });
    assert.equal(first.status, 201);
    assert.equal(first.data.balance, 15);
    assert.equal(first.data.contestant.totalVotes, 5);

    const retry = await sue.post('/votes', { code: stella.code, quantity: 5, idempotencyKey: key });
    assert.equal(retry.data.receiptNo, first.data.receiptNo);
    assert.equal(retry.data.balance, 15);

    await sue.post('/votes', { code: jennifer.code, quantity: 7, idempotencyKey: crypto.randomUUID() });
    const { data: board } = await client(app.base).get('/leaderboard?q=e');
    const j = board.rows.find((r) => r.code === jennifer.code);
    const s = board.rows.find((r) => r.code === stella.code);
    assert.ok(j.position < s.position);
    assert.equal(j.totalVotes, 7);
    assert.ok(s.previousPosition != null);
  });

  test('votes are refused without enough credits, and concurrent spends cannot overdraw', async () => {
    const { code } = await makeContestant(app, admin, 'Overdraw');
    const sue = await makeSupporter(app);
    const poor = await sue.post('/votes', { code, quantity: 1, idempotencyKey: crypto.randomUUID() });
    assert.equal(poor.status, 402);
    assert.equal(poor.data.needed, 1);

    await buyCredits(sue, 5);
    for (const quantity of [0, -3, 1.5, '2', null]) {
      assert.equal((await sue.post('/votes', { code, quantity, idempotencyKey: crypto.randomUUID() })).status, 400);
    }
    const attempts = await Promise.all(Array.from({ length: 10 }, () => sue.post('/votes', { code, quantity: 1, idempotencyKey: crypto.randomUUID() })));
    assert.equal(attempts.filter((r) => r.status === 201).length, 5);
    assert.equal(attempts.filter((r) => r.status === 402).length, 5);
    assert.equal((await sue.get('/wallet')).data.balance, 0);
    assert.equal((await client(app.base).get(`/contestants/${code}`)).data.totalVotes, 5);
  });

  test('voting needs a wallet and respects pause, close and the date window', async () => {
    const { code } = await makeContestant(app, admin, 'Window');
    const sue = await makeSupporter(app);
    await buyCredits(sue, 5);
    const vote = () => sue.post('/votes', { code, quantity: 1, idempotencyKey: crypto.randomUUID() });

    assert.equal((await client(app.base).post('/votes', { code, quantity: 1, idempotencyKey: crypto.randomUUID() })).status, 401);

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
    const sue = await makeSupporter(app, 'secretsupporter');
    await buyCredits(sue, 30);

    const pub = await listen(app.base);
    const alpha = await listen(app.base, a.person.cookie);
    const bravo = await listen(app.base, b.person.cookie);
    await sleep(30);

    await sue.post('/votes', { code: a.code, quantity: 5, idempotencyKey: crypto.randomUUID() });
    await sue.post('/votes', { code: a.code, quantity: 10, idempotencyKey: crypto.randomUUID() });
    await sleep(150);

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

  test('receipts belong to their owner', async () => {
    const { code } = await makeContestant(app, admin, 'Receipt');
    const sue = await makeSupporter(app);
    const reference = await buyCredits(sue, 2);
    const { data: vote } = await sue.post('/votes', { code, quantity: 2, idempotencyKey: crypto.randomUUID() });

    assert.equal((await sue.get(`/receipts/vote/${vote.receiptNo}`)).status, 200);
    assert.equal((await sue.get(`/receipts/payment/${reference}`)).status, 200);

    const other = await makeSupporter(app, 'nosy');
    assert.equal((await other.get(`/receipts/vote/${vote.receiptNo}`)).status, 404);
    assert.equal((await client(app.base).get(`/receipts/vote/${vote.receiptNo}`)).status, 401);

    // A payment receipt is reached by its long reference, and hides most of the email.
    const paymentReceipt = await client(app.base).get(`/receipts/payment/${reference}`);
    assert.equal(paymentReceipt.status, 200);
    assert.ok(!JSON.stringify(paymentReceipt.data).includes(sue.email));
    assert.equal((await client(app.base).get('/receipts/payment/MBG-WRONG')).status, 404);
  });

  test('admin routes refuse everyone else, and cross-site writes are refused', async () => {
    const sue = await makeSupporter(app);
    assert.equal((await sue.get('/admin/overview')).status, 403);
    assert.equal((await client(app.base).get('/admin/overview')).status, 401);
    assert.equal((await sue.get('/admin/export/votes.csv')).status, 403);

    const res = await sue.req('POST', '/votes', { body: {}, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('voiding a vote updates totals, ranks and optionally refunds', async () => {
    const { code } = await makeContestant(app, admin, 'Voided');
    const sue = await makeSupporter(app);
    await buyCredits(sue, 6);
    await sue.post('/votes', { code, quantity: 6, idempotencyKey: crypto.randomUUID() });

    const { data: votes } = await admin.get('/admin/votes');
    const vote = votes.find((v) => v.code === code);
    assert.equal((await admin.post(`/admin/votes/${vote.id}/void`, { reason: 'Fraud confirmed', refund: true })).status, 200);
    assert.equal((await client(app.base).get(`/contestants/${code}`)).data.totalVotes, 0);
    assert.equal((await sue.get('/wallet')).data.balance, 6);
    assert.equal((await admin.post(`/admin/votes/${vote.id}/void`, { reason: 'Again please' })).status, 409);
  });

  test('suspicious patterns raise flags for review', async () => {
    const { code, person } = await makeContestant(app, admin, 'Flagged');
    await buyCredits(person, 2000);
    const big = await person.post('/votes', { code, quantity: 1000, idempotencyKey: crypto.randomUUID() });
    assert.equal(big.status, 201);
    const { data: flags } = await admin.get('/admin/flags');
    const kinds = flags.filter((f) => f.code === code).map((f) => f.kind);
    assert.ok(kinds.includes('large_vote'));
    assert.ok(kinds.includes('self_vote'));
  });

  test('frozen wallets cannot vote or buy', async () => {
    const { code } = await makeContestant(app, admin, 'Frozen');
    const sue = await makeSupporter(app);
    await buyCredits(sue, 2);
    await admin.post(`/admin/users/${sue.userId}/freeze`, { frozen: true });
    assert.equal((await sue.post('/votes', { code, quantity: 1, idempotencyKey: crypto.randomUUID() })).status, 403);
    assert.equal((await sue.post('/wallet/purchases', { votes: 1 })).status, 403);
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
    const mail = app.ctx.db.prepare("SELECT body FROM outbox WHERE subject LIKE 'Reset%' ORDER BY id DESC").get();
    const token = mail.body.match(/\/reset\/([\w-]+)/)[1];
    assert.equal((await client(app.base).post('/auth/reset', { token, password: 'brand-new-pass' })).status, 200);
    assert.equal((await client(app.base).post('/auth/reset', { token, password: 'another-pass-1' })).status, 400);
    assert.equal((await adminSession.get('/admin/overview')).status, 401);
    assert.equal((await client(app.base).post('/auth/login', { email: 'admin@test.local', password: 'brand-new-pass' })).status, 200);
  });
});

// Runs the real Monnify client against a local server that follows Monnify's documented contract.
describe('Monnify integration (against a local stand-in)', () => {
  const SECRET = 'SK_TEST_SECRET';
  let fake;
  let fakeUrl;
  let paidAmount;
  let status;
  let queries = 0;
  let app;

  before(async () => {
    fake = http.createServer((req, res) => {
      const send = (body) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ requestSuccessful: true, responseMessage: 'success', responseCode: '0', responseBody: body }));
      };
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/api/v1/auth/login') {
          assert.equal(req.headers.authorization, `Basic ${Buffer.from(`MK_TEST:${SECRET}`).toString('base64')}`);
          return send({ accessToken: 'token-123', expiresIn: 3600 });
        }
        assert.equal(req.headers.authorization, 'Bearer token-123');
        if (url.pathname === '/api/v1/merchant/transactions/init-transaction') {
          const body = JSON.parse(raw);
          assert.equal(body.contractCode, 'CONTRACT');
          assert.equal(body.currencyCode, 'NGN');
          assert.ok(body.redirectUrl.endsWith(`/pay/return/${body.paymentReference}`));
          return send({ transactionReference: 'MNFY|1', paymentReference: body.paymentReference, checkoutUrl: 'https://sandbox.sdk.monnify.com/checkout/MNFY|1' });
        }
        if (url.pathname === '/api/v2/merchant/transactions/query') {
          queries += 1;
          return send({ paymentReference: url.searchParams.get('paymentReference'), transactionReference: 'MNFY|1', paymentStatus: status, amountPaid: String(paidAmount), paymentMethod: 'CARD' });
        }
        res.statusCode = 404;
        return res.end('{}');
      });
    }).listen(0);
    await new Promise((resolve) => fake.once('listening', resolve));
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
    app = await boot({
      monnify: { apiKey: 'MK_TEST', secretKey: SECRET, contractCode: 'CONTRACT', live: true, baseUrl: fakeUrl },
    });
  });
  after(() => {
    app.close();
    fake.closeAllConnections();
    fake.close();
  });

  const webhook = (body, signature) => fetch(`${app.base}/api/webhooks/monnify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature ? { 'monnify-signature': signature } : {}) },
    body,
  });
  const sign = (body) => crypto.createHmac('sha512', SECRET).update(body).digest('hex');
  const eventFor = (reference) => JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: reference, amountPaid: 999999, paymentStatus: 'PAID' } });

  test('a direct payment counts only what Monnify confirms', async () => {
    const admin = client(app.base);
    await admin.post('/auth/login', { email: 'admin@test.local', password: 'admin-password' });
    const { code } = await makeContestant(app, admin, 'MonnifyDirect');
    const anon = client(app.base);
    const { data } = await anon.post('/votes/pay', { code, quantity: 4, email: emailFor() });
    assert.ok(data.checkoutUrl.startsWith('https://sandbox.sdk.monnify.com/checkout/'));

    status = 'PENDING';
    paidAmount = 0;
    const body = eventFor(data.reference);
    await webhook(body, sign(body));
    await sleep(40);
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 0);

    status = 'PAID';
    paidAmount = 2000;
    await webhook(body, sign(body));
    await sleep(60);
    assert.equal((await anon.post(`/payments/${data.reference}/verify`)).data.votesStatus, 'counted');
    assert.equal((await anon.get(`/contestants/${code}`)).data.totalVotes, 4);
  });

  test('starts a real checkout, and the simulator route does not exist', async () => {
    const sue = await makeSupporter(app);
    const { data } = await sue.post('/wallet/purchases', { votes: 2 });
    assert.ok(data.checkoutUrl.startsWith('https://sandbox.sdk.monnify.com/checkout/'));
    assert.equal((await sue.post(`/simulator/${data.reference}/pay`)).status, 404);
  });

  test('forged or unsigned webhooks are ignored on live, and flagged', async () => {
    const sue = await makeSupporter(app);
    const { data } = await sue.post('/wallet/purchases', { votes: 2 });
    status = 'PAID';
    paidAmount = 1000;
    const body = eventFor(data.reference);
    assert.equal((await webhook(body, 'not-the-signature')).status, 401);
    assert.equal((await webhook(body)).status, 401);
    await sleep(40);
    assert.equal((await sue.get('/wallet')).data.balance, 0);
    assert.ok(app.ctx.db.prepare("SELECT 1 FROM flags WHERE kind = 'bad_webhook_signature'").get());
  });

  test('a signed webhook credits once, using the amount Monnify reports rather than the webhook body', async () => {
    const sue = await makeSupporter(app);
    const { data } = await sue.post('/wallet/purchases', { votes: 2 });

    // Signed webhook says paid, but Monnify's own answer is still pending: no credit.
    status = 'PENDING';
    paidAmount = 0;
    const body = eventFor(data.reference);
    assert.equal((await webhook(body, sign(body))).status, 200);
    await sleep(40);
    assert.equal((await sue.get('/wallet')).data.balance, 0);

    status = 'PAID';
    paidAmount = 1000;
    await Promise.all([webhook(body, sign(body)), webhook(body, sign(body)), webhook(body, sign(body))]);
    await sleep(60);
    await sue.post(`/payments/${data.reference}/verify`);
    assert.equal((await sue.get('/wallet')).data.balance, 2);
    assert.ok(queries > 0);
  });

  test('an underpayment gives no credits and goes to review', async () => {
    const sue = await makeSupporter(app);
    const { data } = await sue.post('/wallet/purchases', { votes: 10 });
    status = 'PAID';
    paidAmount = 100;
    const { data: result } = await sue.post(`/payments/${data.reference}/verify`);
    assert.equal(result.status, 'review');
    assert.equal(result.balance, 0);
    assert.ok(app.ctx.db.prepare("SELECT 1 FROM flags WHERE kind = 'payment_mismatch'").get());
  });

  test('failed and expired payments are marked failed', async () => {
    const sue = await makeSupporter(app);
    const { data } = await sue.post('/wallet/purchases', { votes: 1 });
    status = 'EXPIRED';
    paidAmount = 0;
    const { data: result } = await sue.post(`/payments/${data.reference}/verify`);
    assert.equal(result.status, 'failed');
    assert.equal(result.balance, 0);
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
      app.close();
    }
  });

  test('refuses to boot in production with the simulator or without a secret', () => {
    assert.throws(() => loadConfig({ nodeEnv: 'production', appSecret: 'x', monnify: null }), /simulator/);
    assert.throws(
      () => loadConfig({ nodeEnv: 'production', appSecret: undefined, monnify: { apiKey: 'a', secretKey: 'b', contractCode: 'c', baseUrl: 'x' } }),
      /APP_SECRET/,
    );
  });
});
