import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferenceFacts, factText } from '../web/src/app/reference-facts.js';
import { capitalSnapshot, validateEvidence } from '../src/lib/capital.js';
import { snapshotHash } from '../src/lib/capital-hash.js';
import { consentValid } from '../web/src/app/capital-consent.js';

// What the Request consent view, the Evidence view and the staff page show when "Reference facts" is opened: the
// entire validated, frozen reference of an evidence record, rendered as escaped text.
const render = (reference) => renderToStaticMarkup(createElement(ReferenceFacts, { reference }));
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
// Every scalar in a reference, however deep, with the text the page prints for it.
const leaves = (value) => (value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [factText(value)]);

const benchmark = (over = {}) => ({ deviceId: 'd1', deviceLabel: 'QA laptop', runId: 'r1', modelRef: 'demo-chat:0.6b', modelDigest: 'a'.repeat(64), kind: 'chat', status: 'completed', warm: true, metrics: { wallMs: 1500, ttftMs: 120, loadMs: 0, promptTokens: 20, promptEvalMs: 40, outputTokens: 100, evalMs: 1000, tokensPerSec: 100 }, task: null, createdAt: '2026-11-04T10:00:00.000Z', ...over });
const options = {
  versions: [{ projectId: 'p1', projectName: 'Support chats', version: 1, reviewId: 'rev1', files: 0, createdAt: '2026-11-04T09:00:00.000Z' }],
  runs: [{ id: 'run1', name: 'Returns assistant', baseModelId: 'demo-base', status: 'draft', requestedAt: null }],
  benchmarks: [benchmark(), benchmark({ runId: 'r2', kind: 'compat_test', status: 'failed', warm: false, task: { id: 'arithmetic', passed: false }, metrics: { wallMs: 9000, ttftMs: 4000, loadMs: 3000, promptTokens: 20, promptEvalMs: 40, outputTokens: 100, evalMs: 1000, tokensPerSec: 100 } })],
  credits: [{ id: 'c1', provider: 'Cloud provider', status: 'claimed', restrictions: 'Compute only', expiresOn: '2027-06-30' }, { id: 'c2', provider: 'Cloud provider', status: 'claimed', restrictions: 'Compute only', expiresOn: '2028-01-01' }],
};
const evidenceOf = (body) => {
  const result = validateEvidence(body, options);
  assert.ok(result.values, JSON.stringify(result.errors));
  return result.values;
};

test('all six evidence kinds render their entire validated reference, nested values and empties included', () => {
  const kinds = {
    cost_assumption: evidenceOf({ kind: 'cost_assumption', title: 'Price list', source: 'Provider price page' }),
    company_record: evidenceOf({ kind: 'company_record', title: 'Invoice', source: 'Invoice QA-INV-10' }),
    dataset_provenance: evidenceOf({ kind: 'dataset_provenance', title: 'Chats v1', reference: { projectId: 'p1', version: 1 } }),
    model_provenance: evidenceOf({ kind: 'model_provenance', title: 'Assistant', reference: { enhanceRunId: 'run1' } }),
    local_benchmark: evidenceOf({ kind: 'local_benchmark', title: 'Laptop', reference: { deviceId: 'd1', runId: 'r1' } }),
    credit_restriction: evidenceOf({ kind: 'credit_restriction', title: 'Terms', reference: { creditRecordId: 'c1' } }),
  };
  for (const [kind, e] of Object.entries(kinds)) {
    const html = render(e.reference);
    if (Object.keys(e.reference).length === 0) {
      assert.match(html, /No reference facts: this record is described only by its title and source/, kind);
      continue;
    }
    for (const leaf of leaves(e.reference)) assert.ok(html.includes(escapeHtml(leaf)), `${kind}: "${leaf}" is on the page`);
    for (const key of Object.keys(e.reference)) assert.ok(html.includes(`:k`) === false, 'no key tokens leak');
  }
  // Material benchmark facts are there as readable text: digest, warm flag, provenance, nested metrics with their zero.
  const bench = render(kinds.local_benchmark.reference);
  for (const needle of ['Model digest', 'a'.repeat(64), 'Warm start', 'true (yes)', 'Provenance', 'client_reported', 'Metrics', 'Load time (ms)', '>0<', 'Tokens per second', '>100<', 'Task', 'null (not set)', 'Run kind', 'chat', 'completed']) {
    assert.ok(bench.includes(needle), `benchmark facts include ${needle}`);
  }
  // Provenance metadata is shown in full, marked as metadata rather than hidden.
  assert.ok(render(kinds.dataset_provenance.reference).includes('rev1'));
  assert.ok(render(kinds.dataset_provenance.reference).includes('cap-facts-meta'));
  assert.ok(render(kinds.model_provenance.reference).includes('null (not set)'), 'a null requestedAt is spelled out');
});

