import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { LEASE_MS, MAX_ATTEMPTS, bearerKey, buildJobSpec, projectResult, stableJson, validateCapabilities, validateEvents, validateFinish } from '../src/lib/jobs.js';
import { FIXTURE_CATALOG, makeApp, json, postHeaders } from './helpers.js';

function client(app) {
  let cookies = {};
  const call = async (method, url, body, headers = {}) => {
    const res = await app.inject({ method, url, cookies, headers: { ...(method === 'GET' ? {} : postHeaders), ...headers }, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url) => call('GET', url), post: (url, body = {}, headers) => call('POST', url, body, headers) };
}

async function person(app, email) {
  const c = client(app);
  const s = await c.post('/api/account/signup', { name: email.split('@')[0], email, password: 'long-enough-password' });
  await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

// A runner is not a browser: bearer key, JSON body, no cookies and no Origin.
const runnerClient = (app, key) => {
  const call = (method, url, body) => app.inject({ method, url, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, payload: body === undefined ? undefined : json(body) });
  return { get: (url) => call('GET', url), post: (url, body = {}) => call('POST', url, body) };
};

const capabilities = { platform: 'linux-x86_64', runnerVersion: '0.1.0', gpus: [{ name: 'Test GPU', memoryMb: 24576, driver: '1.0' }], ollama: { reachable: true, version: '0.1.0', models: [{ name: 'demo-chat:0.6b', digest: 'sha256:abc', sizeBytes: 1 }] }, sandbox: { available: true, engine: 'docker', version: '1', gpu: true } };

async function setup({ clock } = {}) {
  const store = createMemoryStore(clock ? { now: () => clock.now } : {});
  const app = await makeApp({ store, env: { MODEL_CATALOG_FILE: FIXTURE_CATALOG } });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const join = async (email, role) => {
    const c = await person(app, email);
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email, role, tokenHash: `${role}-${email}`, expiresAt: new Date(Date.now() + 86400000) }] });
    await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(`${role}-${email}`)).id, userId: c.id });
    return c;
  };
  const base = `/api/workspaces/${ws.id}`;
  const link = async (label = 'Lab workstation') => {
    const res = await owner.post(`${base}/runners`, { label });
    assert.equal(res.statusCode, 200, res.body);
    return { ...res.json(), runnerApi: runnerClient(app, res.json().key) };
  };
  let n = 0;
  const queue = (runnerId, extra = {}) => owner.post(`${base}/jobs`, { kind: 'probe', runnerId, idempotencyKey: `request-key-${(n += 1)}`, ...extra });
  return { app, store, owner, ws, join, base, link, queue };
}

test('linking a runner returns its key once; only owners and admins link or revoke', async () => {
  const { app, owner, base, join, link } = await setup();
  const { runner, key } = await link();
  assert.match(key, /^vrk_[A-Za-z0-9_-]{43}$/);
  assert.equal(runner.status, 'active');
  assert.equal(runner.keyPrefix, key.slice(0, 10));
  const listed = (await owner.get(`${base}/runners`)).json().runners;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(key.slice(10)), 'the key is never shown again');
  assert.ok(!('keyHash' in listed[0]));

  const memberC = await join('m@acme-robotics.com', 'member');
  assert.equal((await memberC.get(`${base}/runners`)).statusCode, 200, 'members can see the workspace runners');
  assert.equal((await memberC.post(`${base}/runners`, { label: 'Mine' })).statusCode, 403);
  assert.equal((await memberC.post(`${base}/runners/${runner.id}/revoke`)).statusCode, 403);
  assert.equal((await owner.post(`${base}/runners`, { label: '   ' })).statusCode, 400);
  assert.equal((await owner.post(`${base}/runners`, { label: 'x'.repeat(81) })).statusCode, 400);
  const stranger = await person(app, 's@elsewhere.com');
  assert.equal((await stranger.get(`${base}/runners`)).statusCode, 404);
  assert.equal((await client(app).get(`${base}/runners`)).statusCode, 401);
  // Session-cookie writes still need this site's Origin.
  assert.equal((await owner.post(`${base}/runners`, { label: 'No origin' }, { origin: 'https://evil.example' })).statusCode, 403);
});

