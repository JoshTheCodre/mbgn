import crypto from 'node:crypto';
import { HttpError, hashIp } from './auth.js';
import { notifyUser, raiseFlag, votingState } from './competition.js';
import { getSetting, nowIso, tx } from './db.js';
import { castVote, recordDirectVotes } from './votes.js';

export const MAX_CREDITS_PER_PURCHASE = 100000;

// ---- Providers. Each exposes init() and query(); query() is the only thing that can credit a wallet. ----

export function createMonnify(config) {
  const { apiKey, secretKey, contractCode, baseUrl, live } = config.monnify;
  let token = null;
  let tokenExpiry = 0;

  async function call(pathname, init) {
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.requestSuccessful) {
      throw new Error(`Monnify ${pathname} failed: ${body?.responseMessage ?? res.status}`);
    }
    return body.responseBody;
  }

  async function bearer() {
    if (token && Date.now() < tokenExpiry) return token;
    const basic = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
    const auth = await call('/api/v1/auth/login', { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
    token = auth.accessToken;
    // Monnify tokens last an hour; renew a minute early.
    tokenExpiry = Date.now() + Math.max((auth.expiresIn ?? 3600) - 60, 30) * 1000;
    return token;
  }

  return {
    name: 'monnify',
    async init({ reference, amount, description, customerName, customerEmail, redirectUrl }) {
      const body = await call('/api/v1/merchant/transactions/init-transaction', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          customerName,
          customerEmail,
          paymentReference: reference,
          paymentDescription: description,
          currencyCode: 'NGN',
          contractCode,
          redirectUrl,
          paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD', 'PHONE_NUMBER'],
        }),
      });
      if (body.paymentReference !== reference) throw new Error('Monnify returned a different payment reference.');
      return { checkoutUrl: body.checkoutUrl, providerRef: body.transactionReference };
    },
    async query(reference) {
      const body = await call(`/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${await bearer()}` },
      });
      return {
        reference: body.paymentReference,
        status: body.paymentStatus,
        amountPaid: Number(body.amountPaid),
        currency: body.currency ?? body.currencyCode ?? 'NGN',
        method: body.paymentMethod ?? null,
        providerRef: body.transactionReference ?? null,
      };
    },
    // Monnify signs live webhooks only, so sandbox notifications arrive unsigned. That is safe
    // because a webhook is only ever a prompt to query() Monnify directly.
    signatureValid(rawBody, signature) {
      if (!signature) return !live;
      const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

// Stand-in used until Monnify keys are configured. Refuses to run in production (see config.js).
export function createSimulator(db) {
  return {
    name: 'simulator',
    async init({ reference, amount }) {
      db.prepare('INSERT INTO simulated_provider (reference, amount) VALUES (?, ?)').run(reference, amount);
      return { checkoutUrl: `/pay/sim/${reference}`, providerRef: `SIM-${reference}` };
    },
    async query(reference) {
      const row = db.prepare('SELECT * FROM simulated_provider WHERE reference = ?').get(reference);
      if (!row) throw new Error('Unknown simulated payment.');
      return {
        reference,
        status: row.paid_at ? 'PAID' : 'PENDING',
        amountPaid: row.paid_at ? row.amount : 0,
        currency: 'NGN',
        method: 'SIMULATED',
        providerRef: `SIM-${reference}`,
      };
    },
    signatureValid: () => false,
  };
}

// ---- Starting a payment ----

// A package's price if one matches exactly, otherwise the price per vote.
export function priceFor(db, votes) {
  if (!Number.isInteger(votes) || votes < 1 || votes > MAX_CREDITS_PER_PURCHASE) {
    throw new HttpError(400, `Enter between 1 and ${MAX_CREDITS_PER_PURCHASE.toLocaleString('en-NG')} votes.`);
  }
  const pack = db.prepare('SELECT price FROM packages WHERE votes = ? AND active = 1').get(votes);
  return pack ? pack.price : votes * Number(getSetting(db, 'vote_price'));
}

export function quotePurchase(db, { packageId, votes }) {
  if (packageId != null) {
    const pack = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
    if (!pack) throw new HttpError(404, 'That package is no longer available.');
    return { credits: pack.votes, amount: pack.price };
  }
  return { credits: votes, amount: priceFor(db, votes) };
}

const safeReturnPath = (value) => (typeof value === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(value) ? value : null);

async function beginCheckout(ctx, {
  user = null, email, mode, credits, amount, returnTo = null, contestantId = null, voteQuantity = null, viaLink = false, ip = null, description,
}) {
  const { db, config, provider } = ctx;
  // Long and random: holding this reference is what lets someone see the payment and its receipt.
  const reference = `MBG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  const { lastInsertRowid: paymentId } = db.prepare(`
    INSERT INTO payments (reference, user_id, email, mode, vote_contestant_id, vote_quantity, via_link, ip_hash, credits, amount, provider, return_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reference, user?.id ?? null, email, mode, contestantId, voteQuantity, viaLink ? 1 : 0, hashIp(config, ip), credits, amount, provider.name, safeReturnPath(returnTo), nowIso());

  const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
  const attempts = db.prepare(`SELECT COUNT(*) AS n FROM payments
    WHERE email = ? AND status = 'pending' AND created_at >= ?`).get(email, tenMinutesAgo).n;
  if (attempts >= 8) {
    raiseFlag(ctx, { kind: 'repeated_checkouts', severity: 'low', details: `${attempts} unfinished checkouts in 10 minutes from ${email}.`, userId: user?.id ?? null });
  }

  try {
    const { checkoutUrl, providerRef } = await provider.init({
      reference,
      amount,
      description,
      customerName: user?.name ?? 'MBGN supporter',
      customerEmail: email,
      redirectUrl: `${config.publicUrl}/pay/return/${reference}`,
    });
    db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(providerRef ?? null, paymentId);
    return { reference, checkoutUrl, credits, amount };
  } catch (err) {
    console.error('Could not start payment:', err.message);
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
    throw new HttpError(502, 'The payment provider could not start this payment. Please try again.');
  }
}

function votableContestant(db, code) {
  const state = votingState(db);
  if (!state.open) throw new HttpError(409, state.message);
  const contestant = db.prepare("SELECT id, code FROM contestants WHERE code = ? AND status = 'approved'").get(code);
  if (!contestant) throw new HttpError(404, 'No active contestant has that code.');
  return contestant;
}

// A plain wallet top-up.
export async function startPurchase(ctx, { user, packageId, votes, returnTo, ip }) {
  if (user.frozen) throw new HttpError(403, 'This wallet is under review and cannot buy credits right now.');
  const { credits, amount } = quotePurchase(ctx.db, { packageId, votes });
  return beginCheckout(ctx, {
    user, email: user.email, mode: 'wallet', credits, amount, returnTo, ip, description: `${credits} MBGN voting credit${credits === 1 ? '' : 's'}`,
  });
}

// Pay directly: no wallet, and the votes count as soon as the provider confirms.
export async function startDirectPayment(ctx, { code, quantity, email, viaLink, ip }) {
  const { db } = ctx;
  const address = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, 'Please enter a valid email address for your receipt.');
  const contestant = votableContestant(db, code);
  const amount = priceFor(db, quantity);
  return beginCheckout(ctx, {
    email: address,
    mode: 'direct',
    credits: quantity,
    amount,
    returnTo: `/c/${contestant.code}`,
    contestantId: contestant.id,
    voteQuantity: quantity,
    viaLink,
    ip,
    description: `${quantity} MBGN vote${quantity === 1 ? '' : 's'} for ${contestant.code}`,
  });
}

