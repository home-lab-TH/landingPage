import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import config from './config/services.json';

// ---------- types ----------
export type Page = 'overview' | 'services' | 'topology' | 'sites' | 'notes' | 'logs' | 'updates' | 'provision';
export type ProvisionType = 'vm' | 'lxc';
export type Guest = { id: number; name: string; type: 'lxc' | 'vm'; status: string; cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; tags?: string[] };
export type Host = { cpu: number; cpus: number; model: string; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number; load: string[]; version: string };
export type Storage = { name: string; type: string; used: number; total: number };
export type Stats = { configured: boolean; node: string; host: Host; guests: Guest[]; storage: Storage[]; at: string };
export type SiteState = { id: string; up: boolean; code: number; ms: number };
export type Site = (typeof config.sites)[number];
export type Route = { name: string; title: string; path: string; kind: string };
export type JobResult = { name: string; title?: string; url: string; admin_url: string; admin_user?: string; admin_password?: string; plugins?: string[]; ai_note?: string };
export type Item = { id: string; text: string; at: string; done?: boolean };
export type Notes = { note: string; prompts: Item[]; todos: Item[]; updated: string | null };
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

const PASS_KEY = 'homelab-pass';
export const readPass = () => { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch { return ''; } };
export const savePass = (value: string) => { try { if (value) sessionStorage.setItem(PASS_KEY, value); else sessionStorage.removeItem(PASS_KEY); } catch { /* private mode */ } };

export const Login = ({ onLogin }: { onLogin: (pass: string) => void }) => {
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
      <h2><Icon name="lock" />Unlock controls</h2>
      <p className="muted">Start, stop, create and delete need the main password. It stays in this tab until you lock or close it.</p>
      <label>Password<input type="password" required autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
      <button className="primary" type="submit">Unlock</button>
      {error && <p className="message error">{error}</p>}
    </form>
  );
};

export function usePoll<T>(url: string, ms: number) {
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
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};
export const Bar = ({ value }: { value: number }) => <div className="bar"><span className={level(value)} style={{ width: pct(value) }} /></div>;
export const Dot = ({ state }: { state: 'up' | 'down' | 'idle' }) => <span className={`dot ${state}`} aria-label={state} />;

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const PROMPT_KEY = 'homelab-use-prompt';
