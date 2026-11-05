import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { hashSecret } from '../src/lib/jobs.js';
import { emptyDraft } from '../src/lib/capital.js';
import { loadConfig } from '../src/config.js';
import { METRIC_PATHS, buildDemoOverview } from '../src/lib/demo-overview.js';
import { totalsByBasis } from '../src/lib/capital.js';
import { costTotalLines, createOverviewLoader, initialOverviewState, reduceOverview } from '../web/src/private/overview-state.js';
import { makeApp, json, postHeaders, sessionCookie } from './helpers.js';

// Everything below is a labelled synthetic fixture. The texts in capitals are canaries: they must never reach a reviewer.
const OVERVIEW = '/api/demo/overview';
const PASSWORD = 'reviewer-secret-1';
const OWNER_PASSWORD = 'owner-password-12';

async function reviewers() {
  const passwordHash = await hashPassword(PASSWORD, { cost: 2 ** 12 });
  return [
    { username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash },
    { username: 'admin', name: 'Demo admin', role: 'admin', passwordHash },
  ];
}
const login = async (app, username, password = PASSWORD) => sessionCookie(await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username, password }) }));
const overview = (app, cookies = {}, url = OVERVIEW, headers = {}) => app.inject({ method: 'GET', url, cookies, headers });

async function workspace(store, { profile = { synthetic: true }, name = 'Northwind Packaging (synthetic demo)' } = {}) {
  const tag = randomUUID().slice(0, 8);
  const owner = await store.createUser({ email: `owner-${tag}@northwind-demo.example`, name: 'Demo Owner (synthetic)', passwordHash: await hashPassword(OWNER_PASSWORD, { cost: 2 ** 12 }) });
  await store.setEmailVerified(owner.id);
  const ws = await store.createWorkspace({ kind: 'organization', name, slug: `northwind-${tag}`, profile, ownerId: owner.id });
  return { owner, ws };
}

