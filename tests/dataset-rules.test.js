import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIssues, countInvalid, findInvalid, isStoredBox } from '../src/lib/dataset.js';
import { ruleProblem } from '../src/lib/onboarding.js';

// Rows as the earlier code could leave them: shared by both stores, so these rules hold for memory and Postgres alike.
const labelSet = [{ id: 'box', name: 'tear', scope: 'box', tone: 'orange' }, { id: 'tag', name: 'ok', scope: 'file', tone: 'plain' }];
const text = { id: 't', filename: 'notes.txt', contentType: 'text/plain', kind: 'image', sizeBytes: 5, duplicateOf: null };
const png = { id: 'p', filename: 'carton.png', contentType: 'image/png', kind: null, sizeBytes: 5, duplicateOf: null };
const project = { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload' }, labelSet };

test('a missing acceptance rule is a blocking issue that a note cannot clear', () => {
  const issues = computeIssues({ project: { ...project, success: null }, uploads: [png], annotations: [{ id: 'a', uploadId: 'p', labelId: 'tag', startMs: null, endMs: null, box: null }], notes: [{ key: 'acceptance', note: 'later' }] });
  const rule = issues.find((i) => i.key === 'acceptance');
  assert.equal(rule.blocking, true);
  assert.equal(rule.open, true);
  assert.equal(rule.fix.page, 'success');
});

test('stored labels and types that today would be refused are found and block review', () => {
  const annotations = [
    { id: 'a1', uploadId: 't', labelId: 'box', startMs: null, endMs: null, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { id: 'a2', uploadId: 'p', labelId: 'box', startMs: null, endMs: null, box: { x: 0.1, y: 0.1, w: 0.0000001, h: 0.2 } },
    { id: 'a3', uploadId: 'p', labelId: 'gone', startMs: null, endMs: null, box: null },
    { id: 'a4', uploadId: 'p', labelId: 'tag', startMs: 5, endMs: 9, box: null },
    { id: 'a5', uploadId: 'p', labelId: 'box', startMs: null, endMs: null, box: { h: 0.2, w: 0.3, x: 0.1, y: 0.2 } },
  ];
  const found = findInvalid({ uploads: [text, png], annotations, labelSet });
  assert.deepEqual(found.kinds.map((k) => k.upload.id), ['t']);
  assert.deepEqual(found.annotations.map((x) => x.annotation.id), ['a1', 'a2', 'a3', 'a4'], 'a5 is valid; jsonb key order does not matter');
  assert.match(found.annotations[0].reason, /not an image/);

  const issues = computeIssues({ project, uploads: [text, png], annotations, notes: [] });
  const keys = issues.filter((i) => i.blocking).map((i) => i.key);
  assert.ok(keys.includes('kind:t') && keys.includes('label:a1') && keys.includes('label:a2'));
  assert.equal(issues.find((i) => i.key === 'kind:t').fix.action, 'reset-kind');
  assert.equal(issues.find((i) => i.key === 'label:a1').fix.action, 'delete-annotation');
  assert.ok(issues.some((i) => i.key === 'unlabelled:image' && i.uploadId === 't'), 'an invalid label does not count as labelling the file');
  assert.ok(!issues.some((i) => i.key.startsWith('unlabelled:') && i.uploadId === 'p'), 'the PNG keeps its valid box');
});

test('frozen history is counted for a warning, not rewritten', () => {
  const manifest = { files: [text, png], labelSet, annotations: [{ id: 'a1', uploadId: 't', labelId: 'box', startMs: null, endMs: null, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] };
  const before = JSON.stringify(manifest);
  assert.deepEqual(countInvalid(manifest), { labels: 1, kinds: 1 });
  assert.equal(JSON.stringify(manifest), before);
  assert.deepEqual(countInvalid({}), { labels: 0, kinds: 0 });
});

test('a stored box must be exactly { x, y, w, h }: extra or missing keys are invalid, key order is not', () => {
  assert.equal(isStoredBox({ h: 0.5, w: 0.5, y: 0, x: 0 }), true, 'any key order');
  for (const bad of [{ x: 0, y: 0, w: 0.5, h: 0.5, extra: true }, { x: 0, y: 0, w: 0.5 }, { x: '0', y: 0, w: 0.5, h: 0.5 }, [0, 0, 0.5, 0.5], null, 'box']) {
    assert.equal(isStoredBox(bad), false, JSON.stringify(bad));
  }
  const annotations = [{ id: 'xk', uploadId: 'p', labelId: 'box', startMs: null, endMs: null, box: { x: 0, y: 0, w: 0.5, h: 0.5, extra: true } }];
  const found = findInvalid({ uploads: [png], annotations, labelSet });
  assert.deepEqual(found.annotations.map((x) => x.annotation.id), ['xk'], 'an extra key fails even though the four values are valid');
  assert.ok(computeIssues({ project, uploads: [png], annotations, notes: [] }).some((i) => i.key === 'label:xk' && i.blocking));
  const manifest = { files: [png], labelSet, annotations };
  const before = JSON.stringify(manifest);
  assert.deepEqual(countInvalid(manifest), { labels: 1, kinds: 0 });
  assert.equal(JSON.stringify(manifest), before, 'history is flagged, not rewritten');
});

test('an acceptance rule needs a target for a metric, or written criteria for a rubric or a data-quality bar', () => {
  assert.match(ruleProblem(null), /how this work will be judged/);
  assert.match(ruleProblem({}), /Choose how this work will be judged/, 'a stored rule with no known measure is incomplete');
  assert.match(ruleProblem({ measure: 'recall', target: null }), /score is good enough/);
  assert.equal(ruleProblem({ measure: 'recall', target: '95%' }), null);
  assert.match(ruleProblem({ measure: 'rubric', target: '95%' }), /criteria/);
  assert.equal(ruleProblem({ measure: 'rubric', criteria: 'two reviewers agree' }), null);
  assert.equal(ruleProblem({ measure: 'data_quality', criteria: 'every image has a box for each tear' }), null, 'data-only work needs no model metric');
  const incomplete = computeIssues({ project: { ...project, success: { measure: 'recall', target: null } }, uploads: [png], annotations: [], notes: [] }).find((i) => i.key === 'acceptance');
  assert.equal(incomplete.blocking, true);
  assert.match(incomplete.title, /incomplete/);
});

// Stored rules that never came through validateSuccess: the shared check holds them to the same bar, read only.
const LEGACY_RULES = [
  ['blank target', { measure: 'recall', target: '   ' }],
  ['blank criteria', { measure: 'data_quality', criteria: ' \n ' }],
  ['criteria as an object', { measure: 'data_quality', criteria: { empty: true } }],
  ['target as an array', { measure: 'precision', target: [] }],
  ['target as a number', { measure: 'accuracy', target: 95 }],
  ['unknown measure', { measure: 'unknown', target: '95%' }],
  ['missing measure', { target: '95%' }],
  ['criteria on a metric', { measure: 'recall', criteria: 'looks right' }],
  ['target on a written measure', { measure: 'rubric', target: '95%' }],
  ['overlong criteria', { measure: 'rubric', criteria: 'x'.repeat(1001) }],
  ['overlong target', { measure: 'recall', target: '9'.repeat(41) }],
  ['rule as an array', []],
];

test('a stored acceptance rule is checked for measure, field type, nonblank text and length', () => {
  for (const [name, rule] of LEGACY_RULES) {
    const before = JSON.stringify(rule);
    assert.ok(ruleProblem(rule), name);
    assert.equal(JSON.stringify(rule), before, `${name}: only read, never normalized`);
    const issue = computeIssues({ project: { ...project, success: rule }, uploads: [png], annotations: [], notes: [] }).find((i) => i.key === 'acceptance');
    assert.equal(issue?.blocking, true, `${name}: blocks review`);
  }
  // The limits are the API's own: the longest text the API saves is complete, and padding is not blankness.
  assert.equal(ruleProblem({ measure: 'rubric', criteria: 'x'.repeat(1000) }), null);
  assert.equal(ruleProblem({ measure: 'recall', target: '9'.repeat(40) }), null);
  assert.equal(ruleProblem({ measure: 'recall', target: ' 95% ' }), null);
});

test('a box the database marks outside the stored form is invalid, in drafts and in frozen history', () => {
  const labelSet = [{ id: 'b', name: 'tear', scope: 'box', tone: 'plain' }];
  // What node-postgres returns for a raw 0.100000000000000001: a JavaScript 0.1 that looks canonical.
  const box = { id: 'a1', uploadId: png.id, labelId: 'b', startMs: null, endMs: null, box: { x: 0.1, y: 0, w: 0.5, h: 0.5 } };
  assert.equal(findInvalid({ uploads: [png], annotations: [box], labelSet }).annotations.length, 0);
  assert.equal(findInvalid({ uploads: [png], annotations: [{ ...box, storedFormInvalid: true }], labelSet }).annotations.length, 1);
  const frozen = { files: [png], annotations: [box], labelSet };
  const before = JSON.stringify(frozen);
  assert.deepEqual(countInvalid(frozen), { labels: 0, kinds: 0 });
  assert.deepEqual(countInvalid(frozen, ['a1']), { labels: 1, kinds: 0 });
  assert.equal(JSON.stringify(frozen), before, 'the frozen record is not rewritten');
});
