import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import config from './config/services.json';

// ---------- types ----------
export type Page =
  | 'overview'
  | 'services'
  | 'topology'
  | 'sites'
  | 'notes'
  | 'logs'
  | 'updates'
  | 'provision'
  | 'agents'
  | 'users'
  | 'login';
export type ProvisionType = 'vm' | 'lxc';
export type Guest = { id: number; name: string; type: 'lxc' | 'vm'; status: string; cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; tags?: string[] };
export type Host = { cpu: number; cpus: number; model: string; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; load: string[]; version: string };
export type Storage = { name: string; type: string; used: number; total: number };
export type Stats = { configured: boolean; node: string; host: Host; guests: Guest[]; storage: Storage[]; at: string };
export type SiteState = { id: string; up: boolean; code: number; ms: number };
export type Site = (typeof config.sites)[number];
export type Route = { name: string; title: string; path: string; kind: string };
// ---- agents hub (CT 111, Mission Control), served by ./api/hub ----
export type HubAgent = { id: number; name: string; role: string; status: string; last_seen: number | null; last_activity: string };
export type HubTask = { id: number; title: string; status: string; priority: string; assigned_to: string | null; updated_at: number | null; tags: string[] };
export type HubEvent = { id: number; type: string; actor: string; description: string; at: number | null };
export type HubData = { agents: HubAgent[]; tasks: HubTask[]; activity: HubEvent[]; at: string };
export type JobResult = { name: string; title?: string; url: string; admin_url: string; admin_user?: string; admin_password?: string; plugins?: string[]; ai_note?: string };
export type Item = { id: string; text: string; at: string; done?: boolean };
export type Notes = { note: string; prompts: Item[]; todos: Item[]; updated: string | null };

// ---- SSO auth & RBAC types ----
export type AuthRole = 'owner' | 'admin' | 'recruiter_guest' | 'player';

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
  avatar: string;
  privileges: string[];
  expiresAt: string | null;
  disabled: boolean;
  note?: string;
  isLegacy?: boolean;
  xp?: number;
  eddies?: number;
  scores?: Record<string, number>;
  plays?: Record<string, number>;
};

export type AuthMeResponse = {
  authenticated: boolean;
  needsBootstrap: boolean;
  allowLegacyPassword: boolean;
  user: AuthUser | null;
};

export type AdminUser = AuthUser & {
  createdBy?: string | null;
  createdAt?: string | null;
  lastLoginAt?: string | null;
  activeSessions?: number;
  xp?: number;
  eddies?: number;
  scores?: Record<string, number>;
  plays?: Record<string, number> | number;
  profile?: { plays?: Record<string, number>; scores?: Record<string, number> };
  totalPlays?: number;
  combinedScore?: number;
};

export type AuditEntry = {
  id: string;
  at: string;
  actorUsername?: string;
  actorRole?: string;
  actor?: { id?: string; username?: string; displayName?: string; role?: string };
  ip: string;
  action: string;
  target: string;
  status: string;
  details: unknown;
  sandboxTag: string | boolean | null;
};

// ---------- RBAC & Arcade metadata ----------
export const PRIVILEGE_KEYS = [
  'view_private',
  'view_logs',
  'view_agents',
  'manage_notes',
  'manage_containers',
  'create_vms',
  'manage_sites',
  'run_updates',
  'manage_settings',
  'manage_users',
  'play_games',
] as const;