test('the runner API accepts only a live key whose linker still manages the workspace', async () => {
  const { app, store, ws, owner, base, join, link } = await setup();
  const admin = await join('a@acme-robotics.com', 'admin');
  const res = await admin.post(`${base}/runners`, { label: 'Admin box' });
  const { runner, key } = res.json();
  const api = runnerClient(app, key);

  assert.equal((await runnerClient(app, 'vrk_' + 'A'.repeat(43)).post('/api/runner/heartbeat', { capabilities })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runner/heartbeat', headers: { 'content-type': 'application/json' }, payload: json({ capabilities }) })).statusCode, 401);
  assert.equal((await owner.post('/api/runner/lease')).statusCode, 401, 'a signed-in browser session is not a runner');

  const beat = await api.post('/api/runner/heartbeat', { capabilities });
  assert.equal(beat.statusCode, 200, beat.body);
  assert.deepEqual(beat.json(), { runner: { id: runner.id, label: 'Admin box', workspaceId: ws.id }, leaseMs: LEASE_MS });
  const seen = (await owner.get(`${base}/runners`)).json().runners[0];
  assert.equal(seen.capabilities.gpus[0].memoryMb, 24576);
  assert.ok(seen.lastSeenAt);
  assert.equal((await api.post('/api/runner/heartbeat', { capabilities: { gpus: 'many' } })).statusCode, 400);

  // Demoting the admin who linked it disables the key until someone who manages the workspace links again.
  const original = store.getMembership;
  store.getMembership = async (workspaceId, userId) => (userId === admin.id ? { role: 'member' } : original(workspaceId, userId));
  assert.equal((await api.post('/api/runner/lease')).json().code, 'runner_owner_inactive');
  store.getMembership = original;
  assert.equal((await api.post('/api/runner/lease')).statusCode, 200);

  const other = await link('Owner box');
  assert.equal((await owner.post(`${base}/runners/${other.runner.id}/revoke`)).statusCode, 200);
  assert.equal((await other.runnerApi.post('/api/runner/lease')).statusCode, 401, 'a revoked key stops working at once');
  assert.equal((await owner.post(`${base}/runners/${other.runner.id}/revoke`)).statusCode, 409);
});

test('a job is leased to one runner at a time, its events are stored once, and it finishes once', async () => {
  const { owner, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const first = await queue(runner.id, { idempotencyKey: 'probe-key-0001' });
  assert.equal(first.statusCode, 200, first.body);
  const job = first.json().job;
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.spec, { checks: ['gpu', 'sandbox', 'ollama'] });
  assert.equal((await queue(runner.id, { idempotencyKey: 'probe-key-0001' })).json().job.id, job.id, 'a repeated request returns the same job');
  const second = (await queue(runner.id)).json().job;

  const leased = (await runnerApi.post('/api/runner/lease')).json().job;
  assert.equal(leased.id, job.id, 'oldest first');
  assert.equal(leased.attempt, 1);
  assert.ok(leased.leaseToken);
  assert.deepEqual((await runnerApi.post('/api/runner/lease')).json(), { job: null }, 'one job at a time per runner');

  const token = { leaseToken: leased.leaseToken };
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/heartbeat`, { leaseToken: 'wrong' })).json().code, 'lease_lost');
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/heartbeat`, token)).json().job.status, 'running');
  const events = [{ seq: 0, kind: 'stage', data: { name: 'gpu', status: 'started' } }, { seq: 1, kind: 'metric', data: { name: 'vram_mb', value: 24576 } }];
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/events`, { ...token, events })).json().added, 2);
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/events`, { ...token, events })).json().added, 0, 'a retried batch is stored once');
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/events`, { ...token, events: [{ seq: 2, kind: 'metric', data: { name: 'x', value: 'NaN' } }] })).statusCode, 400);

  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'failed', failure: 'Traceback: secret row 42' })).statusCode, 400, 'only failure categories are accepted');
  const done = await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'succeeded', result: { sandbox: true, network: 'none', hostGpus: 1, unknownField: 'dropped' } });
  assert.equal(done.json().job.status, 'succeeded');
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'succeeded', result: {} })).json().code, 'lease_lost', 'it finishes once');

  const view = (await owner.get(`${base}/jobs/${job.id}`)).json();
  assert.equal(view.job.status, 'succeeded');
  assert.deepEqual(view.job.result, { sandbox: true, network: 'none', hostGpus: 1 }, 'results are projected onto the documented shape');
  assert.deepEqual(view.events.map((e) => [e.attempt, e.seq, e.kind]), [[1, 0, 'stage'], [1, 1, 'metric']]);
  assert.equal((await owner.get(`${base}/jobs/${job.id}?after=${view.events[0].id}`)).json().events.length, 1);
  assert.equal((await runnerApi.post('/api/runner/lease')).json().job.id, second.id, 'the next job is leased after the first ends');
  assert.equal((await owner.post(`${base}/jobs`, { kind: 'probe', runnerId: (await link('Second')).runner.id, idempotencyKey: 'probe-key-0001' })).json().code, 'idempotency_conflict');
});

test('cancelling: a waiting job stops at once, a running one when the runner next checks in', async () => {
  const { owner, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const waiting = (await queue(runner.id)).json().job;
  const running = (await queue(runner.id)).json().job;
  assert.equal((await owner.post(`${base}/jobs/${waiting.id}/cancel`)).json().job.status, 'cancelled');
  assert.equal((await owner.post(`${base}/jobs/${waiting.id}/cancel`)).statusCode, 409, 'a finished job cannot be cancelled again');

  const leased = (await runnerApi.post('/api/runner/lease')).json().job;
  assert.equal(leased.id, running.id, 'the cancelled job is never leased');
  assert.equal((await owner.post(`${base}/jobs/${running.id}/cancel`)).json().job.status, 'cancel_requested');
  const beat = (await runnerApi.post(`/api/runner/jobs/${running.id}/heartbeat`, { leaseToken: leased.leaseToken })).json().job;
  assert.equal(beat.cancelRequested, true);
  const end = await runnerApi.post(`/api/runner/jobs/${running.id}/finish`, { leaseToken: leased.leaseToken, outcome: 'failed', failure: 'cancelled' });
  assert.equal(end.json().job.status, 'cancelled');
});

test('a lost runner: expired leases are retried a bounded number of times, then fail; stale tokens are refused', async () => {
  const clock = { now: new Date('2026-11-04T12:00:00Z') };
  const { owner, base, link, queue } = await setup({ clock });
  const { runner, runnerApi } = await link();
  const job = (await queue(runner.id)).json().job;
  let token;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const leased = (await runnerApi.post('/api/runner/lease')).json().job;
    assert.equal(leased.attempt, attempt);
    token = leased.leaseToken;
    clock.now = new Date(clock.now.getTime() + LEASE_MS + 1);
  }
  const ended = (await owner.get(`${base}/jobs/${job.id}`)).json().job;
  assert.equal(ended.status, 'failed');
  assert.equal(ended.failure, 'lease_expired');
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/heartbeat`, { leaseToken: token })).json().code, 'lease_lost');

  // A retryable failure goes back to the queue; a non-retryable one is final.
  const retry = (await queue(runner.id)).json().job;
  const a1 = (await runnerApi.post('/api/runner/lease')).json().job;
  assert.equal((await runnerApi.post(`/api/runner/jobs/${retry.id}/finish`, { leaseToken: a1.leaseToken, outcome: 'failed', failure: 'out_of_memory', retryable: true })).json().job.status, 'queued');
  const a2 = (await runnerApi.post('/api/runner/lease')).json().job;
  assert.equal(a2.attempt, 2);
  assert.equal((await runnerApi.post(`/api/runner/jobs/${retry.id}/finish`, { leaseToken: a2.leaseToken, outcome: 'failed', failure: 'dataset_error' })).json().job.status, 'failed');
});