// Owner, staff and runner actions recorded through the store, as the working app records them.
async function populate(store, owner, ws, { projectName = 'Support replies (synthetic)' } = {}) {
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: projectName, task: 'SECRET TASK TEXT', modalities: ['Text'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'exact', target: 'the right fact' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training', 'testing'] } } });
  await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: `ws/${ws.id}/projects/${project.id}/uploads/SECRET-OBJECT-KEY`, sha256: 'ab'.repeat(32), sizeBytes: 1234, contentType: 'application/jsonl', filename: 'SECRET-FILENAME.jsonl' });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id });
  const staff = await store.createUser({ email: `staff-${randomUUID().slice(0, 8)}@valcairn.example`, name: 'Staff (synthetic)', passwordHash: 'scrypt$unused' });
  await store.decideReview({ reviewId: review.id, reviewerId: staff.id, decision: 'approved', checks: { rights: true }, notes: 'SECRET REVIEWER NOTES' });
  const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });

  const key = `vrk_${'k'.repeat(43)}`;
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Lab workstation', keyHash: hashSecret(key), keyPrefix: key.slice(0, 10) });
  const job = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'train', spec: { plan: { name: 'SECRET PLAN NAME' } }, idempotencyKey: 'train-request-0001', createdBy: owner.id });
  const leaseHash = hashSecret('lease-token-0001');
  await store.leaseJob({ runnerId: runner.id, leaseHash });
  await store.finishJob({
    runnerId: runner.id, jobId: job.id, leaseHash, outcome: 'succeeded',
    result: {
      trainExamples: 228, heldOutExamples: 24, baseHeldOutLoss: 3.5, tunedHeldOutLoss: 0.9, trainSeconds: 61.5,
      evaluation: { metric: 'token f1', base: { f1: 0.25, n: 24 }, tuned: { f1: 0.75, n: 24 } },
      adapter: { sha256: 'cd'.repeat(32), location: '/srv/SECRET-ADAPTER-LOCATION' },
      samples: [{ prompt: 'SECRET PROMPT', base: 'SECRET BASE ANSWER', tuned: 'SECRET TUNED ANSWER' }],
      baseModel: { id: 'SECRET-MODEL-ID', weightsSha256: { 'model.safetensors': 'ef'.repeat(32) } },
    },
  });

  const set = await store.createEvalSet({ ...where, createdBy: owner.id, name: 'Warranty answers', purpose: 'development' });
  // The case cites the frozen dataset version (its rights allow testing), as the Evaluate page requires before a freeze.
  await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: set.revision, input: { id: 'warranty', input: 'SECRET QUESTION TEXT', expectedAnswer: 'SECRET EXPECTED ANSWER', sources: [{ projectId: project.id, versionId: version.id, fileId: null }] } });
  const revision = (await store.getEvalSet({ ...where, setId: set.id })).set.revision;
  const frozen = await store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: revision, actorId: owner.id });
  const imported = (role, label, output) => store.importEvalPredictions({ ...where, versionId: frozen.id, role, label, claimedSystem: { identity: `SECRET SYSTEM ${role}` }, claimedScorer: null, filename: null, jsonl: `${JSON.stringify({ id: 'warranty', status: 'answered', output })}\n`, importedBy: owner.id });
  const baseline = await imported('baseline', 'SECRET BATCH LABEL', 'SECRET WRONG OUTPUT');
  const candidate = await imported('candidate', 'SECRET CANDIDATE LABEL', 'SECRET EXPECTED ANSWER');
  const comparison = await store.createEvalComparison({ ...where, setId: set.id, versionId: frozen.id, baselineBatchId: baseline.batch.id, candidateBatchId: candidate.batch.id, createdBy: owner.id });
  const detail = await store.readEvalComparison({ workspaceId: ws.id, comparisonId: comparison.id });
  const report = await store.approveEvalReport({ workspaceId: ws.id, comparisonId: comparison.id, expectedRevision: detail.comparison.revision, contentHash: detail.contentHash, approvedBy: owner.id });

  const kase = await store.createCapitalCase({
    workspaceId: ws.id, createdBy: owner.id, title: 'SECRET CASE TITLE',
    draft: { ...emptyDraft(), purpose: 'SECRET PURPOSE TEXT', requestedAmountCents: 250_000_00, costItems: [{ id: 'gpu-hours', category: 'compute', label: 'SECRET COST LABEL', amountCents: 1_000_00, basis: 'estimated', period: 'one_time' }] },
  });
  return { project, version, runner, job, set, report, kase, key };
}

const CANARIES = ['SECRET', 'vrk_', 'keyHash', 'keyPrefix', 'passwordHash', 'objectKey', 'sha256', 'adapter', 'samples', 'prompt', 'leaseHash', '"spec"', '"result"', '"snapshot"', '"draft":{', '"notes"', '"email"', '"profile"', '"actorId"', '"metadata"', '"title"', '"caseKey"', '"output"', 'northwind-demo.example', 'valcairn.example'];

test('the overview needs a reviewer session and answers with private headers', async () => {
  const store = createMemoryStore();
  const { ws } = await workspace(store);
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(await reviewers()), DEMO_WORKSPACE_ID: ws.id } });
  const anonymous = await overview(app);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['cache-control'], 'private, no-store');
  assert.equal(anonymous.headers['x-robots-tag'], 'noindex');
  assert.ok(!anonymous.body.includes(ws.id), 'nothing about the workspace is told to a signed-out caller');

  const res = await overview(app, await login(app, 'ycinsider'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.json().workspace.id, ws.id);
  await app.close();
});

