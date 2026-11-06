import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { snapshotHash } from '../src/lib/capital-hash.js';
import { MAX_CASES, MAX_IMPORT_BYTES } from '../src/lib/eval.js';
import { makeApp, json, postHeaders, reviewerFixture } from './helpers.js';

const STAFF = 'staff@valcairn-qa.example';

function client(app) {
  let cookies = {};
  const call = async (method, url, body) => {
    const res = await app.inject({ method, url, cookies, headers: method === 'GET' ? {} : postHeaders, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url) => call('GET', url), post: (url, body = {}) => call('POST', url, body) };
}

async function person(app, email) {
  const c = client(app);
  const s = await c.post('/api/account/signup', { name: email.split('@')[0], email, password: 'long-enough-password' });
  assert.equal(s.statusCode, 200, s.body);
  await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

async function setup() {
  const store = createMemoryStore();
  const reviewer = await reviewerFixture();
  const app = await makeApp({ store, env: { STAFF_EMAILS: STAFF, REVIEWERS_JSON: JSON.stringify([{ username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash: reviewer.passwordHash }]) } });
  const owner = await person(app, 'owner@qa-synthetic.example');
  const ws = (await owner.post('/api/workspaces', { name: 'QA ONLY Synthetic Support' })).json().workspace;
  const { project } = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name: 'Policy assistant', task: 'Answer the return policy.', modalities: ['Text'], startingPoint: 'model' })).json();
  const where = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });
  const training = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name: 'Training only', task: 'Answer the return policy.', modalities: ['Text'], startingPoint: 'model' })).json().project;
  await store.updateProject({ workspaceId: ws.id, projectId: training.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'] } } });
  const trainingReview = await store.submitForReview({ workspaceId: ws.id, projectId: training.id, submittedBy: owner.id });
  await store.decideReview({ reviewId: trainingReview.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const trainingVersion = await store.createDatasetVersion({ workspaceId: ws.id, projectId: training.id, createdBy: owner.id });
  const join = async (email, role) => {
    const c = await person(app, email);
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email, role, tokenHash: `${email}-token`, expiresAt: new Date(Date.now() + 86400000) }] });
    await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(`${email}-token`)).id, userId: c.id });
    return c;
  };
  return { app, store, owner, ws, project, version, trainingVersion, join, base: `/api/workspaces/${ws.id}/projects/${project.id}/evaluations` };
}

const line = (row) => JSON.stringify(row);
const sourceOf = (project, version) => ({ projectId: project.id, versionId: version.id, fileId: null });

