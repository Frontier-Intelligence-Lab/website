import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { MODEL_CATALOG, validateEnhanceRun } from '../src/lib/models.js';
import { makeApp, json, postHeaders } from './helpers.js';

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

// A workspace with one approved dataset version that allows training, and one that does not.
async function setup() {
  const store = createMemoryStore();
  const app = await makeApp({ store });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const version = async (name, allowedUses, { dataSource = { mode: 'upload', provenance: 'ours', allowedUses }, files = 1 } = {}) => {
    const { project } = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name, task: 'Answer returns questions by policy.', modalities: ['Text'], startingPoint: 'own' })).json();
    const where = { workspaceId: ws.id, projectId: project.id };
    await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource } });
    for (let i = 0; i < files; i += 1) {
      await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: `${project.id}/${i}`, sha256: String(i).repeat(64).slice(0, 64), sizeBytes: 10, contentType: 'text/plain', filename: `chat-${i}.txt` });
    }
    const review = await store.submitForReview({ ...where, submittedBy: owner.id });
    await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
    await store.createDatasetVersion({ ...where, createdBy: owner.id });
    return project;
  };
  const trainable = await version('Support chats', ['training', 'testing']);
  const testOnly = await version('Held-out cases', ['testing']);
  // Not training data: a license request, and an approved version with no delivered files.
  const licenseRequest = await version('Licensed manuals', [], { dataSource: { mode: 'license', query: 'appliance manuals' }, files: 0 });
  const empty = await version('Empty upload', ['training'], { files: 0 });
  const join = async (email, role) => {
    const c = await person(app, email);
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email, role, tokenHash: `${role}-token`, expiresAt: new Date(Date.now() + 86400000) }] });
    const invitation = await store.getInvitationByTokenHash(`${role}-token`);
    await store.acceptInvitation({ invitationId: invitation.id, userId: c.id });
    return c;
  };
  return { app, store, owner, ws, trainable, testOnly, licenseRequest, empty, join, base: `/api/workspaces/${ws.id}` };
}

test('the catalog is curated: unique ids, known licenses, formats and GPU counts for every model', () => {
  assert.equal(new Set(MODEL_CATALOG.map((m) => m.id)).size, MODEL_CATALOG.length);
  for (const m of MODEL_CATALOG) {
    assert.match(m.id, /^[a-z0-9][a-z0-9.-]{0,63}$/, m.id);
    assert.ok(m.license && m.licenseNote && m.source.includes('/'), m.id);
    assert.ok(m.formats.length && m.formats.every((f) => f.gb > 0), m.id);
    assert.ok([1, 2, 4].includes(m.loraGpus), m.id);
  }
});

test('a plan is validated against pulled models and trainable versions; a request needs a complete plan', () => {
  const pulled = new Set(['qwen3-8b']);
  const eligible = [{ projectId: 'p1', version: 1 }];
  assert.deepEqual(validateEnhanceRun({ baseModelId: 'nope' }, { pulled, eligible }).errors.baseModelId, 'Choose a model from the catalog.');
  assert.match(validateEnhanceRun({ baseModelId: 'gemma-3-12b' }, { pulled, eligible }).errors.baseModelId, /Pull this model/);
  assert.match(validateEnhanceRun({ baseModelId: 'qwen3-8b', datasets: [{ projectId: 'p2', version: 1 }] }, { pulled, eligible }).errors.datasets, /approved dataset versions/);
  assert.equal(validateEnhanceRun({ baseModelId: 'qwen3-8b', steps: ['sft', 'shell'] }, { pulled, eligible }).errors.steps, 'Unknown step.');
  assert.match(validateEnhanceRun({ baseModelId: 'qwen3-8b', spendCapUsd: 0.5 }, { pulled, eligible }).errors.spendCapUsd, /whole-dollar/);
  assert.equal(validateEnhanceRun({ baseModelId: 'qwen3-8b', compute: 'aws' }, { pulled, eligible }).errors.compute, 'Choose one of the listed GPU options.');
  const draft = validateEnhanceRun({ baseModelId: 'qwen3-8b', steps: ['grpo', 'sft'], datasets: [{ projectId: 'p1', version: 1 }, { projectId: 'p1', version: 1 }] }, { pulled, eligible }).values;
  assert.deepEqual(draft.steps, ['sft', 'grpo'], 'steps always run in method order');
  assert.equal(draft.datasets.length, 1, 'duplicates collapse');
  assert.equal(draft.name, 'Qwen3-8B enhanced');
  const missing = validateEnhanceRun({ baseModelId: 'qwen3-8b' }, { pulled, eligible, forRequest: true }).errors;
  assert.deepEqual(Object.keys(missing).sort(), ['compute', 'datasets', 'spendCapUsd', 'steps']);
});

