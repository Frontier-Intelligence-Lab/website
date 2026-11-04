import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { COMPAT_TASKS, parseCatalog, passesTask, validateRun } from '../src/lib/devices.js';
import { FIXTURE_DIST, makeApp, json, postHeaders } from './helpers.js';

const CATALOG = path.join(FIXTURE_DIST, '..', 'local-models.json');

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
  await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

async function setup() {
  const store = createMemoryStore();
  const app = await makeApp({ store, env: { LOCAL_MODEL_CATALOG_FILE: CATALOG } });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const join = async (email, role) => {
    const c = await person(app, email);
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email, role, tokenHash: `${role}-token`, expiresAt: new Date(Date.now() + 86400000) }] });
    await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(`${role}-token`)).id, userId: c.id });
    return c;
  };
  return { app, store, owner, ws, join, base: `/api/workspaces/${ws.id}/devices` };
}

const digest = 'b'.repeat(64);
const run = (extra = {}) => ({ modelRef: 'demo-chat:0.6b', modelDigest: digest, location: 'local_runtime', kind: 'chat', warm: true, status: 'completed', settings: { numCtx: 4096, numPredict: 256, temperature: 0.7 }, metrics: { wallMs: 1500, ttftMs: 120, loadMs: 30, promptTokens: 20, promptEvalMs: 40, outputTokens: 100, evalMs: 1000 }, ...extra });

test('a device is private to the person who connected it, even from owners of the same workspace', async () => {
  const { owner, base, join, app } = await setup();
  const memberA = await join('m@acme-robotics.com', 'member');
  const created = await memberA.post(base, { label: 'Work laptop' });
  assert.equal(created.statusCode, 200, created.body);
  const device = created.json().device;
  const path = `${base}/${device.id}`;

  assert.equal((await owner.get(path)).statusCode, 404, 'the workspace owner cannot open a member’s device');
  assert.deepEqual((await owner.get(base)).json().devices, []);
  // Valid payloads, so a 404 proves the ownership check rather than validation.
  const writes = { '/reports': { reachable: false }, '/installs': { runtimeRef: 'demo-chat:0.6b', state: 'installed' }, '/runs': run(), '/revoke': {} };
  for (const [suffix, body] of Object.entries(writes)) assert.equal((await owner.post(`${path}${suffix}`, body)).statusCode, 404, suffix);
  assert.equal((await memberA.get(path)).json().device.status, 'active', 'the owner could not revoke it');

  const stranger = await person(app, 's@elsewhere.com');
  assert.equal((await stranger.get(base)).statusCode, 404);
  assert.equal((await client(app).get(base)).statusCode, 401);
  assert.equal((await client(app).get('/api/local-models')).statusCode, 401);
  const viewer = await join('v@acme-robotics.com', 'viewer');
  assert.equal((await viewer.post(base, { label: 'Viewer laptop' })).statusCode, 200, 'any member may run models on their own machine');
});

test('reports, installs and runs are recorded as client-reported and survive reload', async () => {
  const { owner, base } = await setup();
  const device = (await owner.post(base, { label: 'Studio desktop' })).json().device;
  const path = `${base}/${device.id}`;
  const report = await owner.post(`${path}/reports`, {
    reachable: true, runtimeVersion: '0.40.13',
    models: [{ name: 'demo-chat:0.6b', digest, sizeBytes: 522653767, family: 'demo' }, { name: 'glm-5:cloud', remote: true }],
    running: [{ name: 'demo-chat:0.6b', digest, sizeBytes: 522653767, sizeVramBytes: 900000000 }],
    browser: { hardwareConcurrency: 24, deviceMemoryGb: 8, webgpu: true, gpu: { vendor: 'nvidia', architecture: 'blackwell' } },
  });
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().report.provenance, 'client_reported');

  const install = (state, extra = {}) => owner.post(`${path}/installs`, { runtimeRef: 'demo-chat:0.6b', catalogId: 'demo-chat-0.6b', digest, sizeBytes: 522653767, details: { family: 'demo', license: 'Apache 2.0' }, state, ...extra });
  assert.equal((await install('downloading', { digest: null })).statusCode, 200);
  assert.equal((await install('verified', { digest: null })).statusCode, 400, 'verified needs the digest read back from the runtime');
  const verified = (await install('verified')).json().install;
  assert.ok(verified.verifiedAt);
  const recorded = await owner.post(`${path}/runs`, run({ installId: verified.id }));
  assert.equal(recorded.statusCode, 200, recorded.body);
  assert.equal(recorded.json().run.metrics.tokensPerSec, 100, 'throughput is derived from the runtime’s own counters');

  const reloaded = (await owner.get(path)).json();
  assert.equal(reloaded.device.latestReport.runtimeVersion, '0.40.13');
  assert.equal(reloaded.installs[0].state, 'verified');
  assert.equal(reloaded.runs.length, 1);
});

