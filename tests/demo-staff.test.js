import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { loadConfig } from '../src/config.js';
import { capitalSnapshot, emptyDraft } from '../src/lib/capital.js';
import { snapshotHash } from '../src/lib/capital-hash.js';
import { scopeAllows, staffScopeFor } from '../src/lib/staff-scope.js';
import { makeApp, json, postHeaders, reviewerFixture, sessionCookie } from './helpers.js';

// Demo-scoped staff: a confirmed account in DEMO_STAFF_EMAILS may review the one synthetic workspace DEMO_WORKSPACE_ID
// names, and nothing else. Everything here is a labelled synthetic QA fixture; strings in capitals are canaries.
const PASSWORD = 'account-password-12';
const INGEST = { INGEST_PUBLIC_URL: 'http://localhost:4100', INGEST_SHARED_SECRET: 'ingest-secret-for-tests-32-characters!' };
const GLOBAL = 'global.staff@valcairn-qa.example';
const DEMO = 'demo.reviewer@valcairn-qa.example';
const SECOND = 'second.demo.reviewer@valcairn-qa.example';
const ALL_CHECKS = { rights: true, consent: true, labels: true, duplicates: true, format: true };

function client(app, cookies = {}) {
  const call = async (method, url, body, headers = {}) => {
    const res = await app.inject({ method, url, cookies, headers: { ...(method === 'GET' ? {} : postHeaders), ...headers }, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url, headers) => call('GET', url, undefined, headers), post: (url, body = {}) => call('POST', url, body) };
}

async function user(store, email, { verified = true } = {}) {
  const created = await store.createUser({ email, name: email.split('@')[0], passwordHash: await hashPassword(PASSWORD, { cost: 2 ** 12 }) });
  return verified ? store.setEmailVerified(created.id) : created;
}

async function signin(app, email) {
  const res = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email, password: PASSWORD }) });
  assert.equal(res.statusCode, 200, res.body);
  return client(app, sessionCookie(res));
}

const workspace = (store, ownerId, name, profile) => store.createWorkspace({ kind: 'organization', name, slug: `ws-${randomUUID().slice(0, 8)}`, profile, ownerId });

