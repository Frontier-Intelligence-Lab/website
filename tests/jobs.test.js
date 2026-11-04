import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { LEASE_MS, MAX_ATTEMPTS, bearerKey, buildJobSpec, validateCapabilities, validateEvents } from '../src/lib/jobs.js';
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
  const done = await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'succeeded', result: { gpu: true } });
  assert.equal(done.json().job.status, 'succeeded');
  assert.equal((await runnerApi.post(`/api/runner/jobs/${job.id}/finish`, { ...token, outcome: 'succeeded', result: {} })).json().code, 'lease_lost', 'it finishes once');

  const view = (await owner.get(`${base}/jobs/${job.id}`)).json();
  assert.equal(view.job.status, 'succeeded');
  assert.deepEqual(view.job.result, { gpu: true });
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
  const plan = (compute) => store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Support tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId: '00000000-0000-4000-8000-000000000001', version: 1 }], steps: ['sft'], compute, spendCapUsd: 0 } });
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
  const draft = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Tone', baseModelId: 'fixture-dense-8b', datasets: [{ projectId, version: 1 }], steps: ['sft'], compute: 'runner', spendCapUsd: 0 } });
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
