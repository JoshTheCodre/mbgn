import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, ago, api, naira, plural, registrationOpen, useApp, useFetch, useLive,
} from '../lib.jsx';
import {
  ActivityFeed, CardsSkeleton, CodeTag, CoverSkeleton, Crown, Countdown, ErrorNote, Field, LoadFailed, Loading, Movement,
  PageSkeleton, Portrait, ProfileSkeleton, RankSkeleton, CountUp, ShareButtons, ShareCard, Timer,
} from '../ui.jsx';

const prefersCalm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Types real names and codes into the placeholder, showing what can be searched.
function useTypedSuggestion(examples, paused) {
  const [text, setText] = useState('');
  const list = examples.join('|');
  useEffect(() => {
    if (paused || !list || prefersCalm()) {
      setText('');
      return undefined;
    }
    const words = list.split('|');
    let word = 0;
    let length = 0;
    let deleting = false;
    let timer;
    const step = () => {
      const current = words[word];
      length += deleting ? -1 : 1;
      setText(current.slice(0, length));
      let wait = deleting ? 45 : 95;
      if (!deleting && length === current.length) {
        deleting = true;
        wait = 1500;
      } else if (deleting && length === 0) {
        deleting = false;
        word = (word + 1) % words.length;
        wait = 350;
      }
      timer = setTimeout(step, wait);
    };
    timer = setTimeout(step, 900);
    return () => clearTimeout(timer);
  }, [list, paused]);
  return text;
}

