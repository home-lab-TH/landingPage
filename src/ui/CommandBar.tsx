import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import config from '../config/services.json';
import { Icon, hasPriv } from '../lib';
import type { AuthUser, Stats } from '../lib';

type Entry = { id: string; group: 'Pages' | 'Sites' | 'Containers'; label: string; hint: string; icon: string; run: () => void };

// Ctrl+K / Cmd+K jump bar: pages, sites and live Proxmox guests. No dependencies.
export function CommandBar({
  nav,
  stats,
  pass,
  user = null,
  onClose,
}: {
  nav: [string, string, string][];
  stats?: Stats | null;
  pass: string;
  user?: AuthUser | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const canInspectGuests = Boolean(pass) && (!user || hasPriv(user, 'view_private') || hasPriv(user, 'manage_containers'));

  const entries = useMemo<Entry[]>(() => {
    const go = (hash: string) => () => { window.location.hash = hash; };
    const pages = nav.map(([id, label, icon]): Entry => ({
      id: `page-${id}`,
      group: 'Pages',
      label,
      hint: `#/${id === 'overview' ? '' : id}`,
      icon,
      run: go(`#/${id === 'overview' ? '' : id}`),
    }));
    const hasUsersInNav = nav.some(([id]) => id === 'users');
    if (!hasUsersInNav && (!user || hasPriv(user, 'manage_users')) && pass) {
      pages.push({
        id: 'page-users',
        group: 'Pages',
        label: 'Users & Audit',
        hint: '#/users',
        icon: 'users',
        run: go('#/users'),
      });
    }
    if (!nav.some(([id]) => id === 'login')) {
      pages.push({
        id: 'page-login',
        group: 'Pages',
        label: user || pass ? 'Account & Session' : 'Sign in',
        hint: '#/login',
        icon: user || pass ? 'shield' : 'lock',
        run: go('#/login'),
      });
    }
    const sites = config.sites.map((s): Entry => ({
      id: `site-${s.id}`,
      group: 'Sites',
      label: s.title,
      hint: `CT ${s.ct} · open site`,
      icon: 'external',
      run: () => { window.open(new URL(s.url, window.location.href).href, '_blank', 'noopener'); },
    }));
    const guests = (canInspectGuests ? stats?.guests ?? [] : []).map((g): Entry => ({
      id: `guest-${g.id}`,
      group: 'Containers',
      label: g.name,
      icon: g.type === 'vm' ? 'box' : 'server',
      hint: `${g.type === 'vm' ? 'VM' : 'CT'} ${g.id} · ${g.status}${g.type === 'lxc' ? ' · logs' : ' · topology'}`,
      run: go(g.type === 'lxc' ? `#/logs/ct-${g.id}` : '#/topology'),
    }));
    return [...pages, ...sites, ...guests];
  }, [nav, stats, pass, user, canInspectGuests]);

  const results = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return entries;
    return entries.filter((e) => { const hay = `${e.label} ${e.hint} ${e.group}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [entries, q]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at, results]);

  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (results.length ? (i + 1) % results.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[at]); }
    else if (e.key === 'Tab') { e.preventDefault(); } // keep focus in the bar
  };

  let last = '';
  return (
    <div className="cmdk-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command bar" onKeyDown={onKey}>
        <label className="cmdk-field">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={canInspectGuests ? 'Jump to a page, site or container' : 'Jump to a page or site'} aria-label={canInspectGuests ? 'Search pages, sites and containers' : 'Search pages and sites'} autoComplete="off" spellCheck={false} />
          <kbd>Esc</kbd>
        </label>
        <ul className="cmdk-list" ref={list} role="listbox" aria-label="Results">
          {results.map((e, i) => {
            const head = e.group !== last ? (last = e.group) : '';
            return (
              <li key={e.id} role="presentation">
                {head && <div className="cmdk-group">{head}</div>}
                <div role="option" aria-selected={i === at} className={`cmdk-item ${i === at ? 'on' : ''}`} onMouseMove={() => setAt(i)} onClick={() => choose(e)}>
                  <Icon name={e.icon} /><span className="cmdk-label">{e.label}</span><small className="mono">{e.hint}</small>
                </div>
              </li>
            );
          })}
          {!results.length && <li className="cmdk-empty muted">Nothing matches “{q.trim()}”.</li>}
        </ul>
        <div className="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}