test('an active reviewer reads a curated projection of the pinned workspace and nothing beyond it', async () => {
  const store = createMemoryStore();
  const { owner, ws } = await workspace(store);
  const records = await populate(store, owner, ws);
  // A second synthetic workspace with the same kinds of records: never visible through the pinned one.
  const other = await workspace(store, { name: 'OTHER SYNTHETIC WORKSPACE' });
  await populate(store, other.owner, other.ws, { projectName: 'OTHER PROJECT NAME' });
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(await reviewers()), DEMO_WORKSPACE_ID: ws.id } });
  const cookies = await login(app, 'ycinsider');

  const res = await overview(app, cookies);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();
  const body = JSON.stringify(data);
  for (const canary of CANARIES) assert.ok(!body.includes(canary), `response must not contain ${canary}`);
  assert.ok(!body.includes('OTHER'), 'the other workspace is excluded');
  assert.ok(!body.includes(other.ws.id));

  assert.deepEqual(data.workspace, { id: ws.id, name: ws.name, slug: ws.slug, kind: 'organization', synthetic: true, createdAt: ws.createdAt });
  assert.equal(data.projects.length, 1);
  const [project] = data.projects;
  assert.equal(project.id, records.project.id);
  assert.equal(project.name, 'Support replies (synthetic)');
  assert.equal(project.status, 'versioned');
  assert.deepEqual(project.reviews, { pending: 0, approved: 1, changes_requested: 0, withdrawn: 0 });
  assert.deepEqual(project.versions, [{ number: 1, files: 1, annotations: 0, createdAt: records.version.createdAt }]);
  assert.deepEqual(project.evaluationSets.map((s) => [s.name, s.status, s.caseCount]), [['Warranty answers', 'frozen', 1]]);
  assert.deepEqual(Object.keys(project).sort(), ['createdAt', 'evaluationSets', 'id', 'modalities', 'name', 'reviews', 'startingPoint', 'status', 'updatedAt', 'versions']);

  assert.deepEqual(data.compute.runners.map(({ id, label, status, reportedGpus }) => ({ id, label, status, reportedGpus })), [{ id: records.runner.id, label: 'Lab workstation', status: 'active', reportedGpus: null }]);
  assert.deepEqual(Object.keys(data.compute.runners[0]).sort(), ['createdAt', 'id', 'label', 'lastSeenAt', 'reportedGpus', 'status']);
  assert.equal(data.compute.jobs.limit, 20);
  assert.equal(data.compute.jobs.basis, 'last_recorded');
  const [job] = data.compute.jobs.items;
  assert.equal(job.id, records.job.id);
  assert.equal(job.kind, 'train');
  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempt, 1);
  assert.equal(job.maxAttempts, 3);
  assert.equal(job.metrics.provenance, 'runner_reported');
  // Only allowlisted finite numbers, only those the runner reported: no zero for the absent step count or scores.
  assert.deepEqual(job.metrics.values, { trainExamples: 228, heldOutExamples: 24, baseHeldOutLoss: 3.5, tunedHeldOutLoss: 0.9, trainSeconds: 61.5, baseF1: 0.25, tunedF1: 0.75, heldOutScored: 24 });
  assert.ok(Object.keys(job.metrics.values).every((k) => k in METRIC_PATHS.train));
  assert.deepEqual(Object.keys(job).sort(), ['attempt', 'createdAt', 'failure', 'finishedAt', 'id', 'kind', 'maxAttempts', 'metrics', 'startedAt', 'status']);

  assert.equal(data.evaluation.reports.length, 1);
  const [report] = data.evaluation.reports;
  assert.equal(report.id, records.report.id);
  assert.equal(report.setId, records.set.id);
  assert.equal(report.setName, 'Warranty answers');
  assert.equal(report.setVersion, 1);
  assert.equal(report.decision, records.report.decision);
  assert.ok(['pass', 'fail', 'insufficient_evidence'].includes(report.decision));
  assert.equal(report.counts.eligible, 1);
  assert.equal(report.counts.passes, 1);
  assert.equal(report.passRate, 1);
  assert.deepEqual(Object.keys(report).sort(), ['approvedAt', 'counts', 'decision', 'denominator', 'id', 'passRate', 'revision', 'setId', 'setName', 'setVersion']);

  assert.equal(data.capital.available, true);
  const [kase] = data.capital.cases;
  assert.equal(kase.id, records.kase.id);
  assert.equal(kase.status, 'draft');
  assert.equal(kase.revision, 1);
  assert.equal(kase.costItems, 1);
  assert.equal(kase.requestedAmountCents, 250_000_00);
  assert.equal(kase.totals.estimated.one_time, 1_000_00);
  assert.deepEqual(Object.keys(kase).sort(), ['costItems', 'createdAt', 'id', 'requestedAmountCents', 'revision', 'status', 'submittedRevision', 'totals', 'updatedAt']);

  assert.equal(data.activity.limit, 25);
  const actions = data.activity.items.map((a) => a.action);
  for (const action of ['workspace.created', 'project.created', 'dataset_version.created', 'runner.linked', 'job.created', 'eval_report.approved', 'capital_case.created']) assert.ok(actions.includes(action), action);
  assert.deepEqual(Object.keys(data.activity.items[0]).sort(), ['action', 'at', 'targetType']);

  // Nothing a client sends selects a workspace: query strings, a path suffix or a header all read the pinned one.
  for (const [url, headers] of [[`${OVERVIEW}?workspaceId=${other.ws.id}`, {}], [`${OVERVIEW}?workspace=${other.ws.slug}&projectId=${other.ws.id}`, {}], [OVERVIEW, { 'x-workspace-id': other.ws.id }]]) {
    const attempt = await overview(app, cookies, url, headers);
    assert.equal(attempt.statusCode, 200, url);
    assert.equal(attempt.json().workspace.id, ws.id, url);
    assert.ok(!attempt.body.includes('OTHER'), url);
  }
  assert.equal((await overview(app, cookies, `${OVERVIEW}/${other.ws.id}`)).statusCode, 404);
  await app.close();
});