// Fund a wallet and vote: credits go in, these votes come straight out, and the rest stay.
export async function startFundAndVote(ctx, { user, code, quantity, fund, viaLink, ip }) {
  const { db } = ctx;
  if (user.frozen) throw new HttpError(403, 'This wallet is under review and cannot buy credits right now.');
  const contestant = votableContestant(db, code);
  priceFor(db, quantity);
  const amount = priceFor(db, fund);
  const { credits: balance } = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
  if (fund + balance < quantity) throw new HttpError(400, `Add at least ${quantity - balance} credits to cast ${quantity} votes.`);
  return beginCheckout(ctx, {
    user,
    email: user.email,
    mode: 'wallet',
    credits: fund,
    amount,
    returnTo: `/c/${contestant.code}`,
    contestantId: contestant.id,
    voteQuantity: quantity,
    viaLink,
    ip,
    description: `${fund} MBGN voting credit${fund === 1 ? '' : 's'}`,
  });
}

// What anyone holding the reference may see. The balance is only ever shown to its owner.
export function paymentView(db, payment, viewer = null) {
  const contestant = payment.vote_contestant_id
    ? db.prepare('SELECT code, stage_name, status, total_votes, position FROM contestants WHERE id = ?').get(payment.vote_contestant_id)
    : null;
  const own = viewer && viewer.id === payment.user_id;
  return {
    reference: payment.reference,
    mode: payment.mode,
    credits: payment.credits,
    amount: payment.amount,
    status: payment.status,
    votes: payment.vote_quantity,
    votesStatus: payment.votes_status,
    provider: payment.provider,
    method: payment.payment_method,
    createdAt: payment.created_at,
    paidAt: payment.paid_at,
    returnTo: payment.return_to,
    contestant: contestant ? {
      code: contestant.code,
      name: contestant.stage_name,
      totalVotes: contestant.status === 'approved' ? contestant.total_votes : null,
      position: contestant.position,
    } : null,
    balance: own ? db.prepare('SELECT credits FROM users WHERE id = ?').get(payment.user_id).credits : undefined,
  };
}

