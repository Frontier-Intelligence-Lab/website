import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { countChanges, importRows, runnerRows, sideLabel } from '../../../src/lib/eval-shared.js';

function tallyComplete(tally, eligible) {
  return eligible > 0 && tally.submitted === eligible && tally.missing === 0 && tally.failed === 0 && tally.abstained === 0;
}

function ScoreLine({ complete, passes, eligible, missing, failed, abstained }) {
  if (!complete) {
    return <p className="eval-score">No score <small>· {missing} missing, {failed} errors, {abstained} abstained</small></p>;
  }
  return <p className="eval-score">{passes} <small>of {eligible} pass</small></p>;
}

function RunCard({ title, provenance, completion, complete, passes, eligible, missing, failed, abstained, facts }) {
  return (
    <article className="ob-card eval-run">
      <h3>{title}</h3>
      <ScoreLine complete={complete} passes={passes} eligible={eligible} missing={missing} failed={failed} abstained={abstained} />
      <p className="eval-pills">
        <span className="pill pill--info">{provenance}</span>
        <span className={`pill ${completion === 'Complete' ? 'pill--plain' : 'pill--warn'}`}>{completion}</span>
      </p>
      <dl className="eval-kv">
        {facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
      </dl>
    </article>
  );
}

function Matrix({ counts, change, onChange }) {
  const cell = (id, title, extra) => (
    <button type="button" className={`eval-cell${id === 'regressed' ? ' eval-cell--regressed' : ''}`} aria-pressed={change === id} onClick={() => onChange(change === id ? null : id)}>
      <b>{counts[id]}</b>
      <span>{title}{extra}</span>
    </button>
  );
  return (
    <div className="eval-matrix" role="group" aria-label="What changed between the runs">
      <span />
      <span className="eval-axis">Candidate passes</span>
      <span className="eval-axis">Candidate does not pass</span>
      <span className="eval-axis">Baseline passes</span>
      {cell('kept', 'Kept passing')}
      {cell('regressed', 'Regressed')}
      <span className="eval-axis">Baseline does not pass</span>
      {cell('fixed', 'Fixed', counts.fixedAwaiting ? ` · ${counts.fixedAwaiting} await judgment` : '')}
      {cell('still', 'Still failing')}
    </div>
  );
}

function Chips({ counts, total, chip, onChip }) {
  const items = [
    ['attention', `Needs attention · ${counts.attention}`],
    ['critical', `Critical · ${counts.critical}`],
    ['judgment', `Needs judgment · ${counts.judgment}`],
    ['all', `All ${total}`],
  ];
  return (
    <div className="eval-chips" role="group" aria-label="Filter cases">
      {items.map(([id, label]) => (
        <button key={id} type="button" className="eval-chip" aria-pressed={chip === id} onClick={() => onChip(id)}>{label}</button>
      ))}
    </div>
  );
}

function CaseTable({ rows, baselineTitle, candidateTitle, selected, onSelect }) {
  return (
    <div className="ob-table-wrap">
      <table>
        <caption>Cases in this comparison. Choose a row to inspect it. The comparison stays on this page. The split is not recorded on this case set.</caption>
        <thead>
          <tr>
            <th>Case</th>
            <th>{baselineTitle}</th>
            <th>{candidateTitle}</th>
            <th>Change</th>
            <th className="eval-hide-sm">Split</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5}>No cases match this filter.</td></tr>
          )}
          {rows.map((row) => (
            <tr key={row.caseKey} aria-current={selected === row.caseKey ? 'true' : undefined}>
              <td>
                <button type="button" className="btn-text" aria-pressed={selected === row.caseKey} onClick={() => onSelect(row.caseKey)}>{row.caseKey}</button>
                {row.severity === 'critical' ? <span className="ob-muted"> · critical</span> : null}
              </td>
              <td>{sideLabel(row.baselineOutcome, row.baselineStatus)}</td>
              <td>{sideLabel(row.candidateOutcome, row.candidateStatus)}</td>
              <td>{row.label}</td>
              <td className="eval-hide-sm">Not recorded</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useFilters(rows) {
  const [change, setChange] = useState(null);
  const [chip, setChip] = useState('attention');
  const [selected, setSelected] = useState(null);
  const counts = countChanges(rows);
  const shown = rows.filter((row) => {
    if (change && row.change !== change) return false;
    if (chip === 'critical') return row.severity === 'critical';
    if (chip === 'judgment') return row.needsJudgment;
    if (chip === 'attention') return row.attention;
    return true;
  });
  return { change, setChange, chip, setChip, selected, setSelected, counts, shown };
}

export function ImportTriage({ review, summary, baseline, candidate, version }) {
  const rows = importRows(review);
  const filters = useFilters(rows ?? []);
  if (!rows) {
    return <p className="ob-card">What changed is hidden while system names are hidden. Show system names to filter kept, fixed, regressed and still failing. The saved assignment is unchanged.</p>;
  }
  const eligible = summary?.counts?.eligible ?? rows.length;
  const baseTally = summary?.counts?.baseline ?? { submitted: 0, missing: 0, failed: 0, abstained: 0 };
  const candTally = summary?.counts?.candidate ?? { submitted: 0, missing: 0, failed: 0, abstained: 0 };
  const baseComplete = tallyComplete(baseTally, eligible);
  const candComplete = tallyComplete(candTally, eligible);
  const passes = (outcome, status) => rows.filter((row) => row[outcome] === 'pass' && row[status] !== 'error').length;
  const hash = version?.contentHash ? `${version.contentHash.slice(0, 8)}…` : 'not loaded';
  function select(caseKey) {
    filters.setSelected(caseKey);
    document.getElementById(`review-${caseKey}`)?.scrollIntoView({ block: 'start' });
  }
  return (
    <section className="eval-stack" aria-labelledby="compare-title">
      <div className="eval-compare-head">
        <h2 id="compare-title">Comparison</h2>
        <p className="pill pill--plain">Same frozen set: version {version?.number ?? 'unknown'} · content hash {hash}</p>
        <button type="button" className="btn-ghost" disabled aria-describedby="rerun-wait">Rerun…</button>
        <p id="rerun-wait" className="ob-muted">A fair rerun is not on this screen. Starting one here would not keep the frozen set as the only scope that counts.</p>
      </div>
      <div className="eval-runs">
        <RunCard
          title={`Baseline${baseline?.label ? `: ${baseline.label}` : ''}`}
          provenance="Imported answers"
          completion={baseComplete ? 'Complete' : 'Partial'}
          complete={baseComplete}
          passes={passes('baselineOutcome', 'baselineStatus')}
          eligible={eligible}
          missing={baseTally.missing}
          failed={baseTally.failed}
          abstained={baseTally.abstained}
          facts={[['Claim', baseline?.claimedSystem?.identity ?? 'No system name claimed'], ['Scorer', 'Normalized exact match']]}
        />
        <p className="eval-vs" aria-hidden="true">→</p>
        <RunCard
          title={`Candidate${candidate?.label ? `: ${candidate.label}` : ''}`}
          provenance="Imported answers"
          completion={candComplete ? 'Complete' : 'Partial'}
          complete={candComplete}
          passes={passes('candidateOutcome', 'candidateStatus')}
          eligible={eligible}
          missing={candTally.missing}
          failed={candTally.failed}
          abstained={candTally.abstained}
          facts={[['Claim', candidate?.claimedSystem?.identity ?? 'No system name claimed'], ['Scorer', 'Normalized exact match']]}
        />
        <Matrix counts={filters.counts} change={filters.change} onChange={filters.setChange} />
      </div>
      <div className="ob-card">
        <div className="eval-compare-head">
          <Chips counts={filters.counts} total={rows.length} chip={filters.chip} onChip={filters.setChip} />
          <p className="ob-muted">Click a row to inspect it. The comparison stays put. {filters.shown.length} of {rows.length} cases shown.</p>
        </div>
        <p className="ob-muted">These cards count a score only when every imported row was answered. The report further down still uses every eligible case. An error is not a wrong answer. This case set does not record a held-out split.</p>
        <CaseTable rows={filters.shown} baselineTitle="Baseline" candidateTitle="Candidate" selected={filters.selected} onSelect={select} />
      </div>
    </section>
  );
}

const STATUS_WORD = { queued: 'Queued', running: 'Running', complete: 'Complete', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled' };

function runnerFacts(run) {
  if (!run) return [['Recipe', 'No run chosen'], ['Settings', 'Not recorded']];
  const settings = run.settings ?? {};
  const model = run.runtime?.modelId ? `catalog model ${run.runtime.modelId}` : 'extractive recipe, no model';
  return [
    ['Recipe', `${run.recipeId} ${run.recipeVersion}`.trim()],
    ['Settings', `retrieval k ${settings.retrievalK ?? 'not recorded'} · ${settings.prompt ? 'prompt recorded' : 'no prompt'} · ${model}`],
  ];
}

function runOption(run) {
  const stamp = run.finishedAt || run.createdAt;
  const when = typeof stamp === 'string' && stamp ? stamp.slice(0, 16).replace('T', ' ') : 'time not recorded';
  return `${STATUS_WORD[run.status] ?? run.status} · ${run.scored ? 'scored' : 'no score'} · ${when} · ${run.id.slice(0, 8)}`;
}

function RunnerCard({ run, role }) {
  const scored = run?.scored === true && run?.status === 'complete' && run?.passCount != null;
  const title = run ? (run.role === 'baseline' ? 'Baseline' : 'Candidate') : (role === 'baseline' ? 'Baseline' : 'Candidate');
  return (
    <article className="ob-card eval-run">
      <h3>{title} · {STATUS_WORD[run?.status] ?? (run ? run.status : 'Not chosen')}</h3>
      <p className="eval-score">{scored ? <>{run.passCount} <small>of {run.caseCount} pass</small></> : <>No score</>}</p>
      <p className="eval-pills">
        <span className="pill pill--info">Runner-executed</span>
        <span className={`pill ${run?.status === 'complete' && run?.scored ? 'pill--plain' : 'pill--warn'}`}>{STATUS_WORD[run?.status] ?? 'Not chosen'}</span>
      </p>
      <dl className="eval-kv">{runnerFacts(run).map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
    </article>
  );
}

function evidence(result) {
  if (!result) return 'No result was stored for this case.';
  if (result.errorKind) return result.explanation || 'This is an error, not a wrong answer.';
  const passages = result.passages ?? [];
  if (!passages.length) return 'No retrieved passage was stored for this case.';
  return passages.map((item) => item.text || item.id).join('\n\n');
}

export function RunPair({ entry, project, set, version, runs }) {
  const baselines = runs.filter((run) => run.role === 'baseline');
  const candidates = runs.filter((run) => run.role === 'candidate');
  const [baselineId, setBaselineId] = useState(baselines.at(-1)?.id ?? '');
  const [candidateId, setCandidateId] = useState(candidates.at(-1)?.id ?? '');
  const baselinePick = baselineId === '' || baselines.some((run) => run.id === baselineId) ? baselineId : (baselines.at(-1)?.id ?? '');
  const candidatePick = candidateId === '' || candidates.some((run) => run.id === candidateId) ? candidateId : (candidates.at(-1)?.id ?? '');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const baseline = baselines.find((run) => run.id === baselinePick) ?? null;
  const candidate = candidates.find((run) => run.id === candidatePick) ?? null;
  const pairReady = Boolean(baseline && candidate && baseline.id !== candidate.id && baseline.scored === true && baseline.status === 'complete' && candidate.scored === true && candidate.status === 'complete');
  useEffect(() => {
    if (!pairReady) { setDetail(null); return undefined; }
    let live = true;
    setDetail(null);
    setError('');
    Promise.all([
      api.caseRun(entry.id, project.id, set.id, version.id, baseline.id),
      api.caseRun(entry.id, project.id, set.id, version.id, candidate.id),
    ]).then(([left, right]) => {
      if (!live) return;
      const samePair = left.run?.id === baseline.id && right.run?.id === candidate.id;
      const sameVersion = left.run?.versionId === version.id && right.run?.versionId === version.id;
      const bothScored = left.run?.scored === true && left.run?.status === 'complete' && right.run?.scored === true && right.run?.status === 'complete';
      if (!samePair || !sameVersion || !bothScored) {
        setDetail(null);
        setError(sameVersion
          ? 'Those runs are not both complete and scored, so nothing from the previous pair is shown.'
          : 'Those runs are not on this frozen version, so they are not compared.');
        return;
      }
      setDetail({ baseline: left.run, candidate: right.run });
    }).catch(() => {
      if (!live) return;
      setDetail(null);
      setError('The run could not be loaded. Nothing from the previous pair is shown.');
    });
    return () => { live = false; };
  }, [pairReady, baseline?.id, candidate?.id, entry.id, project.id, set.id, version.id]);
  const rows = detail ? runnerRows(version.cases, detail.baseline.results, detail.candidate.results) : [];
  const filters = useFilters(rows);
  const blocked = !baseline || !candidate
    ? 'Choose a baseline run and a candidate run. A run is not compared with itself.'
    : baseline.id === candidate.id
      ? 'Choose two different runs.'
      : !pairReady
        ? `No score. ${STATUS_WORD[baseline.status] ?? baseline.status} and ${STATUS_WORD[candidate.status] ?? candidate.status} stay on record and are not compared.`
        : '';
  function select(caseKey) {
    filters.setSelected((current) => (current === caseKey ? null : caseKey));
  }
  const picked = rows.find((row) => row.caseKey === filters.selected) ?? null;
  return (
    <section className="eval-stack" aria-labelledby={`runs-${version.id}`}>
      <h3 id={`runs-${version.id}`}>Runner-executed runs</h3>
      {runs.length === 0 && <p className="ob-muted">No runner-executed run for this version. An imported comparison is a separate record.</p>}
      {runs.length > 0 && (
        <>
          <div className="eval-grid">
            <div className="ob-field">
              <label htmlFor={`base-run-${version.id}`}>Baseline run</label>
              <select id={`base-run-${version.id}`} value={baselinePick} onChange={(event) => setBaselineId(event.target.value)}>
                <option value="">None</option>
                {baselines.map((run) => <option key={run.id} value={run.id}>{runOption(run)}</option>)}
              </select>
            </div>
            <div className="ob-field">
              <label htmlFor={`cand-run-${version.id}`}>Candidate run</label>
              <select id={`cand-run-${version.id}`} value={candidatePick} onChange={(event) => setCandidateId(event.target.value)}>
                <option value="">None</option>
                {candidates.map((run) => <option key={run.id} value={run.id}>{runOption(run)}</option>)}
              </select>
            </div>
          </div>
          <div className="eval-runs">
            <RunnerCard run={baseline} role="baseline" />
            <p className="eval-vs" aria-hidden="true">→</p>
            <RunnerCard run={candidate} role="candidate" />
            {detail && <Matrix counts={filters.counts} change={filters.change} onChange={filters.setChange} />}
          </div>
          {pairReady && !detail && !error && <p className="ob-muted" role="status">Loading the two runs. The previous comparison is not shown.</p>}
          {blocked && <p className="ob-alert ob-alert--info" role="status">{blocked}</p>}
          {error && <p className="ob-alert" role="alert">{error}</p>}
          {detail && (
            <div className="ob-card">
              <Chips counts={filters.counts} total={rows.length} chip={filters.chip} onChip={filters.setChip} />
              <p className="ob-muted">Both runs are complete and scored. A critical case has no recorded judgment yet, so it stays in Needs judgment. Click a row to read the evidence here.</p>
              <CaseTable rows={filters.shown} baselineTitle="Baseline" candidateTitle="Candidate" selected={filters.selected} onSelect={select} />
              {picked && (
                <div className="eval-inspect" role="region" aria-label={`Case ${picked.caseKey}`}>
                  <h4>{picked.caseKey}</h4>
                  <p>{picked.input ?? 'This case key was stored on a run and is not in the frozen set shown here.'}</p>
                  <div className="eval-grid">
                    <div><h4>Baseline</h4><p>{sideLabel(picked.baselineOutcome, picked.baselineStatus)}</p><pre className="eval-pre">{evidence(picked.baselineResult)}</pre></div>
                    <div><h4>Candidate</h4><p>{sideLabel(picked.candidateOutcome, picked.candidateStatus)}</p><pre className="eval-pre">{evidence(picked.candidateResult)}</pre></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
