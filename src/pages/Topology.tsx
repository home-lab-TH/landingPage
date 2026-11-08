import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import config from '../config/services.json';
import { Icon, bytes, duration, pct, ratio } from '../lib';
import type { Guest, Stats } from '../lib';

// Hand-drawn SVG map of how traffic reaches each container. Drag nodes to arrange; positions stay in this browser.
type N = { id: string; label: string; sub: string; x: number; y: number; kind: 'edge' | 'proxy' | 'guest' | 'db'; guest?: Guest };
const W = 1000; const H = 620;
const POS_KEY = 'homelab-topology';
const network = config.network as Record<string, string>;
const stacks = config.stacks as Record<string, string[]>;
const ROUTED = [105, 100, 103, 102, 108];
const DEFAULTS: Record<string, [number, number]> = {
  internet: [90, 310], '101': [300, 310],
  '105': [560, 110], '100': [560, 220], '103': [560, 330], '102': [560, 440], '108': [560, 550],
  '106': [830, 275], '107': [830, 440], '104': [830, 550],
};
const readPos = (): Record<string, [number, number]> => { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } };

export default function Topology({ stats }: { stats: Stats | null }) {
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
      list.push({ id, label: g.name, sub: `CT ${g.id}`, x: def[0], y: def[1], kind: g.id === 101 ? 'proxy' : g.id === 106 ? 'db' : 'guest', guest: g });
    }
    return list.map((n) => { const p = pos[n.id] ?? DEFAULTS[n.id] ?? [n.x, n.y]; return { ...n, x: p[0], y: p[1] }; });
  }, [stats, pos]);

  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links: [string, string, string?][] = [['internet', '101', 'https'], ...ROUTED.map((id): [string, string] => ['101', String(id)]), ['100', '106', 'mongo'], ['103', '106', 'mongo']];

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
  return (
    <>
      <header className="page-head">
        <h1>Topology</h1>
        <p className="lede">How a request reaches each app. Drag to arrange, click for details.</p>
      </header>
      <div className="topo">
        <section className="panel topo-map">
          <div className="panel-head"><h2><Icon name="map" />Network</h2><button type="button" className="ghost" onClick={reset}>Reset layout</button></div>
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="topo-svg" role="img" aria-label="Network map">
            <rect x="200" y="20" width="780" height="580" rx="18" className="host-frame" />
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
          {!sel && <p className="muted">Click a node.</p>}
          {sel && (
            <>
              <p className="eyebrow">{sel.kind === 'edge' ? 'Entry point' : sel.sub}</p>
              <h2>{sel.label}</h2>
              {sel.kind === 'edge' ? (
                <p className="muted">Public traffic arrives over Tailscale Funnel at central-proxy.bluebuck-tailor.ts.net and is routed by nginx on CT 101.</p>
              ) : g && (
                <>
                  <dl className="facts">
                    <dt>Status</dt><dd>{g.status}</dd>
                    <dt>Address</dt><dd className="mono">{network[sel.id] ?? '–'}</dd>
                    <dt>Uptime</dt><dd>{g.status === 'running' ? duration(g.uptime) : '–'}</dd>
                    <dt>CPU</dt><dd className="mono">{pct(g.cpu)}</dd>
                    <dt>Memory</dt><dd className="mono">{bytes(g.mem)} / {bytes(g.maxmem)}</dd>
                    <dt>Disk</dt><dd className="mono">{pct(ratio(g.disk, g.maxdisk))}</dd>
                  </dl>
                  {stacks[sel.id] && <div className="chips">{stacks[sel.id].map((c) => <span key={c} className="chip">{c}</span>)}</div>}
                  <a className="link" href={`#/logs/ct-${sel.id}`}>Logs →</a>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
