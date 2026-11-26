import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Icon, authHeaders } from '../lib';
import type { HubAgent, HubData, HubEvent, HubTask, HubTaskDetail } from '../lib';
import { Help } from '../ui/Help';

// The agents hub (Mission Control on CT 111), read through this dashboard's ./api/hub proxy.
// The hub's API key stays on the server; the browser only ever sees these trimmed fields.
// Two views: "Workspace" (sessions sidebar + conversation thread + prompt composer, Claude Code style)
// and "Board & Activity" (every agent, every task and the activity feed on one page).

// site/proxy/host agents heartbeat from cron inside their container, so silence means something
// is wrong. manager, claude-ops, ralph-overnight and gemini-bulk run in bursts and are idle for
// 12h+ between runs, so they are never marked down. Same split as hub-alerts.py on the host.
const ALWAYS_ON = new Set(['site-agent', 'proxy-agent', 'host-agent']);
const STALE_MIN = 45;
const AGENT_ORDER = ['claude-ops', 'antigravity', 'manager', 'ralph-overnight', 'gemini-bulk', 'site-agent', 'proxy-agent', 'host-agent'];

const ago = (unix: number | null | undefined) => {
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

// Which model a task ran on, read back from the tags phone-worker.py looks at.
const modelOf = (t: HubTask) => {
  const tags = t.tags.map((x) => x.toLowerCase());
  for (const m of ['opus', 'haiku', 'sonnet']) if (tags.includes(m)) return m;
  if (tags.includes('antigravity') || t.assigned_to === 'antigravity') return 'gemini';
  if (t.assigned_to === 'claude-ops') return 'sonnet';
  return '';
};

type Choice = 'sonnet' | 'opus' | 'haiku' | 'gemini' | 'other';
const CHOICES: { key: Choice; label: string; agent?: string }[] = [
  { key: 'sonnet', label: 'Claude Sonnet', agent: 'claude-ops' },
  { key: 'opus', label: 'Claude Opus', agent: 'claude-ops' },
  { key: 'haiku', label: 'Claude Haiku', agent: 'claude-ops' },
  { key: 'gemini', label: 'Antigravity (Gemini)', agent: 'antigravity' },
  { key: 'other', label: 'Other agent…' },
];
const STARTERS = [
  'Check all CTs & disk',
  'Refresh Graphify code map',
  'Check Minecraft CT 200 status',
  "Summarize today's changes",
];
type Filter = 'all' | 'running' | 'done' | 'failed';
const FILTERS: [Filter, string][] = [['all', 'All'], ['running', 'Running'], ['done', 'Done'], ['failed', 'Failed']];
const matchFilter = (t: HubTask, f: Filter) => (f === 'all' ? true : f === 'running' ? OPEN.has(t.status) : t.status === f);

type View = 'workspace' | 'board';
const VIEW_KEY = 'homelab-agents-view';

async function api<T>(pass: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin', ...init, headers: authHeaders(pass, { 'Content-Type': 'application/json' }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { message?: string }).message || `Request failed (${r.status}).`);
  return b as T;
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el); el.select();
    const ok = document.execCommand('copy'); el.remove(); return ok;
  }
}

