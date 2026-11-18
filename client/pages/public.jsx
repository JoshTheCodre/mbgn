import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, ago, api, naira, num, plural, registrationOpen, useApp, useFetch, useLive,
} from '../lib.jsx';
import { bulkPrice, paymentCharges, upsellOffers } from '../../shared/pricing.js';
import {
  ActivityFeed, BrandLogo, CardsSkeleton, CodeTag, CoverSkeleton, Crown, Countdown, Dialog, ErrorNote, Field, LoadFailed,
  Loading, Movement, PLATFORM_NAMES, PageSkeleton, Portrait, ProfileSkeleton, RankSkeleton, CountUp, ShareButton, ShareCard, Timer,
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
            <p>Each vote is {naira(competition?.votePrice ?? 200)}, and bulk votes cost less.</p>
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
  const { user, competition, refreshCompetition } = useApp();
  const [countdownOver, setCountdownOver] = useState(false);
  const open = registrationOpen(competition) && !countdownOver;
  const startsByItself = Boolean(competition.autoStartVoting);

  // The server starts voting when the countdown ends. Ask until it has, then Home moves on.
  useEffect(() => {
    if (!countdownOver) return undefined;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (tries > 20) clearInterval(id);
      refreshCompetition({ fresh: true }).catch(() => {});
    }, 3000);
    refreshCompetition({ fresh: true }).catch(() => {});
    return () => clearInterval(id);
  }, [countdownOver, refreshCompetition]);
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
              : countdownOver && startsByItself ? 'Registration has closed. Voting is opening now…'
                : 'Applications are closed and voting opens soon. Get ready to support your favourite.'}</p>
            {open && endsAt ? <Timer target={endsAt} label={startsByItself ? 'Registration closes and voting opens in' : 'Registration closes in'} onEnd={() => setCountdownOver(true)} /> : null}
            <div className="reg-actions">
              {open || joined ? <Link to={joinTo} className="btn btn-primary reg-join">{joinLabel}</Link> : null}
              <Link to="/enquiry" className="btn reg-share-link">Sponsorship / Enquiry</Link>
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
                <h3>Join and pass the follower check</h3>
                <p>Add your photo and details. You need at least {num(competition?.minFollowers ?? 500)} followers on Instagram, TikTok or Facebook, and we check it on the spot.</p>
              </li>
              <li>
                <h3>Get approved</h3>
                <p>You get your WhatsApp group link straight away. Once our team approves you, you get your own code and voting link.</p>
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

// What it takes to survive the round that is on now.
function RoundNote({ round, light = false }) {
  const rules = [
    round.keepTop ? `the top ${num(round.keepTop)} go through` : null,
    round.minVotes ? `each contestant needs ${num(round.minVotes)} votes${round.votesCounted === 'round' ? ' this round' : ''}` : null,
  ].filter(Boolean).join(', and ');
  const rest = round.probation ? `The next ${num(round.probation)} go on probation, and the rest are eliminated.` : 'The rest are eliminated.';
  return <p className={`round-note ${light ? 'light' : ''}`}><b>{round.name}:</b> when it ends, {rules}. {rest}</p>;
}

export function Home() {
  const { competition } = useApp();
  const navigate = useNavigate();
  const phase = competition?.phase;
  const before = useRef(phase);
  // Anyone on the home page when voting begins is taken straight to the contestants to vote.
  useEffect(() => {
    if (before.current === 'registration' && phase === 'voting') navigate('/contestants');
    before.current = phase;
  }, [phase, navigate]);
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
            {competition?.round ? <Timer target={competition.round.endsAt} label={`${competition.round.name} ends in`} /> : <Countdown competition={competition} />}
            {competition?.round ? <RoundNote round={competition.round} light /> : null}
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

// Lists load a page at a time, so a contest with thousands of contestants stays quick on a phone.
const PAGE = 200;
function usePaging(query) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [query]);
  const path = `/leaderboard?${query ? `${query}&` : ''}limit=${limit}`;
  return { path, limit, more: () => setLimit((n) => n + PAGE) };
}

function ShowMore({ shown, total, limit, onMore }) {
  if (shown < limit) return null;
  return (
    <div className="show-more">
      <p className="muted small-note">Showing {num(shown)}{total > shown ? ` of ${num(total)}` : ''}</p>
      <button type="button" className="btn btn-ghost" onClick={onMore}>Show more</button>
    </div>
  );
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
  const paging = usePaging(f.query);
  const { data, error, reload } = useFetch(paging.path);
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
      {data ? <ShowMore shown={data.rows.length} total={f.query ? 0 : data.total} limit={paging.limit} onMore={paging.more} /> : null}
      <p className="muted small-note">Ranked by total verified votes. If two contestants tie, the one who reached that total first stays ahead. Movement compares with 24 hours ago.</p>
    </div>
  );
});

