import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { agoShort, api, num, shareTargets, useApp, useLive } from './lib.jsx';
import { THEMES, applyTheme, currentTheme } from './themes.js';

const FIELD_MIX = [100, 82, 92, 70, 88, 76, 96, 64];

// Used when a demo contestant has no photograph yet.
export function Portrait({ name, photoUrl, code, className = '' }) {
  if (photoUrl) return <img className={`portrait ${className}`} src={photoUrl} alt={`Portrait of ${name}`} loading="lazy" />;
  const seed = [...(code ?? name ?? '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return (
    <div className={`portrait monogram ${className}`} style={{ '--field': `color-mix(in srgb, var(--accent) ${FIELD_MIX[seed % FIELD_MIX.length]}%, var(--mono-end))` }} role="img" aria-label={`Placeholder for ${name}`}>
      <span aria-hidden="true">{(name ?? '?').charAt(0)}</span>
    </div>
  );
}

export const CodeTag = ({ code, inline = false }) => (code ? <span className={`code-tag ${inline ? 'inline' : ''}`}>{code}</span> : null);

// Always real gold, whatever the theme.
export function Crown({ className = '' }) {
  return (
    <svg className={`crown ${className}`} viewBox="-1 -1 50 38" aria-hidden="true">
      <defs>
        <linearGradient id="crown-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe680" />
          <stop offset=".55" stopColor="#f5b800" />
          <stop offset="1" stopColor="#c98a00" />
        </linearGradient>
      </defs>
      <path fill="url(#crown-gold)" d="M4 10l10 9L24 3l10 16 10-9-4 23H8L4 10z" />
      <circle fill="url(#crown-gold)" cx="4" cy="8" r="3" />
      <circle fill="url(#crown-gold)" cx="24" cy="3" r="3" />
      <circle fill="url(#crown-gold)" cx="44" cy="8" r="3" />
    </svg>
  );
}

export function Dialog({ open, onClose, title, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dialog-body">
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {open ? children : null}
      </div>
    </dialog>
  );
}

export const ErrorNote = ({ error }) => (error ? <p className="note note-error" role="alert">{error.message ?? String(error)}</p> : null);
export const Loading = ({ label = 'Loading…' }) => <p className="muted loading" role="status">{label}</p>;

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Counts down to whichever moment matters next: voting opening, or voting closing.
export function Countdown({ competition, compact = false }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!competition) return null;
  const { voting, startsAt, endsAt } = competition;

  if (voting.status === 'paused') return <p className="count-note">Voting is paused. Please check back soon.</p>;
  if (voting.status === 'closed') return <p className="count-note">Voting has closed.</p>;

  const target = voting.status === 'upcoming' ? startsAt : endsAt;
  if (!target) return <p className="count-note">Voting is open.</p>;
  const left = Math.max(0, new Date(target).getTime() - now);
  const parts = [
    ['Days', Math.floor(left / 864e5)],
    ['Hrs', Math.floor(left / 36e5) % 24],
    ['Min', Math.floor(left / 6e4) % 60],
    ['Sec', Math.floor(left / 1e3) % 60],
  ];
  return (
    <div className={`countdown ${compact ? 'compact' : ''}`} role="timer" aria-label={`${voting.status === 'upcoming' ? 'Voting opens in' : 'Voting closes in'} ${parts[0][1]} days`}>
      <span className="countdown-label">{voting.status === 'upcoming' ? 'Voting opens in' : 'Voting closes in'}</span>
      <div className="countdown-parts">
        {parts.map(([label, value]) => (
          <span key={label} className="countdown-part">
            <b key={value} className="tick">{pad(value)}</b>
            <small>{label}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

const COUNT_MS = 700;

// Waits at 0 until scrolled into view, then counts quickly up to the number.
// After that, it counts from the old number to the new one whenever it changes.
export function CountUp({ value, plain = false }) {
  const still = plain || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const element = useRef(null);
  const [seen, setSeen] = useState(still);
  const [shown, setShown] = useState(still ? value : 0);
  const current = useRef(still ? value : 0);

  useEffect(() => {
    if (seen) return undefined;
    if (!('IntersectionObserver' in window)) {
      setSeen(true);
      return undefined;
    }
    // The margins allow for the sticky header, and start the count just inside the screen.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setSeen(true);
    }, { rootMargin: '-70px 0px -6% 0px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return undefined;
    if (still) {
      current.current = value;
      setShown(value);
      return undefined;
    }
    const from = current.current;
    const started = performance.now();
    let frame;
    const step = (now) => {
      const progress = Math.min(1, (now - started) / COUNT_MS);
      const next = Math.round(from + (value - from) * (1 - (1 - progress) ** 3));
      current.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, seen, still]);

  if (plain) return num(value);
  return (
    <span className="count" ref={element}>
      <span className="visually-hidden">{num(value)}</span>
      <span aria-hidden="true">{num(shown)}</span>
    </span>
  );
}

export function Movement({ value, plain = false }) {
  if (value == null) return <span className="move move-new">New</span>;
  if (value > 0) return <span className="move move-up" title={`Up ${value} in 24 hours`}><span className="move-icon" aria-hidden="true">▲</span> +<CountUp value={value} plain={plain} /></span>;
  if (value < 0) return <span className="move move-down" title={`Down ${-value} in 24 hours`}><span className="move-icon" aria-hidden="true">▼</span> -<CountUp value={-value} plain={plain} /></span>;
  return <span className="move move-flat" title="No change in 24 hours">No change</span>;
}

export function ShareButtons({ url, name }) {
  const [copied, setCopied] = useState(false);
  const text = `Vote for ${name} on Most Beautiful Girl Online Nigeria!`;
  const targets = shareTargets(url, text);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  async function nativeShare() {
    await navigator.share({ title: 'MBGN', text, url }).catch(() => {});
  }

  return (
    <div className="share-row">
      <a className="btn btn-whatsapp" href={targets.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>
      <a className="btn btn-ghost" href={targets.facebook} target="_blank" rel="noreferrer">Facebook</a>
      <a className="btn btn-ghost" href={targets.x} target="_blank" rel="noreferrer">X</a>
      {navigator.share ? <button type="button" className="btn btn-ghost" onClick={nativeShare}>Share…</button> : null}
      <button type="button" className="btn btn-ghost" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
    </div>
  );
}

// Pop-up voting activity for everyone, plus private alerts for the logged-in contestant.
export function LivePopups() {
  const [items, setItems] = useState([]);
  const timers = useRef(new Set());

  function add(item) {
    const key = `${item.private ? 'p' : 'a'}${item.id}`;
    setItems((prev) => [...prev.filter((p) => p.key !== key), { ...item, key }].slice(-3));
    const t = setTimeout(() => setItems((prev) => prev.filter((p) => p.key !== key)), 6500);
    timers.current.add(t);
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useLive('activity', (a) => add(a));
  useLive('notification', (n) => {
    if (n.kind !== 'wallet') add({ ...n, private: true });
  });

  return (
    <div className="popups" aria-live="polite">
      {items.map((item) => {
        const body = (
          <>
            <span className="popup-tag">{item.private ? 'Just for you' : 'Live'}</span>
            <span>{item.message}</span>
          </>
        );
        return item.code && !item.private
          ? <Link key={item.key} to={`/c/${item.code}`} className="popup">{body}</Link>
          : <div key={item.key} className={`popup ${item.private ? 'popup-private' : ''}`}>{body}</div>;
      })}
    </div>
  );
}

// The latest real vote, in the header. Each new one slides in.
export function HeaderPulse() {
  const [latest, setLatest] = useState(null);
  const isVote = (item) => item?.kind === 'votes' && item.code && item.amount;
  useEffect(() => {
    let live = true;
    api('/activity?limit=5').then((items) => {
      if (live) setLatest(items.find(isVote) ?? null);
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  useLive('activity', (item) => { if (isVote(item)) setLatest(item); });

  if (!latest) return null;
  return (
    <Link to={`/c/${latest.code}`} className="header-pulse" aria-label={latest.message}>
      <span className="header-pulse-dot" key={`dot-${latest.id}`} aria-hidden="true" />
      <span className="header-pulse-text" key={latest.id} aria-hidden="true">
        {latest.name} <b>+{num(latest.amount)}</b>
      </span>
    </Link>
  );
}

function FeedAmount({ item }) {
  if (item.kind === 'climb') return <span className="feed-amount">up {num(item.amount)} {item.amount === 1 ? 'place' : 'places'}</span>;
  return <span className="feed-amount">+{num(item.amount)} {item.amount === 1 ? 'vote' : 'votes'}</span>;
}

export function ActivityFeed({ limit = 5 }) {
  const [items, setItems] = useState(null);
  const [, tick] = useState(0);
  const load = () => api(`/activity?limit=${limit}`).then(setItems).catch(() => setItems([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [limit]);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);
  useLive('activity', (a) => setItems((prev) => [a, ...(prev ?? [])].slice(0, limit)));
  useLive('activity_refresh', () => load());

  if (!items) return <Loading />;
  if (items.length === 0) return <p className="muted">The first votes will appear here as they come in.</p>;
  return (
    <ol className="feed">
      {items.map((item) => (
        <li key={item.id}>
          {item.code && item.amount ? (
            <Link to={`/c/${item.code}`} aria-label={item.message}>
              <span className="feed-name">{item.name}</span>
              <FeedAmount item={item} />
            </Link>
          ) : <span className="feed-note">{item.message}</span>}
          <time dateTime={item.createdAt}>{agoShort(item.createdAt)}</time>
        </li>
      ))}
    </ol>
  );
}

// Lets the team compare looks on the real site. The server hides it in production.
export function ThemePicker() {
  const { competition } = useApp();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(currentTheme);
  if (!competition?.themePicker) return null;
  const selected = THEMES.find((t) => t.id === active) ?? THEMES[0];
  const swatch = (t) => ({ background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})` });

  return (
    <div className="theme-picker">
      {open ? (
        <div className="theme-list" role="group" aria-label="Choose a theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-option ${t.id === active ? 'active' : ''}`}
              aria-pressed={t.id === active}
              onClick={() => { applyTheme(t.id); setActive(t.id); }}
            >
              <span className="theme-swatch" style={swatch(t)} />
              <span><b>{t.name}</b><small>{t.vibe}</small></span>
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="theme-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="theme-swatch" style={swatch(selected)} />
        {open ? 'Close' : `Theme: ${selected.name}`}
      </button>
    </div>
  );
}
