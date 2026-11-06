import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { makeApp, json, postHeaders } from './helpers.js';

function client(app) {
  let cookies = {};
  const call = async (method, url, body, headers = {}) => {
    const res = await app.inject({
      method, url, cookies,
      headers: { ...(method === 'GET' ? {} : postHeaders), ...headers },
      payload: body === undefined ? undefined : json(body),
    });
    const sid = res.cookies.find((item) => item.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url) => call('GET', url), post: (url, body = {}, headers) => call('POST', url, body, headers) };
}

async function person(app, email) {
  const c = client(app);
  const signup = await c.post('/api/account/signup', { name: email.split('@')[0], email, password: 'long-enough-password' });
  assert.equal(signup.statusCode, 200, signup.body);
  await c.post('/api/account/verify', { code: signup.json().devCode });
  c.id = signup.json().user.id;
  return c;
}

const source = (projectId, versionId) => ({ projectId, versionId, fileId: null });

test('a member cannot start a case run, and a runner score is not the stored verdict', async () => {
  const store = createMemoryStore();
  const app = await makeApp({ store });
  const owner = await person(app, 'owner@case-run.example');
  const ws = (await owner.post('/api/workspaces', { name: 'Case run QA' })).json().workspace;
  const project = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name: 'Policy', task: 'Answer the return policy.', modalities: ['Text'], startingPoint: 'model' })).json().project;
  const where = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });
  const set = await store.createEvalSet({ ...where, createdBy: owner.id, name: 'Windows', purpose: 'development' });
  await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: 1, input: { id: 'window', input: 'How long?', expectedAnswer: '30 days', reviewCriteria: null, category: 'returns', severity: 'major', sources: [source(project.id, version.id)] } });
  const detail = await store.getEvalSet({ ...where, setId: set.id });
  const frozen = await store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: detail.set.revision, actorId: owner.id });
  const member = await person(app, 'member@case-run.example');
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: 'member@case-run.example', role: 'member', tokenHash: 'member-token', expiresAt: new Date(Date.now() + 86400000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash('member-token')).id, userId: member.id });
  const stranger = await person(app, 'stranger@case-run.example');
  const viewer = await person(app, 'viewer@case-run.example');
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: 'viewer@case-run.example', role: 'viewer', tokenHash: 'viewer-token', expiresAt: new Date(Date.now() + 86400000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash('viewer-token')).id, userId: viewer.id });
  const linked = await owner.post(`/api/workspaces/${ws.id}/runners`, { label: 'Bench' });
  assert.equal(linked.statusCode, 200, linked.body);
  const { runner, key } = linked.json();
  const bearer = { authorization: `Bearer ${key}` };
  const beat = await app.inject({ method: 'POST', url: '/api/runner/heartbeat', headers: { ...bearer, 'content-type': 'application/json' }, payload: json({ capabilities: { platform: 'test', runnerVersion: '0', gpus: [], ollama: { reachable: false, models: [] }, sandbox: { available: true, engine: 'docker', version: 'test', gpu: false } } }) });
  assert.equal(beat.statusCode, 200, beat.body);
  const runs = `/api/workspaces/${ws.id}/projects/${project.id}/evaluations/${set.id}/versions/${frozen.id}/runs`;
  const body = { runnerId: runner.id, role: 'candidate', idempotencyKey: 'case-run-http-1', candidate: { corpus: '30 days', prompt: 'Keep this prompt.', retrievalK: 1, boosts: [] } };
  assert.equal((await member.post(runs, body)).statusCode, 403);
  assert.equal((await viewer.post(runs, body)).statusCode, 403);
  assert.equal((await stranger.get(runs)).statusCode, 404);
  assert.equal((await stranger.get(`${runs}/00000000-0000-4000-8000-000000000001`)).statusCode, 404);
  const missingVersion = runs.replace(frozen.id, '00000000-0000-4000-8000-000000000099');
  assert.equal((await owner.get(missingVersion)).statusCode, 404);
  assert.equal((await owner.post(missingVersion, body)).statusCode, 404);
  const queued = await owner.post(`/api/workspaces/${ws.id}/jobs`, { kind: 'case_eval', runnerId: runner.id, idempotencyKey: 'not-this-queue' });
  assert.equal(queued.statusCode, 400);
  const started = await owner.post(runs, body);
  assert.equal(started.statusCode, 200, started.body);
  const run = started.json().run;
  assert.equal(run.scored, false);
  assert.equal(run.settings.promptUsed, false);
  const replay = await owner.post(runs, body);
  assert.equal(replay.json().run.id, run.id);
  const lease = await app.inject({ method: 'POST', url: '/api/runner/lease', headers: bearer });
  const token = lease.json().job.leaseToken;
  const inputs = await app.inject({ method: 'POST', url: `/api/runner/jobs/${run.jobId}/inputs`, headers: { ...bearer, 'content-type': 'application/json' }, payload: json({ leaseToken: token }) });
  assert.equal(inputs.statusCode, 200, inputs.body);
  assert.equal(inputs.json().cases[0].expectedAnswer, undefined);
  const rejected = await app.inject({ method: 'POST', url: `/api/runner/jobs/${run.jobId}/case-results`, headers: { ...bearer, 'content-type': 'application/json' }, payload: json({ leaseToken: token, results: [{ caseKey: 'nope', output: '30 days' }] }) });
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.json().error, /Nothing was saved/);
  const posted = await app.inject({ method: 'POST', url: `/api/runner/jobs/${run.jobId}/case-results`, headers: { ...bearer, 'content-type': 'application/json' }, payload: json({ leaseToken: token, results: [{ caseKey: 'window', output: 'nope', citations: ['p1'], scores: { verdict: 'pass', exact: true } }] }) });
  assert.equal(posted.statusCode, 200, posted.body);
  const finished = await app.inject({ method: 'POST', url: `/api/runner/jobs/${run.jobId}/finish`, headers: { ...bearer, 'content-type': 'application/json' }, payload: json({ leaseToken: token, outcome: 'succeeded', result: { recipe: 'support-qa', recipeVersion: '1', answered: 1, errors: 0 } }) });
  assert.equal(finished.statusCode, 200, finished.body);
  const read = await owner.get(`${runs}/${run.id}`);
  assert.equal(read.statusCode, 200, read.body);
  const settled = read.json().run;
  assert.equal(settled.status, 'complete');
  assert.equal(settled.results[0].scores.verdict, 'fail');
  assert.equal(settled.results[0].scores.exact, false);
  assert.equal((await owner.get(runs)).json().runs[0].results, undefined);
  assert.equal((await member.get(`${runs}/${run.id}`)).statusCode, 200);
  assert.equal((await viewer.get(runs)).statusCode, 200);
  assert.equal((await viewer.post(runs, { ...body, idempotencyKey: 'viewer-cannot-start' })).statusCode, 403);
  const wide = await owner.post(runs, { ...body, idempotencyKey: 'case-run-http-big', candidate: { ...body.candidate, corpus: 'a'.repeat(40_000) } });
  assert.equal(wide.statusCode, 200, wide.body);
  const huge = await owner.post(runs, { ...body, idempotencyKey: 'case-run-http-huge', candidate: { ...body.candidate, corpus: 'a'.repeat(100_001) } });
  assert.equal(huge.statusCode, 409, huge.body);
  assert.match(huge.json().error, /100,000/);
  await app.close();
});