export const PRIVILEGE_META: Record<string, { label: string; desc: string; group: 'view' | 'ops' | 'admin' | 'arcade' }> = {
  view_private: { label: 'Private Telemetry', desc: 'View temps, SMART disks, storage and container IDs', group: 'view' },
  view_logs: { label: 'View Logs', desc: 'Read host, container and app live logs', group: 'view' },
  view_agents: { label: 'Mission Control', desc: 'Inspect and dispatch CT 111 AI agents and tasks', group: 'ops' },
  manage_notes: { label: 'Manage Notes', desc: 'Edit shared homelab notes, prompts and to-dos', group: 'ops' },
  manage_containers: { label: 'Manage Containers', desc: 'Start, stop, restart and delete sandbox guests (CT 102 protected)', group: 'ops' },
  create_vms: { label: 'Create VMs & LXC', desc: 'Provision new Proxmox containers and virtual machines', group: 'ops' },
  manage_sites: { label: 'Manage Sites & Routes', desc: 'Build AI/WordPress sites, deploy apps and Caddy routes', group: 'ops' },
  run_updates: { label: 'Run Updates', desc: 'Execute apt/system updates across containers', group: 'admin' },
  manage_settings: { label: 'Security Settings', desc: 'Modify dashboard configuration and security options', group: 'admin' },
  manage_users: { label: 'Users & Audit', desc: 'Manage accounts, recruiter guests, privileges and audit logs', group: 'admin' },
  play_games: { label: 'Cyber Arcade 2077', desc: 'Sync Street Cred, Eddies and high scores across all 7 cabinets', group: 'arcade' },
};

export const ROLE_META: Record<AuthRole, { label: string; cls: string; desc: string }> = {
  owner: { label: 'OWNER', cls: 'owner', desc: 'Unrestricted master account' },
  admin: { label: 'ADMIN', cls: 'admin', desc: 'Delegated administrator' },
  recruiter_guest: { label: 'RECRUITER GUEST', cls: 'guest', desc: 'Time-limited sandbox evaluation' },
  player: { label: 'PLAYER', cls: 'player', desc: 'Cyber Arcade & public status' },
};

export const ARCADE_GAMES = [
  { id: 'defender', title: 'Homelab Defender', accent: '#fcee09' },
  { id: 'icebreaker', title: 'ICEBREAKER // Survivor', accent: '#00f0ff' },
  { id: 'blackwall', title: 'Blackwall Defense', accent: '#ff003c' },
  { id: 'neonvector', title: 'Neon Vector 2077', accent: '#d946ef' },
  { id: 'protocol', title: 'Breach Protocol', accent: '#00ff9f' },
  { id: 'overclock', title: 'OVERCLOCK // ICE Shatter', accent: '#ffaa00' },
  { id: 'lightcycle', title: 'LIGHTCYCLE // Trace', accent: '#00e5ff' },
] as const;

export const AVATAR_GLYPH: Record<string, string> = {
  netrunner: '◈',
  solo: '⚔',
  techie: '⚙',
  corpo: '❖',
};

export const hasPriv = (user: AuthUser | null, priv: string): boolean =>
  user?.role === 'owner' || !!user?.privileges?.includes(priv);

export const streetCredLevel = (xp = 0): { level: number; pct: number; current: number; next: number } => {
  const x = Math.max(0, Math.floor(Number(xp) || 0));
  let lvl = 1;
  while (50 * (lvl + 1) * lvl <= x) lvl += 1;
  const base = 50 * lvl * (lvl - 1);
  const nextAt = 50 * (lvl + 1) * lvl;
  const current = x - base;
  const next = nextAt - base;
  return { level: lvl, current, next, pct: next > 0 ? Math.min(100, Math.round((current / next) * 100)) : 0 };
};

