import crypto from 'node:crypto';
import { HttpError, hashIp } from './auth.js';
import { photoUrl, raiseFlag, votingState } from './competition.js';
import { getSetting, nowIso, tx } from './db.js';
import { recordPaidVotes } from './votes.js';
import { bulkPrice, paymentCharges } from '../shared/pricing.js';
import { formatCount, formatMoney, roundMoney } from '../shared/countries.js';

// Paystack takes amounts in kobo (Nigeria) or pesewas (Ghana): a hundredth of the currency.
const minorUnits = (amount) => Math.round(Number(amount) * 100);

export const MAX_VOTES_PER_PAYMENT = 100000;

// ---- Providers. Each exposes init() and query(); query() is the only thing that can get votes counted. ----

export function createPaystack(config) {
  const { secretKey, baseUrl } = config.paystack;
  // Each country's site has its own Paystack account, in its own currency.
  const currency = config.country?.currency ?? 'NGN';
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
    // Paystack's checkout page. `channels` limits it to the way the supporter chose to pay.
    async init({ reference, amount, description, customerEmail, redirectUrl, channels }) {
      const data = await call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email: customerEmail,
          amount: minorUnits(amount),
          currency,
          reference,
          callback_url: redirectUrl,
          ...(channels ? { channels } : {}),
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
    // Pay with Transfer: Paystack opens a bank account for this one payment, and our own page
    // shows it. The money is confirmed the same way as any other payment.
    async chargeTransfer({ reference, amount, description, customerEmail, expiresAt }) {
      const data = await call('/charge', {
        method: 'POST',
        body: JSON.stringify({
          email: customerEmail,
          amount: minorUnits(amount),
          reference,
          bank_transfer: { account_expires_at: expiresAt },
          metadata: { custom_fields: [{ display_name: 'Order', variable_name: 'order', value: description }] },
        }),
      });
      if (!data?.account_number) throw new Error(`Paystack gave no account to pay into (${data?.status ?? 'no status'}).`);
      if (data.reference && data.reference !== reference) throw new Error('Paystack returned a different payment reference.');
      const expiry = Date.parse(data.account_expires_at);
      return {
        accountNumber: String(data.account_number),
        accountName: data.account_name ?? null,
        bankName: data.bank?.name ?? null,
        expiresAt: Number.isNaN(expiry) ? expiresAt : new Date(expiry).toISOString(),
      };
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
export function createSimulator(db, currency = 'NGN') {
  return {
    name: 'simulator',
    async init({ reference, amount }) {
      await db.prepare('INSERT INTO simulated_provider (reference, amount) VALUES (?, ?)').run(reference, amount);
      return { checkoutUrl: `/pay/sim/${reference}`, providerRef: `SIM-${reference}` };
    },
    async chargeTransfer({ reference, amount, expiresAt }) {
      await db.prepare('INSERT INTO simulated_provider (reference, amount) VALUES (?, ?)').run(reference, amount);
      const accountNumber = String(crypto.createHash('sha256').update(reference).digest().readUInt32BE(0)).padStart(10, '0');
      return { accountNumber, accountName: 'MBGN TEST', bankName: 'Test bank, no real money', expiresAt };
    },
    async query(reference) {
      const row = await db.prepare('SELECT * FROM simulated_provider WHERE reference = ?').get(reference);
      if (!row) throw new Error('Unknown simulated payment.');
      return {
        reference,
        status: row.paid_at ? 'PAID' : 'PENDING',
        amountPaid: row.paid_at ? Number(row.amount) : 0,
        currency,
        method: 'SIMULATED',
        providerRef: `SIM-${reference}`,
      };
    },
    signatureValid: () => false,
  };
}

// ---- Starting a payment ----

// Bulk deals apply to every amount from their size upwards. See shared/pricing.js.
export async function priceFor(db, votes) {
  if (!Number.isInteger(votes) || votes < 1 || votes > MAX_VOTES_PER_PAYMENT) {
    throw new HttpError(400, `Enter between 1 and ${formatCount(MAX_VOTES_PER_PAYMENT)} votes.`);
  }
  const packages = await db.prepare('SELECT votes, price FROM packages WHERE active = 1').all();
  return bulkPrice(votes, Number(await getSetting(db, 'vote_price')), packages);
}

// Paystack requires a customer email, and supporters aren't asked for one.
function checkoutEmail(config, reference) {
  const [name, domain] = config.paymentEmail.split('@');
  return `${name}+${reference.toLowerCase()}@${domain}`;
}

// How votes are paid in each country, and the Paystack checkout channels each way opens.
// - Nigeria: bank transfer only. The account number shows on our own page; if Paystack can't open
//   one, its checkout is the fallback, limited to bank transfer, never card.
// - Ghana: Mobile Money (MTN MoMo, Telecel Cash, AirtelTigo Money) on Paystack Ghana's checkout,
//   which asks for the network and number and sends the approval prompt to the phone.
export const PAY_METHODS = { transfer: ['bank_transfer'], momo: ['mobile_money'] };
// Ways that were offered before (card, OPay, "any"). A page still open from then asks for these;
// it pays the country's own way instead of failing.
const RETIRED_METHODS = new Set(['any', 'card', 'opay']);
const TRANSFER_MINUTES = 60;

// Long and random: holding this reference is what lets someone see the payment and its receipt.
const newReference = () => `MBG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

// The votes count as soon as the provider confirms the payment.
export async function startPayment(ctx, { code, quantity, voterName, method: asked, email = null, viaLink, ip }) {
  const { db, config, provider } = ctx;
  const own = config.country?.payMethod ?? 'transfer';
  const name = typeof voterName === 'string' ? voterName.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  if (name.length < 2) throw new HttpError(400, 'Please enter your name. It goes on your proof of vote.');
  // Before its live Paystack key is in, a newer country's site takes no payments at all.
  if (config.paymentsOff) throw new HttpError(409, config.paymentsOff);
  const method = asked == null || RETIRED_METHODS.has(asked) ? own : asked;
  if (method !== own) throw new HttpError(400, `Votes are paid ${config.country?.payLabel ?? 'by transfer'}.`);
  const state = await votingState(db);
  if (!state.open) throw new HttpError(409, state.message);
  const contestant = await db.prepare("SELECT id, code FROM contestants WHERE code = ? AND status = 'approved'").get(code);
  if (!contestant) throw new HttpError(404, 'No active contestant has that code.');
  const amount = await priceFor(db, quantity);
  // The voter pays the charges, so the votes' whole amount arrives.
  const fee = paymentCharges(amount, config.countryId);
  const total = roundMoney(amount + fee, config.country?.decimals ?? 0);

  let reference = newReference();

  const ipHash = hashIp(config, ip);
  const { lastInsertRowid: paymentId } = await db.prepare(`
    INSERT INTO payments (reference, email, voter_name, vote_contestant_id, vote_quantity, via_link, ip_hash, amount, fee, provider, return_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .run(reference, email, name, contestant.id, quantity, viaLink ? 1 : 0, ipHash, amount, fee, provider.name, `/c/${contestant.code}`, nowIso());

  const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
  const attempts = (await db.prepare(`SELECT COUNT(*) AS n FROM payments
    WHERE ip_hash = ? AND status = 'pending' AND created_at >= ?`).get(ipHash, tenMinutesAgo)).n;
  if (attempts >= 20) {
    await raiseFlag(ctx, { kind: 'repeated_checkouts', severity: 'low', details: `${attempts} unfinished checkouts in 10 minutes from one network.` });
  }

  const description = `${quantity} MBGN vote${quantity === 1 ? '' : 's'} for ${contestant.code}`;
  if (method === 'transfer' && provider.chargeTransfer) {
    try {
      const expiresAt = new Date(Date.now() + TRANSFER_MINUTES * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const transfer = await provider.chargeTransfer({ reference, amount: total, description, customerEmail: checkoutEmail(config, reference), expiresAt });
      await db.prepare('UPDATE payments SET transfer_details = ? WHERE id = ?').run(JSON.stringify(transfer), paymentId);
      return { reference, transfer, votes: quantity, amount, fee, total };
    } catch (err) {
      // Pay with Transfer is switched off on the Paystack account, or Paystack had a moment. Its own
      // checkout can still take the transfer. Paystack keeps the failed attempt's reference, so a new one.
      console.error('Could not open a transfer account, sending to checkout instead:', err.message);
      reference = newReference();
      await db.prepare('UPDATE payments SET reference = ? WHERE id = ?').run(reference, paymentId);
    }
  }

  try {
    const { checkoutUrl, providerRef } = await provider.init({
      reference,
      amount: total,
      description,
      customerEmail: checkoutEmail(config, reference),
      redirectUrl: `${config.publicUrl}/pay/return/${reference}`,
      channels: PAY_METHODS[method],
    });
    await db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(providerRef ?? null, paymentId);
    return { reference, checkoutUrl, votes: quantity, amount, fee, total };
  } catch (err) {
    console.error('Could not start payment:', err.message);
    await db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
    throw new HttpError(502, 'The payment provider could not start this payment. Please try again.');
  }
}

// What anyone holding the reference may see.
export async function paymentView(db, payment) {
  const contestant = await db.prepare('SELECT code, stage_name, status, total_votes, position, photo_file FROM contestants WHERE id = ?').get(payment.vote_contestant_id);
  const receipt = payment.status === 'paid'
    ? await db.prepare('SELECT receipt_no FROM votes WHERE payment_id = ?').get(payment.id)
    : null;
  return {
    reference: payment.reference,
    voterName: payment.voter_name,
    receiptNo: receipt?.receipt_no ?? null,
    amount: payment.amount,
    fee: payment.fee ?? 0,
    // Rounded to the pesewa, so cedis add up without floating-point leftovers.
    total: roundMoney(Number(payment.amount) + Number(payment.fee ?? 0), 2),
    status: payment.status,
    votes: payment.vote_quantity,
    votesStatus: payment.votes_status,
    provider: payment.provider,
    method: payment.payment_method,
    createdAt: payment.created_at,
    paidAt: payment.paid_at,
    returnTo: payment.return_to,
    emailed: Boolean(payment.email),
    // The account to pay into, while it is still waiting for the money.
    transfer: payment.status === 'pending' && payment.transfer_details ? JSON.parse(payment.transfer_details) : null,
    contestant: {
      code: contestant.code,
      name: contestant.stage_name,
      totalVotes: contestant.status === 'approved' ? contestant.total_votes : null,
      position: contestant.position,
      photoUrl: contestant.status === 'approved' ? photoUrl(contestant) : null,
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
    // The votes and the charges on them, all of it.
    const expected = Number(payment.amount) + Number(payment.fee ?? 0);
    const currency = ctx.config.country?.currency ?? 'NGN';
    if (result.currency !== currency || !(minorUnits(result.amountPaid) >= minorUnits(expected))) {
      await tx(db, async () => {
        await db.prepare("UPDATE payments SET status = 'review', paid_amount = ? WHERE id = ?").run(result.amountPaid, payment.id);
        await raiseFlag(ctx, {
          kind: 'payment_mismatch',
          severity: 'high',
          details: `${reference}: expected ${currency} ${expected}, provider reports ${result.currency} ${result.amountPaid}. No votes counted.`,
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

export const IN_PERSON_METHODS = ['Cash', 'Bank transfer', 'POS', 'Other'];

// Votes bought from an admin in person. They become an ordinary paid payment, so they count, show
// in revenue and reports, and get a receipt and a proof of vote, just like a payment through Paystack.
export async function recordInPersonSale(ctx, { code, quantity, amount, method, voterName, email, note, adminId }) {
  const { db, config } = ctx;
  const decimals = config.country?.decimals ?? 0;
  const name = typeof voterName === 'string' ? voterName.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  const address = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : '';
  const reference = typeof note === 'string' ? note.trim().slice(0, 100) : '';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_VOTES_PER_PAYMENT) throw new HttpError(400, 'Enter a whole number of votes.');
  // Charged at the normal price, bulk deals included, unless a different amount was agreed.
  if (amount === undefined || amount === null || Number.isNaN(amount)) amount = await priceFor(db, quantity);
  if (!(amount > 0) || roundMoney(amount, decimals) !== amount) {
    throw new HttpError(400, decimals ? 'Enter the amount received, up to 2 decimal places.' : 'Enter the amount received, in whole naira.');
  }
  if (!IN_PERSON_METHODS.includes(method)) throw new HttpError(400, 'Choose how they paid.');
  if (name.length < 2) throw new HttpError(400, 'Enter the voter’s name. It goes on their proof of vote.');
  if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, 'That email address does not look right.');
  const state = await votingState(db);
  if (!state.open) throw new HttpError(409, `${state.message} Votes can only be sold while voting is open.`);
  const contestant = await db.prepare("SELECT id, code FROM contestants WHERE code = ? AND status = 'approved'").get(code);
  if (!contestant) throw new HttpError(404, 'No active contestant has that code.');

  const paymentRef = `MBG-INP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const { lastInsertRowid: id } = await db.prepare(`INSERT INTO payments (reference, email, voter_name, vote_contestant_id, vote_quantity, amount,
    provider, provider_ref, recorded_by, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?, 'in_person', ?, ?, ?, ?) RETURNING id`)
    .run(paymentRef, address || null, name, contestant.id, quantity, amount, reference || null, adminId, `/c/${contestant.code}`, nowIso());
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  const outcome = await recordPaidVotes(ctx, payment, { amountPaid: amount, method: `In person: ${method}`, providerRef: reference || null });
  await db.prepare('INSERT INTO audit_log (actor_id, action, details, created_at) VALUES (?, ?, ?, ?)')
    .run(adminId, 'votes.in_person', `${contestant.code}: ${quantity} votes for ${config.country?.currency ?? 'NGN'} ${amount} by ${method}, from ${name}${reference ? ` (${reference})` : ''}`, nowIso());
  if (outcome && address) await sendPaymentEmail(ctx, payment, outcome);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function sendPaymentEmail(ctx, payment, { held, contestant }) {
  const link = `${ctx.config.publicUrl}/receipt/payment/${payment.reference}`;
  const naira = formatMoney(payment.amount, ctx.config.countryId, { code: true });
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
