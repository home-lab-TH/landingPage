import { useEffect, useMemo, useState } from 'react';
import config from '../config/services.json';
import { Help } from '../ui/Help';
import { HealthPanel, HistoryPanel, UptimeBars, useUptime } from '../ui/Charts';
import { Bar, Dot, Icon, bytes, duration, level, matches, pct, ratio } from '../lib';
import type { Guest, SiteState, Stats } from '../lib';

const stacks = config.stacks as Record<string, string[]>;
const network = config.network as Record<string, string>;
const KNOWN_KEY = 'homelab-known-guests';

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

function GuestCard({ g, pass, busy, isNew, onPower, onRemove }: { g: Guest; pass: string; busy: boolean; isNew: boolean; onPower: (g: Guest, a: 'start' | 'stop' | 'restart') => void; onRemove: (g: Guest) => void }) {
  const running = g.status === 'running';
  const chips = stacks[String(g.id)] ?? [];
  return (
    <article className={`vm ${running ? '' : 'off'}`}>
      <div className="vm-head">
        <h3><span className="mono dim">{g.id}</span>{g.name}<Dot state={running ? 'up' : 'idle'} /></h3>
        <span className="pills">
          {isNew && <span className="pill new">New</span>}
          {g.type === 'vm' && <span className="pill">VM</span>}
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
      {pass && g.id !== 102 && (
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
      )}
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

export default function Overview({ query, stats, statsError, sites, pass }: { query: string; stats: Stats | null; statsError: { code: number; message: string } | null; sites: Record<string, SiteState>; pass: string }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const { fresh, seen } = useNewGuests(stats?.guests);
  const uptime = useUptime(24);

  const power = async (g: Guest, action: 'start' | 'stop' | 'restart') => {
    if (action !== 'start' && !window.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} ${g.name} (${g.id})?`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}/power/${action}`, { method: 'POST', headers: { 'x-dashboard-password': pass } });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || `${action} failed.`);
      setNote(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${g.name}…`);
    } catch (e) { setNote(e instanceof Error ? e.message : `${action} failed.`); } finally { setBusy(null); }
  };
  const remove = async (g: Guest) => {
    if (!window.confirm(`Delete ${g.type.toUpperCase()} ${g.id} (${g.name})? This destroys it and its disk.`)) return;
    setBusy(g.id); setNote('');
    try {
      const response = await fetch(`./api/guests/${g.id}`, { method: 'DELETE', headers: { 'x-dashboard-password': pass } });
      const body: { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message || 'Delete failed.');
      setNote(`Deleting ${g.name}…`);
    } catch (e) { setNote(e instanceof Error ? e.message : 'Delete failed.'); } finally { setBusy(null); }
  };

  const guests = useMemo(() => (stats?.guests ?? []).filter((g) => matches(query, g.name, g.id, g.type, g.status)).sort((a, b) => a.id - b.id), [stats, query]);
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
      <section className="panel hero">
        <div className="hero-top">
          <span className="live"><i />Live</span>
          <span className="mono dim">{stats ? `${stats.node} · Proxmox ${stats.host.version.split('/')[1] ?? ''}` : ''}</span>
        </div>
        <h1 className="status-line">{!stats ? 'Checking the server…' : down.length === 0 ? 'Everything is running.' : `${down.length} ${down.length === 1 ? 'thing needs' : 'things need'} a look.`}</h1>
        <p className="lede">{!stats ? config.subtitle : down.length === 0 ? `${running} guests and ${upCount} sites up · Proxmox running ${duration(stats.host.uptime)}` : `${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} down`}</p>
        {stats && (
          <div className="stats">
            <Stat label="CPU" value={pct(stats.host.cpu)} detail={`${stats.host.cpus} threads · load ${stats.host.load[0] ?? '-'}`} r={stats.host.cpu} />
            <Stat label="Memory" value={bytes(stats.host.mem)} detail={`of ${bytes(stats.host.maxmem)}`} r={ratio(stats.host.mem, stats.host.maxmem)} />
            <Stat label="System disk" value={pct(ratio(stats.host.disk, stats.host.maxdisk))} detail={`${bytes(stats.host.disk)} of ${bytes(stats.host.maxdisk)}`} r={ratio(stats.host.disk, stats.host.maxdisk)} />
            {db && <Stat label="Database" value={bytes(db.mem)} detail={`MongoDB · CT 106`} r={ratio(db.mem, db.maxmem)} help="Memory used by the shared MongoDB container that CodeZi and the flight monitor use." />}
          </div>
        )}
      </section>

      {statsError && statsError.code === 503 && <SetupNotice message={statsError.message} />}
      {statsError && statsError.code !== 503 && <section className="panel notice error"><h2>Can't read server stats</h2><p>{statsError.message}</p></section>}

      {fresh.length > 0 && (
        <section className="panel notice new-guests">
          <h2><span className="pill new">New</span>{fresh.length === 1 ? 'A new guest appeared' : `${fresh.length} new guests appeared`}</h2>
          <p>{fresh.map((g) => `${g.name} (${g.id})`).join(', ')}</p>
          <button type="button" className="ghost" onClick={seen}>Mark as seen</button>
        </section>
      )}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="pulse" />Sites <Help title="Sites">Checked every minute. Bars: last 24 hours, one per half hour.</Help></h2><a href="#/services" className="link">Services →</a></div>
          <ul className="site-list">
            {shownSites.map((site) => {
              const state = sites[site.id];
              return (
                <li key={site.id}>
                  <Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} />
                  <a href={site.url}>{site.title}</a>
                  <span className="mono dim">{!state ? '…' : state.up ? `${state.ms} ms` : state.code ? `${state.code}` : 'no answer'}</span>
                  <UptimeBars data={uptime[site.id]} />
                </li>
              );
            })}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Icon name="disk" />Storage</h2></div>
          {(stats?.storage ?? []).map((s) => (
            <div className="storage" key={s.name}>
              <div className="row"><strong>{s.name}</strong><span className="mono dim">{bytes(s.used)} / {bytes(s.total)}</span></div>
              <Bar value={ratio(s.used, s.total)} />
            </div>
          ))}
          {!stats && <p className="muted">Waiting for Proxmox…</p>}
        </section>
      </div>

      {stats && <HistoryPanel />}
      <HealthPanel pass={pass} />

      <section className="panel">
        <div className="panel-head">
          <h2><Icon name="box" />Containers and VMs <span className="count">{query ? `${guests.length} match` : `${running}/${stats?.guests.length ?? 0}`}</span>
            <Help title="Containers and VMs">Unlock to open logs (≡), restart (↻), stop (■) or start (▶). Jacob's app (102) is never touched; the proxy (101) and this dashboard (105) can't be stopped here.</Help></h2>
          <a href="#/topology" className="link">Topology →</a>
        </div>
        {note && <p className="message success">{note}</p>}
        <div className="guests">
          {guests.map((g) => <GuestCard key={g.id} g={g} pass={pass} busy={busy === g.id} isNew={fresh.some((f) => f.id === g.id)} onPower={(x, a) => void power(x, a)} onRemove={(x) => void remove(x)} />)}
        </div>
        {stats && guests.length === 0 && <p className="muted">Nothing matches "{query}".</p>}
      </section>
    </>
  );
}