// ---------- helpers ----------
export const pageForHash = (): Page => {
  const route = window.location.hash.replace(/^#\/?/, '');
  if (route === 'services') return 'services';
  if (route === 'topology') return 'topology';
  if (route === 'sites') return 'sites';
  if (route === 'provision') return 'provision';
  if (route === 'notes') return 'notes';
  if (route === 'logs' || route.startsWith('logs/')) return 'logs';
  if (route === 'updates') return 'updates';
  if (route === 'agents') return 'agents';
  if (route === 'users' || route.startsWith('users/')) return 'users';
  if (route === 'login') return 'login';
  return 'overview';
};
export const bytes = (n: number) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
};
export const ratio = (used: number, total: number) => (total > 0 ? Math.min(1, used / total) : 0);
export const pct = (r: number) => `${Math.round(r * 100)}%`;
export const duration = (s: number) => {
  if (!s) return '-';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const level = (r: number) => (r >= 0.9 ? 'crit' : r >= 0.75 ? 'warn' : 'ok');
export const matches = (query: string, ...fields: (string | number)[]) => !query || fields.join(' ').toLowerCase().includes(query);

export const formatCountdown = (expiresAt: string | null, nowMs = Date.now()): { text: string; expired: boolean; urgent: boolean } => {
  if (!expiresAt) return { text: 'No expiry', expired: false, urgent: false };
  const diff = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return { text: 'EXPIRED', expired: true, urgent: true };
  const sec = Math.floor(diff / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return { text: `${d}d ${h}h left`, expired: false, urgent: false };
  if (h > 0) return { text: `${h}h ${String(m).padStart(2, '0')}m left`, expired: false, urgent: h < 2 };
  return { text: `${m}m ${String(s).padStart(2, '0')}s left`, expired: false, urgent: true };
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const formatAgo = (iso: string | null | undefined): string => {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Never';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback below */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
};

const PASS_KEY = 'homelab-pass';
export const readPass = () => { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch { return ''; } };
export const savePass = (value: string) => { try { if (value) sessionStorage.setItem(PASS_KEY, value); else sessionStorage.removeItem(PASS_KEY); } catch { /* private mode */ } };

export const authHeaders = (pass?: string, extra?: Record<string, string>): Record<string, string> => ({
  ...(extra ?? {}),
  ...(pass && pass !== '__sso__' ? { 'x-dashboard-password': pass } : {}),
});

export async function apiJson<T>(url: string, init: RequestInit = {}, pass?: string): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...authHeaders(pass),
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(url, { credentials: 'same-origin', ...init, headers });
  const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.message || body.error || `Request failed (${response.status}).`);
  }
  return body as T;
}