test('every evaluation route denies the wrong tenant and role', async () => {
  const { app, owner, ws, project, base, join } = await setup();
  const set = (await owner.post(base, { name: 'Weekday policy', purpose: 'development' })).json().set;
  const setPath = `${base}/${set.id}`;
  const viewer = await join('viewer@qa-synthetic.example', 'viewer');
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const member = await join('member@qa-synthetic.example', 'member');
  const stranger = await person(app, 'stranger@qa-synthetic.example');
  const staff = await person(app, STAFF);
  const anon = client(app);
  const other = await person(app, 'other@qa-synthetic.example');
  const otherWs = (await other.post('/api/workspaces', { name: 'Other QA' })).json().workspace;
  const foreign = `/api/workspaces/${otherWs.id}/projects/${project.id}/evaluations`;
  const reads = [base, setPath, `${setPath}/versions/00000000-0000-4000-8000-000000000099`, `${base}/comparisons/00000000-0000-4000-8000-000000000099`, `${base}/reports/00000000-0000-4000-8000-000000000099`, `${base}/reports/00000000-0000-4000-8000-000000000099/export`];
  const writes = [
    [base, { name: 'Nope', purpose: 'development' }],
    [setPath, { expectedRevision: 1, name: 'Renamed' }],
    [`${setPath}/cases`, { expectedRevision: 1, case: { id: 'x', input: 'Q', expectedAnswer: 'A', sources: [] } }],
    [`${setPath}/cases/00000000-0000-4000-8000-000000000099/delete`, { expectedRevision: 1 }],
    [`${setPath}/import`, { expectedRevision: 1, jsonl: '{"id":"z","input":"Q","expectedAnswer":"A","sources":[]}\n' }],
    [`${setPath}/issues/note`, { expectedRevision: 1, key: 'missing', note: 'no' }],
    [`${setPath}/issues/note/delete`, { expectedRevision: 1, key: 'missing' }],
    [`${setPath}/freeze`, { expectedRevision: 1 }],
    [`${setPath}/reopen`, {}],
    [`${setPath}/versions/00000000-0000-4000-8000-000000000099/predictions`, { role: 'baseline', label: 'x', jsonl: '{"id":"z","status":"answered","output":"A"}\n' }],
    [`${setPath}/comparisons`, { versionId: '00000000-0000-4000-8000-000000000099', baselineBatchId: '00000000-0000-4000-8000-000000000098', candidateBatchId: '00000000-0000-4000-8000-000000000097' }],
    [`${base}/comparisons/00000000-0000-4000-8000-000000000099/blind`, { expectedRevision: 1, hideIdentity: true }],
    [`${base}/comparisons/00000000-0000-4000-8000-000000000099/judgments`, { expectedRevision: 1, caseKey: 'z', baselineDecision: 'pass' }],
    [`${base}/comparisons/00000000-0000-4000-8000-000000000099/approve`, { expectedRevision: 1, contentHash: 'a'.repeat(64) }],
  ];
  for (const actor of [viewer, finance]) {
    for (const url of reads) assert.equal((await actor.get(url)).statusCode, url.includes('00000000') ? 404 : 200, url);
    for (const [url, body] of writes) assert.equal((await actor.post(url, body)).statusCode, 403, url);
  }
  const preview = `${base}/comparisons/00000000-0000-4000-8000-000000000099/preview`;
  for (const actor of [viewer, finance, member]) assert.equal((await actor.get(preview)).statusCode, 403);
  for (const actor of [stranger, staff]) assert.equal((await actor.get(preview)).statusCode, 404);
  assert.equal((await anon.get(preview)).statusCode, 401);
  assert.equal((await member.post(`${setPath}/freeze`, { expectedRevision: 1 })).statusCode, 403);
  const memberCase = await member.post(`${setPath}/cases`, { expectedRevision: set.revision, case: { id: 'member-case', input: 'Who answers?', expectedAnswer: 'A person.', sources: [] } });
  assert.equal(memberCase.statusCode, 200, memberCase.body);
  for (const actor of [stranger, staff]) {
    for (const url of [base, ...reads]) assert.equal((await actor.get(url)).statusCode, 404, url);
    for (const [url, body] of writes) assert.equal((await actor.post(url, body)).statusCode, 404, url);
  }
  for (const url of reads) assert.equal((await anon.get(url)).statusCode, 401, url);
  for (const [url, body] of writes) assert.equal((await anon.post(url, body)).statusCode, 401, url);
  assert.equal((await other.get(foreign)).statusCode, 404);
  assert.equal((await other.get(`${foreign}/${set.id}`)).statusCode, 404);
  assert.equal((await owner.get(`/api/workspaces/${ws.id}/projects/${project.id}`)).json().project.id, project.id);
});

