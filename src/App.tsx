import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import config from './config/services.json';
import { Help } from './ui/Help';
import { Backdrop } from './ui/Backdrop';

// ---------- types ----------
type Page = 'overview' | 'services' | 'sites' | 'notes' | 'provision';
type ProvisionType = 'vm' | 'lxc';
type Guest = { id: number; name: string; type: 'lxc' | 'vm'; status: string; cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; tags?: string[] };
type Host = { cpu: number; cpus: number; model: string; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; load: string[]; version: string };
type Storage = { name: string; type: string; used: number; total: number };
type Stats = { configured: boolean; node: string; host: Host; guests: Guest[]; storage: Storage[]; at: string };
type SiteState = { id: string; up: boolean; code: number; ms: number };
type Site = (typeof config.sites)[number];
type Route = { name: string; title: string; path: string; kind: string };
type JobResult = { name: string; title?: string; url: string; admin_url: string; admin_user?: string; admin_password?: string; plugins?: string[]; ai_note?: string };
type Item = { id: string; text: string; at: string; done?: boolean };
type Notes = { note: string; prompts: Item[]; todos: Item[]; updated: string | null };
type Job = { state: 'running' | 'done' | 'failed'; kind: 'create' | 'ai'; step: string; error: string; result: JobResult | null };

