import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../lib';
import type { HubAgent, HubData, HubEvent, HubTask } from '../lib';
import { Help } from '../ui/Help';

// The agents hub (Mission Control on CT 111), read through this dashboard's ./api/hub proxy.
// The hub's API key stays on the server; the browser only ever sees these trimmed fields.
// No chart library here, same as the rest of the dashboard: counts and lists only.

// site/proxy/host agents heartbeat from cron inside their container, so silence means something
// is wrong. manager, claude-ops, ralph-overnight and gemini-bulk run in bursts and are idle for
// 12h+ between runs, so they are never marked down. Same split as hub-alerts.py on the host.
const ALWAYS_ON = new Set(['site-agent', 'proxy-agent', 'host-agent']);
const STALE_MIN = 45;

const ago = (unix: number | null) => {
  if (!unix) return 'never';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

const health = (a: HubAgent): 'up' | 'down' | 'idle' => {
  if (!ALWAYS_ON.has(a.name)) return 'idle';
  if (!a.last_seen) return 'down';
  return (Date.now() / 1000 - a.last_seen) / 60 > STALE_MIN ? 'down' : 'up';
};

const OPEN = new Set(['inbox', 'backlog', 'assigned', 'in_progress', 'review', 'quality_review', 'awaiting_owner']);
const statusPill = (status: string) => (status === 'done' ? 'up' : status === 'failed' ? 'down' : status === 'in_progress' ? 'new' : '');
const nice = (s: string) => s.replace(/_/g, ' ');

async function api<T>(pass: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { message?: string }).message || `Request failed (${r.status}).`);
  return b as T;
}

export default function Agents({ query, pass }: { query: string; pass: string }) {
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigned, setAssigned] = useState('');
  const [priority, setPriority] = useState('medium');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');

  const load = useCallback(async () => {
    try { setData(await api<HubData>(pass, './api/hub')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reach the hub.'); }
  }, [pass]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Memoised off `data` itself: `data?.agents ?? []` would hand back a fresh array every render,
  // which defeats the useMemo filters below.
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const activity = useMemo(() => data?.activity ?? [], [data]);

  const q = query.trim().toLowerCase();
  const shownTasks = useMemo(
    () => (q ? tasks.filter((t) => `${t.title} ${t.assigned_to ?? ''} ${t.status} ${t.tags.join(' ')}`.toLowerCase().includes(q)) : tasks),
    [tasks, q],
  );
  const shownAgents = useMemo(
    () => (q ? agents.filter((a) => `${a.name} ${a.role} ${a.status}`.toLowerCase().includes(q)) : agents),
    [agents, q],
  );

  const open = tasks.filter((t) => OPEN.has(t.status)).length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const downCount = agents.filter((a) => health(a) === 'down').length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true); setSent(''); setError('');
    try {
      const body = { title, description, assigned_to: assigned, priority };
      const made = await api<{ task: HubTask }>(pass, './api/hub/tasks', { method: 'POST', body: JSON.stringify(body) });
      setSent(`Task #${made.task.id} added${assigned ? ` for ${assigned}` : ' to the inbox'}.`);
      setTitle(''); setDescription('');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not add the task.'); }
    finally { setSending(false); }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1><Icon name="bot" />Agents</h1>
          <p className="lede">
            Every agent in the lab, what it is working on, and a way to hand it a job from your phone.
            {data && <span className="muted"> · updated {new Date(data.at).toLocaleTimeString()}</span>}
          </p>
        </div>
        <Help title="Agents hub">
          <p>
            This page talks to Mission Control on CT 111 through the dashboard server, so the hub's API key never
            reaches your browser. The hub's own interface is on the tailnet at <code>http://agents-hub:3005</code>.
          </p>
          <p>
            <b>site-agent</b>, <b>proxy-agent</b> and <b>host-agent</b> heartbeat every minute from inside their
            container, so a gap means something is down. <b>manager</b>, <b>claude-ops</b>, <b>ralph-overnight</b> and
            <b> gemini-bulk</b> only run in bursts, so they show as idle between runs — that is normal.
          </p>
        </Help>
      </header>

      {error && <p className="message error">{error}</p>}

      <div className="stats">
        <div className="stat"><b>{agents.length}</b><span className="muted">agents</span></div>
        <div className="stat"><b>{open}</b><span className="muted">tasks open</span></div>
        <div className="stat"><b>{done}</b><span className="muted">done</span></div>
        <div className="stat"><b>{failed}</b><span className="muted">failed</span></div>
        <div className="stat"><b>{downCount}</b><span className="muted">not reporting</span></div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="server" />Agents</h2></div>
          {!data && !error && <p className="muted loading">Loading…</p>}
          <ul className="site-list">
            {shownAgents.map((a) => {
              const state = health(a);
              return (
                <li key={a.id}>
                  <span className={`dot ${state}`} aria-label={state} />
                  <span>
                    <b>{a.name}</b>
                    <span className="muted"> · {a.role}</span>
                    {a.last_activity && <><br /><span className="muted">{a.last_activity}</span></>}
                  </span>
                  <span className="pills">
                    <span className={`pill ${state === 'down' ? 'down' : state === 'up' ? 'up' : ''}`}>{nice(a.status)}</span>
                    <span className="pill mono">{ago(a.last_seen)}</span>
                  </span>
                </li>
              );
            })}
            {data && !shownAgents.length && <li><span className="muted">No agents match that search.</span></li>}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head"><h2><Icon name="send" />Hand out a task</h2></div>
          <form className="form" onSubmit={submit}>
            <label>What should it do?
              <input required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Summarise last night's loop" />
            </label>
            <label>Details (optional)
              <textarea rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Anything the agent needs to know." />
            </label>
            <label>Give it to
              <select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
                <option value="">Inbox (nobody yet)</option>
                {agents.map((a) => <option key={a.id} value={a.name}>{a.name} · {a.role}</option>)}
              </select>
            </label>
            <label>Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">low</option><option value="medium">medium</option>
                <option value="high">high</option><option value="critical">critical</option>
              </select>
            </label>
            <button className="primary" type="submit" disabled={sending}>{sending ? 'Adding…' : 'Add task'}</button>
            {sent && <p className="message ok-text">{sent}</p>}
          </form>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2><Icon name="list" />Tasks</h2>
          <span className="muted">{shownTasks.length} shown</span>
        </div>
        <ul className="site-list">
          {shownTasks.map((t) => (
            <li key={t.id}>
              <span className="badge">{t.id}</span>
              <span>
                <b>{t.title}</b>
                <br />
                <span className="muted">{t.assigned_to ?? 'unassigned'} · {t.priority} · {ago(t.updated_at)}</span>
              </span>
              <span className="pills">
                <span className={`pill ${statusPill(t.status)}`}>{nice(t.status)}</span>
                {t.tags.slice(0, 2).map((tag) => <span key={tag} className="chip">{tag}</span>)}
              </span>
            </li>
          ))}
          {data && !shownTasks.length && <li><span className="muted">No tasks match that search.</span></li>}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head"><h2><Icon name="pulse" />Recent activity</h2></div>
        <ul className="site-list">
          {activity.map((e: HubEvent) => (
            <li key={e.id}>
              <span>
                <b>{e.actor || 'hub'}</b>
                <span className="muted"> · {nice(e.type)}</span>
                <br />
                <span className="muted">{e.description}</span>
              </span>
              <span className="pill mono">{ago(e.at)}</span>
            </li>
          ))}
          {data && !activity.length && <li><span className="muted">Nothing yet.</span></li>}
        </ul>
      </section>
    </>
  );
}
