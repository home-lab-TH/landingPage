import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Help } from '../ui/Help';
import { DeployApp, History, LogBox, useJob } from '../ui/Ops';
import type { AppInfo } from '../ui/Ops';
import { Dot, Icon, Login, matches, newId, PROMPT_KEY } from '../lib';
import type { JobResult, Route, SiteState } from '../lib';

const JOB_KEY = 'homelab-job2';
type Tracked = { source: 'site' | 'host'; id: string; kind: string; name: string };
const readJob = (): Tracked | null => { try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null'); } catch { return null; } };
const saveJob = (value: Tracked | null) => { try { if (value) sessionStorage.setItem(JOB_KEY, JSON.stringify(value)); else sessionStorage.removeItem(JOB_KEY); } catch { /* private mode */ } };
const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
const STOP = new Set(['a', 'an', 'the', 'site', 'website', 'web', 'page', 'for', 'my', 'our', 'with', 'about', 'of', 'and', 'small', 'simple', 'new', 'i', 'want', 'make', 'me', 'build', 'create', 'modern']);
const IDEAS = ['A bold, modern site for a small bakery: hero photo, menu with prices, opening hours and a contact page', 'A dark, elegant portfolio for a student web developer with projects, skills and an about page', 'A colorful page for our school robotics team: who we are, competitions, sponsors, join us'];
type Candidate = { ctid: number; name: string; status: string };
type Editing = { route: Route; kind: 'wp' | 'aisite'; ctid?: number };

export default function Sites({ query, routes, sites, pass, onLogin }: { query: string; routes: Route[]; sites: Record<string, SiteState>; pass: string; onLogin: (p: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [sitePass, setSitePass] = useState('');
  const [where, setWhere] = useState<string>('wp');
  const [quality, setQuality] = useState<'fast' | 'best'>(() => { try { return (localStorage.getItem('homelab-quality') as 'fast' | 'best') || 'fast'; } catch { return 'fast'; } });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [tracking, setTracking] = useState<Tracked | null>(readJob);
  const job = useJob(pass, tracking?.source ?? 'site', tracking?.id ?? null);
  const [rName, setRName] = useState('');
  const [rTarget, setRTarget] = useState('http://10.0.0.');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedPrompt, setSavedPrompt] = useState(false);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const loadApps = () => { if (pass) fetch('./api/apps', { headers: { 'x-dashboard-password': pass } }).then((r) => (r.ok ? r.json() : { apps: [] })).then((b: { apps?: AppInfo[] }) => setApps(b.apps ?? [])).catch(() => undefined); };
  const loadCandidates = () => { if (pass) fetch('./api/aisites/candidates', { headers: { 'x-dashboard-password': pass } }).then((r) => (r.ok ? r.json() : { containers: [] })).then((b: { containers?: Candidate[] }) => setCandidates(b.containers ?? [])).catch(() => undefined); };
  useEffect(() => { loadApps(); loadCandidates(); }, [pass]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('homelab-quality', quality); } catch { /* ignore */ } }, [quality]);
  useEffect(() => { if (job && job.state !== 'running') { loadApps(); loadCandidates(); } }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLTextAreaElement>(null);

  const call = async (label: string, url: string, init: RequestInit = {}) => {
    setBusy(label); setError('');
    try {
      const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Request failed.');
      return body;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return null; } finally { setBusy(''); }
  };

  useEffect(() => { try { const p = sessionStorage.getItem(PROMPT_KEY); if (p) { setPrompt(p); sessionStorage.removeItem(PROMPT_KEY); } } catch { /* ignore */ } }, []);
  useEffect(() => { fetch('./api/ai').then((r) => r.json()).then((b: { ai: boolean }) => setAi(b.ai)).catch(() => setAi(false)); }, []);
  useEffect(() => { if (!nameTouched && !editing) setName(slug(prompt.split(/[.,:\n]/)[0].split(/\s+/).filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2).join(' '))); }, [prompt, nameTouched, editing]);

  const follow = (t: Tracked) => { setTracking(t); saveJob(t); };
  useEffect(() => { if (job && job.state !== 'running') saveJob(null); }, [job?.state]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing?.kind === 'wp') {
      const b = await call('go', `./api/wordpress/${editing.route.name}/ai`, { method: 'POST', body: JSON.stringify({ prompt, quality }) });
      if (b) { follow({ source: 'site', id: b.id, kind: 'ai', name: editing.route.name }); setPrompt(''); }
      return;
    }
    if (editing?.kind === 'aisite') {
      const b = await call('go', `./api/aisites/${editing.ctid}/edit`, { method: 'POST', body: JSON.stringify({ prompt, quality }) });
      if (b) { follow({ source: 'host', id: b.job, kind: 'aiedit', name: editing.route.name }); setPrompt(''); }
      return;
    }
    if (where === 'wp') {
      const b = await call('go', './api/wordpress', { method: 'POST', body: JSON.stringify({ name, password: sitePass, prompt: ai ? prompt : '', quality }) });
      if (b) { follow({ source: 'site', id: b.id, kind: 'create', name }); setPrompt(''); setName(''); setNameTouched(false); setSitePass(''); }
      return;
    }
    const b = await call('go', './api/aisites', { method: 'POST', body: JSON.stringify({ name, prompt, quality, ctid: where === 'new' ? null : Number(where) }) });
    if (b) { follow({ source: 'host', id: b.job, kind: 'aisite', name }); setPrompt(''); setName(''); setNameTouched(false); setWhere('wp'); }
  };
  const undo = async () => {
    if (!job) return;
    if (tracking?.source === 'site') {
      const b = await call('undo', `./api/wordpress/${job.name}/undo`, { method: 'POST', body: JSON.stringify({ job: job.id }) });
      if (b) follow({ source: 'site', id: b.id, kind: 'undo', name: job.name });
    } else if (job.ctid) {
      const b = await call('undo', `./api/aisites/${job.ctid}/undo`, { method: 'POST' });
      if (b) follow({ source: 'host', id: b.job, kind: 'aiundo', name: job.name });
    }
  };
  const undoSite = async (r: Route, ctid: number) => {
    if (!window.confirm(`Go back one version on ${r.title}?`)) return;
    const b = await call(`undo:${r.name}`, `./api/aisites/${ctid}/undo`, { method: 'POST' });
    if (b) follow({ source: 'host', id: b.job, kind: 'aiundo', name: r.name });
  };
  const bookmark = async () => {
    const current = await call('mark', './api/notes', { method: 'GET' });
    if (!current) return;
    const next = { ...current, prompts: [{ id: newId(), text: prompt.trim(), at: new Date().toISOString() }, ...(current.prompts || [])] };
    if (await call('mark', './api/notes', { method: 'PUT', body: JSON.stringify(next) })) { setSavedPrompt(true); window.setTimeout(() => setSavedPrompt(false), 2500); }
  };
  const saveKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await call('key', './api/ai/key', { method: 'PUT', body: JSON.stringify({ key }) })) { setAi(true); setKey(''); }
  };
  const newRoute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await call('route', './api/routes', { method: 'POST', body: JSON.stringify({ name: rName, target: rTarget, title: rName }) })) { setRName(''); setRTarget('http://10.0.0.'); }
  };
  const remove = async (r: Route) => {
    const app = apps.find((a) => a.name === r.name);
    const msg = r.kind === 'wordpress' ? `Delete the WordPress site "${r.title}"? Its pages, uploads and database are destroyed.`
      : (r.kind === 'aisite' && app?.adopted) ? `Remove the website "${r.title}" from CT ${app.ctid}? The container itself stays.`
        : r.kind === 'app' || r.kind === 'aisite' ? `Delete "${r.title}"? Its container${app ? ` (CT ${app.ctid})` : ''} and everything in it is destroyed.`
          : `Remove the route ${r.path}? The app itself is not touched.`;
    if (window.confirm(msg)) { await call(`del:${r.name}`, `./api/routes/${r.name}`, { method: 'DELETE' }); loadApps(); loadCandidates(); }
  };
  const startEdit = (r: Route, kind: 'wp' | 'aisite', ctid?: number) => { setEditing({ route: r, kind, ctid }); window.scrollTo({ top: 0, behavior: 'smooth' }); window.setTimeout(() => box.current?.focus(), 300); };

  const running = job?.state === 'running';
  const shown = routes.filter((r) => matches(query, r.name, r.title, r.path, r.kind));
  const isWp = !editing && where === 'wp';
  const ready = editing ? prompt.trim().length > 3 : SITE_NAME.test(name) && (isWp ? sitePass.length >= 8 : prompt.trim().length > 3);
  const result = job?.result as (JobResult & { summary?: string; notes?: string; target?: string }) | null | undefined;
  const liveUrl = result?.url || (job ? `./${job.name}/` : '');
  return (
    <>
      <section className="builder">
        <p className="eyebrow"><Icon name="spark" className="icon-xs" /> Website builder</p>
        <h1>{editing ? <>What should change on {editing.route.title}?</> : <>What website do you want?</>}
          <Help big title="This page: Sites">Build a website with AI in three steps: describe it, give it a name, press Create. Choose where it lives: <b>WordPress</b> (easy to edit by hand in wp-admin, needs a password) or <b>its own container</b> (Gemini writes the whole design in HTML and CSS; you can also pick one of your own containers, like test1). <b>Best</b> uses Gemini Pro for nicer results but is slower. Edit with AI changes a site later, and every AI change can be undone. Builds keep going if you leave the page; History shows what happened.</Help>
        </h1>
        <form className="ai-box" onSubmit={submit}>
          <textarea ref={box} rows={3} value={prompt} disabled={running} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && ready && pass) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
            placeholder={editing ? 'e.g. Make it dark and elegant, add photos, and add an events page' : ai === false ? 'Add your Gemini key below to let AI write the pages.' : 'Describe it: who it is for, which pages, the look and feel, colors…'} />
          <div className="ai-row">
            {editing ? (
              <span className="chip">Editing /{editing.route.path.replace(/^\/|\/$/g, '')}/ <button type="button" aria-label="Stop editing" onClick={() => setEditing(null)}>×</button></span>
            ) : (
              <>
                <label className="pill"><span>Where <Help title="Where it lives">WordPress: on the websites server, with wp-admin to edit by hand. New container: its own small container where Gemini writes the full design (HTML and CSS). Or pick one of your own dashboard containers (like test1): the site is installed on it and the container stays yours.</Help></span>
                  <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label="Where the site lives">
                    <option value="wp">WordPress</option>
                    <option value="new">New container</option>
                    {candidates.map((c) => <option key={c.ctid} value={String(c.ctid)}>{c.name} (CT {c.ctid})</option>)}
                  </select></label>
                <label className="pill"><span>Name <Help title="Site name">Becomes the web address: /sites/name/ for WordPress, /name/ for a container site. Lowercase letters, digits and dashes.</Help></span><input value={name} pattern="[a-z0-9][a-z0-9\-]{1,30}" onChange={(e) => { setNameTouched(true); setName(slug(e.target.value)); }} placeholder="bakery" aria-label="Site name" /></label>
                {isWp && <label className="pill"><span>Password <Help title="Site password">The WordPress login password for this site (user admin), at least 8 characters. Write it down: it is not shown again.</Help></span><input type="password" value={sitePass} minLength={8} autoComplete="new-password" onChange={(e) => setSitePass(e.target.value)} placeholder="8+ characters" aria-label="Site password" /></label>}
              </>
            )}
            <span className="ai-actions">
              <span className="quality" role="radiogroup" aria-label="Quality">
                <button type="button" className={quality === 'fast' ? 'on' : ''} onClick={() => setQuality('fast')}>Fast</button>
                <button type="button" className={quality === 'best' ? 'on' : ''} onClick={() => setQuality('best')}>Best</button>
              </span>
              <Help title="Fast or Best">Fast uses Gemini Flash: about a minute. Best uses Gemini Pro: better writing and design, a few minutes, and falls back to Flash if Pro is busy or out of free quota.</Help>
              {pass && prompt.trim().length > 3 && <button type="button" className="mark" title="Save this prompt to Notes" aria-label="Save prompt to Notes" disabled={busy === 'mark'} onClick={() => void bookmark()}><Icon name="bookmark" className="icon-xs" />{savedPrompt ? 'Saved' : 'Save'}</button>}
              <button className="send" type="submit" disabled={!pass || !ready || running || !!busy} aria-label={editing ? 'Apply changes' : 'Create website'}>
                {busy === 'go' ? '…' : <><Icon name={editing ? 'spark' : 'send'} />{editing ? 'Apply' : 'Create'}</>}
              </button>
            </span>
          </div>
        </form>
        {!editing && !prompt && ai !== false && <div className="ideas"><Help title="Ideas">Example descriptions. Click one to put it in the box, then edit it.</Help>{IDEAS.map((idea) => <button key={idea} type="button" onClick={() => setPrompt(idea)}>{idea}</button>)}</div>}
        {!editing && name && <p className="muted hint">Address: {isWp ? `/sites/${name}/, log in to WordPress as admin with the password you set` : `/${name}/`}.</p>}
      </section>

      {error && <p className="message error">{error}</p>}
      {job && (
        <section className={`panel notice ${job.state === 'failed' ? 'error' : ''}`}>
          {job.state === 'running' && <><h2><span className="spinner" />{job.step}…</h2><p>{job.kind === 'create' || job.kind === 'aisite' ? 'A new site takes one to three minutes (longer with Best and pictures). You can leave this page; it keeps going and History keeps the result.' : 'Gemini is working on the site, usually one to two minutes.'}</p></>}
          {job.state === 'failed' && <><h2>That did not work</h2><p>{job.error}</p></>}
          {job.state === 'done' && (
            <>
              <h2>{{ create: 'Your website is live', aisite: 'Your website is live', ai: 'Changes published', aiedit: 'Changes published', undo: 'Change undone', aiundo: 'Change undone' }[job.kind] ?? 'Done'}</h2>
              {result?.summary && <p className="summary">{result.summary}</p>}
              {result?.notes && <p className="muted"><b>Check:</b> {result.notes}</p>}
              <p className="result-links">
                <a className="primary" href={liveUrl} target="_blank" rel="noreferrer">Open the site</a>
                {result?.admin_url && <a className="link" href={result.admin_url} target="_blank" rel="noreferrer">wp-admin</a>}
                {result?.admin_password && <span className="muted">user <code>admin</code>, password <code>{result.admin_password}</code></span>}
                {(job.can_undo || job.kind === 'aiedit') && <button type="button" className="ghost" disabled={busy === 'undo'} onClick={() => void undo()}>Undo this change</button>}
                <Help title="Undo">Puts the site back exactly as it was before this AI change. WordPress keeps the old pages; container sites keep their last 15 versions.</Help>
              </p>
              {job.kind === 'create' && (result as { ai_note?: string })?.ai_note && <p className="bad">The site was created but AI could not write the pages: {(result as { ai_note?: string }).ai_note}. Use Edit with AI to try again.</p>}
            </>
          )}
          <LogBox lines={job.log ?? []} />
        </section>
      )}
      {!pass && <Login onLogin={onLogin} />}
      {pass && ai === false && (
        <form className="panel form key-form" onSubmit={saveKey}>
          <h2><Icon name="spark" />Connect Gemini <Help title="Gemini key">The builder uses Google Gemini to write the pages. Make a key at aistudio.google.com and paste it once. It is stored only on the websites server (CT 108) and never shown again.</Help></h2>
          <div className="row"><input type="password" required value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your Gemini API key" autoComplete="off" /><button className="primary" type="submit" disabled={busy === 'key'}>{busy === 'key' ? 'Saving…' : 'Save key'}</button></div>
        </form>
      )}

      <section className="panel">
        <div className="panel-head"><h2><Icon name="grid" />Your sites <Help title="Your sites">Websites and apps you added; the dot shows whether each answers. Edit with AI: describe a change. Undo: go back one AI change. wp-admin: edit a WordPress site by hand (user admin). Update (apps): pulls the newest code or image. logs: the app's log. Delete asks first; a site on one of your own containers is removed but the container stays.</Help></h2><span className="muted">{shown.length} extra site{shown.length === 1 ? '' : 's'}</span></div>
        <ul className="site-list">
          {shown.map((r) => {
            const state = sites[`route:${r.name}`];
            const a = apps.find((x) => x.name === r.name);
            return (
              <li key={r.name}>
                <Dot state={!state ? 'idle' : state.up ? 'up' : 'down'} />
                <a href={`.${r.path}`}>{r.title}</a>
                <span className="muted">{r.path}, {r.kind === 'wordpress' ? 'WordPress' : r.kind === 'aisite' ? `AI site on CT ${a?.ctid ?? '?'}` : r.kind === 'app' ? `app on CT ${a?.ctid ?? '?'}` : 'link'}</span>
                {r.kind === 'wordpress' && pass && ai && <button type="button" className="ghost" disabled={running} onClick={() => startEdit(r, 'wp')}><Icon name="spark" className="icon-xs" />Edit with AI</button>}
                {r.kind === 'aisite' && pass && a && <><button type="button" className="ghost" disabled={running} onClick={() => startEdit(r, 'aisite', a.ctid)}><Icon name="spark" className="icon-xs" />Edit with AI</button><button type="button" className="ghost" disabled={running || busy === `undo:${r.name}`} onClick={() => void undoSite(r, a.ctid)}>Undo</button></>}
                {r.kind === 'app' && pass && a && <button type="button" className="ghost" disabled={busy === `up:${r.name}`} onClick={() => void call(`up:${r.name}`, `./api/apps/${a.ctid}/update`, { method: 'POST' }).then((b) => { if (b) follow({ source: 'host', id: b.job, kind: 'update', name: r.name }); })}>Update</button>}
                {(r.kind === 'app' || r.kind === 'aisite') && pass && a && <a className="link" href={`#/logs/app-${a.ctid}`}>logs</a>}
                {r.kind === 'wordpress' && <a className="link" href={`.${r.path}wp-admin/`} target="_blank" rel="noreferrer">wp-admin</a>}
                {r.kind === 'wordpress' && pass && <a className="link" href={`#/logs/wp-${r.name}`}>logs</a>}
                {pass && <button type="button" className="danger" disabled={busy === `del:${r.name}`} onClick={() => void remove(r)}>{busy === `del:${r.name}` ? '…' : 'Delete'}</button>}
              </li>
            );
          })}
          {!shown.length && <li className="muted">No extra sites yet.</li>}
        </ul>
      </section>
      {pass && <DeployApp pass={pass} onDone={loadApps} />}
      {pass && <History pass={pass} />}
      {pass && (
        <details className="panel more">
          <summary>Publish an app that already runs <Help title="Publish an app">For an app that already runs somewhere on your network: gives it a public address /name/. Enter where it runs on the LAN, like http://10.0.0.225:8080/.</Help></summary>
          <form className="form" onSubmit={newRoute}>
            <label>Name (becomes /name/)<input required pattern="[a-z0-9][a-z0-9-]{0,39}" value={rName} onChange={(e) => setRName(e.target.value.toLowerCase())} placeholder="e.g. notes" /></label>
            <label>App address on the LAN<input required value={rTarget} onChange={(e) => setRTarget(e.target.value)} placeholder="http://10.0.0.225:8080/" /></label>
            <button className="primary" disabled={!!busy} type="submit"><Icon name="plus" />{busy === 'route' ? 'Adding…' : 'Add route'}</button>
          </form>
        </details>
      )}
    </>
  );
}
const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;
