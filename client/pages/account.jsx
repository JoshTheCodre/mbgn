import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  api, dateTime, naira, num, plural, registrationOpen, useApp, useFetch,
} from '../lib.jsx';
import {
  BrandLogo, ErrorNote, Field, FollowerRow, Loading, PLATFORM_NAMES, WhatsAppGroup,
} from '../ui.jsx';

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

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1200;

// Phone photos can be several megabytes, and every visitor would have to download them.
async function shrinkPhoto(file) {
  try {
    const image = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(image.width, image.height));
    if (scale === 1 && file.size < 400 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file; // The original is still a valid upload if under the limit.
  }
}

function PhotoPicker() {
  const [photo, setPhoto] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  async function choose(e) {
    const input = e.target;
    const chosen = input.files?.[0];
    setDragging(false);
    if (!chosen) {
      setPhoto(null);
      return;
    }
    const file = PHOTO_TYPES.includes(chosen.type) ? await shrinkPhoto(chosen) : chosen;
    const issue = !PHOTO_TYPES.includes(chosen.type) ? 'Please choose a JPG, PNG or WebP image.'
      : file.size > PHOTO_MAX_BYTES ? 'That photo is larger than 5 MB. Please choose a smaller one.' : null;
    setProblem(issue);
    if (issue) {
      input.value = '';
      setPhoto(null);
      return;
    }
    if (file !== chosen) {
      const replacement = new DataTransfer();
      replacement.items.add(file);
      input.files = replacement.files;
    }
    setPhoto({ url: URL.createObjectURL(file), name: chosen.name, size: `${(file.size / (1024 * 1024)).toFixed(1)} MB` });
  }

  return (
    <>
      <label className={`photo-pick ${photo ? 'has-photo' : ''} ${dragging ? 'dragging' : ''}`}>
        <span className="photo-pick-frame">
          {photo ? <img src={photo.url} alt="Your selected photo" /> : (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="8" r="4.2" />
              <path d="M3.8 21c.6-4.6 4-7.2 8.2-7.2s7.6 2.6 8.2 7.2c0 .4-.3.7-.7.7H4.5c-.4 0-.7-.3-.7-.7Z" />
            </svg>
          )}
        </span>
        <span className="photo-pick-text">
          <strong>{photo ? photo.name : 'Add your photo'}</strong>
          <small>{photo ? photo.size : 'A clear, recent photo of your face.'}</small>
          <span className="btn btn-ghost btn-small">{photo ? 'Change photo' : 'Choose photo'}</span>
        </span>
        <input
          name="photo"
          type="file"
          accept={PHOTO_TYPES.join(',')}
          title=" "
          aria-label="Profile photo"
          required
          onChange={choose}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
        />
      </label>
      {problem ? <p className="note note-error" role="alert">{problem}</p> : null}
      <p className="field-hint">JPG, PNG or WebP, up to 5 MB. Only the review team sees it until you are approved.</p>
    </>
  );
}