test('imports roll back, scores keep the denominator, and the export is the approved snapshot', async () => {
  const { owner, project, version, trainingVersion, join, base } = await setup();
  const viewer = await join('viewer@qa-synthetic.example', 'viewer');
  const member = await join('member@qa-synthetic.example', 'member');
  const source = sourceOf(project, version);
  const created = await owner.post(base, { name: 'Policy answers', purpose: 'final_assessment' });
  assert.equal(created.statusCode, 200, created.body);
  assert.match(created.json().set.purpose, /final_assessment/);
  const setPath = `${base}/${created.json().set.id}`;
  let revision = created.json().set.revision;
  const before = async () => (await owner.get(setPath)).json();

  const malformed = await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: '{not json\n' });
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.json().error, /Nothing was saved/);
  assert.equal((await before()).cases.length, 0);
  const huge = await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: 'x'.repeat(MAX_IMPORT_BYTES + 1) });
  assert.equal(huge.statusCode, 400);
  assert.equal((await before()).cases.length, 0);
  const tooMany = Array.from({ length: MAX_CASES + 1 }, (_, i) => line({ id: `c${i}`, input: 'Question', expectedAnswer: 'Answer', sources: [source] })).join('\n');
  assert.equal((await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: tooMany })).statusCode, 400);
  const repeated = `${line({ id: 'returns', input: 'How long is the return window?', expectedAnswer: '30 days', sources: [source] })}\n`.repeat(2);
  assert.equal((await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: repeated })).statusCode, 400);

  const good = [
    { id: 'returns', input: 'How long is the return window?', expectedAnswer: '30 days', reviewCriteria: 'Name the window.', category: 'returns', severity: 'critical', sources: [source] },
    { id: 'hours', input: 'What time does the shop close?', expectedAnswer: '18:00', category: 'hours', severity: 'minor', sources: [source] },
  ];
  const imported = await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: `${good.map(line).join('\n')}\n` });
  assert.equal(imported.statusCode, 200, imported.body);
  revision = imported.json().revision;
  assert.equal(imported.json().cases.length, 2);
  const collide = `${line({ id: 'returns', input: 'Changed', expectedAnswer: 'no', sources: [source] })}\n${line({ id: 'extra', input: 'A new question', expectedAnswer: 'yes', sources: [source] })}\n`;
  assert.equal((await owner.post(`${setPath}/import`, { expectedRevision: revision, jsonl: collide })).statusCode, 400);
  assert.equal((await before()).cases.map((row) => row.caseKey).join(), 'hours,returns');

  const trainingCase = await owner.post(`${setPath}/cases`, { expectedRevision: revision, case: { id: 'train-only', input: 'May we use the training corpus as the test?', expectedAnswer: 'No.', sources: [{ projectId: trainingVersion.projectId, versionId: trainingVersion.id }] } });
  assert.equal(trainingCase.statusCode, 200, trainingCase.body);
  revision = (await before()).set.revision;
  const blocked = await before();
  assert.equal(blocked.issues.some((issue) => issue.open && /does not permit testing/.test(issue.detail)), true);
  const missingFile = await owner.post(`${setPath}/cases`, { expectedRevision: revision, case: { id: 'missing-file', input: 'Which file says so?', expectedAnswer: 'The policy.', sources: [{ ...source, fileId: '00000000-0000-4000-8000-000000000077' }] } });
  assert.equal(missingFile.statusCode, 200, missingFile.body);
  revision = (await before()).set.revision;
  assert.equal((await before()).issues.some((issue) => /not in the frozen version/.test(issue.detail)), true);
  const inaccessible = await owner.post(`${setPath}/cases`, { expectedRevision: revision, case: { id: 'elsewhere', input: 'What does another workspace say?', expectedAnswer: 'Nothing.', sources: [{ projectId: '00000000-0000-4000-8000-000000000088', versionId: '00000000-0000-4000-8000-000000000099' }] } });
  assert.equal(inaccessible.statusCode, 200, inaccessible.body);
  revision = (await before()).set.revision;
  const refused = await owner.post(`${setPath}/freeze`, { expectedRevision: revision });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'issues_open');
  assert.equal((await before()).set.status, 'draft');
  for (const row of (await before()).cases.filter((item) => item.caseKey !== 'returns' && item.caseKey !== 'hours')) {
    const removed = await owner.post(`${setPath}/cases/${row.id}/delete`, { expectedRevision: revision });
    assert.equal(removed.statusCode, 200, removed.body);
    revision = (await before()).set.revision;
  }
  assert.equal((await before()).issues.filter((issue) => issue.open).length, 0);
  assert.equal((await member.post(`${setPath}/freeze`, { expectedRevision: revision })).statusCode, 403);
  const frozen = await owner.post(`${setPath}/freeze`, { expectedRevision: revision });
  assert.equal(frozen.statusCode, 200, frozen.body);
  const versionId = frozen.json().version.id;
  const again = await owner.post(`${setPath}/freeze`, { expectedRevision: revision });
  assert.equal(again.json().version.id, versionId);
  assert.equal((await owner.post(`${setPath}/cases`, { expectedRevision: revision, case: { id: 'late', input: 'Too late', expectedAnswer: 'No.', sources: [source] } })).statusCode, 409);

  const pred = `${setPath}/versions/${versionId}/predictions`;
  const baselineJsonl = `${line({ id: 'returns', status: 'answered', output: '30 days' })}\n${line({ id: 'hours', status: 'answered', output: '18:00' })}\n`;
  const unknown = await owner.post(pred, { role: 'candidate', label: 'bad', filename: 'bad.jsonl', jsonl: `${line({ id: 'missing', status: 'answered', output: 'x' })}\n` });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /Nothing was saved/);
  const emptyAnswer = await owner.post(pred, { role: 'candidate', label: 'empty', jsonl: `${line({ id: 'returns', status: 'answered', output: '  ' })}\n` });
  assert.equal(emptyAnswer.statusCode, 400);
  assert.match(emptyAnswer.json().error, /empty answer was not stored/);
  const errorWithText = await owner.post(pred, { role: 'candidate', label: 'mixed', jsonl: `${line({ id: 'returns', status: 'error', output: 'partial', error: 'timeout' })}\n` });
  assert.equal(errorWithText.statusCode, 400);
  assert.equal((await before()).versions[0].batches.length, 0);
  const baseline = await owner.post(pred, { role: 'baseline', label: 'old', filename: 'old.jsonl', claimedSystem: { identity: 'claimed-old', configuration: 'prompt-a' }, claimedScorer: 'customer-scorer', jsonl: baselineJsonl });
  assert.equal(baseline.statusCode, 200, baseline.body);
  const replay = await owner.post(pred, { role: 'baseline', label: 'old', jsonl: baselineJsonl });
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().batch.id, baseline.json().batch.id);
  const partial = await owner.post(pred, { role: 'candidate', label: 'partial', jsonl: `${line({ id: 'returns', status: 'answered', output: 'a refund' })}\n` });
  assert.equal(partial.statusCode, 200, partial.body);
  const partialComparison = await owner.post(`${setPath}/comparisons`, { versionId, baselineBatchId: baseline.json().batch.id, candidateBatchId: partial.json().batch.id });
  const partialReview = await owner.get(`${base}/comparisons/${partialComparison.json().comparison.id}`);
  assert.equal(partialReview.json().summary.counts.eligible, 2);
  assert.equal(partialReview.json().summary.counts.candidate.missing, 1);
  assert.equal(partialReview.json().summary.counts.candidate.submitted, 1);
  assert.equal(partialReview.json().summary.denominator, 'eligible');
  assert.equal(partialReview.json().summary.decision.result, 'insufficient_evidence');
  assert.equal(partialReview.json().summary.criticalFailures[0].caseKey, 'returns');
  assert.equal(partialReview.json().summary.passRate, 0);

  const full = await owner.post(pred, { role: 'candidate', label: 'new', claimedSystem: { identity: 'claimed-new' }, jsonl: `${line({ id: 'returns', status: 'answered', output: 'a refund' })}\n${line({ id: 'hours', status: 'answered', output: '18:00' })}\n` });
  const comparison = (await owner.post(`${setPath}/comparisons`, { versionId, baselineBatchId: baseline.json().batch.id, candidateBatchId: full.json().batch.id })).json().comparison;
  const blinded = await owner.post(`${base}/comparisons/${comparison.id}/blind`, { expectedRevision: comparison.revision, hideIdentity: true, swap: true });
  assert.equal(blinded.statusCode, 200, blinded.body);
  assert.equal(blinded.json().comparison.blind.swap, undefined);
  const named = await owner.post(`${base}/comparisons/${comparison.id}/judgments`, { expectedRevision: blinded.json().comparison.revision, caseKey: 'returns', baselineDecision: 'pass', candidateDecision: 'fail' });
  assert.equal(named.statusCode, 400);
  assert.match(named.json().error, /left and right/);
  const reviewed = await owner.post(`${base}/comparisons/${comparison.id}/judgments`, {
    expectedRevision: blinded.json().comparison.revision, caseKey: 'returns', note: 'The refund is not the policy.', leftDecision: 'fail', rightDecision: 'pass',
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().judgment.baselineDecision, undefined);
  const hidden = await owner.get(`${base}/comparisons/${comparison.id}`);
  assert.equal(hidden.json().baseline, undefined);
  assert.equal(hidden.json().comparison.baselineBatchId, undefined);
  assert.equal(typeof hidden.json().version.number, 'number');
  assert.equal(hidden.json().version.contentHash, frozen.json().version.contentHash);
  const hours = await owner.post(`${base}/comparisons/${comparison.id}/judgments`, {
    expectedRevision: reviewed.json().comparison.revision, caseKey: 'hours', note: 'The exact match missed the Sunday exception.', leftDecision: 'fail', rightDecision: 'pass', leftAdjudication: 'human',
  });
  assert.equal(hours.statusCode, 200, hours.body);
  assert.equal((await member.get(`${base}/comparisons/${comparison.id}/preview`)).statusCode, 403);
  const preview = await owner.get(`${base}/comparisons/${comparison.id}/preview`);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().assignment.swap, true);
  assert.equal(preview.json().baseline.label, 'old');
  assert.equal(preview.json().snapshot.decision.result, 'fail');
  assert.equal(preview.json().snapshot.criticalFailures[0].outcome, 'fail');
  assert.equal(preview.json().snapshot.cases.find((row) => row.caseKey === 'hours').candidate.auto.result, 'pass');
  assert.equal(preview.json().snapshot.cases.find((row) => row.caseKey === 'hours').candidate.human, 'fail');
  assert.equal(preview.json().snapshot.counts.eligible, 2);
  const staleContent = await owner.post(`${base}/comparisons/${comparison.id}/approve`, { expectedRevision: hours.json().comparison.revision, contentHash: 'b'.repeat(64) });
  assert.equal(staleContent.statusCode, 409);
  assert.equal(staleContent.json().code, 'content');
  const approved = await owner.post(`${base}/comparisons/${comparison.id}/approve`, { expectedRevision: hours.json().comparison.revision, contentHash: preview.json().contentHash });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().report.decision, 'fail');
  const retry = await owner.post(`${base}/comparisons/${comparison.id}/approve`, { expectedRevision: hours.json().comparison.revision, contentHash: preview.json().contentHash });
  assert.equal(retry.json().report.id, approved.json().report.id);
  const staleRevision = await owner.post(`${base}/comparisons/${comparison.id}/approve`, { expectedRevision: 1, contentHash: preview.json().contentHash });
  assert.equal(staleRevision.statusCode, 409);
  assert.equal(staleRevision.json().code, 'stale_revision');
  const report = await viewer.get(`${base}/reports/${approved.json().report.id}`);
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(snapshotHash(report.json().report.snapshot), report.json().report.contentHash);
  const exported = await viewer.get(`${base}/reports/${approved.json().report.id}/export`);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(exported.headers['content-disposition'], /attachment/);
  const body = exported.json();
  assert.equal(body.schema, 'valcairn.eval-report.export.v1');
  assert.equal(body.approvedBy.email, undefined);
  assert.equal(snapshotHash(body.snapshot), body.contentHash);
  assert.equal(body.contentHash, preview.json().contentHash);
  assert.equal(body.snapshot.cases.length, 2);
  assert.equal((await member.post(`${base}/comparisons/${comparison.id}/approve`, { expectedRevision: hours.json().comparison.revision, contentHash: preview.json().contentHash })).statusCode, 403);
  assert.equal((await viewer.post(`${setPath}/reopen`, {})).statusCode, 403);
  const reopened = await member.post(`${setPath}/reopen`, {});
  assert.equal(reopened.statusCode, 200, reopened.body);
  const returns = (await before()).cases.find((row) => row.caseKey === 'returns');
  const edited = await member.post(`${setPath}/cases`, { expectedRevision: reopened.json().set.revision, caseId: returns.id, case: { ...good[0], input: 'Edited after the report' } });
  assert.equal(edited.statusCode, 200, edited.body);
  const kept = await owner.get(`${setPath}/versions/${versionId}`);
  assert.equal(kept.json().version.cases.find((row) => row.caseKey === 'returns').input, 'How long is the return window?');
  assert.equal(kept.json().version.contentHash, frozen.json().version.contentHash);
  assert.equal((await owner.get(`${base}/reports/${approved.json().report.id}/export`)).json().snapshot.cases.find((row) => row.caseKey === 'returns').input, 'How long is the return window?');
});

