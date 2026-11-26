import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import config from '../config/services.json';
import { Dot, Icon, hasPriv } from '../lib';
import type { AuthUser, SiteState, Stats } from '../lib';

type Group = 'Pages' | 'Live Apps' | 'Containers & VMs';
type Entry = {
  id: string;
  group: Group;
  label: string;
  hint: string;
  icon: string;
  status?: 'up' | 'down' | 'idle';
  keywords?: string;
  run: () => void;
};

const GROUP_ORDER: Group[] = ['Pages', 'Live Apps', 'Containers & VMs'];
const GROUP_ICON: Record<Group, string> = { Pages: 'grid', 'Live Apps': 'external', 'Containers & VMs': 'server' };

// Ctrl+K / Cmd+K jump bar: pages, live apps and Proxmox guests, grouped. No dependencies.
export function CommandBar({
  nav,
  stats,
  sites = {},
  pass,
  user = null,
  onClose,
}: {
  nav: [string, string, string][];
  stats?: Stats | null;
  sites?: Record<string, SiteState>;
  pass: string;
  user?: AuthUser | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const canInspectGuests = Boolean(pass) && (!user || hasPriv(user, 'view_private') || hasPriv(user, 'manage_containers'));

  const entries = useMemo<Entry[]>(() => {
    const go = (hash: string) => () => { window.location.hash = hash; };
    const current = window.location.hash || '#/';
    const pages = nav.map(([id, label, icon]): Entry => {
      const hash = `#/${id === 'overview' ? '' : id}`;
      return { id: `page-${id}`, group: 'Pages', label, hint: hash === current ? 'current page' : hash, icon, run: go(hash) };
    });
    if (!nav.some(([id]) => id === 'users') && (!user || hasPriv(user, 'manage_users')) && pass) {
      pages.push({ id: 'page-users', group: 'Pages', label: 'Users & Audit', hint: '#/users', icon: 'users', run: go('#/users') });
    }
    if (!nav.some(([id]) => id === 'login')) {
      pages.push({
        id: 'page-login',
        group: 'Pages',
        label: user || pass ? 'Account & Session' : 'Sign in',
        hint: '#/login',
        icon: user || pass ? 'shield' : 'lock',
        keywords: 'login auth account password',
        run: go('#/login'),
      });
    }
    const apps = config.sites.map((s): Entry => {
      const st = sites[s.id];
      return {
        id: `site-${s.id}`,
        group: 'Live Apps',
        label: s.title,
        hint: `CT ${s.ct} · ${st ? (st.up ? `up · ${st.ms} ms` : 'down') : 'checking'}`,
        icon: 'external',
        status: st ? (st.up ? 'up' : 'down') : 'idle',
        keywords: `${s.description} ${s.tags.join(' ')} site app`,
        run: () => { window.open(new URL(s.url, window.location.href).href, '_blank', 'noopener'); },
      };
    });
    const guests = (canInspectGuests ? stats?.guests ?? [] : []).map((g): Entry => {
      const canLogs = g.type === 'lxc' && g.id !== 102;
      return {
        id: `guest-${g.id}`,
        group: 'Containers & VMs',
        label: g.name,
        icon: g.type === 'vm' ? 'box' : 'server',
        status: g.status === 'running' ? 'up' : g.status === 'stopped' ? 'down' : 'idle',
        hint: `${g.type === 'vm' ? 'VM' : 'CT'} ${g.id} · ${g.status}${g.id === 102 ? ' · protected' : canLogs ? ' · logs' : ' · topology'}`,
        keywords: `${g.type} ${g.id} ${(g.tags ?? []).join(' ')}`,
        run: go(canLogs ? `#/logs/ct-${g.id}` : '#/topology'),
      };
    });
    return [...pages, ...apps, ...guests];
  }, [nav, stats, sites, pass, user, canInspectGuests]);

  // Filter, then keep results in group order so the flat index matches what is rendered.
  const results = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length
      ? entries.filter((e) => {
          const hay = `${e.label} ${e.hint} ${e.group} ${e.keywords ?? ''}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
      : entries;
    return GROUP_ORDER.flatMap((g) => hits.filter((e) => e.group === g));
  }, [entries, q]);

  const grouped = useMemo(() => {
    let i = 0;
    return GROUP_ORDER.map((group) => ({
      group,
      items: results.filter((e) => e.group === group).map((entry) => ({ entry, index: i++ })),
    })).filter((g) => g.items.length);
  }, [results]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at, results]);

  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  const jumpGroup = (dir: 1 | -1) => {
    if (!grouped.length) return;
    const cur = grouped.findIndex((g) => g.items.some((it) => it.index === at));
    const next = grouped[(cur + dir + grouped.length) % grouped.length];
    setAt(next.items[0].index);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const n = results.length;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (n ? (i + 1) % n : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (n ? (i - 1 + n) % n : 0)); }
    else if (e.key === 'Home' && n) { e.preventDefault(); setAt(0); }
    else if (e.key === 'End' && n) { e.preventDefault(); setAt(n - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[at]); }
    else if (e.key === 'Tab') { e.preventDefault(); jumpGroup(e.shiftKey ? -1 : 1); } // Tab cycles groups; focus stays in the bar
  };

  const placeholder = canInspectGuests ? 'Jump to a page, app or container…' : 'Jump to a page or app…';
  const activeId = results[at] ? `cmdk-opt-${results[at].id}` : undefined;

  return (
    <div className="cmdk-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command bar" onKeyDown={onKey}>
        <label className="cmdk-field">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={canInspectGuests ? 'Search pages, apps and containers' : 'Search pages and apps'}
            aria-controls="cmdk-results"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="cmdk-list" id="cmdk-results" ref={list} role="listbox" aria-label="Results">
          {grouped.map(({ group, items }) => (
            <div className="cmdk-section" role="group" aria-label={group} key={group}>
              <div className="cmdk-group">
                <Icon name={GROUP_ICON[group]} className="icon-xs" />
                <span>{group}</span>
                <small>{items.length}</small>
              </div>
              {items.map(({ entry: e, index: i }) => (
                <div
                  key={e.id}
                  id={`cmdk-opt-${e.id}`}
                  role="option"
                  aria-selected={i === at}
                  className={`cmdk-item ${i === at ? 'on' : ''}`}
                  onMouseMove={() => { if (i !== at) setAt(i); }}
                  onClick={() => choose(e)}
                >
                  <Icon name={e.icon} />
                  <span className="cmdk-label">{e.label}</span>
                  {e.status && <Dot state={e.status} />}
                  <small className="mono">{e.hint}</small>
                  {i === at && <kbd className="cmdk-enter" aria-hidden="true">↵</kbd>}
                </div>
              ))}
            </div>
          ))}
          {!results.length && (
            <div className="cmdk-empty muted">
              Nothing matches “{q.trim()}”. Try a page name, an app, or a CT number.
            </div>
          )}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Tab</kbd> next group</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span className="cmdk-count">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
