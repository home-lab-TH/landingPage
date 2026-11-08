import config from '../config/services.json';
import { Icon, matches } from '../lib';
import type { SiteState } from '../lib';

type Site = (typeof config.sites)[number];

const Status = ({ state }: { state?: SiteState }) => {
  if (!state) return <span className="pill">…</span>;
  if (state.up) return <span className="pill up"><i />{state.ms} ms</span>;
  return <span className="pill down"><i />{state.code || 'down'}</span>;
};

const Project = ({ site, state }: { site: Site; state?: SiteState }) => (
  <article className="proj">
    <div className="proj-top"><Status state={state} /><span className="pill mono">CT {site.ct}</span></div>
    <h4>{site.title}</h4>
    <p>{site.description}</p>
    <div className="chips">{site.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>
    <div className="proj-links">
      <a href={site.url}>Open <Icon name="external" className="icon-xs" /></a>
      {site.repo && <a href={site.repo} target="_blank" rel="noreferrer"><Icon name="github" className="icon-xs" />GitHub</a>}
    </div>
  </article>
);

export default function Services({ query, sites }: { query: string; sites: Record<string, SiteState> }) {
  const links = config.links.filter((l) => matches(query, l.title, l.description));
  return (
    <>
      <header className="page-head">
        <h1>Services</h1>
        <p className="lede">Everything running on the server, by who built it.</p>
      </header>
      {config.members.map((m) => {
        const own = config.sites.filter((s) => s.owner === m.id && matches(query, s.title, s.description, m.name, ...s.tags));
        if (query && !own.length && !matches(query, m.name)) return null;
        return (
          <section className="panel member" key={m.id}>
            <div className="member-head">
              <span className={`avatar ${m.color}`}>{m.initials}</span>
              <div><h2>{m.name}</h2><span className="muted">{own.length ? `${own.length} ${own.length === 1 ? 'service' : 'services'}` : 'In progress'}{'role' in m && m.role ? ` · ${m.role}` : ''}</span></div>
            </div>
            {own.length ? <div className="projs">{own.map((s) => <Project key={s.id} site={s} state={sites[s.id]} />)}</div> : <div className="soon">Coming soon</div>}
          </section>
        );
      })}
      {links.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Admin and code</h2></div>
          <div className="link-row">
            {links.map((l) => (
              <a className="link-card" key={l.title} href={l.url} target="_blank" rel="noreferrer">
                <span className="badge">{l.icon}</span><span><b>{l.title}</b><small className="muted">{l.description}</small></span><Icon name="external" className="icon-xs dim" />
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
