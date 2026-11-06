export function importedScoringLabel(basis) {
  const label = {
    human_only: 'Human review only',
    human_else_auto: 'Human review, exact match fallback',
    auto_exact: 'Normalized exact match',
  }[basis];
  return typeof label === 'string' ? label : 'Not recorded';
}

export function runnerFacts(run) {
  if (!run) return [['Recipe', 'No run chosen'], ['Settings', 'Not recorded']];
  const settings = run.settings ?? {};
  const extractive = run.recipeId === 'support-qa';
  const modelId = run.runtime?.modelId ?? settings.modelId;
  return [
    ['Recipe', [run.recipeId, run.recipeVersion].filter(Boolean).join(' ')],
    ['Execution', extractive ? 'Extractive · no model call' : 'Not recorded'],
    ['Retrieval', `k ${settings.retrievalK ?? 'not recorded'}`],
    ['Model', modelId ? `${modelId} · selected${extractive ? ', not used' : ''}` : 'None selected'],
    ['Prompt', settings.prompt ? (extractive ? 'Recorded, not used' : 'Recorded') : 'None recorded'],
  ];
}

export function filterTriageRows(rows, filter) {
  return rows.filter((row) => {
    if (['kept', 'fixed', 'regressed', 'still'].includes(filter)) return row.change === filter;
    if (filter === 'critical') return row.severity === 'critical';
    if (filter === 'judgment') return row.needsJudgment;
    if (filter === 'attention') return row.attention;
    return true;
  });
}

export function runPairKey(scope) {
  return JSON.stringify([scope.workspaceId, scope.projectId, scope.setId, scope.versionId, scope.baselineId, scope.candidateId]);
}

// Selection can render before the previous effect is cleaned up. Neither its result nor its error belongs
// to the new selection, even if a late request writes that old keyed state in the meantime.
export function visibleRunPair(state, key, ready) {
  return ready && state?.key === key ? state : null;
}

export function loadRunPair(scope, readRun, publish) {
  const key = runPairKey(scope);
  let live = true;
  publish({ key, detail: null, error: '' });
  Promise.all([readRun(scope.baselineId), readRun(scope.candidateId)]).then(([left, right]) => {
    if (!live) return;
    const samePair = left.run?.id === scope.baselineId && right.run?.id === scope.candidateId;
    const sameVersion = left.run?.versionId === scope.versionId && right.run?.versionId === scope.versionId;
    const bothScored = left.run?.scored === true && left.run?.status === 'complete' && right.run?.scored === true && right.run?.status === 'complete';
    if (!samePair || !sameVersion || !bothScored) {
      publish({ key, detail: null, error: sameVersion
        ? 'Those runs are not both complete and scored, so nothing from the previous pair is shown.'
        : 'Those runs are not on this frozen version, so they are not compared.' });
      return;
    }
    publish({ key, detail: { baseline: left.run, candidate: right.run }, error: '' });
  }).catch(() => {
    if (live) publish({ key, detail: null, error: 'The run could not be loaded. Nothing from the previous pair is shown.' });
  });
  return () => { live = false; };
}