test('training jobs need an approved plan set to run on the runner; the plan is frozen into the job', async () => {
  const { store, owner, ws, base, link, queue } = await setup();
  const { runner } = await link();
  const plan = (compute) => store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Support tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId: '00000000-0000-4000-8000-000000000001', version: 1 }], steps: ['sft'], compute, spendCapUsd: 1 } });
  const approve = (r) => store.requestEnhanceRun({ workspaceId: ws.id, runId: r.id, requestedBy: owner.id, expectedUpdatedAt: r.updatedAt });

  const draft = await plan('runner');
  assert.equal((await queue(runner.id, { kind: 'train', enhanceRunId: draft.id })).json().errors.enhanceRunId, 'Approve this plan before you run it.');
  const cloud = await approve(await plan('nebius'));
  assert.match((await queue(runner.id, { kind: 'train', enhanceRunId: cloud.id })).json().errors.enhanceRunId, /GPU provider/);
  assert.equal((await queue(runner.id, { kind: 'probe', enhanceRunId: cloud.id })).statusCode, 400, 'a probe never carries a plan');
  assert.equal((await queue(runner.id, { kind: 'train' })).statusCode, 400);
  assert.equal((await queue(runner.id, { kind: 'shell' })).statusCode, 400);

  const approved = await approve(draft);
  const res = await queue(runner.id, { kind: 'train', enhanceRunId: approved.id });
  assert.equal(res.statusCode, 200, res.body);
  const { spec } = res.json().job;
  assert.equal(spec.enhanceRunId, approved.id);
  assert.equal(spec.planVersion, approved.updatedAt);
  assert.equal(spec.baseModel.id, 'fixture-dense-8b');
  assert.deepEqual(spec.plan.steps, ['sft']);
});

