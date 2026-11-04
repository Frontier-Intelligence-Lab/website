import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotHash } from '../src/lib/capital-hash.js';
import {
  MAX_CASES, MAX_IMPORT_BYTES, SYNTHETIC_CASES, SYNTHETIC_PREDICTIONS, buildComparison, buildReportSnapshot, computeEvalIssues,
  defaultAcceptance, mapBlindDecisions, normalizeText, parseCaseJsonl, parsePredictionJsonl, scoreSide, tokenOverlap, wilson95,
} from '../src/lib/eval.js';

const source = { projectId: '00000000-0000-4000-8000-000000000001', versionId: '00000000-0000-4000-8000-000000000002', fileId: null };
const catalog = [{ versionId: source.versionId, projectId: source.projectId, number: 1, testing: true, fileIds: [] }];
const row = (extra) => ({ caseKey: 'a', input: 'How long is the window?', expectedAnswer: '30 days', reviewCriteria: null, category: 'returns', severity: 'major', sourceRefs: [source], ...extra });

test('normalization is the documented exact-match rule, not a semantic one', () => {
  assert.equal(normalizeText('  “30   Days” '), '“30 days”');
  assert.equal(normalizeText('  "30   Days" '), '30 days');
  assert.equal(normalizeText(" 'Thirty\nDays' "), 'thirty days');
  assert.equal(tokenOverlap('30 days', 'thirty days') < 1, true);
  const scored = scoreSide('30 days', { status: 'answered', output: '30   DAYS', error: null });
  assert.equal(scored.exact, true);
  assert.equal(scored.result, 'pass');
  assert.equal(scoreSide('30 days', { status: 'answered', output: 'a refund', error: null }).result, 'fail');
  assert.equal(scoreSide(null, { status: 'answered', output: '30 days', error: null }).result, 'not_applicable');
  assert.equal(scoreSide('30 days', { status: 'error', output: null, error: 'timeout' }).exact, null);
  assert.equal(scoreSide('30 days', null).result, 'missing');
});

test('case and prediction JSONL reject the whole file', () => {
  const good = JSON.stringify({ id: 'case-1', input: 'Question', expectedAnswer: 'Answer', sources: [source] });
  assert.equal(parseCaseJsonl(`${good}\n`).length, 1);
  assert.throws(() => parseCaseJsonl('{'), /Nothing was saved/);
  assert.throws(() => parseCaseJsonl(`${good}\n${good}\n`), /repeats case id/);
  assert.throws(() => parseCaseJsonl(''), /no rows/);
  assert.throws(() => parseCaseJsonl('x'.repeat(MAX_IMPORT_BYTES + 1)), /limit/);
  assert.throws(() => parseCaseJsonl(Array.from({ length: MAX_CASES + 1 }, (_, i) => JSON.stringify({ id: `c${i}`, input: 'Q', expectedAnswer: 'A', sources: [source] })).join('\n')), /at most 200/);
  const known = new Set(['case-1']);
  assert.equal(parsePredictionJsonl('{"id":"case-1","status":"answered","output":"Answer"}\n', known)[0].output, 'Answer');
  assert.throws(() => parsePredictionJsonl('{"id":"missing","status":"answered","output":"x"}\n', known), /not in this frozen/);
  assert.throws(() => parsePredictionJsonl('{"id":"case-1","status":"answered","output":"  "}\n', known), /empty answer was not stored/);
  assert.throws(() => parsePredictionJsonl('{"id":"case-1","status":"error","output":"partial","error":"timeout"}\n', known), /not dropped/);
  assert.throws(() => parsePredictionJsonl('{"id":"case-1","status":"abstained","output":"no"}\n', known), /not dropped/);
  assert.throws(() => parsePredictionJsonl('{"id":"case-1","status":"error"}\n', known), /error code/);
  assert.throws(() => parsePredictionJsonl('{"id":"case-1","status":"answered","output":"x"}\n{"id":"case-1","status":"answered","output":"y"}\n', known), /repeats/);
});

test('quality findings name the case and do not rewrite it', () => {
  const cases = [row({ caseKey: 'a', input: 'Same question' }), row({ caseKey: 'b', input: '  same   question ', expectedAnswer: 'Other' }), row({ caseKey: 'c', expectedAnswer: null, reviewCriteria: null }), row({ caseKey: 'd', sourceRefs: [] })];
  const issues = computeEvalIssues({ cases, sources: catalog });
  const conflict = issues.find((issue) => issue.group === 'conflict');
  assert.equal(conflict.acknowledgeable, true);
  assert.equal(conflict.open, true);
  assert.match(conflict.detail, /not a proven factual error/);
  assert.equal(issues.find((issue) => issue.caseKeys.includes('c') && issue.group === 'expectation').acknowledgeable, false);
  assert.equal(issues.find((issue) => issue.caseKeys.includes('d') && issue.group === 'sources').open, true);
  const noted = computeEvalIssues({ cases: cases.slice(0, 2), notes: [{ key: conflict.key, note: 'Both policies are in force.' }], sources: catalog });
  assert.equal(noted.find((issue) => issue.group === 'conflict').open, false);
  const duplicate = computeEvalIssues({ cases: [row({ caseKey: 'a', input: 'Same' }), row({ caseKey: 'b', input: 'same' })], sources: catalog });
  assert.equal(duplicate.find((issue) => issue.group === 'duplicate').acknowledgeable, false);
  assert.deepEqual(cases[0].input, 'Same question');
});

