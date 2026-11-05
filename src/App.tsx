import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import config from './config/services.json';

// ---------- types ----------
type Page = 'overview' | 'services' | 'sites' | 'provision';
type ProvisionType = 'vm' | 'lxc';
type Guest = { id: number; name: string; type: 'lxc' | 'vm'; status: string; cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; tags?: string[] };
type Host = { cpu: number; cpus: number; model: string; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; load: string[]; version: string };
type Storage = { name: string; type: string; used: number; total: number };
type Stats = { configured: boolean; node: string; host: Host; guests: Guest[]; storage: Storage[]; at: string };
type SiteState = { id: string; up: boolean; code: number; ms: number };
type Site = (typeof config.sites)[number];
type Route = { name: string; title: string; path: string; kind: string };
type NewSite = { name: string; url: string; admin_url: string; admin_user: string; admin_password: string; plugins: string[] };

// ---------- helpers ----------
const pageForHash = (): Page => {
  const route = window.location.hash.replace(/^#\/?/, '');
  if (route === 'services') return 'services';
  if (route === 'sites') return 'sites';
  if (route === 'provision') return 'provision';
  return 'overview';
};
const bytes = (n: number) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
};
const ratio = (used: number, total: number) => (total > 0 ? Math.min(1, used / total) : 0);
const pct = (r: number) => `${Math.round(r * 100)}%`;
const duration = (s: number) => {
  if (!s) return '-';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const level = (r: number) => (r >= 0.9 ? 'crit' : r >= 0.75 ? 'warn' : 'ok');
const matches = (query: string, ...fields: (string | number)[]) => !query || fields.join(' ').toLowerCase().includes(query);

const PASS_KEY = 'homelab-pass';
const readPass = () => { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch { return ''; } };
const savePass = (value: string) => { try { if (value) sessionStorage.setItem(PASS_KEY, value); else sessionStorage.removeItem(PASS_KEY); } catch { /* private mode */ } };

const Login = ({ onLogin }: { onLogin: (pass: string) => void }) => {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    try {
      const response = await fetch('./api/login', { method: 'POST', headers: { 'x-dashboard-password': value } });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || 'Wrong password.');
      savePass(value); onLogin(value);
    } catch (e) { setError(e instanceof Error ? e.message : 'Login failed.'); }
  };
  return (
    <form className="panel form login" onSubmit={submit}>
      <h2>Unlock create and delete</h2>
      <p className="muted">Enter the main password. It stays in this browser tab until you close it.</p>
      <label>Password<input type="password" required autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
      <button className="primary" type="submit">Unlock</button>
      {error && <p className="message error">{error}</p>}
    </form>
  );
};

function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ code: number; message: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(url);
        const body = await response.json();
        if (!alive) return;
        if (response.ok) { setData(body as T); setError(null); } else setError({ code: response.status, message: body.message ?? 'Request failed' });
      } catch {
        if (alive) setError({ code: 0, message: 'Dashboard server not reachable' });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), ms);
    return () => { alive = false; window.clearInterval(timer); };
  }, [url, ms]);
  return { data, error };
}