test('revoking a runner cancels its waiting jobs and fails the one it holds; workspaces never see each other', async () => {
  const { app, owner, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const held = (await queue(runner.id)).json().job;
  const waiting = (await queue(runner.id)).json().job;
  await runnerApi.post('/api/runner/lease');
  await owner.post(`${base}/runners/${runner.id}/revoke`);
  const jobs = Object.fromEntries((await owner.get(`${base}/jobs`)).json().jobs.map((j) => [j.id, j]));
  assert.equal(jobs[held.id].status, 'failed');
  assert.equal(jobs[held.id].failure, 'runner_revoked');
  assert.equal(jobs[waiting.id].status, 'cancelled');
  assert.equal((await queue(runner.id)).statusCode, 400, 'no new jobs on a revoked runner');

  // A second workspace: its runner cannot see or touch the first workspace's jobs.
  const rival = await person(app, 'r@rival.com');
  const rws = (await rival.post('/api/workspaces', { name: 'Rival Labs' })).json().workspace;
  const theirs = (await rival.post(`/api/workspaces/${rws.id}/runners`, { label: 'Rival box' })).json();
  const rivalApi = runnerClient(app, theirs.key);
  assert.equal((await rivalApi.get(`/api/runner/jobs/${held.id}`)).statusCode, 404);
  assert.equal((await rivalApi.post(`/api/runner/jobs/${held.id}/heartbeat`, { leaseToken: 'x' })).statusCode, 404);
  assert.equal((await rival.get(`${base}/jobs`)).statusCode, 404);
  assert.equal((await rival.post(`/api/workspaces/${rws.id}/jobs`, { kind: 'probe', runnerId: runner.id, idempotencyKey: 'cross-tenant-1' })).statusCode, 400, 'another workspace’s runner does not exist here');
});

test('a runner gets a training job’s frozen dataset files only while it holds the job, and only if training is allowed', async () => {
  const store = createMemoryStore();
  const app = await makeApp({ store, env: { MODEL_CATALOG_FILE: FIXTURE_CATALOG, INGEST_PUBLIC_URL: 'http://127.0.0.1:4100', INGEST_SHARED_SECRET: 's'.repeat(40) } });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const base = `/api/workspaces/${ws.id}`;
  const { runner, key } = (await owner.post(`${base}/runners`, { label: 'Box' })).json();
  const api = runnerClient(app, key);
  const projectId = '00000000-0000-4000-8000-0000000000aa';
  const manifest = (allowedUses) => ({ dataSource: { mode: 'upload', allowedUses }, files: [{ id: 'f1', filename: 'chats.jsonl', sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'application/json', objectKey: `ws/${ws.id}/f1` }] });
  let current = manifest(['training']);
  store.listDatasetVersions = async ({ workspaceId, projectId: p }) => (workspaceId === ws.id && p === projectId ? [{ number: 1, manifest: current }] : []);
  const draft = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId, version: 1 }], steps: ['sft'], compute: 'runner', spendCapUsd: 1 } });
  const plan = await store.requestEnhanceRun({ workspaceId: ws.id, runId: draft.id, requestedBy: owner.id, expectedUpdatedAt: draft.updatedAt });
  const job = (await owner.post(`${base}/jobs`, { kind: 'train', runnerId: runner.id, enhanceRunId: plan.id, idempotencyKey: 'train-key-001' })).json().job;

  assert.equal((await api.post(`/api/runner/jobs/${job.id}/inputs`, { leaseToken: 'x'.repeat(32) })).json().code, 'lease_lost', 'not before it holds the job');
  const leased = (await api.post('/api/runner/lease')).json().job;
  const res = await api.post(`/api/runner/jobs/${job.id}/inputs`, { leaseToken: leased.leaseToken });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.baseModel.id, 'fixture-dense-8b');
  assert.equal(body.datasets[0].files[0].sha256, 'a'.repeat(64));
  assert.match(body.datasets[0].files[0].url, /^http:\/\/127\.0\.0\.1:4100\/v1\/objects\?token=/);
  assert.ok(!JSON.stringify(body).includes('objectKey'), 'storage keys stay on the server');

  current = manifest(['evaluation']);
  assert.equal((await api.post(`/api/runner/jobs/${job.id}/inputs`, { leaseToken: leased.leaseToken })).json().code, 'dataset_unavailable');
  const actions = (await store.listAudit(ws.id)).map((a) => a.action);
  assert.ok(actions.includes('job.inputs_released'));
});