test('rates keep every eligible case, and critical uncertainty is not a proven failure', () => {
  const version = { cases: [row({ caseKey: 'crit', severity: 'critical', expectedAnswer: '30 days' }), row({ caseKey: 'other', expectedAnswer: 'open' })] };
  const acceptance = { ...defaultAcceptance(), minPassRate: 0.9, minCoverage: 1, requireHumanOnCritical: false, requireHumanOnDisagreement: false, requireHumanWhenNoExpectedAnswer: false };
  const built = buildComparison({
    version, acceptance, judgments: [],
    baselinePredictions: [{ caseKey: 'crit', status: 'answered', output: '30 days', error: null }],
    candidatePredictions: [{ caseKey: 'crit', status: 'answered', output: 'refund', error: null }],
  });
  assert.equal(built.counts.eligible, 2);
  assert.equal(built.counts.candidate.missing, 1);
  assert.equal(built.denominator, 'eligible');
  assert.equal(built.passRate, 0);
  assert.equal(built.decision.result, 'insufficient_evidence');
  assert.equal(built.criticalFailures.length, 1);
  assert.equal(built.criticalFailures[0].caseKey, 'crit');

  const covered = { ...acceptance, minCoverage: 0 };
  const failed = buildComparison({
    version: { cases: [row({ caseKey: 'crit', severity: 'critical' })] }, acceptance: covered, judgments: [],
    baselinePredictions: [], candidatePredictions: [{ caseKey: 'crit', status: 'answered', output: 'no', error: null }],
  });
  assert.equal(failed.decision.result, 'fail');
  const missing = buildComparison({
    version: { cases: [row({ caseKey: 'crit', severity: 'critical' })] }, acceptance: covered, judgments: [],
    baselinePredictions: [], candidatePredictions: [],
  });
  assert.equal(missing.decision.result, 'insufficient_evidence');
  assert.equal(missing.criticalFailures.length, 0);

  const human = buildComparison({
    version: { cases: [row({ caseKey: 'crit', severity: 'critical', expectedAnswer: '30 days' })] },
    acceptance: defaultAcceptance(),
    baselinePredictions: [{ caseKey: 'crit', status: 'answered', output: '30 days', error: null }],
    candidatePredictions: [{ caseKey: 'crit', status: 'answered', output: '30 days', error: null }],
    judgments: [{ caseKey: 'crit', baselineDecision: 'fail', candidateDecision: 'pass', adjudicationBaseline: 'human', adjudicationCandidate: null, note: 'The baseline omitted delivery.' }],
  });
  assert.equal(human.rows[0].baseline.disagreement, true);
  assert.equal(human.rows[0].baseline.outcome, 'fail');
  assert.equal(human.rows[0].baseline.auto.result, 'pass');
  assert.equal(human.rows[0].candidate.outcome, 'pass');
  assert.equal(human.decision.result, 'pass');
  const interval = wilson95(1, 1);
  assert.equal(interval, null);
  const wide = wilson95(1, 2);
  assert.equal(wide.n, 2);
  assert.match(wide.assumptions.join(' '), /not a forecast/);
});

test('blind review rejects named decisions, and the report hash ignores the approver', () => {
  assert.throws(() => mapBlindDecisions({ hideIdentity: true, swap: true }, { baselineDecision: 'pass' }), /left and right/);
  const mapped = mapBlindDecisions({ hideIdentity: true, swap: true }, { leftDecision: 'fail', rightDecision: 'pass' });
  assert.equal(mapped.candidateDecision, 'fail');
  assert.equal(mapped.baselineDecision, 'pass');
  const version = { id: 'v', setId: 's', number: 1, name: 'Demo', purpose: 'development', contentHash: 'a'.repeat(64), rubricVersion: 'rubric-v1', cases: [] };
  const batch = { id: 'b', role: 'baseline', label: 'old', claimedSystem: { identity: null, configuration: null }, claimedScorer: null, rubricVersion: 'rubric-v1', provenance: {}, contentHash: 'b'.repeat(64), importedAt: '2026-11-04T00:00:00.000Z' };
  const built = buildComparison({ version, acceptance: defaultAcceptance(), baselinePredictions: [], candidatePredictions: [], judgments: [] });
  const snapshot = buildReportSnapshot({ version, baselineBatch: batch, candidateBatch: { ...batch, id: 'c', role: 'candidate', label: 'new' }, comparison: { acceptance: defaultAcceptance(), blind: { hideIdentity: true, swap: true } }, built });
  assert.equal(snapshot.approvedBy, undefined);
  assert.equal(snapshot.approvedAt, undefined);
  const reordered = snapshotHash({ limitations: snapshot.limitations, schema: snapshot.schema, ...snapshot });
  assert.equal(snapshotHash(snapshot), reordered);
  assert.notEqual(snapshotHash(snapshot), snapshotHash({ ...snapshot, approvedAt: 'later' }), 'approval time stays on the report row, outside the hashed snapshot');
});

test('the documented examples match the synthetic fixtures', () => {
  assert.equal(readFileSync(new URL('../docs/examples/eval-cases.example.jsonl', import.meta.url), 'utf8'), SYNTHETIC_CASES);
  assert.equal(readFileSync(new URL('../docs/examples/eval-predictions.example.jsonl', import.meta.url), 'utf8'), SYNTHETIC_PREDICTIONS);
  assert.equal(parsePredictionJsonl(SYNTHETIC_PREDICTIONS, new Set(['case-returns-window', 'case-warranty-power', 'case-store-hours'])).length, 3);
});
