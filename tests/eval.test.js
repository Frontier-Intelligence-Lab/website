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
