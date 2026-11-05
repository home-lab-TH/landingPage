import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { dashboardConfig, type Site, type UserSection } from './config/dashboardConfig';

type Page = 'gateway' | 'workspace' | 'provision' | 'monitor';
type ProvisionType = 'vm' | 'lxc';

const pageForHash = (): Page => {
  const route = window.location.hash.replace(/^#\/?/, '');
  if (route === 'workspace/provision') return 'provision';
  if (route === 'workspace') return 'workspace';
  if (route === 'monitor') return 'monitor';
  return 'gateway';
};

const Icon = ({ name, className = 'h-4 w-4' }: { name: string; className?: string }) => {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 7h.01M7 18h.01" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1 2-2V8a2 2 0 0 1 2-2h6" /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    box: <><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>,
    back: <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const StatusPill = ({ status }: { status: string }) => <span className={status === 'Online' ? 'status-pill status-online' : 'status-pill status-building'}><i />{status}</span>;

const SiteCard = ({ site }: { site: Site }) => <a href={site.url} target="_blank" rel="noreferrer" className="site-card group"><div className="flex min-w-0 items-center gap-3"><div className="site-icon">{site.icon}</div><div className="min-w-0"><div className="flex items-center gap-2"><h3>{site.title}</h3><span className="tag">{site.badge}</span></div><p>{site.description}</p></div></div><Icon name="arrow" className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-1 group-hover:text-cyan-300" /></a>;

const UserColumn = ({ user, query }: { user: UserSection; query: string }) => {
  const sites = user.sites.filter((site) => `${site.title} ${site.description} ${site.badge}`.toLowerCase().includes(query));
  return <section className="user-column"><header className="mb-5 flex items-center gap-3"><img src={user.avatar} alt="" className="avatar" /><div><p className="eyebrow">{user.role}</p><h2>{user.name}</h2></div><span className="ml-auto h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" title="Available" /></header><div className="space-y-2.5">{sites.map((site) => <SiteCard key={site.title} site={site} />)}</div>{sites.length === 0 && <p className="empty-state">No services match this search.</p>}</section>;
};

const ProvisionPage = ({ back }: { back: () => void }) => {
  const [type, setType] = useState<ProvisionType>('lxc');
  const [name, setName] = useState('');
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(2048);
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading'); setMessage('');
    try {
      const response = await fetch('./api/proxmox/provision', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provision-password': password }, body: JSON.stringify({ type, name, cores, memory }) });
      const data: { message?: string; task?: string } = await response.json();
      if (!response.ok) throw new Error(data.message || 'Proxmox did not accept the request.');
      setState('success'); setMessage(`Provisioning task queued: ${data.task || 'accepted'}`);
      setName('');
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Unable to reach the provisioning service.'); }
  };

  return <><button type="button" className="back-link" onClick={back}><Icon name="back" />Shared workspace</button><header className="page-head provision-head"><div><p className="eyebrow">Shared workspace / Proxmox</p><h1>Provision a service.</h1><p className="lede">Create a new instance from one of your approved homelab templates.</p></div><span className="secure-note"><span className="pulse-dot" />Tailscale-connected</span></header><div className="provision-layout"><form className="provision-form" onSubmit={submit}><div className="form-section"><label>Instance type</label><div className="type-switch"><button type="button" className={type === 'lxc' ? 'selected' : ''} onClick={() => setType('lxc')}><Icon name="box" />LXC container</button><button type="button" className={type === 'vm' ? 'selected' : ''} onClick={() => setType('vm')}><Icon name="server" />Virtual machine</button></div></div><div className="form-section"><label htmlFor="instance-name">Instance name</label><input id="instance-name" required minLength={2} maxLength={50} pattern="[a-zA-Z0-9][a-zA-Z0-9-]*" value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="e.g. paperless" /><small>Letters, numbers, and hyphens only.</small></div><div className="resource-grid"><div className="form-section"><label htmlFor="cores">CPU cores</label><input id="cores" type="number" min="1" max="16" value={cores} onChange={(event) => setCores(Number(event.target.value))} /></div><div className="form-section"><label htmlFor="memory">Memory (MiB)</label><input id="memory" type="number" min="512" max="32768" step="512" value={memory} onChange={(event) => setMemory(Number(event.target.value))} /></div></div><div className="form-section"><label htmlFor="provision-password">Provisioning password</label><input id="provision-password" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small>Set as PROVISION_PASSWORD on the server.</small></div><button className="provision-button" disabled={state === 'loading'} type="submit"><Icon name="plus" />{state === 'loading' ? 'Creating instance...' : `Create ${type === 'lxc' ? 'LXC' : 'VM'}`}</button>{state !== 'idle' && <p className={state === 'success' ? 'form-message success' : 'form-message error'}>{message}</p>}</form><aside className="provision-aside"><Icon name="server" className="h-6 w-6 text-cyan-300" /><h2>Template-based provisioning</h2><p>Each request clones the template you configure on Proxmox. The API token remains on the server and is never sent to the browser.</p><div className="aside-rule" /><p className="aside-label">Target</p><strong>Your configured Proxmox node</strong></aside></div></>;
};

export const App = () => {
  const [page, setPage] = useState<Page>(pageForHash);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  useEffect(() => { const syncPage = () => setPage(pageForHash()); window.addEventListener('hashchange', syncPage); return () => window.removeEventListener('hashchange', syncPage); }, []);
  const navigate = (next: Page) => { const routes: Record<Page, string> = { gateway: '', workspace: 'workspace', provision: 'workspace/provision', monitor: 'monitor' }; window.location.hash = routes[next]; };
  const visibleCount = useMemo(() => dashboardConfig.userSections.reduce((total, user) => total + user.sites.filter((site) => `${site.title} ${site.description} ${site.badge}`.toLowerCase().includes(normalizedQuery)).length, 0), [normalizedQuery]);
  const workspaceActive = page === 'workspace' || page === 'provision';

  return <div className="app-shell"><aside className="sidebar"><button type="button" className="brand" onClick={() => navigate('gateway')} aria-label="Open the gateway"><span className="brand-mark"><Icon name="grid" /></span><span>orbit<span>hub</span></span></button><nav aria-label="Primary navigation"><button type="button" className={page === 'gateway' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('gateway')}><Icon name="grid" />Gateway</button><button type="button" className={workspaceActive ? 'nav-item active' : 'nav-item'} onClick={() => navigate('workspace')}><Icon name="layers" />Shared workspace</button><button type="button" className={page === 'monitor' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('monitor')}><Icon name="server" />Server monitor</button></nav><div className="sidebar-foot"><div className="flex items-center gap-2 text-xs text-slate-400"><span className="h-2 w-2 rounded-full bg-emerald-400" />All systems operational</div><p>Last heartbeat: just now</p></div></aside><main className="main-content">
    {page === 'gateway' && <><header className="page-head gateway-head"><div><p className="eyebrow">Homelab gateway</p><h1>Your corner of the internet.</h1><p className="lede">Everything your crew is building, running, and sharing.</p></div><div className="health-card"><span className="pulse-dot" /><div><strong>All systems online</strong><small>12 services responding</small></div><Icon name="activity" className="ml-3 h-5 w-5 text-cyan-300" /></div></header><div className="search-row"><div className="search-box"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services, projects, or tags..." aria-label="Search services" />{query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">Clear</button>}</div><span className="results-count">{visibleCount} services</span></div><div className="users-grid">{dashboardConfig.userSections.map((user) => <UserColumn key={user.name} user={user} query={normalizedQuery} />)}</div></>}
    {page === 'workspace' && <><header className="page-head workspace-head"><div><p className="eyebrow">Built together</p><h1>Shared workspace.</h1><p className="lede">The services and experiments the whole crew keeps moving.</p></div><button type="button" className="workspace-action" onClick={() => navigate('provision')}><Icon name="plus" />Provision on Proxmox</button></header><div className="project-grid">{dashboardConfig.sharedProjects.map((project) => <a className="project-card" key={project.title} href={project.url} target="_blank" rel="noreferrer"><div className="flex items-start justify-between gap-4"><span className="project-icon">{project.icon}</span><StatusPill status={project.status} /></div><div><h2>{project.title}</h2><p>{project.description}</p></div><div className="flex items-center justify-between gap-3"><div className="flex flex-wrap gap-1.5">{project.stack.map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}</div><Icon name="external" className="h-4 w-4 shrink-0 text-slate-500" /></div></a>)}</div></>}
    {page === 'provision' && <ProvisionPage back={() => navigate('workspace')} />}
    {page === 'monitor' && <><header className="page-head"><p className="eyebrow">Infrastructure</p><h1>Server monitor.</h1><p className="lede">A quiet place for host health, containers, and logs.</p></header><div className="monitor-placeholder"><Icon name="server" className="h-8 w-8 text-cyan-300" /><h2>Monitoring is on deck.</h2><p>This space is ready for your container metrics and system logs.</p><div className="monitor-lines"><span /><span /><span /></div></div></>}
  </main></div>;
};