async function pendingReview(store, ownerId, ws, name) {
  const project = await store.createProject({ workspaceId: ws.id, createdBy: ownerId, name, task: `${name} task`, modalities: ['Images'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'], personalData: 'no' } } });
  await store.createUpload({ ...where, uploadedBy: ownerId, objectKey: `ws/${ws.id}/projects/${project.id}/uploads/${randomUUID()}`, sha256: 'ab'.repeat(32), sizeBytes: 10, contentType: 'image/png', filename: `${name}.png` });
  return store.submitForReview({ ...where, submittedBy: ownerId });
}

async function submittedCase(store, ownerId, ws, title) {
  const created = await store.createCapitalCase({ workspaceId: ws.id, createdBy: ownerId, title, draft: emptyDraft() });
  const draft = { ...emptyDraft(), purpose: `${title} purpose`, requestedAmountCents: 100000, costItems: [{ id: 'gpu', category: 'compute', label: 'GPU hours', amountCents: 1000, basis: 'estimated', period: 'one_time' }] };
  const kase = await store.updateCapitalCase({ workspaceId: ws.id, caseId: created.id, expectedRevision: 1, title, draft });
  const sub = await store.submitCapitalCase({ workspaceId: ws.id, caseId: kase.id, submittedBy: ownerId, expectedRevision: kase.revision, contentHash: snapshotHash(capitalSnapshot(kase, [], [])) });
  return { kase, sub };
}

async function join(store, ws, invitedBy, userId, email, role) {
  await store.createInvitations({ workspaceId: ws.id, invitedBy, invites: [{ email, role, tokenHash: `${email}-${ws.id}`, expiresAt: new Date(Date.now() + 86400000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(`${email}-${ws.id}`)).id, userId });
}

// A pinned synthetic workspace and a second synthetic workspace, each with a pending dataset review and a sent Capital case.
async function fixture({ pinnedProfile = { synthetic: true }, env = {} } = {}) {
  const store = createMemoryStore();
  const owner = await user(store, 'owner@northwind-qa.example');
  const otherOwner = await user(store, 'owner@other-qa.example');
  const pinned = await workspace(store, owner.id, 'Northwind (synthetic demo)', pinnedProfile);
  const other = await workspace(store, otherOwner.id, 'OTHER SYNTHETIC WORKSPACE', { synthetic: true });
  const pinnedReview = await pendingReview(store, owner.id, pinned, 'Pinned project');
  const otherReview = await pendingReview(store, otherOwner.id, other, 'OTHER PROJECT NAME');
  const pinnedCase = await submittedCase(store, owner.id, pinned, 'Pinned case');
  const otherCase = await submittedCase(store, otherOwner.id, other, 'OTHER CASE TITLE');
  const reviewer = await reviewerFixture();
  const app = await makeApp({ store, env: {
    ...INGEST, STAFF_EMAILS: GLOBAL, DEMO_WORKSPACE_ID: pinned.id, DEMO_STAFF_EMAILS: `${DEMO},${SECOND}`,
    REVIEWERS_JSON: JSON.stringify([{ username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash: reviewer.passwordHash }]), ...env,
  } });
  return { store, app, owner, otherOwner, pinned, other, pinnedReview, otherReview, pinnedCase, otherCase, reviewer };
}

// The account view must say exactly what the routes will do for this session.
async function expectAccess(c, { isStaff, scope = null, reviews, capital = reviews }) {
  const account = (await c.get('/api/account')).json();
  assert.equal(account.isStaff, isStaff);
  assert.equal(account.staffScope, scope);
  assert.equal((await c.get('/api/staff/reviews')).statusCode, reviews);
  assert.equal((await c.get('/api/staff/capital')).statusCode, capital);
  return account;
}

test('DEMO_STAFF_EMAILS is validated as email addresses, needs the pinned workspace and never overlaps global staff', () => {
  const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) };
  const id = randomUUID();
  assert.throws(() => loadConfig({ ...base, DEMO_STAFF_EMAILS: DEMO }), /DEMO_WORKSPACE_ID/);
  assert.throws(() => loadConfig({ ...base, DEMO_WORKSPACE_ID: id, DEMO_STAFF_EMAILS: `${DEMO},not-an-address` }), (err) => /email address/.test(err.message) && !err.message.includes('not-an-address') && !err.message.includes(DEMO));
  assert.throws(() => loadConfig({ ...base, DEMO_WORKSPACE_ID: id, STAFF_EMAILS: GLOBAL, DEMO_STAFF_EMAILS: GLOBAL.toUpperCase() }), (err) => /STAFF_EMAILS/.test(err.message) && !err.message.includes('global.staff'));
  const config = loadConfig({ ...base, DEMO_WORKSPACE_ID: id, DEMO_STAFF_EMAILS: ` ${DEMO.toUpperCase()} , ${SECOND} ,` });
  assert.deepEqual(config.demoStaffEmails, [DEMO, SECOND]);
  assert.deepEqual(loadConfig(base).demoStaffEmails, [], 'no demo staff by default');
  assert.deepEqual(loadConfig({ ...base, DEMO_WORKSPACE_ID: id }).demoStaffEmails, []);
});

test('the scope helper decides from the server alone and reaches nothing without a live synthetic pin', async () => {
  const verified = { id: 'u', email: DEMO, emailVerifiedAt: '2026-11-05T00:00:00.000Z' };
  const config = { staffEmails: [GLOBAL], demoStaffEmails: [DEMO], demoWorkspaceId: randomUUID() };
  const synthetic = { id: config.demoWorkspaceId, name: 'Pinned', profile: { synthetic: true } };
  const storeWith = (workspace) => ({ getWorkspace: async (id) => (workspace && id === config.demoWorkspaceId ? workspace : null) });
  assert.deepEqual(await staffScopeFor({ config, store: storeWith(synthetic), user: verified }), { global: false, workspaceId: synthetic.id, workspaceName: 'Pinned' });
  assert.deepEqual(await staffScopeFor({ config, store: storeWith(synthetic), user: { ...verified, email: GLOBAL } }), { global: true, workspaceId: null });
  assert.equal(await staffScopeFor({ config, store: storeWith(synthetic), user: { ...verified, emailVerifiedAt: null } }), null, 'an unconfirmed email is denied');
  assert.equal(await staffScopeFor({ config, store: storeWith(null), user: verified }), null, 'a missing pinned workspace grants nothing');
  assert.equal(await staffScopeFor({ config, store: storeWith({ ...synthetic, profile: { synthetic: 'yes' } }), user: verified }), null, 'synthetic must be exactly true');
  assert.equal(await staffScopeFor({ config: { ...config, demoWorkspaceId: null }, store: storeWith(synthetic), user: verified }), null);
  assert.equal(await staffScopeFor({ config, store: null, user: verified }), null, 'no store, no scope');
  assert.equal(await staffScopeFor({ config, store: storeWith(synthetic), user: { ...verified, email: 'someone@else.example', profile: { staff: true } } }), null);
  const demoScope = { global: false, workspaceId: synthetic.id };
  assert.equal(scopeAllows(demoScope, synthetic.id), true);
  assert.equal(scopeAllows(demoScope, randomUUID()), false);
  assert.equal(scopeAllows(demoScope, undefined), false);
  assert.equal(scopeAllows(demoScope, ''), false);
  assert.equal(scopeAllows({ global: true, workspaceId: null }, randomUUID()), true);
  assert.equal(scopeAllows(null, synthetic.id), false);
});

test('global staff are unchanged, and reviewer-only accounts still cannot become staff', async () => {
  const f = await fixture();
  await user(f.store, GLOBAL);
  const global = await signin(f.app, GLOBAL);
  const account = await expectAccess(global, { isStaff: true, scope: 'global', reviews: 200 });
  assert.equal(account.staffWorkspace, null);
  assert.deepEqual((await global.get('/api/staff/reviews')).json().reviews.map((r) => r.projectName).sort(), ['OTHER PROJECT NAME', 'Pinned project']);
  assert.equal((await global.get(`/api/staff/reviews/${f.otherReview.id}`)).statusCode, 200);
  assert.deepEqual((await global.get('/api/staff/capital')).json().cases.map((c) => c.workspaceId).sort(), [f.other.id, f.pinned.id].sort());
  assert.equal((await global.get(`/api/staff/capital/${f.otherCase.kase.id}`)).statusCode, 200);
  assert.equal((await global.post(`/api/staff/reviews/${f.otherReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS })).statusCode, 200);

  // An external demo reviewer (reviewer_accounts / REVIEWERS_JSON) is not a user: no account, no staff queue.
  const login = await f.app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username: 'ycinsider', password: f.reviewer.password }) });
  assert.equal(login.statusCode, 200);
  const cookies = sessionCookie(login);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/account', cookies })).json().user, null);
  for (const url of ['/api/staff/reviews', `/api/staff/reviews/${f.pinnedReview.id}`, '/api/staff/capital', `/api/staff/capital/${f.pinnedCase.kase.id}`]) {
    assert.equal((await f.app.inject({ method: 'GET', url, cookies })).statusCode, 401, url);
  }
  await f.app.close();
});

test('demo-scoped staff list, open, download-link and decide only the pinned synthetic workspace; everything else is 404 and untouched', async () => {
  const f = await fixture();
  await user(f.store, DEMO);
  const demo = await signin(f.app, DEMO);
  const account = await expectAccess(demo, { isStaff: true, scope: 'demo_workspace', reviews: 200 });
  assert.deepEqual(account.staffWorkspace, { id: f.pinned.id, name: f.pinned.name });

  // Lists are filtered in the store; nothing in the query or headers widens them.
  for (const [url, headers] of [['/api/staff/reviews', {}], [`/api/staff/reviews?workspaceId=${f.other.id}`, {}], [`/api/staff/reviews?status=pending&workspace=${f.other.id}&all=1`, {}], ['/api/staff/reviews', { 'x-workspace-id': f.other.id }]]) {
    const res = await demo.get(url, headers);
    assert.equal(res.statusCode, 200, url);
    assert.deepEqual(res.json().reviews.map((r) => [r.projectName, r.workspaceId]), [['Pinned project', f.pinned.id]], url);
    assert.ok(!res.body.includes('OTHER'), url);
  }
  const queue = await demo.get(`/api/staff/capital?workspaceId=${f.other.id}`);
  assert.deepEqual(queue.json().cases.map((c) => [c.workspaceId, c.title]), [[f.pinned.id, 'Pinned case']]);
  assert.ok(!queue.body.includes('OTHER'));

  // In scope: the frozen snapshot with signed download and preview links.
  const detail = await demo.get(`/api/staff/reviews/${f.pinnedReview.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().workspace.id, f.pinned.id);
  assert.match(detail.json().uploads[0].downloadUrl, /^http:\/\/localhost:4100\/v1\/objects\?token=/);
  assert.match(detail.json().uploads[0].previewUrl, /^http:\/\/localhost:4100\/v1\/preview\?token=/);

  // Out of scope: no detail, no link, no decision, no audit row, no change.
  const denied = await demo.get(`/api/staff/reviews/${f.otherReview.id}`);
  assert.equal(denied.statusCode, 404);
  assert.ok(!denied.body.includes('OTHER') && !denied.body.includes('token=') && !denied.body.includes(f.other.id));
  assert.equal((await demo.post(`/api/staff/reviews/${f.otherReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS })).statusCode, 404);
  assert.equal((await f.store.getReview(f.otherReview.id)).status, 'pending');
  assert.equal((await f.store.listAudit(f.other.id)).some((a) => a.action === 'review.opened'), false, 'nothing was recorded against the other workspace');
  assert.equal((await demo.get(`/api/staff/reviews/${randomUUID()}`)).statusCode, 404);

  const decided = await demo.post(`/api/staff/reviews/${f.pinnedReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal((await f.store.getReview(f.pinnedReview.id)).status, 'approved');
  assert.equal((await f.store.listAudit(f.pinned.id)).some((a) => a.action === 'review.opened'), true);

  // Capital: the same boundary on detail, decision and evidence marks; only the frozen snapshot is shown.
  assert.equal((await demo.get(`/api/staff/capital/${f.otherCase.kase.id}`)).statusCode, 404);
  assert.equal((await demo.post(`/api/staff/capital/${f.otherCase.kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: f.otherCase.sub.id })).statusCode, 404);
  assert.equal((await demo.post(`/api/staff/capital/${f.otherCase.kase.id}/evidence/${randomUUID()}/review`, { submissionId: f.otherCase.sub.id })).statusCode, 404);
  const untouched = await f.store.getCapitalCase({ workspaceId: f.other.id, caseId: f.otherCase.kase.id });
  assert.deepEqual([untouched.status, untouched.submittedRevision], ['submitted', f.otherCase.sub.revision]);
  assert.equal((await f.store.listAudit(f.other.id)).some((a) => a.action === 'capital.review_opened'), false);
  const view = await demo.get(`/api/staff/capital/${f.pinnedCase.kase.id}`);
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().submission.snapshot.title, 'Pinned case');
  assert.equal(view.json().submission.contentHash, f.pinnedCase.sub.contentHash);
  assert.equal(view.json().case.draft, undefined, 'no live draft leaves the server');
  assert.equal((await demo.post(`/api/staff/capital/${f.pinnedCase.kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: randomUUID() })).json().code, 'stale_submission', 'the submission guard still applies');
  const done = await demo.post(`/api/staff/capital/${f.pinnedCase.kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: f.pinnedCase.sub.id, notes: 'Looked at the plan.' });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await f.store.getCapitalCase({ workspaceId: f.pinned.id, caseId: f.pinnedCase.kase.id })).status, 'evidence_reviewed');
  await f.app.close();
});

test('demo-scoped staff cannot decide on a workspace they belong to, and their own other workspaces stay out of scope', async () => {
  const f = await fixture();
  const second = await user(f.store, SECOND);
  await join(f.store, f.pinned, f.owner.id, second.id, SECOND, 'viewer');
  const mine = await workspace(f.store, second.id, 'MY OWN SYNTHETIC WORKSPACE', { synthetic: true });
  const myReview = await pendingReview(f.store, second.id, mine, 'MY OWN PROJECT');
  const c = await signin(f.app, SECOND);
  await expectAccess(c, { isStaff: true, scope: 'demo_workspace', reviews: 200 });
  assert.deepEqual((await c.get('/api/staff/reviews')).json().reviews.map((r) => r.workspaceId), [f.pinned.id], 'the workspace the person owns is not the pinned one');
  assert.equal((await c.get(`/api/staff/reviews/${myReview.id}`)).statusCode, 404);
  assert.equal((await c.get(`/api/staff/reviews/${f.pinnedReview.id}`)).statusCode, 200, 'a member may still read the pinned review');
  const conflict = await c.post(`/api/staff/reviews/${f.pinnedReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS });
  assert.equal(conflict.statusCode, 403);
  assert.equal(conflict.json().code, 'conflict_of_interest');
  assert.equal((await f.store.getReview(f.pinnedReview.id)).status, 'pending');
  assert.equal((await c.get(`/api/staff/capital/${f.pinnedCase.kase.id}`)).json().conflict, true);
  assert.equal((await c.post(`/api/staff/capital/${f.pinnedCase.kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: f.pinnedCase.sub.id })).json().code, 'conflict_of_interest');
  assert.equal((await c.post(`/api/staff/capital/${f.pinnedCase.kase.id}/evidence/${randomUUID()}/review`, { submissionId: f.pinnedCase.sub.id })).json().code, 'conflict_of_interest');
  await f.app.close();
});

test('scope fails closed on a missing or non-synthetic pin, a removed or unconfirmed email, and a flag changed mid-session', async () => {
  const missing = await fixture({ env: { DEMO_WORKSPACE_ID: randomUUID() } });
  await user(missing.store, DEMO);
  await expectAccess(await signin(missing.app, DEMO), { isStaff: false, reviews: 404 });
  await missing.app.close();

  for (const pinnedProfile of [{ synthetic: 'yes' }, {}, { synthetic: 1 }]) {
    const f = await fixture({ pinnedProfile });
    await user(f.store, DEMO);
    const c = await signin(f.app, DEMO);
    await expectAccess(c, { isStaff: false, reviews: 404 });
    assert.equal((await c.get(`/api/staff/reviews/${f.pinnedReview.id}`)).statusCode, 404, JSON.stringify(pinnedProfile));
    await f.app.close();
  }

  const removed = await fixture({ env: { DEMO_STAFF_EMAILS: SECOND } });
  await user(removed.store, DEMO);
  await expectAccess(await signin(removed.app, DEMO), { isStaff: false, reviews: 404 });
  await removed.app.close();

  const unconfirmed = await fixture();
  await user(unconfirmed.store, DEMO, { verified: false });
  const u = await signin(unconfirmed.app, DEMO);
  const account = (await u.get('/api/account')).json();
  assert.equal(account.isStaff, false);
  assert.equal(account.staffScope, null);
  assert.equal((await u.get('/api/staff/reviews')).statusCode, 403, 'the confirmed-email guard answers first');
  assert.equal((await u.get(`/api/staff/reviews/${unconfirmed.pinnedReview.id}`)).statusCode, 403);
  assert.equal((await u.get('/api/staff/capital')).statusCode, 403);
  await unconfirmed.app.close();

  // The synthetic flag is re-read on every request: nothing is cached from an earlier grant.
  const live = await fixture();
  await user(live.store, DEMO);
  const c = await signin(live.app, DEMO);
  await expectAccess(c, { isStaff: true, scope: 'demo_workspace', reviews: 200 });
  await live.store.updateWorkspaceProfile({ workspaceId: live.pinned.id, profile: { synthetic: false } });
  await expectAccess(c, { isStaff: false, reviews: 404 });
  assert.equal((await c.get(`/api/staff/reviews/${live.pinnedReview.id}`)).statusCode, 404);
  assert.equal((await c.post(`/api/staff/reviews/${live.pinnedReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS })).statusCode, 404);
  assert.equal((await live.store.getReview(live.pinnedReview.id)).status, 'pending');
  await live.store.updateWorkspaceProfile({ workspaceId: live.pinned.id, profile: { synthetic: true } });
  await expectAccess(c, { isStaff: true, scope: 'demo_workspace', reviews: 200 });
  await live.app.close();
});

test('owners, admins, members, finance and viewers of the pinned workspace cannot grant themselves staff scope', async () => {
  const f = await fixture();
  const owner = await signin(f.app, 'owner@northwind-qa.example');
  await expectAccess(owner, { isStaff: false, reviews: 404 });
  for (const role of ['admin', 'member', 'finance', 'viewer']) {
    const email = `${role}@northwind-qa.example`;
    const u = await user(f.store, email);
    await join(f.store, f.pinned, f.owner.id, u.id, email, role);
    const c = await signin(f.app, email);
    await expectAccess(c, { isStaff: false, reviews: 404 });
    assert.equal((await c.get(`/api/staff/reviews/${f.pinnedReview.id}`)).statusCode, 404, role);
    assert.equal((await c.post(`/api/staff/reviews/${f.pinnedReview.id}/decision`, { decision: 'approved', checks: ALL_CHECKS })).statusCode, 404, role);
  }
  // Workspace profile flags, which owners can influence, carry no staff meaning.
  await f.store.updateWorkspaceProfile({ workspaceId: f.pinned.id, profile: { synthetic: true, staff: true, demoStaff: ['owner@northwind-qa.example'], staffEmails: 'owner@northwind-qa.example' } });
  await expectAccess(owner, { isStaff: false, reviews: 404 });
  assert.equal((await f.store.getReview(f.pinnedReview.id)).status, 'pending');
  await f.app.close();
});
