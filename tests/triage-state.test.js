import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { countChanges, runnerRows } from '../src/lib/eval-shared.js';
import { filterTriageRows, loadRunPair, runnerFacts, runPairKey, visibleRunPair } from '../web/src/app/triage-state.js';

// Synthetic UI-seam requests only: no API, browser, database, recipe or model is executed.
const scope = () => Object.fromEntries(['workspaceId', 'projectId', 'setId', 'versionId', 'baselineId', 'candidateId'].map((key) => [key, randomUUID()]));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const run = (id, versionId, overrides = {}) => ({ id, versionId, scored: true, status: 'complete', results: [], ...overrides });
const responsePair = (s) => [{ run: run(s.baselineId, s.versionId) }, { run: run(s.candidateId, s.versionId) }];

test('selection synchronously hides old results even before effect cleanup or a new load', async () => {
  const previous = scope();
  const next = { ...previous, candidateId: randomUUID() };
  const waiting = [deferred(), deferred()];
  let state = { key: runPairKey(previous), detail: { baseline: 'old evidence' }, error: '' };
  assert.equal(visibleRunPair(state, runPairKey(next), true), null);
  let i = 0;
  const dispose = loadRunPair(previous, () => waiting[i++].promise, (value) => { state = value; });
  const replies = responsePair(previous);
  waiting.forEach((item, index) => item.resolve(replies[index]));
  await flush();
  assert.ok(state.detail, 'the old effect can finish before its cleanup');
  assert.equal(visibleRunPair(state, runPairKey(next), true), null, 'none of that old detail is renderable under the new selection');
  dispose();
  loadRunPair(next, (id) => Promise.resolve({ run: run(id, next.versionId) }), (value) => { state = value; });
  assert.equal(visibleRunPair(state, runPairKey(next), true).detail, null);
  await flush();
  assert.equal(visibleRunPair(state, runPairKey(next), true).detail.candidate.id, next.candidateId);
});

test('pair identity includes every tenant, project, case set, frozen version and selected run', () => {
  const selected = scope();
  const state = { key: runPairKey(selected), detail: { baseline: 'fixture evidence' }, error: '' };
  assert.equal(visibleRunPair(state, runPairKey(selected), true), state);
  for (const key of Object.keys(selected)) {
    assert.equal(visibleRunPair(state, runPairKey({ ...selected, [key]: randomUUID() }), true), null, key);
  }
  assert.equal(visibleRunPair(state, runPairKey(selected), false), null);
});

test('partial selection hides a stored fetch error as well as stored evidence', () => {
  const selected = scope();
  const state = { key: runPairKey(selected), detail: null, error: 'Fixture old fetch error' };
  assert.equal(visibleRunPair(state, runPairKey(selected), true).error, state.error);
  assert.equal(visibleRunPair(state, runPairKey(selected), false), null);
  assert.equal(visibleRunPair(state, runPairKey({ ...selected, candidateId: '' }), false), null);
  assert.equal(visibleRunPair(state, runPairKey({ ...selected, candidateId: randomUUID() }), true), null);
});

test('a new pair clears its old error immediately and an abandoned rejection cannot overwrite it', async () => {
  const previous = scope();
  const next = { ...previous, candidateId: randomUUID() };
  const failed = deferred();
  let state;
  const dispose = loadRunPair(previous, () => failed.promise, (value) => { state = value; });
  dispose();
  loadRunPair(next, (id) => Promise.resolve({ run: run(id, next.versionId) }), (value) => { state = value; });
  assert.equal(state.error, '');
  failed.reject(new Error('Fixture abandoned failure'));
  await flush();
  assert.equal(state.key, runPairKey(next));
  assert.equal(state.detail.candidate.id, next.candidateId);
  assert.equal(state.error, '');
});

test('an abandoned success cannot overwrite the newly loaded pair', async () => {
  const previous = scope();
  const next = { ...previous, baselineId: randomUUID() };
  const waiting = deferred();
  let state;
  const dispose = loadRunPair(previous, () => waiting.promise, (value) => { state = value; });
  dispose();
  loadRunPair(next, (id) => Promise.resolve({ run: run(id, next.versionId) }), (value) => { state = value; });
  await flush();
  const current = state;
  waiting.resolve({ run: run(previous.baselineId, previous.versionId) });
  await flush();
  assert.equal(state, current);
});

test('mismatched run, frozen version and partial response are refused without evidence', async () => {
  for (const defect of ['run', 'version', 'partial']) {
    const selected = scope();
    const replies = responsePair(selected);
    if (defect === 'run') replies[1].run.id = randomUUID();
    if (defect === 'version') replies[1].run.versionId = randomUUID();
    if (defect === 'partial') replies[1].run.status = 'partial';
    let state;
    let i = 0;
    loadRunPair(selected, () => Promise.resolve(replies[i++]), (value) => { state = value; });
    await flush();
    assert.equal(state.key, runPairKey(selected));
    assert.equal(state.detail, null, defect);
    assert.match(state.error, defect === 'version' ? /not on this frozen version/ : /not both complete and scored/);
  }
});

test('a current fetch failure is shown only for its exact selected pair', async () => {
  const selected = scope();
  let state;
  loadRunPair(selected, () => Promise.reject(new Error('Fixture request failure')), (value) => { state = value; });
  await flush();
  assert.equal(state.detail, null);
  assert.match(visibleRunPair(state, runPairKey(selected), true).error, /could not be loaded/);
  assert.equal(visibleRunPair(state, runPairKey({ ...selected, baselineId: randomUUID() }), true), null);
});

test('positive matrix buckets include all their rows instead of intersecting Attention', () => {
  const cases = ['kept', 'fixed', 'regressed', 'still'].map((caseKey) => ({ caseKey, severity: 'major' }));
  const result = (caseKey, verdict) => ({ caseKey, scores: { verdict } });
  const baseline = cases.map(({ caseKey }) => result(caseKey, ['kept', 'regressed'].includes(caseKey) ? 'pass' : 'fail'));
  const candidate = cases.map(({ caseKey }) => result(caseKey, ['kept', 'fixed'].includes(caseKey) ? 'pass' : 'fail'));
  const rows = runnerRows(cases, baseline, candidate);
  const counts = countChanges(rows);
  assert.deepEqual(filterTriageRows(rows, 'attention').map((row) => row.caseKey), ['regressed', 'still']);
  for (const bucket of ['kept', 'fixed', 'regressed', 'still']) {
    assert.equal(filterTriageRows(rows, bucket).length, counts[bucket]);
    assert.deepEqual(filterTriageRows(rows, bucket).map((row) => row.caseKey), [bucket]);
  }
  assert.equal(filterTriageRows(rows, 'all').length, 4);
});

test('critical and judgment filters preserve their existing case meaning', () => {
  const cases = [{ caseKey: 'fixture', severity: 'critical' }];
  const rows = runnerRows(cases, [], [{ caseKey: 'fixture', scores: { verdict: 'pass' } }]);
  assert.equal(filterTriageRows(rows, 'critical').length, 1);
  assert.equal(filterTriageRows(rows, 'judgment').length, 1);
  assert.equal(filterTriageRows(rows, 'attention').length, 1);
});

test('unknown recipes do not inherit an unsupported no-model execution claim', () => {
  const facts = Object.fromEntries(runnerFacts({ recipeId: 'fixture-other-recipe', settings: {} }));
  assert.equal(facts.Execution, 'Not recorded');
  assert.equal(facts.Model, 'None selected');
});
