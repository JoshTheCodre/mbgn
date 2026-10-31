import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, dateTime, naira, num, plural, useApp, useFetch, useLive } from '../lib.jsx';
import { ErrorNote, Field, Loading, CountUp } from '../ui.jsx';

// Only same-site paths, so a crafted link can't send someone elsewhere after paying.
const safeReturn = (value) => (value && /^\/[^/\\]/.test(value) ? value : '/wallet');

export function AdminLogin() {
  const { setUser } = useApp();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { user } = await api('/auth/login', { body: { email: form.get('email'), password: form.get('password') } });
      setUser(user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap page narrow">
      <h1>Administrators</h1>
      <form className="stack" onSubmit={submit}>
        <Field label="Email"><input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password"><input name="password" type="password" autoComplete="current-password" required /></Field>
        <ErrorNote error={error} />
        <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
      </form>
      <p className="muted form-foot"><Link to="/forgot">Forgot your password?</Link></p>
    </div>
  );
}

export function Forgot() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      await api('/auth/forgot', { body: { email: new FormData(e.currentTarget).get('email') } });
      setSent(true);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="wrap page narrow">
      <h1>Reset the admin password</h1>
      {sent ? <p className="note note-good">If that is an administrator’s email, a reset link is on its way. It works for one hour.</p> : (
        <form className="stack" onSubmit={submit}>
          <Field label="Email"><input name="email" type="email" autoComplete="email" required /></Field>
          <ErrorNote error={error} />
          <button className="btn btn-primary btn-wide">Send reset link</button>
        </form>
      )}
    </div>
  );
}

export function Reset() {
  const { token } = useParams();
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      await api('/auth/reset', { body: { token, password: new FormData(e.currentTarget).get('password') } });
      setDone(true);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="wrap page narrow">
      <h1>Choose a new password</h1>
      {done ? <p className="note note-good">Password changed. <Link to="/admin">Continue</Link></p> : (
        <form className="stack" onSubmit={submit}>
          <Field label="New password" hint="At least 8 characters."><input name="password" type="password" autoComplete="new-password" minLength={8} required /></Field>
          <ErrorNote error={error} />
          <button className="btn btn-primary btn-wide">Save password</button>
        </form>
      )}
    </div>
  );
}

export function Register() {
  const { competition, refreshUser, user } = useApp();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  if (user?.contestant) return <Navigate to="/dashboard" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/contestants/register', { form: new FormData(e.currentTarget) });
      await refreshUser();
      navigate('/dashboard');
    } catch (err) {
      setError(err);
      setTimeout(() => errorRef.current?.scrollIntoView({ block: 'center' }), 0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap page register">
      <header className="register-head">
        <p className="eyebrow">Contestant application</p>
        <h1>Join the contest</h1>
        <p className="muted">Our team reviews every application. Once approved, you get a permanent contestant code, your personal voting link and your dashboard.</p>
      </header>
      <form className="register-form" onSubmit={submit}>
        <fieldset>
          <legend>Your profile photograph</legend>
          <label className="photo-drop">
            {preview ? <img src={preview} alt="Your selected photograph" /> : <span>Add a clear, recent photo of your face</span>}
            <input
              name="photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              onChange={(e) => {
                const file = e.target.files?.[0];
                setPreview(file ? URL.createObjectURL(file) : null);
              }}
            />
          </label>
          <p className="field-hint">JPG, PNG or WebP, up to 5 MB. Only the review team sees it until you are approved.</p>
        </fieldset>
        <fieldset>
          <legend>About you</legend>
          <div className="form-grid">
            <Field label="Full name"><input name="fullName" autoComplete="name" required /></Field>
            <Field label="Contestant / stage name" hint="Shown publicly. Your full name stays private."><input name="stageName" required /></Field>
            <Field label="State">
              <select name="state" required defaultValue="">
                <option value="" disabled>Choose your state</option>
                {(competition?.states ?? []).map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Town or city"><input name="location" required /></Field>
          </div>
          <Field label="Short biography" hint="A few lines supporters will read on your profile.">
            <textarea name="bio" rows={4} minLength={20} maxLength={600} required />
          </Field>
        </fieldset>
        <fieldset>
          <legend>Contact details (private)</legend>
          <div className="form-grid three">
            <Field label="Email address"><input name="email" type="email" autoComplete="email" required /></Field>
            <Field label="Phone number"><input name="phone" type="tel" autoComplete="tel" required /></Field>
            <Field label="WhatsApp number"><input name="whatsapp" type="tel" required /></Field>
          </div>
          <p className="field-hint">Your email and WhatsApp number also bring back your dashboard on a new phone.</p>
        </fieldset>
        <fieldset>
          <legend>Social media</legend>
          <div className="form-grid three">
            <Field label="TikTok"><input name="tiktok" placeholder="@yourname" /></Field>
            <Field label="Instagram"><input name="instagram" placeholder="@yourname" /></Field>
            <Field label="Facebook"><input name="facebook" placeholder="yourname or page link" /></Field>
          </div>
        </fieldset>
        <div ref={errorRef}>
          <ErrorNote error={error} />
          {error?.status === 409 ? <p><Link to="/dashboard">Open your dashboard</Link></p> : null}
        </div>
        <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Sending…' : 'Join the contest'}</button>
      </form>
    </div>
  );
}