// ---------- prompt composer ----------
function Composer({ pass, agents, onCreated, starters, focusKey }: {
  pass: string; agents: HubAgent[]; onCreated: (t: HubTask) => void; starters: boolean; focusKey: number;
}) {
  const [text, setText] = useState('');
  const [ownTitle, setOwnTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState<Choice>('sonnet');
  const [other, setOther] = useState('');
  const [priority, setPriority] = useState('medium');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (focusKey) box.current?.focus(); }, [focusKey]);

  const derived = (ownTitle ? title : text.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 120);
  const canSend = derived.trim().length >= 3 && !sending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) { setMsg({ ok: false, text: 'Write at least a few words first.' }); return; }
    const picked = CHOICES.find((c) => c.key === choice);
    const assigned = choice === 'other' ? other : picked?.agent ?? '';
    const body = { title: derived.trim(), description: text.trim(), assigned_to: assigned, priority, ...(choice !== 'other' ? { model: choice } : {}) };
    setSending(true); setMsg(null);
    try {
      const made = await api<{ task: HubTask }>(pass, './api/hub/tasks', { method: 'POST', body: JSON.stringify(body) });
      setMsg({ ok: true, text: `Task #${made.task.id} added${assigned ? ` for ${assigned}` : ' to the inbox'}.` });
      setText(''); setTitle('');
      onCreated(made.task);
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not add the task.' }); }
    finally { setSending(false); }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  };

  return (
    <form className="aw-composer" onSubmit={submit}>
      {starters && !text && (
        <div className="aw-starters">
          {STARTERS.map((s) => <button type="button" key={s} onClick={() => { setText(s); box.current?.focus(); }}>{s}</button>)}
        </div>
      )}
      <div className="aw-box">
        {ownTitle && (
          <input className="aw-title-in" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Task title" />
        )}
        <textarea
          ref={box} rows={3} maxLength={4000} value={text} onKeyDown={onKey}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask Claude or Antigravity to write code, inspect containers, refresh Graphify, or deploy..."
          aria-label="Prompt"
        />
        <div className="aw-bar">
          <div className="aw-models" role="radiogroup" aria-label="Model or agent">
            {CHOICES.map((c) => (
              <button type="button" role="radio" aria-checked={choice === c.key} key={c.key}
                className={choice === c.key ? 'on' : ''} onClick={() => setChoice(c.key)}>{c.label}</button>
            ))}
            {choice === 'other' && (
              <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Agent">
                <option value="">Inbox (auto)</option>
                {agents.map((a) => <option key={a.id} value={a.name}>{a.name} · {a.role}</option>)}
              </select>
            )}
          </div>
          <div className="aw-bar-end">
            <select className="aw-prio" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
              <option value="low">low</option><option value="medium">medium</option>
              <option value="high">high</option><option value="critical">critical</option>
            </select>
            <button type="button" className={`aw-mini ${ownTitle ? 'on' : ''}`} onClick={() => setOwnTitle((v) => !v)} title="Write a separate title">Title</button>
            <button type="submit" className="aw-run" disabled={!canSend}>{sending ? 'Sending…' : 'Run ↵'}</button>
          </div>
        </div>
      </div>
      <div className="aw-foot">
        {msg ? <span className={msg.ok ? 'ok-text' : 'bad'}>{msg.text}</span>
          : <span className="muted">{derived ? <>Title: <b>{derived}</b></> : 'First line becomes the title.'}</span>}
        <span className="muted aw-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run</span>
      </div>
    </form>
  );
}

// ---------- one task as a conversation ----------
function Thread({ pass, taskId, fallback, onBack }: { pass: string; taskId: number; fallback?: HubTask; onBack: () => void }) {
  const [detail, setDetail] = useState<HubTaskDetail | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    setDetail(null); setError('');
    const tick = async () => {
      try {
        const d = await api<HubTaskDetail>(pass, `./api/hub/tasks/${encodeURIComponent(taskId)}`);
        if (!alive) return;
        setDetail(d); setError('');
        if (OPEN.has(d.task.status)) timer = window.setTimeout(tick, 4000);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Could not load the task.');
        timer = window.setTimeout(tick, 8000);
      }
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [pass, taskId]);

  const t = detail?.task ?? fallback;
  const comments = detail?.comments ?? [];
  const running = t ? OPEN.has(t.status) : false;
  const model = t ? modelOf(t) : '';
  const output = comments.map((c) => c.body).join('\n\n');

  const copy = async () => { if (await copyText(output)) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } };

  if (!t) return <div className="aw-thread"><p className="muted loading">{error || 'Loading…'}</p></div>;
  return (
    <div className="aw-thread">
      <header className="aw-thead">
        <button type="button" className="aw-back" onClick={onBack} aria-label="Back to sessions"><Icon name="back" /></button>
        <span className="aw-id mono">#{t.id}</span>
        <h2>{t.title}</h2>
        <span className="pills">
          <span className={`pill ${statusPill(t.status)}`}>{nice(t.status)}</span>
          <span className="pill">{t.assigned_to ?? 'unassigned'}</span>
          {model && <span className="pill new">{model}</span>}
          <span className="pill">{t.priority}</span>
          <span className="pill mono">{ago(t.updated_at ?? t.created_at)}</span>
        </span>
      </header>
      {error && <p className="message error">{error}</p>}
      <div className="aw-msgs">
        <div className="aw-msg you">
          <div className="aw-who">You{t.created_at ? <span className="muted"> · {ago(t.created_at)}</span> : null}</div>
          <div className="aw-bubble">
            <b>{t.title}</b>
            {t.description && t.description.trim() !== t.title.trim() && <p>{t.description}</p>}
          </div>
        </div>
        <div className="aw-msg agent">
          <div className="aw-who"><Icon name="terminal" className="icon-xs" />{t.assigned_to ?? 'inbox'}{model && <span className="muted"> · {model}</span>}</div>
          {comments.length > 0 && (
            <div className="aw-term">
              <div className="aw-term-head">
                <span className="muted mono">output · {comments.length} {comments.length === 1 ? 'message' : 'messages'}</span>
                <button type="button" className="ghost" onClick={() => void copy()}><Icon name="copy" className="icon-xs" />{copied ? 'Copied' : 'Copy output'}</button>
              </div>
              {comments.map((c) => (
                <div key={c.id} className="aw-out">
                  <div className="aw-out-meta muted mono">{c.author} · {ago(c.at)}</div>
                  <pre>{c.body || '(empty)'}</pre>
                </div>
              ))}
            </div>
          )}
          {running && (
            <div className="aw-running"><i /><span>Running on CT 111 (agents-hub)…</span><span className="muted"> {nice(t.status)} · checks every 4 s</span></div>
          )}
          {!running && !comments.length && detail && <p className="muted aw-none">No output was posted for this task.</p>}
        </div>
      </div>
    </div>
  );
}

