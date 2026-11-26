import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import config from '../config/services.json';
import { Icon, bytes, duration, pct, ratio } from '../lib';
import type { Guest, Stats } from '../lib';

// Hand-drawn SVG map of how traffic reaches each container. Drag nodes to arrange; positions stay in this browser.
type N = { id: string; label: string; sub: string; x: number; y: number; kind: 'edge' | 'proxy' | 'guest' | 'db'; guest?: Guest };
const W = 1000; const H = 670;
const POS_KEY = 'homelab-topology';
const network = config.network as Record<string, string>;
const stacks = config.stacks as Record<string, string[]>;
const ROUTED = [105, 100, 103, 102, 108, 110];
const DEFAULTS: Record<string, [number, number]> = {
  internet: [90, 310], '101': [300, 310],
  '105': [560, 110], '100': [560, 220], '103': [560, 330], '102': [560, 440], '108': [560, 550], '110': [560, 620],
  '106': [830, 275], '107': [830, 440], '104': [830, 550], '111': [830, 620],
};
const readPos = (): Record<string, [number, number]> => { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } };

export default function Topology({ stats, pass }: { stats: Stats | null; pass: string }) {
  const [pos, setPos] = useState<Record<string, [number, number]>>(readPos);
  const [picked, setPicked] = useState<string>('101');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  const nodes = useMemo<N[]>(() => {
    const guests = stats?.guests ?? [];
    const list: N[] = [{ id: 'internet', label: 'Internet', sub: 'via Funnel', x: 0, y: 0, kind: 'edge' }];
    let extra = 0;
    for (const g of [...guests].sort((a, b) => a.id - b.id)) {
      const id = String(g.id);
      const def = DEFAULTS[id] ?? [830, 110 + (extra++) * 80];
      list.push({ id, label: g.name, sub: pass ? `CT ${g.id}` : g.id === 101 ? 'proxy' : g.id === 106 ? 'database' : 'service', x: def[0], y: def[1], kind: g.id === 101 ? 'proxy' : g.id === 106 ? 'db' : 'guest', guest: g });
    }
    return list.map((n) => { const p = pos[n.id] ?? DEFAULTS[n.id] ?? [n.x, n.y]; return { ...n, x: p[0], y: p[1] }; });
  }, [stats, pos, pass]);

  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links: [string, string, string?][] = [['internet', '101', 'https'], ...ROUTED.map((id): [string, string] => ['101', String(id)]), ['100', '106', 'mongo'], ['103', '106', 'mongo'], ['110', '106', 'mongo']];

  const toSvg = (e: RPointerEvent) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    return { x: (e.clientX - m.e) / m.a, y: (e.clientY - m.f) / m.d };
  };
  const down = (e: RPointerEvent<SVGGElement>, n: N) => {
    const p = toSvg(e);
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent<SVGGElement>) => {
    const d = drag.current; if (!d) return;
    const p = toSvg(e);
    const x = Math.max(60, Math.min(W - 60, p.x - d.dx)); const y = Math.max(30, Math.min(H - 30, p.y - d.dy));
    d.moved = true;
    setPos((old) => ({ ...old, [d.id]: [Math.round(x), Math.round(y)] }));
  };
  const up = (n: N) => {
    const d = drag.current; drag.current = null;
    if (d?.moved) setPos((old) => { try { localStorage.setItem(POS_KEY, JSON.stringify(old)); } catch { /* private mode */ } return old; });
    else setPicked(n.id);
  };
  const reset = () => { setPos({}); try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ } };

  const sel = by[picked];
  const g = sel?.guest;
  const guestNodes = nodes.filter((n) => n.guest);
  const runningCount = guestNodes.filter((n) => n.guest?.status === 'running').length;
  const stoppedCount = guestNodes.length - runningCount;
  const routedPath = sel && ROUTED.includes(Number(sel.id)) ? `CT 101 → CT ${sel.id}` : null;
  return (
    <>
      <header className="page-head">
        <h1>Topology</h1>
        <p className="lede">How a request reaches each app. Drag to arrange, click for details.</p>
      </header>
      <div className="services-summary" aria-label="Topology summary">
        <span className="summary-chip"><b>{nodes.length}</b> node{nodes.length === 1 ? '' : 's'}</span>
        <span className="summary-chip ok"><span className="led-dot on" aria-hidden="true">●</span><b>{runningCount}</b> running</span>
        <span className={`summary-chip ${stoppedCount ? 'warn' : ''}`}><span className="led-dot off" aria-hidden="true">●</span><b>{stoppedCount}</b> stopped</span>
        <span className="summary-chip muted"><Icon name="map" className="icon-xs" />Click any node for details · drag to arrange</span>
      </div>
      {guestNodes.length > 0 && (
        <div className="filter-bar">
          <div className="filter-pills" role="group" aria-label="Select a node">
            {nodes.map((n) => {
              const on = n.guest ? n.guest.status === 'running' : true;
              return (
                <button key={n.id} type="button" className={`filter-pill ${picked === n.id ? 'active on' : ''}`} aria-pressed={picked === n.id} onClick={() => setPicked(n.id)} title={`${n.label}: ${on ? 'running' : 'stopped'}`}>
                  <span className={`led-dot ${on ? 'on' : 'off'}`} aria-hidden="true" style={{ color: on ? 'var(--ok, #3fb950)' : 'var(--bad, #f85149)' }}>●</span> {n.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {!stats && <p className="muted hint">Waiting for live stats from Proxmox… the map fills in as soon as they arrive.</p>}
      <div className="topo">
        <section className="panel topo-map">
          <div className="panel-head"><h2><Icon name="map" />Network</h2><button type="button" className="ghost" onClick={reset}>Reset layout</button></div>
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="topo-svg" role="img" aria-label="Network map">
            <rect x="200" y="20" width="780" height="630" rx="18" className="host-frame" />
            <text x="222" y="48" className="host-label">Proxmox · {stats?.node ?? 'server'}</text>
            {links.map(([a, b, label]) => {
              const A = by[a]; const B = by[b]; if (!A || !B) return null;
              const live = (A.guest ? A.guest.status === 'running' : true) && (B.guest ? B.guest.status === 'running' : false);
              const mx = (A.x + B.x) / 2;
              return (
                <g key={`${a}-${b}`}>
                  <path d={`M${A.x},${A.y} C${mx},${A.y} ${mx},${B.y} ${B.x},${B.y}`} className={`edge ${live ? 'live' : ''}`} />
                  {label && <text x={mx} y={(A.y + B.y) / 2 - 8} className="edge-label">{label}</text>}
                </g>
              );
            })}
            {nodes.map((n) => {
              const on = n.guest ? n.guest.status === 'running' : true;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`node ${n.kind} ${on ? 'on' : 'off'} ${picked === n.id ? 'picked' : ''}`}
                  onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={() => up(n)} tabIndex={0} role="button" aria-label={`${n.label} ${on ? 'running' : 'stopped'}`}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPicked(n.id); }}>
                  <rect x="-68" y="-24" width="136" height="48" rx="12" />
                  <circle cx="-52" cy="0" r="4.5" className="led" />
                  <text x="-40" y="-3" className="n-label">{n.label.length > 13 ? `${n.label.slice(0, 12)}…` : n.label}</text>
                  <text x="-40" y="13" className="n-sub">{n.sub}</text>
                </g>
              );
            })}
          </svg>
        </section>
        <aside className="panel topo-info">
          {!sel && <p className="muted empty-state">Click a node on the map (or a pill above) to see its details.</p>}
          {sel && (
            <>
              <p className="eyebrow">{sel.kind === 'edge' ? 'Entry point' : sel.kind === 'proxy' ? 'Reverse proxy' : sel.kind === 'db' ? 'Database' : 'Service'}{pass && sel.kind !== 'edge' ? ` · ${sel.sub}` : ''}</p>
              <h2>{sel.label}</h2>
              {sel.kind === 'edge' ? (
                <p className="muted">Public traffic arrives over Tailscale Funnel at central-proxy.bluebuck-tailor.ts.net and is routed by nginx on CT 101.</p>
              ) : g && (
                <>
                  <p className="status-line"><span className={`pill ${g.status === 'running' ? 'ok' : 'bad'}`}><span aria-hidden="true">●</span> {g.status === 'running' ? 'Running' : g.status}</span>
                    {g.status === 'running' && <span className="muted"> up {duration(g.uptime)}</span>}</p>
                  {routedPath && <p className="muted hint">Traffic path: Internet → {routedPath}</p>}
                  <h3 className="muted">Details</h3>
                  <dl className="facts">
                    <dt>Status</dt><dd>{g.status}</dd>
                    {pass && <><dt>Address</dt><dd className="mono">{network[sel.id] ?? '–'}</dd></>}
                    <dt>Uptime</dt><dd>{g.status === 'running' ? duration(g.uptime) : '–'}</dd>
                    {pass && <>
                      <dt>CPU</dt><dd className="mono">{pct(g.cpu)}</dd>
                      <dt>Memory</dt><dd className="mono">{bytes(g.mem)} / {bytes(g.maxmem)}</dd>
                      <dt>Disk</dt><dd className="mono">{pct(ratio(g.disk, g.maxdisk))}</dd>
                    </>}
                  </dl>
                  {stacks[sel.id] && <><h3 className="muted">Stack</h3><div className="chips">{stacks[sel.id].map((c) => <span key={c} className="chip">{c}</span>)}</div></>}
                  <h3 className="muted">Quick links</h3>
                  <div className="result-links">
                    {sel.id === '102' ? (
                      <span className="pill"><Icon name="lock" className="icon-xs" />Protected</span>
                    ) : pass ? (
                      <a className="link" href={`#/logs/ct-${sel.id}`}>Logs →</a>
                    ) : (
                      <a className="link muted" href="#/login">Unlock for IP, metrics &amp; logs →</a>
                    )}
                    <a className="link" href="#/services">All services →</a>
                  </div>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