// ---------- small UI pieces ----------
const Icon = ({ name, className = 'icon' }: { name: string; className?: string }) => {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 7h.01M7 18h.01" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
    external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    box: <><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>,
    db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    pulse: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    disk: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

const Ring = ({ value, label, detail }: { value: number; label: string; detail: string }) => {
  const r = 34; const c = 2 * Math.PI * r;
  return (
    <div className="ring-card">
      <svg viewBox="0 0 80 80" className="ring" role="img" aria-label={`${label} ${pct(value)}`}>
        <circle cx="40" cy="40" r={r} className="ring-track" />
        <circle cx="40" cy="40" r={r} className={`ring-value ${level(value)}`} strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
        <text x="40" y="45" textAnchor="middle">{pct(value)}</text>
      </svg>
      <div><p className="label">{label}</p><p className="detail">{detail}</p></div>
    </div>
  );
};

const Bar = ({ value }: { value: number }) => <div className="bar"><span className={level(value)} style={{ width: pct(value) }} /></div>;
const Dot = ({ state }: { state: 'up' | 'down' | 'idle' }) => <span className={`dot ${state}`} aria-label={state} />;

// ---------- pages ----------
const SetupNotice = ({ message }: { message: string }) => (
  <section className="panel notice">
    <h2>Connect the dashboard to Proxmox</h2>
    <p>{message}</p>
    <ol>
      <li>On the Proxmox host: <code>pveum user add dashboard@pve</code>, then <code>pveum acl modify / -user dashboard@pve -role PVEAuditor</code>, then <code>pveum user token add dashboard@pve read --privsep 0</code>.</li>
      <li>In <code>.env</code> on FrontPage set <code>PROXMOX_URL</code>, <code>PROXMOX_NODE=server</code>, <code>PROXMOX_READ_TOKEN_ID=dashboard@pve!read</code>, <code>PROXMOX_READ_TOKEN_SECRET</code> and <code>PROXMOX_INSECURE_TLS=1</code>.</li>
      <li>Restart: <code>pm2 restart landing-page --update-env</code>.</li>
    </ol>
  </section>
);

const Overview = ({ query, stats, statsError, sites, pass }: { query: string; stats: Stats | null; statsError: { code: number; message: string } | null; sites: Record<string, SiteState>; pass: string }) => {
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const power = async (g: Guest, action: 'start' | 'stop' | 'restart') => {
    if (action !== 'start' && !window.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} ${g.name} (${g.id})?`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}/power/${action}`, { method: 'POST', headers: { 'x-dashboard-password': pass } });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || `${action} failed.`);
      setNote(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${g.name} (${g.id})…`);
    } catch (e) { setNote(e instanceof Error ? e.message : `${action} failed.`); } finally { setBusy(null); }
  };
  const remove = async (g: Guest) => {
    if (!window.confirm(`Delete ${g.type.toUpperCase()} ${g.id} (${g.name})? This destroys it and its disk.`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}`, { method: 'DELETE', headers: { 'x-dashboard-password': pass } });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || 'Delete failed.');
      setNote(`Deleting ${g.name} (${g.id})… it disappears from the list in a few seconds.`);
    } catch (e) { setNote(e instanceof Error ? e.message : 'Delete failed.'); } finally { setBusy(null); }
  };
  const guests = (stats?.guests ?? []).filter((g) => matches(query, g.name, g.id, g.type, g.status));
  const db = stats?.guests.find((g) => g.id === 106);
  const running = stats?.guests.filter((g) => g.status === 'running').length ?? 0;
  const upCount = config.sites.filter((s) => sites[s.id]?.up).length;
  return (
    <>
      <header className="hero">
        <div>
          <p className="eyebrow">{stats ? `${stats.node} · Proxmox ${stats.host.version.split('/')[1] ?? ''}` : 'Homelab'}</p>
          <h1>{config.title}</h1>
          <p className="lede">{config.subtitle}</p>
        </div>
        <div className="hero-chips">
          <span className="chip"><Dot state={running ? 'up' : 'idle'} />{running}/{stats?.guests.length ?? '-'} guests running</span>
          <span className="chip"><Dot state={upCount === config.sites.length ? 'up' : 'down'} />{upCount}/{config.sites.length} sites up</span>
          {stats && <span className="chip">up {duration(stats.host.uptime)}</span>}
        </div>
      </header>

      {statsError && statsError.code === 503 && <SetupNotice message={statsError.message} />}
      {statsError && statsError.code !== 503 && <section className="panel notice error"><h2>Can't read server stats</h2><p>{statsError.message}</p></section>}

      {stats && (
        <section className="rings">
          <Ring value={stats.host.cpu} label="CPU" detail={`${stats.host.cpus} threads · load ${stats.host.load.slice(0, 3).join(' ')}`} />
          <Ring value={ratio(stats.host.mem, stats.host.maxmem)} label="Memory" detail={`${bytes(stats.host.mem)} of ${bytes(stats.host.maxmem)}`} />
          <Ring value={ratio(stats.host.disk, stats.host.maxdisk)} label="System disk" detail={`${bytes(stats.host.disk)} of ${bytes(stats.host.maxdisk)}`} />
          {db && <Ring value={ratio(db.mem, db.maxmem)} label="Database memory" detail={`MongoDB · CT 106 · ${db.status}`} />}
        </section>
      )}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="pulse" />Sites</h2><a href="#/services" className="link">All services</a></div>
          <ul className="site-list">
            {config.sites.filter((s) => matches(query, s.title, s.description, ...s.tags)).map((site) => {
              const state = sites[site.id];
              return (
                <li key={site.id}>
                  <Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} />
                  <a href={site.url}>{site.title}</a>
                  <span className="muted">{!state ? 'checking…' : state.up ? `${state.ms} ms` : state.code ? `error ${state.code}` : 'no answer'}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head"><h2><Icon name="disk" />Storage</h2></div>
          {(stats?.storage ?? []).map((s) => (
            <div className="storage" key={s.name}>
              <div className="row"><strong>{s.name}</strong><span className="muted">{bytes(s.used)} / {bytes(s.total)}</span></div>
              <Bar value={ratio(s.used, s.total)} />
            </div>
          ))}
          {!stats && <p className="muted">Waiting for Proxmox…</p>}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2><Icon name="box" />Containers and VMs</h2><span className="muted">{query ? `${guests.length} match "${query}"` : `${guests.length} total`}</span></div>
        <div className="table">
          {note && <p className="message success">{note}</p>}
          <div className="tr th"><span>ID</span><span>Name</span><span>CPU</span><span>Memory</span><span>Disk</span><span>Uptime</span></div>
          {guests.map((g) => {
            const mem = ratio(g.mem, g.maxmem); const disk = ratio(g.disk, g.maxdisk);
            return (
              <div className="tr" key={g.id}>
                <span className="mono">{g.id}</span>
                <span className="name"><Dot state={g.status === 'running' ? 'up' : 'idle'} />{g.name}{g.type === 'vm' && <em>VM</em>}{g.id === 106 && <em><Icon name="db" className="icon-xs" />DB</em>}</span>
                <span className="mono">{pct(g.cpu)}</span>
                <span className="cell-bar"><Bar value={mem} /><small>{bytes(g.mem)} / {bytes(g.maxmem)}</small></span>
                <span className="cell-bar"><Bar value={disk} /><small>{pct(disk)}</small></span>
                <span className="muted uptime">{g.status === 'running' ? duration(g.uptime) : g.status}
                  {pass && g.id !== 102 && (
                    <span className="actions">
                      {g.status === 'running'
                        ? <>
                            <button type="button" className="mini" disabled={busy === g.id} onClick={() => void power(g, 'restart')} title="Restart">↻</button>
                            {g.id !== 101 && g.id !== 105 && <button type="button" className="mini" disabled={busy === g.id} onClick={() => void power(g, 'stop')} title="Stop">■</button>}
                          </>
                        : <button type="button" className="mini" disabled={busy === g.id} onClick={() => void power(g, 'start')} title="Start">▶</button>}
                      {g.tags?.includes('dashboard') && <button type="button" className="danger" disabled={busy === g.id} onClick={() => void remove(g)}>{busy === g.id ? '…' : 'Delete'}</button>}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {stats && guests.length === 0 && <p className="muted pad">Nothing matches "{query}".</p>}
        </div>
      </section>
    </>
  );
};

const SiteCard = ({ site, state }: { site: Site; state?: SiteState }) => (
  <a className="card" href={site.url}>
    <div className="card-top"><span className="badge">{site.icon}</span><Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} /></div>
    <h3>{site.title}</h3>
    <p>{site.description}</p>
    <div className="tags">{site.tags.map((t) => <span key={t}>{t}</span>)}<span>CT {site.ct}</span></div>
  </a>
);

const Services = ({ query, sites }: { query: string; sites: Record<string, SiteState> }) => {
  const shown = config.sites.filter((s) => matches(query, s.title, s.description, ...s.tags));
  const links = config.links.filter((l) => matches(query, l.title, l.description));
  return (
    <>
      <header className="hero"><div><p className="eyebrow">Services</p><h1>Apps on the server</h1><p className="lede">Open a site, or use the search bar to find one.</p></div></header>
      <section className="cards">{shown.map((s) => <SiteCard key={s.id} site={s} state={sites[s.id]} />)}</section>
      <h2 className="section-title">Admin and code</h2>
      <section className="cards small">
        {links.map((l) => (
          <a className="card" key={l.title} href={l.url} target="_blank" rel="noreferrer">
            <div className="card-top"><span className="badge">{l.icon}</span><Icon name="external" className="icon muted" /></div>
            <h3>{l.title}</h3><p>{l.description}</p>
          </a>
        ))}
      </section>
      {!shown.length && !links.length && <p className="muted">Nothing matches "{query}".</p>}
    </>
  );
};

const Sites = ({ query, routes, sites, pass, onLogin, reload }: { query: string; routes: Route[]; sites: Record<string, SiteState>; pass: string; onLogin: (p: string) => void; reload: () => void }) => {
  const [wpName, setWpName] = useState('');
  const [wpTitle, setWpTitle] = useState('');
  const [rName, setRName] = useState('');
  const [rTarget, setRTarget] = useState('http://10.0.0.');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<NewSite | null>(null);
  const call = async (label: string, url: string, init: RequestInit) => {
    setBusy(label); setError('');
    try {
      const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Request failed.');
      reload();
      return body;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return null; } finally { setBusy(''); }
  };
  const newWordpress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setCreated(null);
    const body = await call('wp', './api/wordpress', { method: 'POST', body: JSON.stringify({ name: wpName, title: wpTitle }) });
    if (body) { setCreated(body as NewSite); setWpName(''); setWpTitle(''); }
  };
  const newRoute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await call('route', './api/routes', { method: 'POST', body: JSON.stringify({ name: rName, target: rTarget, title: rName }) })) { setRName(''); setRTarget('http://10.0.0.'); }
  };
  const remove = async (r: Route) => {
    const msg = r.kind === 'wordpress' ? `Delete the WordPress site "${r.title}"? Its pages, uploads and database are destroyed.` : `Remove the route ${r.path}? The app itself is not touched.`;
    if (window.confirm(msg)) await call(`del:${r.name}`, `./api/routes/${r.name}`, { method: 'DELETE' });
  };
  const shown = routes.filter((r) => matches(query, r.name, r.title, r.path, r.kind));
  return (
    <>
      <header className="hero"><div><p className="eyebrow">Sites</p><h1>Websites on the server</h1><p className="lede">Spin up a WordPress site in about a minute, or publish any app under its own path.</p></div></header>
      <section className="panel">
        <div className="panel-head"><h2><Icon name="grid" />Your sites</h2><span className="muted">{shown.length} extra site{shown.length === 1 ? '' : 's'}</span></div>
        <ul className="site-list">
          {shown.map((r) => {
            const state = sites[`route:${r.name}`];
            return (
              <li key={r.name}>
                <Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} />
                <a href={`.${r.path}`}>{r.title}</a>
                <span className="muted">{r.path} · {r.kind === 'wordpress' ? 'WordPress' : 'app'}</span>
                {r.kind === 'wordpress' && <a className="link" href={`.${r.path}wp-admin/`} target="_blank" rel="noreferrer">edit</a>}
                {pass && <button type="button" className="danger" disabled={busy === `del:${r.name}`} onClick={() => void remove(r)}>{busy === `del:${r.name}` ? '…' : 'Delete'}</button>}
              </li>
            );
          })}
          {!shown.length && <li className="muted">No extra sites yet.</li>}
        </ul>
      </section>
      {error && <p className="message error">{error}</p>}
      {created && (
        <section className="panel notice">
          <h2>Your new site is ready</h2>
          <p>Save the password now. It is only shown once.</p>
          <ol>
            <li>Site: <a className="link" href={created.url} target="_blank" rel="noreferrer">{created.url}</a></li>
            <li>Edit it: <a className="link" href={created.admin_url} target="_blank" rel="noreferrer">{created.admin_url}</a></li>
            <li>User <code>{created.admin_user}</code> · password <code>{created.admin_password}</code></li>
            {created.plugins.includes('ai-engine') && <li>AI editing: in WordPress open <strong>Meow Apps → AI Engine → Settings</strong>, pick Google, and paste your Gemini key.</li>}
          </ol>
        </section>
      )}
      {!pass ? <Login onLogin={onLogin} /> : (
        <div className="grid-2">
          <form className="panel form" onSubmit={newWordpress}>
            <h2>New WordPress site</h2>
            <label>Name (becomes /sites/name/)<input required pattern="[a-z0-9][a-z0-9-]{1,30}" value={wpName} onChange={(e) => setWpName(e.target.value.toLowerCase())} placeholder="e.g. bakery" /></label>
            <label>Title<input value={wpTitle} onChange={(e) => setWpTitle(e.target.value)} placeholder="e.g. Dana's Bakery" /></label>
            <button className="primary" disabled={!!busy} type="submit"><Icon name="plus" />{busy === 'wp' ? 'Creating… (about a minute)' : 'Create site'}</button>
          </form>
          <form className="panel form" onSubmit={newRoute}>
            <h2>Publish an app</h2>
            <label>Name (becomes /name/)<input required pattern="[a-z0-9][a-z0-9-]{0,39}" value={rName} onChange={(e) => setRName(e.target.value.toLowerCase())} placeholder="e.g. notes" /></label>
            <label>App address on the LAN<input required value={rTarget} onChange={(e) => setRTarget(e.target.value)} placeholder="http://10.0.0.225:8080/" /></label>
            <button className="primary" disabled={!!busy} type="submit"><Icon name="plus" />{busy === 'route' ? 'Adding…' : 'Add route'}</button>
          </form>
        </div>
      )}
    </>
  );
};

const Provision = ({ pass, onLogin }: { pass: string; onLogin: (p: string) => void }) => {
  const [type, setType] = useState<ProvisionType>('lxc');
  const [name, setName] = useState('');
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(2048);
  const [disk, setDisk] = useState(8);
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading'); setMessage('');
    try {
      const response = await fetch('./api/proxmox/provision', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass }, body: JSON.stringify({ type, name, cores, memory, disk }) });
      const data: { message?: string; task?: string; id?: number } = await response.json();
      if (!response.ok) throw new Error(data.message || 'Proxmox did not accept the request.');
      setState('success'); setMessage(`Creating ${type.toUpperCase()} ${data.id ?? ''} (${name}). It shows up on the Overview in a minute; delete it there if you don't need it.`);
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Unable to reach the provisioning service.'); }
  };

  return (
    <>
      <header className="hero"><div><p className="eyebrow">Proxmox</p><h1>Create a container or VM</h1><p className="lede">Containers start from a fresh Debian image; VMs are cloned from your VM template.</p></div></header>
      {!pass ? <Login onLogin={onLogin} /> : <form className="panel form" onSubmit={submit}>
        <div className="segmented" role="radiogroup">
          <button type="button" className={type === 'lxc' ? 'on' : ''} onClick={() => setType('lxc')}><Icon name="box" />Container (LXC)</button>
          <button type="button" className={type === 'vm' ? 'on' : ''} onClick={() => setType('vm')}><Icon name="server" />Virtual machine</button>
        </div>
        <label>Name<input required minLength={2} maxLength={50} pattern="[a-z0-9][a-z0-9-]*" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. paperless" /></label>
        <div className="row-2">
          <label>CPU cores<input type="number" min={1} max={8} value={cores} onChange={(e) => setCores(Number(e.target.value))} /></label>
          <label>Memory (MiB)<input type="number" min={256} max={8192} step={256} value={memory} onChange={(e) => setMemory(Number(e.target.value))} /></label>
        </div>
        <label>Disk (GB)<input type="number" min={2} max={100} value={disk} onChange={(e) => setDisk(Number(e.target.value))} /></label>
        <button className="primary" disabled={state === 'loading'} type="submit"><Icon name="plus" />{state === 'loading' ? 'Creating…' : `Create ${type === 'lxc' ? 'container' : 'VM'}`}</button>
        {state !== 'idle' && state !== 'loading' && <p className={`message ${state}`}>{message}</p>}
      </form>}
    </>
  );
};

// ---------- shell ----------
export function App() {
  const [page, setPage] = useState<Page>(pageForHash);
  const [query, setQuery] = useState('');
  const [pass, setPass] = useState(readPass);
  const [now, setNow] = useState(() => new Date());
  const search = useRef<HTMLInputElement>(null);
  const { data: stats, error: statsError } = usePoll<Stats>('./api/stats', 5000);
  const { data: siteData } = usePoll<{ results: SiteState[] }>('./api/services', 30000);
  const { data: routeData } = usePoll<{ routes: Route[] }>('./api/routes', 30000);
  const sites = useMemo(() => Object.fromEntries((siteData?.results ?? []).map((r) => [r.id, r])), [siteData]);

  useEffect(() => {
    const onHash = () => setPage(pageForHash());
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'Escape' && document.activeElement === search.current) { setQuery(''); search.current?.blur(); }
    };
    const clock = window.setInterval(() => setNow(new Date()), 30000);
    window.addEventListener('hashchange', onHash); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey); window.clearInterval(clock); };
  }, []);

  const q = query.trim().toLowerCase();
  const nav: [Page, string, string][] = [['overview', 'Overview', 'grid'], ['services', 'Services', 'server'], ['sites', 'Sites', 'pulse'], ['provision', 'Create', 'plus']];

  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="#/"><span className="logo">HL</span><span>Homelab</span></a>
        <nav>
          {nav.map(([id, label, icon]) => (
            <a key={id} href={`#/${id === 'overview' ? '' : id}`} className={page === id ? 'active' : ''}><Icon name={icon} />{label}</a>
          ))}
        </nav>
        <div className="lock">
          {pass ? <button type="button" className="link-btn" onClick={() => { savePass(''); setPass(''); }}>🔓 Unlocked · lock</button> : <a href="#/provision" className="link-btn">🔒 Locked · unlock</a>}
        </div>
        <div className="side-foot">
          <span className="muted">{now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <strong>{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</strong>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <label className="search">
            <Icon name="search" />
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sites, containers, links…" aria-label="Search" />
            <kbd>/</kbd>
          </label>
        </div>
        {page === 'overview' && <Overview query={q} stats={stats} statsError={statsError} sites={sites} pass={pass} />}
        {page === 'services' && <Services query={q} sites={sites} />}
        {page === 'sites' && <Sites query={q} routes={routeData?.routes ?? []} sites={sites} pass={pass} onLogin={setPass} reload={() => undefined} />}
        {page === 'provision' && <Provision pass={pass} onLogin={setPass} />}
      </main>
    </div>
  );
}
