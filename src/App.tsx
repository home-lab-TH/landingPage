import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Overview from './pages/Overview';
import Services from './pages/Services';
import { CommandBar } from './ui/CommandBar';
import {
  AVATAR_GLYPH,
  Icon,
  Login,
  PRIVILEGE_META,
  ROLE_META,
  authHeaders,
  formatCountdown,
  hasPriv,
  pageForHash,
  readPass,
  savePass,
  usePoll,
} from './lib';
import type { AuthMeResponse, AuthUser, Page, Route, SiteState, Stats } from './lib';

// Only the landing page is in the first download; every other page loads when it is opened.
const Topology = lazy(() => import('./pages/Topology'));
const Sites = lazy(() => import('./pages/Sites'));
const NotesPage = lazy(() => import('./pages/Notes'));
const Provision = lazy(() => import('./pages/Provision'));
const LogsPage = lazy(() => import('./ui/Ops').then((m) => ({ default: m.LogsPage })));
const UpdatesPage = lazy(() => import('./ui/Ops').then((m) => ({ default: m.UpdatesPage })));
const Agents = lazy(() => import('./pages/Agents'));
const Users = lazy(() => import('./pages/Users'));
const LoginPage = lazy(() => import('./pages/LoginPage'));

const BASE_NAV: [Page, string, string][] = [
  ['overview', 'Overview', 'grid'],
  ['services', 'Services', 'server'],
  ['topology', 'Topology', 'map'],
  ['sites', 'Sites', 'pulse'],
  ['notes', 'Notes', 'note'],
  ['logs', 'Logs', 'list'],
  ['updates', 'Updates', 'refresh'],
  ['agents', 'Agents', 'bot'],
  ['provision', 'Create', 'plus'],
];

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

const Locked = ({
  title,
  text,
  needsBootstrap,
  allowLegacyPassword,
  onLogin,
}: {
  title: string;
  text: string;
  needsBootstrap?: boolean;
  allowLegacyPassword?: boolean;
  onLogin: (p: string, u?: AuthUser) => void;
}) => (
  <>
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="lede">{text}</p>
      </div>
    </header>
    <Login
      onLogin={onLogin}
      needsBootstrap={needsBootstrap}
      allowLegacyPassword={allowLegacyPassword}
    />
  </>
);

const InsufficientPrivilege = ({
  title,
  privilege,
  user,
}: {
  title: string;
  privilege: string;
  user: AuthUser | null;
}) => {
  const privInfo = PRIVILEGE_META[privilege];
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow"><Icon name="shield" className="icon-xs" />Insufficient Privilege</p>
          <h1>{title}</h1>
          <p className="lede">
            Signed in as <strong>{user?.displayName ?? 'guest'}</strong> ({user ? ROLE_META[user.role].label : 'restricted'}), which lacks the <code>{privilege}</code> privilege.
          </p>
        </div>
      </header>
      <section className="panel notice">
        <h2><Icon name="lock" />Insufficient privilege</h2>
        <p className="muted">
          This section requires <strong>{privInfo?.label ?? privilege}</strong> (<code>{privilege}</code>).
          {privInfo ? ` — ${privInfo.desc}.` : ''}
        </p>
        <div className="quick-links">
          <a className="btn solid" href="#/"><Icon name="grid" />Overview</a>
          <a className="btn" href="#/login"><Icon name="shield" />Account &amp; Privileges</a>
          <a className="btn" href="/game/"><Icon name="gamepad" />Cyberpunk Game Hub</a>
        </div>
      </section>
    </>
  );
};

