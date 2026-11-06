import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptBatch, acceptPosted, decideRun, validateCandidate } from '../src/lib/case-run.js';
import { buildJobSpec, projectResult } from '../src/lib/jobs.js';
import { loadConfig } from '../src/config.js';

const cases = [{ caseKey: 'window', input: 'How long?', expectedAnswer: '30 days', reviewCriteria: null }];
const posted = (extra = {}) => new Map([['window', { caseKey: 'window', output: '30 days', errorKind: null, passages: [], citations: ['p1'], latencyMs: 1, ...extra }]]);
const corpus = [{ id: 'p1', citation: 'p1', text: '30 days' }];

test('exact fact, rubric and citation decide, and token overlap does not', () => {
  const pass = decideRun({ cases, posted: posted(), corpus });
  assert.equal(pass.results[0].scores.verdict, 'pass');
  assert.equal(pass.results[0].scores.tokenOverlapLabel, 'token overlap');
  assert.equal(pass.results[0].scores.decides, 'exact fact, rubric and citation');
  const uncited = decideRun({ cases, posted: posted({ citations: [] }), corpus });
  assert.equal(uncited.results[0].scores.verdict, 'needs_judgment');
  assert.equal(uncited.results[0].scores.exact, true);
  const rubric = decideRun({ cases: [{ ...cases[0], reviewCriteria: 'Name the window.' }], posted: posted(), corpus });
  assert.equal(rubric.results[0].scores.verdict, 'fail');
  assert.equal(rubric.results[0].explanation.includes('Name the window.'), false);
  assert.equal(rubric.results[0].explanation.includes('30 days'), false);
});

test('errors, a missing case and an empty source never become a score', () => {
  const both = decideRun({
    cases: [...cases, { caseKey: 'other', input: 'Else?', expectedAnswer: '30 days', reviewCriteria: null }],
    posted: new Map([['window', { caseKey: 'window', output: null, errorKind: 'timeout', passages: [], citations: [], latencyMs: null }]]),
    corpus,
  });
  assert.deepEqual([both.status, both.scored], ['failed', false]);
  assert.equal(both.results.every((row) => row.scores == null), true);
  const partial = decideRun({
    cases: [...cases, { caseKey: 'other', input: 'Else?', expectedAnswer: '30 days', reviewCriteria: null }],
    posted: new Map([
      ['window', { caseKey: 'window', output: null, errorKind: 'timeout', passages: [], citations: [], latencyMs: null }],
      ['other', { caseKey: 'other', output: '30 days', errorKind: null, passages: [], citations: ['p1'], latencyMs: 1 }],
    ]),
    corpus,
  });
  assert.deepEqual([partial.status, partial.scored], ['partial', false]);
  assert.equal(partial.results.find((row) => row.caseKey === 'other').explanation, null);
  assert.equal(partial.results.every((row) => row.scores == null), true);
  const empty = decideRun({ cases, posted: posted(), corpus: [] });
  assert.deepEqual([empty.status, empty.results[0].errorKind, empty.results[0].output, empty.scored], ['failed', 'no_source', null, false]);
});

test('a posted batch is all or nothing, and a runner score is ignored', () => {
  const known = new Set(['window']);
  assert.equal(acceptBatch([{ caseKey: 'window', output: '30 days' }, { caseKey: 'nope', output: '30 days' }], known).error.includes('Nothing was saved'), true);
  assert.equal(acceptBatch([{ caseKey: 'window', output: '30 days' }, { caseKey: 'window', output: 'later' }], known).error.includes('Nothing was saved'), true);
  assert.equal(acceptBatch([{ caseKey: 'window', output: '30 days', errorKind: 'timeout' }], known).error.includes('Nothing was saved'), true);
  assert.match(acceptPosted({ caseKey: 'window', errorKind: 'missing' }).error, /unknown error/);
  const accepted = acceptPosted({ caseKey: 'window', output: '30 days', scores: { verdict: 'pass' } });
  assert.equal(accepted.result.scores, undefined);
  assert.equal(validateCandidate({ candidate: { corpus: 'x'.repeat(100_001) }, catalog: [] }).error.includes('100,000'), true);
  assert.deepEqual(validateCandidate({ candidate: { modelId: 'missing' }, catalog: [] }).error.includes('catalog'), true);
  assert.equal(validateCandidate({ candidate: { corpus: '' }, catalog: [{ id: 'local' }] }).passages.length, 0);
});

test('the public job queue cannot start a case run, and its result is counts only', () => {
  assert.match(buildJobSpec({ kind: 'case_eval', run: null, catalog: [] }).errors.kind, /frozen evaluation/);
  assert.equal(projectResult('case_eval', { recipe: 'support-qa', recipeVersion: '1', answered: 2, errors: 1, scores: { verdict: 'pass' } }).scores, undefined);
  assert.equal(projectResult('case_eval', { recipe: 'support-qa' }), null);
  const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) };
  assert.equal(loadConfig(base).evalRecipeVersion, '1');
  assert.throws(() => loadConfig({ ...base, EVAL_RECIPE_VERSION: '' }), /EVAL_RECIPE_VERSION/);
  assert.throws(() => loadConfig({ ...base, EVAL_RECIPE_VERSION: 'has space' }), /EVAL_RECIPE_VERSION/);
});
