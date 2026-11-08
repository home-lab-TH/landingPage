import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Help } from '../ui/Help';
import { Icon, Login, matches, newId, PROMPT_KEY } from '../lib';
import type { Notes } from '../lib';

// ---------- notes (saved prompts, to-dos, scratch note), stored on the dashboard server ----------
function useNotes(pass: string) {
  const [notes, setNotes] = useState<Notes | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const latest = useRef<Notes | null>(null);
  useEffect(() => {
    if (!pass) return;
    fetch('./api/notes', { headers: { 'x-dashboard-password': pass } })
      .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.message || 'Could not load notes.'); latest.current = b; setNotes(b); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load notes.'));
  }, [pass]);
  const save = async (next: Notes) => {
    latest.current = next; setNotes(next); setState('saving');
    try {
      const r = await fetch('./api/notes', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass }, body: JSON.stringify(next) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.message || 'Could not save.');
      setState(latest.current === next ? 'saved' : 'saving'); setError('');
    } catch (e) { setState('error'); setError(e instanceof Error ? e.message : 'Could not save.'); }
  };
  const update = (change: (n: Notes) => Notes) => { if (latest.current) void save(change(latest.current)); };
  return { notes, state, error, update };
}

export default function NotesPage({ query, pass, onLogin }: { query: string; pass: string; onLogin: (p: string) => void }) {
  const { notes, state, error, update } = useNotes(pass);
  const [draft, setDraft] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [newTodo, setNewTodo] = useState('');
  useEffect(() => {
    if (draft === null || !notes || draft === notes.note) return undefined;
    const t = window.setTimeout(() => update((n) => ({ ...n, note: draft })), 800);
    return () => window.clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pass) return (<><header className="page-head"><div><p className="eyebrow">Notes</p><h1>Your notes</h1><p className="lede">Saved prompts and to-dos, on the server so they follow you to any device.</p></div></header><Login onLogin={onLogin} /></>);
  if (!notes) return <p className={error ? 'message error' : 'muted'}>{error || 'Loading notes…'}</p>;
  const prompts = notes.prompts.filter((p) => matches(query, p.text));
  const todos = notes.todos.filter((t) => matches(query, t.text));
  const open = todos.filter((t) => !t.done); const done = todos.filter((t) => t.done);
  const usePrompt = (text: string) => { try { sessionStorage.setItem(PROMPT_KEY, text); } catch { /* ignore */ } window.location.hash = '#/sites'; };
  const addPrompt = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!newPrompt.trim()) return; update((n) => ({ ...n, prompts: [{ id: newId(), text: newPrompt.trim(), at: new Date().toISOString() }, ...n.prompts] })); setNewPrompt(''); };
  const addTodo = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!newTodo.trim()) return; update((n) => ({ ...n, todos: [...n.todos, { id: newId(), text: newTodo.trim(), at: new Date().toISOString(), done: false }] })); setNewTodo(''); };
  const toggle = (id: string) => update((n) => ({ ...n, todos: n.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) }));
  const dropTodo = (id: string) => update((n) => ({ ...n, todos: n.todos.filter((t) => t.id !== id) }));
  const dropPrompt = (id: string) => update((n) => ({ ...n, prompts: n.prompts.filter((p) => p.id !== id) }));
  const status = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? error : notes.updated ? `Last saved ${new Date(notes.updated).toLocaleString()}` : '';
  return (
    <>
      <header className="page-head"><div><p className="eyebrow">Notes</p><h1>Your notes <Help big title="This page: Notes">To-dos, saved prompts and a scratch note. Everything is saved on the server, so it is the same on your phone and laptop. Saved prompts have a Build site button that opens the website builder with that text.</Help></h1><p className="lede">Saved prompts and to-dos, on the server so they follow you to any device.</p></div><span className={`muted hint ${state === 'error' ? 'bad' : ''}`}>{status}</span></header>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="check" />To do <Help title="To do">Type a task and press Enter. Tick it when done; × deletes it. Clear done removes all ticked tasks.</Help></h2><span className="muted">{open.length} open</span></div>
          <form className="add-row" onSubmit={addTodo}><input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="Add a to-do and press Enter" aria-label="New to-do" /><button className="primary" type="submit"><Icon name="plus" /></button></form>
          <ul className="todo-list">
            {[...open, ...done].map((t) => (
              <li key={t.id} className={t.done ? 'done' : ''}>
                <label><input type="checkbox" checked={!!t.done} onChange={() => toggle(t.id)} /><span>{t.text}</span></label>
                <button type="button" className="x" aria-label="Delete" onClick={() => dropTodo(t.id)}>×</button>
              </li>
            ))}
            {!todos.length && <li className="muted">Nothing to do. Nice.</li>}
          </ul>
          {done.length > 0 && <button type="button" className="link-btn" onClick={() => update((n) => ({ ...n, todos: n.todos.filter((t) => !t.done) }))}>Clear {done.length} done</button>}
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Icon name="bookmark" />Saved prompts <Help title="Saved prompts">Keep website ideas or tasks for later. Build site opens the website builder with the prompt filled in. Copy puts it on your clipboard for Gemini or Claude.</Help></h2><span className="muted">{prompts.length}</span></div>
          <form className="add-row" onSubmit={addPrompt}><textarea rows={2} value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder="Save a prompt for later (website ideas, Gemini tasks…)" aria-label="New prompt" /><button className="primary" type="submit"><Icon name="plus" /></button></form>
          <ul className="prompt-list">
            {prompts.map((p) => (
              <li key={p.id}>
                <p>{p.text}</p>
                <div className="prompt-actions">
                  <span className="muted">{new Date(p.at).toLocaleDateString()}</span>
                  <button type="button" className="ghost" onClick={() => usePrompt(p.text)}><Icon name="spark" className="icon-xs" />Build site</button>
                  <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(p.text)}>Copy</button>
                  <button type="button" className="x" aria-label="Delete" onClick={() => dropPrompt(p.id)}>×</button>
                </div>
              </li>
            ))}
            {!prompts.length && <li className="muted">No saved prompts yet. Use the bookmark button in the website builder, or add one here.</li>}
          </ul>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><h2><Icon name="note" />Scratch note <Help title="Scratch note">Free text for anything. It saves by itself a moment after you stop typing.</Help></h2><span className="muted">saves as you type</span></div>
        <textarea className="scratch" rows={8} value={draft ?? notes.note} onChange={(e) => setDraft(e.target.value)} placeholder="Anything: ideas, links, what to ask Claude next…" />
      </section>
    </>
  );
}