export function App() {
  const [page, setPage] = useState<Page>(pageForHash);
  const [logKey, setLogKey] = useState(() => window.location.hash.match(/^#\/?logs\/([a-z0-9-]+)/)?.[1] ?? '');
  const [query, setQuery] = useState('');
  const [pass, setPass] = useState(readPass);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMeta, setAuthMeta] = useState<{ needsBootstrap: boolean; allowLegacyPassword: boolean; ready: boolean; authError: string }>({
    needsBootstrap: false,
    allowLegacyPassword: true,
    ready: false,
    authError: '',
  });
  const [now, setNow] = useState(() => Date.now());
  const [bar, setBar] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const { data: stats, error: statsError } = usePoll<Stats>('./api/stats', 5000);
  const { data: siteData } = usePoll<{ results: SiteState[] }>('./api/services', 30000);
  const { data: routeData } = usePoll<{ routes: Route[] }>('./api/routes', 30000);
  const sites = useMemo(() => Object.fromEntries((siteData?.results ?? []).map((r) => [r.id, r])), [siteData]);

  const refreshAuth = useCallback(async () => {
    try {
      const legacy = readPass();
      const response = await fetch('./api/auth/me', {
        credentials: 'same-origin',
        headers: authHeaders(legacy),
      });
      if (!response.ok) {
        setAuthMeta((prev) => ({ ...prev, ready: true }));
        return;
      }
      const body = (await response.json()) as AuthMeResponse;
      const allowLegacy = body.allowLegacyPassword !== false;
      const sessionReason = !body.authenticated ? (body.error || body.message || '') : '';
      setAuthMeta({
        needsBootstrap: Boolean(body.needsBootstrap),
        allowLegacyPassword: allowLegacy,
        ready: true,
        authError: sessionReason,
      });
      if (body.authenticated && body.user) {
        setUser(body.user);
        setPass((cur) => (body.user?.isLegacy && cur && cur !== '__sso__' ? cur : '__sso__'));
      } else {
        setUser(null);
        if (!allowLegacy) {
          savePass('');
          setPass('');
        } else {
          setPass((cur) => (cur === '__sso__' ? '' : cur));
        }
      }
    } catch {
      /* server may be starting; keep existing state */
      setAuthMeta((prev) => ({ ...prev, ready: true }));
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (user?.role !== 'recruiter_guest' || !user.expiresAt) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [user?.role, user?.expiresAt]);

  useEffect(() => {
    const onHash = () => {
      setPage(pageForHash());
      const m = window.location.hash.match(/^#\/?logs\/([a-z0-9-]+)/);
      if (m) setLogKey(m[1]);
      window.scrollTo(0, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setBar((open) => !open); return; }
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'Escape' && document.activeElement === search.current) { setQuery(''); search.current?.blur(); }
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey); };
  }, []);

  const handleLogin = useCallback(
    (token: string, nextUser?: AuthUser) => {
      setPass(token);
      if (nextUser) setUser(nextUser);
      void refreshAuth();
    },
    [refreshAuth],
  );

  const handleLogout = useCallback(async () => {
    try {
      await fetch('./api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore network error during logout */
    }
    savePass('');
    setPass('');
    setUser(null);
    void refreshAuth();
  }, [refreshAuth]);

  const isLegacyOwner = Boolean(pass && pass !== '__sso__' && !user);
  const allowed = useCallback((priv: string) => isLegacyOwner || hasPriv(user, priv), [isLegacyOwner, user]);
  const canManageUsers = Boolean(pass) && allowed('manage_users');
  const canRunUpdates = Boolean(pass) && allowed('run_updates');
  const overviewPass = pass && (allowed('view_private') || allowed('manage_containers')) ? pass : '';

  const nav = useMemo<[Page, string, string][]>(() => {
    const base = canRunUpdates ? BASE_NAV : BASE_NAV.filter(([id]) => id !== 'updates');
    return canManageUsers ? [...base, ['users', 'Users', 'users']] : base;
  }, [canRunUpdates, canManageUsers]);

  const q = query.trim().toLowerCase();
  const guestExpiry = user?.role === 'recruiter_guest' ? formatCountdown(user.expiresAt, now) : null;

  return (
    <div className="shell">
      <div className="glow" aria-hidden="true" />
      <header className="top">
        <a className="brand" href="#/" aria-label="Homelab home">
          <span className="logo"><i /></span>
          <span><b>Homelab</b><small>{stats ? `${stats.node} · ${stats.guests.filter((g) => g.status === 'running').length} running` : 'Proxmox server'}</small></span>
        </a>
        <label className="search">
          <Icon name="search" />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search this page" />
          <kbd>/</kbd>
          <button type="button" className="cmdk-hint" onClick={() => setBar(true)} title="Jump to a page, site or container" aria-label="Open the command bar"><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd></button>
        </label>
        <div className="top-auth">
          {user ? (
            <>
              <a className="user-pill" href="#/login" title="View session, privileges and change password">
                <span className="user-pill-glyph" aria-hidden="true">{AVATAR_GLYPH[user.avatar] ?? '◈'}</span>
                <span className="user-pill-name">{user.displayName}</span>
                <span className={`role-badge ${ROLE_META[user.role].cls}`}>{ROLE_META[user.role].label}</span>
              </a>
              <button type="button" className="btn lock on" onClick={() => void handleLogout()} title="Sign out">
                <Icon name="logout" />Sign Out
              </button>
            </>
          ) : pass ? (
            <>
              <a className="user-pill" href="#/login" title="Legacy password session">
                <span className="user-pill-name">Legacy</span>
                <span className="role-badge owner">OWNER</span>
              </a>
              <button type="button" className="btn lock on" onClick={() => void handleLogout()} title="Lock controls">
                <Icon name="unlock" />Sign Out
              </button>
            </>
          ) : (
            <a className="btn lock solid" href="#/login"><Icon name="lock" />Sign in</a>
          )}
        </div>
        <nav className="tabs" aria-label="Pages">
          {nav.map(([id, label, icon]) => (
            <a key={id} href={`#/${id === 'overview' ? '' : id}`} className={page === id ? 'on' : ''} aria-current={page === id ? 'page' : undefined}><Icon name={icon} />{label}</a>
          ))}
        </nav>
      </header>

      {user?.role === 'recruiter_guest' && (
        <aside className={`sandbox-ribbon ${guestExpiry?.expired ? 'expired' : ''}`} role="status">
          <div className="sandbox-ribbon-main">
            <span className="role-badge guest">RECRUITER SANDBOX</span>
            <span>
              Exploring as <strong>{user.displayName}</strong> · CT 102 is protected · Created VMs, containers &amp; routes are tagged and audited.
            </span>
          </div>
          <div className="sandbox-ribbon-meta">
            {guestExpiry && (
              <span className={`countdown-pill ${guestExpiry.expired ? 'expired' : guestExpiry.urgent ? 'urgent' : ''}`}>
                <Icon name="clock" className="icon-xs" />
                {guestExpiry.text}
              </span>
            )}
            <a className="link" href="./game/">Arcade 2077 ↗</a>
            {guestExpiry?.expired ? (
              <a className="btn solid" href="#/login">Sign in again →</a>
            ) : (
              <a className="link" href="#/login">Session details →</a>
            )}
          </div>
        </aside>
      )}

      <main className="page" key={page}>
        <Suspense fallback={<p className="muted loading">Loading…</p>}>
          {page === 'overview' && <Overview query={q} stats={stats} statsError={statsError} sites={sites} pass={overviewPass} user={user} />}
          {page === 'services' && <Services query={q} sites={sites} />}
          {page === 'topology' && <Topology stats={stats} pass={overviewPass} />}
          {page === 'sites' && (pass && !allowed('manage_sites') ? <InsufficientPrivilege title="Sites" privilege="manage_sites" user={user} /> : <Sites query={q} routes={routeData?.routes ?? []} sites={sites} pass={pass} user={user} onLogin={handleLogin} />)}
          {page === 'notes' && (pass && !allowed('manage_notes') ? <InsufficientPrivilege title="Notes" privilege="manage_notes" user={user} /> : <NotesPage query={q} pass={pass} onLogin={handleLogin} />)}
          {page === 'updates' && (!pass ? <Locked title="Updates" text="Sign in to check and install updates." needsBootstrap={authMeta.ready ? authMeta.needsBootstrap : undefined} allowLegacyPassword={authMeta.ready ? authMeta.allowLegacyPassword : undefined} onLogin={handleLogin} /> : !allowed('run_updates') ? <InsufficientPrivilege title="Updates" privilege="run_updates" user={user} /> : <UpdatesPage pass={pass} />)}
          {page === 'logs' && (!pass ? <Locked title="Logs" text="Sign in to read the server's logs." needsBootstrap={authMeta.ready ? authMeta.needsBootstrap : undefined} allowLegacyPassword={authMeta.ready ? authMeta.allowLegacyPassword : undefined} onLogin={handleLogin} /> : !allowed('view_logs') ? <InsufficientPrivilege title="Logs" privilege="view_logs" user={user} /> : <LogsPage pass={pass} initial={logKey} />)}
          {page === 'agents' && (!pass ? <Locked title="Agents" text="Sign in to see the agents hub and hand out tasks." needsBootstrap={authMeta.ready ? authMeta.needsBootstrap : undefined} allowLegacyPassword={authMeta.ready ? authMeta.allowLegacyPassword : undefined} onLogin={handleLogin} /> : !allowed('view_agents') ? <InsufficientPrivilege title="Agents" privilege="view_agents" user={user} /> : <Agents query={q} pass={pass} />)}
          {page === 'provision' && (pass && !allowed('create_vms') ? <InsufficientPrivilege title="Create" privilege="create_vms" user={user} /> : <Provision pass={pass} user={user} onLogin={handleLogin} />)}
          {page === 'users' && (!pass ? <Locked title="Users & Audit" text="Sign in with user management access to manage accounts and audit logs." needsBootstrap={authMeta.ready ? authMeta.needsBootstrap : undefined} allowLegacyPassword={authMeta.ready ? authMeta.allowLegacyPassword : undefined} onLogin={handleLogin} /> : !allowed('manage_users') ? <InsufficientPrivilege title="Users & Audit" privilege="manage_users" user={user} /> : <Users currentUser={user} pass={pass} onRefreshAuth={refreshAuth} />)}
          {page === 'login' && (
            <LoginPage
              user={user}
              pass={pass}
              authReady={authMeta.ready}
              authError={authMeta.authError}
              needsBootstrap={authMeta.ready ? authMeta.needsBootstrap : undefined}
              allowLegacyPassword={authMeta.ready ? authMeta.allowLegacyPassword : undefined}
              onLogin={handleLogin}
              onLogout={handleLogout}
              onRefreshAuth={refreshAuth}
            />
          )}
        </Suspense>
      </main>
      {bar && <CommandBar nav={nav} stats={stats} pass={pass} user={user} onClose={() => setBar(false)} />}
      <footer className="foot">
        <span>Homelab · Proxmox · Docker · Tailscale</span>
        <a href="https://github.com/lakylaky963/homelab-ops" target="_blank" rel="noreferrer"><Icon name="github" className="icon-xs" />homelab-ops</a>
      </footer>
    </div>
  );
}