// ---------- page ----------
export default function Agents({ query, pass }: { query: string; pass: string }) {
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'workspace'));
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [stripOpen, setStripOpen] = useState(true);

  const load = useCallback(async () => {
    try { setData(await api<HubData>(pass, './api/hub')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reach the hub.'); }
  }, [pass]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

  // Memoised off `data` itself: `data?.agents ?? []` would hand back a fresh array every render,
  // which defeats the useMemo filters below.
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const activity = useMemo(() => data?.activity ?? [], [data]);
  const strip = useMemo(() => [...agents].sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a.name); const ib = AGENT_ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  }), [agents]);

  const q = query.trim().toLowerCase();
  const searched = useMemo(
    () => (q ? tasks.filter((t) => `${t.id} ${t.title} ${t.description ?? ''} ${t.assigned_to ?? ''} ${t.status} ${t.tags.join(' ')}`.toLowerCase().includes(q)) : tasks),
    [tasks, q],
  );
  const sideTasks = useMemo(() => searched.filter((t) => matchFilter(t, filter)), [searched, filter]);
  const shownAgents = useMemo(
    () => (q ? agents.filter((a) => `${a.name} ${a.role} ${a.status}`.toLowerCase().includes(q)) : agents),
    [agents, q],
  );

  const open = tasks.filter((t) => OPEN.has(t.status)).length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const downCount = agents.filter((a) => health(a) === 'down').length;
  const online = agents.length - downCount;

  const newSession = () => { setView('workspace'); setSelected(null); setFocusKey((k) => k + 1); };
  const openTask = (id: number) => { setView('workspace'); setSelected(id); };
  const created = (t: HubTask) => { setSelected(t.id); void load(); };
  const selectedTask = tasks.find((t) => t.id === selected);

  const help = (
    <Help title="Agents workspace">
      <p>
        This page talks to Mission Control on CT 111 through the dashboard server, so the hub's API key never
        reaches your browser. The hub's own interface is on the tailnet at <code>http://agents-hub:3005</code>.
      </p>
      <p>
        Type a prompt, pick a model and press <b>Run</b> (or Ctrl/Cmd+Enter). The first line becomes the title.
        phone-worker on CT 111 picks it up and posts the output back here; open tasks refresh every 4 seconds.
      </p>
      <p>
        <b>site-agent</b>, <b>proxy-agent</b> and <b>host-agent</b> heartbeat every minute from inside their
        container, so a gap means something is down. <b>manager</b>, <b>claude-ops</b>, <b>ralph-overnight</b> and
        <b> gemini-bulk</b> only run in bursts, so they show as idle between runs — that is normal.
      </p>
    </Help>
  );

  return (
    <div className="aw-page">
      <header className="aw-top">
        <div className="aw-top-title">
          <h1><Icon name="bot" />Agents Workspace</h1>
          <span className="live"><i />{online} agents online · {open} open · {done} done</span>
        </div>
        <div className="aw-top-tools">
          <div className="aw-switch" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'workspace'} className={view === 'workspace' ? 'on' : ''} onClick={() => setView('workspace')}>Workspace</button>
            <button type="button" role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board &amp; Activity</button>
          </div>
          <details className="aw-menu">
            <summary>Links<Icon name="chevron" className="icon-xs" /></summary>
            <div className="aw-menu-pop" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
              <a href="https://claude.ai/code" target="_blank" rel="noreferrer"><Icon name="external" className="icon-xs" />Claude Remote (claude.ai/code)</a>
              <a href="http://agents-hub:7681" target="_blank" rel="noreferrer"><Icon name="terminal" className="icon-xs" />Tailscale Terminal (:7681)</a>
              <a href="http://agents-hub:3005" target="_blank" rel="noreferrer"><Icon name="grid" className="icon-xs" />Mission Control (:3005)</a>
            </div>
          </details>
          {help}
        </div>
      </header>

      {error && <p className="message error">{error}</p>}

      {view === 'workspace' ? (
        <div className={`aw ${selected != null ? 'has-sel' : ''}`}>
          <aside className="aw-side">
            <button type="button" className="aw-new" onClick={newSession}><Icon name="plus" />New Session / Task</button>
            <div className="aw-filters">
              {FILTERS.map(([key, label]) => (
                <button type="button" key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>
                  {label}<span>{searched.filter((t) => matchFilter(t, key)).length}</span>
                </button>
              ))}
            </div>
            <ul className="aw-list">
              {!data && !error && <li className="muted aw-empty">Loading…</li>}
              {sideTasks.map((t) => (
                <li key={t.id}>
                  <button type="button" className={selected === t.id ? 'on' : ''} onClick={() => openTask(t.id)}>
                    <span className={`dot ${t.status === 'done' ? 'up' : t.status === 'failed' ? 'down' : ''} ${OPEN.has(t.status) ? 'aw-pulse' : ''}`} />
                    <span className="aw-li-main">
                      <span className="aw-li-title">{t.title}</span>
                      <span className="muted">#{t.id} · {t.assigned_to ?? 'inbox'}{modelOf(t) ? ` · ${modelOf(t)}` : ''} · {ago(t.updated_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {data && !sideTasks.length && <li className="muted aw-empty">{q ? 'No tasks match that search.' : 'Nothing here yet.'}</li>}
            </ul>
            <div className="aw-strip">
              <button type="button" className="aw-strip-head" onClick={() => setStripOpen((v) => !v)} aria-expanded={stripOpen}>
                <span>Agents</span>
                <span className="aw-strip-dots">{!stripOpen && strip.map((a) => <span key={a.id} className={`dot ${health(a)}`} title={a.name} />)}</span>
                <span className="muted">{downCount ? `${downCount} down` : 'all ok'}</span>
                <Icon name="chevron" className={`icon-xs aw-chev ${stripOpen ? 'up' : ''}`} />
              </button>
              {stripOpen && (
                <ul>
                  {strip.map((a) => {
                    const state = health(a);
                    return (
                      <li key={a.id} title={a.last_activity || a.role}>
                        <span className={`dot ${state}`} aria-label={state} />
                        <span className="aw-ag-name">{a.name}</span>
                        <span className="muted mono">{state === 'idle' ? nice(a.status) : ago(a.last_seen)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          <section className="aw-main">
            {selected != null ? (
              <Thread key={selected} pass={pass} taskId={selected} fallback={selectedTask} onBack={() => setSelected(null)} />
            ) : (
              <div className="aw-hello">
                <div className="aw-hello-mark"><Icon name="spark" /></div>
                <h2>What should the agents do?</h2>
                <p className="muted">Runs on CT 111 (agents-hub) through phone-worker. Pick a model below, or a starter.</p>
              </div>
            )}
            <Composer pass={pass} agents={agents} onCreated={created} starters={selected == null} focusKey={focusKey} />
          </section>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat"><b>{agents.length}</b><span className="muted">agents</span></div>
            <div className="stat"><b>{open}</b><span className="muted">tasks open</span></div>
            <div className="stat"><b>{done}</b><span className="muted">done</span></div>
            <div className="stat"><b>{failed}</b><span className="muted">failed</span></div>
            <div className="stat"><b>{downCount}</b><span className="muted">not reporting</span></div>
          </div>

          <div className="grid-2 aw-board">
            <section className="panel">
              <div className="panel-head"><h2><Icon name="server" />Agents</h2>{data && <span className="muted">updated {new Date(data.at).toLocaleTimeString()}</span>}</div>
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
              <Composer pass={pass} agents={agents} onCreated={(t) => { void load(); openTask(t.id); }} starters={false} focusKey={0} />
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="list" />Tasks</h2>
              <span className="muted">{searched.length} shown · click one to open its thread</span>
            </div>
            <ul className="site-list">
              {searched.map((t) => (
                <li key={t.id}>
                  <span className="badge">{t.id}</span>
                  <span>
                    <button type="button" className="aw-tlink" onClick={() => openTask(t.id)}>{t.title}</button>
                    <br />
                    <span className="muted">{t.assigned_to ?? 'unassigned'} · {t.priority} · {ago(t.updated_at)}</span>
                  </span>
                  <span className="pills">
                    <span className={`pill ${statusPill(t.status)}`}>{nice(t.status)}</span>
                    {t.tags.slice(0, 2).map((tag) => <span key={tag} className="chip">{tag}</span>)}
                  </span>
                </li>
              ))}
              {data && !searched.length && <li><span className="muted">No tasks match that search.</span></li>}
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
      )}
    </div>
  );
}