// No sign-in: these details create the wallet the first time and bring it back on any device.
function WalletDetails() {
  const { setUser } = useApp();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { user } = await api('/supporters/wallet', { body: { email: form.get('email'), phone: form.get('phone') } });
      setUser(user);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="wrap page narrow">
      <h1>Open your wallet</h1>
      <p className="muted">Already funded a wallet? Enter the email and phone number you used. If you don’t have one yet, it’s set up for you when you fund it while voting.</p>
      <form className="stack" onSubmit={submit}>
        <Field label="Email address"><input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Phone number"><input name="phone" type="tel" autoComplete="tel" required /></Field>
        <ErrorNote error={error} />
        <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Opening…' : 'Open my wallet'}</button>
      </form>
    </div>
  );
}

function WalletView() {
  const { competition, refreshUser, setUser } = useApp();
  const [params] = useSearchParams();
  const need = Number(params.get('need')) || null;
  const returnTo = params.get('return');
  const { data, reload } = useFetch('/wallet');
  const [custom, setCustom] = useState(need ? String(need) : '');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('votes');

  useLive('wallet', () => { reload(); refreshUser().catch(() => {}); });

  async function buy(body, key) {
    setBusy(key);
    setError(null);
    try {
      const started = await api('/wallet/purchases', { body: { ...body, returnTo: safeReturn(returnTo) } });
      window.location.assign(started.checkoutUrl);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  async function forget() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  const customVotes = Number(custom);
  const customValid = Number.isInteger(customVotes) && customVotes > 0;

  return (
    <div className="wrap page wallet">
      <div className="wallet-balance">
        <span className="eyebrow">Your balance</span>
        <p className="wallet-number">{data ? <CountUp value={data.balance} /> : '…'}</p>
        <span>voting credits · 1 credit = 1 vote</span>
      </div>

      <section>
        <h2>Buy voting credits</h2>
        {need ? <p className="note">You need {plural(need, 'more credit')} for that vote. {returnTo ? 'We’ll bring you back afterwards.' : ''}</p> : null}
        <ErrorNote error={error} />
        <ul className="packages">
          {(competition?.packages ?? []).map((p) => (
            <li key={p.id}>
              <button type="button" className="package" disabled={Boolean(busy)} onClick={() => buy({ packageId: p.id }, `p${p.id}`)}>
                <b>{num(p.votes)}</b>
                <span>{p.votes === 1 ? 'vote' : 'votes'}</span>
                <em>{busy === `p${p.id}` ? 'Opening…' : naira(p.price)}</em>
              </button>
            </li>
          ))}
        </ul>
        <form className="custom-buy" onSubmit={(e) => { e.preventDefault(); if (customValid) buy({ votes: customVotes }, 'custom'); }}>
          <Field label="Or choose your own number of votes">
            <input type="number" min="1" step="1" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. 35" />
          </Field>
          <button className="btn btn-primary" disabled={!customValid || Boolean(busy)}>
            {busy === 'custom' ? 'Opening…' : customValid ? `Pay ${naira(customVotes * (competition?.votePrice ?? 0))}` : 'Pay'}
          </button>
        </form>
        <p className="muted small-note">Credits are added only after the payment provider confirms your payment to our server.</p>
      </section>

      <section>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'votes'} className={tab === 'votes' ? 'active' : ''} onClick={() => setTab('votes')}>Votes cast</button>
          <button type="button" role="tab" aria-selected={tab === 'payments'} className={tab === 'payments' ? 'active' : ''} onClick={() => setTab('payments')}>Payments</button>
        </div>
        {!data ? <Loading /> : tab === 'votes' ? (
          data.votes.length === 0 ? <p className="muted empty">You haven’t voted yet. <Link to="/contestants">Find a contestant</Link>.</p> : (
            <ul className="history">
              {data.votes.map((v) => (
                <li key={v.receiptNo}>
                  <span><b>{plural(v.quantity, 'vote')}</b> for <Link to={`/c/${v.code}`}>{v.name}</Link>{v.status === 'void' ? <em className="tag tag-bad">Voided</em> : null}<small>{dateTime(v.createdAt)}</small></span>
                  <Link className="text-link" to={`/receipt/vote/${v.receiptNo}`}>Receipt</Link>
                </li>
              ))}
            </ul>
          )
        ) : (
          data.payments.length === 0 ? <p className="muted empty">No payments yet.</p> : (
            <ul className="history">
              {data.payments.map((p) => (
                <li key={p.reference}>
                  <span><b>{plural(p.credits, 'credit')}</b> for {naira(p.amount)} <em className={`tag tag-${p.status}`}>{p.status}</em><small>{dateTime(p.createdAt)}</small></span>
                  {p.status === 'paid'
                    ? <Link className="text-link" to={`/receipt/payment/${p.reference}`}>Receipt</Link>
                    : p.status === 'pending' ? <Link className="text-link" to={`/pay/return/${p.reference}`}>Check status</Link> : null}
                </li>
              ))}
            </ul>
          )
        )}
        {data ? <p className="muted small-note">Wallet for {data.email}. <button type="button" className="text-link as-button" onClick={forget}>Not you? Use other details</button></p> : null}
      </section>
    </div>
  );
}

export function Wallet() {
  const { user } = useApp();
  if (user === undefined) return <div className="wrap page"><Loading /></div>;
  return user ? <WalletView /> : <WalletDetails />;
}

export function PayReturn() {
  const { reference } = useParams();
  const { refreshUser } = useApp();
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer;
    let tries = 0;
    async function check() {
      try {
        const result = await api(`/payments/${encodeURIComponent(reference)}/verify`, { method: 'POST' });
        if (stop) return;
        setPayment(result);
        setError(null);
        if (result.status === 'paid') refreshUser().catch(() => {});
        if (result.status !== 'pending') return;
      } catch (err) {
        if (stop) return;
        setError(err);
        if (err.status === 404) return;
      }
      tries += 1;
      setAttempts(tries);
      if (tries < 20) timer = setTimeout(check, 4000);
    }
    check();
    return () => { stop = true; clearTimeout(timer); };
  }, [reference, refreshUser]);

  if (!payment) {
    return (
      <div className="wrap page narrow pay-status">
        <h1>Confirming your payment…</h1>
        <ErrorNote error={error} />
      </div>
    );
  }

  const { contestant, status, votesStatus, balance } = payment;
  const back = payment.returnTo ?? (payment.balance === undefined ? '/' : '/wallet');
  const receipt = <p className="form-foot"><Link to={`/receipt/payment/${reference}`}>View receipt</Link></p>;
  return (
    <div className="wrap page narrow pay-status">
      {status === 'paid' && votesStatus === 'counted' ? (
        <>
          <p className="eyebrow">Payment confirmed</p>
          <h1>{plural(payment.votes, 'vote')} counted for {contestant.name}</h1>
          <p className="muted">Now in position {contestant.position} with {num(contestant.totalVotes)} votes.</p>
          {balance > 0 ? <p>You have <b>{plural(balance, 'credit')}</b> left in your wallet.</p> : null}
          <Link to={back} className="btn btn-vote btn-wide">Vote again</Link>
          {receipt}
        </>
      ) : null}
      {status === 'paid' && votesStatus === 'kept' ? (
        <>
          <h1>Your credits are safe</h1>
          <p className="muted">We couldn’t cast your vote for {contestant.name}, so {plural(payment.credits, 'credit')} stayed in your wallet.</p>
          <Link to="/wallet" className="btn btn-primary btn-wide">Open my wallet</Link>
          {receipt}
        </>
      ) : null}
      {status === 'paid' && votesStatus === 'held' ? (
        <>
          <h1>We received your payment</h1>
          <p className="muted">These votes couldn’t be counted because {contestant.name} is no longer in the running or results are final. Our team will refund you.</p>
          {receipt}
        </>
      ) : null}
      {status === 'paid' && !contestant ? (
        <>
          <p className="eyebrow">Payment confirmed</p>
          <h1>{plural(payment.credits, 'credit')} added</h1>
          <p>Your balance is now <b>{plural(balance ?? 0, 'credit')}</b>.</p>
          <Link to={back} className="btn btn-primary btn-wide">Back to my wallet</Link>
          {receipt}
        </>
      ) : null}
      {status === 'pending' ? (
        <>
          <h1>Waiting for confirmation</h1>
          <p className="muted">We haven’t received confirmation of this payment yet. {attempts >= 20 ? 'If you paid, it will go through as soon as the provider confirms, and we’ll email your receipt. You can safely leave this page.' : 'This page checks automatically.'}</p>
          <Link to={back} className="btn btn-ghost btn-wide">Go back</Link>
        </>
      ) : null}
      {status === 'failed' ? (
        <>
          <h1>Payment not completed</h1>
          <p className="muted">Nothing was added or counted for this attempt.</p>
          <Link to={back} className="btn btn-primary btn-wide">Try again</Link>
        </>
      ) : null}
      {status === 'review' ? (
        <>
          <h1>We’re checking this payment</h1>
          <p className="muted">The amount received didn’t match this order, so our team needs to review it. Reference: {reference}.</p>
          <Link to={back} className="btn btn-ghost btn-wide">Go back</Link>
        </>
      ) : null}
    </div>
  );
}

