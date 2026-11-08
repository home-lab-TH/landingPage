import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import Overview from './pages/Overview';
import Services from './pages/Services';
import { Icon, Login, pageForHash, readPass, savePass, usePoll } from './lib';
import type { Page, Route, SiteState, Stats } from './lib';

// Only the landing page is in the first download; every other page loads when it is opened.
const Topology = lazy(() => import('./pages/Topology'));
const Sites = lazy(() => import('./pages/Sites'));
const NotesPage = lazy(() => import('./pages/Notes'));
const Provision = lazy(() => import('./pages/Provision'));
const LogsPage = lazy(() => import('./ui/Ops').then((m) => ({ default: m.LogsPage })));
const UpdatesPage = lazy(() => import('./ui/Ops').then((m) => ({ default: m.UpdatesPage })));

const NAV: [Page, string, string][] = [['overview', 'Overview', 'grid'], ['services', 'Services', 'server'], ['topology', 'Topology', 'map'], ['sites', 'Sites', 'pulse'], ['notes', 'Notes', 'note'], ['logs', 'Logs', 'list'], ['updates', 'Updates', 'refresh'], ['provision', 'Create', 'plus']];

const Locked = ({ title, text, onLogin }: { title: string; text: string; onLogin: (p: string) => void }) => (
  <><header className="page-head"><h1>{title}</h1><p className="lede">{text}</p></header><Login onLogin={onLogin} /></>
);

export function App() {
  const [page, setPage] = useState<Page>(pageForHash);
  const [logKey, setLogKey] = useState(() => window.location.hash.match(/^#\/?logs\/([a-z0-9-]+)/)?.[1] ?? '');
  const [query, setQuery] = useState('');
  const [pass, setPass] = useState(readPass);
  const search = useRef<HTMLInputElement>(null);
  const { data: stats, error: statsError } = usePoll<Stats>('./api/stats', 5000);
  const { data: siteData } = usePoll<{ results: SiteState[] }>('./api/services', 30000);
  const { data: routeData } = usePoll<{ routes: Route[] }>('./api/routes', 30000);
  const sites = useMemo(() => Object.fromEntries((siteData?.results ?? []).map((r) => [r.id, r])), [siteData]);

  useEffect(() => {
    const onHash = () => { setPage(pageForHash()); const m = window.location.hash.match(/^#\/?logs\/([a-z0-9-]+)/); if (m) setLogKey(m[1]); window.scrollTo(0, 0); };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'Escape' && document.activeElement === search.current) { setQuery(''); search.current?.blur(); }
    };
    window.addEventListener('hashchange', onHash); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey); };
  }, []);

  const q = query.trim().toLowerCase();
  const lock = () => { savePass(''); setPass(''); };

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
        </label>
        {pass
          ? <button type="button" className="btn lock on" onClick={lock} title="Lock the controls"><Icon name="unlock" />Lock</button>
          : <a className="btn lock solid" href="#/provision"><Icon name="lock" />Unlock</a>}
        <nav className="tabs" aria-label="Pages">
          {NAV.map(([id, label, icon]) => (
            <a key={id} href={`#/${id === 'overview' ? '' : id}`} className={page === id ? 'on' : ''} aria-current={page === id ? 'page' : undefined}><Icon name={icon} />{label}</a>
          ))}
        </nav>
      </header>
      <main className="page" key={page}>
        <Suspense fallback={<p className="muted loading">Loading…</p>}>
          {page === 'overview' && <Overview query={q} stats={stats} statsError={statsError} sites={sites} pass={pass} />}
          {page === 'services' && <Services query={q} sites={sites} />}
          {page === 'topology' && <Topology stats={stats} />}
          {page === 'sites' && <Sites query={q} routes={routeData?.routes ?? []} sites={sites} pass={pass} onLogin={setPass} />}
          {page === 'notes' && <NotesPage query={q} pass={pass} onLogin={setPass} />}
          {page === 'updates' && (pass ? <UpdatesPage pass={pass} /> : <Locked title="Updates" text="Unlock to check and install updates." onLogin={setPass} />)}
          {page === 'logs' && (pass ? <LogsPage pass={pass} initial={logKey} /> : <Locked title="Logs" text="Unlock to read the server's logs." onLogin={setPass} />)}
          {page === 'provision' && <Provision pass={pass} onLogin={setPass} />}
        </Suspense>
      </main>
      <footer className="foot">
        <span>Homelab · Proxmox · Docker · Tailscale</span>
        <a href="https://github.com/lakylaky963/homelab-ops" target="_blank" rel="noreferrer"><Icon name="github" className="icon-xs" />homelab-ops</a>
      </footer>
    </div>
  );
}
