import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ago, dateTime, num, plural, shortDate, useApp, useFetch, useLive } from '../lib.jsx';
import {
  CodeTag, Countdown, ErrorNote, Field, LoadFailed, Loading, Movement, Portrait, CountUp, ShareButtons,
} from '../ui.jsx';

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

function NotYetLive({ data, onRead }) {
  const copy = {
    pending: ['Your application is being reviewed', 'We will email you as soon as a decision is made. Once approved, your contestant code and voting link appear here.'],
    rejected: ['Your application was not approved', data.statusReason ?? ''],
    suspended: ['Your profile is suspended', data.statusReason ?? ''],
    disqualified: ['You have been disqualified', data.statusReason ?? ''],
  }[data.status];
  return (
    <div className="wrap page narrow-wide">
      <div className="waiting">
        <div className="dash-avatar"><Portrait name={data.name} photoUrl={data.photoUrl} code={data.code ?? data.name} /></div>
        <div>
          <p className="eyebrow">Hello, {data.name}</p>
          <h1>{copy[0]}</h1>
          {copy[1] ? <p className="muted">{copy[1]}</p> : null}
          {data.code ? <p>Your code <b>{data.code}</b> stays reserved for you.</p> : null}
        </div>
      </div>
      <Notifications items={data.notifications} onRead={onRead} />
    </div>
  );
}

// A contestant's browser is recognised from the moment they join. On a new device,
// the details they joined with bring the dashboard back.
function OpenDashboard() {
  const { setUser } = useApp();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { user } = await api('/contestants/recognise', { body: { email: form.get('email'), whatsapp: form.get('whatsapp') } });
      setUser(user);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="wrap page narrow">
      <h1>Open your dashboard</h1>
      <p className="muted">Already in the contest? Enter the details you joined with.</p>
      <form className="stack" onSubmit={submit}>
        <Field label="Email address"><input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="WhatsApp number"><input name="whatsapp" type="tel" required /></Field>
        <ErrorNote error={error} />
        <button className="btn btn-primary btn-wide" disabled={busy}>{busy ? 'Opening…' : 'Open my dashboard'}</button>
      </form>
      <p className="muted form-foot">Not in yet? <Link to="/register">Join the contest</Link></p>
    </div>
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
  if (!user || !user.contestant) return <OpenDashboard />;
  if (error && !data) return <div className="wrap page"><LoadFailed error={error} onRetry={reload} what="your dashboard" /></div>;
  if (!data) return <div className="wrap page"><Loading /></div>;
  if (data.status !== 'approved') return <NotYetLive data={data} onRead={markRead} />;

  const { stats } = data;
  return (
    <div className="wrap page dashboard">
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

      <div className="dash-grid">
        <section className="panel">
          <h2>Performance</h2>
          <p className="muted">Votes per day, last 14 days. Your best day: {plural(stats.bestDay, 'vote')}.</p>
          <DailyVotes daily={data.daily} />
        </section>
        <Notifications items={data.notifications} onRead={markRead} />
      </div>

      <section className="panel">
        <h2>Voting activity</h2>
        {data.history.length === 0 ? <p className="muted">Votes will appear here as they arrive. Supporter identities are kept private.</p> : (
          <ul className="history">
            {data.history.map((v, i) => (
              <li key={`${v.createdAt}-${i}`}>
                <span><b>+{plural(v.quantity, 'vote')}</b>{v.viaLink ? <em className="tag">via your link</em> : null}</span>
                <small>{dateTime(v.createdAt)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
