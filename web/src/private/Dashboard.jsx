import { useEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.js';
import { ThemeToggle } from '../theme.jsx';
import { costTotalLines, createOverviewLoader, formatCents, initialOverviewState, reduceOverview } from './overview-state.js';

/**
 * The reviewer overview: actual records of one pinned synthetic workspace, read from GET /api/demo/overview.
 * Nothing on this page is sample data. Every section shows what the server recorded, or says plainly that there is
 * nothing, that the overview is not configured, or that the latest refresh failed.
 */
const ICONS = {
  home: <path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  chart: <path d="M4 20V11M10 20V5M16 20v-6M2 20h20" />,
  bank: <><path d="M3 10 12 4l9 6" /><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'projects', label: 'Projects', icon: 'grid' },
  { id: 'compute', label: 'Compute', icon: 'chip' },
  { id: 'evaluation', label: 'Evaluation', icon: 'chart' },
  { id: 'capital', label: 'Capital', icon: 'bank' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
];

const PROJECT_STATUS = { draft: 'Draft', in_review: 'In review', changes_requested: 'Changes requested', approved: 'Approved', versioned: 'Dataset version approved' };
const JOB_KIND = { probe: 'Sandbox check', train: 'Training', evaluate: 'Evaluation', export: 'Export' };
const JOB_STATUS = { queued: 'Queued', leased: 'Leased', running: 'Running', cancel_requested: 'Cancel requested', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' };
const JOB_TONE = { succeeded: 'info', failed: 'warn', cancelled: 'warn' };
const DECISION = { pass: 'Pass', fail: 'Fail', insufficient_evidence: 'Insufficient evidence' };
const DECISION_TONE = { pass: 'info', fail: 'warn', insufficient_evidence: 'plain' };
const CASE_STATUS = { draft: 'Draft', submitted: 'With internal review', changes_requested: 'Changes requested', evidence_reviewed: 'Evidence reviewed' };
const METRIC_LABELS = {
  hostGpus: 'GPUs on host', trainExamples: 'Training examples', heldOutExamples: 'Held-out examples', steps: 'Steps', epochs: 'Epochs',
  baseHeldOutLoss: 'Base held-out loss', tunedHeldOutLoss: 'Tuned held-out loss', trainSeconds: 'Training seconds', peakGpuMemoryMb: 'Peak GPU memory (MB)',
  baseF1: 'Base token F1', tunedF1: 'Tuned token F1', baseExact: 'Base exact match', tunedExact: 'Tuned exact match', heldOutScored: 'Held-out answers scored',
  ggufSizeBytes: 'GGUF size (bytes)', loadTestConversations: 'Load-test conversations', loadTestSeconds: 'Load-test seconds', tunedTokensPerSec: 'Tuned tokens/s', baseTokensPerSec: 'Base tokens/s',
};
const UNAVAILABLE_HELP = {
  demo_unconfigured: 'The server has no DEMO_WORKSPACE_ID, so no workspace is pinned for this view. No sample data is shown in its place.',
  demo_workspace_missing: 'The pinned workspace id does not match any workspace on this server.',
  demo_workspace_not_synthetic: 'The pinned workspace is not marked as a synthetic demo, so this view refuses to show it.',
  store_unavailable: 'This server has no database, so there are no records to show.',
};

const initials = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const formatNumber = (value) => (Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 4 }));
const formatPercent = (fraction) => `${(fraction * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const humanize = (value) => String(value ?? '').replaceAll(/[._]/g, ' ');
const roleName = (role) => role[0].toUpperCase() + role.slice(1);

function Sidebar({ admin }) {
  return (
    <aside className="dash-side">
      <a className="dash-brand" href="#overview">
        <span className="dash-mark" aria-hidden="true" />
        <span><strong>Valcairn</strong><small>by Frontier Intelligence Labs</small></span>
      </a>
      <nav aria-label="Overview sections" className="dash-nav">
        <div className="dash-nav-group">
          {SECTIONS.map((s, i) => <a key={s.id} href={`#${s.id}`} aria-current={i === 0 ? 'page' : undefined}><Icon name={s.icon} />{s.label}</a>)}
          {admin && <a href="#access-log"><Icon name="shield" />Sign-in log</a>}
        </div>
      </nav>
    </aside>
  );
}

function Empty({ children }) {
  return <p className="card-foot subtle">{children}</p>;
}

