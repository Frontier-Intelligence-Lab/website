import { useEffect, useRef, useState } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { requireWorkspace } from './ui.jsx';
import { WorkspaceShell } from './shell.jsx';
import { PLANNED, SYNTHETIC_CASES, SYNTHETIC_PREDICTIONS } from '../../../src/lib/eval-shared.js';
import { ImportTriage, RunPair } from './triage.jsx';
import { CaseForm, caseEditForScope } from './eval-case-form.jsx';

const TABS = [['cases', 'Cases'], ['quality', 'Quality'], ['comparisons', 'Comparisons']];
const PURPOSES = [['development', 'Development'], ['final_assessment', 'Final assessment']];
const BASES = [
  ['human_else_auto', 'Human review, or exact match where nobody has reviewed'],
  ['human_only', 'Human review only'],
  ['auto_exact', 'Normalized exact match'],
];
const DECISIONS = [['', 'No decision yet'], ['pass', 'Pass'], ['fail', 'Fail'], ['insufficient', 'Insufficient evidence']];
const ADJUDICATIONS = [['', 'Not adjudicated'], ['human', 'Keep the human decision'], ['automatic', 'Keep the exact match']];
const failed = (res) => res?.data?.error ?? 'That did not work. Check your connection and try again.';
const pct = (value) => `${Math.round(value * 1000) / 10}%`;

async function workspaceProject(params) {
  const { account, entry } = await requireWorkspace(params.slug);
  const { project } = await api.project(entry.id, params.projectId);
  return { account, entry, project };
}
export async function evalHomeLoader({ params }) {
  const base = await workspaceProject(params);
  return { ...base, ...(await api.evaluations(base.entry.id, params.projectId)) };
}
export async function evalSetLoader({ params }) {
  const base = await workspaceProject(params);
  const detail = await api.evaluation(base.entry.id, params.projectId, params.setId);
  const caseRuns = [];
  for (const version of detail.versions ?? []) {
    const listed = await api.caseRuns(base.entry.id, params.projectId, params.setId, version.id);
    for (const run of listed.runs ?? []) caseRuns.push(run);
  }
  return { ...base, ...detail, caseRuns };
}
export async function evalReviewLoader({ params }) {
  const base = await workspaceProject(params);
  return { ...base, ...(await api.evalComparison(base.entry.id, params.projectId, params.comparisonId)) };
}
export async function evalReportLoader({ params }) {
  const base = await workspaceProject(params);
  return { ...base, ...(await api.evalReport(base.entry.id, params.projectId, params.reportId)) };
}

function Banner({ status, error, onRetry }) {
  return (
    <>
      <p className="ob-muted" aria-live="polite">{status}</p>
      {error && (
        <p className="ob-alert" role="alert">
          {error}{' '}
          {onRetry && <button type="button" className="btn-text" onClick={onRetry}>Try again</button>}
        </p>
      )}
    </>
  );
}

function Planned() {
  return (
    <section className="ob-card" aria-labelledby="eval-planned">
      <h2 id="eval-planned">Planned</h2>
      <ul className="ob-list">
        {PLANNED.map((item) => (
          <li key={item}><span className="ob-badge">Planned</span><div><span className="ob-muted">{item}</span></div></li>
        ))}
      </ul>
    </section>
  );
}

