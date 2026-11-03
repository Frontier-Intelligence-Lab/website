import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { makeApp, json, postHeaders } from './helpers.js';

// Keeps the session cookie between calls, like a browser.
function client(app) {
  let cookies = {};
  const call = async (method, url, body, headers = postHeaders) => {
    const res = await app.inject({ method, url, cookies, headers: method === 'GET' ? {} : headers, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url) => call('GET', url), post: (url, body = {}, headers) => call('POST', url, body, headers) };
}

async function verifiedUser(app, email, name = 'Person') {
  const c = client(app);
  const signup = await c.post('/api/account/signup', { name, email, password: 'long-enough-password' });
  assert.equal(signup.statusCode, 200, signup.body);
  assert.match(signup.json().devCode, /^\d{6}$/);
  const verify = await c.post('/api/account/verify', { code: signup.json().devCode });
  assert.equal(verify.statusCode, 200, verify.body);
  return { c, verify: verify.json() };
}

test('sign-up, email confirmation and organization creation; colleagues request to join and an admin approves', async () => {
  const app = await makeApp();
  const { c: alex } = await verifiedUser(app, 'Alex@Acme-Robotics.com', 'Alex');
  const created = await alex.post('/api/workspaces', { name: 'Acme Robotics', website: 'https://www.acme-robotics.com', joinByDomain: true, sizeBand: '11-50' });
  assert.equal(created.statusCode, 200, created.body);
  const ws = created.json().workspace;
  assert.equal(ws.slug, 'acme-robotics');
  assert.equal(ws.domainVerified, true);
  assert.equal(ws.joinByDomain, true);
  assert.equal((await alex.get('/api/account')).json().workspaces[0].role, 'owner');
  assert.equal((await alex.get('/api/workspaces/slug-available?slug=Acme%20Robotics')).json().available, false);

  const { c: priya, verify } = await verifiedUser(app, 'priya@acme-robotics.com', 'Priya');
  assert.equal(verify.match.id, ws.id);
  assert.equal((await priya.get(`/api/workspaces/${ws.id}`)).statusCode, 404);
  const asked = await priya.post(`/api/workspaces/${ws.id}/join-requests`, { note: 'Perception team' });
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal((await priya.get('/api/account')).json().joinRequests[0].workspaceName, 'Acme Robotics');

  const pending = (await alex.get(`/api/workspaces/${ws.id}`)).json().joinRequests;
  assert.equal(pending.length, 1);
  const decided = await alex.post(`/api/workspaces/${ws.id}/join-requests/${pending[0].id}/decision`, { approve: true });
  assert.equal(decided.json().joinRequest.status, 'approved');
  assert.equal((await priya.get(`/api/workspaces/${ws.id}`)).json().role, 'member');
  await app.close();
});

test('unconfirmed emails cannot create workspaces; wrong codes are rejected', async () => {
  const app = await makeApp();
  const c = client(app);
  const signup = await c.post('/api/account/signup', { name: 'Sam', email: 'sam@acme.com', password: 'long-enough-password' });
  const blocked = await c.post('/api/workspaces', { name: 'Acme' });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().code, 'email_unverified');
  const wrong = signup.json().devCode === '000000' ? '111111' : '000000';
  assert.equal((await c.post('/api/account/verify', { code: wrong })).statusCode, 400);
  assert.equal((await c.post('/api/account/verify', { code: 'abc' })).statusCode, 400);
  assert.equal((await c.post('/api/account/verify', { code: signup.json().devCode })).statusCode, 200);
  await app.close();
});

test('personal email domains never verify or match an organization', async () => {
  const app = await makeApp();
  const { c } = await verifiedUser(app, 'founder@gmail.com', 'Founder');
  const ws = (await c.post('/api/workspaces', { name: 'Side Project', joinByDomain: true })).json().workspace;
  assert.equal(ws.domain, null);
  assert.equal(ws.joinByDomain, false);
  const { verify } = await verifiedUser(app, 'other@gmail.com', 'Other');
  assert.equal(verify.match, null);
  await app.close();
});

