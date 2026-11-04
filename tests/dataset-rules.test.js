import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIssues, countInvalid, findInvalid } from '../src/lib/dataset.js';

// Rows as the earlier code could leave them: shared by both stores, so these rules hold for memory and Postgres alike.
const labelSet = [{ id: 'box', name: 'tear', scope: 'box', tone: 'orange' }, { id: 'tag', name: 'ok', scope: 'file', tone: 'plain' }];
const text = { id: 't', filename: 'notes.txt', contentType: 'text/plain', kind: 'image', sizeBytes: 5, duplicateOf: null };
const png = { id: 'p', filename: 'carton.png', contentType: 'image/png', kind: null, sizeBytes: 5, duplicateOf: null };
const project = { success: { measure: 'recall' }, dataSource: { mode: 'upload' }, labelSet };

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