test('cloud models and non-local locations are refused: local mode never records remote inference', async () => {
  const { owner, base } = await setup();
  const path = `${base}/${(await owner.post(base, { label: 'Laptop' })).json().device.id}`;
  for (const runtimeRef of ['glm-5:cloud', 'gemma4:31b-cloud']) {
    const res = await owner.post(`${path}/installs`, { runtimeRef, state: 'installed' });
    assert.equal(res.statusCode, 400, runtimeRef);
    assert.match(res.json().errors.runtimeRef, /Cloud models/);
  }
  assert.equal((await owner.post(`${path}/installs`, { runtimeRef: 'demo-chat:0.6b', state: 'installed', remote: true })).statusCode, 400);
  for (const location of ['remote_worker', 'browser', 'cloud', undefined]) {
    assert.equal((await owner.post(`${path}/runs`, run({ location }))).statusCode, 400, String(location));
  }
  assert.equal((await owner.post(`${path}/runs`, run({ modelRef: 'gemma4:31b-cloud' }))).statusCode, 400);
  assert.equal((await owner.post(`${path}/runs`, run({ metrics: { wallMs: -5 } }))).statusCode, 400);
  assert.equal((await owner.post(`${path}/runs`, run({ kind: 'compat_test' }))).statusCode, 400, 'a compatibility run names its task');
  assert.equal((await owner.post(`${path}/reports`, { reachable: false, models: [{ name: 'x:1b' }] })).statusCode, 400);
});

test('a revoked device keeps its history but accepts nothing new', async () => {
  const { owner, base } = await setup();
  const path = `${base}/${(await owner.post(base, { label: 'Old laptop' })).json().device.id}`;
  assert.equal((await owner.post(`${path}/runs`, run())).statusCode, 200);
  assert.equal((await owner.post(`${path}/revoke`)).json().device.status, 'revoked');
  const refused = await owner.post(`${path}/runs`, run());
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'device_revoked');
  assert.equal((await owner.post(`${path}/revoke`)).statusCode, 409);
  assert.equal((await owner.get(path)).json().runs.length, 1);
});

test('the page may reach only the loopback runtime, never an arbitrary host', async () => {
  const { app, owner } = await setup();
  const csp = (await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy'];
  const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  assert.equal(connect, "connect-src 'self' http://127.0.0.1:11434 http://localhost:11434");
  assert.doesNotMatch(csp, /unsafe-/);
  const local = (await owner.get('/api/local-models')).json();
  assert.deepEqual(local.runtimeOrigins, ['http://127.0.0.1:11434', 'http://localhost:11434']);
  assert.deepEqual(local.catalog.map((m) => m.id), ['demo-chat-0.6b'], 'the download catalog comes from configuration');
});

test('compatibility tasks have one exact answer', () => {
  const [arithmetic, extraction, classification] = COMPAT_TASKS;
  assert.ok(passesTask(arithmetic, ' 42.'));
  assert.ok(!passesTask(arithmetic, 'The answer is 42'), 'extra words fail: the task asks for only the number');
  assert.ok(passesTask(extraction, '**INV-20419**'));
  assert.ok(passesTask(classification, 'Yes'));
  assert.ok(!passesTask(classification, 'no'));
  assert.ok(validateRun(run({ kind: 'compat_test', task: { id: 'arithmetic', passed: true } })).values);
});

test('a download catalog is validated at startup and never offers a cloud model', () => {
  const entry = { id: 'demo-chat-1b', ref: 'demo-chat:1b', name: 'Demo', license: 'MIT', summary: 'x', approxGb: 1, source: 'https://ollama.com/library/demo-chat' };
  assert.equal(parseCatalog(JSON.stringify([entry]))[0].ref, 'demo-chat:1b');
  for (const bad of [{ ...entry, ref: 'demo:1b-cloud' }, { ...entry, source: 'http://plain.example' }, { ...entry, approxGb: 0 }, { ...entry, license: '' }]) {
    assert.throws(() => parseCatalog(JSON.stringify([bad])), /catalog entry 1/);
  }
  assert.throws(() => parseCatalog(JSON.stringify([entry, entry])), /unique/);
  assert.throws(() => parseCatalog('{}'), /JSON array/);
});
