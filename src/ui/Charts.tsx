import { useEffect, useMemo, useRef, useState } from 'react';
import { Help } from './Help';

// Lightweight SVG charts: no chart library, so the dashboard stays small and themable.
type Point = { t: number; [k: string]: number | null };
type Series = { key: string; label: string; color: string; format: (v: number) => string };
const RANGES = [['hour', '1 h'], ['day', '24 h'], ['week', '7 days'], ['month', '30 days']] as const;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const rate = (v: number) => (v > 1e6 ? `${(v / 1e6).toFixed(1)} MB/s` : v > 1e3 ? `${(v / 1e3).toFixed(0)} kB/s` : `${Math.round(v)} B/s`);
const when = (t: number, range: string) => new Date(t).toLocaleString([], range === 'hour' || range === 'day' ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', hour: '2-digit' });

function LineChart({ points, series, range, max }: { points: Point[]; series: Series[]; range: string; max?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const W = 600; const H = 150; const P = 4;
  const top = useMemo(() => max ?? Math.max(1e-9, ...points.flatMap((p) => series.map((s) => Number(p[s.key] ?? 0)))) * 1.15, [points, series, max]);
  if (points.length < 2) return <p className="muted chart-empty">Not enough data yet.</p>;
  const t0 = points[0].t; const t1 = points[points.length - 1].t;
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v: number) => H - P - (Math.min(v, top) / top) * (H - 2 * P);
  const line = (key: string) => points.filter((p) => p[key] !== null && p[key] !== undefined).map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(Number(p[key])).toFixed(1)}`).join('');
  const area = (key: string) => { const d = line(key); return d ? `${d}L${x(t1).toFixed(1)},${H - P}L${x(t0).toFixed(1)},${H - P}Z` : ''; };
  const hp = hover !== null ? points[hover] : null;
  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    const tx = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = 0; for (let i = 1; i < points.length; i += 1) if (Math.abs(points[i].t - tx) < Math.abs(points[best].t - tx)) best = i;
    setHover(best);
  };
  return (
    <div className="chart">
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(', ')}>
        <defs>{series.map((s) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={s.color} stopOpacity=".35" /><stop offset="1" stopColor={s.color} stopOpacity="0" /></linearGradient>)}</defs>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} className="grid-line" />)}
        {series.map((s) => <path key={`a${s.key}`} d={area(s.key)} fill={`url(#g-${s.key})`} />)}
        {series.map((s) => <path key={`l${s.key}`} d={line(s.key)} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />)}
        {hp && <line x1={x(hp.t)} x2={x(hp.t)} y1="0" y2={H} className="cursor-line" />}
      </svg>
      <div className="chart-foot">
        <span className="muted">{when(t0, range)}</span>
        <span className="chart-legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}{hp && hp[s.key] !== null && hp[s.key] !== undefined ? `: ${s.format(Number(hp[s.key]))}` : ''}</span>)}{hp && <span className="muted">{when(hp.t, range)}</span>}</span>
        <span className="muted">{when(t1, range)}</span>
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const [range, setRange] = useState<string>(() => { try { return localStorage.getItem('homelab-range') || 'day'; } catch { return 'day'; } });
  const [points, setPoints] = useState<Point[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    try { localStorage.setItem('homelab-range', range); } catch { /* ignore */ }
    const load = () => fetch(`./api/history?range=${range}`).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.message); setPoints(b.points); setError(''); }).catch((e: Error) => setError(e.message));
    void load();
    const t = window.setInterval(() => void load(), range === 'hour' ? 60000 : 300000);
    return () => window.clearInterval(t);
  }, [range]);
  const avg = (k: string) => { const v = points.map((p) => p[k]).filter((n): n is number => typeof n === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  const peak = (k: string) => Math.max(0, ...points.map((p) => Number(p[k] ?? 0)));
  return (
    <section className="panel">
      <div className="panel-head"><h2>Over time <Help title="Over time">How hard the server worked, from Proxmox's own records. Move over a chart to read exact values. CPU and memory are for the whole host; network is the host's traffic in and out.</Help></h2>
        <span className="tools" role="radiogroup" aria-label="Time range">{RANGES.map(([k, l]) => <button key={k} type="button" className={`toggle ${range === k ? 'on' : ''}`} onClick={() => setRange(k)}>{l}</button>)}</span></div>
      {error && <p className="message error">{error}</p>}
      <div className="charts">
        <div><p className="chart-title">CPU <span className="muted">average {pct(avg('cpu'))}, peak {pct(peak('cpu'))}</span></p><LineChart points={points} range={range} max={Math.max(0.2, peak('cpu') * 1.2)} series={[{ key: 'cpu', label: 'CPU', color: '#4fe3c1', format: pct }]} /></div>
        <div><p className="chart-title">Memory <span className="muted">average {pct(avg('mem'))}, peak {pct(peak('mem'))}</span></p><LineChart points={points} range={range} max={1} series={[{ key: 'mem', label: 'Memory', color: '#9b8cff', format: pct }]} /></div>
        <div><p className="chart-title">Network <span className="muted">peak in {rate(peak('netin'))}, out {rate(peak('netout'))}</span></p><LineChart points={points} range={range} series={[{ key: 'netin', label: 'In', color: '#5ab4ff', format: rate }, { key: 'netout', label: 'Out', color: '#ffb547', format: rate }]} /></div>
        <div><p className="chart-title">Disk wait <span className="muted">time the CPU waits for disks</span></p><LineChart points={points} range={range} max={Math.max(0.05, peak('iowait') * 1.2)} series={[{ key: 'iowait', label: 'IO wait', color: '#ff6b81', format: pct }]} /></div>
      </div>
    </section>
  );
}

// 48 bars per site: each one is a slice of the chosen period, colored by how many checks passed.
type Uptime = Record<string, { pct: number | null; ms: number | null; buckets: [number, number | null, number | null][] }>;
export function useUptime(hours = 24) {
  const [data, setData] = useState<Uptime>({});
  useEffect(() => {
    const load = () => fetch(`./api/uptime?hours=${hours}`).then((r) => r.json()).then((b: { sites: Uptime }) => setData(b.sites || {})).catch(() => undefined);
    void load();
    const t = window.setInterval(() => void load(), 120000);
    return () => window.clearInterval(t);
  }, [hours]);
  return data;
}
export function UptimeBars({ data }: { data?: Uptime[string] }) {
  if (!data || !data.buckets.length) return <span className="uptime-bars empty" title="No history yet" />;
  const n = 48; const per = Math.max(1, Math.ceil(data.buckets.length / n));
  const bars: { ok: number | null; t: number }[] = [];
  for (let i = 0; i < data.buckets.length; i += per) {
    const slice = data.buckets.slice(i, i + per).filter((b) => b[1] !== null);
    bars.push({ t: data.buckets[i][0], ok: slice.length ? slice.reduce((a, b) => a + Number(b[1]), 0) / slice.length : null });
  }
  return (
    <span className="uptime-wrap" title={`${data.pct ?? '?'}% up${data.ms ? `, ${data.ms} ms average` : ''}`}>
      <span className="uptime-bars">{bars.slice(-n).map((b, i) => <i key={i} className={b.ok === null ? 'none' : b.ok >= 0.99 ? 'ok' : b.ok >= 0.5 ? 'part' : 'bad'} title={`${new Date(b.t).toLocaleString()}: ${b.ok === null ? 'no data' : `${Math.round(b.ok * 100)}% up`}`} />)}</span>
      <span className="uptime-pct">{data.pct === null ? '–' : `${data.pct}%`}</span>
    </span>
  );
}

// ---------- server health: temperatures and disks ----------
type Temp = { chip: string; label: string; c: number; crit: number | null };
type Disk = { dev: string; model: string; size_gb?: number; passed?: boolean | null; temp?: number | null; hours?: number | null; reallocated?: number | null; pending?: number | null; uncorrectable?: number | null; wear?: number | null; media_errors?: number | null; ssd?: boolean; state: string };
const tempClass = (c: number, crit: number | null) => (c >= (crit ? crit - 5 : 85) ? 'crit' : c >= (crit ? crit - 20 : 70) ? 'warn' : 'ok');

export function HealthPanel({ pass }: { pass: string }) {
  const [h, setH] = useState<{ temps: Temp[]; disks: Disk[]; at: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => fetch('./api/health', { headers: pass ? { 'x-dashboard-password': pass } : {} }).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.message); setH(b); setError(''); }).catch((e: Error) => setError(e.message));
    void load();
    const t = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(t);
  }, [pass]);
  const cpu = (h?.temps ?? []).filter((t) => /coretemp|k10temp|zenpower|cpu|acpitz/i.test(t.chip) || /package|tctl|core/i.test(t.label));
  const hottest = (cpu.length ? cpu : h?.temps ?? []).reduce<Temp | null>((a, t) => (!a || t.c > a.c ? t : a), null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Health <Help title="Health">Temperatures from the server's sensors and the S.M.A.R.T. self-check of every disk, refreshed every minute. A disk with reallocated or pending sectors is starting to fail: copy its data off soon. Spun-down hard disks are not woken just to read them.</Help></h2>
        {hottest && <span className={`chip temp ${tempClass(hottest.c, hottest.crit)}`}>{hottest.c.toFixed(0)}°C {hottest.label}</span>}</div>
      {error && <p className="muted">{error === 'The host agent is not installed.' ? 'Needs the host agent.' : error}</p>}
      {h && (
        <>
          <div className="temps">{(h.temps.length ? h.temps : []).slice(0, 12).map((t, i) => (
            <span key={i} className={`temp-pill ${tempClass(t.c, t.crit)}`} title={`${t.chip} ${t.label}${t.crit ? `, limit ${t.crit}°C` : ''}`}><b>{t.c.toFixed(0)}°</b>{t.label.replace(/^temp\d+$/, t.chip)}</span>
          ))}{!h.temps.length && <span className="muted">No temperature sensors found.</span>}</div>
          <ul className="disks">{h.disks.map((d) => {
            const bad = d.passed === false || (d.reallocated ?? 0) > 0 || (d.pending ?? 0) > 0 || (d.uncorrectable ?? 0) > 0 || (d.media_errors ?? 0) > 0;
            return (
              <li key={d.dev} className={bad ? 'bad-disk' : ''}>
                <span className={`state ${d.state !== 'ok' ? '' : bad ? 'failed' : 'done'}`}>{d.state !== 'ok' ? 'z' : bad ? '!' : '✓'}</span>
                <span className="h-title">{d.dev.replace('/dev/', '')}</span>
                <span className="muted">{d.model}{d.size_gb ? `, ${d.size_gb} GB` : ''}{d.ssd ? ', SSD' : ''}</span>
                <span className="disk-facts">
                  {d.state !== 'ok' ? <span className="muted">{d.state}</span> : <>
                    {d.temp != null && <span className={`temp-pill ${tempClass(d.temp, d.ssd ? 70 : 55)}`}><b>{d.temp}°</b></span>}
                    {d.hours != null && <span className="muted">{Math.round(d.hours / 24 / 365 * 10) / 10} years on</span>}
                    {d.wear != null && <span className="muted">{d.wear}% worn</span>}
                    {bad ? <span className="bad">{d.passed === false ? 'self-check FAILED' : `${(d.reallocated ?? 0) + (d.pending ?? 0)} bad sectors`}</span> : <span className="ok-text">healthy</span>}
                  </>}
                </span>
              </li>
            );
          })}</ul>
        </>
      )}
    </section>
  );
}