test('workspaces are isolated: non-members get 404 and roles limit what members can do', async () => {
  const app = await makeApp();
  const { c: owner } = await verifiedUser(app, 'o@alpha.com', 'Owner');
  const alpha = (await owner.post('/api/workspaces', { name: 'Alpha Labs' })).json().workspace;
  const project = await owner.post(`/api/workspaces/${alpha.id}/projects`, { task: 'Flag damaged boxes on line 2', modalities: ['Images'], startingPoint: 'own' });
  assert.equal(project.statusCode, 200, project.body);
  const projectId = project.json().project.id;

  const { c: stranger } = await verifiedUser(app, 's@beta.com', 'Stranger');
  const beta = (await stranger.post('/api/workspaces', { name: 'Beta Corp' })).json().workspace;
  for (const url of [`/api/workspaces/${alpha.id}`, `/api/workspaces/${alpha.id}/projects`, `/api/workspaces/${alpha.id}/projects/${projectId}`, `/api/workspaces/${beta.id}/projects/${projectId}`]) {
    assert.equal((await stranger.get(url)).statusCode, 404, url);
  }
  assert.equal((await stranger.post(`/api/workspaces/${alpha.id}/projects/${projectId}`, { success: { measure: 'recall' } })).statusCode, 404);
  assert.equal((await stranger.post(`/api/workspaces/${beta.id}/projects/${projectId}`, { success: { measure: 'recall' } })).statusCode, 404);

  const invited = await owner.post(`/api/workspaces/${alpha.id}/invitations`, { invites: [{ email: 'v@alpha.com', role: 'viewer' }, { email: 'f@alpha.com', role: 'finance' }] });
  assert.equal(invited.json().saved, 2);
  assert.equal(invited.json().delivered, false);
  assert.match(invited.json().devLinks[0].link, /\/invite\/[\w-]{20,}$/);
  assert.equal((await owner.post(`/api/workspaces/${alpha.id}/invitations`, { invites: [{ email: 'x@alpha.com', role: 'owner' }] })).statusCode, 400);
  await app.close();
});