export function PaySim() {
  const { reference } = useParams();
  const navigate = useNavigate();
  const { data, error } = useFetch(`/payments/${encodeURIComponent(reference)}`);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState(null);

  async function pay() {
    setBusy(true);
    try {
      await api(`/simulator/${encodeURIComponent(reference)}/pay`, { method: 'POST' });
      navigate(`/pay/return/${reference}`, { replace: true });
    } catch (err) {
      setPayError(err);
      setBusy(false);
    }
  }

  return (
    <div className="wrap page narrow">
      <p className="eyebrow">Simulated checkout</p>
      <h1>{data ? naira(data.amount) : '…'}</h1>
      <p className="muted">This stands in for Monnify’s checkout while no keys are configured. No real money moves.</p>
      <ErrorNote error={error ?? payError} />
      {data ? <p>{data.mode === 'direct' ? `${plural(data.votes, 'vote')} for ${data.contestant.name}` : plural(data.credits, 'voting credit')}</p> : null}
      <div className="stack">
        <button type="button" className="btn btn-primary btn-wide" disabled={busy || !data} onClick={pay}>Simulate successful payment</button>
        <Link to={`/pay/return/${reference}`} className="btn btn-ghost btn-wide">Leave without paying</Link>
      </div>
    </div>
  );
}

export function Receipt() {
  const { kind, number } = useParams();
  const { data, error } = useFetch(`/receipts/${kind === 'vote' ? 'vote' : 'payment'}/${encodeURIComponent(number)}`);
  if (error) {
    return (
      <div className="wrap page narrow">
        <h1>Receipt not available</h1>
        <ErrorNote error={error} />
        {error.status === 401 ? <Link to="/wallet" className="btn btn-primary">Open my wallet</Link> : null}
      </div>
    );
  }
  if (!data) return <div className="wrap page narrow"><Loading /></div>;
  return (
    <div className="wrap page narrow">
      <article className="receipt">
        <header>
          <span className="logo">MBGN</span>
          <span>{data.kind === 'vote' ? 'Vote receipt' : 'Payment receipt'}</span>
        </header>
        <p className="receipt-number">{data.number}</p>
        <dl>
          <div><dt>Date</dt><dd>{dateTime(data.date)}</dd></div>
          <div><dt>Issued to</dt><dd>{data.customer}</dd></div>
          {data.lines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </article>
      <div className="receipt-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>
        <Link to="/wallet" className="btn btn-ghost">Back to my wallet</Link>
      </div>
    </div>
  );
}
