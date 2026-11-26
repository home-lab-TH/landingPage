import { useEffect, useRef, useState } from 'react';
import { Dot, Icon, copyText, matches, usePoll } from '../lib';
import '../styles/minecraft.css';

// ---- local API contracts (mirrors ./api/minecraft and ./api/nodes) ----
interface MinecraftServer {
  id: string;
  name: string;
  host: string;
  port: number;
  joinAddress: string;
  type: string;
  ram: string;
  online: boolean;
  ms: number | null;
  version: string | null;
  players: { online: number; max: number; sample?: string[] };
  motd: string | null;
}
interface MinecraftData {
  updatedAt: string;
  host: {
    node: string;
    nodeIp: string;
    ct: number;
    ctName: string;
    ip: string;
    craftyUp: boolean;
    craftyMs: number | null;
    craftyUrls: string[];
    backupSchedule: string;
  };
  servers: MinecraftServer[];
}
interface HomelabNode {
  id: string;
  name: string;
  ip: string;
  port: number;
  role: string;
  specs: string;
  online: boolean;
  ms: number | null;
  url: string;
}
interface NodesData { updatedAt: string; nodes: HomelabNode[] }

const PRIMARY_ADDRESS = 'mc.avrahamarazi.com';
const CRAFTY_PUBLIC = 'https://crafty.avrahamarazi.com';
const CRAFTY_FUNNEL_FALLBACK = 'https://central-proxy.bluebuck-tailor.ts.net:8443';

const fmtMs = (ms: number | null | undefined) => (ms == null ? '–' : `${Math.round(ms)} ms`);
const pingClass = (ms: number | null | undefined) => (ms == null ? '' : ms < 60 ? 'good' : ms < 150 ? 'fair' : 'slow');

