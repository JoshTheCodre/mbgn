import {
  Component, Suspense, lazy, useEffect, useRef, useState,
} from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider, api, useApp } from './lib.jsx';
import {
  HeaderPulse, LivePopups, Loading, PageSkeleton, ThemePicker,
} from './ui.jsx';
import { applyTheme, currentTheme } from './themes.js';
import { Contestants, Home, Leaderboard, NotFound, Profile, Results } from './pages/public.jsx';

// Voters only download the public pages up front. Everything else comes when it's needed.
const loadAccount = () => import('./pages/account.jsx');
const fromAccount = (name) => lazy(() => loadAccount().then((m) => ({ default: m[name] })));
const AdminLogin = fromAccount('AdminLogin');
const Forgot = fromAccount('Forgot');
const PayReturn = fromAccount('PayReturn');
const PaySim = fromAccount('PaySim');
const Receipt = fromAccount('Receipt');
const Register = fromAccount('Register');
const Reset = fromAccount('Reset');
const Dashboard = lazy(() => import('./pages/dashboard.jsx').then((m) => ({ default: m.Dashboard })));
const Admin = lazy(() => import('./pages/admin.jsx').then((m) => ({ default: m.Admin })));

function Header() {
  const { user, setUser } = useApp();
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const header = useRef(null);
  const links = useRef(null);
  const glide = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { setMenu(false); }, [location.pathname]);

  // The header tightens once scrolled, and its bottom edge shows how far down the page you are.
  useEffect(() => {
    let frame = null;
    const update = () => {
      frame = null;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      header.current?.style.setProperty('--scroll', room > 0 ? String(Math.min(1, window.scrollY / room)) : '0');
      setScrolled(window.scrollY > 12);
    };
    const onScroll = () => { if (frame === null) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [location.pathname]);

  // A highlight glides to whichever link is hovered, and rests on the current page.
  const moveGlide = (target) => {
    const el = glide.current;
    if (!el) return;
    el.style.opacity = target ? '1' : '0';
    if (target) {
      el.style.width = `${target.offsetWidth}px`;
      el.style.transform = `translateX(${target.offsetLeft}px)`;
    }
  };
  const restGlide = () => moveGlide(links.current?.querySelector('a.active'));
  useEffect(() => {
    restGlide();
    document.fonts?.ready.then(restGlide);
    window.addEventListener('resize', restGlide);
    return () => window.removeEventListener('resize', restGlide);
  }, [location.pathname]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    navigate('/');
  }

  return (
    <header className={`site-header ${scrolled ? 'scrolled' : ''}`} ref={header}>
      <div className="wrap header-row">
        <Link to="/" className="logo" aria-label="MBGN home">MBGN</Link>
        <button type="button" className="menu-btn" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="site-nav" onClick={() => setMenu((m) => !m)}>
          <span className="menu-lines" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <nav id="site-nav" className={`site-nav ${menu ? 'open' : ''}`} aria-label="Main">
          <div
            className="nav-links"
            ref={links}
            onMouseOver={(e) => moveGlide(e.target.closest('a'))}
            onFocus={(e) => moveGlide(e.target.closest('a'))}
            onMouseLeave={restGlide}
            onBlur={restGlide}
          >
            <span className="nav-glide" ref={glide} aria-hidden="true" />
            <NavLink to="/contestants">Contestants</NavLink>
            <NavLink to="/leaderboard">Leaderboard</NavLink>
            <NavLink to="/results">Winners</NavLink>
          </div>
          <span className="nav-spacer" />
          <HeaderPulse />
          {user?.role === 'admin' ? (
            <>
              <NavLink to="/admin">Admin</NavLink>
              <button type="button" className="nav-link-btn" onClick={logout}>Log out</button>
            </>
          ) : (
            user?.contestant
              ? <NavLink to="/dashboard">My dashboard</NavLink>
              : <NavLink to="/register" className="btn btn-primary btn-small">Join the contest</NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  const { competition } = useApp();
  const name = competition?.name ?? 'Most Beautiful Girl Online Nigeria';
  return (
    <footer className="site-footer">
      <div className="wrap footer-top">
        <div className="footer-brand">
          <Link to="/" className="logo">MBGN</Link>
          <p>{name}</p>
        </div>
        <nav aria-label="Voting">
          <h2>Vote</h2>
          <Link to="/contestants">Contestants</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/results">Winners</Link>
        </nav>
        <nav aria-label="Contestants">
          <h2>Compete</h2>
          <Link to="/register">Join the contest</Link>
          <Link to="/dashboard">Contestant dashboard</Link>
        </nav>
      </div>
      <div className="wrap footer-bottom">
        <span>© {new Date().getFullYear()} MBGN</span>
        <span>Every vote is a verified record.</span>
      </div>
    </footer>
  );
}

// The only password on the site. Nothing public links here.
function AdminGate() {
  const { user } = useApp();
  if (user === undefined) return <div className="wrap page"><Loading /></div>;
  if (user?.role === 'admin') return <Admin />;
  return <AdminLogin />;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  // Braces matter: scrollTo returns a Promise in current Chromium, and an effect may only return a cleanup.
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wrap page narrow">
        <h1>Something went wrong</h1>
        <p className="muted">Your votes are safe. Please reload the page.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

function App() {
  // A voter is likely to need this next, for the page after paying. Fetched once the page is idle.
  useEffect(() => {
    const id = setTimeout(() => { loadAccount().catch(() => {}); }, 2500);
    return () => clearTimeout(id);
  }, []);

  return (
    <>
      <ScrollToTop />
      <Header />
      <main>
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/contestants" element={<Contestants />} />
          <Route path="/c/:code" element={<Profile />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/results" element={<Results />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/pay/return/:reference" element={<PayReturn />} />
          <Route path="/pay/sim/:reference" element={<PaySim />} />
          <Route path="/receipt/:kind/:number" element={<Receipt />} />
          <Route path="/admin" element={<AdminGate />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset/:token" element={<Reset />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </main>
      <Footer />
      <LivePopups />
      <ThemePicker />
    </>
  );
}

export default function Site() {
  useEffect(() => { applyTheme(currentTheme()); }, []);
  return (
    <BrowserRouter>
      <AppProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AppProvider>
    </BrowserRouter>
  );
}