function Summary({ summary }) {
  if (!summary) return null;
  const { counts } = summary;
  const cards = [
    ['Eligible', counts.eligible],
    ['Candidate submitted', counts.candidate.submitted],
    ['Candidate missing', counts.candidate.missing],
    ['Candidate run errors', counts.candidate.failed],
    ['Reviewed', counts.reviewed],
    ['Unreviewed', counts.unreviewed],
  ];
  return (
    <div>
      <div className="eval-kpis">
        {cards.map(([label, value]) => <div key={label} className="ob-card"><span className="ob-muted">{label}</span><strong>{value}</strong></div>)}
      </div>
      <p>Pass rate {summary.counts.passes} of {counts.eligible} eligible cases ({pct(summary.passRate)}). Denominator: {summary.denominator}. Coverage {summary.coverage.covered} of {summary.coverage.eligible}.</p>
      <p><strong>{summary.decision.result === 'insufficient_evidence' ? 'Insufficient evidence' : summary.decision.result === 'pass' ? 'Pass' : 'Fail'}.</strong> {summary.decision.reasons.join(' ')}</p>
      <p>Improvements: {summary.improvements.length ? summary.improvements.join(', ') : 'none'}. Regressions: {summary.regressions.length ? summary.regressions.join(', ') : 'none'}.</p>
      {summary.criticalFailures.length > 0 && (
        <p>Critical failures, kept apart from the average: {summary.criticalFailures.map((row) => `${row.caseKey} (${row.outcome})`).join(', ')}.</p>
      )}
      <div className="ob-table-wrap">
        <table>
          <caption>Results by category and severity. Each row’s n is the eligible count in that group.</caption>
          <thead><tr><th>Group</th><th>n</th><th>Pass</th><th>Fail</th><th>Missing</th><th>Error</th><th>Unreviewed</th><th>Disagreement</th></tr></thead>
          <tbody>
            {[...summary.byCategory, ...summary.bySeverity].map((row) => (
              <tr key={`${row.category ?? row.severity}`}>
                <td>{row.category ?? row.severity}</td><td>{row.eligible}</td><td>{row.pass}</td><td>{row.fail}</td><td>{row.missing}</td><td>{row.error}</td><td>{row.unreviewed}</td><td>{row.disagreement}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.wilson95 ? (
        <p>Wilson 95% interval on {summary.wilson95.n} decisive cases: {pct(summary.wilson95.low)} to {pct(summary.wilson95.high)}. {summary.wilson95.assumptions.join(' ')}</p>
      ) : <p>No Wilson interval: fewer than two decisive pass or fail cases. The interval would not decide the result anyway.</p>}
    </div>
  );
}

export function EvalHome() {
  const data = useLoaderData();
  const revalidator = useRevalidator();
  const { account, entry, project, sets, canWrite } = data;
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('development');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const base = `/w/${entry.slug}/projects/${project.id}/evaluate`;

  async function create(event) {
    event.preventDefault();
    setPending(true); setError(null); setStatus('Saving the evaluation set…');
    const res = await api.createEvaluation(entry.id, project.id, { name, purpose }).catch(() => null);
    setPending(false);
    if (!res?.ok) { setStatus(''); setError(failed(res)); return; }
    setName(''); setStatus('Evaluation set saved.'); revalidator.revalidate();
  }

  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Evaluate" project={project} current="evaluate">
      <div className="ob-intro">
        <Link className="ob-muted" to={`/w/${entry.slug}/projects/${project.id}`}>← {project.name}</Link>
        <h1 className="ob-h1">Evaluate answers</h1>
        <p>Import the answers you already have, connect failures to the frozen source, and approve a report. Valcairn does not call your model. A development or final-assessment label is not a claim that the set is secret or leakage-free.</p>
      </div>
      <Banner status={status} error={error} onRetry={() => revalidator.revalidate()} />
      {!canWrite && <p className="ob-alert ob-alert--info">You can view evaluations. Your role cannot create or edit them.</p>}
      {sets.length === 0 && <p className="ob-card">No evaluation sets yet. Add the questions your assistant is supposed to answer.</p>}
      <ul className="ob-list">
        {sets.map((set) => (
          <li key={set.id}>
            <div>
              <Link to={`${base}/${set.id}`}><strong>{set.name}</strong></Link>
              <span className="ob-muted">{PURPOSES.find(([id]) => id === set.purpose)?.[1]} · {set.status} · {set.caseCount} cases · revision {set.revision}</span>
            </div>
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="ob-card" onSubmit={create} aria-busy={pending}>
          <h2>New evaluation set</h2>
          <div className="ob-field"><label htmlFor="eval-name">Name</label><input id="eval-name" value={name} maxLength={120} required disabled={pending} onChange={(e) => setName(e.target.value)} /></div>
          <div className="ob-field">
            <label htmlFor="eval-purpose">Purpose</label>
            <select id="eval-purpose" value={purpose} disabled={pending} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <span className="ob-muted">This label does not make the set a secret holdout.</span>
          </div>
          <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Create set'}</button>
        </form>
      )}
      <Planned />
    </WorkspaceShell>
  );
}

function Tabs({ tab, onTab, openIssues, disabled = false }) {
  const refs = useRef([]);
  function move(event) {
    if (disabled) return;
    const index = TABS.findIndex(([id]) => id === tab);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index + TABS.length - 1) % TABS.length;
    onTab(TABS[next][0]);
    refs.current[next]?.focus();
  }
  return (
    <div className="eval-tabs" role="tablist" aria-label="Evaluation sections" onKeyDown={move}>
      {TABS.map(([id, label], index) => (
        <button key={id} type="button" role="tab" id={`eval-tab-${id}`} aria-selected={tab === id} aria-controls={`eval-panel-${id}`} tabIndex={tab === id ? 0 : -1} disabled={disabled} ref={(node) => { refs.current[index] = node; }} onClick={() => onTab(id)}>
          {label}{id === 'quality' && openIssues > 0 ? ` (${openIssues} open)` : ''}
        </button>
      ))}
    </div>
  );
}

export function EvalSet() {
  const data = useLoaderData();
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([id]) => id === params.get('tab')) ? params.get('tab') : 'cases';
  const { account, entry, project, set, cases, issues, counts, sources, versions, comparisons, reports, caseRuns = [], canWrite, canApprove } = data;
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [jsonl, setJsonl] = useState('');
  const [predictions, setPredictions] = useState('');
  const [editing, setEditing] = useState(null);
  const openIssues = issues.filter((issue) => issue.open).length;
  const draft = set.status === 'draft';
  const base = `/w/${entry.slug}/projects/${project.id}/evaluate/${set.id}`;
  const testingSources = sources.filter((source) => source.testing);
  // A rule edit must wait while a save is pending or the loader is refreshing: the rule form is keyed by set.revision,
  // so a newer revision remounts it and would discard anything typed in between.
  const busy = pending || revalidator.state !== 'idle';
  const activeEditing = caseEditForScope(editing, { workspaceId: entry.id, projectId: project.id, setId: set.id, canWrite, draft });
  // Reset an invalid selection during render: no old row reaches a new route's first paint or revives on return.
  if (editing && !activeEditing) setEditing(null);
  const otherActionBusy = busy || Boolean(activeEditing);

  async function act(fn, pendingLabel, doneLabel) {
    setPending(true); setError(null); setStatus(pendingLabel);
    const res = await fn().catch(() => null);
    if (!res?.ok) { setPending(false); setStatus(''); setError(failed(res)); return null; }
    setStatus(doneLabel);
    await revalidator.revalidate();
    setPending(false);
    return res.data;
  }
  const setTab = (id) => setParams({ tab: id });
  function editCase(row) {
    if (!canWrite || !draft || otherActionBusy) return;
    setEditing({ workspaceId: entry.id, projectId: project.id, setId: set.id, row, revision: set.revision });
    setTab('cases');
  }
  function fixIssue(issue) {
    const row = issue.caseKeys.length === 1 ? cases.find((item) => item.caseKey === issue.caseKeys[0]) : null;
    if (row && canWrite && draft) editCase(row);
    else setTab('cases');
  }

  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title={set.name} project={project} current="evaluate">
      <div className="ob-intro">
        <Link className="ob-muted" to={`/w/${entry.slug}/projects/${project.id}/evaluate`}>← Evaluation sets</Link>
        <h1 className="ob-h1">{set.name}</h1>
        <p>{PURPOSES.find(([id]) => id === set.purpose)?.[1]} · {set.status} · revision {set.revision} · {counts.cases} cases. {counts.categories.map((row) => `${row.category} ${row.cases}`).join(', ') || 'No category counts yet.'}</p>
      </div>
      <Banner status={status} error={error} onRetry={() => revalidator.revalidate()} />
      {!canWrite && <p className="ob-alert ob-alert--info">You can view this set. Your role cannot change it.</p>}
      <Tabs tab={tab} onTab={setTab} openIssues={openIssues} disabled={otherActionBusy} />

      {tab === 'cases' && (
        <div role="tabpanel" id="eval-panel-cases" aria-labelledby="eval-tab-cases" className="eval-stack">
          {cases.length === 0 && <p className="ob-card">No cases yet. Add one, or paste JSONL. A failed import keeps what you typed and saves nothing.</p>}
          <ul className="ob-list">
            {cases.map((row) => (
              <li key={row.id} id={`case-${row.caseKey}`}>
                <div>
                  <strong>{row.caseKey}</strong>
                  <span className="ob-muted">{row.severity ?? 'no severity'} · {row.category ?? 'no category'}</span>
                  <span>{row.input}</span>
                  <span className="ob-muted">Expected: {row.expectedAnswer ?? 'none'} · Criteria: {row.reviewCriteria ?? 'none'}</span>
                </div>
                {canWrite && draft && <div className="ob-row-actions">
                  <button type="button" className="btn-text" disabled={otherActionBusy} onClick={() => editCase(row)} aria-label={`Edit case ${row.caseKey}`}>Edit</button>
                  <button type="button" className="btn-text" disabled={otherActionBusy} onClick={() => act(() => api.deleteEvalCase(entry.id, project.id, set.id, row.id, set.revision), 'Removing the case…', 'Case removed.')}>Delete</button>
                </div>}
              </li>
            ))}
          </ul>
          {canWrite && draft && <CaseForm key={`${set.id}:${activeEditing?.row.id ?? 'new'}`} entry={entry} project={project} set={set} sources={testingSources} row={activeEditing?.row} expectedRevision={activeEditing?.revision ?? set.revision} pending={busy} act={act} onDone={() => setEditing(null)} />}
          {canWrite && draft && (
            <form className="ob-card" onSubmit={(event) => { event.preventDefault(); act(() => api.importEvalCases(entry.id, project.id, set.id, set.revision, jsonl), 'Checking the import…', 'Import saved.'); }}>
              <h2>Import JSONL</h2>
              <label htmlFor="case-jsonl">Cases, one JSON object per line</label>
              <textarea id="case-jsonl" value={jsonl} disabled={otherActionBusy} onChange={(e) => setJsonl(e.target.value)} rows={6} spellCheck="false" />
              <details>
                <summary>Synthetic example (not evidence of a real model)</summary>
                <pre className="eval-pre">{SYNTHETIC_CASES}</pre>
                <p className="ob-muted">The source ids are placeholders. Replace them with a frozen version that allows testing, or the quality check will reject the sources. Nothing in this example was produced by a customer model.</p>
              </details>
              <button className="btn-app" type="submit" disabled={otherActionBusy || !jsonl.trim()}>{pending ? 'Saving…' : 'Import cases'}</button>
            </form>
          )}
          <Acceptance key={set.revision} rule={set.acceptance} locked={!canWrite || !draft || Boolean(activeEditing)} pending={pending} busy={busy} onSave={(acceptance) => act(() => api.updateEvaluation(entry.id, project.id, set.id, { expectedRevision: set.revision, acceptance }), 'Saving the rule…', 'Rule saved.')} />
          <div className="ob-row-actions">
            {canApprove && draft && <button type="button" className="btn-app" disabled={otherActionBusy} onClick={() => act(() => api.freezeEvaluation(entry.id, project.id, set.id, set.revision), 'Freezing this revision…', 'Set frozen.')}>Freeze this revision</button>}
            {canWrite && !draft && <button type="button" className="btn-ghost" disabled={pending} onClick={() => act(() => api.reopenEvaluation(entry.id, project.id, set.id), 'Starting a new draft…', 'New draft started. The frozen version was not changed.')}>Start a new draft</button>}
            {!canApprove && draft && <p className="ob-muted">An owner or admin freezes the set. Freezing copies this revision; it does not change older versions.</p>}
          </div>
          {versions.length > 0 && <p className="ob-muted">Frozen versions: {versions.map((version) => `v${version.number} (${version.cases.length} cases)`).join(', ')}. Reopening does not rewrite them.</p>}
        </div>
      )}

      {tab === 'quality' && (
        <div role="tabpanel" id="eval-panel-quality" aria-labelledby="eval-tab-quality" className="eval-stack">
          {issues.length === 0 && <p className="ob-card">No quality findings. Semantic near-duplicates and document-truth checks are planned, so a clear list is not a claim that the set is complete.</p>}
          <ul className="ob-list">
            {issues.map((issue) => (
              <li key={issue.key}>
                <div>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                  <span className="ob-muted">{issue.open ? 'Open' : 'Acknowledged'} · {issue.caseKeys.join(', ')}</span>
                  {issue.note && <span className="ob-muted">Note: {issue.note}</span>}
                  <button type="button" className="btn-text" disabled={otherActionBusy} onClick={() => fixIssue(issue)}>{issue.fix.label}</button>
                </div>
                {canWrite && draft && issue.acknowledgeable && issue.open && <Ack entry={entry} project={project} set={set} issue={issue} act={act} pending={pending} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'comparisons' && (
        <div role="tabpanel" id="eval-panel-comparisons" aria-labelledby="eval-tab-comparisons" className="eval-stack">
          {versions.length === 0 && <p className="ob-card">Freeze the set before importing answers. Imports attach to that frozen version, not to the editable draft.</p>}
          {versions.map((version) => (
            <section key={version.id} className="ob-card">
              <h2>Version {version.number}</h2>
              <p className="ob-muted">{version.batches.length} imported file{version.batches.length === 1 ? '' : 's'}. An import is a customer-supplied result, not proof of which model ran.</p>
              <ul>{version.batches.map((batch) => <li key={batch.id}>{batch.role}: {batch.label} · {batch.provenance?.rowCount ?? 0} rows · {batch.claimedSystem?.identity ?? 'no system name claimed'}</li>)}</ul>
              {canWrite && (
                <PredictionForm entry={entry} project={project} set={set} version={version} text={predictions} setText={setPredictions} pending={pending} act={act} />
              )}
              {canWrite && <CompareForm entry={entry} project={project} set={set} version={version} pending={pending} act={act} />}
              <RunPair entry={entry} project={project} set={set} version={version} runs={caseRuns.filter((run) => run.versionId === version.id)} />
            </section>
          ))}
          <ul className="ob-list">
            {comparisons.map((comparison) => {
              const report = reports.find((item) => item.comparisonId === comparison.id);
              return (
                <li key={comparison.id}>
                  <div>
                    <Link to={`${base}/review/${comparison.id}`}><strong>Review comparison</strong></Link>
                    <span className="ob-muted">Imported answers · revision {comparison.revision}{comparison.blind?.hideIdentity ? ' · identities hidden on the review screen' : ''}</span>
                    {report && <Link to={`${base}/reports/${report.id}`}>Report: {report.decision}</Link>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </WorkspaceShell>
  );
}

function Acceptance({ rule, locked, pending, busy, onSave }) {
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      version: 1,
      scoreBasis: form.get('scoreBasis'),
      minPassRate: Number(form.get('minPassRate')),
      minCoverage: Number(form.get('minCoverage')),
      criticalMustPass: form.get('criticalMustPass') === 'on',
      requireHumanOnCritical: form.get('requireHumanOnCritical') === 'on',
      requireHumanOnDisagreement: form.get('requireHumanOnDisagreement') === 'on',
      requireHumanWhenNoExpectedAnswer: form.get('requireHumanWhenNoExpectedAnswer') === 'on',
    });
  }
  return (
    <form className="ob-card" onSubmit={submit} aria-busy={busy}>
      <h2>Acceptance rule</h2>
      <p className="ob-muted">This is the rule the report uses. The sentence on the project is not executed. Exact match is not semantic correctness.</p>
      {/* One fieldset disables every control while the rule is locked, a save is pending or the loader is refreshing.
          `.ob fieldset` resets its box; the flex column keeps the card's spacing between the fields. */}
      <fieldset disabled={locked || busy} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="ob-field">
          <label htmlFor="score-basis">How a case counts</label>
          <select id="score-basis" name="scoreBasis" defaultValue={rule.scoreBasis}>
            {BASES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <div className="eval-grid">
          <div className="ob-field"><label htmlFor="min-pass">Minimum pass rate</label><input id="min-pass" name="minPassRate" inputMode="decimal" defaultValue={rule.minPassRate} /></div>
          <div className="ob-field"><label htmlFor="min-cover">Minimum coverage</label><input id="min-cover" name="minCoverage" inputMode="decimal" defaultValue={rule.minCoverage} /></div>
        </div>
        {[['criticalMustPass', 'Critical cases must pass'], ['requireHumanOnCritical', 'A person must review critical cases'], ['requireHumanOnDisagreement', 'A disagreement stays unresolved until someone adjudicates it'], ['requireHumanWhenNoExpectedAnswer', 'A case with no expected answer needs a person']].map(([key, label]) => (
          <label key={key} className="ob-option ob-option--row"><input type="checkbox" name={key} defaultChecked={rule[key] === true} />{label}</label>
        ))}
        {!locked && <button className="btn-ghost" type="submit">{pending ? 'Saving…' : 'Save rule'}</button>}
      </fieldset>
    </form>
  );
}

function Ack({ entry, project, set, issue, act, pending }) {
  const [note, setNote] = useState('');
  return (
    <form onSubmit={(event) => { event.preventDefault(); act(() => api.noteEvalIssue(entry.id, project.id, set.id, { expectedRevision: set.revision, key: issue.key, note }), 'Saving the note…', 'Conflict acknowledged. The cases were not changed.'); }}>
      <label htmlFor={`note-${issue.key}`}>Acknowledgement</label>
      <textarea id={`note-${issue.key}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      <button className="btn-ghost" type="submit" disabled={pending || !note.trim()}>Acknowledge suspected conflict</button>
    </form>
  );
}

function PredictionForm({ entry, project, set, version, text, setText, pending, act }) {
  const [role, setRole] = useState('baseline');
  const [label, setLabel] = useState('');
  const [identity, setIdentity] = useState('');
  const [configuration, setConfiguration] = useState('');
  const [scorer, setScorer] = useState('');
  return (
    <form onSubmit={(event) => { event.preventDefault(); act(() => api.importEvalPredictions(entry.id, project.id, set.id, version.id, { role, label, claimedSystem: { identity, configuration }, claimedScorer: scorer, filename: 'pasted.jsonl', jsonl: text }), 'Checking the prediction import…', 'Predictions saved. Missing cases stay missing.'); }}>
      <h3>Import predictions</h3>
      <div className="eval-grid">
        <div className="ob-field"><label htmlFor={`role-${version.id}`}>Baseline or candidate</label><select id={`role-${version.id}`} value={role} onChange={(e) => setRole(e.target.value)}><option value="baseline">Baseline</option><option value="candidate">Candidate</option></select></div>
        <div className="ob-field"><label htmlFor={`label-${version.id}`}>Label</label><input id={`label-${version.id}`} value={label} required onChange={(e) => setLabel(e.target.value)} /></div>
      </div>
      <div className="ob-field"><label htmlFor={`identity-${version.id}`}>Claimed system name</label><input id={`identity-${version.id}`} value={identity} onChange={(e) => setIdentity(e.target.value)} /><span className="ob-muted">This is what you claim. It is not verified.</span></div>
      <div className="ob-field"><label htmlFor={`config-${version.id}`}>Claimed configuration</label><input id={`config-${version.id}`} value={configuration} onChange={(e) => setConfiguration(e.target.value)} /></div>
      <div className="ob-field"><label htmlFor={`scorer-${version.id}`}>Claimed scorer version</label><input id={`scorer-${version.id}`} value={scorer} onChange={(e) => setScorer(e.target.value)} /></div>
      <label htmlFor={`pred-${version.id}`}>Prediction JSONL</label>
      <textarea id={`pred-${version.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck="false" />
      <details><summary>Synthetic prediction example</summary><pre className="eval-pre">{SYNTHETIC_PREDICTIONS}</pre></details>
      <button className="btn-app" type="submit" disabled={pending || !text.trim() || !label.trim()}>{pending ? 'Saving…' : 'Import predictions'}</button>
    </form>
  );
}

function CompareForm({ entry, project, set, version, pending, act }) {
  const baselines = version.batches.filter((batch) => batch.role === 'baseline');
  const candidates = version.batches.filter((batch) => batch.role === 'candidate');
  const [baselinePick, setBaseline] = useState('');
  const [candidatePick, setCandidate] = useState('');
  const baselineBatchId = baselines.some((batch) => batch.id === baselinePick) ? baselinePick : (baselines[0]?.id ?? '');
  const candidateBatchId = candidates.some((batch) => batch.id === candidatePick) ? candidatePick : (candidates[0]?.id ?? '');
  if (!baselines.length || !candidates.length) return <p className="ob-muted">Import a baseline and a candidate for this version before comparing.</p>;
  return (
    <form onSubmit={(event) => { event.preventDefault(); act(() => api.createEvalComparison(entry.id, project.id, set.id, { versionId: version.id, baselineBatchId, candidateBatchId }), 'Creating the comparison…', 'Comparison ready.'); }}>
      <div className="eval-grid">
        <div className="ob-field"><label htmlFor={`base-${version.id}`}>Baseline import</label><select id={`base-${version.id}`} value={baselineBatchId} onChange={(e) => setBaseline(e.target.value)}>{baselines.map((batch) => <option key={batch.id} value={batch.id}>{batch.label}</option>)}</select></div>
        <div className="ob-field"><label htmlFor={`cand-${version.id}`}>Candidate import</label><select id={`cand-${version.id}`} value={candidateBatchId} onChange={(e) => setCandidate(e.target.value)}>{candidates.map((batch) => <option key={batch.id} value={batch.id}>{batch.label}</option>)}</select></div>
      </div>
      <button className="btn-ghost" type="submit" disabled={pending}>Compare these imports</button>
    </form>
  );
}

function Side({ title, side, hidden, values, setValues, prefix }) {
  const auto = side.auto?.result === 'pass' || side.auto?.result === 'fail'
    ? `Normalized exact match: ${side.auto.result}${side.auto.tokenOverlap == null ? '' : ` (token overlap ${Math.round(side.auto.tokenOverlap * 100)}%, diagnostic only)`}`
    : `Automatic result: ${side.auto?.result ?? 'none'}. Exact match is not a semantic judgment.`;
  return (
    <div className="ob-card">
      <h3>{title}</h3>
      <p>Status: {side.status}{side.error ? ` (${side.error})` : ''}</p>
      <p className="eval-pre">{side.output ?? (side.status === 'missing' ? 'No imported answer for this case.' : 'No answer text.')}</p>
      <p className="ob-muted">{auto}</p>
      <label htmlFor={`${prefix}-decision`}>Your decision</label>
      <select id={`${prefix}-decision`} value={values.decision} onChange={(e) => setValues({ ...values, decision: e.target.value })}>
        {DECISIONS.map(([id, label]) => <option key={id || 'none'} value={id}>{label}</option>)}
      </select>
      {side.disagreement && (
        <>
          <label htmlFor={`${prefix}-adj`}>Adjudication</label>
          <select id={`${prefix}-adj`} value={values.adjudication} onChange={(e) => setValues({ ...values, adjudication: e.target.value })}>
            {ADJUDICATIONS.map(([id, label]) => <option key={id || 'none'} value={id}>{label}</option>)}
          </select>
          <p className="ob-muted">The {hidden ? 'side' : 'system'} disagrees with the exact match. Both stay on record.</p>
        </>
      )}
    </div>
  );
}

export function EvalReview() {
  const data = useLoaderData();
  const revalidator = useRevalidator();
  const { account, entry, project, comparison, version, summary, review, baseline, candidate, canWrite, canApprove } = data;
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  // Unsaved choices, notes and the preview are bound to the comparison revision they were entered under (the revision
  // shown in the heading). Every save, assignment change and approval names that same revision; nothing advances it
  // behind the person's back, and a draft entered under another revision is never read, shown or submitted.
  const key = `${comparison.id}:${comparison.revision}`;
  const empty = () => ({ key, sides: {}, notes: {}, preview: null });
  const [draft, setDraft] = useState(empty);
  const { sides, notes, preview } = draft.key === key ? draft : empty();
  const patch = (fields) => setDraft((current) => ({ ...(current.key === key ? current : empty()), ...fields }));
  const setSides = (next) => patch({ sides: next });
  const setNotes = (next) => patch({ notes: next });
  const setPreview = (next) => patch({ preview: next });
  // After this tab's own successful save the next loader revision carries the same assignment, so the draft carries over
  // to exactly that revision. Any other observed revision (another tab, or a change whose reply never arrived) drops it.
  const carryRef = useRef(null);
  useEffect(() => {
    if (draft.key === key) return;
    const carried = carryRef.current === key;
    carryRef.current = null;
    const hadDraft = Object.keys(draft.sides).length > 0 || Object.keys(draft.notes).length > 0 || draft.preview != null;
    setDraft(carried ? { ...draft, key } : empty());
    if (!carried && hadDraft) setStatus(`This comparison moved to revision ${comparison.revision} after those choices were made, for example from another tab or a reply that did not arrive. Unsaved choices, notes and the preview were cleared. Review the current assignment before saving.`);
  }, [key]);
  const hidden = review.hidden;
  // Review controls wait while a save or an assignment change is pending or the loader is refreshing: left and right are
  // view-bound, so a draft choice must not be entered or re-read in the gap before the refreshed assignment is shown.
  const busy = pending || revalidator.state !== 'idle';
  const back = `/w/${entry.slug}/projects/${project.id}/evaluate/${comparison.setId}?tab=comparisons`;

  function valuesFor(row) {
    return sides[row.caseKey] ?? { left: row.left.decision ?? '', right: row.right.decision ?? '', leftAdj: row.left.adjudication ?? '', rightAdj: row.right.adjudication ?? '' };
  }
  async function save(row) {
    const values = valuesFor(row);
    const body = hidden
      ? { leftDecision: values.left || null, rightDecision: values.right || null, leftAdjudication: values.leftAdj || null, rightAdjudication: values.rightAdj || null }
      : { baselineDecision: values.left || null, candidateDecision: values.right || null, adjudicationBaseline: values.leftAdj || null, adjudicationCandidate: values.rightAdj || null };
    setPending(true); setError(null); setStatus('Saving the review…');
    const res = await api.evalJudgment(entry.id, project.id, comparison.id, { expectedRevision: comparison.revision, caseKey: row.caseKey, note: notes[row.caseKey] ?? row.note ?? '', ...body }).catch(() => null);
    if (!res?.ok) { setPending(false); setStatus(''); setError(failed(res)); return; }
    // The saved judgment moves the comparison on without changing the assignment: the other unsaved choices carry over to
    // exactly the revision the server reports, while a preview fetched before it is no longer the decision an approval
    // would freeze, so it is dropped and must be opened again. The server stays authoritative.
    const next = res.data?.comparison?.revision;
    carryRef.current = Number.isInteger(next) ? `${comparison.id}:${next}` : null;
    setPreview(null);
    setStatus('Review saved.');
    await revalidator.revalidate();
    setPending(false);
  }
  async function blind(body, label) {
    setPending(true); setError(null); setStatus(label);
    const res = await api.evalBlind(entry.id, project.id, comparison.id, { expectedRevision: comparison.revision, ...body }).catch(() => null);
    if (!res?.ok) { setPending(false); setStatus(''); setError(failed(res)); return; }
    // The saved assignment changed, so unsaved left/right choices, view-bound notes and the preview would now describe
    // different answers. They are dropped, never remapped or saved; a refused change above keeps them as they were.
    const hadDraft = Object.keys(sides).length > 0 || Object.keys(notes).length > 0 || preview != null;
    carryRef.current = null;
    setDraft(empty());
    setStatus(hadDraft ? 'Assignment saved. Unsaved choices, notes and the preview were cleared because left and right may now be different answers.' : 'Assignment saved.');
    await revalidator.revalidate();
    setPending(false);
  }
  async function reveal() {
    setPending(true); setError(null); setStatus('Loading the decision preview…');
    const res = await api.evalPreview(entry.id, project.id, comparison.id).catch(() => null);
    setPending(false);
    if (!res?.ok) { setStatus(''); setError(failed(res)); return; }
    setPreview(res.data); setStatus('Preview loaded. Approving freezes this decision.');
  }
  async function approve() {
    if (!preview) return;
    setPending(true); setError(null); setStatus('Approving the report…');
    const res = await api.approveEvalReport(entry.id, project.id, comparison.id, { expectedRevision: comparison.revision, contentHash: preview.contentHash }).catch(() => null);
    setPending(false);
    if (!res?.ok) { setStatus(''); setError(failed(res)); return; }
    setStatus('Report approved.');
    window.location.assign(`/w/${entry.slug}/projects/${project.id}/evaluate/${comparison.setId}/reports/${res.data.report.id}`);
  }

  const leftTitle = hidden ? 'Left answer' : `Baseline${baseline ? `: ${baseline.label}` : ''}`;
  const rightTitle = hidden ? 'Right answer' : `Candidate${candidate ? `: ${candidate.label}` : ''}`;
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Review" project={project} current="evaluate">
      <div className="ob-intro">
        <Link className="ob-muted" to={back}>← Comparisons</Link>
        <h1 className="ob-h1">Review</h1>
        <p>Revision {comparison.revision}. {hidden ? 'System names are hidden on this screen. The saved left and right assignment is stored and shown again on the approved report.' : 'System names are visible.'} Normalized exact match is not semantic correctness.</p>
      </div>
      <Banner status={status} error={error} onRetry={() => revalidator.revalidate()} />
      <ImportTriage review={review} summary={summary} baseline={baseline} candidate={candidate} version={version} acceptance={comparison.acceptance} />
      <Summary summary={summary} />
      {canWrite && (
        <div className="ob-row-actions">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => blind({ hideIdentity: !hidden, swap: false }, 'Saving the review mode…')}>{hidden ? 'Show system names' : 'Hide system names'}</button>
          <button type="button" className="btn-ghost" disabled={busy || !hidden} onClick={() => blind({ hideIdentity: true, randomize: true }, 'Randomizing left and right…')}>Randomize left and right</button>
        </div>
      )}
      {review.cases.map((row) => {
        const values = valuesFor(row);
        return (
          <article key={row.caseKey} id={`review-${row.caseKey}`} className="ob-card">
            <h2>{row.caseKey}{row.severity === 'critical' ? ' · critical' : ''}</h2>
            <p>{row.input}</p>
            <p className="ob-muted">Expected: {row.expectedAnswer ?? 'none'}. Criteria: {row.reviewCriteria ?? 'none'}. Category: {row.category ?? 'none'}.</p>
            <fieldset disabled={busy} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="eval-grid">
                <Side title={leftTitle} side={row.left} hidden={hidden} prefix={`${row.caseKey}-left`} values={{ decision: values.left, adjudication: values.leftAdj }} setValues={(next) => setSides({ ...sides, [row.caseKey]: { ...values, left: next.decision, leftAdj: next.adjudication } })} />
                <Side title={rightTitle} side={row.right} hidden={hidden} prefix={`${row.caseKey}-right`} values={{ decision: values.right, adjudication: values.rightAdj }} setValues={(next) => setSides({ ...sides, [row.caseKey]: { ...values, right: next.decision, rightAdj: next.adjudication } })} />
              </div>
              <label htmlFor={`note-${row.caseKey}`}>Review note</label>
              <textarea id={`note-${row.caseKey}`} value={notes[row.caseKey] ?? row.note ?? ''} onChange={(e) => setNotes({ ...notes, [row.caseKey]: e.target.value })} rows={2} />
              {canWrite && <button type="button" className="btn-app" onClick={() => save(row)}>{pending ? 'Saving…' : 'Save review'}</button>}
            </fieldset>
          </article>
        );
      })}
      {canApprove && (
        <section className="ob-card">
          <h2>Approve the report</h2>
          <p>Open the preview to see the system names and the exact decision. Approving a fail or an insufficient-evidence result freezes that result. It is not a certification.</p>
          <button type="button" className="btn-ghost" disabled={busy} onClick={reveal}>Preview the decision with system names</button>
          {preview && (
            <>
              <p>Decision: {preview.snapshot.decision.result}. Hash {preview.contentHash.slice(0, 12)}… Baseline {preview.baseline.label}. Candidate {preview.candidate.label}. Left is {preview.assignment.swap ? 'the candidate' : 'the baseline'}.</p>
              <button type="button" className="btn-app" disabled={busy} onClick={approve}>{pending ? 'Approving…' : 'Approve this report'}</button>
            </>
          )}
        </section>
      )}
      {!canApprove && <p className="ob-muted">An owner or admin approves the report.</p>}
    </WorkspaceShell>
  );
}

export function EvalReport() {
  const { account, entry, project, report } = useLoaderData();
  const snapshot = report.snapshot;
  const href = api.evalExportUrl(entry.id, project.id, report.id);
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Report" project={project} current="evaluate">
      <div className="ob-intro">
        <Link className="ob-muted" to={`/w/${entry.slug}/projects/${project.id}/evaluate/${snapshot.set.id}?tab=comparisons`}>← Evaluation set</Link>
        <h1 className="ob-h1">{snapshot.set.name}</h1>
        <p>Approved report, revision {report.revision}. Decision: {snapshot.decision.result === 'insufficient_evidence' ? 'Insufficient evidence' : snapshot.decision.result}. This is not a certification and does not say the assistant is safe for production.</p>
      </div>
      <p><a className="btn-ghost" href={href}>Download JSON</a></p>
      <section className="ob-card">
        <h2>What was frozen</h2>
        <ul>
          <li>Set version {snapshot.set.number}, content hash {snapshot.set.contentHash}</li>
          <li>Rubric {snapshot.set.rubricVersion}. Scorer {snapshot.scorer.id}. {snapshot.scorer.decides}.</li>
          <li>Baseline {snapshot.batches.baseline.label} ({snapshot.batches.baseline.claimedSystem?.identity ?? 'no system name claimed'}). {snapshot.batches.baseline.provenanceLimit}</li>
          <li>Candidate {snapshot.batches.candidate.label} ({snapshot.batches.candidate.claimedSystem?.identity ?? 'no system name claimed'}).</li>
          <li>Left was {snapshot.blind?.swap ? 'the candidate' : 'the baseline'} when identities were {snapshot.blind?.hideIdentity ? 'hidden' : 'shown'}.</li>
        </ul>
        {snapshot.limitations.map((line) => <p key={line} className="ob-muted">{line}</p>)}
      </section>
      <Summary summary={snapshot} />
      <section className="ob-card">
        <h2>Follow-ups</h2>
        {snapshot.followUps.length === 0 && <p>No failed, abstained, errored, or unresolved critical cases in this snapshot.</p>}
        <ul>
          {snapshot.followUps.map((row) => (
            <li key={row.caseKey}><Link to={`/w/${entry.slug}/projects/${project.id}/evaluate/${snapshot.set.id}?tab=cases#case-${row.caseKey}`}>{row.caseKey}</Link> · {row.outcome} · {row.severity ?? 'no severity'}. Correct it in a new draft; this report stays.</li>
          ))}
        </ul>
      </section>
      <div className="ob-table-wrap">
        <table>
          <caption>Cases in the approved snapshot</caption>
          <thead><tr><th>Case</th><th>Baseline outcome</th><th>Candidate outcome</th><th>Candidate human</th><th>Candidate exact</th></tr></thead>
          <tbody>
            {snapshot.cases.map((row) => (
              <tr key={row.caseKey}><td>{row.caseKey}</td><td>{row.baseline.outcome}</td><td>{row.candidate.outcome}</td><td>{row.candidate.human ?? '—'}</td><td>{String(row.candidate.auto.exact)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </WorkspaceShell>
  );
}
