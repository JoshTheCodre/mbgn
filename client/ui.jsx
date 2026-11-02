import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  agoShort, api, num, recall, remember, shareTargets, useApp, useLive,
} from './lib.jsx';
import { THEMES, applyTheme, currentTheme } from './themes.js';

const FIELD_MIX = [100, 82, 92, 70, 88, 76, 96, 64];

// Used when a demo contestant has no photograph yet.
export function Portrait({ name, photoUrl, code, className = '' }) {
  if (photoUrl) {
    return (
      <img
        className={`portrait photo-loading ${className}`}
        src={photoUrl}
        alt={`Portrait of ${name}`}
        loading="lazy"
        decoding="async"
        onLoad={(e) => e.currentTarget.classList.remove('photo-loading')}
      />
    );
  }
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

// ---- Loading states ----
const Bone = ({ className = '', style }) => <span className={`skeleton ${className}`} style={style} aria-hidden="true" />;

// Announces the wait to screen readers, and reassures anyone left waiting a long time.
function Waiting({ label }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(id);
  }, []);
  return (
    <>
      <span className="visually-hidden" role="status">{label}</span>
      {slow ? <p className="muted slow-note">Still loading. This is taking longer than usual.</p> : null}
    </>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <div className="skeleton-lines">
      <Bone style={{ width: '62%' }} />
      <Bone style={{ width: '88%' }} />
      <Bone style={{ width: '74%' }} />
      <Waiting label={label} />
    </div>
  );
}

export function RankSkeleton({ count = 5 }) {
  return (
    <div className="ranks-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rank-skeleton">
          <Bone className="bone-pos" />
          <Bone className="bone-face" />
          <span className="bone-who">
            <Bone style={{ width: `${70 - (i % 3) * 12}%` }} />
            <Bone className="bone-small" style={{ width: `${48 - (i % 2) * 10}%` }} />
          </span>
          <Bone className="bone-votes" />
        </div>
      ))}
      <Waiting label="Loading the leaderboard" />
    </div>
  );
}

export function CardsSkeleton({ count = 8 }) {
  return (
    <>
      <div className="card-grid" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="card">
            <div className="card-photo"><Bone className="bone-fill" /></div>
            <div className="card-body">
              <Bone style={{ width: '65%' }} />
              <Bone className="bone-small" style={{ width: '40%' }} />
              <Bone className="bone-small" style={{ width: '75%' }} />
            </div>
          </div>
        ))}
      </div>
      <Waiting label="Loading the contestants" />
    </>
  );
}

export function FeedSkeleton({ count = 5 }) {
  return (
    <div className="feed-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Bone style={{ width: `${44 + (i % 3) * 8}%` }} />
          <Bone className="bone-amount" />
        </div>
      ))}
      <Waiting label="Loading recent votes" />
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="wrap page profile">
      <div className="profile-photo"><Bone className="bone-fill" /></div>
      <div className="profile-main skeleton-lines">
        <Bone className="bone-small" style={{ width: '36%' }} />
        <Bone className="bone-title" style={{ width: '58%' }} />
        <Bone className="bone-panel" />
        <Bone className="bone-panel bone-panel-tall" />
        <Waiting label="Loading this contestant" />
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="wrap page skeleton-lines">
      <Bone className="bone-title" style={{ width: '42%' }} />
      <Bone style={{ width: '68%' }} />
      <Bone className="bone-panel bone-panel-tall" />
      <Waiting label="Loading this page" />
    </div>
  );
}

export function CoverSkeleton() {
  return <div className="cover-float"><div className="cover skeleton" aria-hidden="true" /></div>;
}

export function LoadFailed({ error, onRetry, what = 'this' }) {
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    await onRetry();
    setBusy(false);
  }
  return (
    <div className="load-failed" role="alert">
      <p><b>We couldn’t load {what}.</b> {error?.status ? 'Please try again.' : 'Check your connection and try again.'}</p>
      <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={retry}>{busy ? 'Trying…' : 'Try again'}</button>
    </div>
  );
}

// Shown from the first moment, before any of the site's scripts have arrived.
export function BootScreen() {
  return (
    <>
      <header className="site-header">
        <div className="wrap header-row"><span className="logo">MBGN</span></div>
      </header>
      <main className="boot" role="status" aria-label="Loading">
        <Crown className="boot-crown" />
        <span className="boot-bar" aria-hidden="true"><i /></span>
      </main>
    </>
  );
}

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