test('pulling a model is idempotent, needs a writer, and is hidden from non-members', async () => {
  const { app, owner, base, join } = await setup();
  assert.equal((await owner.post(`${base}/models/pulls`, { modelId: 'not-a-model' })).statusCode, 400);
  const first = (await owner.post(`${base}/models/pulls`, { modelId: 'qwen3-8b' })).json().pull;
  assert.equal(first.status, 'requested');
  const again = (await owner.post(`${base}/models/pulls`, { modelId: 'qwen3-8b' })).json().pull;
  assert.equal(again.id, first.id);
  const models = (await owner.get(`${base}/models`)).json();
  assert.equal(models.pulls.length, 1);
  assert.equal(models.catalog.length, MODEL_CATALOG.length);

  const viewer = await join('v@acme-robotics.com', 'viewer');
  assert.equal((await viewer.get(`${base}/models`)).statusCode, 200);
  assert.equal((await viewer.post(`${base}/models/pulls`, { modelId: 'gemma-3-12b' })).statusCode, 403);
  const stranger = await person(app, 's@elsewhere.com');
  assert.equal((await stranger.get(`${base}/models`)).statusCode, 404);
  assert.equal((await stranger.post(`${base}/models/pulls`, { modelId: 'gemma-3-12b' })).statusCode, 404);
  assert.equal((await client(app).get('/api/models/catalog')).statusCode, 401);
});

const BASE = MODEL_CATALOG[0].id;
const plan = (p) => ({ baseModelId: BASE, name: 'returns-assistant', datasets: [{ projectId: p.id, version: 1 }], steps: ['sft', 'grpo'], compute: 'nebius' });