/** Copy button with a short-lived "Copied!" state. */
function CopyButton({ text, label = 'Copy Address', className = 'btn' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  };
  return (
    <button type="button" className={`${className} mc-copy ${state === 'ok' ? 'copied' : ''}`} onClick={() => void onClick()} aria-live="polite">
      <Icon name={state === 'ok' ? 'check' : 'copy'} />
      {state === 'ok' ? 'Copied!' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

function ServerCard({ s }: { s: MinecraftServer }) {
  const max = Math.max(0, s.players?.max ?? 0);
  const online = Math.max(0, s.players?.online ?? 0);
  const fill = max > 0 ? Math.min(100, (online / max) * 100) : 0;
  const sample = s.players?.sample ?? [];
  const isModded = /neoforge|forge|fabric|bmc|modpack/i.test(`${s.type} ${s.name}`);
  return (
    <article className={`mc-card ${s.online ? 'is-up' : 'is-down'}`}>
      <div className="mc-card-top">
        <span className={`mc-status ${s.online ? 'up' : 'down'}`}><i />{s.online ? 'Online' : 'Offline'}</span>
        <span className={`mc-ping ${pingClass(s.ms)}`}><Icon name="activity" className="icon-xs" />{s.online ? fmtMs(s.ms) : '–'}</span>
      </div>

      <div className="mc-card-title">
        <span className={`mc-block ${isModded ? 'modded' : 'vanilla'}`} aria-hidden="true" />
        <div>
          <h3>{s.name}</h3>
          <p className="mc-motd">{s.motd || (s.online ? 'No MOTD set' : 'Server is not responding')}</p>
        </div>
      </div>

      <div className="mc-badges">
        {s.version && <span className="mc-badge ver">v{s.version}</span>}
        <span className={`mc-badge ${isModded ? 'mod' : 'paper'}`}>{s.type}</span>
        <span className="mc-badge ram"><Icon name="server" className="icon-xs" />{s.ram}</span>
      </div>

      <div className="mc-players">
        <div className="mc-players-head">
          <span><Icon name="users" className="icon-xs" /> Players</span>
          <b className="mono">{s.online ? `${online} / ${max}` : '– / –'}</b>
        </div>
        <div className="mc-cap" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={online}>
          <span style={{ width: `${s.online ? fill : 0}%` }} />
        </div>
        {sample.length > 0 ? (
          <div className="mc-chips">
            {sample.map((p) => (
              <span className="mc-player" key={p}><span className="mc-head" aria-hidden="true">{p.slice(0, 1).toUpperCase()}</span>{p}</span>
            ))}
          </div>
        ) : (
          <p className="mc-empty">{s.online ? 'Nobody online — be the first to join.' : 'Players unavailable while offline.'}</p>
        )}
      </div>

      <div className="mc-join">
        <div className="mc-join-addr">
          <span className="mc-join-label">Join address</span>
          <code>{s.joinAddress}</code>
        </div>
        <CopyButton text={s.joinAddress} className="btn solid" />
      </div>
    </article>
  );
}

export default function Minecraft({ query = '' }: { query?: string }) {
  const { data, error } = usePoll<MinecraftData>('./api/minecraft', 10000);
  const { data: nodesData, error: nodesError } = usePoll<NodesData>('./api/nodes', 15000);
  const [guideOpen, setGuideOpen] = useState(true);

  const q = query.trim().toLowerCase();
  const servers = data?.servers ?? [];
  const shown = servers.filter((s) => matches(q, s.name, s.type, s.joinAddress, s.version ?? '', s.motd ?? '', s.id));
  const up = servers.filter((s) => s.online).length;
  const players = servers.reduce((n, s) => n + (s.online ? s.players?.online ?? 0 : 0), 0);
  const host = data?.host;
  const funnel = host?.craftyUrls?.find((u) => u.includes(':8443')) ?? CRAFTY_FUNNEL_FALLBACK;
  const nodes = nodesData?.nodes ?? [];

  const headline = !data
    ? error ? 'Realm status unavailable' : 'Checking the realm…'
    : `${up}/${servers.length} Servers Online · ${players} Player${players === 1 ? '' : 's'} Active`;
  const heroState = !data ? 'idle' : up === servers.length && servers.length > 0 ? 'up' : up === 0 ? 'down' : 'partial';

  return (
    <div className="mc-page">
      {/* ---------- Hero ---------- */}
      <section className={`mc-hero ${heroState}`}>
        <div className="mc-hero-grid" aria-hidden="true" />
        <div className="mc-hero-body">
          <p className="eyebrow mc-eyebrow"><Icon name="gamepad" className="icon-xs" />Minecraft Realm · CT {host?.ct ?? 200} on {host?.node ?? 'PVE2'}</p>
          <h1 className="mc-headline">
            <span className={`mc-live ${heroState}`} aria-hidden="true" />
            {headline}
          </h1>
          <p className="lede mc-lede">
            Two worlds, one realm — a Better MC modpack server and a lightweight Vanilla Paper server, managed by Crafty Controller.
            {data && <span className="mc-updated"> Updated {new Date(data.updatedAt).toLocaleTimeString()}.</span>}
          </p>
          {error && !data && <p className="mc-error"><Icon name="alert" className="icon-xs" />{error.message}</p>}
          <div className="mc-actions">
            <a className="btn solid" href={funnel} target="_blank" rel="noreferrer"><Icon name="terminal" />Open Crafty Controller <span className="mc-tag">:8443</span></a>
            <a className="btn" href={CRAFTY_PUBLIC} target="_blank" rel="noreferrer"><Icon name="external" />Open Crafty</a>
            <CopyButton text={PRIMARY_ADDRESS} label={`Copy ${PRIMARY_ADDRESS}`} />
          </div>
        </div>
      </section>

      {/* ---------- Servers ---------- */}
      <section className="panel mc-panel">
        <div className="panel-head">
          <h2><Icon name="box" />Live Servers</h2>
          <span className="muted mc-sub">{data ? `${shown.length} of ${servers.length} shown · refreshes every 10s` : 'Loading…'}</span>
        </div>
        {!data && !error && (
          <div className="mc-grid">{[0, 1].map((i) => <div className="mc-card mc-skeleton" key={i} />)}</div>
        )}
        {data && shown.length === 0 && <p className="muted">No servers match “{query}”.</p>}
        {shown.length > 0 && <div className="mc-grid">{shown.map((s) => <ServerCard s={s} key={s.id} />)}</div>}
      </section>

      {/* ---------- Infrastructure ---------- */}
      <div className="grid-2 mc-infra">
        <section className="panel mc-panel">
          <div className="panel-head">
            <h2><Icon name="server" />CT {host?.ct ?? 200} Host &amp; Crafty</h2>
            <span className={`pill ${host ? (host.craftyUp ? 'up' : 'down') : ''}`}><i />Crafty {host ? (host.craftyUp ? 'online' : 'offline') : '…'}</span>
          </div>
          <dl className="mc-facts">
            <dt>Container</dt><dd className="mono">CT {host?.ct ?? 200} · {host?.ctName ?? 'minecraft'}</dd>
            <dt>Address</dt><dd className="mono">{host?.ip ?? '10.0.0.160'}</dd>
            <dt>Proxmox node</dt><dd className="mono">{host?.node ?? 'pve2'}{host?.nodeIp ? ` · ${host.nodeIp}` : ''}</dd>
            <dt>Crafty latency</dt><dd className={`mono mc-ping ${pingClass(host?.craftyMs)}`}>{fmtMs(host?.craftyMs)}</dd>
            <dt>Backups</dt><dd>{host?.backupSchedule ?? 'Nightly 04:15 → server:/mnt/backup2/minecraft'}</dd>
          </dl>
          {host?.craftyUrls && host.craftyUrls.length > 0 && (
            <div className="mc-links">
              {host.craftyUrls.map((u) => (
                <a key={u} className="chip mono" href={u} target="_blank" rel="noreferrer"><Icon name="external" className="icon-xs" />{u.replace(/^https?:\/\//, '')}</a>
              ))}
            </div>
          )}
        </section>

        <section className="panel mc-panel">
          <div className="panel-head">
            <h2><Icon name="grid" />Proxmox Nodes</h2>
            <span className="muted mc-sub">{nodes.length ? `${nodes.filter((n) => n.online).length}/${nodes.length} up` : nodesError ? 'unavailable' : 'Loading…'}</span>
          </div>
          {nodesError && !nodesData && <p className="mc-error"><Icon name="alert" className="icon-xs" />{nodesError.message}</p>}
          <ul className="mc-nodes">
            {nodes.map((n) => (
              <li key={n.id} className={`mc-node ${n.online ? '' : 'off'} ${n.id === (host?.node ?? 'pve2') || n.name === (host?.node ?? 'pve2') ? 'is-host' : ''}`}>
                <Dot state={n.online ? 'up' : 'down'} />
                <div className="mc-node-main">
                  <div className="mc-node-name">
                    <a href={n.url} target="_blank" rel="noreferrer">{n.name}</a>
                    <span className="mc-node-role">{n.role}</span>
                  </div>
                  <div className="mc-node-meta mono">{n.ip}:{n.port} · {n.specs}</div>
                </div>
                <span className={`mc-ping mono ${pingClass(n.ms)}`}>{n.online ? fmtMs(n.ms) : 'down'}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ---------- Quick join guide ---------- */}
      <section className="panel mc-panel mc-guide">
        <button type="button" className="mc-guide-toggle" onClick={() => setGuideOpen((o) => !o)} aria-expanded={guideOpen}>
          <h2><Icon name="spark" />Quick Join Guide</h2>
          <Icon name="chevron" className={`icon mc-chev ${guideOpen ? 'open' : ''}`} />
        </button>
        {guideOpen && (
          <div className="mc-guide-body">
            <div className="mc-track">
              <h3><span className="mc-block modded" aria-hidden="true" />Better MC <span className="mc-badge mod">[BMC5] v53 · NeoForge 1.21.1</span></h3>
              <ol className="mc-steps">
                <li><b>1</b><div><strong>Get the launcher</strong><p>Install <em>CurseForge</em> (or <em>SKlauncher</em> for non-premium accounts).</p></div></li>
                <li><b>2</b><div><strong>Install the modpack</strong><p>Search <code>Better MC [NEOFORGE] BMC5</code>, pick version <code>v53</code>, and give it 6–8 GB RAM.</p></div></li>
                <li><b>3</b><div><strong>Join</strong><p>Multiplayer → Add Server → paste the Better MC join address from the card above.</p></div></li>
              </ol>
            </div>
            <div className="mc-track">
              <h3><span className="mc-block vanilla" aria-hidden="true" />Vanilla Paper <span className="mc-badge paper">No mods needed</span></h3>
              <ol className="mc-steps">
                <li><b>1</b><div><strong>Launch Minecraft</strong><p>Official launcher or SKlauncher — any matching vanilla release.</p></div></li>
                <li><b>2</b><div><strong>Match the version</strong><p>Use the version shown on the Paper server card.</p></div></li>
                <li><b>3</b><div><strong>Join</strong><p>Multiplayer → Direct Connect → <code>{PRIMARY_ADDRESS}</code></p></div></li>
              </ol>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