// ---------- helpers ----------
const pageForHash = (): Page => {
  const route = window.location.hash.replace(/^#\/?/, '');
  if (route === 'services') return 'services';
  if (route === 'sites') return 'sites';
  if (route === 'provision') return 'provision';
  if (route === 'notes') return 'notes';
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
      <h2>Unlock the controls <Help title="Why unlock?">Creating, deleting, starting and stopping things needs the main password. Looking around does not. The password stays in this browser tab until you close it or press Lock.</Help></h2>
      <p className="muted">Enter the main password to continue.</p>
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
    spark: <><path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z" /></>,
    send: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    note: <><path d="M5 3h10l4 4v14H5z" /><path d="M15 3v4h4" /><path d="M9 12h6M9 16h4" /></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
    check: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="m8 12 3 3 5-6" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

function useTween(target: number, ms = 700) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now(); const a = from.current; let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms); const eased = 1 - (1 - k) ** 3;
      const v = a + (target - a) * eased; setValue(v); from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

const Ring = ({ value: target, label, detail, help }: { value: number; label: string; detail: string; help: string }) => {
  const r = 34; const c = 2 * Math.PI * r;
  const value = useTween(target);
  return (
    <div className="ring-card">
      <svg viewBox="0 0 80 80" className="ring" role="img" aria-label={`${label} ${pct(value)}`}>
        <circle cx="40" cy="40" r={r} className="ring-track" />
        <circle cx="40" cy="40" r={r} className={`ring-value ${level(value)}`} strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
        <text x="40" y="45" textAnchor="middle">{pct(value)}</text>
      </svg>
      <div><p className="label">{label} <Help title={label}>{help}</Help></p><p className="detail">{detail}</p></div>
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
  const down = [
    ...config.sites.filter((s) => sites[s.id] && !sites[s.id].up).map((s) => s.title),
    ...(stats?.guests ?? []).filter((g) => g.status !== 'running' && g.id !== 102 && g.id !== 104).map((g) => `${g.name} (${g.id})`),
  ];
  return (
    <>
      <header className="hero">
        <div>
          <p className="eyebrow">{stats ? `${stats.node}, Proxmox ${stats.host.version.split('/')[1] ?? ''}` : 'Homelab'}</p>
          <h1 className="status-line">{!stats ? 'Checking the server…' : down.length === 0 ? 'Everything is running.' : `${down.length} ${down.length === 1 ? 'thing needs' : 'things need'} a look.`}
            <Help big title="This page: Overview">Live health of the server, refreshed every 5 seconds. The rings are the Proxmox host's CPU, memory and disk. <b>Sites</b> shows which apps answer right now. <b>Containers and VMs</b> lists every guest; unlock with the main password to start, stop or restart them. The moving map in the background is your server: the bright hub is Proxmox and each dot is a container (bright = running).</Help>
          </h1>
          <p className="lede">{!stats ? config.subtitle : down.length === 0 ? `${running} containers and ${upCount} sites are up. Proxmox has been running for ${duration(stats.host.uptime)}.` : down.join(', ') + (down.length === 1 ? ' is down.' : ' are down.')}</p>
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
          <Ring help="How busy the server's processor is right now, across all threads. Load is the average queue over 1, 5 and 15 minutes." value={stats.host.cpu} label="CPU" detail={`${stats.host.cpus} threads · load ${stats.host.load.slice(0, 3).join(' ')}`} />
          <Ring help="RAM in use on the Proxmox host by all containers and VMs together. Above 90% turns red: stop something or give the server more memory." value={ratio(stats.host.mem, stats.host.maxmem)} label="Memory" detail={`${bytes(stats.host.mem)} of ${bytes(stats.host.maxmem)}`} />
          <Ring help="The Proxmox system disk (where the OS and templates live). Container disks are listed under Storage." value={ratio(stats.host.disk, stats.host.maxdisk)} label="System disk" detail={`${bytes(stats.host.disk)} of ${bytes(stats.host.maxdisk)}`} />
          {db && <Ring help="Memory used by the shared MongoDB container (CT 106) that CodeZi and the flight monitor store their data in." value={ratio(db.mem, db.maxmem)} label="Database memory" detail={`MongoDB · CT 106 · ${db.status}`} />}
        </section>
      )}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="pulse" />Sites <Help title="Sites">Each app is checked every 30 seconds. Green means it answered, with the response time. Red means it gave an error or no answer. Click a name to open it.</Help></h2><a href="#/services" className="link">All services</a></div>
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
          <div className="panel-head"><h2><Icon name="disk" />Storage <Help title="Storage">Disk space on each Proxmox storage. local holds templates and backups; local-lvm holds the container and VM disks.</Help></h2></div>
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
        <div className="panel-head"><h2><Icon name="box" />Containers and VMs <Help title="Containers and VMs">Every guest on the server with its CPU, memory and disk use. Once unlocked: ↻ restarts, ■ stops and ▶ starts (stop and restart ask first). Delete only shows on guests made from this dashboard. Jacob's app (102) is never touched, and the proxy (101) and this dashboard (105) can't be stopped from here.</Help></h2><span className="muted">{query ? `${guests.length} match "${query}"` : `${guests.length} total`}</span></div>
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
      <header className="hero"><div><p className="eyebrow">Services</p><h1>Apps on the server <Help big title="This page: Services">Every app the server runs, plus admin and code links. Click a card to open it. The dot on each card shows whether it answers right now (checked every 30 seconds). Use the search bar to filter.</Help></h1><p className="lede">Open a site, or use the search bar to find one.</p></div></header>
      <section className="cards">{shown.map((s) => <SiteCard key={s.id} site={s} state={sites[s.id]} />)}</section>
      <h2 className="section-title">Admin and code <Help title="Admin and code">Proxmox opens the server's admin panel (only over Tailscale). The GitHub links open each app's code; a push to main deploys it automatically.</Help></h2>
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

// ---------- notes (saved prompts, to-dos, scratch note), stored on the dashboard server ----------
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const PROMPT_KEY = 'homelab-use-prompt';
function useNotes(pass: string) {
  const [notes, setNotes] = useState<Notes | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const latest = useRef<Notes | null>(null);
  useEffect(() => {
    if (!pass) return;
    fetch('./api/notes', { headers: { 'x-dashboard-password': pass } })
      .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.message || 'Could not load notes.'); latest.current = b; setNotes(b); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load notes.'));
  }, [pass]);
  const save = async (next: Notes) => {
    latest.current = next; setNotes(next); setState('saving');
    try {
      const r = await fetch('./api/notes', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass }, body: JSON.stringify(next) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.message || 'Could not save.');
      setState(latest.current === next ? 'saved' : 'saving'); setError('');
    } catch (e) { setState('error'); setError(e instanceof Error ? e.message : 'Could not save.'); }
  };
  const update = (change: (n: Notes) => Notes) => { if (latest.current) void save(change(latest.current)); };
  return { notes, state, error, update };
}