test('project setup saves validated steps and ignores fields it does not know', async () => {
  const app = await makeApp();
  const { c } = await verifiedUser(app, 'p@gamma.com', 'P');
  const ws = (await c.post('/api/workspaces', { name: 'Gamma' })).json().workspace;
  const bad = await c.post(`/api/workspaces/${ws.id}/projects`, { task: 'short', modalities: ['Smell'], startingPoint: 'maybe' });
  assert.deepEqual(Object.keys(bad.json().errors).sort(), ['modalities', 'startingPoint', 'task']);
  const { project } = (await c.post(`/api/workspaces/${ws.id}/projects`, { task: 'Flag damaged boxes. More detail here.', modalities: ['Images', 'Smell'], startingPoint: 'own' })).json();
  assert.equal(project.name, 'Flag damaged boxes');
  assert.deepEqual(project.modalities, ['Images']);
  const url = `/api/workspaces/${ws.id}/projects/${project.id}`;
  const step2 = (await c.post(url, { success: { measure: 'recall', target: '95%', runsOn: 'device', device: 'Jetson', extra: 'x' } })).json().project;
  assert.equal(step2.success.target, '95%');
  assert.equal(step2.success.extra, undefined);
  assert.equal(step2.setupStep, 'data');
  assert.equal((await c.post(url, { dataSource: { mode: 'upload', allowedUses: [] } })).statusCode, 400);
  const done = (await c.post(url, { dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training', 'testing'], personalData: 'no' } })).json().project;
  assert.equal(done.setupStep, 'done');
  assert.equal(done.status, 'draft');
  await app.close();
});

test('account routes fail closed: no store in production, signup closed, no codes leaked, CSRF checked', async () => {
  const prodEnv = { NODE_ENV: 'production', COOKIE_SECURE: 'true' };
  const prod = await makeApp({ env: prodEnv });
  const res = await prod.inject({ method: 'POST', url: '/api/account/signup', headers: postHeaders, payload: json({ name: 'A', email: 'a@b.co', password: 'long-enough-password' }) });
  assert.equal(res.statusCode, 503);
  assert.equal((await prod.inject({ method: 'GET', url: '/api/config' })).json().signupOpen, false);
  await prod.close();

  const closed = await makeApp({ env: { ...prodEnv, ACCOUNT_SIGNUP: 'false' }, store: createMemoryStore() });
  assert.equal((await closed.inject({ method: 'POST', url: '/api/account/signup', headers: postHeaders, payload: json({ name: 'A', email: 'a@b.co', password: 'long-enough-password' }) })).statusCode, 503);
  await closed.close();

  // Production with signup on but no SMTP: refuses instead of creating accounts nobody can confirm.
  const noMail = await makeApp({ env: { ...prodEnv, ACCOUNT_SIGNUP: 'true' }, store: createMemoryStore() });
  const nm = await noMail.inject({ method: 'POST', url: '/api/account/signup', headers: postHeaders, payload: json({ name: 'A', email: 'a@b.co', password: 'long-enough-password' }) });
  assert.equal(nm.statusCode, 503);
  assert.equal(nm.json().devCode, undefined);
  await noMail.close();

  const sent = [];
  const mailed = await makeApp({ env: { CONTACT_DELIVERY: 'smtp', SMTP_HOST: 'smtp.test', CONTACT_FROM: 'no-reply@test' }, mailTransport: { sendMail: async (m) => sent.push(m) } });
  const signup = await mailed.inject({ method: 'POST', url: '/api/account/signup', headers: postHeaders, payload: json({ name: 'A', email: 'a@b.co', password: 'long-enough-password' }) });
  assert.equal(signup.statusCode, 200);
  assert.equal(signup.json().devCode, undefined);
  assert.equal(sent[0].to, 'a@b.co');
  assert.match(sent[0].text, /\d{6}/);
  const csrf = await mailed.inject({ method: 'POST', url: '/api/account/signin', headers: { 'content-type': 'application/json' }, payload: json({ email: 'a@b.co', password: 'long-enough-password' }) });
  assert.equal(csrf.statusCode, 403);
  await mailed.close();
});

test('sign-in checks the password and onboarding pages are private app shells', async () => {
  const app = await makeApp();
  await verifiedUser(app, 'q@delta.com', 'Q');
  const c = client(app);
  assert.equal((await c.post('/api/account/signin', { email: 'q@delta.com', password: 'wrong-password-x' })).statusCode, 401);
  assert.equal((await c.post('/api/account/signin', { email: 'nobody@delta.com', password: 'long-enough-password' })).statusCode, 401);
  const ok = await c.post('/api/account/signin', { email: 'Q@delta.com', password: 'long-enough-password' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.passwordHash, undefined);
  for (const url of ['/signup', '/start', '/setup/organization', '/w/delta/projects/new']) {
    const page = await app.inject({ method: 'GET', url });
    assert.equal(page.statusCode, 200, url);
    assert.equal(page.headers['cache-control'], 'private, no-store', url);
  }
  assert.equal((await c.post('/api/account/signout')).statusCode, 200);
  assert.equal((await c.get('/api/account')).json().user, null);
  await app.close();
});

test('only owners and admins decide join requests; members are refused and declines add nobody', async () => {
  const app = await makeApp();
  const { c: owner } = await verifiedUser(app, 'boss@omega.com', 'Boss');
  const ws = (await owner.post('/api/workspaces', { name: 'Omega', joinByDomain: true })).json().workspace;
  const { c: first } = await verifiedUser(app, 'first@omega.com', 'First');
  const { c: second } = await verifiedUser(app, 'second@omega.com', 'Second');
  await first.post(`/api/workspaces/${ws.id}/join-requests`, { note: 'Data team' });
  await second.post(`/api/workspaces/${ws.id}/join-requests`, {});

  const listed = (await owner.get(`/api/workspaces/${ws.id}`)).json().joinRequests;
  assert.deepEqual(listed.map((r) => [r.name, r.email, r.note]).sort(), [['First', 'first@omega.com', 'Data team'], ['Second', 'second@omega.com', '']]);
  assert.ok(listed.every((r) => r.userId === undefined));
  const byName = Object.fromEntries(listed.map((r) => [r.name, r.id]));

  assert.equal((await owner.post(`/api/workspaces/${ws.id}/join-requests/${byName.First}/decision`, { approve: true })).statusCode, 200);
  // First is now a Member: may see the workspace but not decide, and sees no pending requests.
  const asMember = (await first.get(`/api/workspaces/${ws.id}`)).json();
  assert.equal(asMember.role, 'member');
  assert.deepEqual(asMember.joinRequests, []);
  assert.equal((await first.post(`/api/workspaces/${ws.id}/join-requests/${byName.Second}/decision`, { approve: true })).statusCode, 403);
  // Not a member at all: 404.
  assert.equal((await second.post(`/api/workspaces/${ws.id}/join-requests/${byName.Second}/decision`, { approve: true })).statusCode, 404);

  const declined = await owner.post(`/api/workspaces/${ws.id}/join-requests/${byName.Second}/decision`, { approve: false });
  assert.equal(declined.json().joinRequest.status, 'declined');
  assert.equal((await second.get(`/api/workspaces/${ws.id}`)).statusCode, 404);
  assert.equal((await owner.post(`/api/workspaces/${ws.id}/join-requests/${byName.Second}/decision`, { approve: true })).statusCode, 409);
  assert.equal((await owner.get(`/api/workspaces/${ws.id}`)).json().members.length, 2);
  await app.close();
});

test('projects that start from an existing model record the model, not a data source', async () => {
  const app = await makeApp();
  const { c } = await verifiedUser(app, 'ml@sigma.com', 'ML');
  const ws = (await c.post('/api/workspaces', { name: 'Sigma' })).json().workspace;
  const { project } = (await c.post(`/api/workspaces/${ws.id}/projects`, { task: 'Route support tickets to the right team.', modalities: ['Text'], startingPoint: 'model' })).json();
  const url = `/api/workspaces/${ws.id}/projects/${project.id}`;
  assert.equal((await c.post(url, { success: { measure: 'accuracy', target: '90%' } })).json().project.setupStep, 'model');
  assert.equal((await c.post(url, { dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'] } })).statusCode, 400);

  const tryModel = (model) => c.post(url, { model });
  assert.deepEqual(Object.keys((await tryModel({})).json().errors).sort(), ['rightsConfirmed', 'source']);
  assert.ok((await tryModel({ source: 'endpoint', endpointUrl: 'http://insecure.example.com', rightsConfirmed: true })).json().errors.endpointUrl);
  assert.ok((await tryModel({ source: 'endpoint', endpointUrl: 'https://user:secret@api.example.com', rightsConfirmed: true })).json().errors.endpointUrl);
  assert.ok((await tryModel({ source: 'hub', rightsConfirmed: true })).json().errors.hubId);

  const saved = (await tryModel({ source: 'endpoint', endpointUrl: 'https://api.example.com/v1/classify', hubId: 'ignored', format: 'onnx', license: 'internal', rightsConfirmed: true, testSet: 'partial', testSetSize: '300 tickets' })).json().project;
  assert.equal(saved.setupStep, 'done');
  assert.equal(saved.model.endpointUrl, 'https://api.example.com/v1/classify');
  assert.equal(saved.model.hubId, null);
  assert.equal(saved.model.testSet, 'partial');
  assert.equal(saved.dataSource, null);

  const other = (await c.post(`/api/workspaces/${ws.id}/projects`, { task: 'Flag damaged boxes on line 2.', modalities: ['Images'], startingPoint: 'own' })).json().project;
  assert.equal((await c.post(`/api/workspaces/${ws.id}/projects/${other.id}`, { model: { source: 'hub', hubId: 'a/b', rightsConfirmed: true } })).statusCode, 400);
  await app.close();
});