export function Timer({ target, label, compact = false }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, new Date(target).getTime() - now);
  const parts = [
    ['Days', Math.floor(left / 864e5)],
    ['Hrs', Math.floor(left / 36e5) % 24],
    ['Min', Math.floor(left / 6e4) % 60],
    ['Sec', Math.floor(left / 1e3) % 60],
  ];
  return (
    <div className={`countdown ${compact ? 'compact' : ''}`} role="timer" aria-label={`${label} ${parts[0][1]} days`}>
      <span className="countdown-label">{label}</span>
      <div className="countdown-parts">
        {parts.map(([name, value]) => (
          <span key={name} className="countdown-part">
            <b key={value} className="tick">{pad(value)}</b>
            <small>{name}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

// Counts down to whichever moment matters next: voting opening, or voting closing.
export function Countdown({ competition, compact = false }) {
  if (!competition) {
    return (
      <div className={`countdown ${compact ? 'compact' : ''}`} aria-hidden="true">
        <span className="countdown-label">Voting closes in</span>
        <div className="countdown-parts">
          {['Days', 'Hrs', 'Min', 'Sec'].map((label) => (
            <span key={label} className="countdown-part">
              <b className="skeleton-text">00</b>
              <small>{label}</small>
            </span>
          ))}
        </div>
      </div>
    );
  }
  const { voting, startsAt, endsAt } = competition;

  if (voting.status === 'registration') return <p className="count-note">{voting.message}</p>;
  if (voting.status === 'paused') return <p className="count-note">Voting is paused. Please check back soon.</p>;
  if (voting.status === 'closed') return <p className="count-note">Voting has closed.</p>;

  const target = voting.status === 'upcoming' ? startsAt : endsAt;
  if (!target) return <p className="count-note">Voting is open.</p>;
  return <Timer target={target} label={voting.status === 'upcoming' ? 'Voting opens in' : 'Voting closes in'} compact={compact} />;
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

const BRAND_LOGOS = {
  whatsapp: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
  facebook: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
};

const BrandLogo = ({ name }) => (
  <svg className="brand-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={BRAND_LOGOS[name]} /></svg>
);

// The share panel on the registration pages: a card of its own.
export function ShareCard({ title, text, message }) {
  const targets = shareTargets(window.location.origin, message);

  return (
    <section className="wrap section" id="share">
      <div className="share-card">
        <div className="share-card-copy">
          <p className="eyebrow">Spread the word</p>
          <h2>{title}</h2>
          <p className="muted">{text}</p>
        </div>
        <div className="share-line">
          <a className="btn btn-whatsapp" href={targets.whatsapp} target="_blank" rel="noreferrer"><BrandLogo name="whatsapp" />WhatsApp</a>
          <a className="btn btn-facebook" href={targets.facebook} target="_blank" rel="noreferrer"><BrandLogo name="facebook" />Facebook</a>
          <a className="btn btn-x" href={targets.x} target="_blank" rel="noreferrer" aria-label="Share on X"><BrandLogo name="x" />Post</a>
        </div>
      </div>
    </section>
  );
}

export function ShareButtons({ url, name, message }) {
  const [copied, setCopied] = useState(false);
  const text = message ?? `Vote for ${name} on Most Beautiful Girl Online Nigeria!`;
  const targets = shareTargets(url, text);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="share-line share-line-four">
      <a className="btn btn-whatsapp" href={targets.whatsapp} target="_blank" rel="noreferrer"><BrandLogo name="whatsapp" />WhatsApp</a>
      <a className="btn btn-facebook" href={targets.facebook} target="_blank" rel="noreferrer"><BrandLogo name="facebook" />Facebook</a>
      <a className="btn btn-x" href={targets.x} target="_blank" rel="noreferrer" aria-label="Share on X"><BrandLogo name="x" />Post</a>
      <button type="button" className="btn btn-ghost" onClick={copy}>
        <svg className="brand-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
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
  useLive('notification', (n) => add({ ...n, private: true }));

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
  const path = `/activity?limit=${limit}`;
  const [items, setItems] = useState(() => recall(path));
  const [error, setError] = useState(null);
  const [, tick] = useState(0);
  const load = () => api(path)
    .then((next) => {
      remember(path, next);
      setItems(next);
      setError(null);
    })
    .catch(setError);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [limit]);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);
  useLive('activity', (a) => setItems((prev) => [a, ...(prev ?? [])].slice(0, limit)));
  useLive('activity_refresh', () => load());

  if (!items) return error ? <LoadFailed error={error} onRetry={load} what="recent votes" /> : <FeedSkeleton count={limit} />;
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
  const root = useRef(null);

  // Clicking or tapping anywhere else, or pressing Escape, closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!competition?.themePicker) return null;
  const selected = THEMES.find((t) => t.id === active) ?? THEMES[0];
  const swatch = (t) => ({ background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})` });

  return (
    <div className="theme-picker" ref={root}>
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
      <button type="button" className="theme-toggle" aria-label={`Theme: ${selected.name}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="theme-swatch" style={swatch(selected)} />
        Theme
      </button>
    </div>
  );
}
