import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { ThemeToggle } from '../theme.jsx';
import { ATTENTION, CAMPAIGNS, FINANCING, KPIS, LIFECYCLE, NAV, PROJECTS, RUNS } from './sampleData.js';

const ICONS = {
  home: <path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  book: <path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13" />,
  upload: <><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  store: <><path d="M3 9h18l-1.5-5h-15z" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  chart: <path d="M4 20V11M10 20V5M16 20v-6M2 20h20" />,
  server: <><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  bank: <><path d="M3 10 12 4l9 6" /><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" /></>,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  shieldAlert: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="M12 8v4M12 16h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 8h5M19.5 5.5v5" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function Sidebar() {
  return (
    <aside className="dash-side">
      <a className="dash-brand" href="#overview">
        <span className="dash-mark" aria-hidden="true" />
        <span><strong>Valcairn</strong><small>by Frontier Intelligence Labs</small></span>
      </a>
      <nav aria-label="Workspace" className="dash-nav">
        {NAV.map((group) => (
          <div key={group.label ?? 'main'} className="dash-nav-group">
            {group.label && <span className="dash-nav-label">{group.label}</span>}
            {group.items.map((item) => (
              <a key={item.label} href={item.href} aria-current={item.current ? 'page' : undefined}>
                <Icon name={item.icon} />{item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Lifecycle({ step, total = LIFECYCLE.length }) {
  return (
    <div className="lifecycle">
      <div className="lifecycle-track" aria-hidden="true">
        {LIFECYCLE.map((stage, i) => (
          <span key={stage} className={i < step - 1 || step > total ? 'is-done' : i === step - 1 ? 'is-current' : ''} />
        ))}
      </div>
      <span className="subtle">{step > total ? `Deployed · ${total} of ${total}` : `${LIFECYCLE[step - 1]} · step ${step} of ${total}`}</span>
    </div>
  );
}

function Projects({ query }) {
  const q = query.trim().toLowerCase();
  const rows = PROJECTS.filter((p) => !q || `${p.name} ${p.data}`.toLowerCase().includes(q));
  return (
    <section id="projects" className="card card--table" aria-labelledby="projects-title">
      <div className="card-head">
        <h2 id="projects-title">Projects</h2>
        <span className="subtle">{rows.length} of {PROJECTS.length}</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th scope="col">Project</th><th scope="col">Lifecycle</th><th scope="col">Now</th><th scope="col" className="num">Updated</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.name}>
                <td><div className="cell-stack"><strong>{p.name}</strong><span className="subtle">{p.data}</span></div></td>
                <td><Lifecycle step={p.step} /></td>
                <td className={`tone-${p.tone ?? 'plain'}`}>{p.now}</td>
                <td className="num subtle">{p.updated}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="subtle">No projects match “{query}”.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="card-foot subtle">Lifecycle: {LIFECYCLE.join(' → ')}</p>
    </section>
  );
}

function Attention() {
  return (
    <section id="attention" className="card" aria-labelledby="attention-title">
      <div className="card-head">
        <h2 id="attention-title">Needs you</h2>
        <span className="count">{ATTENTION.length}</span>
      </div>
      <ul className="attention">
        {ATTENTION.map((item) => (
          <li key={item.text}>
            <span className={`tone-${item.tone}`}><Icon name={item.icon} /></span>
            <div className="cell-stack">
              <span className={`eyebrow tone-${item.tone}`}>{item.kind}</span>
              <span>{item.text}</span>
            </div>
            <a className="btn-small" href={item.href}>{item.action}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ label, value }) {
  return <div className="cell-stack"><dt className="subtle">{label}</dt><dd>{value}</dd></div>;
}

function Supply() {
  return (
    <section id="collection" className="card card--pad" aria-labelledby="supply-title">
      <div className="card-head"><h2 id="supply-title">Collection &amp; labeling</h2></div>
      {CAMPAIGNS.map((c) => (
        <div key={c.name} className="progress-row">
          <div className="row-between"><span className="strong">{c.name}</span><span className="subtle">{c.pct}%</span></div>
          <div className="bar" role="progressbar" aria-label={c.name} aria-valuenow={c.pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${c.pct}%` }} /></div>
          <span className="subtle">{c.note}</span>
        </div>
      ))}
      <dl className="stats stats--3">
        <Stat label="Label queue" value="2,310" />
        <Stat label="Agreement" value="94.1%" />
        <Stat label="Rejected" value="3.2%" />
      </dl>
    </section>
  );
}

function Models() {
  return (
    <section id="training" className="card card--pad" aria-labelledby="models-title">
      <div className="card-head"><h2 id="models-title">Training &amp; evaluation</h2></div>
      <ul className="runs">
        {RUNS.map((r) => (
          <li key={r.name}>
            <div className="cell-stack"><span className="strong">{r.name}</span><span className="subtle">{r.note}</span></div>
            <span className={`pill pill--${r.tone}`}>{r.status}</span>
          </li>
        ))}
      </ul>
      <div className="row-between card-rule"><span className="subtle">Deployments you control</span><span className="strong">1 edge · 1 on-prem</span></div>
    </section>
  );
}

function Market() {
  return (
    <section id="listings" className="card card--pad" aria-labelledby="market-title">
      <div className="card-head"><h2 id="market-title">Licensing &amp; sales</h2></div>
      <dl className="stats stats--2">
        <Stat label="Live listings" value="4" />
        <Stat label="Active licenses" value="11" />
      </dl>
      <div className="share">
        <span className="eyebrow subtle">Contributor share, Q4</span>
        <div className="bar bar--thick" role="progressbar" aria-label="Contributor share paid" aria-valuenow={63} aria-valuemin={0} aria-valuemax={100}><span style={{ width: '63%' }} /></div>
        <div className="row-between">
          <span><strong>$21,260</strong> <span className="subtle">paid</span></span>
          <span><strong>$12,480</strong> <span className="subtle">accrued, unpaid</span></span>
        </div>
      </div>
      <p className="body-2"><strong>Latest:</strong> Factory floor audio v2 licensed to [Buyer] for evaluation only, 12 months.</p>
    </section>
  );
}

function Financing() {
  return (
    <section id="financing" className="card card--fin" aria-labelledby="fin-title">
      <div className="fin-copy">
        <span className="eyebrow subtle">Financing</span>
        <h2 id="fin-title">{FINANCING.title}</h2>
        <p className="body-2">{FINANCING.summary}</p>
      </div>
      <div className="fin-status">
        <ol className="fin-steps">
          {FINANCING.steps.map((s, i) => (
            <li key={s} className={i < FINANCING.current ? 'is-done' : i === FINANCING.current ? 'is-current' : ''} aria-current={i === FINANCING.current ? 'step' : undefined}>
              <span aria-hidden="true" />{s}
            </li>
          ))}
        </ol>
        <div className="row-between row-wrap">
          <span className="subtle">Reviewed by capital partners. Nothing is funded until an agreement is recorded.</span>
          <a className="btn-solid-app" href="#financing">Open data room <Icon name="arrow" size={16} /></a>
        </div>
      </div>
    </section>
  );
}

export default function Dashboard({ reviewer }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  async function signOut() {
    await api.logout().catch(() => null);
    navigate('/demo');
  }

  return (
    <div className="dash">
      <title>Overview — Valcairn workspace</title>
      <Sidebar />
      <div className="dash-body">
        <header className="dash-top">
          <div className="row-wrap gap-10">
            <span className="org">Acme Robotics</span>
            <span className="chip">Sample data</span>
          </div>
          <div className="dash-tools">
            <label className="search">
              <Icon name="search" size={16} />
              <span className="visually-hidden">Search projects</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…" />
            </label>
            <ThemeToggle />
            <span className="avatar" title={reviewer.username} aria-hidden="true">{initials(reviewer.name)}</span>
            <span className="visually-hidden">Signed in as {reviewer.name}</span>
            <button type="button" className="btn-small" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <main id="overview" className="dash-main">
          <section className="dash-heading">
            <div className="cell-stack">
              <h1>Overview</h1>
              <p className="subtle">Data, models and capital across five active projects. Sample workspace for invited reviewers.</p>
            </div>
          </section>

          <section aria-label="Key figures" className="kpis">
            {KPIS.map((k) => (
              <div key={k.label} className="kpi">
                <span className="subtle">{k.label}</span>
                <span className="kpi-value">{k.value}</span>
                <span className={k.tone ? `tone-${k.tone}` : 'subtle'}>{k.note}</span>
              </div>
            ))}
          </section>

          <div className="dash-split">
            <Projects query={query} />
            <Attention />
          </div>

          <div className="dash-grid">
            <Supply />
            <Models />
            <Market />
          </div>

          <Financing />
        </main>
      </div>
    </div>
  );
}
