import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store/memory.js';
import { parseModelCatalog, validateEnhanceRun } from '../src/lib/models.js';
import { EXAMPLE_CATALOG, FIXTURE_CATALOG, makeApp, json, postHeaders } from './helpers.js';

// The catalog under test is a file chosen through MODEL_CATALOG_FILE, as in a deployment. Model ids are read
// from it, never written here: the fixture is synthetic and the documented example is only checked for validity.
const CATALOG = parseModelCatalog(readFileSync(FIXTURE_CATALOG, 'utf8'));
const [BASE, OTHER] = CATALOG.map((m) => m.id);
const withCatalog = (file) => ({ MODEL_CATALOG_FILE: file });
const PASSWORD = 'long-enough-password';

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

// Signs up a new person, or signs an existing one in (for a second app sharing the same store).
async function person(app, email, { existing = false } = {}) {
  const c = client(app);
  const s = existing
    ? await c.post('/api/account/signin', { email, password: PASSWORD })
    : await c.post('/api/account/signup', { name: email.split('@')[0], email, password: PASSWORD });
  if (!existing) await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

// A workspace with one approved dataset version that allows training, and one that does not.
async function setup({ catalog = FIXTURE_CATALOG } = {}) {
  const store = createMemoryStore();
  const app = await makeApp({ store, env: catalog ? withCatalog(catalog) : {} });
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

const curated = (models) => {
  assert.ok(models.length > 0);
  assert.equal(new Set(models.map((m) => m.id)).size, models.length);
  for (const m of models) {
    assert.match(m.id, /^[a-z0-9][a-z0-9.-]{0,63}$/, m.id);
    assert.ok(m.name && m.license && m.licenseNote && m.source && m.summary, m.id);
    assert.ok(m.formats.length && m.formats.every((f) => f.gb > 0), m.id);
    assert.ok([1, 2, 4].includes(m.loraGpus), m.id);
  }
};

test('the catalog is deployment data: the documented example and the test fixture both pass the same checks', () => {
  curated(CATALOG);
  const example = parseModelCatalog(readFileSync(EXAMPLE_CATALOG, 'utf8'));
  curated(example);
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ...withCatalog(EXAMPLE_CATALOG) });
  assert.deepEqual(config.modelCatalog, example, 'the server reads the file once, through config');
  assert.deepEqual(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) }).modelCatalog, [], 'unset means an empty catalog, not a failure');
  assert.deepEqual(parseModelCatalog('[]'), [], 'an explicitly empty catalog is allowed');
});

test('an unreadable or invalid catalog file stops startup with the reason', () => {
  const env = (file) => ({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), MODEL_CATALOG_FILE: file });
  assert.throws(() => loadConfig(env(path.join(tmpdir(), 'valcairn-no-such-catalog.json'))), /MODEL_CATALOG_FILE .*ENOENT/);
  const dir = mkdtempSync(path.join(tmpdir(), 'valcairn-catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig(env(file)), /MODEL_CATALOG_FILE .*not valid JSON/);
  writeFileSync(file, '{"models": []}');
  assert.throws(() => loadConfig(env(file)), /must be a JSON array/);

  const [good] = CATALOG;
  const bad = (patch, ...more) => JSON.stringify([{ ...good, ...patch }, ...more]);
  const cases = [
    [bad({}, good), /repeats an id/],
    [bad({ id: 'Bad Id' }), /id must be/],
    [bad({ id: 'a'.repeat(65) }), /id must be/],
    [bad({ licence: 'typo' }), /unknown field "licence"/],
    [bad({ name: 'x'.repeat(81) }), /name must be text of 1 to 80/],
    [bad({ summary: '' }), /summary must be text/],
    [bad({ tone: 'pink' }), /tone must be one of/],
    [bad({ architecture: 'moe', active: null }), /moe model needs active/],
    [bad({ contextK: 1e9 }), /contextK must be/],
    [bad({ contextK: '32' }), /contextK must be/],
    [bad({ commercial: 'yes' }), /commercial must be true or false/],
    [bad({ modalities: [] }), /modalities must be/],
    [bad({ modalities: ['text', 'text'] }), /modalities must be/],
    [bad({ tags: ['magic'] }), /tags must be/],
    [bad({ formats: [] }), /formats must list/],
    [bad({ formats: [{ format: 'bf16', gb: -1 }] }), /gb, a number above 0/],
    [bad({ formats: [{ format: '', gb: 1 }] }), /format needs a name/],
    [bad({ loraGpus: 3 }), /loraGpus must be one of/],
    ['[1]', /must be an object/],
    [JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ ...good, id: `m${i}` }))), /more than 200 models/],
  ];
  for (const [text, reason] of cases) assert.throws(() => parseModelCatalog(text), reason, text.slice(0, 120));
});

