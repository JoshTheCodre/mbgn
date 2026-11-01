import crypto from 'node:crypto';
import { HttpError, hashIp } from './auth.js';
import { raiseFlag, votingState } from './competition.js';
import { getSetting, nowIso, tx } from './db.js';
import { recordPaidVotes } from './votes.js';

export const MAX_VOTES_PER_PAYMENT = 100000;

// ---- Providers. Each exposes init() and query(); query() is the only thing that can get votes counted. ----

export function createPaystack(config) {
  const { secretKey, baseUrl } = config.paystack;
  const STATUSES = { success: 'PAID', failed: 'FAILED', reversed: 'REVERSED' };

  async function call(pathname, init) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.status) {
      throw new Error(`Paystack ${pathname} failed: ${body?.message ?? res.status}`);
    }
    return body.data;
  }

  return {
    name: 'paystack',
    async init({ reference, amount, description, customerEmail, redirectUrl }) {
      const data = await call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email: customerEmail,
          amount: amount * 100,
          currency: 'NGN',
          reference,
          callback_url: redirectUrl,
          metadata: {
            // Paystack's cancel link on checkout goes here.
            cancel_action: `${redirectUrl}?cancelled=1`,
            custom_fields: [{ display_name: 'Order', variable_name: 'order', value: description }],
          },
        }),
      });
      if (data.reference !== reference) throw new Error('Paystack returned a different payment reference.');
      return { checkoutUrl: data.authorization_url, providerRef: data.access_code };
    },
    async query(reference) {
      const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      return {
        reference: data.reference,
        // "abandoned" only means nobody has finished this checkout yet, so it can still be paid.
        status: STATUSES[data.status] ?? 'PENDING',
        amountPaid: Number(data.amount) / 100,
        currency: data.currency,
        method: data.channel ?? null,
        providerRef: data.id == null ? null : String(data.id),
      };
    },
    // A webhook is only ever a prompt to query() Paystack directly.
    signatureValid(rawBody, signature) {
      if (!signature) return false;
      const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

// Stand-in used until a Paystack key is configured. Refuses to run in production (see config.js).
export function createSimulator(db) {
  return {
    name: 'simulator',
    async init({ reference, amount }) {
      await db.prepare('INSERT INTO simulated_provider (reference, amount) VALUES (?, ?)').run(reference, amount);
      return { checkoutUrl: `/pay/sim/${reference}`, providerRef: `SIM-${reference}` };
    },
    async query(reference) {
      const row = await db.prepare('SELECT * FROM simulated_provider WHERE reference = ?').get(reference);
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
export async function priceFor(db, votes) {
  if (!Number.isInteger(votes) || votes < 1 || votes > MAX_VOTES_PER_PAYMENT) {
    throw new HttpError(400, `Enter between 1 and ${MAX_VOTES_PER_PAYMENT.toLocaleString('en-NG')} votes.`);
  }
  const pack = await db.prepare('SELECT price FROM packages WHERE votes = ? AND active = 1').get(votes);
  return pack ? pack.price : votes * Number(await getSetting(db, 'vote_price'));
}

// Paystack requires a customer email, and supporters aren't asked for one.
function checkoutEmail(config, reference) {
  const [name, domain] = config.paymentEmail.split('@');
  return `${name}+${reference.toLowerCase()}@${domain}`;
}

// The votes count as soon as the provider confirms the payment.
export async function startPayment(ctx, { code, quantity, email = null, viaLink, ip }) {
  const { db, config, provider } = ctx;
  const state = await votingState(db);
  if (!state.open) throw new HttpError(409, state.message);
  const contestant = await db.prepare("SELECT id, code FROM contestants WHERE code = ? AND status = 'approved'").get(code);
  if (!contestant) throw new HttpError(404, 'No active contestant has that code.');
  const amount = await priceFor(db, quantity);

  // Long and random: holding this reference is what lets someone see the payment and its receipt.
  const reference = `MBG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  const ipHash = hashIp(config, ip);
  const { lastInsertRowid: paymentId } = await db.prepare(`
    INSERT INTO payments (reference, email, vote_contestant_id, vote_quantity, via_link, ip_hash, amount, provider, return_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(reference, email, contestant.id, quantity, viaLink ? 1 : 0, ipHash, amount, provider.name, `/c/${contestant.code}`, nowIso());

  const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
  const attempts = (await db.prepare(`SELECT COUNT(*) AS n FROM payments
    WHERE ip_hash = ? AND status = 'pending' AND created_at >= ?`).get(ipHash, tenMinutesAgo)).n;
  if (attempts >= 20) {
    await raiseFlag(ctx, { kind: 'repeated_checkouts', severity: 'low', details: `${attempts} unfinished checkouts in 10 minutes from one network.` });
  }

  try {
    const { checkoutUrl, providerRef } = await provider.init({
      reference,
      amount,
      description: `${quantity} MBGN vote${quantity === 1 ? '' : 's'} for ${contestant.code}`,
      customerEmail: checkoutEmail(config, reference),
      redirectUrl: `${config.publicUrl}/pay/return/${reference}`,
    });
    await db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(providerRef ?? null, paymentId);
    return { reference, checkoutUrl, votes: quantity, amount };
  } catch (err) {
    console.error('Could not start payment:', err.message);
    await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
    throw new HttpError(502, 'The payment provider could not start this payment. Please try again.');
  }
}

// What anyone holding the reference may see.
export async function paymentView(db, payment) {
  const contestant = await db.prepare('SELECT code, stage_name, status, total_votes, position FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
  return {
    reference: payment.reference,
    amount: payment.amount,
    status: payment.status,
    votes: payment.vote_quantity,
    votesStatus: payment.votes_status,
    provider: payment.provider,
    method: payment.payment_method,
    createdAt: payment.created_at,
    paidAt: payment.paid_at,
    returnTo: payment.return_to,
    emailed: Boolean(payment.email),
    contestant: {
      code: contestant.code,
      name: contestant.stage_name,
      totalVotes: contestant.status === 'approved' ? contestant.total_votes : null,
      position: contestant.position,
    },
  };
}

// The single path that turns money into votes. It always asks the provider directly;
// browser redirects and webhook bodies only decide *when* it runs, never the outcome.
export async function settlePayment(ctx, reference) {
  const { db, provider } = ctx;
  const payment = await db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) throw new HttpError(404, 'Payment not found.');
  if (payment.status === 'paid' || payment.status === 'review') return payment;

  const result = await provider.query(reference);
  if (result.reference && result.reference !== reference) {
    await raiseFlag(ctx, { kind: 'payment_mismatch', severity: 'high', details: `Provider answered ${reference} with ${result.reference}.`, paymentId: payment.id });
    return payment;
  }

  if (result.status === 'PAID') {
    if (result.currency !== 'NGN' || !(result.amountPaid >= payment.amount)) {
      await tx(db, async () => {
        await db.prepare("UPDATE payments SET status = 'review', paid_amount = ? WHERE id = ?").run(result.amountPaid, payment.id);
        await raiseFlag(ctx, {
          kind: 'payment_mismatch',
          severity: 'high',
          details: `${reference}: expected NGN ${payment.amount}, provider reports ${result.currency} ${result.amountPaid}. No votes counted.`,
          paymentId: payment.id,
        });
      });
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    }
    const outcome = await recordPaidVotes(ctx, payment, result);
    if (outcome && payment.email) await sendPaymentEmail(ctx, payment, outcome);
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  }

  if (['FAILED', 'REVERSED'].includes(result.status)) {
    await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

function sendPaymentEmail(ctx, payment, { held, contestant }) {
  const link = `${ctx.config.publicUrl}/receipt/payment/${payment.reference}`;
  const naira = `NGN ${payment.amount.toLocaleString('en-NG')}`;
  const votes = payment.vote_quantity;
  const subject = held ? 'We received your payment' : `Your ${votes} vote${votes === 1 ? '' : 's'} for ${contestant.stage_name}`;
  const text = held
    ? `Your payment of ${naira} arrived, but those votes could not be counted because ${contestant.stage_name} is no longer in the running or results are final. Our team will refund you.`
    : `Thank you! ${votes} vote${votes === 1 ? ' has' : 's have'} been counted for ${contestant.stage_name} (${contestant.code}).`;
  return ctx.mailer.send({ to: payment.email, subject, text: `${text}\n\nReceipt: ${link}` });
}

// The optional receipt offered after paying. One per payment, so holding a reference
// can't be used to send someone repeated emails.
export async function emailReceipt(ctx, payment, address) {
  const { db } = ctx;
  const email = typeof address === 'string' ? address.trim().toLowerCase().slice(0, 200) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (payment.status !== 'paid') throw new HttpError(409, 'A receipt is issued once payment is confirmed.');
  const { changes } = await db.prepare('UPDATE payments SET email = ? WHERE id = ? AND email IS NULL').run(email, payment.id);
  if (changes !== 1) throw new HttpError(409, 'The receipt for this payment has already been sent.');

  const contestant = await db.prepare('SELECT * FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
  if (email === contestant.email.toLowerCase()) {
    await raiseFlag(ctx, {
      kind: 'self_vote',
      details: `${email} belongs to ${contestant.code}, and asked for the receipt for ${payment.vote_quantity} votes for them.`,
      contestantId: contestant.id,
    });
  }
  await sendPaymentEmail(ctx, { ...payment, email }, { held: payment.votes_status === 'held', contestant });
}

// Catches payments whose webhook and browser redirect both went missing.
export async function reconcilePending(ctx) {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const pending = await ctx.db.prepare("SELECT reference FROM payments WHERE status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 50").all(dayAgo);
  for (const { reference } of pending) {
    await settlePayment(ctx, reference).catch((err) => console.error(`Reconcile ${reference}:`, err.message));
  }
}

export async function handleWebhook(ctx, rawBody, signature) {
  if (!ctx.provider.signatureValid(rawBody, signature)) {
    await raiseFlag(ctx, { kind: 'bad_webhook_signature', severity: 'high', details: 'A payment webhook arrived with an invalid signature and was ignored.' });
    return { accepted: false };
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { accepted: true };
  }
  const reference = event?.data?.reference;
  // A Paystack account has one webhook address, so another site's payments may land here too.
  const known = typeof reference === 'string'
    && await ctx.db.prepare('SELECT 1 FROM payments WHERE reference = ?').get(reference);
  if (event?.event === 'charge.success' && known) {
    // Settled before answering, because a serverless function can freeze once it has responded.
    // If this fails, the regular recheck of pending payments still catches it.
    await settlePayment(ctx, reference).catch((err) => console.error(`Webhook ${reference}:`, err.message));
  }
  return { accepted: true };
}