test('export and evaluation name one finished training run of the same plan on the same runner', async () => {
  const { store, owner, ws, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const other = await link('Second box');
  const approve = async () => {
    const r = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId: '00000000-0000-4000-8000-000000000002', version: 1 }], steps: ['sft'], compute: 'runner', spendCapUsd: 1 } });
    return store.requestEnhanceRun({ workspaceId: ws.id, runId: r.id, requestedBy: owner.id, expectedUpdatedAt: r.updatedAt });
  };
  const plan = await approve();
  const otherPlan = await approve();
  assert.equal((await queue(runner.id, { kind: 'export', enhanceRunId: plan.id })).json().errors.trainJobId, 'Choose a finished training run of this plan.');
  const train = (await queue(runner.id, { kind: 'train', enhanceRunId: plan.id })).json().job;
  assert.ok((await queue(runner.id, { kind: 'export', enhanceRunId: plan.id, trainJobId: train.id })).json().errors.trainJobId, 'not before it succeeds');
  const leased = (await runnerApi.post('/api/runner/lease')).json().job;
  const sha = 'c'.repeat(64);
  await runnerApi.post(`/api/runner/jobs/${train.id}/finish`, { leaseToken: leased.leaseToken, outcome: 'succeeded', result: { adapter: { sha256: sha, sizeBytes: 1, location: 'jobs/x/out/adapter' } } });

  assert.ok((await queue(other.runner.id, { kind: 'export', enhanceRunId: plan.id, trainJobId: train.id })).json().errors.trainJobId, 'the adapter is on the runner that trained it');
  assert.ok((await queue(runner.id, { kind: 'export', enhanceRunId: otherPlan.id, trainJobId: train.id })).json().errors.trainJobId, 'a run of another plan does not count');
  const res = await queue(runner.id, { kind: 'export', enhanceRunId: plan.id, trainJobId: train.id });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().job.spec.source, { trainJobId: train.id, adapterSha256: sha, adapterLocation: 'jobs/x/out/adapter' });
  assert.equal((await owner.get(`${base}/jobs/${res.json().job.id}`)).json().job.kind, 'export');
});