test('without a catalog file the site runs, the catalog is empty, and new pulls or plans are refused', async () => {
  const { app, owner, base } = await setup({ catalog: null });
  for (const url of ['/', '/contact', '/demo', '/api/config', '/api/session']) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url);
  assert.deepEqual((await owner.get('/api/models/catalog')).json().models, []);
  const models = (await owner.get(`${base}/models`)).json();
  assert.deepEqual(models.catalog, []);
  assert.ok(models.methods.length && models.compute.length, 'methods and compute options are code, not catalog data');
  assert.deepEqual((await owner.get(`${base}/enhance-runs/options`)).json().catalog, []);
  assert.equal((await owner.post(`${base}/models/pulls`, { modelId: BASE })).statusCode, 400);
  const refused = await owner.post(`${base}/enhance-runs`, { baseModelId: BASE });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().errors.baseModelId, 'Choose a model from the catalog.');
  assert.deepEqual((await owner.get(`${base}/models`)).json().pulls, [], 'nothing was recorded');
});

test('a plan is validated against pulled models and trainable versions; a request needs a complete plan', () => {
  const pulled = new Set([BASE]);
  const eligible = [{ projectId: 'p1', version: 1 }];
  const check = (body, more = {}) => validateEnhanceRun(body, { catalog: CATALOG, pulled, eligible, ...more });
  assert.deepEqual(check({ baseModelId: 'nope' }).errors.baseModelId, 'Choose a model from the catalog.');
  assert.deepEqual(validateEnhanceRun({ baseModelId: BASE }, { catalog: [], pulled, eligible }).errors.baseModelId, 'Choose a model from the catalog.', 'an empty catalog refuses every model');
  assert.match(check({ baseModelId: OTHER }).errors.baseModelId, /Pull this model/);
  assert.match(check({ baseModelId: BASE, datasets: [{ projectId: 'p2', version: 1 }] }).errors.datasets, /approved dataset versions/);
  assert.equal(check({ baseModelId: BASE, steps: ['sft', 'shell'] }).errors.steps, 'Unknown step.');
  assert.match(check({ baseModelId: BASE, spendCapUsd: 0.5 }).errors.spendCapUsd, /whole-dollar/);
  assert.equal(check({ baseModelId: BASE, compute: 'aws' }).errors.compute, 'Choose one of the listed GPU options.');
  const draft = check({ baseModelId: BASE, steps: ['grpo', 'sft'], datasets: [{ projectId: 'p1', version: 1 }, { projectId: 'p1', version: 1 }] }).values;
  assert.deepEqual(draft.steps, ['sft', 'grpo'], 'steps always run in method order');
  assert.equal(draft.datasets.length, 1, 'duplicates collapse');
  assert.equal(draft.name, `${CATALOG[0].name} enhanced`);
  const missing = check({ baseModelId: BASE }, { forRequest: true }).errors;
  assert.deepEqual(Object.keys(missing).sort(), ['compute', 'datasets', 'spendCapUsd', 'steps']);
});

test('pulling a model is idempotent, needs a writer, and is hidden from non-members', async () => {
  const { app, owner, base, join } = await setup();
  assert.equal((await owner.post(`${base}/models/pulls`, { modelId: 'not-a-model' })).statusCode, 400);
  const first = (await owner.post(`${base}/models/pulls`, { modelId: BASE })).json().pull;
  assert.equal(first.status, 'requested');
  const again = (await owner.post(`${base}/models/pulls`, { modelId: BASE })).json().pull;
  assert.equal(again.id, first.id);
  const models = (await owner.get(`${base}/models`)).json();
  assert.equal(models.pulls.length, 1);
  assert.deepEqual(models.catalog, CATALOG, 'the browser gets the catalog from the server');
  assert.deepEqual((await owner.get('/api/models/catalog')).json().models, CATALOG);

  const viewer = await join('v@acme-robotics.com', 'viewer');
  assert.equal((await viewer.get(`${base}/models`)).statusCode, 200);
  assert.equal((await viewer.post(`${base}/models/pulls`, { modelId: OTHER })).statusCode, 403);
  const stranger = await person(app, 's@elsewhere.com');
  assert.equal((await stranger.get(`${base}/models`)).statusCode, 404);
  assert.equal((await stranger.post(`${base}/models/pulls`, { modelId: OTHER })).statusCode, 404);
  assert.equal((await client(app).get('/api/models/catalog')).statusCode, 401);
});

