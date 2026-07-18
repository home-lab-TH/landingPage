import { useEffect, useMemo, useState } from 'react';
import { dashboardConfig, type Site, type UserSection } from './config/dashboardConfig';

type Page = 'gateway' | 'workspace' | 'monitor';

const pageForPath = (): Page => {
  if (window.location.pathname === '/workspace') return 'workspace';
  if (window.location.pathname === '/monitor') return 'monitor';
  return 'gateway';
};

const Icon = ({ name, className = 'h-4 w-4' }: { name: string; className?: string }) => {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 7h.01M7 18h.01" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const StatusPill = ({ status }: { status: string }) => (
  <span className={status === 'Online' ? 'status-pill status-online' : 'status-pill status-building'}>
    <i />{status}
  </span>
);

const SiteCard = ({ site }: { site: Site }) => (
  <a href={site.url} target="_blank" rel="noreferrer" className="site-card group">
    <div className="flex min-w-0 items-center gap-3">
      <div className="site-icon">{site.icon}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2"><h3>{site.title}</h3><span className="tag">{site.badge}</span></div>
        <p>{site.description}</p>
      </div>
    </div>
    <Icon name="arrow" className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-cyan-300" />
  </a>
);

const UserColumn = ({ user, query }: { user: UserSection; query: string }) => {
  const sites = user.sites.filter((site) => `${site.title} ${site.description} ${site.badge}`.toLowerCase().includes(query));
  return <section className="user-column">
    <header className="mb-5 flex items-center gap-3">
      <img src={user.avatar} alt="" className="avatar" />
      <div><p className="eyebrow">{user.role}</p><h2>{user.name}</h2></div>
      <span className="ml-auto h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" title="Available" />
    </header>
    <div className="space-y-2.5">{sites.map((site) => <SiteCard key={site.title} site={site} />)}</div>
    {sites.length === 0 && <p className="empty-state">No services match this search.</p>}
  </section>;
};

export const App = () => {
  const [page, setPage] = useState<Page>(pageForPath);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    const syncPage = () => setPage(pageForPath());
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  const navigate = (next: Page) => {
    const path = next === 'gateway' ? '/' : `/${next}`;
    window.history.pushState({}, '', path);
    setPage(next);
  };

  const visibleCount = useMemo(() => dashboardConfig.userSections.reduce((total, user) => total + user.sites.filter((site) => `${site.title} ${site.description} ${site.badge}`.toLowerCase().includes(normalizedQuery)).length, 0), [normalizedQuery]);

  return <div className="app-shell">
    <aside className="sidebar">
      <button type="button" className="brand" onClick={() => navigate('gateway')} aria-label="Open the gateway"><span className="brand-mark"><Icon name="grid" /></span><span>orbit<span>hub</span></span></button>
      <nav aria-label="Primary navigation">
        <button type="button" className={page === 'gateway' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('gateway')}><Icon name="grid" />Gateway</button>
        <button type="button" className={page === 'workspace' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('workspace')}><Icon name="layers" />Shared workspace</button>
        <button type="button" className={page === 'monitor' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('monitor')}><Icon name="server" />Server monitor</button>
      </nav>
      <div className="sidebar-foot"><div className="flex items-center gap-2 text-xs text-slate-400"><span className="h-2 w-2 rounded-full bg-emerald-400" />All systems operational</div><p>Last heartbeat: just now</p></div>
    </aside>

    <main className="main-content">
      {page === 'gateway' && <>
        <header className="page-head gateway-head"><div><p className="eyebrow">Homelab gateway</p><h1>Your corner of the internet.</h1><p className="lede">Everything your crew is building, running, and sharing.</p></div><div className="health-card"><span className="pulse-dot" /><div><strong>All systems online</strong><small>12 services responding</small></div><Icon name="activity" className="ml-3 h-5 w-5 text-cyan-300" /></div></header>
        <div className="search-row"><div className="search-box"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, projects, or tags..." aria-label="Search services" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">Clear</button>}</div><span className="results-count">{visibleCount} services</span></div>
        <div className="users-grid">{dashboardConfig.userSections.map((user) => <UserColumn key={user.name} user={user} query={normalizedQuery} />)}</div>
      </>}

      {page === 'workspace' && <><header className="page-head"><p className="eyebrow">Built together</p><h1>Shared workspace.</h1><p className="lede">The services and experiments the whole crew keeps moving.</p></header><div className="project-grid">{dashboardConfig.sharedProjects.map((project) => <a className="project-card" key={project.title} href={project.url} target="_blank" rel="noreferrer"><div className="flex items-start justify-between gap-4"><span className="project-icon">{project.icon}</span><StatusPill status={project.status} /></div><div><h2>{project.title}</h2><p>{project.description}</p></div><div className="flex items-center justify-between gap-3"><div className="flex flex-wrap gap-1.5">{project.stack.map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}</div><Icon name="external" className="h-4 w-4 shrink-0 text-slate-500" /></div></a>)}</div></>}

      {page === 'monitor' && <><header className="page-head"><p className="eyebrow">Infrastructure</p><h1>Server monitor.</h1><p className="lede">A quiet place for host health, containers, and logs.</p></header><div className="monitor-placeholder"><Icon name="server" className="h-8 w-8 text-cyan-300" /><h2>Monitoring is on deck.</h2><p>This space is ready for your container metrics and system logs.</p><div className="monitor-lines"><span /><span /><span /></div></div></>}
    </main>
  </div>;
};