const NotesPage = ({ query, pass, onLogin }: { query: string; pass: string; onLogin: (p: string) => void }) => {
  const { notes, state, error, update } = useNotes(pass);
  const [draft, setDraft] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [newTodo, setNewTodo] = useState('');
  useEffect(() => {
    if (draft === null || !notes || draft === notes.note) return undefined;
    const t = window.setTimeout(() => update((n) => ({ ...n, note: draft })), 800);
    return () => window.clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pass) return (<><header className="hero"><div><p className="eyebrow">Notes</p><h1>Your notes</h1><p className="lede">Saved prompts and to-dos, on the server so they follow you to any device.</p></div></header><Login onLogin={onLogin} /></>);
  if (!notes) return <p className={error ? 'message error' : 'muted'}>{error || 'Loading notes…'}</p>;
  const prompts = notes.prompts.filter((p) => matches(query, p.text));
  const todos = notes.todos.filter((t) => matches(query, t.text));
  const open = todos.filter((t) => !t.done); const done = todos.filter((t) => t.done);
  const usePrompt = (text: string) => { try { sessionStorage.setItem(PROMPT_KEY, text); } catch { /* ignore */ } window.location.hash = '#/sites'; };
  const addPrompt = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!newPrompt.trim()) return; update((n) => ({ ...n, prompts: [{ id: newId(), text: newPrompt.trim(), at: new Date().toISOString() }, ...n.prompts] })); setNewPrompt(''); };
  const addTodo = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!newTodo.trim()) return; update((n) => ({ ...n, todos: [...n.todos, { id: newId(), text: newTodo.trim(), at: new Date().toISOString(), done: false }] })); setNewTodo(''); };
  const toggle = (id: string) => update((n) => ({ ...n, todos: n.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) }));
  const dropTodo = (id: string) => update((n) => ({ ...n, todos: n.todos.filter((t) => t.id !== id) }));
  const dropPrompt = (id: string) => update((n) => ({ ...n, prompts: n.prompts.filter((p) => p.id !== id) }));
  const status = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? error : notes.updated ? `Last saved ${new Date(notes.updated).toLocaleString()}` : '';
  return (
    <>
      <header className="hero"><div><p className="eyebrow">Notes</p><h1>Your notes <Help big title="This page: Notes">To-dos, saved prompts and a scratch note. Everything is saved on the server, so it is the same on your phone and laptop. Saved prompts have a Build site button that opens the website builder with that text.</Help></h1><p className="lede">Saved prompts and to-dos, on the server so they follow you to any device.</p></div><span className={`muted hint ${state === 'error' ? 'bad' : ''}`}>{status}</span></header>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="check" />To do <Help title="To do">Type a task and press Enter. Tick it when done; × deletes it. Clear done removes all ticked tasks.</Help></h2><span className="muted">{open.length} open</span></div>
          <form className="add-row" onSubmit={addTodo}><input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="Add a to-do and press Enter" aria-label="New to-do" /><button className="primary" type="submit"><Icon name="plus" /></button></form>
          <ul className="todo-list">
            {[...open, ...done].map((t) => (
              <li key={t.id} className={t.done ? 'done' : ''}>
                <label><input type="checkbox" checked={!!t.done} onChange={() => toggle(t.id)} /><span>{t.text}</span></label>
                <button type="button" className="x" aria-label="Delete" onClick={() => dropTodo(t.id)}>×</button>
              </li>
            ))}
            {!todos.length && <li className="muted">Nothing to do. Nice.</li>}
          </ul>
          {done.length > 0 && <button type="button" className="link-btn" onClick={() => update((n) => ({ ...n, todos: n.todos.filter((t) => !t.done) }))}>Clear {done.length} done</button>}
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Icon name="bookmark" />Saved prompts <Help title="Saved prompts">Keep website ideas or tasks for later. Build site opens the website builder with the prompt filled in. Copy puts it on your clipboard for Gemini or Claude.</Help></h2><span className="muted">{prompts.length}</span></div>
          <form className="add-row" onSubmit={addPrompt}><textarea rows={2} value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder="Save a prompt for later (website ideas, Gemini tasks…)" aria-label="New prompt" /><button className="primary" type="submit"><Icon name="plus" /></button></form>
          <ul className="prompt-list">
            {prompts.map((p) => (
              <li key={p.id}>
                <p>{p.text}</p>
                <div className="prompt-actions">
                  <span className="muted">{new Date(p.at).toLocaleDateString()}</span>
                  <button type="button" className="ghost" onClick={() => usePrompt(p.text)}><Icon name="spark" className="icon-xs" />Build site</button>
                  <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(p.text)}>Copy</button>
                  <button type="button" className="x" aria-label="Delete" onClick={() => dropPrompt(p.id)}>×</button>
                </div>
              </li>
            ))}
            {!prompts.length && <li className="muted">No saved prompts yet. Use the bookmark button in the website builder, or add one here.</li>}
          </ul>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><h2><Icon name="note" />Scratch note <Help title="Scratch note">Free text for anything. It saves by itself a moment after you stop typing.</Help></h2><span className="muted">saves as you type</span></div>
        <textarea className="scratch" rows={8} value={draft ?? notes.note} onChange={(e) => setDraft(e.target.value)} placeholder="Anything: ideas, links, what to ask Claude next…" />
      </section>
    </>
  );
};

