import { useState } from 'react';
import config from '../config/services.json';
import { Icon, matches } from '../lib';
import type { SiteState } from '../lib';

type Site = (typeof config.sites)[number];
type StatusFilter = 'all' | 'online' | 'offline';

const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
];

const Status = ({ state }: { state?: SiteState }) => {
  if (!state) return <span className="pill">…</span>;
  if (state.up) return <span className="pill up"><i />{state.ms} ms</span>;
  return <span className="pill down"><i />{state.code || 'down'}</span>;
};

const Project = ({ site, state }: { site: Site; state?: SiteState }) => (
  <article className="proj">
    <div className="proj-top">
      <span className="badge">{site.icon}</span>
      <Status state={state} />
      <span className="pill mono">CT {site.ct}</span>
    </div>
    <h4>{site.title}</h4>
    <p>{site.description}</p>
    <div className="chips">{site.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>
    <div className="proj-links">
      <a className="btn solid" href={site.url}>Open App <Icon name="external" className="icon-xs" /></a>
      {site.repo && (
        <a className="btn" href={site.repo} target="_blank" rel="noreferrer"><Icon name="github" className="icon-xs" />GitHub</a>
      )}
    </div>
  </article>
);

export default function Services({ query, sites }: { query: string; sites: Record<string, SiteState> }) {
  const [owner, setOwner] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const states = config.sites.map((s) => sites[s.id]).filter((s): s is SiteState => Boolean(s));
  const online = states.filter((s) => s.up);
  const avgMs = online.length ? Math.round(online.reduce((a, s) => a + s.ms, 0) / online.length) : null;
  const contributors = config.members.filter((m) => config.sites.some((s) => s.owner === m.id)).length;

  const statusOk = (s: Site) => {
    const st = sites[s.id];
    if (status === 'online') return Boolean(st?.up);
    if (status === 'offline') return Boolean(st && !st.up);
    return true;
  };
  const filtersActive = owner !== 'all' || status !== 'all';
  const reset = () => { setOwner('all'); setStatus('all'); };

  const groups = config.members
    .filter((m) => owner === 'all' || m.id === owner)
    .map((m) => ({
      member: m,
      own: config.sites.filter((s) => s.owner === m.id && statusOk(s) && matches(query, s.title, s.description, m.name, ...s.tags)),
    }))
    .filter(({ member, own }) => {
      if (own.length) return true;
      if (status !== 'all') return false;
      return !query || matches(query, member.name);
    });
  const shown = groups.reduce((a, g) => a + g.own.length, 0);
  const links = config.links.filter((l) => matches(query, l.title, l.description));

  return (
    <>
      <header className="page-head">
        <h1>Services</h1>
        <p className="lede">Everything running on the server, grouped by who built it.</p>
      </header>

      <div className="services-summary">
        <span className="pill"><b>{config.sites.length}</b> services</span>
        <span className="pill up"><i /><b>{online.length}</b> online</span>
        <span className="pill mono">{avgMs === null ? '— ms' : `${avgMs} ms`} avg</span>
        <span className="pill"><b>{contributors}</b> contributors</span>
      </div>

      <div className="services-filters filter-bar">
        <div className="filter-pills" role="group" aria-label="Filter by owner">
          <button type="button" className={`filter-pill${owner === 'all' ? ' on' : ''}`} aria-pressed={owner === 'all'} onClick={() => setOwner('all')}>All</button>
          {config.members.map((m) => (
            <button type="button" key={m.id} className={`filter-pill${owner === m.id ? ' on' : ''}`} aria-pressed={owner === m.id} onClick={() => setOwner(m.id)}>{m.name}</button>
          ))}
        </div>
        <div className="filter-pills" role="group" aria-label="Filter by status">
          {STATUS_OPTIONS.map((o) => (
            <button type="button" key={o.id} className={`filter-pill${status === o.id ? ' on' : ''}`} aria-pressed={status === o.id} onClick={() => setStatus(o.id)}>{o.label}</button>
          ))}
        </div>
        {filtersActive && <span className="muted">{shown} of {config.sites.length} shown</span>}
      </div>

      {groups.length ? (
        groups.map(({ member: m, own }) => (
          <section className="panel member" key={m.id}>
            <div className="member-head">
              <span className={`avatar ${m.color}`}>{m.initials}</span>
              <div>
                <h2>{m.name}</h2>
                <span className="muted">{own.length ? `${own.length} ${own.length === 1 ? 'service' : 'services'}` : 'In progress'}{'role' in m && m.role ? ` · ${m.role}` : ''}</span>
              </div>
            </div>
            {own.length ? (
              <div className="projs">{own.map((s) => <Project key={s.id} site={s} state={sites[s.id]} />)}</div>
            ) : (
              <div className="soon">Coming soon</div>
            )}
          </section>
        ))
      ) : (
        <section className="panel empty">
          <h2>No services match</h2>
          <p className="muted">Nothing fits the current {query ? 'search and ' : ''}filters. Try a different owner or status.</p>
          {filtersActive && <button type="button" className="btn" onClick={reset}>Reset filters</button>}
        </section>
      )}

      {links.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Admin &amp; Infrastructure</h2>
            <span className="muted">{links.length} tools</span>
          </div>
          <div className="link-row">
            {links.map((l) => (
              <a className="link-card" key={l.title} href={l.url} target="_blank" rel="noreferrer">
                <span className="badge">{l.icon}</span>
                <span><b>{l.title}</b><small className="muted">{l.description}</small></span>
                <Icon name="external" className="icon-xs dim" />
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