function Projects({ projects }) {
  if (projects.available === false) return <section id="projects" className="card" aria-labelledby="projects-title"><div className="card-head"><h2 id="projects-title">Projects</h2></div><Empty>This server's store does not expose project records.</Empty></section>;
  return (
    <section id="projects" className="card card--table" aria-labelledby="projects-title">
      <div className="card-head">
        <h2 id="projects-title">Projects</h2>
        <span className="subtle">{plural(projects.length, 'project')} recorded</span>
      </div>
      {projects.length === 0 ? <Empty>No projects have been created in this workspace yet.</Empty> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Dataset versions</th><th scope="col">Staff reviews</th><th scope="col">Evaluation sets</th><th scope="col" className="num">Updated</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const latest = p.versions.at(-1);
                return (
                  <tr key={p.id}>
                    <td><div className="cell-stack"><strong>{p.name}</strong><span className="subtle">{p.modalities.join(', ') || 'No inputs chosen'}</span></div></td>
                    <td>{PROJECT_STATUS[p.status] ?? humanize(p.status)}</td>
                    <td>{latest ? `v${latest.number}${latest.files == null ? '' : ` · ${plural(latest.files, 'file')}`}${p.versions.length > 1 ? ` · ${p.versions.length} versions` : ''}` : <span className="subtle">None approved</span>}</td>
                    <td>{p.reviews.approved + p.reviews.changes_requested + p.reviews.pending + p.reviews.withdrawn === 0 ? <span className="subtle">None</span> : `${p.reviews.approved} approved · ${p.reviews.changes_requested} changes requested${p.reviews.pending ? ` · ${p.reviews.pending} pending` : ''}`}</td>
                    <td>{p.evaluationSets.length === 0 ? <span className="subtle">None</span> : p.evaluationSets.map((s) => `${s.name} (${s.status}${s.caseCount == null ? '' : `, ${plural(s.caseCount, 'case')}`})`).join('; ')}</td>
                    <td className="num subtle">{formatTime(p.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot subtle">Statuses and counts are the workspace's stored records. A dataset version freezes exactly the files and rights record a staff review approved.</p>
    </section>
  );
}

function Metrics({ metrics }) {
  const entries = Object.entries(metrics?.values ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="stats stats--auto" aria-label="Runner-reported metrics">
      {entries.map(([key, value]) => (
        <div key={key} className="cell-stack"><dt className="subtle">{METRIC_LABELS[key] ?? humanize(key)}</dt><dd>{formatNumber(value)}</dd></div>
      ))}
    </dl>
  );
}

function Compute({ compute }) {
  if (compute.available === false) return <section id="compute" className="card card--pad" aria-labelledby="compute-title"><div className="card-head"><h2 id="compute-title">Compute</h2></div><Empty>This server's store does not expose runners or jobs.</Empty></section>;
  const { runners, jobs } = compute;
  return (
    <section id="compute" className="card card--pad" aria-labelledby="compute-title">
      <div className="card-head"><h2 id="compute-title">Compute</h2><span className="subtle">{plural(runners.length, 'linked machine')}</span></div>
      {runners.length === 0 ? <p className="subtle">No machine has been linked to this workspace.</p> : (
        <ul className="runs">
          {runners.map((r) => (
            <li key={r.id}>
              <div className="cell-stack"><span className="strong">{r.label}</span><span className="subtle">{r.lastSeenAt ? `Last heard from ${formatTime(r.lastSeenAt)}` : 'Never heard from'}{r.reportedGpus == null ? '' : ` · ${plural(r.reportedGpus, 'GPU')} reported`}</span></div>
              <span className={`pill pill--${r.status === 'active' ? 'plain' : 'warn'}`}>{r.status === 'active' ? 'Linked' : 'Revoked'}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row-between card-rule"><span className="strong">Jobs</span><span className="subtle">Latest {jobs.limit} · state as last recorded</span></div>
      {jobs.items.length === 0 ? <p className="subtle">No jobs have been queued.</p> : (
        <ul className="runs">
          {jobs.items.map((j) => (
            <li key={j.id} style={{ flexWrap: 'wrap' }}>
              <div className="cell-stack" style={{ flex: '1 1 240px' }}>
                <span className="strong">{JOB_KIND[j.kind] ?? humanize(j.kind)}</span>
                <span className="subtle">Attempt {j.attempt} of {j.maxAttempts} · queued {formatTime(j.createdAt)}{j.finishedAt ? ` · ended ${formatTime(j.finishedAt)}` : ''}{j.failure ? ` · ${humanize(j.failure)}` : ''}</span>
              </div>
              <span className={`pill pill--${JOB_TONE[j.status] ?? 'plain'}`}>{JOB_STATUS[j.status] ?? humanize(j.status)}</span>
              <div style={{ flexBasis: '100%' }}><Metrics metrics={j.metrics} /></div>
            </li>
          ))}
        </ul>
      )}
      <p className="subtle">Metrics are the numbers the runner reported for that job. They describe a run on the customer's own machine, not a certified result.</p>
    </section>
  );
}

function Evaluation({ evaluation, projects }) {
  if (evaluation.available === false) return <section id="evaluation" className="card card--pad" aria-labelledby="eval-title"><div className="card-head"><h2 id="eval-title">Evaluation</h2></div><Empty>This server's store does not expose evaluation reports.</Empty></section>;
  const setNames = new Map((Array.isArray(projects) ? projects : []).flatMap((p) => p.evaluationSets.map((s) => [s.id, p.name])));
  return (
    <section id="evaluation" className="card card--pad" aria-labelledby="eval-title">
      <div className="card-head"><h2 id="eval-title">Evaluation</h2><span className="subtle">{plural(evaluation.reports.length, 'approved report')}</span></div>
      {evaluation.reports.length === 0 ? <p className="subtle">No evaluation report has been approved. Draft sets, if any, are listed under Projects.</p> : (
        <ul className="runs">
          {evaluation.reports.map((r) => (
            <li key={r.id}>
              <div className="cell-stack">
                <span className="strong">{r.setName ?? 'Evaluation set'}{r.setVersion == null ? '' : ` v${r.setVersion}`}{setNames.has(r.setId) ? ` · ${setNames.get(r.setId)}` : ''}</span>
                <span className="subtle">
                  {r.counts.eligible == null ? '' : `${r.counts.passes ?? '?'} of ${r.counts.eligible} eligible cases passed`}
                  {r.passRate == null ? '' : ` (${formatPercent(r.passRate)})`}
                  {r.counts.reviewed == null ? '' : ` · ${plural(r.counts.reviewed, 'review decision')}`}
                  {` · approved ${formatTime(r.approvedAt)}`}
                </span>
              </div>
              <span className={`pill pill--${DECISION_TONE[r.decision] ?? 'plain'}`}>{DECISION[r.decision] ?? humanize(r.decision)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="subtle">A report is approved by an owner or admin from a frozen snapshot. The answers it scores were imported by the customer, so it does not prove which model produced them.</p>
    </section>
  );
}

function Capital({ capital }) {
  const head = <div className="card-head"><h2 id="capital-title">Capital</h2>{capital.available && <span className="subtle">{plural(capital.cases.length, 'case')}</span>}</div>;
  if (!capital.available) {
    return <section id="capital" className="card card--pad" aria-labelledby="capital-title">{head}<p className="subtle">{capital.reason === 'organization_only' ? 'Capital applies to organization workspaces only.' : "This server's store does not expose capital cases."}</p></section>;
  }
  return (
    <section id="capital" className="card card--pad" aria-labelledby="capital-title">
      {head}
      {capital.cases.length === 0 ? <p className="subtle">No financing case has been drafted.</p> : (
        <ul className="runs">
          {capital.cases.map((c) => (
            <li key={c.id}>
              <div className="cell-stack">
                <span className="strong">Case · revision {c.revision}{c.submittedRevision ? ` · revision ${c.submittedRevision} sent` : ''}</span>
                <span className="subtle">
                  {c.requestedAmountCents == null ? 'No amount requested yet' : `Requested ${formatCents(c.requestedAmountCents)}`}
                  {c.costItems == null ? '' : ` · ${plural(c.costItems, 'cost item')}`}
                  {` · updated ${formatTime(c.updatedAt)}`}
                </span>
                {costTotalLines(c.totals).length > 0 && (
                  <ul className="subtle" aria-label="Planned cost totals by basis and period" style={{ margin: 0, paddingLeft: 18 }}>
                    {costTotalLines(c.totals).map((line) => <li key={`${line.basis}-${line.period}`}>{line.label}</li>)}
                  </ul>
                )}
              </div>
              <span className="pill pill--plain">{CASE_STATUS[c.status] ?? humanize(c.status)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="subtle">Planning totals as the customer entered them, kept apart by basis and period: one-time, monthly and annual amounts are not added together. Statuses end at Valcairn's internal review: no lender, offer, funding or provider result exists.</p>
    </section>
  );
}

function Activity({ activity }) {
  if (activity.available === false) return <section id="activity" className="card" aria-labelledby="activity-title"><div className="card-head"><h2 id="activity-title">Recent activity</h2></div><Empty>This server's store does not expose the audit log.</Empty></section>;
  return (
    <section id="activity" className="card card--table" aria-labelledby="activity-title">
      <div className="card-head"><h2 id="activity-title">Recent activity</h2><span className="subtle">Latest {activity.limit} recorded actions</span></div>
      {activity.items.length === 0 ? <Empty>Nothing has been recorded in this workspace yet.</Empty> : (
        <div className="table-scroll">
          <table className="table-compact">
            <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">On</th></tr></thead>
            <tbody>
              {activity.items.map((a, i) => (
                <tr key={`${a.at}-${a.action}-${i}`}>
                  <td className="subtle">{formatTime(a.at)}</td>
                  <td>{humanize(a.action)}</td>
                  <td className="subtle">{humanize(a.targetType) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const EVENT_LABELS = { signin: 'Signed in', signout: 'Signed out', failed: 'Failed attempt' };

// Admin-only: who has signed in. The server refuses this data to non-admin accounts.
function AccessLog() {
  const [state, setState] = useState({ status: 'loading', events: [] });
  useEffect(() => {
    let live = true;
    fetch('/api/admin/signins', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(({ events }) => live && setState({ status: 'ready', events }))
      .catch(() => live && setState({ status: 'error', events: [] }));
    return () => { live = false; };
  }, []);

  return (
    <section id="access-log" className="card card--table" aria-labelledby="access-title">
      <div className="card-head">
        <h2 id="access-title">Sign-in log</h2>
        <span className="subtle">Visible to admins only</span>
      </div>
      {state.status === 'loading' && <p className="card-foot subtle" role="status">Loading…</p>}
      {state.status === 'error' && <p className="card-foot tone-warn" role="alert">The sign-in log could not be loaded.</p>}
      {state.status === 'ready' && (
        <div className="table-scroll">
          <table className="table-compact">
            <thead><tr><th scope="col">When</th><th scope="col">Account</th><th scope="col">Event</th></tr></thead>
            <tbody>
              {state.events.map((e) => (
                <tr key={`${e.at}-${e.event}-${e.username}`}>
                  <td className="subtle">{formatTime(e.at)}</td>
                  <td>{e.username ?? <span className="subtle">unknown username</span>}</td>
                  <td className={e.event === 'failed' ? 'tone-warn' : 'tone-plain'}>{EVENT_LABELS[e.event] ?? e.event}</td>
                </tr>
              ))}
              {state.events.length === 0 && <tr><td colSpan={3} className="subtle">No sign-ins recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Whether this browser also holds a normal workspace account that is a member of the pinned workspace. The reviewer
 * login never is one. GET /api/account only ever describes the caller's own session, so nothing about other
 * accounts is read here.
 */
function useOwnMembership(workspaceId) {
  const [entry, setEntry] = useState(null);
  useEffect(() => {
    if (!workspaceId) return undefined;
    let live = true;
    api.account()
      .then((account) => live && setEntry(account.workspaces?.find((w) => w.id === workspaceId) ?? null))
      .catch(() => live && setEntry(null));
    return () => { live = false; };
  }, [workspaceId]);
  return entry;
}

function WorkingAppAccess({ workspaceId }) {
  const entry = useOwnMembership(workspaceId);
  if (entry) {
    return <Link className="btn-solid-app" to={`/w/${entry.slug}`}>Open this workspace as {roleName(entry.role)} <Icon name="arrow" size={16} /></Link>;
  }
  return (
    <p className="subtle" style={{ flex: '1 1 320px', maxWidth: 420 }}>
      This view is read-only. The working app needs a separate workspace account that is a member of this workspace; the reviewer login does not open it. Someone with owner credentials can use <Link to="/signin">workspace sign-in</Link>.
    </p>
  );
}

export default function Dashboard({ reviewer }) {
  const navigate = useNavigate();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [state, dispatch] = useReducer(reduceOverview, initialOverviewState);
  const busy = state.status === 'loading' || state.status === 'refreshing';

  // One loader per mount: only the newest request's response is applied, and nothing after unmount (see
  // createOverviewLoader). StrictMode's rehearsal mount gets its own loader, which is stopped before the real one starts.
  const loader = useRef(null);
  useEffect(() => {
    const current = createOverviewLoader({ fetch: api.demoOverview, apply: dispatch });
    loader.current = current;
    current.load();
    return () => { current.stop(); if (loader.current === current) loader.current = null; };
  }, []);
  const load = () => loader.current?.load();
  // A 401 here means the reviewer account was disabled or the session ended: back to the sign-in page.
  useEffect(() => { if (state.status === 'signed_out') navigate('/demo'); }, [state.status, navigate]);

  // Only leave the dashboard once the server has ended the session.
  async function signOut() {
    const res = await api.logout().catch(() => null);
    if (res?.ok) return navigate('/demo');
    setSignOutFailed(true);
  }

  const overview = state.overview;
  return (
    <div className="dash">
      <title>Live overview — Valcairn reviewer demo</title>
      <Sidebar admin={reviewer.role === 'admin'} />
      <div className="dash-body">
        <header className="dash-top">
          <div className="row-wrap gap-10">
            <span className="org">{overview ? overview.workspace.name : 'Reviewer demo'}</span>
            <span className="chip">{overview ? 'Synthetic workspace · actual records' : 'Reviewer view'}</span>
          </div>
          <div className="dash-tools">
            <span className="subtle" role="status" style={{ flex: '1 1 auto' }}>
              {busy ? (state.overview ? 'Refreshing…' : 'Loading the live overview…') : state.fetchedAt ? `Fetched ${formatTime(state.fetchedAt)}` : ''}
            </span>
            <button type="button" className="btn-small" onClick={load} disabled={busy} aria-busy={busy || undefined}>Refresh</button>
            <ThemeToggle />
            <span className="avatar" title={reviewer.username} aria-hidden="true">{initials(reviewer.name)}</span>
            <span className="visually-hidden">Signed in as {reviewer.name}</span>
            <button type="button" className="btn-small" onClick={signOut}>Sign out</button>
            {signOutFailed && <span className="tone-warn" role="alert">Sign-out failed. Please try again.</span>}
          </div>
        </header>

        <main id="overview" className="dash-main">
          <section className="dash-heading row-between row-wrap">
            <div className="cell-stack" style={{ flex: '1 1 460px' }}>
              <h1>Live overview</h1>
              <p className="subtle">What the server has recorded for one synthetic demo workspace. Its inputs are generated samples; the projects, reviews, dataset versions, jobs, evaluation reports and capital cases below are the stored records themselves, not illustrations, and a seeded fixture shows up as exactly what the seed recorded. Refresh to see new actions. Hosted GPU scheduling, charges, cloud deployment and financing are planned and have no records to show.</p>
            </div>
            {overview && <WorkingAppAccess workspaceId={overview.workspace.id} />}
          </section>

          {state.status === 'stale' && (
            <p className="ob-alert" role="alert">The latest refresh failed ({state.problem.message}). Showing the records fetched {formatTime(state.fetchedAt)}; they may be out of date.</p>
          )}
          {state.status === 'loading' && <p className="subtle" role="status">Loading the live overview…</p>}
          {state.status === 'error' && (
            <section className="card card--pad" aria-labelledby="error-title">
              <h2 id="error-title">The overview could not be loaded</h2>
              <p className="tone-warn" role="alert">{state.problem.message}</p>
              <div><button type="button" className="btn-small" onClick={load}>Try again</button></div>
            </section>
          )}
          {state.status === 'unavailable' && (
            <section className="card card--pad" aria-labelledby="unavailable-title">
              <h2 id="unavailable-title">No live records are available</h2>
              <p className="body-2" role="status">{UNAVAILABLE_HELP[state.problem.code] ?? state.problem.message}</p>
              <p className="subtle">This page never shows sample figures in place of records. Ask the Valcairn team to pin the synthetic demo workspace, then refresh.</p>
            </section>
          )}

          {overview && (
            <>
              <Projects projects={overview.projects} />
              <div className="dash-grid">
                <Compute compute={overview.compute} />
                <Evaluation evaluation={overview.evaluation} projects={overview.projects} />
                <Capital capital={overview.capital} />
              </div>
              <Activity activity={overview.activity} />
            </>
          )}

          {reviewer.role === 'admin' && <AccessLog />}
        </main>
      </div>
    </div>
  );
}