test('a refused update leaves the draft and its revision unchanged', async () => {
  const { owner, base } = await setup();
  const created = await owner.post(base, { name: 'Reviewed original name', purpose: 'development' });
  assert.equal(created.statusCode, 200, created.body);
  const setPath = `${base}/${created.json().set.id}`;
  const before = (await owner.get(setPath)).json().set;
  assert.equal(before.revision, 1);
  const rule = { ...before.acceptance, minPassRate: 0.75 };
  const refusals = [
    { name: 'Mutated although rejected', purpose: 'invalid' },
    { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: { ...rule, scoreBasis: 'guess' } },
    { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: { ...rule, minPassRate: 0.900049 } },
    { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: rule, rubricVersion: 'Rubric V2!' },
  ];
  for (const patch of refusals) {
    const res = await owner.post(setPath, { expectedRevision: 1, ...patch });
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(res.json().code, 'invalid_import');
    assert.deepEqual((await owner.get(setPath)).json().set, before, `unchanged after ${JSON.stringify(patch)}`);
  }
  const applied = await owner.post(setPath, { expectedRevision: 1, name: 'Renamed after review', purpose: 'final_assessment', acceptance: rule, rubricVersion: 'rubric-v2' });
  assert.equal(applied.statusCode, 200, applied.body);
  const after = (await owner.get(setPath)).json().set;
  assert.deepEqual([after.revision, after.name, after.purpose, after.acceptance.minPassRate, after.rubricVersion], [2, 'Renamed after review', 'final_assessment', 0.75, 'rubric-v2']);
  assert.equal((await owner.post(setPath, { expectedRevision: 1, name: 'Stale' })).statusCode, 409);
});