// Accepts what the form does: @name, name, or a full link.
function accountLabel(value) {
  const parts = value.split(/[?#]/)[0].split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? value;
  return name.startsWith('@') ? name : `@${name}`;
}

const stillness = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Paced so people can follow it, one account at a time. The counts shown are the real answer:
// a row stays on "Counting" for as long as the server takes to reply.
function FollowerCheck({ accounts, response, onFinished }) {
  const [done, setDone] = useState(0);
  const [counting, setCounting] = useState(false);
  const pause = (ms) => (stillness() ? 0 : ms);

  useEffect(() => {
    if (done >= accounts.length) {
      const id = setTimeout(onFinished, pause(1200));
      return () => clearTimeout(id);
    }
    if (!counting) {
      const id = setTimeout(() => setCounting(true), pause(1000));
      return () => clearTimeout(id);
    }
    if (!response) return undefined;
    const id = setTimeout(() => { setDone(done + 1); setCounting(false); }, pause(1100));
    return () => clearTimeout(id);
  }, [done, counting, response]);

  const active = accounts[done];
  const progress = ((done + (counting ? 0.5 : 0)) / accounts.length) * 100;
  return (
    <div className="check-card">
      <div className="spinner" aria-hidden="true" />
      <h1>Checking your followers</h1>
      <p className="muted" role="status">
        {active ? `${counting ? 'Counting followers on' : 'Looking for your account on'} ${PLATFORM_NAMES[active.platform]}…` : 'Getting your result…'}
      </p>
      <div className="check-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <ul className="follower-rows">
        {accounts.map((a, i) => (i < done
          ? <FollowerRow key={a.platform} {...a} minFollowers={response.minFollowers} result={response.results.find((r) => r.platform === a.platform)} />
          : (
            <li key={a.platform} className={`follower-row ${i === done ? 'active' : 'queued'}`}>
              <span className={`follower-logo follower-logo-${a.platform}`}><BrandLogo name={a.platform} /></span>
              <span className="follower-who"><strong>{PLATFORM_NAMES[a.platform]}</strong><small>{a.account}</small></span>
              <span className="follower-count">{i === done ? (counting ? 'Counting…' : 'Looking…') : 'Next'}</span>
            </li>
          )))}
      </ul>
    </div>
  );
}

function CheckResult({ accounts, response, testMode, onRetry }) {
  const { outcome, minFollowers, results, email, whatsappGroup } = response;
  const hasMissing = results.some((r) => r.status === 'missing');
  return (
    <div className={`check-card check-${outcome}`}>
      {outcome === 'passed' ? <div className="check-seal" aria-hidden="true">✓</div> : null}
      <p className="eyebrow">Your result</p>
      <h1>{{ passed: 'Congratulations, you passed!', review: 'Our team will take it from here', failed: 'You are not there yet' }[outcome]}</h1>
      {outcome === 'passed' ? <p className="muted">Your application is now with our review team. We will send more information to <b>{email}</b>.</p> : null}
      {outcome === 'review' ? <p className="muted">We could not finish the check automatically, so our team will look at your accounts and email <b>{email}</b>.</p> : null}
      {outcome === 'failed' ? (
        <p className="muted">
          You need at least <b>{num(minFollowers)}</b> followers on one of your accounts. Your application has not been sent, so you can try again once you get there.
          {hasMissing ? ' If we could not find an account, check the spelling.' : ''}
        </p>
      ) : null}
      <ul className="follower-rows">
        {accounts.map((a) => <FollowerRow key={a.platform} {...a} minFollowers={minFollowers} result={results.find((r) => r.platform === a.platform)} />)}
      </ul>
      {testMode ? <p className="note">Test mode: these follower counts are made up.</p> : null}
      <div className="check-actions">
        {outcome === 'passed' && whatsappGroup ? (
          <div className="check-group">
            <h2>One more step</h2>
            <p className="muted">Join {whatsappGroup.name} on WhatsApp for updates about your batch.</p>
            <WhatsAppGroup group={whatsappGroup} />
          </div>
        ) : null}
        {outcome === 'passed' && !whatsappGroup ? <p className="note">Your WhatsApp group link will be sent to your email soon.</p> : null}
        {outcome === 'failed'
          ? <button type="button" className="btn btn-primary btn-wide" onClick={onRetry}>Change my accounts</button>
          : <Link to="/dashboard" className="btn btn-ghost btn-wide">Go to my dashboard</Link>}
        {outcome === 'failed' ? <Link to="/" className="btn btn-ghost btn-wide">Back to the home page</Link> : null}
      </div>
    </div>
  );
}

export function Register() {
  const { competition, refreshUser, user } = useApp();
  const [error, setError] = useState(null);
  const [step, setStep] = useState('form');
  const [accounts, setAccounts] = useState([]);
  const [response, setResponse] = useState(null);
  const errorRef = useRef(null);

  // Stays here after joining, so the new contestant can see their result.
  if (user?.contestant && !response) return <Navigate to="/dashboard" replace />;
  if (competition?.phase && !registrationOpen(competition) && !response) {
    const voting = competition.phase === 'voting';
    return (
      <div className="wrap page narrow">
        <h1>Registration has closed</h1>
        <p className="muted">{voting ? 'Voting is now open. Find a contestant and support her.' : 'New applications have stopped, and voting opens soon.'}</p>
        <Link to={voting ? '/contestants' : '/'} className="btn btn-primary btn-wide">{voting ? 'Vote now' : 'Back to the home page'}</Link>
        <p className="muted form-foot">Already in the contest? <Link to="/dashboard">Open your dashboard</Link></p>
      </div>
    );
  }

  function showError(err) {
    setError(err);
    setStep('form');
    setTimeout(() => errorRef.current?.scrollIntoView({ block: 'center' }), 0);
  }

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const given = Object.keys(PLATFORM_NAMES)
      .filter((platform) => form.get(platform).trim())
      .map((platform) => ({ platform, account: accountLabel(form.get(platform).trim()) }));
    if (given.length === 0) {
      showError(new Error('Please add at least one of your Instagram, TikTok or Facebook accounts.'));
      return;
    }
    setError(null);
    setResponse(null);
    setAccounts(given);
    setStep('checking');
    window.scrollTo(0, 0);
    try {
      const answer = await api('/contestants/register', { form });
      setResponse(answer);
      if (answer.outcome !== 'failed') await refreshUser();
    } catch (err) {
      showError(err);
    }
  }

  function tryAgain() {
    setResponse(null);
    setStep('form');
    window.scrollTo(0, 0);
  }

  const minFollowers = num(competition?.minFollowers ?? 800);

  return (
    <div className="wrap page register">
      {step === 'checking' ? <FollowerCheck accounts={accounts} response={response} onFinished={() => { setStep('result'); window.scrollTo(0, 0); }} /> : null}
      {step === 'result' ? <CheckResult accounts={accounts} response={response} testMode={competition?.followerCheckIsTest} onRetry={tryAgain} /> : null}
      {/* Stays in the page during the check, so nothing is lost if they need to change an account. */}
      <div hidden={step !== 'form'}>
      <header className="register-head">
        <p className="eyebrow">Contestant application</p>
        <h1>Join the contest</h1>
        <p className="muted">You need at least {minFollowers} followers on Instagram, TikTok or Facebook. One account is enough, and we check it as soon as you send this form.</p>
      </header>
      <form className="register-form" onSubmit={submit}>
        <fieldset>
          <legend>Your social media</legend>
          <p className="field-hint">Add every account you have. At least one needs {minFollowers} followers.</p>
          <div className="form-grid three">
            <Field label="Instagram"><input name="instagram" placeholder="@yourname" /></Field>
            <Field label="TikTok"><input name="tiktok" placeholder="@yourname" /></Field>
            <Field label="Facebook"><input name="facebook" placeholder="yourname or page link" /></Field>
          </div>
          {competition?.followerCheckIsTest ? <p className="note">Test mode: follower counts are made up. A username ending in _ and a number has that many followers, so @ada_500 does not pass and @ada_1200 does.</p> : null}
        </fieldset>
        <fieldset>
          <legend>Profile photo</legend>
          <PhotoPicker />
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
        <div ref={errorRef}>
          <ErrorNote error={error} />
          {error?.status === 409 ? <p><Link to="/dashboard">Open your dashboard</Link></p> : null}
        </div>
        <button className="btn btn-primary btn-wide">Check my followers and join</button>
      </form>
      </div>
    </div>
  );
}

// Voting never asks for an email, so this is how a supporter can keep a copy.
function EmailReceipt({ reference }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/payments/${encodeURIComponent(reference)}/receipt-email`, { body: { email: new FormData(e.currentTarget).get('email') } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <p className="note note-good" role="status">Your receipt is on its way.</p>;
  return (
    <form className="stack email-receipt" onSubmit={submit}>
      <Field label="Email me this receipt" hint="Optional. Only used to send this receipt.">
        <input name="email" type="email" autoComplete="email" required />
      </Field>
      <ErrorNote error={error} />
      <button className="btn btn-ghost btn-wide" disabled={busy}>{busy ? 'Sending…' : 'Send receipt'}</button>
    </form>
  );
}

export function PayReturn() {
  const { reference } = useParams();
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const [params] = useSearchParams();
  // Only changes the wording and stops the checking. What counts is still what the provider says.
  const cancelled = params.get('cancelled') === '1';

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
        if (result.status !== 'pending' || cancelled) return;
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
  }, [reference, cancelled]);

  if (!payment) {
    return (
      <div className="wrap page narrow pay-status">
        {error ? null : <span className="spinner" aria-hidden="true" />}
        <h1>Confirming your payment…</h1>
        {error ? null : <p className="muted">This usually takes a few seconds. Please keep this page open.</p>}
        <ErrorNote error={error} />
      </div>
    );
  }

  const { contestant, status, votesStatus } = payment;
  const back = payment.returnTo ?? '/';
  const receipt = (
    <>
      <p className="form-foot"><Link to="/">Back to home</Link> · <Link to={`/receipt/payment/${reference}`}>View receipt</Link></p>
      {payment.emailed ? null : <EmailReceipt reference={reference} />}
    </>
  );
  return (
    <div className="wrap page narrow pay-status">
      {status === 'paid' && votesStatus === 'counted' ? (
        <>
          <p className="eyebrow">Payment confirmed</p>
          <h1>{plural(payment.votes, 'vote')} counted for {contestant.name}</h1>
          <p className="muted">Now in position {contestant.position} with {num(contestant.totalVotes)} votes.</p>
          <div className="pay-actions">
            <Link to={back} className="btn btn-vote btn-wide">Vote again</Link>
            <Link to="/leaderboard" className="btn btn-ghost btn-wide">See the leaderboard</Link>
          </div>
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
      {status === 'pending' && cancelled ? (
        <>
          <h1>Payment cancelled</h1>
          <p className="muted">You weren’t charged, and no votes were counted.</p>
          <Link to={back} className="btn btn-primary btn-wide">Try again</Link>
        </>
      ) : null}
      {status === 'pending' && !cancelled ? (
        <>
          {attempts < 20 ? <span className="spinner" aria-hidden="true" /> : null}
          <h1>Waiting for confirmation</h1>
          <p className="muted">We haven’t received confirmation of this payment yet. {attempts >= 20 ? 'If you paid, your votes will count as soon as the provider confirms. You can safely leave this page.' : 'This page checks automatically.'}</p>
          <Link to={back} className="btn btn-ghost btn-wide">Go back</Link>
        </>
      ) : null}
      {status === 'failed' ? (
        <>
          <h1>Payment not completed</h1>
          <p className="muted">Nothing was counted for this attempt.</p>
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
      <p className="muted">This stands in for Paystack’s checkout while no key is configured. No real money moves.</p>
      <ErrorNote error={error ?? payError} />
      {data ? <p>{plural(data.votes, 'vote')} for {data.contestant.name}</p> : null}
      <div className="stack">
        <button type="button" className="btn btn-primary btn-wide" disabled={busy || !data} onClick={pay}>Simulate successful payment</button>
        <Link to={`/pay/return/${reference}?cancelled=1`} className="btn btn-ghost btn-wide">Leave without paying</Link>
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
          {data.customer ? <div><dt>Issued to</dt><dd>{data.customer}</dd></div> : null}
          {data.lines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      </article>
      <div className="receipt-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>
        <Link to="/" className="btn btn-ghost">Back to the site</Link>
      </div>
    </div>
  );
}