const plan = (p) => ({ baseModelId: BASE, name: 'returns-assistant', datasets: [{ projectId: p.id, version: 1 }], steps: ['sft', 'grpo'], compute: 'nebius' });

test('an enhance run is a draft until an owner or admin requests it; then its plan is frozen', async () => {
  const { owner, base, trainable, testOnly, licenseRequest, empty, join } = await setup();
  await owner.post(`${base}/models/pulls`, { modelId: BASE });
  const options = (await owner.get(`${base}/enhance-runs/options`)).json();
  assert.deepEqual(options.datasets.map((d) => d.projectId), [trainable.id], 'test-only, license-request and empty versions are not training data');
  for (const p of [testOnly, licenseRequest, empty]) {
    assert.equal((await owner.post(`${base}/enhance-runs`, { baseModelId: BASE, datasets: [{ projectId: p.id, version: 1 }] })).statusCode, 400, p.name);
  }

  assert.equal((await owner.post(`${base}/enhance-runs`, { baseModelId: BASE, datasets: [{ projectId: testOnly.id, version: 1 }] })).statusCode, 400);
  const created = await owner.post(`${base}/enhance-runs`, { baseModelId: BASE, steps: ['sft', 'dpo', 'grpo'] });
  assert.equal(created.statusCode, 200, created.body);
  const run = created.json().run;
  assert.equal(run.status, 'draft');

  const member = await join('m@acme-robotics.com', 'member');
  const edited = await member.post(`${base}/enhance-runs/${run.id}`, { ...plan(trainable), spendCapUsd: 250 });
  assert.equal(edited.statusCode, 200, edited.body);
  const reviewed = edited.json().run;
  assert.equal((await member.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: reviewed.updatedAt })).statusCode, 403, 'members plan; owners and admins approve spend');

  for (const cap of ['12.5', '-5', '1e3', '0x10', 12.5, -5, [250], { value: 250 }, true]) {
    const bad = await member.post(`${base}/enhance-runs/${run.id}`, { ...plan(trainable), spendCapUsd: cap });
    assert.equal(bad.statusCode, 400, `cap ${cap} is refused, not rewritten`);
  }

  const incomplete = (await owner.post(`${base}/enhance-runs`, { baseModelId: BASE })).json().run;
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
  const frozen = await owner.post(`${base}/enhance-runs/${run.id}`, { baseModelId: BASE, spendCapUsd: 99999 });
  assert.equal(frozen.statusCode, 409);
  assert.equal(frozen.json().code, 'run_requested');
  assert.equal((await owner.post(`${base}/enhance-runs/${run.id}/request`, { expectedUpdatedAt: current.updatedAt })).statusCode, 409);
  assert.equal((await owner.get(`${base}/enhance-runs/${run.id}`)).json().run.spendCapUsd, 250);

  const viewer = await join('v@acme-robotics.com', 'viewer');
  assert.equal((await viewer.get(`${base}/enhance-runs/${run.id}`)).statusCode, 200);
  assert.equal((await viewer.post(`${base}/enhance-runs`, { baseModelId: BASE })).statusCode, 403);
});

test('runs and pulls are scoped to their workspace', async () => {
  const { app, owner, base } = await setup();
  await owner.post(`${base}/models/pulls`, { modelId: BASE });
  const run = (await owner.post(`${base}/enhance-runs`, { baseModelId: BASE })).json().run;
  const other = await person(app, 'x@other.com');
  const ws2 = (await other.post('/api/workspaces', { name: 'Other Co' })).json().workspace;
  assert.equal((await other.get(`/api/workspaces/${ws2.id}/enhance-runs/${run.id}`)).statusCode, 404);
  assert.equal((await other.post(`/api/workspaces/${ws2.id}/enhance-runs/${run.id}`, { baseModelId: BASE })).statusCode, 404);
  assert.equal((await other.post(`/api/workspaces/${ws2.id}/enhance-runs`, { baseModelId: BASE })).json().errors.baseModelId, 'Pull this model into the workspace first.');
});