test('a conflict does not hide duplicates, and an acknowledgement is tied to the facts that were reviewed', async () => {
  const { store, owner, ws, project, version, base } = await setup();
  const source = sourceOf(project, version);
  // A second frozen version that allows testing, so a source reference can change to another valid source.
  const second = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name: 'Second policy', task: 'Answer the return policy.', modalities: ['Text'], startingPoint: 'model' })).json().project;
  await store.updateProject({ workspaceId: ws.id, projectId: second.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const secondReview = await store.submitForReview({ workspaceId: ws.id, projectId: second.id, submittedBy: owner.id });
  await store.decideReview({ reviewId: secondReview.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const secondVersion = await store.createDatasetVersion({ workspaceId: ws.id, projectId: second.id, createdBy: owner.id });

  const set = (await owner.post(base, { name: 'Returns', purpose: 'development' })).json().set;
  const setPath = `${base}/${set.id}`;
  const state = async () => (await owner.get(setPath)).json();
  const question = 'Is the synthetic demo kettle returnable?';
  const imported = await owner.post(`${setPath}/import`, { expectedRevision: set.revision, jsonl: Array.from({ length: 10 }, (_, i) => line({ id: `c${i}`, input: question, expectedAnswer: i < 9 ? 'yes' : 'no', sources: [source] })).join('\n') });
  assert.equal(imported.statusCode, 200, imported.body);
  let detail = await state();
  const duplicate = detail.issues.find((issue) => issue.group === 'duplicate');
  const conflict = detail.issues.find((issue) => issue.group === 'conflict');
  assert.deepEqual([duplicate.caseKeys.length, duplicate.acknowledgeable, conflict.caseKeys.length, conflict.acknowledgeable], [9, false, 10, true]);
  assert.equal((await owner.post(`${setPath}/issues/note`, { expectedRevision: detail.set.revision, key: duplicate.key, note: 'Fine.' })).statusCode, 409);
  const ack = await owner.post(`${setPath}/issues/note`, { expectedRevision: detail.set.revision, key: conflict.key, note: 'Reviewed the yes/no answers.' });
  assert.equal(ack.statusCode, 200, ack.body);
  detail = await state();
  assert.deepEqual(detail.issues.map((issue) => [issue.group, issue.open]).sort(), [['conflict', false], ['duplicate', true]]);
  const refused = await owner.post(`${setPath}/freeze`, { expectedRevision: detail.set.revision });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual([refused.json().code, refused.json().open, (await state()).set.status], ['issues_open', 1, 'draft']);

  // Removing the copies changes the conflict's membership: the earlier note stays on record but no longer applies.
  for (const row of detail.cases.filter((item) => !['c0', 'c9'].includes(item.caseKey))) {
    const removed = await owner.post(`${setPath}/cases/${row.id}/delete`, { expectedRevision: (await state()).set.revision });
    assert.equal(removed.statusCode, 200, removed.body);
  }
  const expectOpenConflict = async (label) => {
    const current = await state();
    assert.deepEqual(current.issues.filter((issue) => issue.open).map((issue) => [issue.group, issue.note]), [['conflict', null]], label);
    const blocked = await owner.post(`${setPath}/freeze`, { expectedRevision: current.set.revision });
    assert.equal(blocked.statusCode, 409, `${label}: ${blocked.body}`);
    assert.equal(blocked.json().code, 'issues_open', label);
    const res = await owner.post(`${setPath}/issues/note`, { expectedRevision: current.set.revision, key: current.issues.find((issue) => issue.group === 'conflict').key, note: `Reviewed after ${label}.` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await state()).issues.filter((issue) => issue.open).length, 0, label);
  };
  const edit = async (caseKey, patch) => {
    const current = await state();
    const row = current.cases.find((item) => item.caseKey === caseKey);
    const res = await owner.post(`${setPath}/cases`, { expectedRevision: current.set.revision, caseId: row.id, case: { ...row, id: caseKey, sources: row.sourceRefs, ...patch } });
    assert.equal(res.statusCode, 200, res.body);
  };
  await expectOpenConflict('the membership change');
  await edit('c9', { expectedAnswer: 'changed answer never reviewed' });
  await expectOpenConflict('the answer edit');
  await edit('c9', { sources: [{ projectId: second.id, versionId: secondVersion.id, fileId: null }] });
  await expectOpenConflict('the source edit');
  await edit('c0', { reviewCriteria: 'Name the window.' });
  await expectOpenConflict('the criteria edit');
  const added = await owner.post(`${setPath}/cases`, { expectedRevision: (await state()).set.revision, case: { id: 'c10', input: question, expectedAnswer: 'sometimes', sources: [source] } });
  assert.equal(added.statusCode, 200, added.body);
  await expectOpenConflict('the new member');
  await edit('c0', { category: 'returns' });
  const final = await state();
  assert.equal(final.issues.filter((issue) => issue.open).length, 0, 'a label that is not a fact about the answer keeps the acknowledgement');
  assert.ok(final.notes.length >= 6, 'earlier notes stay on record');
  const frozen = await owner.post(`${setPath}/freeze`, { expectedRevision: final.set.revision });
  assert.equal(frozen.statusCode, 200, frozen.body);
  assert.deepEqual([frozen.json().version.qc.open, frozen.json().version.qc.issues.length, frozen.json().version.cases.length], [0, 1, 3]);
});

test('parallel freezes and identical imports do not create two copies', async () => {
  const { owner, project, version, base } = await setup();
  const source = sourceOf(project, version);
  const set = (await owner.post(base, { name: 'Race', purpose: 'development' })).json().set;
  const setPath = `${base}/${set.id}`;
  const saved = await owner.post(`${setPath}/cases`, { expectedRevision: 1, case: { id: 'a', input: 'Question a', expectedAnswer: '30 days', category: 'returns', sources: [source] } });
  assert.equal(saved.statusCode, 200, saved.body);
  const revision = (await owner.get(setPath)).json().set.revision;
  const frozen = await Promise.all([1, 2].map(() => owner.post(`${setPath}/freeze`, { expectedRevision: revision })));
  assert.equal(frozen.every((res) => res.statusCode === 200), true, frozen.map((res) => res.body).join('\n'));
  assert.equal(frozen[0].json().version.id, frozen[1].json().version.id);
  const jsonl = `${line({ id: 'a', status: 'answered', output: '30 days' })}\n`;
  const pred = `${setPath}/versions/${frozen[0].json().version.id}/predictions`;
  const imports = await Promise.all([1, 2].map(() => owner.post(pred, { role: 'baseline', label: 'same', jsonl })));
  assert.equal(imports.every((res) => res.statusCode === 200), true, imports.map((res) => res.body).join('\n'));
  assert.equal(imports[0].json().batch.id, imports[1].json().batch.id);
});