// The single path that turns money into credits or votes. It always asks the provider directly;
// browser redirects and webhook bodies only decide *when* it runs, never the outcome.
export async function settlePayment(ctx, reference) {
  const { db, provider } = ctx;
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) throw new HttpError(404, 'Payment not found.');
  if (payment.status === 'paid' || payment.status === 'review') return payment;

  const result = await provider.query(reference);
  if (result.reference && result.reference !== reference) {
    raiseFlag(ctx, { kind: 'payment_mismatch', severity: 'high', details: `Provider answered ${reference} with ${result.reference}.`, userId: payment.user_id, paymentId: payment.id });
    return payment;
  }

  if (result.status === 'PAID' || result.status === 'OVERPAID') {
    if (result.currency !== 'NGN' || !(result.amountPaid >= payment.amount)) {
      tx(db, () => {
        db.prepare("UPDATE payments SET status = 'review', paid_amount = ? WHERE id = ?").run(result.amountPaid, payment.id);
        raiseFlag(ctx, {
          kind: 'payment_mismatch',
          severity: 'high',
          details: `${reference}: expected NGN ${payment.amount}, provider reports ${result.currency} ${result.amountPaid}. No credits given.`,
          userId: payment.user_id,
          paymentId: payment.id,
        });
      });
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    }
    if (!payment.user_id) {
      const outcome = recordDirectVotes(ctx, payment, result);
      if (outcome) sendPaymentEmail(ctx, payment, outcome);
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    }
    return creditWallet(ctx, payment, result);
  }

  if (result.status === 'PARTIALLY_PAID') {
    tx(db, () => {
      db.prepare("UPDATE payments SET status = 'review', paid_amount = ? WHERE id = ?").run(result.amountPaid, payment.id);
      raiseFlag(ctx, { kind: 'partial_payment', details: `${reference}: paid ${result.amountPaid} of ${payment.amount}. No credits given.`, userId: payment.user_id, paymentId: payment.id });
    });
  } else if (['FAILED', 'EXPIRED', 'REVERSED', 'CANCELLED'].includes(result.status)) {
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

function creditWallet(ctx, payment, result) {
  const { db } = ctx;
  const credited = tx(db, () => {
    // Exactly one caller can flip this row, however many webhooks and verifies race.
    const flip = db.prepare(`UPDATE payments SET status = 'paid', paid_amount = ?, paid_at = ?, payment_method = ?,
      provider_ref = COALESCE(?, provider_ref) WHERE id = ? AND status IN ('pending', 'failed')`)
      .run(result.amountPaid, nowIso(), result.method, result.providerRef, payment.id);
    if (flip.changes !== 1) return false;
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(payment.credits, payment.user_id);
    const { credits } = db.prepare('SELECT credits FROM users WHERE id = ?').get(payment.user_id);
    db.prepare(`INSERT INTO wallet_ledger (user_id, delta, balance_after, kind, payment_id, created_at)
      VALUES (?, ?, ?, 'purchase', ?, ?)`).run(payment.user_id, payment.credits, credits, payment.id, nowIso());
    return true;
  });
  if (credited) {
    notifyUser(ctx, payment.user_id, 'wallet', `${payment.credits} voting credit${payment.credits === 1 ? '' : 's'} added to your wallet.`);
    const outcome = payment.vote_contestant_id ? voteFromPayment(ctx, payment) : {};
    ctx.bus.sendToUser(payment.user_id, 'wallet', { reference: payment.reference });
    sendPaymentEmail(ctx, payment, outcome);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

// The votes a "fund wallet and vote" payment was made for. If they can no longer be cast,
// nothing is lost: the credits simply stay in the wallet.
function voteFromPayment(ctx, payment) {
  const { db } = ctx;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payment.user_id);
  const contestant = db.prepare('SELECT code, stage_name FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
  try {
    castVote(ctx, {
      user,
      code: contestant.code,
      quantity: payment.vote_quantity,
      idempotencyKey: `payment-${payment.id}`,
      viaLink: Boolean(payment.via_link),
      ipHash: payment.ip_hash ?? 'unknown',
      payment,
    });
    db.prepare("UPDATE payments SET votes_status = 'counted' WHERE id = ?").run(payment.id);
    return { contestant };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    db.prepare("UPDATE payments SET votes_status = 'kept' WHERE id = ?").run(payment.id);
    notifyUser(ctx, payment.user_id, 'wallet', `Your vote for ${contestant.stage_name} could not be cast, so your credits are safe in your wallet.`);
    return { kept: true, contestant };
  }
}

function sendPaymentEmail(ctx, payment, { held, kept, contestant }) {
  const link = `${ctx.config.publicUrl}/receipt/payment/${payment.reference}`;
  const naira = `NGN ${payment.amount.toLocaleString('en-NG')}`;
  const votes = payment.vote_quantity;
  let subject = 'Your MBGN credits';
  let text = `Your payment of ${naira} added ${payment.credits} voting credits to your wallet.`;
  if (held) {
    subject = 'We received your payment';
    text = `Your payment of ${naira} arrived, but those votes could not be counted because ${contestant.stage_name} is no longer in the running or results are final. Our team will refund you.`;
  } else if (kept) {
    text = `Your payment of ${naira} arrived, but your vote for ${contestant.stage_name} could not be cast. Your credits are safe in your wallet.`;
  } else if (contestant) {
    subject = `Your ${votes} vote${votes === 1 ? '' : 's'} for ${contestant.stage_name}`;
    text = `Thank you! ${votes} vote${votes === 1 ? ' has' : 's have'} been counted for ${contestant.stage_name} (${contestant.code}).`;
  }
  ctx.mailer.send({ to: payment.email, subject, text: `${text}\n\nReceipt: ${link}` });
}

// Catches payments whose webhook and browser redirect both went missing.
export async function reconcilePending(ctx) {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const pending = ctx.db.prepare("SELECT reference FROM payments WHERE status = 'pending' AND created_at >= ?").all(dayAgo);
  for (const { reference } of pending) {
    await settlePayment(ctx, reference).catch((err) => console.error(`Reconcile ${reference}:`, err.message));
  }
}

export function handleWebhook(ctx, rawBody, signature) {
  if (!ctx.provider.signatureValid(rawBody, signature)) {
    raiseFlag(ctx, { kind: 'bad_webhook_signature', severity: 'high', details: 'A payment webhook arrived with an invalid signature and was ignored.' });
    return { accepted: false };
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { accepted: true };
  }
  const reference = event?.eventData?.paymentReference;
  const known = typeof reference === 'string'
    && ctx.db.prepare('SELECT 1 FROM payments WHERE reference = ?').get(reference);
  if (event?.eventType === 'SUCCESSFUL_TRANSACTION' && known) {
    // Acknowledge first, as Monnify recommends, then settle.
    setImmediate(() => settlePayment(ctx, reference).catch((err) => console.error(`Webhook ${reference}:`, err.message)));
  }
  return { accepted: true };
}
