import { useEffect, useMemo, useState } from 'react';
import config from '../config/services.json';
import { Help } from '../ui/Help';
import { HealthPanel, HistoryPanel, UptimeBars, useUptime } from '../ui/Charts';
import { Bar, Dot, Icon, authHeaders, bytes, duration, level, matches, pct, ratio, usePoll } from '../lib';
import type { AuthUser, Guest, MinecraftData, NodesData, SiteState, Stats } from '../lib';

const stacks = config.stacks as Record<string, string[]>;
const network = config.network as Record<string, string>;
const KNOWN_KEY = 'homelab-known-guests';
const VIEW_KEY = 'homelab-guest-view';
const SHOWCASE_DISMISSED_KEY = 'homelab-recruiter-showcase-dismissed';

type PowerAction = 'start' | 'stop' | 'restart';
type PowerFn = (g: Guest, a: PowerAction) => void;
type Filter = 'all' | 'running' | 'stopped';
type View = 'cards' | 'compact';

// Guests that appeared since this browser last looked. First visit just records what exists.
function useNewGuests(guests: Guest[] | undefined) {
  const [known, setKnown] = useState<number[] | null>(() => { try { const v = localStorage.getItem(KNOWN_KEY); return v ? JSON.parse(v) : null; } catch { return null; } });
  useEffect(() => {
    if (!guests?.length || known !== null) return;
    const ids = guests.map((g) => g.id);
    setKnown(ids);
    try { localStorage.setItem(KNOWN_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
  }, [guests, known]);
  const fresh = known ? (guests ?? []).filter((g) => !known.includes(g.id)) : [];
  const seen = () => {
    const ids = (guests ?? []).map((g) => g.id);
    setKnown(ids);
    try { localStorage.setItem(KNOWN_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
  };
  return { fresh, seen };
}

const Stat = ({ label, value, detail, r, help }: { label: string; value: string; detail: string; r: number; help?: string }) => (
  <div className="stat">
    <small>{label}{help && <Help title={label}>{help}</Help>}</small>
    <b>{value}</b>
    <span className="muted">{detail}</span>
    <div className={`meter ${level(r)}`}><span style={{ transform: `scaleX(${r})` }} /></div>
  </div>
);

const siteStatus = (state: SiteState | undefined, pending = '…') =>
  !state ? pending : state.up ? `${state.ms} ms` : state.code ? `HTTP ${state.code}` : 'no answer';
const siteDot = (state: SiteState | undefined): 'up' | 'down' | 'idle' => (!state ? 'idle' : state.up ? 'up' : 'down');

// CT 102 (Jacob's app) is read-only; CT 101 (proxy) and CT 105 (this dashboard) can't be stopped.
function GuestActions({ g, busy, onPower, onRemove }: { g: Guest; busy: boolean; onPower: PowerFn; onRemove: (g: Guest) => void }) {
  if (g.id === 102) return <span className="muted protected-note"><Icon name="lock" className="icon-xs" />Read-only</span>;
  const running = g.status === 'running';
  return (
    <div className="acts">
      <a className="act" href={`#/logs/ct-${g.id}`} title="Logs" aria-label={`Logs for ${g.name}`}>≡</a>
      {running ? (
        <>
          <button type="button" className="act" disabled={busy} onClick={() => onPower(g, 'restart')} title="Restart" aria-label={`Restart ${g.name}`}>↻</button>
          {g.id !== 101 && g.id !== 105 && <button type="button" className="act" disabled={busy} onClick={() => onPower(g, 'stop')} title="Stop" aria-label={`Stop ${g.name}`}>■</button>}
        </>
      ) : <button type="button" className="act" disabled={busy} onClick={() => onPower(g, 'start')} title="Start" aria-label={`Start ${g.name}`}>▶</button>}
      {g.tags?.includes('dashboard') && <button type="button" className="act danger" disabled={busy} onClick={() => onRemove(g)}>{busy ? '…' : 'Delete'}</button>}
    </div>
  );
}

function GuestCard({ g, pass, busy, isNew, onPower, onRemove }: { g: Guest; pass: string; busy: boolean; isNew: boolean; onPower: PowerFn; onRemove: (g: Guest) => void }) {
  const running = g.status === 'running';
  const chips = stacks[String(g.id)] ?? [];
  return (
    <article className={`vm ${running ? '' : 'off'}`}>
      <div className="vm-head">
        <h3><span className="mono dim">{g.id}</span>{g.name}<Dot state={running ? 'up' : 'idle'} /></h3>
        <span className="pills">
          {isNew && <span className="pill new">New</span>}
          {g.type === 'vm' && <span className="pill">VM</span>}
          {g.id === 102 && <span className="pill"><Icon name="lock" className="icon-xs" />Protected</span>}
          {g.id === 106 && <span className="pill"><Icon name="db" className="icon-xs" />DB</span>}
        </span>
      </div>
      <p className="vm-meta mono">{network[String(g.id)] ?? ''}{network[String(g.id)] ? ' · ' : ''}{running ? duration(g.uptime) : g.status}</p>
      <div className="tiles">
        <div className="tile"><small>CPU</small><b>{running ? pct(g.cpu) : '–'}</b></div>
        <div className="tile"><small>RAM</small><b>{bytes(g.mem)}</b><Bar value={ratio(g.mem, g.maxmem)} /></div>
        <div className="tile"><small>Disk</small><b>{pct(ratio(g.disk, g.maxdisk))}</b><Bar value={ratio(g.disk, g.maxdisk)} /></div>
      </div>
      {chips.length > 0 && <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
      {pass && g.id !== 102 && <GuestActions g={g} busy={busy} onPower={onPower} onRemove={onRemove} />}
    </article>
  );
}

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

export default function Overview({ query, stats, statsError, sites, pass, user = null }: { query: string; stats: Stats | null; statsError: { code: number; message: string } | null; sites: Record<string, SiteState>; pass: string; user?: AuthUser | null }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'compact' ? 'compact' : 'cards'; } catch { return 'cards'; } });
  const [showcaseDismissed, setShowcaseDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(SHOWCASE_DISMISSED_KEY) === '1'; } catch { return false; }
  });
  const { fresh, seen } = useNewGuests(stats?.guests);
  const uptime = useUptime(24);
  const { data: nodesData } = usePoll<NodesData>('./api/nodes', 15000);
  const { data: mcData } = usePoll<MinecraftData>('./api/minecraft', 10000);
  const nodes = nodesData?.nodes ?? [];
  const mcServers = mcData?.servers ?? [];
  const craftyUrl = mcData?.host.craftyUrls[0];

  const chooseView = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };
  const dismissShowcase = () => {
    setShowcaseDismissed(true);
    try { sessionStorage.setItem(SHOWCASE_DISMISSED_KEY, '1'); } catch { /* ignore */ }
  };

  const power = async (g: Guest, action: PowerAction) => {
    if (action !== 'start' && !window.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} ${g.name} (${g.id})?`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}/power/${action}`, { method: 'POST', credentials: 'same-origin', headers: authHeaders(pass) });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || `${action} failed.`);
      setNote(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${g.name}…`);
    } catch (e) { setNote(e instanceof Error ? e.message : `${action} failed.`); } finally { setBusy(null); }
  };
  const remove = async (g: Guest) => {
    if (!window.confirm(`Delete ${g.type.toUpperCase()} ${g.id} (${g.name})? This destroys it and its disk.`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}`, { method: 'DELETE', credentials: 'same-origin', headers: authHeaders(pass) });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || 'Delete failed.');
      setNote(`Deleting ${g.name}…`);
    } catch (e) { setNote(e instanceof Error ? e.message : 'Delete failed.'); } finally { setBusy(null); }
  };
  const onPower: PowerFn = (x, a) => void power(x, a);
  const onRemove = (x: Guest) => void remove(x);

  const guests = useMemo(() => (stats?.guests ?? []).filter((g) => matches(query, g.name, g.id, g.type, g.status)).sort((a, b) => a.id - b.id), [stats, query]);
  const counts: Record<Filter, number> = {
    all: guests.length,
    running: guests.filter((g) => g.status === 'running').length,
    stopped: guests.filter((g) => g.status !== 'running').length,
  };
  const filtered = filter === 'all' ? guests : guests.filter((g) => (g.status === 'running') === (filter === 'running'));
  const db = stats?.guests.find((g) => g.id === 106);
  const running = stats?.guests.filter((g) => g.status === 'running').length ?? 0;
  const upCount = config.sites.filter((s) => sites[s.id]?.up).length;
  const down = [
    ...config.sites.filter((s) => sites[s.id] && !sites[s.id].up).map((s) => s.title),
    ...(stats?.guests ?? []).filter((g) => g.status !== 'running' && g.id !== 102 && g.id !== 104).map((g) => g.name),
  ];
  const shownSites = config.sites.filter((s) => matches(query, s.title, s.description, ...s.tags));

  return (
    <>
      {user?.role === 'recruiter_guest' && !showcaseDismissed && (
        <section className="panel showcase-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow"><Icon name="spark" className="icon-xs" />Recruiter Guided Showcase</p>
              <h2>Welcome, {user.displayName}</h2>
            </div>
            <button type="button" className="x" aria-label="Dismiss Recruiter Guided Showcase" onClick={dismissShowcase}>×</button>
          </div>
          <p className="lede">
            You are exploring a live self-hosted Proxmox VE homelab running LXC containers, Docker apps, MongoDB, AI website builders, Mission Control agents, and the Night Lab // Arcade 2077 game hub with unified SSO.
          </p>
          <div className="quick-links">
            <a className="btn solid" href="#/services"><Icon name="server" />Explore Live Services →</a>
            <a className="btn" href="#/topology"><Icon name="map" />Interactive Topology →</a>
            <a className="btn" href="#/provision"><Icon name="plus" />Spin Up a Sandbox VM/LXC →</a>
            <a className="btn" href="./game/"><Icon name="gamepad" />Play Night Lab // Arcade 2077 →</a>
          </div>
          <p className="sandbox-note">
            <Icon name="shield" className="icon-xs" />
            <span>
              <strong>Sandbox policy:</strong> Any VMs or containers you create are automatically tagged <code>sandbox-guest</code> in Proxmox and can be safely tested and deleted. CT 102 (Jacob&apos;s app) and host system updates are protected.
            </span>
          </p>
        </section>
      )}

      {/* 1 · Hero & KPI strip */}
      <section className="panel hero hero-v4">
        <div className="hero-top">
          <span className="live"><i />Live</span>
          <span className="mono dim">{stats ? `${stats.node} · Proxmox ${stats.host.version.split('/')[1] ?? ''}` : ''}</span>
          <nav className="hero-actions" aria-label="Quick actions">
            <a className="btn solid" href="#/services"><Icon name="server" />Explore Services</a>
            <a className="btn" href="#/topology"><Icon name="map" />Topology</a>
            <a className="btn" href="./game/"><Icon name="gamepad" />Arcade 2077</a>
            <a className="btn" href="#/minecraft"><Icon name="cube" />Minecraft</a>
            {user ? (
              <>
                <a className="btn" href="#/agents"><Icon name="bot" />Agents</a>
                <a className="btn" href="#/provision"><Icon name="plus" />Create</a>
              </>
            ) : <a className="btn" href="#/login"><Icon name="key" />Sign in</a>}
          </nav>
        </div>
        <h1 className="status-line">{!stats ? 'Checking the server…' : down.length === 0 ? 'Everything is running.' : `${down.length} ${down.length === 1 ? 'thing needs' : 'things need'} a look.`}</h1>
        <p className="lede">{!stats ? config.subtitle : down.length === 0 ? `${running} guests and ${upCount}/${config.sites.length} sites up · Proxmox running ${duration(stats.host.uptime)}` : `${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} down`}</p>
        {stats && (
          <div className="stats kpi-grid">
            <Stat label="CPU" value={pct(stats.host.cpu)} detail={`${stats.host.cpus} threads · load ${stats.host.load[0] ?? '-'}`} r={stats.host.cpu} />
            <Stat label="Memory" value={pct(ratio(stats.host.mem, stats.host.maxmem))} detail={`${bytes(stats.host.mem)} of ${bytes(stats.host.maxmem)}`} r={ratio(stats.host.mem, stats.host.maxmem)} />
            <Stat label="System disk" value={pct(ratio(stats.host.disk, stats.host.maxdisk))} detail={`${bytes(stats.host.disk)} of ${bytes(stats.host.maxdisk)}`} r={ratio(stats.host.disk, stats.host.maxdisk)} />
            {db && <Stat label="Database" value={pct(ratio(db.mem, db.maxmem))} detail={`MongoDB · CT 106 · ${bytes(db.mem)}`} r={ratio(db.mem, db.maxmem)} help="Memory used by the shared MongoDB container that CodeZi, the news reader and the flight monitor use." />}
          </div>
        )}
      </section>

      {statsError && statsError.code === 503 && <SetupNotice message={statsError.message} />}
      {statsError && statsError.code !== 503 && <section className="panel notice error"><h2>Can't read server stats</h2><p>{statsError.message}</p></section>}

      {pass && fresh.length > 0 && (
        <section className="panel notice new-guests">
          <h2><span className="pill new">New</span>{fresh.length === 1 ? 'A new guest appeared' : `${fresh.length} new guests appeared`}</h2>
          <p>{fresh.map((g) => `${g.name} (${g.id})`).join(', ')}</p>
          <button type="button" className="ghost" onClick={seen}>Mark as seen</button>
        </section>
      )}

      {/* 2 · Quick app launcher */}
      <section className="panel launcher">
        <div className="panel-head">
          <h2><Icon name="grid" />Quick Launch <span className="count">{shownSites.length}</span></h2>
          <a href="#/services" className="link">All Services →</a>
        </div>
        <div className="launcher-grid">
          {shownSites.map((site) => {
            const state = sites[site.id];
            return (
              <a key={site.id} className={`app-tile${state && !state.up ? ' down' : ''}`} href={site.url}>
                <div className="app-tile-head">
                  <span className="app-tile-icon" aria-hidden="true">{site.icon}</span>
                  <div className="app-tile-title">
                    <strong>{site.title}</strong>
                    <span className="app-tile-status mono dim"><Dot state={siteDot(state)} />{siteStatus(state, 'checking…')}</span>
                  </div>
                </div>
                <p className="app-tile-desc">{site.description}</p>
                <div className="app-tile-tags">
                  {site.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                  <span className="chip mono">CT {site.ct}</span>
                </div>
              </a>
            );
          })}
        </div>
        {shownSites.length === 0 && <p className="muted">No apps match "{query}".</p>}
      </section>

      {/* 2b · Proxmox nodes */}
      <section className="panel nodes-panel">
        <div className="panel-head">
          <h2><Icon name="server" />Proxmox Nodes <span className="count">{nodesData ? `${nodes.filter((n) => n.online).length}/${nodes.length || 3} online` : 'checking…'}</span></h2>
          <a href="#/topology" className="link">Topology →</a>
        </div>
        <div className="nodes-grid">
          {nodes.map((n) => (
            <article key={n.id} className={`node-card ${n.online ? 'online' : 'offline'}`}>
              <div className="node-card-top">
                <strong className="mono">{n.name}</strong>
                <Dot state={n.online ? 'up' : 'down'} />
                <span className="mono dim">{n.online ? `${n.ms} ms` : 'offline'}</span>
              </div>
              <p className="node-role">{n.role}</p>
              <p className="node-specs muted">{n.specs}</p>
              <div className="node-foot">
                <code className="mono dim">{n.ip}:{n.port || 8006}</code>
                <a className="link" href={n.url} target="_blank" rel="noreferrer">Proxmox UI ↗</a>
              </div>
            </article>
          ))}
        </div>
        {!nodesData && <p className="muted">Pinging nodes…</p>}
      </section>

      {/* 2c · Minecraft servers */}
      <section className="panel mc-overview-panel">
        <div className="panel-head">
          <h2><Icon name="cube" />Minecraft Servers <span className="count">{mcData ? `${mcServers.filter((m) => m.online).length}/${mcServers.length} online` : 'checking…'}</span>
            {mcData && <span className="mono dim mc-host-note">CT {mcData.host.ct} · {mcData.host.node}</span>}</h2>
          <a href="#/minecraft" className="link">Minecraft Page →</a>
        </div>
        <div className="mc-overview-grid">
          {mcServers.map((m) => (
            <article key={m.id} className={`mc-overview-card ${m.online ? 'online' : 'offline'}`}>
              <div className="mc-overview-top">
                <strong>{m.name}</strong>
                <span className="mono dim"><Dot state={m.online ? 'up' : 'down'} />{m.online ? `${m.ms} ms` : 'offline'}</span>
              </div>
              <div className="chips">
                {m.version && <span className="chip">{m.version}</span>}
                <span className="chip">{m.type}</span>
                <span className="chip mono">{m.ram}</span>
              </div>
              <div className="mc-overview-stats">
                <span><small className="muted">Players</small> <b className="mono">{m.players.online}/{m.players.max}</b></span>
                <code className="mono">{m.joinAddress}</code>
              </div>
              <div className="mc-overview-links">
                <a className="link" href="#/minecraft">Details →</a>
                {craftyUrl && <a className="link" href={craftyUrl} target="_blank" rel="noreferrer">Crafty Controller ↗</a>}
              </div>
            </article>
          ))}
        </div>
        {!mcData && <p className="muted">Querying Minecraft servers…</p>}
      </section>

      {/* 3 · Uptime & storage */}
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="pulse" />Live Sites Uptime <span className="count">{upCount}/{config.sites.length}</span><Help title="Sites">Checked every minute. Bars: last 24 hours, one per half hour.</Help></h2></div>
          <ul className="site-list">
            {shownSites.map((site) => {
              const state = sites[site.id];
              return (
                <li key={site.id}>
                  <Dot state={siteDot(state)} />
                  <a href={site.url}>{site.title}</a>
                  <span className="mono dim">{siteStatus(state)}</span>
                  <UptimeBars data={uptime[site.id]} />
                </li>
              );
            })}
          </ul>
        </section>
        {pass ? (
          <section className="panel">
            <div className="panel-head"><h2><Icon name="disk" />Storage</h2></div>
            {(stats?.storage ?? []).map((s) => (
              <div className="storage" key={s.name}>
                <div className="row"><strong>{s.name}</strong><span className="mono dim">{bytes(s.used)} / {bytes(s.total)} · {pct(ratio(s.used, s.total))}</span></div>
                <Bar value={ratio(s.used, s.total)} />
              </div>
            ))}
            {!stats && <p className="muted">Waiting for Proxmox…</p>}
          </section>
        ) : (
          <section className="panel unlock-card">
            <div className="panel-head"><h2><Icon name="lock" />Unlock Dashboard</h2></div>
            <p className="muted">You're viewing the public status page. Unlocking reveals:</p>
            <ul className="unlock-list">
              <li><Icon name="disk" className="icon-xs" />Storage pools and usage</li>
              <li><Icon name="box" className="icon-xs" />Container IPs, stacks and logs</li>
              <li><Icon name="activity" className="icon-xs" />Hardware health sensors</li>
              <li><Icon name="terminal" className="icon-xs" />Start, stop and restart controls</li>
            </ul>
            <a className="btn solid" href="#/login"><Icon name="unlock" />Unlock →</a>
          </section>
        )}
      </div>

      {/* 4 · Containers & VMs */}
      {!pass ? (
        <section className="panel">
          <div className="panel-head"><h2><Icon name="box" />Containers and VMs <span className="count">{running}/{stats?.guests.length ?? 0}</span></h2></div>
          <p className="muted">{running} of {stats?.guests.length ?? 0} running. Internal container details, IPs, storage, logs and controls are hidden until unlocked.</p>
          <a className="link" href="#/login">Unlock →</a>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2><Icon name="box" />Containers and VMs <span className="count">{query ? `${guests.length} match` : `${running}/${stats?.guests.length ?? 0}`}</span>
              <Help title="Containers and VMs">Open logs (≡), restart (↻), stop (■) or start (▶). Jacob's app (102) is never touched; the proxy (101) and this dashboard (105) can't be stopped here.</Help></h2>
            <a href="#/topology" className="link">Topology →</a>
          </div>
          <div className="filter-bar">
            <div className="filter-pills" role="group" aria-label="Filter by status">
              {(['all', 'running', 'stopped'] as const).map((f) => (
                <button key={f} type="button" className={`filter-pill${filter === f ? ' active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Stopped'}<span className="count">{counts[f]}</span>
                </button>
              ))}
            </div>
            <div className="view-toggle" role="group" aria-label="Layout">
              <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => chooseView('cards')}><Icon name="grid" className="icon-xs" />Cards</button>
              <button type="button" className={view === 'compact' ? 'active' : ''} aria-pressed={view === 'compact'} onClick={() => chooseView('compact')}><Icon name="list" className="icon-xs" />Compact</button>
            </div>
          </div>
          {note && <p className="message success">{note}</p>}
          {view === 'cards' ? (
            <div className="guests">
              {filtered.map((g) => <GuestCard key={g.id} g={g} pass={pass} busy={busy === g.id} isNew={fresh.some((f) => f.id === g.id)} onPower={onPower} onRemove={onRemove} />)}
            </div>
          ) : (
            <div className="guests-table-wrap">
              <table className="guests-table">
                <thead><tr><th>ID</th><th>Name</th><th>IP</th><th>Status</th><th>CPU</th><th>RAM</th><th>Disk</th><th>Actions</th></tr></thead>
                <tbody>
                  {filtered.map((g) => {
                    const on = g.status === 'running';
                    return (
                      <tr key={g.id} className={on ? '' : 'off'}>
                        <td className="mono dim">{g.id}</td>
                        <td>
                          {g.name}
                          {fresh.some((f) => f.id === g.id) && <span className="pill new">New</span>}
                          {g.type === 'vm' && <span className="pill">VM</span>}
                          {g.id === 102 && <span className="pill"><Icon name="lock" className="icon-xs" />Protected</span>}
                        </td>
                        <td className="mono">{network[String(g.id)] ?? '–'}</td>
                        <td><Dot state={on ? 'up' : 'idle'} />{on ? duration(g.uptime) : g.status}</td>
                        <td className="mono">{on ? pct(g.cpu) : '–'}</td>
                        <td className="mono">{bytes(g.mem)}</td>
                        <td className="mono">{pct(ratio(g.disk, g.maxdisk))}</td>
                        <td><GuestActions g={g} busy={busy === g.id} onPower={onPower} onRemove={onRemove} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {stats && filtered.length === 0 && <p className="muted">{query ? `Nothing matches "${query}".` : 'Nothing in this filter.'}</p>}
        </section>
      )}

      {/* 5 · History & hardware health */}
      {stats && <HistoryPanel />}
      {pass && <HealthPanel pass={pass} />}
    </>
  );
}