test('a plan with more dataset versions than one run allows is refused, never truncated', () => {
  const eligible = Array.from({ length: 21 }, (_, i) => ({ projectId: `p${i}`, version: 1 }));
  const pulled = new Set([BASE]);
  const plan = { baseModelId: BASE, datasets: eligible };
  assert.match(validateEnhanceRun(plan, { catalog: CATALOG, pulled, eligible }).errors.datasets, /at most 20/);
  assert.equal(validateEnhanceRun({ ...plan, datasets: eligible.slice(0, 20) }, { catalog: CATALOG, pulled, eligible }).values.datasets.length, 20);
});

test('a model that leaves the catalog keeps its pulls and runs readable; new work on it is refused', async () => {
  const { store, owner, base, trainable } = await setup();
  await owner.post(`${base}/models/pulls`, { modelId: BASE });
  await owner.post(`${base}/models/pulls`, { modelId: OTHER });
  const approved = (await owner.post(`${base}/enhance-runs`, { ...plan(trainable), spendCapUsd: 250 })).json().run;
  const requested = (await owner.post(`${base}/enhance-runs/${approved.id}/request`, { expectedUpdatedAt: approved.updatedAt })).json().run;
  assert.equal(requested.status, 'requested');
  const draft = (await owner.post(`${base}/enhance-runs`, { ...plan(trainable), spendCapUsd: 250 })).json().run;

  // The next release ships a catalog without BASE. Same store, same history, new server and catalog file.
  const reduced = path.join(mkdtempSync(path.join(tmpdir(), 'valcairn-catalog-')), 'catalog.json');
  writeFileSync(reduced, JSON.stringify(CATALOG.filter((m) => m.id !== BASE)));
  const later = await makeApp({ store, env: withCatalog(reduced) });
  const ownerLater = await person(later, 'o@acme-robotics.com', { existing: true });

  const models = (await ownerLater.get(`${base}/models`)).json();
  assert.deepEqual(models.catalog.map((m) => m.id), CATALOG.map((m) => m.id).filter((id) => id !== BASE));
  assert.deepEqual(models.pulls.map((p) => p.modelId).sort(), [BASE, OTHER].sort(), 'history is read without consulting the catalog');
  assert.deepEqual(models.runs.map((r) => r.id).sort(), [approved.id, draft.id].sort());
  const seen = (await ownerLater.get(`${base}/enhance-runs/${approved.id}`)).json().run;
  assert.equal(seen.status, 'requested');
  assert.equal(seen.baseModelId, BASE);
  assert.equal(seen.spendCapUsd, 250, 'the frozen plan is returned as approved, not rewritten');
  assert.equal((await ownerLater.get(`${base}/enhance-runs/${draft.id}`)).statusCode, 200);
  assert.ok((await ownerLater.get(`${base}/enhance-runs/options`)).json().pulls.some((p) => p.modelId === BASE));

  assert.equal((await ownerLater.post(`${base}/models/pulls`, { modelId: BASE })).statusCode, 400, 'no new pull of an unlisted model');
  assert.equal((await ownerLater.post(`${base}/models/pulls`, { modelId: OTHER })).statusCode, 200);
  const edit = await ownerLater.post(`${base}/enhance-runs/${draft.id}`, { ...plan(trainable), spendCapUsd: 300 });
  assert.equal(edit.statusCode, 400);
  assert.equal(edit.json().errors.baseModelId, 'Choose a model from the catalog.');
  const approve = await ownerLater.post(`${base}/enhance-runs/${draft.id}/request`, { expectedUpdatedAt: draft.updatedAt });
  assert.equal(approve.statusCode, 400, 'a draft cannot be approved on a model that is no longer offered');
  assert.equal(approve.json().errors.baseModelId, 'Choose a model from the catalog.');
  assert.equal((await ownerLater.get(`${base}/enhance-runs/${draft.id}`)).json().run.status, 'draft');
  assert.equal((await ownerLater.post(`${base}/enhance-runs/${approved.id}`, { ...plan(trainable), spendCapUsd: 1 })).json().code, 'run_requested', 'the approved plan stays frozen');
  const moved = await ownerLater.post(`${base}/enhance-runs/${draft.id}`, { ...plan(trainable), baseModelId: OTHER, spendCapUsd: 250 });
  assert.equal(moved.statusCode, 200, 'the draft can move to a model that is still offered');
  await later.close();
});