test('an enhance run is a draft until an owner or admin requests it; then its plan is frozen', async () => {
  const { owner, base, trainable, testOnly, licenseRequest, empty, join } = await setup();
  await owner.post(`${base}/models/pulls`, { modelId: 'qwen3-8b' });
  const options = (await owner.get(`${base}/enhance-runs/options`)).json();
  assert.deepEqual(options.datasets.map((d) => d.projectId), [trainable.id], 'test-only, license-request and empty versions are not training data');
  for (const p of [testOnly, licenseRequest, empty]) {
    assert.equal((await owner.post(`${base}/enhance-runs`, { baseModelId: BASE, datasets: [{ projectId: p.id, version: 1 }] })).statusCode, 400, p.name);
  }

  assert.equal((await owner.post(`${base}/enhance-runs`, { baseModelId: 'qwen3-8b', datasets: [{ projectId: testOnly.id, version: 1 }] })).statusCode, 400);
  const created = await owner.post(`${base}/enhance-runs`, { baseModelId: 'qwen3-8b', steps: ['sft', 'dpo', 'grpo'] });
  assert.equal(created.statusCode, 200, created.body);
  const run = created.json().run;
  assert.equal(run.status, 'draft');

  const member = await join('m@acme-robotics.com', 'member');
  const edited = await member.post(`${base}/enhance-runs/${run.id}`, { baseModelId: 'qwen3-8b', name: 'returns-assistant', datasets: [{ projectId: trainable.id, version: 1 }], steps: ['sft', 'grpo'], compute: 'nebius', spendCapUsd: 250 });
  assert.equal(edited.statusCode, 200, edited.body);
  const reviewed = edited.json().run;
  assert.equal((await member.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: reviewed.updatedAt })).statusCode, 403, 'members plan; owners and admins approve spend');

  for (const cap of ['12.5', '-5', '1e3', '0x10', 12.5, -5, [250], { value: 250 }, true]) {
    const bad = await member.post(`${base}/enhance-runs/${run.id}`, { ...plan(trainable), spendCapUsd: cap });
    assert.equal(bad.statusCode, 400, `cap ${cap} is refused, not rewritten`);
  }

  const incomplete = (await owner.post(`${base}/enhance-runs`, { baseModelId: 'qwen3-8b' })).json().run;
  const refused = await owner.post(`${base}/enhance-runs/${incomplete.id}/request`, { expectedUpdatedAt: incomplete.updatedAt });
  assert.equal(refused.statusCode, 400);
  assert.ok(refused.json().errors.spendCapUsd);

  // The member raises the cap after the owner opened the plan: the owner's approval of the old version is refused.
  const raised = (await member.post(`${base}/enhance-runs/${run.id}`, { ...plan(trainable), spendCapUsd: 9000 })).json().run;
  const stale = await owner.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: reviewed.updatedAt });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_plan');
  assert.equal((await owner.post(`${base}/enhance-runs/${run.id}/request`)).statusCode, 400, 'an approval names the version it approves');
  assert.equal((await owner.get(`${base}/enhance-runs/${run.id}`)).json().run.status, 'draft');
  const current = (await member.post(`${base}/enhance-runs/${run.id}`, { ...plan(trainable), spendCapUsd: 250 })).json().run;
  assert.notEqual(current.updatedAt, raised.updatedAt);

  const requested = await owner.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: current.updatedAt });
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().run.status, 'requested');
  assert.equal(requested.json().run.spendCapUsd, 250);
  const frozen = await owner.post(`${base}/enhance-runs/${run.id}`, { baseModelId: 'qwen3-8b', spendCapUsd: 99999 });
  assert.equal(frozen.statusCode, 409);
  assert.equal(frozen.json().code, 'run_requested');
  assert.equal((await owner.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: current.updatedAt })).statusCode, 409);
  assert.equal((await owner.get(`${base}/enhance-runs/${run.id}`)).json().run.spendCapUsd, 250);

  const viewer = await join('v@acme-robotics.com', 'viewer');
  assert.equal((await viewer.get(`${base}/enhance-runs/${run.id}`)).statusCode, 200);
  assert.equal((await viewer.post(`${base}/enhance-runs`, { baseModelId: 'qwen3-8b' })).statusCode, 403);
});

test('runs and pulls are scoped to their workspace', async () => {
  const { app, owner, base } = await setup();
  await owner.post(`${base}/models/pulls`, { modelId: 'qwen3-8b' });
  const run = (await owner.post(`${base}/enhance-runs`, { baseModelId: 'qwen3-8b' })).json().run;
  const other = await person(app, 'x@other.com');
  const ws2 = (await other.post('/api/workspaces', { name: 'Other Co' })).json().workspace;
  assert.equal((await other.get(`/api/workspaces/${ws2.id}/enhance-runs/${run.id}`)).statusCode, 404);
  assert.equal((await other.post(`/api/workspaces/${ws2.id}/enhance-runs/${run.id}`, { baseModelId: 'qwen3-8b' })).statusCode, 404);
  assert.equal((await other.post(`/api/workspaces/${ws2.id}/enhance-runs`, { baseModelId: 'qwen3-8b' })).json().errors.baseModelId, 'Pull this model into the workspace first.');
});

test('a plan with more dataset versions than one run allows is refused, never truncated', () => {
  const eligible = Array.from({ length: 21 }, (_, i) => ({ projectId: `p${i}`, version: 1 }));
  const pulled = new Set([MODEL_CATALOG[0].id]);
  const plan = { baseModelId: MODEL_CATALOG[0].id, datasets: eligible };
  assert.match(validateEnhanceRun(plan, { pulled, eligible }).errors.datasets, /at most 20/);
  assert.equal(validateEnhanceRun({ ...plan, datasets: eligible.slice(0, 20) }, { pulled, eligible }).values.datasets.length, 20);
});
