import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotHash } from '../src/lib/capital-hash.js';
import {
  MAX_CASES, MAX_IMPORT_BYTES, SYNTHETIC_CASES, SYNTHETIC_PREDICTIONS, buildComparison, buildReportSnapshot, computeEvalIssues,
  defaultAcceptance, mapBlindDecisions, normalizeText, parseCaseJsonl, parsePredictionJsonl, scoreSide, tokenOverlap, validateAcceptance, wilson95,
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

test('a conflicting answer does not hide exact duplicates, and an acknowledgement is bound to what was reviewed', () => {
  const nineAndOne = Array.from({ length: 10 }, (_, i) => row({ caseKey: `c${i}`, input: 'Is the kettle returnable?', expectedAnswer: i < 9 ? 'Yes' : 'no' }));
  const issues = computeEvalIssues({ cases: nineAndOne, sources: catalog });
  const duplicates = issues.filter((issue) => issue.group === 'duplicate');
  const conflict = issues.find((issue) => issue.group === 'conflict');
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].caseKeys, nineAndOne.slice(0, 9).map((item) => item.caseKey));
  assert.equal(duplicates[0].acknowledgeable, false);
  assert.deepEqual(conflict.caseKeys, nineAndOne.map((item) => item.caseKey));
  const acknowledged = computeEvalIssues({ cases: nineAndOne, notes: [{ key: conflict.key, note: 'Reviewed.' }], sources: catalog });
  assert.equal(acknowledged.find((issue) => issue.group === 'conflict').open, false);
  assert.equal(acknowledged.find((issue) => issue.group === 'duplicate').open, true, 'acknowledging the conflict does not waive the duplicates');
  assert.equal(computeEvalIssues({ cases: [nineAndOne[0], nineAndOne[9]], sources: catalog }).filter((issue) => issue.group === 'duplicate').length, 0);

  const pair = [row({ caseKey: 'a', input: 'Is it returnable?', expectedAnswer: 'yes' }), row({ caseKey: 'b', input: 'Is it returnable?', expectedAnswer: 'no' })];
  const keyOf = (cases) => computeEvalIssues({ cases, sources: catalog }).find((issue) => issue.group === 'conflict').key;
  const reviewed = keyOf(pair);
  assert.equal(keyOf([pair[1], pair[0]]), reviewed, 'the key does not depend on the order the cases arrive in');
  assert.match(reviewed, /^conflict:[0-9a-f]{64}$/);
  assert.match(duplicates[0].key, /^duplicate:[0-9a-f]{64}$/);
  const changed = {
    answer: [pair[0], { ...pair[1], expectedAnswer: 'changed answer never reviewed' }],
    criteria: [pair[0], { ...pair[1], reviewCriteria: 'New criteria' }],
    sources: [pair[0], { ...pair[1], sourceRefs: [{ ...source, fileId: '00000000-0000-4000-8000-000000000003' }] }],
    membership: [...pair, row({ caseKey: 'c', input: 'Is it returnable?', expectedAnswer: 'sometimes' })],
    renamed: [pair[0], { ...pair[1], caseKey: 'b2' }],
  };
  for (const [label, cases] of Object.entries(changed)) {
    assert.notEqual(keyOf(cases), reviewed, `${label} change needs a fresh acknowledgement`);
    const stale = computeEvalIssues({ cases, notes: [{ key: reviewed, note: 'Reviewed the original yes/no answers.' }], sources: catalog });
    assert.equal(stale.find((issue) => issue.group === 'conflict').open, true, `${label}: the old note is not applied`);
    assert.equal(stale.find((issue) => issue.group === 'conflict').note, null, `${label}: the old note is not shown as this finding's note`);
  }
  const sameFacts = [{ ...pair[0], category: 'other', severity: 'minor' }, pair[1]];
  assert.equal(keyOf(sameFacts), reviewed, 'labels that are not facts about the answer keep the acknowledgement');
});