test('runner input validation', () => {
  assert.equal(bearerKey('Bearer vrk_' + 'a'.repeat(43)), 'vrk_' + 'a'.repeat(43));
  for (const bad of [undefined, '', 'vrk_x', 'Basic abc', `Bearer vrk_${'a'.repeat(42)}`, `bearer vrk_${'a'.repeat(43)}`]) assert.equal(bearerKey(bad), null);
  assert.ok(validateCapabilities(capabilities).values);
  assert.ok(validateCapabilities({}).values, 'an empty report means nothing is available');
  assert.equal(validateCapabilities({ ...capabilities, gpus: Array(17).fill(capabilities.gpus[0]) }).errors?.gpus, 'Up to 16 GPUs.');
  assert.ok(validateCapabilities({ ollama: { reachable: 'yes' } }).errors);
  assert.ok(validateEvents([{ seq: 0, kind: 'log', data: { level: 'info', message: 'ok' } }]).values);
  assert.ok(validateEvents([{ seq: 0, kind: 'log', data: { level: 'info', message: 'x'.repeat(2001) } }]).errors);
  assert.ok(validateEvents([{ seq: 0, kind: 'log', data: { level: 'info', message: 'a' } }, { seq: 0, kind: 'log', data: { level: 'info', message: 'b' } }]).errors, 'duplicate sequence numbers');
  assert.ok(validateEvents([{ seq: 0, kind: 'exec', data: {} }]).errors);
  assert.ok(validateEvents(Array.from({ length: 51 }, (_, i) => ({ seq: i, kind: 'log', data: { level: 'info', message: 'a' } }))).errors);
  assert.ok(validateEvents([{ seq: 0, kind: 'artifact', data: { name: 'adapter.safetensors', sha256: 'f'.repeat(64), sizeBytes: 10 } }]).values);
  assert.ok(buildJobSpec({ kind: 'train', run: { status: 'requested', compute: 'runner', baseModelId: 'gone' }, catalog: [] }).errors);
});

// --- Regressions for the independent PR13 review (comment 6637458993). Each one failed on 6b5fbb7.

const runnerPlan = async (store, owner, ws, projectId = '00000000-0000-4000-8000-000000000003') => {
  const draft = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId, version: 1 }], steps: ['sft'], compute: 'runner', spendCapUsd: 1 } });
  return store.requestEnhanceRun({ workspaceId: ws.id, runId: draft.id, requestedBy: owner.id, expectedUpdatedAt: draft.updatedAt });
};
// Leases the runner's next job and finishes it with this result.
const leaseAndFinish = async (runnerApi, jobId, result) => {
  const leased = (await runnerApi.post('/api/runner/lease')).json().job;
  assert.equal(leased.id, jobId);
  return { leased, res: await runnerApi.post(`/api/runner/jobs/${jobId}/finish`, { leaseToken: leased.leaseToken, outcome: 'succeeded', result }) };
};

