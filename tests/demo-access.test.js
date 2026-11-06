import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { DEMO_ALLOWED_MUTATIONS, DEMO_ALLOWED_READS, parseDemoReviewerUsers } from '../src/lib/demo-access.js';
import { FIXTURE_CATALOG, FIXTURE_DIST, json, postHeaders, reviewerFixture, sessionCookie } from './helpers.js';

// Reviewer entry into the real workspace: each configured reviewer username opens ITS OWN synthetic organization as a
// dedicated demo owner. Everything here is a labelled synthetic fixture; strings in capitals are canaries.
const YC = 'ycinsider';
const SR = 'sr008-reviewer';
const ADMIN = 'admin';
const PASSWORD = 'account-password-12';

function client(app, cookies = {}) {
  const call = async (method, url, body, headers = {}) => {
    const res = await app.inject({ method, url, cookies, headers: { ...(method === 'GET' ? {} : postHeaders), ...headers }, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url, headers) => call('GET', url, undefined, headers), post: (url, body = {}, headers) => call('POST', url, body, headers), cookies: () => cookies };
}

async function user(store, email, name, { verified = true } = {}) {
  const created = await store.createUser({ email, name, passwordHash: await hashPassword(PASSWORD, { cost: 2 ** 12 }) });
  return verified ? store.setEmailVerified(created.id) : created;
}
async function join(store, ws, invitedBy, member, role) {
  const tokenHash = `${member.email}-${ws.id}`;
  await store.createInvitations({ workspaceId: ws.id, invitedBy, invites: [{ email: member.email, role, tokenHash, expiresAt: new Date(Date.now() + 86400000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(tokenHash)).id, userId: member.id });
}
const organization = (store, ownerId, name, profile = { synthetic: true }) => store.createWorkspace({ kind: 'organization', name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`, profile, ownerId });
const project = (store, ws, createdBy, name) => store.createProject({ workspaceId: ws.id, createdBy, name, task: `${name} task`, modalities: ['Text'], startingPoint: 'own' });

// A simple session store so a test can inspect and shape a session the way a stale browser would present it.
function memorySessions() {
  const sessions = new Map();
  return {
    sessions,
    set: (id, session, cb) => { sessions.set(id, session); cb(); },
    get: (id, cb) => cb(null, sessions.get(id)),
    destroy: (id, cb) => { sessions.delete(id); cb(); },
    // The installed @fastify/session also requires compare-and-set; this store has no concurrent writers.
    compareAndSet: (id, _previous, session, cb) => { sessions.set(id, session); cb(); },
  };
}

/**
 * Two reviewer organizations (YC owned by "YC", a16z Speedrun owned by "a16z Speedrun"), the operator's pinned demo
 * workspace with its own owner and project, and a foreign organization. Each has a project whose name is a canary.
 */
async function fixture({ mapping = 'both', env = {}, sessionStore, storeKind } = {}) {
  const base = createMemoryStore();
  const store = storeKind ? { ...base, kind: storeKind } : base;
  const reviewer = await reviewerFixture();
  const ycOwner = await user(store, 'yc-owner@reviewer-demo.invalid', 'YC');
  const srOwner = await user(store, 'speedrun-owner@reviewer-demo.invalid', 'a16z Speedrun');
  const operator = await user(store, 'operator@northwind-qa.example', 'Demo Operator');
  const stranger = await user(store, 'owner@foreign-qa.example', 'Foreign Owner');
  const yc = await organization(store, ycOwner.id, 'YC');
  const sr = await organization(store, srOwner.id, 'a16z Speedrun');
  const pin = await organization(store, operator.id, 'Northwind (operator demo)');
  const foreign = await organization(store, stranger.id, 'FOREIGN SYNTHETIC ORG');
  const ycProject = await project(store, yc, ycOwner.id, 'YC project');
  const srProject = await project(store, sr, srOwner.id, 'SPEEDRUN PROJECT');
  const pinProject = await project(store, pin, operator.id, 'OPERATOR PROJECT');
  const foreignProject = await project(store, foreign, stranger.id, 'FOREIGN PROJECT');
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-reviewers-'));
  const file = path.join(dir, 'demo-reviewer-users.json');
  const entries = mapping === 'none' ? null : mapping === 'both' ? [{ username: YC, userId: ycOwner.id, workspaceId: yc.id }, { username: SR, userId: srOwner.id, workspaceId: sr.id }] : mapping;
  if (entries) writeFileSync(file, JSON.stringify(entries));
  const accounts = [[YC, 'YC reviewer', 'viewer'], [SR, 'Speedrun reviewer', 'viewer'], [ADMIN, 'Demo admin', 'admin']].map(([username, name, role]) => ({ username, name, role, passwordHash: reviewer.passwordHash }));
  const config = loadConfig({
    NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), MODEL_CATALOG_FILE: FIXTURE_CATALOG, DEMO_WORKSPACE_ID: pin.id,
    ...(entries ? { DEMO_REVIEWER_USERS_FILE: file } : {}), ...(storeKind ? {} : { REVIEWERS_JSON: JSON.stringify(accounts) }), ...env,
  });
  const app = await buildApp({ config, store, sessionStore, distDir: FIXTURE_DIST });
  await app.ready();
  const login = async (username) => {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username, password: reviewer.password }) });
    assert.equal(res.statusCode, 200, res.body);
    return { res, c: client(app, sessionCookie(res)) };
  };
  const close = async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, app, config, ycOwner, srOwner, operator, stranger, yc, sr, pin, foreign, ycProject, srProject, pinProject, foreignProject, reviewer, accounts, login, close };
}

const expectSignedOut = async (c, workspaceId) => {
  assert.equal((await c.get('/api/account')).json().user, null);
  assert.equal((await c.get(`/api/workspaces/${workspaceId}/projects`)).statusCode, 401);
};
const overviewOf = async (c) => c.get('/api/demo/overview');

test('the mapping file is strictly validated: entry shape, usernames, UUIDs, uniqueness, and never the operator pin', () => {
  const [u1, w1] = [randomUUID(), randomUUID()];
  assert.throws(() => parseDemoReviewerUsers('{}'), /array/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: 'not-a-uuid', workspaceId: w1 }])), (err) => /UUID/.test(err.message) && !err.message.includes('not-a-uuid'));
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1 }])), /workspaceId|organization/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: 'has space', userId: u1, workspaceId: w1 }])), /username/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1, workspaceId: w1, role: 'admin' }])), /unknown field/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1, workspaceId: w1, password: 'x' }])), /unknown field/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1, workspaceId: w1 }, { username: 'YCINSIDER', userId: randomUUID(), workspaceId: randomUUID() }])), /repeats a reviewer username/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1, workspaceId: w1 }, { username: SR, userId: u1.toUpperCase(), workspaceId: randomUUID() }])), /repeats a demo user id/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify([{ username: YC, userId: u1, workspaceId: w1 }, { username: SR, userId: randomUUID(), workspaceId: w1.toUpperCase() }])), /repeats a workspace id/);
  assert.throws(() => parseDemoReviewerUsers(JSON.stringify(['x'])), /entry 0/);
  assert.deepEqual(parseDemoReviewerUsers(JSON.stringify([{ username: ' YCINSIDER ', userId: u1.toUpperCase(), workspaceId: w1 }])), [{ username: YC, userId: u1, workspaceId: w1 }]);

  const dir = mkdtempSync(path.join(tmpdir(), 'demo-reviewers-'));
  try {
    const file = path.join(dir, 'map.json');
    const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) };
    writeFileSync(file, JSON.stringify([{ username: YC, userId: u1, workspaceId: w1 }]));
    assert.deepEqual(loadConfig({ ...base, DEMO_REVIEWER_USERS_FILE: file }).demoReviewerUsers, [{ username: YC, userId: u1, workspaceId: w1 }], 'the reviewer organizations do not depend on the operator pin');
    assert.throws(() => loadConfig({ ...base, DEMO_WORKSPACE_ID: w1.toUpperCase(), DEMO_REVIEWER_USERS_FILE: file }), /operator workspace/);
    writeFileSync(file, '{"ycinsider": "x"}');
    assert.throws(() => loadConfig({ ...base, DEMO_REVIEWER_USERS_FILE: file }), /DEMO_REVIEWER_USERS_FILE: must be a JSON array/);
    assert.deepEqual(loadConfig(base).demoReviewerUsers, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without a mapping (unset or empty), a viewer stays signed in but gets no overview and no workspace; only the admin keeps the operator overview', async () => {
  for (const mapping of ['none', []]) {
    const f = await fixture({ mapping });
    const { res, c } = await f.login(YC);
    assert.equal(res.json().to, undefined);
    assert.equal((await c.get('/api/session')).json().reviewer.username, YC, 'the reviewer sign-in itself is unchanged');
    const overview = await overviewOf(c);
    assert.equal(overview.statusCode, 403, JSON.stringify(mapping));
    assert.equal(overview.json().code, 'demo_overview_unavailable');
    assert.ok(!overview.body.includes('OPERATOR') && !overview.body.includes(f.pin.id) && !('projects' in overview.json()), 'never the operator records');
    const enter = await c.post('/api/demo/enter');
    assert.equal(enter.statusCode, 403);
    assert.equal(enter.json().code, 'demo_entry_unavailable');
    await expectSignedOut(c, f.yc.id);
    const admin = await f.login(ADMIN);
    const operator = await overviewOf(admin.c);
    assert.equal(operator.statusCode, 200);
    assert.equal(operator.json().workspace.id, f.pin.id, 'the admin reviewer keeps the operator overview');
    assert.equal((await admin.c.get('/api/admin/signins')).statusCode, 200);
    assert.equal((await c.get('/api/admin/signins')).statusCode, 403);
    await f.close();
  }
});

test('each reviewer enters its own organization as its dedicated owner; the admin reviewer is not mapped by role', async () => {
  const f = await fixture();
  const yc = await f.login(YC);
  assert.equal(yc.res.json().to, `/w/${f.yc.slug}/models`);
  assert.deepEqual([yc.res.json().workspace.id, yc.res.json().workspace.name], [f.yc.id, 'YC']);
  assert.ok(!yc.res.body.includes('passwordHash'));
  const account = (await yc.c.get('/api/account')).json();
  assert.deepEqual([account.user.id, account.user.name, account.user.passwordHash], [f.ycOwner.id, 'YC', undefined]);
  assert.deepEqual(account.workspaces.map((w) => [w.id, w.name, w.role, w.synthetic]), [[f.yc.id, 'YC', 'owner', true]]);
  assert.deepEqual([account.isStaff, account.staffScope, account.staffWorkspace, account.joinRequests, account.match, account.signupOpen], [false, null, null, [], null, false]);
  assert.deepEqual([account.demoAccess.reviewer.username, account.demoAccess.reviewer.role, account.demoAccess.workspace.name], [YC, 'viewer', 'YC']);
  assert.deepEqual([account.demoAccess.capabilities.runners, account.demoAccess.capabilities.jobs, account.demoAccess.capabilities.team, account.demoAccess.capabilities.plan], [false, false, false, true]);
  for (const canary of ['SPEEDRUN', 'OPERATOR', 'FOREIGN', f.operator.email, f.pin.id, f.sr.id]) assert.ok(!JSON.stringify(account).includes(canary), canary);

  // Real pages read real data of that organization, as its owner.
  const models = await yc.c.get(`/api/workspaces/${f.yc.id}/models`);
  assert.equal(models.statusCode, 200, models.body);
  assert.equal(models.json().role, 'owner');
  assert.ok(models.json().catalog.length > 0);
  assert.equal((await yc.c.get(`/api/workspaces/${f.yc.id}`)).json().workspace.name, 'YC');
  assert.deepEqual((await yc.c.get(`/api/workspaces/${f.yc.id}/projects`)).json().projects.map((p) => p.name), ['YC project']);
  for (const url of DEMO_ALLOWED_READS) assert.equal((await yc.c.get(url)).statusCode, 200, url);
  assert.equal((await yc.c.get('/api/session')).json().reviewer.username, YC, 'the reviewer session stays alongside the entry');
  // The overview is the same organization and nothing else.
  const overview = await overviewOf(yc.c);
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.json().workspace.id, f.yc.id);
  assert.ok(!overview.body.includes('SPEEDRUN') && !overview.body.includes('OPERATOR'));

  const sr = await f.login(SR);
  assert.equal(sr.res.json().to, `/w/${f.sr.slug}/models`);
  const srAccount = (await sr.c.get('/api/account')).json();
  assert.deepEqual([srAccount.user.id, srAccount.user.name, srAccount.workspaces[0].name, srAccount.workspaces[0].role], [f.srOwner.id, 'a16z Speedrun', 'a16z Speedrun', 'owner']);
  assert.notEqual(srAccount.user.id, account.user.id);
  assert.equal((await overviewOf(sr.c)).json().workspace.id, f.sr.id);
  assert.deepEqual((await sr.c.get(`/api/workspaces/${f.sr.id}/projects`)).json().projects.map((p) => p.name), ['SPEEDRUN PROJECT']);

  // The admin reviewer has no entry: no workspace by role, the operator overview and its log access unchanged.
  const admin = await f.login(ADMIN);
  assert.equal(admin.res.json().to, undefined);
  assert.equal((await admin.c.post('/api/demo/enter')).json().code, 'demo_entry_unavailable');
  assert.equal((await admin.c.get('/api/account')).json().user, null);
  assert.equal((await overviewOf(admin.c)).json().workspace.id, f.pin.id);
  assert.equal((await admin.c.get('/api/admin/signins')).statusCode, 200);
  assert.equal((await yc.c.get('/api/admin/signins')).statusCode, 403, 'a viewer reviewer never reads the log');

  // No password sharing or fixation: the owner's own sign-in does not take the reviewer password; each login is a fresh session.
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: f.ycOwner.email, password: f.reviewer.password }) })).statusCode, 401);
  const again = await f.login(YC);
  assert.notEqual(again.c.cookies()['valcairn.sid'], yc.c.cookies()['valcairn.sid']);
  await f.close();
});

test('one reviewer never reaches the other organization, the operator workspace or a foreign one, on any route family', async () => {
  const f = await fixture();
  const { c } = await f.login(YC);
  // Even an accidental membership elsewhere does not widen the bridged session.
  await join(f.store, f.sr, f.srOwner.id, f.ycOwner, 'admin');
  await join(f.store, f.pin, f.operator.id, f.ycOwner, 'admin');
  for (const [ws, p] of [[f.sr, f.srProject], [f.pin, f.pinProject], [f.foreign, f.foreignProject]]) {
    const o = ws.id;
    const reads = [`/api/workspaces/${o}`, `/api/workspaces/${o}/projects`, `/api/workspaces/${o}/projects/${p.id}`, `/api/workspaces/${o}/projects/${p.id}/dataset`,
      `/api/workspaces/${o}/projects/${p.id}/evaluations`, `/api/workspaces/${o}/models`, `/api/workspaces/${o}/enhance-runs/options`, `/api/workspaces/${o}/devices`,
      `/api/workspaces/${o}/capital`, `/api/workspaces/${o}/runners`, `/api/workspaces/${o}/jobs`, `/api/workspaces/${o}/projects?workspaceId=${f.yc.id}`,
      `/api/workspaces/${f.yc.id}/projects/${p.id}`, `/api/workspaces/${f.yc.id}/projects/${p.id}/dataset`];
    for (const url of reads) {
      const res = await c.get(url, { 'x-workspace-id': f.yc.id });
      assert.equal(res.statusCode, 404, url);
      assert.ok(!/SPEEDRUN|OPERATOR|FOREIGN/.test(res.body), url);
    }
    const before = (await f.store.listProjects(o)).length;
    for (const [url, body] of [[`/api/workspaces/${o}/projects`, { name: 'Sneaky', task: 'x', modalities: ['Text'], startingPoint: 'own' }], [`/api/workspaces/${o}/projects/${p.id}`, { name: 'Renamed' }],
      [`/api/workspaces/${o}/models/pulls`, { modelId: 'fixture-dense-8b' }], [`/api/workspaces/${o}/devices`, { label: 'Mine' }], [`/api/workspaces/${o}/capital/cases`, { title: 'x' }],
      [`/api/workspaces/${o}/projects/${p.id}/evaluations`, { name: 'x', purpose: 'development' }]]) {
      assert.equal((await c.post(url, body, { 'x-workspace-id': f.yc.id })).statusCode, 404, url);
    }
    assert.equal((await f.store.listProjects(o)).length, before);
    assert.equal((await f.store.getProject({ workspaceId: o, projectId: p.id })).name, p.name);
    assert.deepEqual(await f.store.listModelPulls(o), []);
  }
  // The overview stays this reviewer's own organization whatever the request names.
  for (const [url, headers] of [[`/api/demo/overview?workspaceId=${f.sr.id}`, {}], [`/api/demo/overview?workspace=${f.pin.id}`, { 'x-workspace-id': f.pin.id }]]) {
    const res = await c.get(url, headers);
    assert.equal(res.json().workspace.id, f.yc.id, url);
  }
  await f.close();
});

test('the overview binds to the reviewer entry before and after workspace entry, and never falls back to the operator pin', async () => {
  const f = await fixture();
  // Entry invalid at sign-in (organization not synthetic): no destination, no marker, and the overview is unavailable, not the operator's.
  await f.store.updateWorkspaceProfile({ workspaceId: f.yc.id, profile: { synthetic: false } });
  const { res, c } = await f.login(YC);
  assert.equal(res.json().to, undefined);
  let overview = await overviewOf(c);
  assert.equal(overview.statusCode, 503);
  assert.equal(overview.json().code, 'demo_entry_unavailable');
  assert.ok(!overview.body.includes('OPERATOR') && !overview.body.includes(f.pin.id));
  assert.equal((await c.post('/api/demo/enter')).json().code, 'demo_entry_unavailable');
  // Fixed: the reviewer's username alone locates its organization for the overview, before any workspace entry.
  await f.store.updateWorkspaceProfile({ workspaceId: f.yc.id, profile: { synthetic: true } });
  overview = await overviewOf(c);
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.json().workspace.id, f.yc.id);
  assert.equal((await c.get('/api/account')).json().user, null, 'the overview grants no workspace session by itself');
  assert.equal((await c.post('/api/demo/enter')).statusCode, 200);
  assert.equal((await c.get('/api/account')).json().user.id, f.ycOwner.id);
  // Invalidated again after entry: the overview is unavailable and the workspace session is gone, on the next request.
  const original = f.config.demoReviewerUsers;
  f.config.demoReviewerUsers = original.map((m) => (m.username === YC ? { ...m, userId: f.srOwner.id } : m));
  assert.equal((await overviewOf(c)).json().code, 'demo_entry_unavailable');
  await expectSignedOut(c, f.yc.id);
  // The entry removed altogether: a viewer with an old marker gets no overview at all, and never the operator's.
  f.config.demoReviewerUsers = original.filter((m) => m.username !== YC);
  const removed = await overviewOf(c);
  assert.equal(removed.statusCode, 403);
  assert.equal(removed.json().code, 'demo_overview_unavailable');
  assert.ok(!removed.body.includes('OPERATOR') && !removed.body.includes(f.pin.id) && !removed.body.includes(f.yc.id));
  await expectSignedOut(c, f.yc.id);
  f.config.demoReviewerUsers = original;
  await f.close();
});

test('an existing reviewer session enters with a same-origin POST, never a GET, and signs out of both identities at once', async () => {
  const f = await fixture();
  const { c } = await f.login(SR);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/demo/enter', headers: { 'content-type': 'application/json' }, cookies: c.cookies(), payload: '{}' })).statusCode, 403, 'no Origin');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/demo/enter', headers: { ...postHeaders, origin: 'https://evil.example' }, cookies: c.cookies(), payload: '{}' })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/demo/enter', cookies: c.cookies() })).statusCode, 404, 'no GET entry exists');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/demo/enter', headers: postHeaders, payload: '{}' })).statusCode, 401, 'anonymous');
  const enter = await c.post('/api/demo/enter');
  assert.equal(enter.statusCode, 200, enter.body);
  assert.equal(enter.json().to, `/w/${f.sr.slug}/models`);
  assert.equal(enter.headers['cache-control'], 'private, no-store');
  assert.equal((await c.get(`/api/workspaces/${f.sr.id}/projects`)).statusCode, 200);

  const out = await c.post('/api/logout');
  assert.equal(out.statusCode, 200);
  await expectSignedOut(c, f.sr.id);
  assert.equal((await c.get('/api/session')).json().reviewer, null);
  const admin = await f.login(ADMIN);
  assert.ok((await admin.c.get('/api/admin/signins')).json().events.some((e) => e.event === 'signout' && e.username === SR));

  // The workspace shell's other sign-out ends everything too.
  const yc = await f.login(YC);
  assert.equal((await yc.c.get('/api/account')).json().user.id, f.ycOwner.id);
  assert.equal((await yc.c.post('/api/account/signout')).statusCode, 200);
  await expectSignedOut(yc.c, f.yc.id);
  assert.equal((await yc.c.get('/api/session')).json().reviewer, null);
  await f.close();
});

test('every link is re-checked on each request: entry, workspace, synthetic flag, owner role, user, staff status and reviewer state', async () => {
  const f = await fixture();
  const { c } = await f.login(YC);
  const ok = async () => assert.equal((await c.get(`/api/workspaces/${f.yc.id}/projects`)).statusCode, 200);
  const reenter = async () => { assert.equal((await c.post('/api/demo/enter')).statusCode, 200); await ok(); };
  await ok();

  const original = f.config.demoReviewerUsers;
  f.config.demoReviewerUsers = original.filter((m) => m.username !== YC);
  await expectSignedOut(c, f.yc.id);
  f.config.demoReviewerUsers = original;
  await expectSignedOut(c, f.yc.id);
  await reenter();

  // The entry's workspace changed: the marker no longer matches, and the user is no owner there anyway.
  f.config.demoReviewerUsers = original.map((m) => (m.username === YC ? { ...m, workspaceId: f.foreign.id } : m));
  await expectSignedOut(c, f.yc.id);
  assert.equal((await c.post('/api/demo/enter')).json().code, 'demo_entry_unavailable');
  f.config.demoReviewerUsers = original;
  await reenter();

  for (const profile of [{ synthetic: 'yes' }, { synthetic: false }, {}]) {
    await f.store.updateWorkspaceProfile({ workspaceId: f.yc.id, profile });
    await expectSignedOut(c, f.yc.id);
  }
  await f.store.updateWorkspaceProfile({ workspaceId: f.yc.id, profile: { synthetic: true } });
  await reenter();

  // Demoted or removed owner membership.
  const getMembership = f.store.getMembership;
  f.store.getMembership = async (workspaceId, userId) => (userId === f.ycOwner.id && workspaceId === f.yc.id ? { role: 'admin' } : getMembership(workspaceId, userId));
  await expectSignedOut(c, f.yc.id);
  f.store.getMembership = async (workspaceId, userId) => (userId === f.ycOwner.id && workspaceId === f.yc.id ? null : getMembership(workspaceId, userId));
  await expectSignedOut(c, f.yc.id);
  f.store.getMembership = getMembership;
  await reenter();

  const getUserById = f.store.getUserById;
  f.store.getUserById = async (id) => (id === f.ycOwner.id ? null : getUserById(id));
  await expectSignedOut(c, f.yc.id);
  f.store.getUserById = getUserById;
  await reenter();

  f.config.staffEmails.push(f.ycOwner.email);
  await expectSignedOut(c, f.yc.id);
  f.config.staffEmails.pop();
  await reenter();
  f.config.demoStaffEmails.push(f.ycOwner.email);
  await expectSignedOut(c, f.yc.id);
  f.config.demoStaffEmails.pop();
  await reenter();

  // An entry to an unconfirmed user never enters.
  const unverified = await user(f.store, 'unverified-owner@reviewer-demo.invalid', 'Unverified', { verified: false });
  const extra = await organization(f.store, unverified.id, 'Unverified org');
  f.config.demoReviewerUsers = original.map((m) => (m.username === SR ? { ...m, userId: unverified.id, workspaceId: extra.id } : m));
  const sr = await f.login(SR);
  assert.equal(sr.res.json().to, undefined);
  assert.equal((await sr.c.post('/api/demo/enter')).json().code, 'demo_entry_unavailable');
  // An entry mispointed at a personal workspace, even a synthetic one the user owns, never enters: organizations only.
  const personal = await f.store.createWorkspace({ kind: 'personal', name: 'a16z Speedrun', slug: `personal-${randomUUID().slice(0, 6)}`, profile: { synthetic: true }, ownerId: f.srOwner.id });
  f.config.demoReviewerUsers = original.map((m) => (m.username === SR ? { ...m, workspaceId: personal.id } : m));
  const mispointed = await f.login(SR);
  assert.equal(mispointed.res.json().to, undefined);
  assert.equal((await mispointed.c.post('/api/demo/enter')).json().code, 'demo_entry_unavailable');
  assert.equal((await overviewOf(mispointed.c)).json().code, 'demo_entry_unavailable');
  f.config.demoReviewerUsers = original;
  await f.close();

  // A disabled reviewer account ends the entry at once (store-backed reviewer accounts, as in production).
  const g = await fixture({ storeKind: 'postgres' });
  for (const a of g.accounts) await g.store.upsertReviewer(a);
  const yc = await g.login(YC);
  assert.equal(yc.res.json().to, `/w/${g.yc.slug}/models`);
  assert.equal((await yc.c.get(`/api/workspaces/${g.yc.id}/models`)).statusCode, 200);
  await g.store.setReviewerEnabled({ username: YC, enabled: false });
  await expectSignedOut(yc.c, g.yc.id);
  assert.equal((await yc.c.get('/api/session')).json().reviewer, null);
  assert.equal((await overviewOf(yc.c)).statusCode, 401);
  await g.close();
});

test('mutations outside the allowlist are refused by registered route, whatever the URL looks like; allowed ones reach the route', async () => {
  const f = await fixture();
  const { c } = await f.login(YC);
  const fill = (pattern) => pattern.replace(':workspaceId', f.yc.id).replace(':projectId', f.ycProject.id).replace(':token', 'x'.repeat(30)).replace(/:[a-zA-Z]+/g, () => randomUUID());
  const skip = new Set(['/api/contact', '/api/login', '/api/logout', '/api/account/signin', '/api/account/signout', '/api/demo/enter']);
  const allowed = new Set(DEMO_ALLOWED_MUTATIONS);
  let denied = 0;
  let passed = 0;
  for (const entry of f.app.registeredRoutes) {
    const [method, pattern] = entry.split(' ');
    if (method !== 'POST' || !pattern.startsWith('/api/') || skip.has(pattern)) continue;
    const res = await c.post(fill(pattern), {});
    if (pattern.startsWith('/api/runner/')) { assert.equal(res.statusCode, 401, pattern); continue; }
    if (allowed.has(pattern)) {
      assert.notEqual(res.json().code, 'demo_access_denied', pattern);
      assert.ok([200, 400, 404, 409, 503].includes(res.statusCode), `${pattern} ${res.statusCode}`);
      passed += 1;
    } else {
      assert.equal(res.statusCode, 403, `${pattern} ${res.body}`);
      assert.equal(res.json().code, 'demo_access_denied', pattern);
      denied += 1;
    }
  }
  assert.equal(passed, DEMO_ALLOWED_MUTATIONS.length, 'every allowlisted pattern is a registered route the gate lets through');
  assert.equal(denied, 24, 'the denied set covers account, workspace, team, runner, job, case-run start, plan approval, Capital send, credit and staff routes');

  for (const url of ['/api/workspaces/slug-available?slug=x', '/api/staff/reviews', '/api/staff/capital', `/api/staff/reviews/${randomUUID()}`, `/api/staff/capital/${randomUUID()}`]) {
    const res = await c.get(url);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.json().code, 'demo_access_denied', url);
  }
  const p = f.yc.id;
  for (const [url, headers] of [[`/api/workspaces/${p}/runners/`, {}], [`/api/workspaces/${p}/RUNNERS`, {}], [`/api/workspaces/${p}/runners?allow=1`, {}], [`/api/workspaces/${p}/runners`, { 'x-http-method-override': 'GET' }],
    [`/api/workspaces/${p}/jobs`, { 'x-original-url': `/api/workspaces/${p}/projects` }], [`/api/workspaces/${p}%2Frunners`, {}], [`/api/workspaces/${p}/capital/credits`, { 'x-workspace-id': f.sr.id }]]) {
    const res = await c.post(url, { label: 'Mine' }, headers);
    assert.ok([403, 404].includes(res.statusCode), `${url} ${res.statusCode}`);
  }
  assert.equal((await c.post('/api/account/signup', { name: 'x', email: 'x@y.example', password: 'long-enough-password' })).json().code, 'demo_access_denied');
  assert.equal((await f.store.listWorkspacesForUser(f.ycOwner.id)).length, 1);
  assert.deepEqual(await f.store.listRunners(p), []);
  assert.deepEqual(await f.store.listJobs({ workspaceId: p }), []);
  assert.deepEqual(await f.store.listCreditRecords(p), []);
  assert.deepEqual(await f.store.listInvitations(p), []);
  await f.close();
});

test('allowed demo edits persist under each dedicated owner; execution and money authority stay refused', async () => {
  const f = await fixture();
  const yc = (await f.login(YC)).c;
  const sr = (await f.login(SR)).c;
  for (const [c, ws, ownerId] of [[yc, f.yc, f.ycOwner.id], [sr, f.sr, f.srOwner.id]]) {
    const p = ws.id;
    const created = await c.post(`/api/workspaces/${p}/projects`, { name: `${ws.name} reviewer project`, task: 'Flag damaged boxes.', modalities: ['Images'], startingPoint: 'own' });
    assert.equal(created.statusCode, 200, created.body);
    const projectId = created.json().project.id;
    assert.equal((await f.store.getProject({ workspaceId: p, projectId })).createdBy, ownerId);
    assert.equal((await c.post(`/api/workspaces/${p}/projects/${projectId}`, { success: { measure: 'recall', target: '95%', baseline: 'current' } })).statusCode, 200);
    assert.ok((await f.store.listAudit(p)).some((a) => a.action === 'project.updated' && a.actorId === ownerId), 'audit rows name this organization\'s dedicated owner');
    assert.equal((await c.post(`/api/workspaces/${p}/projects/${projectId}/evaluations`, { name: 'Reviewer set', purpose: 'development' })).statusCode, 200);
    assert.equal((await f.store.listEvalSets({ workspaceId: p, projectId })).length, 1);
    const pull = await c.post(`/api/workspaces/${p}/models/pulls`, { modelId: 'fixture-dense-8b' });
    assert.equal(pull.statusCode, 200, pull.body);
    assert.equal((await f.store.listModelPulls(p))[0].requestedBy, ownerId);
    assert.equal((await c.post(`/api/workspaces/${p}/devices`, { label: 'Reviewer laptop' })).statusCode, 200);
    assert.equal((await f.store.listDevices({ workspaceId: p, ownerId })).length, 1);
    const kase = await c.post(`/api/workspaces/${p}/capital/cases`, { title: 'Reviewer plan' });
    assert.equal(kase.statusCode, 200, kase.body);
    const caseId = kase.json().case.id;
    for (const [url, body] of [[`/api/workspaces/${p}/capital/cases/${caseId}/submit`, { expectedRevision: 1, contentHash: 'a'.repeat(64), sendToReview: true }], [`/api/workspaces/${p}/capital/cases/${caseId}/withdraw`, {}],
      [`/api/workspaces/${p}/capital/credits`, { provider: 'Cloud', status: 'claimed', amountCents: 100, expiresOn: null, restrictions: '', reference: '' }],
      [`/api/workspaces/${p}/runners`, { label: 'Mine' }], [`/api/workspaces/${p}/jobs`, { kind: 'probe', runnerId: randomUUID(), idempotencyKey: 'key-00000001' }],
      [`/api/workspaces/${p}/enhance-runs/${randomUUID()}/request`, { expectedUpdatedAt: new Date().toISOString() }], [`/api/workspaces/${p}/invitations`, { invites: [{ email: 'x@y.example', role: 'member' }] }]]) {
      assert.equal((await c.post(url, body)).json().code, 'demo_access_denied', url);
    }
    assert.equal((await f.store.getCapitalCase({ workspaceId: p, caseId })).status, 'draft');
    assert.deepEqual(await f.store.listCreditRecords(p), []);
  }
  // Device records stay with the identity that made them: neither owner sees the other's, in either organization.
  assert.equal((await f.store.listDevices({ workspaceId: f.yc.id, ownerId: f.srOwner.id })).length, 0);
  assert.equal((await f.store.listDevices({ workspaceId: f.sr.id, ownerId: f.ycOwner.id })).length, 0);
  await f.close();
});

test('normal accounts and staff are unchanged, and a normal account session is never overwritten by an entry', async () => {
  const sessions = memorySessions();
  const f = await fixture({ sessionStore: sessions, env: { STAFF_EMAILS: 'staff@valcairn-qa.example' } });
  const operator = client(f.app);
  assert.equal((await operator.post('/api/account/signin', { email: f.operator.email, password: PASSWORD })).statusCode, 200);
  const account = (await operator.get('/api/account')).json();
  assert.equal(account.user.id, f.operator.id);
  assert.equal(account.demoAccess, undefined);
  assert.ok('match' in account);
  assert.equal((await operator.post('/api/workspaces', { name: 'Second org' })).statusCode, 200, 'ordinary owners still create workspaces');
  assert.equal((await operator.post('/api/demo/enter')).statusCode, 401, 'a normal account is not a reviewer');
  assert.equal((await operator.get(`/api/workspaces/${f.yc.id}/projects`)).statusCode, 404, 'the operator is no member of a reviewer organization');

  // A session that somehow holds both a normal account and a reviewer: the account wins, the entry is refused.
  const yc = await f.login(YC);
  const stored = [...sessions.sessions.values()].find((s) => s.reviewer?.username === YC);
  assert.ok(stored, 'the reviewer session is in the store');
  stored.account = { userId: f.operator.id };
  const enter = await yc.c.post('/api/demo/enter');
  assert.equal(enter.statusCode, 409);
  assert.equal(enter.json().code, 'account_session');
  const mixed = (await yc.c.get('/api/account')).json();
  assert.equal(mixed.user.id, f.operator.id, 'the normal account identity is the one that acts');
  assert.equal(mixed.demoAccess, undefined);
  assert.equal((await yc.c.get(`/api/workspaces/${f.yc.id}/models`)).statusCode, 404, 'and it has no reach into the reviewer organization');
  const current = [...sessions.sessions.values()].find((s) => s.reviewer?.username === YC);
  assert.equal(current.demoAccess, undefined, 'the derived marker was dropped beside the normal account');
  delete current.account;
  assert.equal((await yc.c.get('/api/account')).json().user, null, 'no reviewer-derived access survives a normal account session');
  assert.equal((await yc.c.get(`/api/workspaces/${f.yc.id}/models`)).statusCode, 401);

  const staff = await user(f.store, 'staff@valcairn-qa.example', 'Staff');
  const sc = client(f.app);
  await sc.post('/api/account/signin', { email: staff.email, password: PASSWORD });
  assert.equal((await sc.get('/api/account')).json().isStaff, true);
  assert.equal((await sc.get('/api/staff/reviews')).statusCode, 200);
  await f.close();
});