test('the reviewer read reports job state as last recorded and settles no leases', async () => {
  const clock = { now: new Date('2026-11-04T10:00:00Z') };
  const store = createMemoryStore({ now: () => clock.now });
  const { owner, ws } = await workspace(store);
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Lab workstation', keyHash: hashSecret('k'), keyPrefix: 'vrk_kkkkkk' });
  const job = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: 'probe-request-0001', createdBy: owner.id });
  await store.leaseJob({ runnerId: runner.id, leaseHash: hashSecret('lease') });
  clock.now = new Date('2026-11-04T10:10:00Z');
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(await reviewers()), DEMO_WORKSPACE_ID: ws.id } });
  const cookies = await login(app, 'ycinsider');

  const first = (await overview(app, cookies)).json().compute.jobs.items[0];
  assert.equal(first.id, job.id);
  assert.equal(first.status, 'leased', 'the overview shows the recorded state, even though the lease has run out');
  assert.deepEqual(first.metrics.values, {}, 'an unfinished job has no metrics and none are invented');
  // The ordinary job API settles the expired lease; only then does the overview see the new recorded state.
  assert.equal((await store.listJobs({ workspaceId: ws.id }))[0].status, 'queued');
  assert.equal((await overview(app, cookies)).json().compute.jobs.items[0].status, 'queued');
  await app.close();
});

test('a reviewer account disabled after sign-in is refused and signed out', async () => {
  // Reviewer accounts read from the store, as in production with Postgres.
  const store = { ...createMemoryStore(), kind: 'postgres' };
  const { ws } = await workspace(store);
  const app = await makeApp({ store, env: { DEMO_WORKSPACE_ID: ws.id } });
  await store.upsertReviewer({ username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash: await hashPassword(PASSWORD, { cost: 2 ** 12 }) });
  const cookies = await login(app, 'ycinsider');
  assert.equal((await overview(app, cookies)).statusCode, 200);

  await store.setReviewerEnabled({ username: 'ycinsider', enabled: false });
  const refused = await overview(app, cookies);
  assert.equal(refused.statusCode, 401);
  assert.ok(!refused.body.includes(ws.id));
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/session', cookies })).json(), { reviewer: null });
  await app.close();
});