test('review 3: successful results are typed and bounded by kind; unknown fields are dropped', () => {
  const adapter = { sha256: 'c'.repeat(64), sizeBytes: 10 };
  const good = { adapter, baseHeldOutLoss: 2.5, tunedHeldOutLoss: 1.5, gpus: ['GPU'], samples: [{ prompt: 'p', base: 'b', tuned: 't' }], extra: 'dropped' };
  assert.deepEqual(projectResult('train', good), { adapter, baseHeldOutLoss: 2.5, tunedHeldOutLoss: 1.5, gpus: ['GPU'], samples: [{ prompt: 'p', base: 'b', tuned: 't' }] });
  const refused = {
    'string loss': { adapter, baseHeldOutLoss: '2.1' },
    'object samples': { adapter, samples: { prompt: 'x' } },
    'sample missing tuned': { adapter, samples: [{ prompt: 'p', base: 'b' }] },
    'oversized sample': { adapter, samples: [{ prompt: 'x'.repeat(601), base: 'b', tuned: 't' }] },
    'no adapter': { baseHeldOutLoss: 2 },
    'short adapter hash': { adapter: { sha256: 'abc' } },
    'string gpus': { adapter, gpus: 'GPU' },
    'too many samples': { adapter, samples: Array.from({ length: 6 }, () => ({ prompt: 'p', base: 'b', tuned: 't' })) },
    'over 32 KB': { adapter, location: 'x'.repeat(40_000) },
    'array': [adapter],
  };
  for (const [name, raw] of Object.entries(refused)) assert.equal(projectResult('train', raw), null, name);
  assert.equal(projectResult('probe', { sandboxGpus: { name: 'x' } }), null);
  assert.equal(projectResult('export', { ollamaModel: 'x' }), null, 'an export names its GGUF');
  assert.equal(projectResult('export', { gguf: { sha256: 'd'.repeat(64) }, loadTest: { tuned: { tokensPerSec: 'fast' } } }), null);
  assert.equal(projectResult('nope', {}), null, 'unknown kinds have no result');
  assert.ok(validateFinish({ outcome: 'succeeded', result: { baseHeldOutLoss: '2' } }, 'train').errors.result);
  assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('review 3: the finish route refuses a malformed result for the job kind and stores only the projection', async () => {
  const { store, owner, ws, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const plan = await runnerPlan(store, owner, ws);
  const train = (await queue(runner.id, { kind: 'train', enhanceRunId: plan.id })).json().job;
  const { leased, res } = await leaseAndFinish(runnerApi, train.id, { adapter: { sha256: 'c'.repeat(64) }, baseHeldOutLoss: '2.1', samples: { prompt: 'x' } });
  assert.equal(res.statusCode, 400);
  assert.notEqual((await owner.get(`${base}/jobs/${train.id}`)).json().job.status, 'succeeded', 'a refused result does not finish the job');
  const ok = await runnerApi.post(`/api/runner/jobs/${train.id}/finish`, { leaseToken: leased.leaseToken, outcome: 'succeeded', result: { adapter: { sha256: 'c'.repeat(64) }, baseHeldOutLoss: 2.1, secret: 'row 42' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual((await owner.get(`${base}/jobs/${train.id}`)).json().job.result, { adapter: { sha256: 'c'.repeat(64) }, baseHeldOutLoss: 2.1 });
});

test('review 4: a finished job with 550 events is read in pages and nothing is silently dropped', async () => {
  const { owner, base, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const job = (await queue(runner.id)).json().job;
  const leased = (await runnerApi.post('/api/runner/lease')).json().job;
  for (let batch = 0; batch < 11; batch += 1) {
    const events = Array.from({ length: 50 }, (_, i) => ({ seq: batch * 50 + i, kind: 'log', data: { level: 'info', message: `line ${batch * 50 + i}` } }));
    assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/events`, { leaseToken: leased.leaseToken, events })).json().added, 50);
  }
  await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { leaseToken: leased.leaseToken, outcome: 'succeeded', result: { network: 'none' } });
  const first = (await owner.get(`${base}/jobs/${job.id}`)).json();
  assert.deepEqual([first.job.status, first.events.length, first.more], ['succeeded', 500, true]);
  const rest = (await owner.get(`${base}/jobs/${job.id}?after=${first.events.at(-1).id}`)).json();
  assert.deepEqual([rest.events.length, rest.more], [50, false]);
  assert.deepEqual([...first.events, ...rest.events].map((e) => e.seq), Array.from({ length: 550 }, (_, i) => i));
});

test('review 5: once cancel is stored the job ends cancelled, even if the runner reports success; no new inputs after cancel', async () => {
  const store = createMemoryStore();
  const app = await makeApp({ store, env: { MODEL_CATALOG_FILE: FIXTURE_CATALOG, INGEST_PUBLIC_URL: 'http://127.0.0.1:4100', INGEST_SHARED_SECRET: 's'.repeat(40) } });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const base = `/api/workspaces/${ws.id}`;
  const { runner, key } = (await owner.post(`${base}/runners`, { label: 'Box' })).json();
  const api = runnerClient(app, key);
  const projectId = '00000000-0000-4000-8000-0000000000ab';
  const manifest = { dataSource: { mode: 'upload', allowedUses: ['training'] }, files: [{ id: 'f1', filename: 'c.jsonl', sha256: 'a'.repeat(64), sizeBytes: 1, contentType: 'application/json', objectKey: `ws/${ws.id}/f1` }] };
  store.listDatasetVersions = async ({ workspaceId, projectId: p }) => (workspaceId === ws.id && p === projectId ? [{ number: 1, manifest }] : []);
  const plan = await runnerPlan(store, owner, ws, projectId);
  const job = (await owner.post(`${base}/jobs`, { kind: 'train', runnerId: runner.id, enhanceRunId: plan.id, idempotencyKey: 'cancel-key-001' })).json().job;
  const leased = (await api.post('/api/runner/lease')).json().job;
  const token = { leaseToken: leased.leaseToken };
  assert.equal((await api.post(`/api/runner/jobs/${job.id}/inputs`, token)).statusCode, 200, 'inputs before cancel');
  assert.equal((await owner.post(`${base}/jobs/${job.id}/cancel`)).json().job.status, 'cancel_requested');
  const refused = await api.post(`/api/runner/jobs/${job.id}/inputs`, token);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'job_cancelled']);
  const end = await api.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'succeeded', result: { adapter: { sha256: 'c'.repeat(64) } } });
  assert.equal(end.json().job.status, 'cancelled', 'cancel wins over a late success');
  const stored = (await owner.get(`${base}/jobs/${job.id}`)).json().job;
  assert.deepEqual([stored.status, stored.result ?? null], ['cancelled', null], 'the late result is not stored');
});

test('review 2: one request key means one complete request, including the training run it names', async () => {
  const { store, owner, ws, link, queue } = await setup();
  const { runner, runnerApi } = await link();
  const plan = await runnerPlan(store, owner, ws);
  const trained = [];
  for (const sha of ['a', 'b']) {
    const t = (await queue(runner.id, { kind: 'train', enhanceRunId: plan.id })).json().job;
    assert.equal((await leaseAndFinish(runnerApi, t.id, { adapter: { sha256: sha.repeat(64), location: `jobs/${sha}/adapter` } })).res.statusCode, 200);
    trained.push(t);
  }
  const ask = (trainJobId, idempotencyKey = 'eval-key-0001') => queue(runner.id, { kind: 'evaluate', enhanceRunId: plan.id, trainJobId, idempotencyKey });
  const first = await ask(trained[0].id);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await ask(trained[0].id)).json().job.id, first.json().job.id, 'the same request returns the same job');
  const other = await ask(trained[1].id);
  assert.deepEqual([other.statusCode, other.json().code], [409, 'idempotency_conflict'], 'another training run under the same key is a conflict');
  // Two different requests racing under one fresh key: exactly one wins, the other is a conflict.
  const race = await Promise.all(trained.map((t) => ask(t.id, 'eval-key-race1')));
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409]);
});
