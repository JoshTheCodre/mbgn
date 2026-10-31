import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method, body, form } = {}) {
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
const EVENTS = ['activity', 'activity_refresh', 'leaderboard', 'competition', 'notification', 'wallet', 'admin'];

function openStream() {
  source?.close();
  source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => {
      const data = JSON.parse(e.data);
      for (const fn of listeners.get(name) ?? []) fn(data);
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
  const [competition, setCompetition] = useState(null);

  const refreshUser = useCallback(async () => {
    const { user: next } = await api('/auth/me');
    setUser(next);
    return next;
  }, []);
  const refreshCompetition = useCallback(async () => {
    setCompetition(await api('/competition'));
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

  useLive('competition', () => refreshCompetition().catch(() => {}));
  useLive('wallet', () => refreshUser().catch(() => {}));

  return (
    <AppContext.Provider value={{ user, setUser, refreshUser, competition, refreshCompetition }}>
      {children}
    </AppContext.Provider>
  );
}

export function useFetch(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api(path);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((prev) => ({ data: prev.data, error, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true }));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);
  return { ...state, reload: load };
}

export const newVoteKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function shareTargets(url, text) {
  const message = encodeURIComponent(`${text} ${url}`);
  return {
    whatsapp: `https://wa.me/?text=${message}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    x: `https://twitter.com/intent/tweet?text=${message}`,
  };
}
