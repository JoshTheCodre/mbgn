import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ago, dateTime, num, plural, shortDate, useApp, useFetch, useLive } from '../lib.jsx';
import {
  CodeTag, Countdown, ErrorNote, Field, LoadFailed, Loading, Movement, PinInput, Portrait, CountUp, PushToggle, ShareButtons, Timer, WhatsAppGroup,
} from '../ui.jsx';

const PUSH_WHAT = 'You’ll hear when you get votes, are approved, and other news.';
const HomeLink = () => <Link to="/" className="home-link">← Home</Link>;
import { BioField, PhotoPicker } from './account.jsx';

function DailyVotes({ daily }) {
  const [active, setActive] = useState(null);
  const max = Math.max(1, ...daily.map((d) => d.votes));
  const W = 560;
  const H = 180;
  const base = H - 22;
  const slot = W / daily.length;
  const bar = Math.max(8, slot - 6);
  const shown = active ?? daily[daily.length - 1];

  return (
    <figure className="chart">
      <figcaption>
        <strong>{num(shown.votes)}</strong> votes on {shortDate(shown.day)}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Votes received per day over the last 14 days" onMouseLeave={() => setActive(null)}>
        <line x1="0" x2={W} y1={base} y2={base} className="chart-axis" />
        {daily.map((d, i) => {
          const height = d.votes === 0 ? 0 : Math.max(3, (d.votes / max) * (base - 8));
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setActive(d)} onClick={() => setActive(d)}>
              <rect x={i * slot} y="0" width={slot} height={H} fill="transparent" />
              <path
                className={`chart-bar ${active?.day === d.day ? 'on' : ''}`}
                d={height === 0 ? '' : `M${x},${base} v${-(height - 4)} q0,-4 4,-4 h${bar - 8} q4,0 4,4 v${height - 4} z`}
              />
              {i === 0 || i === daily.length - 1 ? (
                <text x={i === 0 ? x : x + bar} y={H - 6} textAnchor={i === 0 ? 'start' : 'end'} className="chart-label">{shortDate(d.day)}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details className="chart-table">
        <summary>View as a table</summary>
        <table>
          <thead><tr><th scope="col">Day</th><th scope="col">Votes</th></tr></thead>
          <tbody>{daily.map((d) => <tr key={d.day}><td>{shortDate(d.day)}</td><td>{num(d.votes)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

function Notifications({ items, onRead }) {
  const unread = items.filter((n) => !n.read).length;
  return (
    <section className="panel">
      <div className="section-head">
        <h2>Notifications{unread ? <span className="badge">{unread}</span> : null}</h2>
        {unread ? <button type="button" className="text-link as-button" onClick={onRead}>Mark all read</button> : null}
      </div>
      {items.length === 0 ? <p className="muted">Your vote alerts will appear here. Only you can see them.</p> : (
        <ul className="notifications">
          {items.map((n) => (
            <li key={n.id} className={n.read ? '' : 'unread'}>
              <span>{n.message}</span>
              <time dateTime={n.createdAt}>{ago(n.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupPanel({ data }) {
  if (data.whatsappGroup) {
    return (
      <section className="panel group-panel">
        <h2>Your WhatsApp group</h2>
        <p className="muted">{data.whatsappGroup.joined
          ? `You’re in ${data.whatsappGroup.name}. Open the chat for updates about your batch.`
          : `Join ${data.whatsappGroup.name} for updates about your batch. This is your only group.`}</p>
        <WhatsAppGroup group={data.whatsappGroup} />
      </section>
    );
  }
  if (data.status === 'approved') {
    return <p className="note">Your WhatsApp group link will be sent to you on WhatsApp soon.</p>;
  }
  return null;
}

function NotYetLive({ data, onRead, onSaved }) {
  const copy = {
    pending: [
      data.verification === 'passed' ? 'You passed the follower check' : 'Your application is being reviewed',
      `${{ review: 'We couldn’t finish checking your followers automatically, so our team is looking at your accounts. ', failed: 'Your accounts are below our follower minimum, so our team will decide on your application. ' }[data.verification] ?? ''}Once you're approved, we'll message you on WhatsApp, and your contestant code and voting link appear here.`,
    ],
    rejected: ['Your application was not approved', data.statusReason ?? ''],
    suspended: ['Your profile is suspended', data.statusReason ?? ''],
    disqualified: ['You have been disqualified', data.statusReason ?? ''],
    eliminated: ['You have been eliminated', `${data.statusReason ?? ''} Thank you for taking part.`.trim()],
  }[data.status];
  return (
    <div className="wrap page narrow-wide">
      <HomeLink />
      <PushToggle what={PUSH_WHAT} />
      <div className="waiting">
        <div className="dash-avatar"><Portrait name={data.name} photoUrl={data.photoUrl} code={data.code ?? data.name} /></div>
        <div>
          <p className="eyebrow">Hello, {data.name}</p>
          <h1>{copy[0]}</h1>
          {copy[1] ? <p className="muted">{copy[1]}</p> : null}
          {data.code ? <p>Your code <b>{data.code}</b> stays reserved for you.</p> : null}
        </div>
      </div>
      {data.profile.hasPin ? null : <PinPanel data={data} />}
      <GroupPanel data={data} />
      <ProfilePanel data={data} onSaved={onSaved} />
      {data.profile.hasPin ? <PinPanel data={data} /> : null}
      <Notifications items={data.notifications} onRead={onRead} />
    </div>
  );
}

// A contestant's browser is recognised from the moment they join. On any other phone, their
// phone number and PIN open the dashboard.
function ContestantLogin() {
  const { setUser } = useApp();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(path, body) {
    setBusy(true);
    setError(null);
    try {
      const { user } = await api(path, { body });
      setUser(user);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="wrap page narrow">
      <p className="eyebrow">Contestants</p>
      <h1>Log in to your dashboard</h1>
      <p className="muted">Use the phone or WhatsApp number you joined with, and your 4-digit PIN.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); submit('/contestants/login', { phone: f.get('phone'), pin: f.get('pin') }); }}>
        <Field label="Phone or WhatsApp number"><input name="phone" type="tel" autoComplete="tel" required /></Field>
        <Field label="PIN"><PinInput name="pin" autoComplete="current-password" required /></Field>
        <ErrorNote error={error} />
        <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      <details className="no-pin">
        <summary>No PIN yet, or the organisers reset yours?</summary>
        <p className="muted">Enter the email and WhatsApp number you joined with. You will be asked to choose a PIN straight away.</p>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); submit('/contestants/recognise', { email: f.get('email'), whatsapp: f.get('whatsapp') }); }}>
          <Field label="Email address"><input name="email" type="email" autoComplete="email" required /></Field>
          <Field label="WhatsApp number"><input name="whatsapp" type="tel" required /></Field>
          <button className="btn btn-ghost btn-wide" disabled={busy}>Open my dashboard</button>
        </form>
      </details>
      <p className="muted form-foot">Forgot your PIN? Ask the organisers to reset it. Not in yet? <Link to="/register">Join the contest</Link></p>
    </div>
  );
}

// Everything they registered with. A new public name or photo waits for the organisers once approved.
function ProfilePanel({ data, onSaved }) {
  const { competition } = useApp();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const p = data.profile;
  const approved = !['pending', 'rejected'].includes(data.status);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { waiting } = await api('/me/profile', { method: 'PUT', form: new FormData(e.currentTarget) });
      setSaved(waiting ? 'Saved. Your new name or photo will show once the organisers approve it.' : 'Saved.');
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const socials = [['Instagram', p.instagram], ['TikTok', p.tiktok], ['Facebook', p.facebook]].filter(([, link]) => link);
  return (
    <section className="panel profile-panel">
      <div className="section-head">
        <h2>Your registration</h2>
        {!editing ? <button type="button" className="btn btn-ghost btn-small" onClick={() => { setEditing(true); setSaved(null); }}>Edit</button> : null}
      </div>
      {saved ? <p className="note note-good">{saved}</p> : null}
      {p.pendingStageName || p.pendingPhotoUrl ? (
        <p className="note">Waiting for the organisers: {[p.pendingStageName ? `new name “${p.pendingStageName}”` : null, p.pendingPhotoUrl ? 'new photo' : null].filter(Boolean).join(' and ')}.</p>
      ) : null}
      {editing ? (
        <form className="stack" onSubmit={save}>
          <PhotoPicker required={false} current={p.pendingPhotoUrl ?? data.photoUrl} hint={approved ? 'A new photo shows once the organisers approve it.' : 'JPG, PNG or WebP, up to 5 MB.'} />
          <div className="form-grid">
            <Field label="Contestant / stage name" hint={approved ? 'A new name shows once the organisers approve it.' : 'Shown publicly.'}><input name="stageName" defaultValue={p.pendingStageName ?? p.stageName} required /></Field>
            <Field label="Full name"><input name="fullName" defaultValue={p.fullName} autoComplete="name" required /></Field>
            <Field label="State">
              <select name="state" defaultValue={p.state} required>
                {(competition?.states ?? [p.state]).map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Town or city"><input name="location" defaultValue={p.location} required /></Field>
            <Field label="Email address"><input name="email" type="email" defaultValue={p.email} autoComplete="email" required /></Field>
            <Field label="Phone number"><input name="phone" type="tel" defaultValue={p.phone} autoComplete="tel" required /></Field>
            <Field label="WhatsApp number" hint="You log in with this number."><input name="whatsapp" type="tel" defaultValue={p.whatsapp} required /></Field>
          </div>
          <BioField defaultValue={p.bio} />
          <ErrorNote error={error} />
          <div className="admin-actions">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <dl className="profile-list">
          <div><dt>Stage name</dt><dd>{p.stageName}</dd></div>
          <div><dt>Full name</dt><dd>{p.fullName}</dd></div>
          <div><dt>Where</dt><dd>{p.location}, {p.state}</dd></div>
          <div><dt>Email</dt><dd>{p.email}</dd></div>
          <div><dt>Phone</dt><dd>{p.phone}</dd></div>
          <div><dt>WhatsApp</dt><dd>{p.whatsapp}</dd></div>
          <div className="wide"><dt>Biography</dt><dd>{p.bio}</dd></div>
        </dl>
      )}
      <p className="muted small-note">
        Social accounts: {socials.length ? socials.map(([label, link], i) => <span key={label}>{i ? ' · ' : ''}<a href={link} target="_blank" rel="noreferrer noopener">{label}</a></span>) : 'none'}.
        {' '}These were used for your follower check, so ask the organisers to change them.
      </p>
    </section>
  );
}

function PinPanel({ data }) {
  const { setUser } = useApp();
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const has = data.profile.hasPin;

  async function save(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setSaved(false);
    if (f.get('pin') !== f.get('pinAgain')) {
      setError(new Error('The two PINs do not match.'));
      return;
    }
    setBusy(true);
    try {
      await api('/me/pin', { method: 'PUT', body: { currentPin: f.get('currentPin') ?? '', pin: f.get('pin') } });
      setSaved(true);
      form.reset();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  return (
    <section className={`panel pin-panel ${has ? '' : 'needs-pin'}`}>
      <h2>{has ? 'Your PIN' : 'Choose your PIN'}</h2>
      <p className="muted">{has
        ? 'Your phone or WhatsApp number and this PIN open your dashboard on any phone. Changing it signs out your other phones.'
        : 'You have no PIN yet. Choose one now, so you can log in on any phone with your phone number and PIN.'}</p>
      <form className="inline-form" onSubmit={save}>
        {has ? <Field label="Current PIN"><PinInput name="currentPin" autoComplete="current-password" required /></Field> : null}
        <Field label="New PIN"><PinInput name="pin" autoComplete="new-password" required /></Field>
        <Field label="New PIN again"><PinInput name="pinAgain" autoComplete="new-password" required /></Field>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : has ? 'Change PIN' : 'Save PIN'}</button>
      </form>
      <ErrorNote error={error} />
      {saved ? <p className="note note-good">Your PIN is saved.</p> : null}
      <p className="small-note"><button type="button" className="text-link as-button" onClick={logout}>Log out of this phone</button></p>
    </section>
  );
}

// Where they stand in the round that is on now.
function RoundPanel({ data }) {
  const r = data.round;
  if (!r) return data.onProbation ? <p className="note note-error">You are on probation. If you miss the next round’s target you will be eliminated.</p> : null;
  const rules = [r.keepTop ? `the top ${num(r.keepTop)} stay` : null, r.minVotes ? `you need ${num(r.minVotes)} votes${r.votesCounted === 'round' ? ' in this round' : ' in total'}` : null].filter(Boolean).join(', and ');
  return (
    <section className={`panel round-panel ${r.safe ? 'safe' : 'at-risk'}`}>
      <p className="eyebrow">{r.name}</p>
      <h2>{r.safe ? 'You are safe right now' : 'You are at risk of elimination'}</h2>
      <p className="muted">When this round ends, {rules}.{r.probation ? ` The next ${num(r.probation)} below the cut go on probation instead of out.` : ''}</p>
      {r.minVotes ? <p>Your votes {r.votesCounted === 'round' ? 'this round' : 'so far'}: <b>{num(r.votes)}</b> of {num(r.minVotes)}</p> : null}
      {data.onProbation ? <p className="note note-error">You are on probation: miss this round’s target and you will be eliminated.</p> : null}
      <Timer target={r.endsAt} label={`${r.name} ends in`} compact />
    </section>
  );
}

export function Dashboard() {
  const { competition, user } = useApp();
  const { data, error, reload } = useFetch(user?.contestant ? '/me/dashboard' : null);
  useLive('notification', reload);
  useLive('leaderboard', reload);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  async function markRead() {
    await api('/me/notifications/read', { method: 'POST' }).catch(() => {});
    reload();
  }

  if (user === undefined) return <div className="wrap page"><Loading /></div>;
  if (!user || !user.contestant) return <ContestantLogin />;
  if (error && !data) return <div className="wrap page"><LoadFailed error={error} onRetry={reload} what="your dashboard" /></div>;
  if (!data) return <div className="wrap page"><Loading /></div>;
  if (data.status !== 'approved') return <NotYetLive data={data} onRead={markRead} onSaved={reload} />;

  const { stats } = data;
  return (
    <div className="wrap page dashboard">
      <HomeLink />
      <PushToggle what={PUSH_WHAT} />
      <header className="dash-hero">
        {data.photoUrl ? <img className="dash-backdrop" src={data.photoUrl} alt="" aria-hidden="true" /> : null}
        <div className="dash-avatar">
          <Portrait name={data.name} photoUrl={data.photoUrl} code={data.code} />
        </div>
        <h1>{data.name}</h1>
        <CodeTag code={data.code} inline />
        <div className="dash-rank">
          <span className="dash-rank-number"><CountUp value={data.position} /></span>
          <span>
            <b>Current position</b>
            <small>{data.previousPosition ? `Previously ${data.previousPosition}` : 'Your first ranking'}</small>
            <Movement value={data.movement24h} />
          </span>
        </div>
        <Countdown competition={competition} compact />
      </header>

      {data.profile.hasPin ? null : <PinPanel data={data} />}
      <RoundPanel data={data} />

      <dl className="tiles">
        <div><dt>Total votes</dt><dd><CountUp value={data.totalVotes} /></dd></div>
        <div><dt>New votes (24 hrs)</dt><dd><CountUp value={data.newVotes} /></dd></div>
        <div><dt>{data.position === 1 ? 'You are in the lead' : 'Votes to climb one place'}</dt><dd>{data.position === 1 ? '★' : num(stats.votesToNextPosition)}</dd></div>
        <div><dt>Share of all votes</dt><dd>{(stats.shareOfVotes * 100).toFixed(1)}%</dd></div>
      </dl>

      <section className="panel share-panel">
        <h2>Your voting link</h2>
        <p className="link-box"><code>{data.votingLink}</code></p>
        <p className="muted">Your permanent code is <b>{data.code}</b>. Supporters can type it into the site to find you.</p>
        <ShareButtons url={data.votingLink} name={data.name} />
        <p className="muted small-note">{plural(stats.linkVisits, 'visit')} through your link · {plural(stats.votesFromLink, 'vote')} from those visitors</p>
      </section>

      <GroupPanel data={data} />

      <div className="dash-grid">
        <section className="panel">
          <h2>Performance</h2>
          <p className="muted">Votes per day, last 14 days. Your best day: {plural(stats.bestDay, 'vote')}.</p>
          <DailyVotes daily={data.daily} />
        </section>
        <Notifications items={data.notifications} onRead={markRead} />
      </div>

      {data.topSupporters.length ? (
        <section className="panel">
          <h2>Your top supporters</h2>
          <ol className="history supporters">
            {data.topSupporters.map((s) => (
              <li key={s.name}><span><b>{s.name}</b></span><small>{plural(s.votes, 'vote')}</small></li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="panel">
        <h2>Who voted for you</h2>
        {data.history.length === 0 ? <p className="muted">Votes will appear here as they arrive, with the name each supporter gave.</p> : (
          <ul className="history">
            {data.history.map((v, i) => (
              <li key={`${v.createdAt}-${i}`}>
                <span><b>{v.name}</b> gave <b>{plural(v.quantity, 'vote')}</b>{v.viaLink ? <em className="tag">via your link</em> : null}</span>
                <small>{dateTime(v.createdAt)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProfilePanel data={data} onSaved={reload} />
      {data.profile.hasPin ? <PinPanel data={data} /> : null}
    </div>
  );
}
