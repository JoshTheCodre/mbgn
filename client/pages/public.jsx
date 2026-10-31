import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, ago, api, naira, newVoteKey, num, plural, useApp, useFetch, useLive,
} from '../lib.jsx';
import {
  ActivityFeed, CodeTag, Crown, Countdown, Dialog, ErrorNote, Field, Loading, Movement, Portrait, CountUp, ShareButtons,
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

function JoinCard({ top }) {
  const faces = top.filter((row) => row.photoUrl).slice(0, 4);
  return (
    <section className="wrap section">
      <div className="join-card">
        <span className="join-spark join-spark-a" aria-hidden="true">✦</span>
        <span className="join-spark join-spark-b" aria-hidden="true">✦</span>
        <Crown className="join-crown" />
        <h2>Think the crown should be yours?</h2>
        <p>Join in a few minutes and get your own code, voting link and dashboard.</p>
        {faces.length ? (
          <div className="join-faces" aria-hidden="true">
            {faces.map((row) => <img key={row.code} src={row.photoUrl} alt="" loading="lazy" />)}
            <span>You?</span>
          </div>
        ) : null}
        <Link to="/register" className="btn btn-primary">Join the contest</Link>
      </div>
    </section>
  );
}

export function Home() {
  const { competition } = useApp();
  const { data, reload } = useFetch('/leaderboard?limit=5');
  useLive('leaderboard', reload);
  const top = data?.rows ?? [];
  const withPhotos = top.filter((row) => row.photoUrl);
  const covers = withPhotos.length ? withPhotos : top.slice(0, 1);

  return (
    <>
      <section className="hero">
        <div className="hero-photos" aria-hidden="true">
          {top.filter((row) => row.photoUrl).map((row) => <img key={row.code} src={row.photoUrl} alt="" />)}
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
          {covers.length ? <HeroCover rows={covers} /> : null}
        </div>
      </section>

      <section className="wrap section live-grid">
        <div>
          <div className="section-head">
            <h2>Live leaderboard</h2>
            <Link to="/leaderboard" className="text-link">See everyone</Link>
          </div>
          {data ? <RankList rows={top} /> : <Loading />}
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

      <JoinCard top={top} />
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

export function Leaderboard() {
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
            {data?.updatedAt ? ` Last vote counted ${ago(data.updatedAt)}.` : ' Waiting for the first vote.'}
          </p>
        </div>
      </div>
      <BoardFilters f={f} filters={data?.filters} />
      <ErrorNote error={error} />
      {data && !f.query && data.rows.length >= 3 ? <Podium rows={data.rows} /> : null}
      {data ? <RankList rows={data.rows} flash={flash} /> : <Loading />}
      <p className="muted small-note">Ranked by total verified votes. If two contestants tie, the one who reached that total first stays ahead. Movement compares with 24 hours ago.</p>
    </div>
  );
}

export function Contestants() {
  const f = useBoardFilters();
  const { data, error } = useFetch(`/leaderboard?${f.query}`);
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <h1>The contestants</h1>
          {data ? <p className="muted">{plural(data.total, 'contestant')} in the running</p> : null}
        </div>
      </div>
      <BoardFilters f={f} filters={data?.filters} />
      <ErrorNote error={error} />
      {!data ? <Loading /> : data.rows.length === 0 ? <p className="muted empty">No contestants match that search.</p> : (
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
}

function VotePanel({ contestant, onVoted, viaLink }) {
  const { user, refreshUser, competition } = useApp();
  const [quantity, setQuantity] = useState(5);
  const [custom, setCustom] = useState('');
  const [step, setStep] = useState(null); // null, 'direct' or 'wallet'
  const [fund, setFund] = useState(null);
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('mbgn-email') ?? ''; } catch { return ''; }
  });
  const [phone, setPhone] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const voteKey = useRef(newVoteKey());

  const packages = competition?.packages ?? [];
  const priceOf = (n) => packages.find((p) => p.votes === n)?.price ?? n * (competition?.votePrice ?? 0);
  const amount = custom !== '' ? Number(custom) : quantity;
  const valid = Number.isInteger(amount) && amount > 0;
  const balance = user?.credits ?? 0;
  const canUseWallet = valid && balance >= amount;
  const needed = valid ? Math.max(amount - balance, 1) : 1;

  // How much to add: exactly what's needed, or one of the packages above it.
  const fundOptions = [...new Set([needed, ...packages.map((p) => p.votes).filter((v) => v > needed)])].slice(0, 4);
  const fundAmount = fundOptions.includes(fund) ? fund : (fundOptions[1] ?? fundOptions[0]);
  const leftover = balance + fundAmount - amount;
  const voting = competition?.voting;

  function choose(n, typed) {
    setQuantity(n);
    setCustom(typed);
    setError(null);
  }

  async function checkout(path, body) {
    setBusy(true);
    setError(null);
    try {
      try { if (!user) localStorage.setItem('mbgn-email', email); } catch { /* convenience only */ }
      const started = await api(path, { body: { code: contestant.code, quantity: amount, viaLink, ...body } });
      window.location.assign(started.checkoutUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function vote() {
    setBusy(true);
    setError(null);
    try {
      const receipt = await api('/votes', {
        body: { code: contestant.code, quantity: amount, idempotencyKey: voteKey.current, viaLink },
      });
      voteKey.current = newVoteKey();
      setDone(receipt);
      setConfirming(false);
      setCustom('');
      await refreshUser();
      onVoted();
    } catch (err) {
      // A definite refusal can safely start over; anything else keeps the key so a retry can't double-spend.
      if (err.status && err.status < 500) voteKey.current = newVoteKey();
      setError(err);
      setConfirming(false);
      refreshUser().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (voting && !voting.open) return <div className="vote-panel"><p className="note">{voting.message}</p></div>;

  return (
    <div className="vote-panel">
      <h2>Vote for {contestant.name}</h2>
      {balance > 0 ? <p className="vote-balance"><Link to="/wallet">{plural(balance, 'credit')} in your wallet</Link></p> : null}
      {done ? (
        <div className="note note-good" role="status">
          <b>{plural(done.quantity, 'vote')} counted for {done.contestant.name}.</b>{' '}
          Now in position {done.contestant.position} with {num(done.contestant.totalVotes)} votes.{' '}
          <Link to={`/receipt/vote/${done.receiptNo}`}>View receipt</Link>
        </div>
      ) : null}
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

      {user === undefined || !valid ? null : step === null ? (
        canUseWallet ? (
          <div className="vote-choices">
            <button type="button" className="btn btn-vote btn-wide" onClick={() => setConfirming(true)}>Vote with {plural(amount, 'credit')}</button>
            <button type="button" className="text-link as-button" onClick={() => setStep('direct')}>Pay {naira(priceOf(amount))} directly instead</button>
          </div>
        ) : (
          <div className="vote-choices">
            <button type="button" className="btn btn-vote btn-wide" onClick={() => setStep('direct')}>Pay {naira(priceOf(amount))} and vote</button>
            <button type="button" className="btn btn-ghost btn-wide" onClick={() => setStep('wallet')}>Fund wallet and vote</button>
            <p className="muted small-note">With a wallet, your next votes don’t need a new payment.</p>
          </div>
        )
      ) : step === 'direct' ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); checkout('/votes/pay', { email }); }}>
          {user ? null : (
            <Field label="Email for your receipt" hint="Never shown publicly.">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          )}
          <button className="btn btn-vote btn-wide" disabled={busy}>{busy ? 'Opening checkout…' : `Pay ${naira(priceOf(amount))}`}</button>
          <button type="button" className="text-link as-button" onClick={() => setStep(null)}>Back</button>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); checkout('/votes/fund', { fund: fundAmount, email, phone }); }}>
          <div>
            <span className="field-label">How many credits to add?</span>
            <div className="qty-chips fund-chips" role="group" aria-label="Credits to add">
              {fundOptions.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${fundAmount === n ? 'active' : ''}`}
                  aria-pressed={fundAmount === n}
                  onClick={() => setFund(n)}
                >{num(n)}</button>
              ))}
            </div>
            <p className="muted small-note">
              {plural(amount, 'vote')} {amount === 1 ? 'goes' : 'go'} to {contestant.name} now.
              {leftover > 0 ? ` ${plural(leftover, 'credit')} ${leftover === 1 ? 'stays' : 'stay'} in your wallet.` : ''}
            </p>
          </div>
          {user ? null : (
            <>
              <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="Phone number" hint="These details open your wallet on any phone.">
                <input type="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
            </>
          )}
          <button className="btn btn-vote btn-wide" disabled={busy}>{busy ? 'Opening checkout…' : `Pay ${naira(priceOf(fundAmount))}`}</button>
          <button type="button" className="text-link as-button" onClick={() => setStep(null)}>Back</button>
        </form>
      )}
      <ErrorNote error={error} />

      <Dialog open={confirming} onClose={() => setConfirming(false)} title="Confirm your vote">
        <div className="confirm">
          <div className="confirm-who">
            <Portrait name={contestant.name} photoUrl={contestant.photoUrl} code={contestant.code} />
            <div>
              <strong>{contestant.name}</strong>
              <small>{contestant.code} · {contestant.state}</small>
            </div>
          </div>
          <p>Spend <b>{plural(amount, 'credit')}</b> on <b>{plural(amount, 'vote')}</b> for {contestant.name}? Votes cannot be moved once cast.</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn btn-vote" disabled={busy} onClick={vote}>{busy ? 'Counting…' : 'Confirm vote'}</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function Profile() {
  const { code } = useParams();
  const [params] = useSearchParams();
  const { data, error, reload, loading } = useFetch(`/contestants/${encodeURIComponent(code)}`);
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
    return (
      <div className="wrap page">
        <h1>We could not find that contestant</h1>
        <p className="muted">{error.message} Check the code and try again.</p>
        <Link to="/contestants" className="btn btn-primary">Browse all contestants</Link>
      </div>
    );
  }
  if (!data || loading && !data) return <div className="wrap page"><Loading /></div>;

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
        <dl className="profile-stats">
          <div><dt>Total votes</dt><dd><CountUp value={data.totalVotes} /></dd></div>
          <div><dt>Position</dt><dd><CountUp value={data.position} /></dd></div>
          <div><dt>24 hours</dt><dd className="profile-move"><Movement value={data.movement24h} /></dd></div>
        </dl>
        <VotePanel contestant={data} onVoted={reload} viaLink={viaLink} />
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
  const { data, error } = useFetch('/results');
  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <h1>Winners</h1>
          <p className="muted">Final standings, decided by verified votes under the competition rules.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : data.length === 0
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