export const Login = ({
  onLogin,
  needsBootstrap: needsBootstrapProp,
  allowLegacyPassword: allowLegacyProp,
  onAuthMeta,
}: {
  onLogin: (passOrToken: string, user?: AuthUser) => void;
  needsBootstrap?: boolean;
  allowLegacyPassword?: boolean;
  onAuthMeta?: (meta: AuthMeResponse) => void;
}) => {
  const [meta, setMeta] = useState<{ needsBootstrap: boolean; allowLegacyPassword: boolean; ready: boolean }>({
    needsBootstrap: needsBootstrapProp ?? false,
    allowLegacyPassword: allowLegacyProp ?? true,
    ready: needsBootstrapProp !== undefined && allowLegacyProp !== undefined,
  });
  // SSO login fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Bootstrap fields
  const [bootUsername, setBootUsername] = useState('owner');
  const [bootDisplayName, setBootDisplayName] = useState('Owner');
  const [bootPassword, setBootPassword] = useState('');
  const [mainPassword, setMainPassword] = useState('');
  // Legacy fallback field
  const [legacyValue, setLegacyValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (needsBootstrapProp !== undefined && allowLegacyProp !== undefined) {
      setMeta({ needsBootstrap: needsBootstrapProp, allowLegacyPassword: allowLegacyProp, ready: true });
      return undefined;
    }
    let alive = true;
    fetch('./api/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: AuthMeResponse | null) => {
        if (!alive) return;
        if (body) {
          onAuthMeta?.(body);
          setMeta({
            needsBootstrap: Boolean(body.needsBootstrap),
            allowLegacyPassword: body.allowLegacyPassword !== false,
            ready: true,
          });
        } else {
          setMeta((prev) => ({ ...prev, ready: true }));
        }
      })
      .catch(() => {
        if (alive) setMeta((prev) => ({ ...prev, ready: true }));
      });
    return () => { alive = false; };
  }, [needsBootstrapProp, allowLegacyProp]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitSso = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiJson<{ ok: boolean; token?: string; user: AuthUser }>('./api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      savePass('');
      onLogin('__sso__', data.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitBootstrap = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiJson<{ ok: boolean; user: AuthUser }>('./api/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          username: bootUsername.trim(),
          displayName: bootDisplayName.trim() || bootUsername.trim(),
          password: bootPassword,
          mainPassword,
        }),
      });
      savePass('');
      onLogin('__sso__', data.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Owner setup failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitLegacy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch('./api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-dashboard-password': legacyValue },
      });
      const body: { message?: string } = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || 'Wrong password.');
      savePass(legacyValue);
      onLogin(legacyValue);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!meta.ready) {
    return (
      <div className="panel form login">
        <p className="muted"><span className="spinner" /> Checking access status…</p>
      </div>
    );
  }

  if (meta.needsBootstrap) {
    return (
      <form className="panel form login" onSubmit={submitBootstrap}>
        <p className="eyebrow"><Icon name="shield" className="icon-xs" />First-run Setup</p>
        <h2><Icon name="shield" />Create Owner Admin Account</h2>
        <p className="muted">Initialize your primary Owner account for Homelab Dashboard and Cyber Arcade SSO.</p>
        <div className="pair">
          <label>
            Username
            <input
              type="text"
              required
              minLength={2}
              maxLength={24}
              pattern="[a-zA-Z0-9_.\- ]+"
              autoComplete="username"
              value={bootUsername}
              onChange={(e) => setBootUsername(e.target.value)}
              placeholder="owner"
            />
          </label>
          <label>
            Display name
            <input
              type="text"
              required
              minLength={2}
              maxLength={40}
              value={bootDisplayName}
              onChange={(e) => setBootDisplayName(e.target.value)}
              placeholder="Owner"
            />
          </label>
        </div>
        <label>
          New Owner password
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={bootPassword}
            onChange={(e) => setBootPassword(e.target.value)}
            placeholder="6+ characters (8+ recommended)"
          />
        </label>
        <label>
          Existing main dashboard password
          <input
            type="password"
            autoComplete="current-password"
            value={mainPassword}
            onChange={(e) => setMainPassword(e.target.value)}
            placeholder="Required to verify initial setup (if configured)"
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          <Icon name="shield" />{busy ? 'Creating Owner…' : 'Create Owner & Sign In'}
        </button>
        {error && <p className="message error">{error}</p>}
      </form>
    );
  }

  return (
    <div className="panel login login-card">
      <form className="form" onSubmit={submitSso}>
        <h2><Icon name="lock" />Sign in</h2>
        <p className="muted">Single Sign-On across Homelab Dashboard and Night Lab Arcade 2077.</p>
        <label>
          Username
          <input
            type="text"
            required
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. owner or recruiter-acme"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password or Arcade PIN"
          />
        </label>
        <div className="login-actions">
          <button className="primary" type="submit" disabled={busy}>
            <Icon name="key" />{busy ? 'Signing in…' : 'Sign in'}
          </button>
          <a className="link" href="#/login">Full sign-in page →</a>
        </div>
        {error && <p className="message error">{error}</p>}
      </form>
      {meta.allowLegacyPassword && (
        <details className="legacy-box">
          <summary><Icon name="key" className="icon-xs" />Unlock with legacy main password</summary>
          <form className="form legacy-form" onSubmit={submitLegacy}>
            <label>
              Main password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={legacyValue}
                onChange={(e) => setLegacyValue(e.target.value)}
                placeholder="Legacy DASHBOARD_PASSWORD"
              />
            </label>
            <button className="ghost" type="submit" disabled={busy}>Unlock</button>
          </form>
        </details>
      )}
    </div>
  );
};

export function usePoll<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ code: number; message: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
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
export const Icon = ({ name, className = 'icon' }: { name: string; className?: string }) => {
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
    refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    map: <><circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M7 7.5 10.5 16M17 7.5 13.5 16M7.5 6h9" /></>,
    lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
    github: <path d="M9 19c-4 1.5-4-2-6-2.5m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.3 5.8 2.6 5.8 2.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />,
    check: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="m8 12 3 3 5-6" /></>,
    bot: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /><path d="M2 13v3M22 13v3" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    gamepad: <><line x1="6" y1="11" x2="10" y2="11" /><line x1="8" y1="9" x2="8" y2="13" /><line x1="15" y1="12" x2="15.01" y2="12" /><line x1="18" y1="10" x2="18.01" y2="10" /><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5Z" /></>,
    activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};
export const Bar = ({ value }: { value: number }) => <div className="bar"><span className={level(value)} style={{ width: pct(value) }} /></div>;
export const Dot = ({ state }: { state: 'up' | 'down' | 'idle' }) => <span className={`dot ${state}`} aria-label={state} />;

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const PROMPT_KEY = 'homelab-use-prompt';