test('unset, invalid, missing and non-synthetic configuration is unavailable, never a sample fallback', async () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), DEMO_WORKSPACE_ID: 'northwind-demo' }), /DEMO_WORKSPACE_ID/);
  assert.equal(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) }).demoWorkspaceId, null);
  assert.equal(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), DEMO_WORKSPACE_ID: '  ' }).demoWorkspaceId, null);
  const id = randomUUID();
  assert.equal(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), DEMO_WORKSPACE_ID: ` ${id} ` }).demoWorkspaceId, id);

  const store = createMemoryStore();
  const truthy = await workspace(store, { profile: { synthetic: 'yes' } });
  const unmarked = await workspace(store, { profile: {} });
  const env = { REVIEWERS_JSON: JSON.stringify(await reviewers()) };
  const cases = [
    [{ ...env }, store, 'demo_unconfigured'],
    [{ ...env, DEMO_WORKSPACE_ID: randomUUID() }, store, 'demo_workspace_missing'],
    [{ ...env, DEMO_WORKSPACE_ID: truthy.ws.id }, store, 'demo_workspace_not_synthetic'],
    [{ ...env, DEMO_WORKSPACE_ID: unmarked.ws.id }, store, 'demo_workspace_not_synthetic'],
    [{ ...env, DEMO_WORKSPACE_ID: randomUUID() }, null, 'store_unavailable'],
  ];
  for (const [vars, appStore, code] of cases) {
    const app = await makeApp({ store: appStore, env: vars });
    const res = await overview(app, await login(app, 'ycinsider'));
    assert.equal(res.statusCode, 503, code);
    assert.equal(res.json().code, code);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.ok(!res.body.includes('Northwind') && !('projects' in res.json()), `${code}: no data and no sample`);
    await app.close();
  }
  assert.deepEqual(await buildDemoOverview({ store, workspaceId: null }), { code: 'demo_unconfigured' });
});