export const Contestants = whileVoting(() => {
  const f = useBoardFilters();
  const paging = usePaging(f.query);
  const { data, error, reload } = useFetch(paging.path);
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
      {data ? <ShowMore shown={data.rows.length} total={f.query ? 0 : data.total} limit={paging.limit} onMore={paging.more} /> : null}
    </div>
  );
});

// Shown every time someone goes to pay: a bigger amount is always one tap away, and saying no
// is just as easy.
function UpsellDialog({ open, votes, offers, votePrice, contestant, onPick, onClose }) {
  const current = offers.length ? offers[0].price - offers[0].extra : 0;
  const best = offers[0];
  return (
    <Dialog open={open} onClose={onClose} title={best ? `Give ${contestant.name} ${num(best.votes)} votes for ${naira(best.price)}` : 'Get more votes for your money'}>
      <p className="muted">Bulk votes cost less each, and every vote moves {contestant.name} ({contestant.code}) up the leaderboard.</p>
      <ul className="upsell-offers">
        {offers.map((o, i) => (
          <li key={o.votes}>
            <button type="button" className={`upsell-offer ${i === 0 ? 'best' : ''}`} onClick={() => onPick(o.votes)}>
              {i === 0 ? <span className="upsell-tag">Most popular</span> : null}
              <span className="upsell-votes"><b>{num(o.votes)}</b> votes for {contestant.name}</span>
              <span className="upsell-price">{naira(o.price)}</span>
              <small>
                {naira(Math.round(o.price / o.votes))} a vote{o.saving > 0 ? ` · save ${naira(o.saving)}` : ''}
                {o.extra > 0 ? ` · only ${naira(o.extra)} more` : ''}
                {` · plus ${naira(paymentCharges(o.price))} charges`}
              </small>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="text-link as-button upsell-decline" onClick={() => onPick(votes)}>
        No thanks, pay {naira(current + paymentCharges(current))} for {plural(votes, 'vote')}
      </button>
      {votePrice ? <p className="muted small-note">Normal price: {naira(votePrice)} a vote.</p> : null}
    </Dialog>
  );
}

const PayIcon = ({ d }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
// Card opens Paystack with card first, and its other ways (USSD, QR) there too. Short labels on
// phones, fuller ones where there's room.
const PAY_OPTIONS = [
  { id: 'transfer', label: 'Transfer', wide: 'Bank transfer', icon: <PayIcon d="M3 10h18M5 10v8m4.5-8v8m5-8v8M19 10v8M3 21h18M12 3 3 8h18z" />, button: 'by transfer' },
  { id: 'opay', label: 'OPay', wide: 'OPay', logo: true, icon: <img className="opay-logo" src="/pay/opay.png" width="141" height="48" alt="" />, button: 'with OPay' },
  { id: 'any', label: 'Card', wide: 'Pay with card', logo: true, icon: <img className="card-logo" src="/pay/mastercard.png" width="76" height="48" alt="" />, button: 'by card' },
];

// One slim row. A bank transfer opens an account number right here; the others go to Paystack.
function PayWith({ method, onChange }) {
  return (
    <div className="pay-row" role="radiogroup" aria-label="Pay with">
      {PAY_OPTIONS.map((o) => (
        <label key={o.id} className={`pay-pill ${method === o.id ? 'on' : ''}`}>
          <input type="radio" name="payMethod" value={o.id} checked={method === o.id} onChange={() => onChange(o.id)} />
          <span className={`pay-icon ${o.logo ? 'pay-icon-logo' : ''}`}>{o.icon}</span>
          <span className="pay-label">{o.label}</span>
          <span className="pay-label-wide">{o.wide}</span>
        </label>
      ))}
    </div>
  );
}

function VotePanel({ contestant, viaLink }) {
  const { competition } = useApp();
  const navigate = useNavigate();
  const [quantity, setQuantity] = useState(5);
  const [custom, setCustom] = useState('');
  const [voterName, setVoterName] = useState(() => {
    try { return localStorage.getItem('mbgn-voter-name') ?? ''; } catch { return ''; }
  });
  const [method, setMethod] = useState(() => {
    try {
      const saved = localStorage.getItem('mbgn-pay-method');
      return saved === 'any' || PAY_OPTIONS.some((o) => o.id === saved) ? saved : 'transfer';
    } catch { return 'transfer'; }
  });
  const [other, setOther] = useState(false);
  const [offering, setOffering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const packages = competition?.packages ?? [];
  const votePrice = competition?.votePrice ?? 0;
  const priceOf = (n) => bulkPrice(n, votePrice, packages);
  const amount = other ? Number(custom) : quantity;
  const valid = Number.isInteger(amount) && amount > 0;
  const voting = competition?.voting;
  // One row: the usual amounts and the bulk deals together, smallest first.
  const amounts = [...new Set([1, 5, 10, 20, ...packages.map((p) => p.votes)])].sort((a, b) => a - b);
  const savingOn = (n) => {
    const deal = packages.find((p) => p.votes === n);
    return deal ? n * votePrice - deal.price : 0;
  };
  const price = valid ? priceOf(amount) : 0;
  const fee = valid ? paymentCharges(price) : 0;
  const rate = valid ? price / amount : votePrice;
  // A bigger amount is only suggested when it saves a lot (NGN 1,000 or more) for at most twice the spend.
  const offers = valid ? upsellOffers(amount, votePrice, packages).filter((o) => o.saving >= 1000 && o.price <= price * 2) : [];

  function choose(n) {
    setOther(false);
    setQuantity(n);
    setError(null);
  }

  function askFirst(e) {
    e.preventDefault();
    if (voterName.trim().length < 2) {
      setError(new Error('Please enter your name. It goes on your proof of vote.'));
      return;
    }
    setError(null);
    if (offers.length) setOffering(true);
    else pay(amount);
  }

  async function pay(votes) {
    setOffering(false);
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('mbgn-voter-name', voterName.trim());
      localStorage.setItem('mbgn-pay-method', method);
    } catch { /* a convenience only */ }
    try {
      const started = await api('/votes/pay', { body: { code: contestant.code, quantity: votes, voterName, method, viaLink } });
      if (started.transfer) navigate(`/pay/transfer/${started.reference}`);
      else window.location.assign(started.checkoutUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (voting && !voting.open) return <div className="vote-panel"><p className="note">{voting.message}</p></div>;

  return (
    <form className="vote-panel" onSubmit={askFirst}>
      <h2 className="vote-step">How many votes?</h2>
      <div className="vote-amounts" role="group" aria-label="Number of votes">
        {amounts.map((n) => {
          const active = !other && quantity === n;
          const saving = savingOn(n);
          return (
            <button key={n} type="button" className={`amount ${active ? 'active' : ''} ${saving > 0 ? 'amount-deal' : ''}`} aria-pressed={active} onClick={() => choose(n)}
              aria-label={`${plural(n, 'vote')}${saving > 0 ? `, save ${naira(saving)}` : ''}`}>
              <b>{num(n)}</b>
              {saving > 0 ? <small>save {naira(saving)}</small> : null}
            </button>
          );
        })}
        <button type="button" className={`amount ${other ? 'active' : ''}`} aria-pressed={other} onClick={() => { setOther(true); setError(null); }}>
          <b>Other</b>
        </button>
      </div>
      {other ? (
        <input
          className="qty-custom"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          placeholder="How many votes?"
          aria-label="How many votes?"
          value={custom}
          autoFocus
          onChange={(e) => { setCustom(e.target.value); setError(null); }}
        />
      ) : null}
      {valid ? (
        <p className="vote-sum">
          <b>{plural(amount, 'vote')} · {naira(price + fee)}</b>
          {rate < votePrice ? <small>Bulk price: {naira(Math.round(rate))} a vote</small> : null}
        </p>
      ) : null}
      <Field hint={`${contestant.name} sees this name with your votes.`}>
        <input value={voterName} onChange={(e) => setVoterName(e.target.value)} maxLength={60} autoComplete="name" required
          placeholder="Type your name or nickname" aria-label="Your name or nickname" />
      </Field>

      {valid ? (
        <>
          <PayWith method={method} onChange={setMethod} />
          <button className="btn btn-vote btn-wide" disabled={busy}>
            {busy
              ? (method === 'transfer' ? 'Getting your account number…' : 'Opening checkout…')
              : `Pay ${naira(price + fee)} ${PAY_OPTIONS.find((o) => o.id === method)?.button ?? 'and vote'}`}
          </button>
        </>
      ) : null}
      <ErrorNote error={error} />
      <UpsellDialog open={offering} votes={amount} offers={offers} votePrice={votePrice} contestant={contestant} onPick={pay} onClose={() => setOffering(false)} />
    </form>
  );
}

// "@stella" from instagram.com/stella or tiktok.com/@stella, so a profile link shows whose it is.
function socialHandle(link, platform) {
  try {
    const first = new URL(link).pathname.split('/').filter(Boolean)[0];
    if (!first || ['people', 'pages', 'profile.php'].includes(first)) return `${PLATFORM_NAMES[platform]} page`;
    const name = decodeURIComponent(first).replace(/^@/, '');
    return platform === 'facebook' ? name : `@${name}`;
  } catch {
    return PLATFORM_NAMES[platform];
  }
}

// Someone arriving from outside the site came through a shared voting link. Remembered for the
// visit, so the vote it leads to counts as through her link, whichever of her pages it's made on.
function useViaLink(code) {
  const [params] = useSearchParams();
  return useMemo(() => {
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
}

function ContestantError({ error, onRetry }) {
  if (error.status === 410) {
    return (
      <div className="wrap page">
        <h1>No longer in the contest</h1>
        <p className="muted">{error.message}</p>
        <Link to="/contestants" className="btn btn-primary">See who is still in</Link>
      </div>
    );
  }
  // Only a real "no such code" means that. Anything else is a problem on our side or the connection.
  if (error.status !== 404) return <div className="wrap page"><LoadFailed error={error} onRetry={onRetry} what="this contestant" /></div>;
  return (
    <div className="wrap page">
      <h1>We could not find that contestant</h1>
      <p className="muted">{error.message} Check the code and try again.</p>
      <Link to="/contestants" className="btn btn-primary">Browse all contestants</Link>
    </div>
  );
}

// Her page, in one phone screen: photo, name and town, votes, a short about, and the Vote
// button. Voting itself is the next page.
export function Profile() {
  const { competition } = useApp();
  const { code } = useParams();
  const { data, error, reload } = useFetch(`/contestants/${encodeURIComponent(code)}`);
  useLive('leaderboard', reload);
  useViaLink(code);

  if (error && !data) return <ContestantError error={error} onRetry={reload} />;
  if (!data) return <ProfileSkeleton />;

  const voting = competition?.voting;
  const url = `${window.location.origin}/c/${data.code}`;
  const socials = ['tiktok', 'instagram', 'facebook'].filter((id) => data[id])
    .map((id) => ({ id, url: data[id], name: PLATFORM_NAMES[id], handle: socialHandle(data[id], id) }));
  return (
    <div className="wrap page profile">
      <div className="profile-photo"><Portrait name={data.name} photoUrl={data.photoUrl} code={data.code} /></div>
      <h1 className="profile-name">
        {data.name}
        <span className="profile-place">{data.location}, {data.state}</span>
        {data.onProbation ? <em className="tag tag-review probation-tag">On probation</em> : null}
      </h1>
      {competition?.phase === 'voting' ? (
        <p className="profile-line">
          <span><b><CountUp value={data.totalVotes} /></b> votes</span>
          <span>No. <b><CountUp value={data.position} /></b></span>
          <Movement value={data.movement24h} />
        </p>
      ) : null}
      {data.bio ? (
        <section className="profile-about" aria-labelledby="about-heading">
          <h2 id="about-heading">About</h2>
          <p className="profile-bio">{data.bio}</p>
        </section>
      ) : null}
      {voting?.open ? (
        <Link to={`/c/${data.code}/vote`} className="btn btn-vote btn-wide profile-vote">
          <span>Vote {data.name} · <span className="profile-vote-code">{data.code}</span></span>
        </Link>
      ) : <p className="note">{voting?.message ?? 'Voting opens soon.'}</p>}
      {competition?.phase === 'voting' && competition.round ? <RoundNote round={competition.round} /> : null}
      <div className="profile-actions">
        {socials.map((s) => (
          <a key={s.id} className="social-icon" href={s.url} target="_blank" rel="noreferrer noopener" aria-label={`${data.name} on ${s.name}: ${s.handle}`} title={`${s.name}: ${s.handle}`}>
            <span className={`follower-logo follower-logo-${s.id}`}><BrandLogo name={s.id} /></span>
          </a>
        ))}
        <ShareButton url={url} name={data.name} label="Share her link" />
      </div>
    </div>
  );
}

// Voting for her: how many votes, a name, how to pay, and Pay, all in one phone screen.
export function VotePage() {
  const { code } = useParams();
  const { data, error } = useFetch(`/contestants/${encodeURIComponent(code)}`);
  const viaLink = useViaLink(code);
  // Her page says what's wrong (eliminated, no such code, or a connection problem).
  if (error && !data) return <Navigate to={`/c/${encodeURIComponent(code)}`} replace />;
  if (!data) return <div className="wrap page vote-page"><Loading /></div>;
  return (
    <div className="wrap page vote-page">
      <Link to={`/c/${data.code}`} className="vote-who" aria-label={`Back to ${data.name}’s page`}>
        <span className="vote-who-back" aria-hidden="true">←</span>
        <span className="vote-who-photo"><Portrait name={data.name} photoUrl={data.photoUrl} code={data.code} /></span>
        <span className="vote-who-text"><b>{data.name}</b><small>{data.code} · {data.location}, {data.state}</small></span>
      </Link>
      <VotePanel contestant={data} viaLink={viaLink} />
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
