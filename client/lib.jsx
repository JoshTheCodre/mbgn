import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function send(path, { method, body, form } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: method ?? (body || form ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: form ?? (body ? JSON.stringify(body) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'We could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong. Please try again.', data);
  return data;
}

// Reads are tried twice: a dropped connection or a database waking from sleep shouldn't show as an error.
export async function api(path, options = {}) {
  const isRead = !options.method && !options.body && !options.form;
  try {
    return await send(path, options);
  } catch (err) {
    if (!isRead || (err.status && err.status < 500)) throw err;
    await new Promise((resolve) => { setTimeout(resolve, 1200); });
    return send(path, options);
  }
}

// ---- Showing the last known answer straight away, while the fresh one loads ----
const remembered = new Map();
// Only public data, so nothing private is left on a shared phone. These few also survive a return visit.
const isPublic = (path) => /^\/(competition|leaderboard|activity|results|contestants\/)/.test(path);
const KEPT_BETWEEN_VISITS = new Set(['/competition', '/leaderboard?limit=5', '/activity?limit=5', '/leaderboard?']);
const STORE_PREFIX = 'mbgn-cache:';

export function recall(path) {
  if (remembered.has(path)) return remembered.get(path);
  if (!KEPT_BETWEEN_VISITS.has(path)) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_PREFIX + path));
    return saved && Date.now() - saved.at < 864e5 ? saved.data : null;
  } catch {
    return null;
  }
}

export function remember(path, data) {
  if (!isPublic(path)) return;
  remembered.set(path, data);
  if (!KEPT_BETWEEN_VISITS.has(path)) return;
  try {
    localStorage.setItem(STORE_PREFIX + path, JSON.stringify({ at: Date.now(), data }));
  } catch { /* a convenience only */ }
}

// Checked against the clock too, so a page left open closes when the countdown ends.
export const registrationOpen = (competition) => {
  const registration = competition?.registration;
  if (!registration?.open) return false;
  return !registration.endsAt || Date.now() < new Date(registration.endsAt).getTime();
};

// ---- Formatting ----
export const num = (n) => Number(n ?? 0).toLocaleString('en-NG');
export const naira = (n) => `₦${num(n)}`;
export const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

export function dateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function shortDate(iso) {
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

export function ago(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  return shortDate(iso);
}

export function agoShort(iso) {
  const minutes = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// ---- Live events: one EventSource, reopened when the logged-in user changes ----
const listeners = new Map();
let source = null;
const EVENTS = ['activity', 'activity_refresh', 'leaderboard', 'competition', 'notification', 'admin'];

function notify(name, data) {
  for (const fn of listeners.get(name) ?? []) fn(data);
}

// On serverless hosting, a vote can reach a different instance from this page's live stream.
const REFRESH_MS = 20000;
let refreshTimer = null;

function openStream() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    notify('leaderboard', {});
    notify('activity_refresh', {});
    // So every open page moves on when an admin starts voting.
    notify('competition_check', {});
  }, REFRESH_MS);
  source?.close();
  source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => {
      const data = JSON.parse(e.data);
      notify(name, data);
    });
  }
}

export function useLive(event, handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const fn = (data) => latest.current(data);
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }, [event]);
}

// ---- App state ----
const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function AppProvider({ children }) {
  const [user, setUser] = useState(undefined);
  const [competition, setCompetition] = useState(() => recall('/competition'));

  const refreshUser = useCallback(async () => {
    const { user: next } = await api('/auth/me');
    setUser(next);
    return next;
  }, []);
  // `fresh` skips the edge cache, for when the contest has just changed.
  const refreshCompetition = useCallback(async ({ fresh = false } = {}) => {
    const next = await api(fresh ? `/competition?fresh=${Date.now()}` : '/competition');
    remember('/competition', next);
    setCompetition(next);
  }, []);

  useEffect(() => {
    refreshUser().catch(() => setUser(null));
    refreshCompetition().catch(() => {});
  }, [refreshUser, refreshCompetition]);

  // The stream authenticates when it opens, so reopen it on login and logout.
  const userId = user === undefined ? 'loading' : user?.id ?? 'guest';
  useEffect(() => {
    if (userId === 'loading') return undefined;
    openStream();
    return () => source?.close();
  }, [userId]);

  useLive('competition', () => refreshCompetition({ fresh: true }).catch(() => {}));
  useLive('competition_check', () => refreshCompetition().catch(() => {}));

  return (
    <AppContext.Provider value={{ user, setUser, refreshUser, competition, refreshCompetition }}>
      {children}
    </AppContext.Provider>
  );
}

export function useFetch(path, deps = []) {
  const [state, setState] = useState(() => ({ path, data: path ? recall(path) : null, error: null, loading: true }));
  const latest = useRef(path);
  latest.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api(path);
      remember(path, data);
      // An answer for a page we've since left must not replace what's showing.
      if (latest.current === path) setState({ path, data, error: null, loading: false });
    } catch (error) {
      if (latest.current === path) setState((prev) => ({ ...prev, path, error, loading: false }));
    }
  }, [path]);

  // New filters keep the old list up until the new one arrives. A different page,
  // such as another contestant, must never briefly show the last one's details.
  const samePage = state.path?.split('?')[0] === path?.split('?')[0];
  const view = state.path === path ? state : { path, data: (path && recall(path)) ?? (samePage ? state.data : null), error: null, loading: true };

  useEffect(() => {
    setState((prev) => (prev.path === path ? { ...prev, loading: true } : view));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);
  return { data: view.data, error: view.error, loading: view.loading, reload: load };
}

export function shareTargets(url, text) {
  const message = encodeURIComponent(`${text} ${url}`);
  return {
    whatsapp: `https://wa.me/?text=${message}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    x: `https://twitter.com/intent/tweet?text=${message}`,
  };
}