const JOB_KEY = 'homelab-job';
const readJob = (): { name: string; kind: string } | null => { try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null'); } catch { return null; } };
const saveJob = (value: { name: string; kind: string } | null) => { try { if (value) sessionStorage.setItem(JOB_KEY, JSON.stringify(value)); else sessionStorage.removeItem(JOB_KEY); } catch { /* private mode */ } };
const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
const STOP = new Set(['a', 'an', 'the', 'site', 'website', 'web', 'page', 'for', 'my', 'our', 'with', 'about', 'of', 'and', 'small', 'simple', 'new', 'i', 'want', 'make', 'me', 'build', 'create']);
const IDEAS = ['A site for a small bakery with a menu, opening hours and a contact page', 'A portfolio for a student web developer with projects and an about page', 'A page for our school robotics team: who we are, competitions, join us'];

const Sites = ({ query, routes, sites, pass, onLogin }: { query: string; routes: Route[]; sites: Record<string, SiteState>; pass: string; onLogin: (p: string) => void }) => {
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [sitePass, setSitePass] = useState('');
  const [editing, setEditing] = useState<Route | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [tracking, setTracking] = useState(readJob);
  const [job, setJob] = useState<Job | null>(null);
  const [rName, setRName] = useState('');
  const [rTarget, setRTarget] = useState('http://10.0.0.');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedPrompt, setSavedPrompt] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const call = async (label: string, url: string, init: RequestInit = {}) => {
    setBusy(label); setError('');
    try {
      const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Request failed.');
      return body;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return null; } finally { setBusy(''); }
  };

  useEffect(() => { try { const p = sessionStorage.getItem(PROMPT_KEY); if (p) { setPrompt(p); sessionStorage.removeItem(PROMPT_KEY); } } catch { /* ignore */ } }, []);
  useEffect(() => { fetch('./api/ai').then((r) => r.json()).then((b: { ai: boolean }) => setAi(b.ai)).catch(() => setAi(false)); }, []);
  useEffect(() => { if (!nameTouched && !editing) setName(slug(prompt.split(/[.,:\n]/)[0].split(/\s+/).filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2).join(' '))); }, [prompt, nameTouched, editing]);
  useEffect(() => {
    if (!tracking || !pass) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const response = await fetch(`./api/wordpress/jobs/${tracking.name}`, { headers: { 'x-dashboard-password': pass } });
        const body = await response.json();
        if (stop) return;
        if (!response.ok) { setError(body.message || 'Lost track of the build.'); setTracking(null); saveJob(null); return; }
        setJob(body as Job);
        if (body.state !== 'running') { setTracking(null); saveJob(null); }
      } catch { /* network blip: try again */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => { stop = true; window.clearInterval(timer); };
  }, [tracking, pass]);

  const follow = (target: { name: string; kind: string }) => { setJob({ state: 'running', kind: target.kind as Job['kind'], step: 'Starting', error: '', result: null }); setTracking(target); saveJob(target); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing) {
      const body = await call('go', `./api/wordpress/${editing.name}/ai`, { method: 'POST', body: JSON.stringify({ prompt }) });
      if (body) { follow({ name: editing.name, kind: 'ai' }); setPrompt(''); }
      return;
    }
    const body = await call('go', './api/wordpress', { method: 'POST', body: JSON.stringify({ name, password: sitePass, prompt: ai ? prompt : '' }) });
    if (body) { follow({ name, kind: 'create' }); setPrompt(''); setName(''); setNameTouched(false); setSitePass(''); }
  };
  const bookmark = async () => {
    const current = await call('mark', './api/notes', { method: 'GET' });
    if (!current) return;
    const next = { ...current, prompts: [{ id: newId(), text: prompt.trim(), at: new Date().toISOString() }, ...(current.prompts || [])] };
    if (await call('mark', './api/notes', { method: 'PUT', body: JSON.stringify(next) })) { setSavedPrompt(true); window.setTimeout(() => setSavedPrompt(false), 2500); }
  };
  const saveKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await call('key', './api/ai/key', { method: 'PUT', body: JSON.stringify({ key }) })) { setAi(true); setKey(''); }
  };
  const newRoute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await call('route', './api/routes', { method: 'POST', body: JSON.stringify({ name: rName, target: rTarget, title: rName }) })) { setRName(''); setRTarget('http://10.0.0.'); }
  };
  const remove = async (r: Route) => {
    const msg = r.kind === 'wordpress' ? `Delete the WordPress site "${r.title}"? Its pages, uploads and database are destroyed.` : `Remove the route ${r.path}? The app itself is not touched.`;
    if (window.confirm(msg)) await call(`del:${r.name}`, `./api/routes/${r.name}`, { method: 'DELETE' });
  };
  const startEdit = (r: Route) => { setEditing(r); setJob(null); window.scrollTo({ top: 0, behavior: 'smooth' }); window.setTimeout(() => box.current?.focus(), 300); };

  const running = !!tracking;
  const shown = routes.filter((r) => matches(query, r.name, r.title, r.path, r.kind));
  const ready = editing ? prompt.trim().length > 3 : SITE_NAME.test(name) && sitePass.length >= 8;
  return (
    <>
      <section className="builder">
        <p className="eyebrow"><Icon name="spark" className="icon-xs" /> Website builder</p>
        <h1>{editing ? <>What should change on {editing.title}?</> : <>What website do you want?</>}
          <Help big title="This page: Sites">Build a WordPress website with AI. 1. Describe it in the box. 2. Pick a name: it becomes the address /sites/name/. 3. Set a password for the WordPress login (user admin). 4. Press Create. It takes 1–2 minutes and you can leave the page. Your sites are listed below: Edit with AI changes their pages, wp-admin opens WordPress to edit by hand.</Help>
        </h1>
        <form className="ai-box" onSubmit={submit}>
          <textarea ref={box} rows={3} value={prompt} disabled={running} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && ready && pass) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
            placeholder={editing ? 'e.g. Add a contact page and make the home page more friendly' : ai === false ? 'Add your Gemini key below to let AI write the pages. You can still create an empty site.' : 'Describe it: who it is for, which pages, the feel…'} />
          <div className="ai-row">
            {editing ? (
              <span className="chip">Editing /sites/{editing.name}/ <button type="button" aria-label="Stop editing" onClick={() => setEditing(null)}>×</button></span>
            ) : (
              <>
                <label className="pill"><span>Name <Help title="Site name">Becomes the web address /sites/name/. Lowercase letters, digits and dashes. It fills in from your description; change it if you like.</Help></span><input value={name} pattern="[a-z0-9][a-z0-9\-]{1,30}" onChange={(e) => { setNameTouched(true); setName(slug(e.target.value)); }} placeholder="bakery" aria-label="Site name" /></label>
                <label className="pill"><span>Password <Help title="Site password">The WordPress login password for this site (user admin), at least 8 characters. Write it down: it is not shown again.</Help></span><input type="password" value={sitePass} minLength={8} autoComplete="new-password" onChange={(e) => setSitePass(e.target.value)} placeholder="8+ characters" aria-label="Site password" /></label>
              </>
            )}
            <span className="ai-actions">
              {pass && prompt.trim().length > 3 && <Help title="Save">Saves the text in the box to Notes, under Saved prompts, so you can reuse it later.</Help>}
              {pass && prompt.trim().length > 3 && <button type="button" className="mark" title="Save this prompt to Notes" aria-label="Save prompt to Notes" disabled={busy === 'mark'} onClick={() => void bookmark()}><Icon name="bookmark" className="icon-xs" />{savedPrompt ? 'Saved' : 'Save'}</button>}
              <Help title={editing ? 'Apply' : 'Create'}>{editing ? 'Gemini reads the site and rewrites the pages as you asked. Removed pages go to the WordPress trash, so nothing is lost for good.' : !pass ? 'Unlock with the main password first (form below).' : 'Builds WordPress, then Gemini writes the pages from your description. Needs a name and an 8+ character password. Enter in the box does the same.'}</Help>
              <button className="send" type="submit" disabled={!pass || !ready || running || !!busy} aria-label={editing ? 'Apply changes' : 'Create website'}>
                {busy === 'go' ? '…' : <><Icon name={editing ? 'spark' : 'send'} />{editing ? 'Apply' : 'Create'}</>}
              </button>
            </span>
          </div>
        </form>
        {!editing && !prompt && ai !== false && <div className="ideas"><Help title="Ideas">Example descriptions. Click one to put it in the box, then edit it.</Help>{IDEAS.map((idea) => <button key={idea} type="button" onClick={() => setPrompt(idea)}>{idea}</button>)}</div>}
        {!editing && name && <p className="muted hint">Address: /sites/{name}/ · log in to WordPress as <code>admin</code> with the password you set.</p>}
      </section>

      {error && <p className="message error">{error}</p>}
      {job && (
        <section className={`panel notice ${job.state === 'failed' ? 'error' : ''}`}>
          {job.state === 'running' && <><h2><span className="spinner" />{job.step}…</h2><p>{job.kind === 'create' ? 'A new site takes one to two minutes. You can leave this page; it keeps going.' : 'Gemini is rewriting the pages, usually under a minute.'}</p></>}
          {job.state === 'failed' && <><h2>That did not work</h2><p>{job.error}</p></>}
          {job.state === 'done' && job.result && (
            <>
              <h2>{job.kind === 'create' ? 'Your website is live' : 'Changes published'}</h2>
              <ol>
                <li>Site: <a className="link" href={job.result.url} target="_blank" rel="noreferrer">{job.result.url}</a></li>
                <li>Edit by hand: <a className="link" href={job.result.admin_url} target="_blank" rel="noreferrer">{job.result.admin_url}</a>{job.kind === 'create' && <> · user <code>admin</code>{job.result.admin_password ? <> · password <code>{job.result.admin_password}</code></> : ' · your password'}</>}</li>
                {job.result.ai_note && <li>The site was created but AI could not write the pages: {job.result.ai_note}. Use “Edit with AI” to try again.</li>}
              </ol>
            </>
          )}
        </section>
      )}
      {!pass && <Login onLogin={onLogin} />}
      {pass && ai === false && (
        <form className="panel form key-form" onSubmit={saveKey}>
          <h2><Icon name="spark" />Connect Gemini <Help title="Gemini key">The builder uses Google Gemini to write the pages. Make a key at aistudio.google.com and paste it once. It is stored only on the websites server (CT 108) and never shown again.</Help></h2>
          <p className="muted hint">Get a key at aistudio.google.com → Get API key, then paste it here. It is saved on the websites server only, and never shown again.</p>
          <div className="row"><input type="password" required value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your Gemini API key" autoComplete="off" /><button className="primary" type="submit" disabled={busy === 'key'}>{busy === 'key' ? 'Saving…' : 'Save key'}</button></div>
        </form>
      )}

      <section className="panel">
        <div className="panel-head"><h2><Icon name="grid" />Your sites <Help title="Your sites">Websites and apps you added. The dot shows whether each answers. Edit with AI: describe a change and Gemini rewrites the pages. wp-admin: edit text, images and menus by hand (user admin). Delete: removes a WordPress site with its pages and database (asks first, cannot be undone); for an app it only removes the address.</Help></h2><span className="muted">{shown.length} extra site{shown.length === 1 ? '' : 's'}</span></div>
        <ul className="site-list">
          {shown.map((r) => {
            const state = sites[`route:${r.name}`];
            return (
              <li key={r.name}>
                <Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} />
                <a href={`.${r.path}`}>{r.title}</a>
                <span className="muted">{r.path} · {r.kind === 'wordpress' ? 'WordPress' : 'app'}</span>
                {r.kind === 'wordpress' && pass && ai && <button type="button" className="ghost" disabled={running} onClick={() => startEdit(r)}><Icon name="spark" className="icon-xs" />Edit with AI</button>}
                {r.kind === 'wordpress' && <a className="link" href={`.${r.path}wp-admin/`} target="_blank" rel="noreferrer">wp-admin</a>}
                {pass && <button type="button" className="danger" disabled={busy === `del:${r.name}`} onClick={() => void remove(r)}>{busy === `del:${r.name}` ? '…' : 'Delete'}</button>}
              </li>
            );
          })}
          {!shown.length && <li className="muted">No extra sites yet.</li>}
        </ul>
      </section>
      {pass && (
        <details className="panel more">
          <summary>Publish an app instead <Help title="Publish an app">Gives any app running on your network a public address /name/. Enter where it runs on the LAN, like http://10.0.0.225:8080/.</Help></summary>
          <form className="form" onSubmit={newRoute}>
            <label>Name (becomes /name/)<input required pattern="[a-z0-9][a-z0-9-]{0,39}" value={rName} onChange={(e) => setRName(e.target.value.toLowerCase())} placeholder="e.g. notes" /></label>
            <label>App address on the LAN<input required value={rTarget} onChange={(e) => setRTarget(e.target.value)} placeholder="http://10.0.0.225:8080/" /></label>
            <button className="primary" disabled={!!busy} type="submit"><Icon name="plus" />{busy === 'route' ? 'Adding…' : 'Add route'}</button>
          </form>
        </details>
      )}
    </>
  );
};
const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

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
      <header className="hero"><div><p className="eyebrow">Proxmox</p><h1>Create a container or VM <Help big title="This page: Create">Make a new guest on Proxmox. A container (LXC) is light and starts in seconds, good for one app or Docker. A VM is a full computer, cloned from your VM template. New guests get the dashboard tag, so you can delete them from the Overview later.</Help></h1><p className="lede">Containers start from a fresh Debian image; VMs are cloned from your VM template.</p></div></header>
      {!pass ? <Login onLogin={onLogin} /> : <form className="panel form" onSubmit={submit}>
        <div className="segmented" role="radiogroup">
          <Help title="Container or VM">Container: shares the server's Linux kernel, uses little memory, best for most apps. VM: its own operating system, for Windows or anything that needs full isolation.</Help>
          <button type="button" className={type === 'lxc' ? 'on' : ''} onClick={() => setType('lxc')}><Icon name="box" />Container (LXC)</button>
          <button type="button" className={type === 'vm' ? 'on' : ''} onClick={() => setType('vm')}><Icon name="server" />Virtual machine</button>
        </div>
        <label><span>Name <Help title="Name">The guest's hostname. Lowercase letters, digits and dashes.</Help></span><input required minLength={2} maxLength={50} pattern="[a-z0-9][a-z0-9-]*" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. paperless" /></label>
        <div className="row-2">
          <label><span>CPU cores <Help title="CPU cores">How many processor threads it may use. 1–2 is plenty for a small app.</Help></span><input type="number" min={1} max={8} value={cores} onChange={(e) => setCores(Number(e.target.value))} /></label>
          <label><span>Memory (MiB) <Help title="Memory">RAM in MiB: 1024 = 1 GB. The server has 16 GB shared by everything.</Help></span><input type="number" min={256} max={8192} step={256} value={memory} onChange={(e) => setMemory(Number(e.target.value))} /></label>
        </div>
        <label><span>Disk (GB) <Help title="Disk">Disk size in GB. It can be grown later in Proxmox, not shrunk.</Help></span><input type="number" min={2} max={100} value={disk} onChange={(e) => setDisk(Number(e.target.value))} /></label>
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
    // one pointer position for the whole page: panels light up under the cursor (see .panel in CSS)
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { document.documentElement.style.setProperty('--mx', `${e.clientX}px`); document.documentElement.style.setProperty('--my', `${e.clientY}px`); });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('hashchange', onHash); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey); window.removeEventListener('pointermove', onMove); window.clearInterval(clock); };
  }, []);

  const q = query.trim().toLowerCase();
  const nav: [Page, string, string][] = [['overview', 'Overview', 'grid'], ['services', 'Services', 'server'], ['sites', 'Sites', 'pulse'], ['notes', 'Notes', 'note'], ['provision', 'Create', 'plus']];

  return (
    <div className="shell">
      <Backdrop guests={(stats?.guests ?? []).map((g) => ({ id: g.id, status: g.status }))} />
      <aside className="side">
        <a className="brand" href="#/"><span className="logo">HL</span><span>Homelab</span></a>
        <nav>
          {nav.map(([id, label, icon]) => (
            <a key={id} href={`#/${id === 'overview' ? '' : id}`} className={page === id ? 'active' : ''}><Icon name={icon} />{label}</a>
          ))}
        </nav>
        <div className="lock">
          {pass ? <button type="button" className="link-btn" onClick={() => { savePass(''); setPass(''); }}>🔓 Unlocked, press to lock</button> : <a href="#/provision" className="link-btn">🔒 Locked, press to unlock</a>}
          <Help title="Lock">Unlocked means the main password is remembered in this tab, so you can create, delete, start and stop things. Press to lock again. Closing the tab locks too.</Help>
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
          <Help title="Search">Filters what is on the current page: sites, containers, links and notes. Press / to jump here and Esc to clear.</Help>
        </div>
        <div className="page" key={page}>
        {page === 'overview' && <Overview query={q} stats={stats} statsError={statsError} sites={sites} pass={pass} />}
        {page === 'services' && <Services query={q} sites={sites} />}
        {page === 'sites' && <Sites query={q} routes={routeData?.routes ?? []} sites={sites} pass={pass} onLogin={setPass} />}
        {page === 'notes' && <NotesPage query={q} pass={pass} onLogin={setPass} />}
        {page === 'provision' && <Provision pass={pass} onLogin={setPass} />}
        </div>
      </main>
    </div>
  );
}