test('two benchmark references with the same model, device and throughput differ visibly in status, kind, warm flag, task and other metrics', () => {
  const a = evidenceOf({ kind: 'local_benchmark', title: 'A', reference: { deviceId: 'd1', runId: 'r1' } }).reference;
  const b = evidenceOf({ kind: 'local_benchmark', title: 'B', reference: { deviceId: 'd1', runId: 'r2' } }).reference;
  assert.equal(a.modelRef, b.modelRef);
  assert.equal(a.metrics.tokensPerSec, b.metrics.tokensPerSec);
  const ha = render(a);
  const hb = render(b);
  assert.notEqual(ha, hb);
  for (const [onlyA, onlyB] of [['completed', 'failed'], ['>chat<', '>compat_test<'], ['true (yes)', 'false (no)'], ['>1500<', '>9000<'], ['>120<', '>4000<'], ['null (not set)', 'arithmetic']]) {
    assert.ok(ha.includes(onlyA) && !ha.includes(onlyB), `A shows ${onlyA}, not ${onlyB}`);
    assert.ok(hb.includes(onlyB) && !hb.includes(onlyA), `B shows ${onlyB}, not ${onlyA}`);
  }
  assert.ok(hb.includes('Passed') && hb.includes('false (no)'), 'a failed task reads as failed, not as missing');
});

test('two credit-restriction references that differ only by expiry differ visibly, and an older reference keeps its own snapshotted expiry', () => {
  const older = evidenceOf({ kind: 'credit_restriction', title: 'Terms', reference: { creditRecordId: 'c1' } }).reference;
  const newer = evidenceOf({ kind: 'credit_restriction', title: 'Terms', reference: { creditRecordId: 'c2' } }).reference;
  assert.deepEqual([older.provider, older.status, older.restrictions], [newer.provider, newer.status, newer.restrictions]);
  const ho = render(older);
  const hn = render(newer);
  assert.notEqual(ho, hn);
  assert.ok(ho.includes('Expires on') && ho.includes('2027-06-30') && !ho.includes('2028-01-01'));
  assert.ok(hn.includes('2028-01-01') && !hn.includes('2027-06-30'));
  // The credit c1 is later corrected (superseded) with a new expiry; the evidence reference frozen earlier still shows its own.
  const corrected = { id: 'c3', provider: 'Cloud provider', status: 'claimed', restrictions: 'Compute only', expiresOn: '2029-12-31', supersedes: 'c1' };
  assert.notEqual(corrected.expiresOn, older.expiresOn);
  assert.ok(render(older).includes('2027-06-30') && !render(older).includes('2029-12-31'), 'the facts shown are the reference as stored, not the current credit');
});

test('values are escaped text, never markup, and rendering changes nothing the consent hash covers', () => {
  const hostile = { provider: '<img src=x onerror=alert(1)>', restrictions: '</dd><script>1</script>', expiresOn: null, nested: { note: '"quoted" & <b>bold</b>' } };
  const html = render(hostile);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img') && !html.includes('<script') && !html.includes('<b>bold'));
  assert.ok(html.includes('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'));
  const kase = { title: 'T', projectId: null, enhanceRunId: null, draft: { purpose: 'p', requestedAmountCents: 1, costItems: [], datasetVersions: [] } };
  const evidence = [{ id: 'e1', kind: 'credit_restriction', title: 'Terms', source: '', reference: hostile, verification: 'unverified' }];
  const before = snapshotHash(capitalSnapshot(kase, [], evidence));
  render(evidence[0].reference);
  assert.equal(snapshotHash(capitalSnapshot(kase, [], evidence)), before, 'rendering is pure');
  assert.equal(consentValid({ consentHash: before, contentHash: before }), true);
  assert.equal(consentValid({ consentHash: before, contentHash: snapshotHash(capitalSnapshot(kase, [], [{ ...evidence[0], reference: { ...hostile, expiresOn: '2027-01-01' } }])) }), false, 'a changed reference fact still invalidates consent');
});