test('an empty synthetic workspace shows empty sections, and owner actions appear on refresh', async () => {
  const store = createMemoryStore();
  const { owner, ws } = await workspace(store);
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(await reviewers()), DEMO_WORKSPACE_ID: ws.id } });
  const cookies = await login(app, 'ycinsider');

  const empty = (await overview(app, cookies)).json();
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.compute, { runners: [], jobs: { limit: 20, basis: 'last_recorded', items: [] } });
  assert.deepEqual(empty.evaluation, { reports: [] });
  assert.deepEqual(empty.capital, { available: true, cases: [] });
  assert.deepEqual(empty.activity.items.map((a) => a.action), ['workspace.created']);

  // The owner signs in with a normal account in another session and creates a project through the API.
  const signin = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: owner.email, password: OWNER_PASSWORD }) });
  assert.equal(signin.statusCode, 200, signin.body);
  const created = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/projects`, headers: postHeaders, cookies: sessionCookie(signin), payload: json({ name: 'Damaged boxes (synthetic)', task: 'Flag damaged boxes on line 2.', modalities: ['Images'], startingPoint: 'own' }) });
  assert.equal(created.statusCode, 200, created.body);

  const refreshed = (await overview(app, cookies)).json();
  assert.deepEqual(refreshed.projects.map((p) => [p.name, p.status, p.versions, p.evaluationSets]), [['Damaged boxes (synthetic)', 'draft', [], []]]);
  assert.deepEqual(refreshed.activity.items.map((a) => a.action), ['project.created', 'workspace.created']);
  assert.ok(!JSON.stringify(refreshed).includes(owner.email));
  // The reviewer session is still only a reviewer session: no account was attached to it.
  assert.equal((await app.inject({ method: 'GET', url: '/api/account', cookies })).json().user, null);
  await app.close();
});

test('the admin sign-in log is unchanged and separate from the overview', async () => {
  const store = createMemoryStore();
  const { ws } = await workspace(store);
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(await reviewers()), DEMO_WORKSPACE_ID: ws.id } });
  const viewer = await login(app, 'ycinsider');
  const admin = await login(app, 'admin');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/signins', cookies: viewer })).statusCode, 403);
  const log = await app.inject({ method: 'GET', url: '/api/admin/signins', cookies: admin });
  assert.equal(log.statusCode, 200);
  assert.deepEqual(log.json().events.map((e) => `${e.event}:${e.username}`), ['signin:admin', 'signin:ycinsider']);
  for (const cookies of [viewer, admin]) {
    const res = await overview(app, cookies);
    assert.equal(res.statusCode, 200);
    assert.ok(!('events' in res.json()) && !res.body.includes('ycinsider'), 'the overview carries no sign-in data');
  }
  await app.close();
});

test('the dashboard keeps the last good overview when a refresh fails, and says so', () => {
  const at = '2026-11-04T10:00:00.000Z';
  const later = '2026-11-04T10:05:00.000Z';
  const data = { workspace: { id: 'w1', name: 'Northwind' }, projects: [] };
  let state = reduceOverview(initialOverviewState, { type: 'load' });
  assert.equal(state.status, 'loading');
  state = reduceOverview(state, { type: 'result', result: { ok: true, status: 200, data }, at });
  assert.deepEqual(state, { status: 'ready', overview: data, fetchedAt: at, problem: null });

  const refreshing = reduceOverview(state, { type: 'load' });
  assert.equal(refreshing.status, 'refreshing');
  assert.equal(refreshing.overview, data, 'records stay on screen while refreshing');
  const stale = reduceOverview(refreshing, { type: 'result', result: { ok: false, status: 500, data: { error: 'Something went wrong on our side.' } }, at: later });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.overview, data, 'the last good records are kept');
  assert.equal(stale.fetchedAt, at, 'and labelled with the time they were fetched, not the failed attempt');
  assert.equal(stale.problem.message, 'Something went wrong on our side.');
  const offline = reduceOverview(stale, { type: 'failed', at: later });
  assert.equal(offline.status, 'stale');
  assert.equal(offline.problem.code, 'network');

  // A first load that fails has nothing to keep; the server saying "unavailable" replaces any earlier data.
  const error = reduceOverview(reduceOverview(initialOverviewState, { type: 'load' }), { type: 'failed', at });
  assert.deepEqual(error, { status: 'error', overview: null, fetchedAt: null, problem: { code: 'network', message: 'The overview could not be reached. Check your connection and refresh.', status: null } });
  const unavailable = reduceOverview(stale, { type: 'result', result: { ok: false, status: 503, data: { error: 'Not configured.', code: 'demo_unconfigured' } }, at: later });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.overview, null);
  assert.equal(unavailable.problem.code, 'demo_unconfigured');
  const signedOut = reduceOverview(stale, { type: 'result', result: { ok: false, status: 401, data: { error: 'Sign in first.' } }, at: later });
  assert.equal(signedOut.status, 'signed_out');
  assert.equal(signedOut.overview, null);
});

// The loader as the dashboard drives it: real deferred completions, applied through the reducer.
function loaderHarness() {
  const pending = [];
  let tick = 0;
  let state = initialOverviewState;
  const applied = [];
  const fetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const apply = (event) => { applied.push(event); state = reduceOverview(state, event); };
  const make = () => createOverviewLoader({ fetch, apply, now: () => `2026-11-04T10:0${tick += 1}:00.000Z` });
  const ok = (name) => ({ ok: true, status: 200, data: { workspace: { id: 'w1', name }, projects: [] } });
  return { pending, make, ok, applied, state: () => state };
}

test('a newer overview response is never overwritten by an older one that resolves later', async () => {
  const h = loaderHarness();
  const loader = h.make();
  const older = loader.load();
  const newer = loader.load();
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(h.ok('fresh'));
  await newer;
  assert.equal(h.state().status, 'ready');
  assert.equal(h.state().overview.workspace.name, 'fresh');
  const fetchedAt = h.state().fetchedAt;
  h.pending[0].resolve(h.ok('stale'));
  await older;
  assert.equal(h.state().overview.workspace.name, 'fresh', 'the older success is ignored');
  assert.equal(h.state().fetchedAt, fetchedAt, 'and the fetched time still names the newer response');

  // An older 401 (a request issued before a fresh sign-in) does not sign out the newer authorized view.
  const unauthorized = loader.load();
  const authorized = loader.load();
  h.pending[3].resolve(h.ok('after sign-in'));
  await authorized;
  h.pending[2].resolve({ ok: false, status: 401, data: { error: 'Sign in first.' } });
  await unauthorized;
  assert.equal(h.state().status, 'ready');
  assert.equal(h.state().overview.workspace.name, 'after sign-in');

  // A superseded failure is ignored too; only the newest request's failure marks the view stale, keeping its records.
  const droppedFailure = loader.load();
  const latest = loader.load();
  h.pending[5].reject(new Error('offline'));
  await latest;
  assert.equal(h.state().status, 'stale');
  assert.equal(h.state().overview.workspace.name, 'after sign-in');
  h.pending[4].reject(new Error('offline'));
  await droppedFailure;
  assert.equal(h.state().status, 'stale');
  assert.equal(h.applied.filter((e) => e.type !== 'load').length, 3, 'only the three newest completions were applied; the three superseded ones were dropped');
});

test('a completion that arrives after unmount is ignored, including StrictMode rehearsal mounts', async () => {
  const h = loaderHarness();
  // StrictMode: mount, unmount, mount again. The rehearsal loader is stopped before the real one starts.
  const rehearsal = h.make();
  const first = rehearsal.load();
  rehearsal.stop();
  const real = h.make();
  const second = real.load();
  assert.equal(h.pending.length, 2);
  h.pending[0].resolve(h.ok('rehearsal'));
  await first;
  assert.equal(h.state().status, 'loading', 'the stopped loader applied nothing');
  assert.equal(h.state().overview, null);
  h.pending[1].resolve(h.ok('real'));
  await second;
  assert.equal(h.state().overview.workspace.name, 'real');

  // Unmount while a refresh is in flight: its completion, success or failure, changes nothing afterwards.
  const inflight = real.load();
  const inflightFailure = real.load();
  real.stop();
  const before = h.state();
  h.pending[3].reject(new Error('offline'));
  await inflightFailure;
  h.pending[2].resolve(h.ok('too late'));
  await inflight;
  assert.equal(h.state(), before);
  await real.load();
  assert.equal(h.applied.length, 5, 'a stopped loader issues no further requests or events');
});

test('capital planning totals stay separate by basis and period in the dashboard derivation', () => {
  const totals = totalsByBasis([
    { basis: 'estimated', period: 'one_time', amountCents: 10000 },
    { basis: 'estimated', period: 'monthly', amountCents: 2000 },
    { basis: 'estimated', period: 'annual', amountCents: 30000 },
    { basis: 'quoted', period: 'monthly', amountCents: 500 },
  ]);
  const lines = costTotalLines(totals);
  assert.deepEqual(lines.map(({ basis, period, cents }) => [basis, period, cents]), [
    ['quoted', 'monthly', 500], ['estimated', 'one_time', 10000], ['estimated', 'monthly', 2000], ['estimated', 'annual', 30000],
  ]);
  assert.deepEqual(lines.map((l) => l.label), ['quoted $5.00 per month', 'estimated $100.00 one-time', 'estimated $20.00 per month', 'estimated $300.00 per year']);
  assert.ok(lines.every((l) => l.cents !== 42000) && !lines.some((l) => l.label.includes('$420.00')), 'unlike periods are never added into one figure');
  assert.deepEqual(costTotalLines(totalsByBasis([])), [], 'no cost items means no lines, not a zero line');
  assert.deepEqual(costTotalLines(undefined), []);
});