function CodeSearch({ examples = [] }) {
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const typed = useTypedSuggestion(examples, focused || code !== '');

  async function go(e) {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    setError(null);
    try {
      const found = await api(`/contestants/${encodeURIComponent(value)}`);
      navigate(`/c/${found.code}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) navigate(`/contestants?q=${encodeURIComponent(value)}`);
      else setError(err);
    }
  }

  return (
    <form className="code-search" onSubmit={go} role="search">
      <label htmlFor="code-search-input" className="field-label">Enter a contestant code or name</label>
      <div className="code-search-row">
        <input
          id="code-search-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={typed ? `${typed}|` : 'MBG001 or Stella'}
          autoComplete="off"
        />
        <button className="btn btn-vote">Find &amp; vote</button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

// Cycles through the top contestants, with a slow zoom and a slight tilt towards the pointer.
function HeroCover({ rows }) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const card = useRef(null);
  const count = rows.length;
  const row = rows[index % count];

  useEffect(() => {
    if (held || count < 2 || prefersCalm()) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), 4500);
    return () => clearInterval(id);
  }, [held, count]);

  function tilt(e) {
    if (prefersCalm()) return;
    const box = card.current.getBoundingClientRect();
    card.current.style.setProperty('--ry', `${((e.clientX - box.left) / box.width - 0.5) * 10}deg`);
    card.current.style.setProperty('--rx', `${((e.clientY - box.top) / box.height - 0.5) * -10}deg`);
  }
  function level() {
    setHeld(false);
    card.current.style.setProperty('--rx', '0deg');
    card.current.style.setProperty('--ry', '0deg');
  }

  return (
    <div className="cover-float">
      <div className="cover" ref={card} onMouseEnter={() => setHeld(true)} onMouseMove={tilt} onMouseLeave={level}>
        <Link to={`/c/${row.code}`} className="cover-link" aria-label={`${row.name}, position ${row.position}, ${plural(row.totalVotes, 'vote')}`}>
          {rows.map((r, i) => (
            <div key={r.code} className={`cover-slide ${i === index % count ? 'active' : ''}`} aria-hidden="true">
              <Portrait name={r.name} photoUrl={r.photoUrl} code={r.code} />
            </div>
          ))}
          <CodeTag code={row.code} />
          <div className="cover-caption" key={row.code}>
            <span className="cover-kicker">{row.position === 1 ? 'On top right now' : `No. ${row.position} right now`}</span>
            <strong>{row.name}</strong>
            <span>{plural(row.totalVotes, 'vote')} · {row.state}</span>
          </div>
        </Link>
        {count > 1 ? (
          <div className="cover-dots">
            {rows.map((r, i) => (
              <button
                key={r.code}
                type="button"
                className={i === index % count ? 'active' : ''}
                aria-label={`Show ${r.name}`}
                aria-pressed={i === index % count}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HowVoting({ competition }) {
  return (
    <section className="how">
      <div className="wrap how-grid">
        <div>
          <h2>How voting works</h2>
          <Link to="/contestants" className="btn btn-primary">Find a contestant</Link>
        </div>
        <ol className="how-steps">
          <li>
            <h3>Find your contestant</h3>
            <p>Search by name or unique code.</p>
          </li>
          <li>
            <h3>Choose your votes</h3>
            <p>Each vote is {naira(competition?.votePrice ?? 500)}.</p>
          </li>
          <li>
            <h3>Pay and it counts</h3>
            <p>The leaderboard updates within seconds.</p>
          </li>
        </ol>
      </div>
    </section>
  );
}

function JoinCard({ to, label }) {
  return (
    <section className="wrap section">
      <div className="join-card">
        <span className="join-spark join-spark-a" aria-hidden="true">✦</span>
        <span className="join-spark join-spark-b" aria-hidden="true">✦</span>
        <Crown className="join-crown" />
        <h2>Think the crown should be yours?</h2>
        <p>Join in a few minutes and get your own code, voting link and dashboard.</p>
        <Link to={to} className="btn btn-primary">{label}</Link>
      </div>
    </section>
  );
}

function ShareInvite() {
  const { competition } = useApp();
  return registrationOpen(competition) ? (
    <ShareCard
      title="Know someone who should enter?"
      text="Send this to a friend, a sister or anyone ready for the crown."
      message="Over ₦10 million in cash prizes to be won on Most Beautiful Girl Online Nigeria. Registration is open:"
    />
  ) : (
    <ShareCard
      title="Tell people voting opens soon"
      text="Over ₦10 million in cash prizes is at stake. Get your friends and family ready to vote."
      message="Voting opens soon on Most Beautiful Girl Online Nigeria, with over ₦10 million in cash prizes to be won:"
    />
  );
}

// The first stage of the contest: everything here is about getting people to join.
function RegistrationHome() {
  const { user, competition } = useApp();
  const open = registrationOpen(competition);
  const endsAt = competition.registration?.endsAt;
  const joined = Boolean(user?.contestant);
  const joinTo = joined ? '/dashboard' : '/register';
  const joinLabel = joined ? 'Open my dashboard' : 'Join the contest';

  return (
    <>
      <section className="hero reg-hero">
        <span className="hero-glow hero-glow-a" aria-hidden="true" />
        <span className="hero-glow hero-glow-b" aria-hidden="true" />
        {['a', 'b', 'c', 'd'].map((k) => <span key={k} className={`hero-star hero-star-${k}`} aria-hidden="true">✦</span>)}
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">{open ? <><span className="reg-dot" aria-hidden="true" />Registration is open</> : 'Registration has closed'}</p>
            <h1>
              <span className="hero-word" style={{ '--i': 0 }}>Most</span>{' '}
              <span className="hero-word" style={{ '--i': 1 }}>Beautiful</span>{' '}
              <span className="hero-word" style={{ '--i': 2 }}>Girl</span>{' '}
              <em className="hero-word" style={{ '--i': 3 }}>Online</em>{' '}
              <span className="hero-word" style={{ '--i': 4 }}>Nigeria</span>
            </h1>
            <p className="reg-lead">{open
              ? 'Nigeria is looking for its next queen. Join the contest today, or share it with someone who should.'
              : 'Applications are closed and voting opens soon. Get ready to support your favourite.'}</p>
            {open && endsAt ? <Timer target={endsAt} label="Registration closes in" /> : null}
            <div className="reg-actions">
              {open || joined ? <Link to={joinTo} className="btn btn-primary reg-join">{joinLabel}</Link> : null}
              <a href="#share" className="btn reg-share-link">Share with someone</a>
            </div>
          </div>
          <div className="prize">
            <span className="prize-over">Over</span>
            <strong className="prize-amount">₦10 Million</strong>
            <span className="prize-rule" aria-hidden="true"><i>✦</i></span>
            <span className="prize-note">in cash prizes to be won</span>
          </div>
        </div>
      </section>

      {open ? (
        <section className="how">
          <div className="wrap how-grid">
            <div>
              <h2>How to enter</h2>
              <Link to={joinTo} className="btn btn-primary">{joinLabel}</Link>
            </div>
            <ol className="how-steps">
              <li>
                <h3>Join the contest</h3>
                <p>Add your photo and a few details. It only takes a few minutes.</p>
              </li>
              <li>
                <h3>Get approved</h3>
                <p>Our team reviews your application, then you get your own code and voting link.</p>
              </li>
              <li>
                <h3>Get your supporters ready</h3>
                <p>Voting opens when registration closes. Verified votes decide the winners.</p>
              </li>
            </ol>
          </div>
        </section>
      ) : null}

      <ShareInvite />

      {open ? <JoinCard to={joinTo} label={joinLabel} /> : null}
    </>
  );
}

// What the voting pages show until voting has started.
function VotingSoon() {
  const { user, competition } = useApp();
  const open = registrationOpen(competition);
  return (
    <>
      <div className="wrap page narrow voting-soon">
        <Crown className="prize-crown" />
        <h1>Voting hasn’t started yet</h1>
        <p className="muted">{open
          ? 'Voting opens when registration closes. Right now, over ₦10 million in cash prizes is waiting for the women who join.'
          : 'Registration has closed and voting opens soon. Please check back shortly.'}</p>
        {user?.contestant ? <Link to="/dashboard" className="btn btn-primary btn-wide">Open my dashboard</Link> : null}
        {!user?.contestant && open ? <Link to="/register" className="btn btn-primary btn-wide">Join the contest</Link> : null}
      </div>
      <ShareInvite />
    </>
  );
}

// These pages wait for the first answer about the contest's stage, then show the right one.
const whileVoting = (Page) => function WhileVoting() {
  const { competition } = useApp();
  if (!competition?.phase) return <PageSkeleton />;
  return competition.phase === 'voting' ? <Page /> : <VotingSoon />;
};

export function Home() {
  const { competition } = useApp();
  if (!competition?.phase) return <PageSkeleton />;
  return competition.phase === 'voting' ? <VotingHome /> : <RegistrationHome />;
}

function VotingHome() {
  const { competition } = useApp();
  const { data, error, reload } = useFetch('/leaderboard?limit=5');
  useLive('leaderboard', reload);
  const top = data?.rows ?? [];
  const withPhotos = top.filter((row) => row.photoUrl);
  const covers = withPhotos.length ? withPhotos : top.slice(0, 1);

  return (
    <>
      <section className="hero">
        <div className="hero-photos" aria-hidden="true">
          {top.filter((row) => row.photoUrl).map((row) => <img key={row.code} src={row.photoUrl} alt="" decoding="async" />)}
        </div>
        <span className="hero-glow hero-glow-a" aria-hidden="true" />
        <span className="hero-glow hero-glow-b" aria-hidden="true" />
        {['a', 'b', 'c', 'd'].map((k) => <span key={k} className={`hero-star hero-star-${k}`} aria-hidden="true">✦</span>)}
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">{competition?.voting.open ? 'The nation is voting' : 'Nigeria’s online pageant'}</p>
            <h1>
              <span className="hero-word" style={{ '--i': 0 }}>Most</span>{' '}
              <span className="hero-word" style={{ '--i': 1 }}>Beautiful</span>{' '}
              <span className="hero-word" style={{ '--i': 2 }}>Girl</span>{' '}
              <em className="hero-word" style={{ '--i': 3 }}>Online</em>{' '}
              <span className="hero-word" style={{ '--i': 4 }}>Nigeria</span>
            </h1>
            <Countdown competition={competition} />
            <CodeSearch examples={top.flatMap((row) => [row.name, row.code]).slice(0, 6)} />
          </div>
          {covers.length ? <HeroCover rows={covers} /> : data || error ? null : <CoverSkeleton />}
        </div>
      </section>

      <section className="wrap section live-grid">
        <div>
          <div className="section-head">
            <h2>Live leaderboard</h2>
            <Link to="/leaderboard" className="text-link">See everyone</Link>
          </div>
          {data ? <RankList rows={top} /> : error ? <LoadFailed error={error} onRetry={reload} what="the leaderboard" /> : <RankSkeleton />}
        </div>
        <aside className="live-panel">
          <div className="section-head">
            <h2>Happening now</h2>
            <span className="live-dot">Live</span>
          </div>
          <ActivityFeed limit={5} />
        </aside>
      </section>

      <HowVoting competition={competition} />
    </>
  );
}

function Podium({ rows }) {
  return (
    <ol className="podium">
      {rows.slice(0, 3).map((row) => (
        <li key={row.code}>
          <Link to={`/c/${row.code}`}>
            <span className="podium-photo">
              <span className="podium-shine"><Portrait name={row.name} photoUrl={row.photoUrl} code={row.code} /></span>
              <span className="podium-pos" aria-label={`Position ${row.position}`}>{row.position}</span>
            </span>
            <strong>{row.name}</strong>
            <small><CountUp value={row.totalVotes} /> votes</small>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// Very long lists only animate the top rows, so the page stays fast.
const ROLL_LIMIT = 30;

function RankList({ rows, flash }) {
  if (rows.length === 0) return <p className="muted empty">No contestants match that search.</p>;
  const top = Math.max(1, ...rows.map((row) => row.totalVotes));
  return (
    <ol className="ranks">
      {rows.map((row, index) => (
        <li key={row.code} className={`rank ${row.position <= 3 ? `rank-top rank-${row.position}` : ''} ${flash?.has(row.code) ? 'rank-flash' : ''}`}>
          <Link to={`/c/${row.code}`}>
            <span className="rank-pos" aria-label={`Position ${row.position}`}>{row.position}</span>
            <span className="rank-photo"><Portrait name={row.name} photoUrl={row.photoUrl} code={row.code} /></span>
            <span className="rank-who">
              <strong>{row.name}</strong>
              <small>{row.code} · {row.state}{row.category ? <span className="rank-cat"> · {row.category}</span> : null}</small>
            </span>
            <span className="rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, (row.totalVotes / top) * 100)}%` }} /></span>
            <span className="rank-move">
              <Movement value={row.movement24h} plain={index >= ROLL_LIMIT} />
              <small>{row.previousPosition ? `was ${row.previousPosition}` : ''}</small>
            </span>
            <span className="rank-votes"><b><CountUp value={row.totalVotes} plain={index >= ROLL_LIMIT} /></b><small>votes</small></span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function useBoardFilters() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const state = params.get('state') ?? '';
  const category = params.get('category') ?? '';
  const update = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (state) query.set('state', state);
  if (category) query.set('category', category);
  return { q, state, category, update, query: query.toString() };
}

function BoardFilters({ f, filters }) {
  return (
    <div className="filters" role="search">
      <Field label="Search name or code">
        <input type="search" value={f.q} onChange={(e) => f.update('q', e.target.value)} placeholder="Stella or MBG001" />
      </Field>
      <Field label="State">
        <select value={f.state} onChange={(e) => f.update('state', e.target.value)}>
          <option value="">All states</option>
          {(filters?.states ?? []).map((s) => <option key={s}>{s}</option>)}
        </select>
      </Field>
      {filters?.categories?.length ? (
        <Field label="Category">
          <select value={f.category} onChange={(e) => f.update('category', e.target.value)}>
            <option value="">All categories</option>
            {filters.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      ) : null}
    </div>
  );
}

export const Leaderboard = whileVoting(() => {
  const f = useBoardFilters();
  const { data, error, reload } = useFetch(`/leaderboard?${f.query}`);
  const previous = useRef(new Map());
  const [flash, setFlash] = useState(new Set());
  useLive('leaderboard', reload);

  // Briefly lights up rows whose vote total just changed.
  useEffect(() => {
    if (!data) return undefined;
    const changed = new Set();
    for (const row of data.rows) {
      const before = previous.current.get(row.code);
      if (before != null && before !== row.totalVotes) changed.add(row.code);
      previous.current.set(row.code, row.totalVotes);
    }
    if (changed.size === 0) return undefined;
    setFlash(changed);
    const t = setTimeout(() => setFlash(new Set()), 2400);
    return () => clearTimeout(t);
  }, [data]);

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">
            <span className="live-dot">Live</span>
            {data?.updatedAt ? ` Last vote counted ${ago(data.updatedAt)}.` : data ? ' Waiting for the first vote.' : ''}
          </p>
        </div>
      </div>
      <BoardFilters f={f} filters={data?.filters} />
      {data ? <ErrorNote error={error} /> : null}
      {data && !f.query && data.rows.length >= 3 ? <Podium rows={data.rows} /> : null}
      {data ? <RankList rows={data.rows} flash={flash} /> : error ? <LoadFailed error={error} onRetry={reload} what="the leaderboard" /> : <RankSkeleton count={8} />}
      <p className="muted small-note">Ranked by total verified votes. If two contestants tie, the one who reached that total first stays ahead. Movement compares with 24 hours ago.</p>
    </div>
  );
});

export const Contestants = whileVoting(() => {
  const f = useBoardFilters();
  const { data, error, reload } = useFetch(`/leaderboard?${f.query}`);
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <h1>The contestants</h1>
          {data ? <p className="muted">{plural(data.total, 'contestant')} in the running</p> : null}
        </div>
      </div>
      <BoardFilters f={f} filters={data?.filters} />
      {data ? <ErrorNote error={error} /> : null}
      {!data ? (error ? <LoadFailed error={error} onRetry={reload} what="the contestants" /> : <CardsSkeleton />) : data.rows.length === 0 ? <p className="muted empty">No contestants match that search.</p> : (
        <ul className="card-grid">
          {data.rows.map((c) => (
            <li key={c.code}>
              <Link to={`/c/${c.code}`} className="card">
                <div className="card-photo">
                  <Portrait name={c.name} photoUrl={c.photoUrl} code={c.code} />
                  <CodeTag code={c.code} />
                </div>
                <div className="card-body">
                  <strong>{c.name}</strong>
                  <small>{c.state}</small>
                  <span className="card-stats"><b><CountUp value={c.totalVotes} /></b> votes · No. {c.position}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function VotePanel({ contestant, viaLink }) {
  const { competition } = useApp();
  const [quantity, setQuantity] = useState(5);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const packages = competition?.packages ?? [];
  const priceOf = (n) => packages.find((p) => p.votes === n)?.price ?? n * (competition?.votePrice ?? 0);
  const amount = custom !== '' ? Number(custom) : quantity;
  const valid = Number.isInteger(amount) && amount > 0;
  const voting = competition?.voting;

  function choose(n, typed) {
    setQuantity(n);
    setCustom(typed);
    setError(null);
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const started = await api('/votes/pay', { body: { code: contestant.code, quantity: amount, viaLink } });
      window.location.assign(started.checkoutUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (voting && !voting.open) return <div className="vote-panel"><p className="note">{voting.message}</p></div>;

  return (
    <div className="vote-panel">
      <h2>Vote for {contestant.name}</h2>
      <div className="qty-chips" role="group" aria-label="Number of votes">
        {[1, 5, 10, 20, 50, 100].map((n) => (
          <button
            key={n}
            type="button"
            className={`chip ${custom === '' && quantity === n ? 'active' : ''}`}
            aria-pressed={custom === '' && quantity === n}
            onClick={() => choose(n, '')}
          >{n}</button>
        ))}
        <input
          className="qty-custom"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          placeholder="Other"
          aria-label="Other number of votes"
          value={custom}
          onChange={(e) => { setCustom(e.target.value); setError(null); }}
        />
      </div>

      {valid ? (
        <button type="button" className="btn btn-vote btn-wide" disabled={busy} onClick={pay}>{busy ? 'Opening checkout…' : `Pay ${naira(priceOf(amount))} and vote`}</button>
      ) : null}
      <ErrorNote error={error} />
    </div>
  );
}

export function Profile() {
  const { competition } = useApp();
  const { code } = useParams();
  const [params] = useSearchParams();
  const { data, error, reload } = useFetch(`/contestants/${encodeURIComponent(code)}`);
  useLive('leaderboard', reload);

  // Someone arriving from outside the site came through a shared voting link.
  const viaLink = useMemo(() => {
    const key = `mbgn-ref-${code.toUpperCase()}`;
    try {
      if (sessionStorage.getItem(key)) return true;
      const external = params.get('via') || (document.referrer && !document.referrer.startsWith(window.location.origin));
      const direct = !document.referrer && window.history.length <= 2;
      if (external || direct) {
        sessionStorage.setItem(key, '1');
        api(`/contestants/${encodeURIComponent(code)}/visit`, { body: { source: params.get('via') ?? 'link' } }).catch(() => {});
        return true;
      }
    } catch { /* storage blocked: treat as an ordinary visit */ }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (error && !data) {
    // Only a real "no such code" means that. Anything else is a problem on our side or the connection.
    if (error.status !== 404) return <div className="wrap page"><LoadFailed error={error} onRetry={reload} what="this contestant" /></div>;
    return (
      <div className="wrap page">
        <h1>We could not find that contestant</h1>
        <p className="muted">{error.message} Check the code and try again.</p>
        <Link to="/contestants" className="btn btn-primary">Browse all contestants</Link>
      </div>
    );
  }
  if (!data) return <ProfileSkeleton />;

  const url = `${window.location.origin}/c/${data.code}`;
  return (
    <div className="wrap page profile">
      <div className="profile-photo">
        <Portrait name={data.name} photoUrl={data.photoUrl} code={data.code} />
        <CodeTag code={data.code} />
      </div>
      <div className="profile-main">
        <p className="eyebrow">{data.location}, {data.state}{data.category ? ` · ${data.category}` : ''}</p>
        <h1>{data.name}</h1>
        {competition?.phase === 'voting' ? (
          <dl className="profile-stats">
            <div><dt>Total votes</dt><dd><CountUp value={data.totalVotes} /></dd></div>
            <div><dt>Position</dt><dd><CountUp value={data.position} /></dd></div>
            <div><dt>24 hours</dt><dd className="profile-move"><Movement value={data.movement24h} /></dd></div>
          </dl>
        ) : null}
        <VotePanel contestant={data} viaLink={viaLink} />
        <p className="profile-bio">{data.bio}</p>
        <div className="social-links">
          {data.tiktok ? <a href={data.tiktok} target="_blank" rel="noreferrer noopener">TikTok</a> : null}
          {data.instagram ? <a href={data.instagram} target="_blank" rel="noreferrer noopener">Instagram</a> : null}
          {data.facebook ? <a href={data.facebook} target="_blank" rel="noreferrer noopener">Facebook</a> : null}
        </div>
        <h2 className="share-title">Share {data.name}’s voting link</h2>
        <ShareButtons url={url} name={data.name} />
      </div>
    </div>
  );
}

function Edition({ edition }) {
  const [winner, ...others] = edition.standings;
  const when = new Date(edition.publishedAt).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
  return (
    <section className="edition">
      <div className="edition-winner">
        {winner.photoUrl ? <img className="edition-backdrop" src={winner.photoUrl} alt="" aria-hidden="true" /> : null}
        <Crown className="edition-crown" />
        <div className="edition-photo">
          <Portrait name={winner.name} photoUrl={winner.photoUrl} code={winner.code ?? winner.name} />
        </div>
        <p className="edition-label">Winner</p>
        <h2>{winner.name}</h2>
        {winner.votes != null ? <p className="edition-votes"><CountUp value={winner.votes} /> votes</p> : null}
        <p className="edition-meta">{edition.competition} · <time dateTime={edition.publishedAt}>{when}</time></p>
      </div>
      {others.length ? (
        <ol className="edition-list" start="2">
          {others.slice(0, 9).map((row) => (
            <li key={`${row.position}-${row.name}`}>
              <span className="edition-pos">{row.position}</span>
              <span className="edition-avatar">
                <Portrait name={row.name} photoUrl={row.photoUrl} code={row.code ?? row.name} />
              </span>
              <span className="edition-name">
                <strong>{row.name}</strong>
                {row.code ? <small>{row.code}</small> : null}
              </span>
              {row.votes != null ? <span className="edition-count"><b><CountUp value={row.votes} /></b> votes</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function Results() {
  const { data, error, reload } = useFetch('/results');
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <h1>Winners</h1>
          <p className="muted">Final standings, decided by verified votes under the competition rules.</p>
        </div>
      </div>
      {data ? <ErrorNote error={error} /> : null}
      {!data ? (error ? <LoadFailed error={error} onRetry={reload} what="the winners" /> : <Loading label="Loading the winners" />) : data.length === 0
        ? <p className="muted empty">Final results will be published here when voting closes.</p>
        : data.map((edition) => <Edition key={edition.id} edition={edition} />)}
    </div>
  );
}

export function NotFound() {
  return (
    <div className="wrap page">
      <h1>That page isn’t here</h1>
      <p className="muted">The link may be out of date.</p>
      <Link to="/" className="btn btn-primary">Back to the home page</Link>
    </div>
  );
}
