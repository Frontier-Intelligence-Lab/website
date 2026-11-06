// Constants the Evaluate page and the server both use. This module has no imports: it is the only
// evaluation module the web bundle (and the Docker build stage) includes. Everything that validates,
// scores or identifies findings stays in eval.js, which is server-side and uses node:crypto.

export const PLANNED = [
  'Semantic near-duplicate detection',
  'Automatic verification that a source document is true',
  'A guarantee that personal data has been removed',
  'Proof that the case set covers future questions',
  'Calling a model endpoint, running an uploaded scorer, or starting a training job',
];

export const SYNTHETIC_CASES = `{"id":"case-returns-window","input":"How long does a customer have to return an unopened synthetic demo kettle?","expectedAnswer":"30 days from delivery","reviewCriteria":"Name the 30-day window and that it starts at delivery.","category":"returns","severity":"critical","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
{"id":"case-warranty-power","input":"The synthetic demo kettle will not power on. What should the agent do?","expectedAnswer":"Ask for the order number and offer a replacement. Do not promise a refund before the order is found.","reviewCriteria":null,"category":"warranty","severity":"major","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002"}]}
{"id":"case-store-hours","input":"What time does the synthetic demo shop close on Sunday?","expectedAnswer":null,"reviewCriteria":"The answer must match the Sunday hours in the cited policy, or say the policy does not state them.","category":"hours","severity":"minor","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
`;

export const SYNTHETIC_PREDICTIONS = `{"id":"case-returns-window","status":"answered","output":"You can return an unopened kettle within 30 days of delivery."}
{"id":"case-warranty-power","status":"answered","output":"I can refund you right now."}
{"id":"case-store-hours","status":"error","error":"timeout"}
`;

/** A pass is the only outcome that counts as passing. An error, a miss, and an open judgment do not. */
export function isPass(outcome) {
  return outcome === 'pass';
}

/** A stored error is never a pass, even after a person records a decision on that row. */
function countsAsPass(outcome, status) {
  return isPass(outcome) && status !== 'error';
}

/** One cell of the kept / fixed / regressed / still-failing matrix. */
export function changeKind(baselineOutcome, candidateOutcome, baselineStatus, candidateStatus) {
  const baseline = countsAsPass(baselineOutcome, baselineStatus);
  const candidate = countsAsPass(candidateOutcome, candidateStatus);
  if (baseline && candidate) return 'kept';
  if (!baseline && candidate) return 'fixed';
  if (baseline && !candidate) return 'regressed';
  return 'still';
}

export function changeLabel(change, baselineOutcome, candidateOutcome, baselineStatus, candidateStatus) {
  if (baselineOutcome === 'error' || candidateOutcome === 'error' || baselineStatus === 'error' || candidateStatus === 'error') return 'Error';
  if (change === 'kept') return 'Kept passing';
  if (change === 'fixed') return 'Fixed';
  if (change === 'regressed') return 'Regressed';
  return 'Still failing';
}

export function sideLabel(outcome, status) {
  if (status === 'error' || outcome === 'error') return 'Error';
  if (status === 'missing' || outcome === 'missing') return 'Missing';
  if (status === 'abstained' || outcome === 'abstained') return 'Abstained';
  if (outcome === 'needs_judgment') return 'Needs judgment';
  if (outcome === 'pass') return 'Pass';
  if (outcome === 'fail') return 'Fail';
  if (outcome === 'disagreement') return 'Disagreement';
  if (outcome === 'unreviewed') return 'Unreviewed';
  if (outcome === 'insufficient') return 'Insufficient';
  if (outcome === 'not_applicable') return 'Not applicable';
  return 'Not scored';
}

/** A person still has to decide. A critical case with no recorded judgment stays here. */
export function judgmentNeeded({ severity, outcome, human, auto }) {
  if (outcome === 'needs_judgment' || outcome === 'disagreement' || outcome === 'unreviewed' || outcome === 'insufficient') return true;
  if (severity === 'critical' && !human) return true;
  if (auto === 'not_applicable' && !human) return true;
  return false;
}

export function triageRow(row) {
  const change = changeKind(row.baselineOutcome, row.candidateOutcome, row.baselineStatus, row.candidateStatus);
  const needsJudgment = judgmentNeeded({ severity: row.severity, outcome: row.candidateOutcome, human: row.human, auto: row.auto });
  const candidatePass = countsAsPass(row.candidateOutcome, row.candidateStatus);
  const attention = change === 'regressed' || change === 'still' || needsJudgment || (row.severity === 'critical' && !candidatePass);
  return { ...row, change, needsJudgment, attention, label: changeLabel(change, row.baselineOutcome, row.candidateOutcome, row.baselineStatus, row.candidateStatus) };
}

export function importRows(review) {
  if (!review || review.hidden || !review.leftRole) return null;
  const baseline = review.leftRole === 'baseline' ? 'left' : 'right';
  const candidate = baseline === 'left' ? 'right' : 'left';
  return review.cases.map((row) => {
    const base = row[baseline] ?? {};
    const cand = row[candidate] ?? {};
    return triageRow({
      caseKey: row.caseKey,
      severity: row.severity ?? null,
      baselineOutcome: base.outcome ?? 'missing',
      candidateOutcome: cand.outcome ?? 'missing',
      baselineStatus: base.status ?? 'missing',
      candidateStatus: cand.status ?? 'missing',
      human: cand.decision ?? null,
      auto: cand.auto?.result ?? null,
      split: null,
    });
  });
}

function runnerOutcome(result) {
  if (!result) return { outcome: 'missing', status: 'missing' };
  if (result.errorKind) return { outcome: 'error', status: 'error' };
  const verdict = result.scores?.verdict;
  if (verdict === 'pass' || verdict === 'fail' || verdict === 'needs_judgment') return { outcome: verdict, status: 'answered' };
  return { outcome: 'missing', status: 'missing' };
}

/** Join two scored runs onto one frozen case list. A verdict other than pass is not a pass. */
export function runnerRows(cases, baselineResults, candidateResults) {
  const baseline = new Map((baselineResults ?? []).map((row) => [row.caseKey, row]));
  const candidate = new Map((candidateResults ?? []).map((row) => [row.caseKey, row]));
  const keys = new Set([...(cases ?? []).map((row) => row.caseKey), ...baseline.keys(), ...candidate.keys()]);
  return [...keys].sort().map((caseKey) => {
    const frozen = (cases ?? []).find((row) => row.caseKey === caseKey);
    const base = runnerOutcome(baseline.get(caseKey));
    const cand = runnerOutcome(candidate.get(caseKey));
    return triageRow({
      caseKey,
      severity: frozen?.severity ?? null,
      input: frozen?.input ?? null,
      baselineOutcome: base.outcome,
      candidateOutcome: cand.outcome,
      baselineStatus: base.status,
      candidateStatus: cand.status,
      human: null,
      auto: cand.outcome,
      split: null,
      baselineResult: baseline.get(caseKey) ?? null,
      candidateResult: candidate.get(caseKey) ?? null,
    });
  });
}

export function countChanges(rows) {
  const counts = { kept: 0, fixed: 0, regressed: 0, still: 0, attention: 0, critical: 0, judgment: 0, fixedAwaiting: 0 };
  for (const row of rows) {
    counts[row.change] += 1;
    if (row.attention) counts.attention += 1;
    if (row.severity === 'critical') counts.critical += 1;
    if (row.needsJudgment) counts.judgment += 1;
    if (row.change === 'fixed' && row.needsJudgment) counts.fixedAwaiting += 1;
  }
  return counts;
}