test('an acknowledgement identity is the SHA-256 of the reviewed conflict, so different evidence is never the same consent', () => {
  // These two answers collide under the 32-bit fold an earlier draft used (found by a bounded synthetic scan,
  // eval-repair-collision-probe.mjs). They must be distinct identities, and a note for one must not open the other.
  const pair = (answer) => [
    { caseKey: 'a', input: 'same question', expectedAnswer: answer, reviewCriteria: null, sourceRefs: [] },
    { caseKey: 'b', input: 'same question', expectedAnswer: 'other', reviewCriteria: null, sourceRefs: [] },
  ];
  const conflictOf = (cases, notes = []) => computeEvalIssues({ cases, notes, sources: catalog }).find((issue) => issue.group === 'conflict');
  const first = conflictOf(pair('synthetic-2c0fbbaee715645f'));
  const second = conflictOf(pair('synthetic-656d5be9b8439710'), [{ key: first.key, note: 'Reviewed the first answer only.' }]);
  assert.notEqual(second.key, first.key);
  assert.deepEqual([second.open, second.note], [true, null]);
  assert.equal(conflictOf(pair('synthetic-2c0fbbaee715645f'), [{ key: first.key, note: 'Reviewed.' }]).open, false);
  // The identity is pinned: membership, exact expectation, criteria and source references, ordered by case key.
  const identity = (members) => `conflict:${snapshotHash({ question: 'same question', members })}`;
  assert.equal(first.key, identity([
    { caseKey: 'a', expectedAnswer: 'synthetic-2c0fbbaee715645f', reviewCriteria: null, sourceRefs: [] },
    { caseKey: 'b', expectedAnswer: 'other', reviewCriteria: null, sourceRefs: [] },
  ]));
  const [a, b] = pair('x');
  const cited = conflictOf([b, { ...a, reviewCriteria: 'Cite the policy.', sourceRefs: [{ ...source, fileId: '00000000-0000-4000-8000-000000000003' }] }]);
  assert.equal(cited.key, identity([
    { caseKey: 'a', expectedAnswer: 'x', reviewCriteria: 'Cite the policy.', sourceRefs: [{ projectId: source.projectId, versionId: source.versionId, fileId: '00000000-0000-4000-8000-000000000003' }] },
    { caseKey: 'b', expectedAnswer: 'other', reviewCriteria: null, sourceRefs: [] },
  ]));
  // Two conflicts in one set are two identities; a note for one never covers the other.
  const twoQuestions = [...pair('x'), { caseKey: 'c', input: 'another question', expectedAnswer: 'yes', reviewCriteria: null, sourceRefs: [] }, { caseKey: 'd', input: 'another question', expectedAnswer: 'no', reviewCriteria: null, sourceRefs: [] }];
  const both = computeEvalIssues({ cases: twoQuestions, notes: [{ key: cited.key, note: 'Reviewed.' }, { key: conflictOf(pair('x')).key, note: 'Reviewed x/other.' }], sources: catalog }).filter((issue) => issue.group === 'conflict');
  assert.deepEqual(both.map((issue) => [issue.caseKeys.join(','), issue.open]), [['a,b', false], ['c,d', true]]);
});

test('acceptance rates are validated as sent: no rounding before the bounds or precision check', () => {
  const rate = (minPassRate) => validateAcceptance({ ...defaultAcceptance(), minPassRate });
  for (const bad of [-0.00001, 1.00001, 0.900049, 0.00001, 1e-7, 0.12345, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, '0.9', null]) {
    assert.match(rate(bad).error ?? '', /between 0 and 1 with at most four decimal places/, String(bad));
  }
  for (const good of [0, 1, 0.9, 0.0001, 0.9999, 0.25, 0.1234, 1.0]) {
    assert.equal(rate(good).rule.minPassRate, good, String(good));
  }
  assert.ok(Object.is(rate(-0).rule.minPassRate, 0), 'a negative zero is stored as 0');
  assert.match(validateAcceptance({ ...defaultAcceptance(), minCoverage: 0.99999 }).error, /coverage between 0 and 1 with at most four decimal places/);
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
  // A checkout may rewrite line endings (core.autocrlf); the content, not the platform's newline, is what must match.
  const example = (name) => readFileSync(new URL(`../docs/examples/${name}`, import.meta.url), 'utf8');
  const lines = (text) => text.replace(/\r\n/g, '\n');
  assert.equal(lines(example('eval-cases.example.jsonl')), SYNTHETIC_CASES);
  assert.equal(lines(example('eval-predictions.example.jsonl')), SYNTHETIC_PREDICTIONS);
  const ids = ['case-returns-window', 'case-warranty-power', 'case-store-hours'];
  assert.deepEqual(parseCaseJsonl(example('eval-cases.example.jsonl')).map((item) => item.caseKey), ids, 'the file parses as checked out');
  assert.deepEqual(parsePredictionJsonl(example('eval-predictions.example.jsonl'), new Set(ids)).map((item) => item.status), ['answered', 'answered', 'error']);
  assert.equal(parsePredictionJsonl(SYNTHETIC_PREDICTIONS, new Set(ids)).length, 3);
  // The page imports only this module; it must stay import-free so the web bundle never pulls in node:crypto.
  assert.doesNotMatch(readFileSync(new URL('../src/lib/eval-shared.js', import.meta.url), 'utf8'), /^\s*import\b/m);
});
