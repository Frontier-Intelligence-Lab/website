import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { createPostgresPool, createPostgresStore } from '../src/store/postgres.js';
import { createPgSessionStore } from '../src/store/pg-session-store.js';
import { applyMigrations } from '../scripts/migrate.js';
import { runStoreContract } from './store-contract.js';
import { makeApp, json, postHeaders } from './helpers.js';
import { signToken } from '../src/lib/tokens.js';
import { capitalSnapshot } from '../src/lib/capital.js';
import { snapshotHash } from '../src/lib/capital-hash.js';

// These tests reset ONLY the explicitly supplied, dedicated test database.
// No application connection string is ever used to establish a connection.
const connectionString = process.env.TEST_DATABASE_URL;
const options = { connectionString, ssl: 'disable' };
const dbIdentity = (value) => {
  const url = new URL(value);
  // pg accepts destination overrides in URL query parameters. Refuse ambiguous
  // targets before any connection or destructive reset, including the app URL.
  if (!url.hostname || !url.port || url.search) throw new Error('Database safety checks require explicit-host and port URLs without query parameters; unset DATABASE_URL when running isolated tests');
  const hostname = decodeURIComponent(url.hostname).toLowerCase();
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'loopback' : hostname;
  return `${host}:${url.port}${decodeURI(url.pathname)}`;
};
function validateTestDatabase(testUrl, applicationUrl) {
  const identity = dbIdentity(testUrl);
  const database = decodeURI(new URL(testUrl).pathname.slice(1));
  if (!/(^|[_-])test($|[_-])/i.test(database)) throw new Error('TEST_DATABASE_URL must name a dedicated test database (for example valcairn_test)');
  if (applicationUrl && identity === dbIdentity(applicationUrl)) {
    throw new Error('TEST_DATABASE_URL must not target the application DATABASE_URL database');
  }
}
if (connectionString) validateTestDatabase(connectionString, process.env.DATABASE_URL);

async function makeStore() {
  const pool = createPostgresPool(options);
  try {
    await applyMigrations({ pool });
    await pool.query('TRUNCATE TABLE reviewer_accounts, sessions, audit_events, dataset_versions, reviews, uploads, projects, join_requests, invitations, memberships, email_codes, workspaces, users RESTART IDENTITY CASCADE');
  } finally { await pool.end(); }
  return createPostgresStore(options);
}

// Node's top-level tests are serial: every makeStore starts with empty tables.
runStoreContract(connectionString ? test : test.skip, makeStore, 'postgres store');
const withStore = (name, fn) => test(`postgres store: ${name}`, { skip: !connectionString, concurrency: false }, async () => {
  const store = await makeStore();
  const pool = createPostgresPool(options);
  try { await fn(store, pool); } finally { await store.close(); await pool.end(); }
});
const user = (store, email = 'owner@example.test') => store.createUser({ email, name: 'Owner', passwordHash: 'test-hash' });
const workspace = (store, ownerId, extra = {}) => store.createWorkspace({ kind: 'organization', name: 'Example', slug: 'example', ownerId, ...extra });

withStore('parallel email-code consumers have exactly one winner', async (store) => {
  const { id: userId } = await user(store);
  await store.createEmailCode({ userId, email: 'owner@example.test', purpose: 'signup', codeHash: 'right', expiresAt: new Date(Date.now() + 60_000) });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'right' })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.reason === 'invalid').length, 7);
});

withStore('parallel wrong codes cannot bypass the attempt limit', async (store) => {
  const { id: userId } = await user(store);
  await store.createEmailCode({ userId, email: 'owner@example.test', purpose: 'academic', codeHash: 'right', expiresAt: new Date(Date.now() + 60_000) });
  await Promise.all(Array.from({ length: 8 }, () => store.consumeEmailCode({ userId, purpose: 'academic', codeHash: 'wrong' })));
  assert.deepEqual(await store.consumeEmailCode({ userId, purpose: 'academic', codeHash: 'right' }), { ok: false, reason: 'too_many_attempts' });
});

withStore('personal workspace uniqueness survives parallel requests', async (store) => {
  const owner = await user(store);
  const results = await Promise.allSettled(['personal-a', 'personal-b'].map(slug => workspace(store, owner.id, { kind: 'personal', slug })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'personal_exists');
  assert.equal((await store.listWorkspacesForUser(owner.id)).length, 1);
});

withStore('concurrent invitation replacement keeps one pending invite', async (store) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  await Promise.all(['first', 'second'].map(tokenHash => store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: 'INVITEE@example.test', role: 'member', tokenHash, expiresAt: new Date(Date.now() + 60_000) }] })));
  const invites = await store.listInvitations(ws.id);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].email, 'invitee@example.test');
  assert.equal('tokenHash' in invites[0], false);
});

withStore('failed invitation batches roll back revocations and audit rows', async (store) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const invite = { email: 'invitee@example.test', role: 'member', tokenHash: 'original', expiresAt: new Date(Date.now() + 60_000) };
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [invite] });
  const before = await store.listInvitations(ws.id);
  const auditBefore = await store.listAudit(ws.id);
  await assert.rejects(store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [
    { ...invite, tokenHash: 'duplicate' }, { ...invite, email: 'second@example.test', tokenHash: 'duplicate' },
  ] }), { code: '23505' });
  assert.deepEqual(await store.listInvitations(ws.id), before);
  assert.deepEqual(await store.listAudit(ws.id), auditBefore);
});

withStore('workspace and owner roll back when audit insertion fails', async (store, pool) => {
  const owner = await user(store);
  await pool.query("ALTER TABLE audit_events ADD CONSTRAINT test_reject_creation CHECK (action <> 'workspace.created')");
  try {
    await assert.rejects(workspace(store, owner.id), { code: '23514' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM workspaces')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM memberships')).rows[0].count, 0);
  } finally { await pool.query('ALTER TABLE audit_events DROP CONSTRAINT test_reject_creation'); }
});

withStore('parallel join requests and decisions preserve a single outcome', async (store) => {
  const owner = await user(store);
  const joiner = await user(store, 'joiner@example.test');
  const ws = await workspace(store, owner.id);
  const requests = await Promise.all(Array.from({ length: 6 }, () => store.createJoinRequest({ workspaceId: ws.id, userId: joiner.id })));
  assert.equal(new Set(requests.map(r => r.id)).size, 1);
  const results = await Promise.allSettled([true, false].map(approve => store.decideJoinRequest({ workspaceId: ws.id, requestId: requests[0].id, deciderId: owner.id, approve })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'already_decided');
  const outcome = results.find(r => r.status === 'fulfilled').value;
  assert.equal(Boolean(await store.getMembership(ws.id, joiner.id)), outcome.status === 'approved');
});

withStore('normalization, safe shapes, first verification and nullable patches', async (store) => {
  const owner = await user(store, 'UPPER@example.test');
  const verified = await store.setEmailVerified(owner.id);
  assert.equal((await store.setEmailVerified(owner.id)).emailVerifiedAt, verified.emailVerifiedAt);
  const ws = await workspace(store, owner.id, { slug: 'UPPER-SLUG', domain: 'EXAMPLE.TEST' });
  assert.equal(ws.slug, 'upper-slug');
  assert.equal(await store.isSlugAvailable('UPPER-SLUG'), false);
  assert.match(ws.createdAt, /Z$/);
  assert.equal('personalOwnerId' in ws, false);
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Test', task: 'Classify', startingPoint: 'own' });
  await store.updateProject({ workspaceId: ws.id, projectId: project.id, patch: { success: { target: 1 }, dataSource: { kind: 'upload' } } });
  const reset = await store.updateProject({ workspaceId: ws.id, projectId: project.id, patch: { success: null, dataSource: null, modalities: [] } });
  assert.equal(reset.success, null);
  assert.equal(reset.dataSource, null);
  assert.deepEqual(reset.modalities, []);
  assert.equal(await store.getUserById('not-a-uuid'), null);
  assert.equal(await store.getWorkspace('not-a-uuid'), null);
});

withStore('parallel invitation acceptance has one winner and preserves existing roles', async (store) => {
  const owner = await user(store);
  const guest = await user(store, 'guest@example.test');
  const ws = await workspace(store, owner.id);
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: guest.email, role: 'finance', tokenHash: 'parallel-invite', expiresAt: new Date(Date.now() + 60_000) }] });
  const invite = await store.getInvitationByTokenHash('parallel-invite');
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => store.acceptInvitation({ invitationId: invite.id, userId: guest.id })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.code === 'already_decided'));
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: guest.email, role: 'viewer', tokenHash: 'role-preserved', expiresAt: new Date(Date.now() + 60_000) }] });
  const again = await store.getInvitationByTokenHash('role-preserved');
  assert.deepEqual(await store.acceptInvitation({ invitationId: again.id, userId: guest.id }), { workspaceId: ws.id, role: 'finance', alreadyMember: true });
  assert.deepEqual(await store.getMembership(ws.id, guest.id), { role: 'finance' });
  assert.equal('tokenHash' in again, false);
});

withStore('invitation acceptance and revocation roll back with their audit event', async (store, pool) => {
  const owner = await user(store);
  const guest = await user(store, 'guest@example.test');
  const ws = await workspace(store, owner.id);
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: guest.email, role: 'member', tokenHash: 'atomic-invite', expiresAt: new Date(Date.now() + 60_000) }] });
  const invite = await store.getInvitationByTokenHash('atomic-invite');
  await pool.query("ALTER TABLE audit_events ADD CONSTRAINT test_reject_invitation CHECK (action NOT IN ('invitation.accepted', 'invitation.revoked'))");
  try {
    await assert.rejects(store.acceptInvitation({ invitationId: invite.id, userId: guest.id }), { code: '23514' });
    assert.equal((await store.getInvitationByTokenHash('atomic-invite')).acceptedAt, null);
    assert.equal(await store.getMembership(ws.id, guest.id), null);
    await assert.rejects(store.revokeInvitation({ workspaceId: ws.id, invitationId: invite.id, actorId: owner.id }), { code: '23514' });
    assert.equal((await store.getInvitationByTokenHash('atomic-invite')).revokedAt, null);
  } finally { await pool.query('ALTER TABLE audit_events DROP CONSTRAINT test_reject_invitation'); }
});

withStore('concurrent profile updates preserve independent keys and merge shallowly', async (store) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id, { profile: { keep: 'yes', nested: { old: true } } });
  await Promise.all([
    store.updateWorkspaceProfile({ workspaceId: ws.id, profile: { academicEmail: 'student@uni.edu' } }),
    store.updateWorkspaceProfile({ workspaceId: ws.id, profile: { academicVerifiedAt: '2026-11-03T00:00:00.000Z', nested: { new: true } } }),
  ]);
  assert.deepEqual((await store.getWorkspace(ws.id)).profile, { keep: 'yes', academicEmail: 'student@uni.edu', academicVerifiedAt: '2026-11-03T00:00:00.000Z', nested: { new: true } });
});

const dataProject = async (store, suffix = '') => {
  const owner = await user(store, `owner${suffix}@example.test`);
  const ws = await workspace(store, owner.id, suffix ? { slug: `example-${suffix}` } : {});
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Dataset', task: 'Classify', startingPoint: 'own' });
  return { owner, ws, project, scope: { workspaceId: ws.id, projectId: project.id } };
};

withStore('parallel uploads mark duplicate content and reject reused object keys', async (store, pool) => {
  const { owner, scope } = await dataProject(store);
  const fields = { ...scope, uploadedBy: owner.id, sha256: 'b'.repeat(64), sizeBytes: 2048, contentType: 'text/plain', filename: 'sample.txt' };
  const uploads = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createUpload({ ...fields, objectKey: `objects/${i}` })));
  assert.equal(uploads.filter(u => u.duplicateOf === null).length, 1);
  const ids = new Set(uploads.map(u => u.id));
  assert.ok(uploads.every(u => u.duplicateOf === null || ids.has(u.duplicateOf)));
  assert.ok(uploads.every(u => u.sizeBytes === 2048 && /Z$/.test(u.createdAt)));
  await assert.rejects(store.createUpload({ ...fields, objectKey: 'objects/0' }), { code: 'duplicate_upload' });
  assert.equal((await store.listUploads(scope)).length, 8);
  const other = await workspace(store, owner.id, { slug: 'other' });
  assert.equal((await store.listUploads({ ...scope, workspaceId: other.id })).length, 0);
  await assert.rejects(pool.query('UPDATE uploads SET workspace_id = $1 WHERE id = $2', [other.id, uploads[0].id]), { code: '23503' });
});

withStore('parallel review submissions and decisions preserve one outcome', async (store) => {
  const { owner, scope } = await dataProject(store);
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => store.submitForReview({ ...scope, submittedBy: owner.id })));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.code === 'invalid_state'));
  const review = attempts.find(r => r.status === 'fulfilled').value;
  const decisions = await Promise.allSettled(['approved', 'changes_requested'].map(decision => store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision, checks: { rights: true } })));
  assert.equal(decisions.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(decisions.find(r => r.status === 'rejected').reason.code, 'already_decided');
  const decided = decisions.find(r => r.status === 'fulfilled').value;
  assert.equal((await store.getProject(scope)).status, decided.status);
  assert.equal((await store.getReview(review.id)).status, decided.status);
  assert.equal((await store.listProjectReviews(scope)).length, 1);
});

withStore('failed review operations roll back the review and project together', async (store, pool) => {
  const { owner, scope } = await dataProject(store);
  await pool.query("ALTER TABLE audit_events ADD CONSTRAINT test_reject_review CHECK (action NOT LIKE 'review.%')");
  try {
    await assert.rejects(store.submitForReview({ ...scope, submittedBy: owner.id }), { code: '23514' });
    assert.equal((await store.getProject(scope)).status, 'draft');
    assert.deepEqual(await store.listProjectReviews(scope), []);
  } finally { await pool.query('ALTER TABLE audit_events DROP CONSTRAINT test_reject_review'); }
  const review = await store.submitForReview({ ...scope, submittedBy: owner.id });
  await pool.query("ALTER TABLE audit_events ADD CONSTRAINT test_reject_decision CHECK (action <> 'review.approved')");
  try {
    await assert.rejects(store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved' }), { code: '23514' });
    assert.equal((await store.getProject(scope)).status, 'in_review');
    assert.equal((await store.getReview(review.id)).status, 'pending');
  } finally { await pool.query('ALTER TABLE audit_events DROP CONSTRAINT test_reject_decision'); }
});

withStore('dataset versions receive consecutive numbers under concurrency and roll back on failure', async (store, pool) => {
  const { owner, scope } = await dataProject(store);
  const review = await store.submitForReview({ ...scope, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved' });
  await pool.query("ALTER TABLE audit_events ADD CONSTRAINT test_reject_version CHECK (action <> 'dataset_version.created')");
  try {
    await assert.rejects(store.createDatasetVersion({ ...scope, createdBy: owner.id }), { code: '23514' });
    assert.equal((await store.getProject(scope)).status, 'approved');
    assert.deepEqual(await store.listDatasetVersions(scope), []);
  } finally { await pool.query('ALTER TABLE audit_events DROP CONSTRAINT test_reject_version'); }
  // One approval yields exactly one version, however many requests race for it.
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.createDatasetVersion({ ...scope, createdBy: owner.id })));
  const won = results.filter(r => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'invalid_state'));
  assert.equal(won[0].value.manifest.reviewId, review.id);
  assert.deepEqual((await store.listDatasetVersions(scope)).map(v => v.number), [1]);
  assert.equal((await store.getProject(scope)).status, 'versioned');
});

withStore('a held receipt racing submission is either in the reviewed snapshot or refused, never added after', async (store) => {
  for (let round = 0; round < 6; round++) {
    const { owner, scope } = await dataProject(store, `race${round}`);
    const upload = store.createUpload({ ...scope, uploadedBy: owner.id, objectKey: `race-${round}`, sha256: 'c'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'late.png' });
    const submit = store.submitForReview({ ...scope, submittedBy: owner.id });
    const [u, r] = await Promise.allSettled([upload, submit]);
    assert.equal(r.status, 'fulfilled');
    const inSnapshot = r.value.snapshot.files.some(f => f.objectKey === `race-${round}`);
    if (u.status === 'fulfilled') assert.ok(inSnapshot, 'a recorded upload must be in the snapshot');
    else { assert.equal(u.reason.code, 'invalid_state'); assert.ok(!inSnapshot); }
  }
});

withStore('reopening races versioning: either the version is made from the approved snapshot or the approval is void', async (store) => {
  const { owner, scope } = await dataProject(store);
  const review = await store.submitForReview({ ...scope, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved' });
  const [v, reopened] = await Promise.allSettled([store.createDatasetVersion({ ...scope, createdBy: owner.id }), store.reopenProject({ ...scope, actorId: owner.id })]);
  assert.equal(reopened.status, 'fulfilled', 'reopen works from approved or versioned');
  if (v.status === 'fulfilled') assert.deepEqual(v.value.manifest.files, review.snapshot.files);
  else assert.equal(v.reason.code, 'invalid_state');
  assert.equal((await store.getProject(scope)).status, 'draft');
  await assert.rejects(store.createDatasetVersion({ ...scope, createdBy: owner.id }), { code: 'invalid_state' });
});

withStore('freeze triggers refuse direct SQL edits and file changes on frozen projects', async (store, pool) => {
  const { owner, scope } = await dataProject(store);
  await store.createUpload({ ...scope, uploadedBy: owner.id, objectKey: 'kept', sha256: 'd'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'kept.png' });
  await store.submitForReview({ ...scope, submittedBy: owner.id });
  await assert.rejects(pool.query(`UPDATE projects SET data_source = '{"mode":"license"}'::jsonb WHERE id = $1`, [scope.projectId]), /project_frozen/);
  await assert.rejects(pool.query('DELETE FROM uploads WHERE project_id = $1', [scope.projectId]), /project_frozen/);
  await assert.rejects(pool.query(`INSERT INTO uploads (workspace_id, project_id, uploaded_by, object_key, sha256, size_bytes, content_type, filename)
    VALUES ($1, $2, $3, 'sneaky', $4, 1, 'image/png', 'x.png')`, [scope.workspaceId, scope.projectId, owner.id, 'e'.repeat(64)]), /project_frozen/);
  // Lifecycle status changes and cascading deletes still work.
  await pool.query("UPDATE projects SET setup_step = 'done' WHERE id = $1", [scope.projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [scope.projectId]);
});

withStore('account and dataset APIs complete a persisted review workflow', async (store) => {
  const secret = 'local-api-integration-secret-at-least-32-characters';
  // The outer fixture owns the pool; Fastify gets a non-owning store for this test.
  // Commit/delete calls to services/ingest are stubbed; the Rust service has its own tests.
  const app = await makeApp({ store: { ...store, close: async () => {} }, ingestClient: { commit: async (key) => key, remove: async () => {} }, env: {
    INGEST_PUBLIC_URL: 'http://localhost:4100', INGEST_SHARED_SECRET: secret, STAFF_EMAILS: 'staff@example.test',
  } });
  const person = async (email) => {
    let cookies = {};
    const call = async (method, url, body) => {
      const result = await app.inject({ method, url, cookies, headers: method === 'GET' ? {} : postHeaders, payload: body === undefined ? undefined : json(body) });
      const cookie = result.cookies.find(c => c.name === 'valcairn.sid');
      if (cookie) cookies = { 'valcairn.sid': cookie.value };
      assert.equal(result.statusCode, 200, `${method} ${url}: ${result.body}`);
      return result.json();
    };
    const created = await call('POST', '/api/account/signup', { email, name: email.split('@')[0], password: 'local-fixture-password' });
    await call('POST', '/api/account/verify', { code: created.devCode });
    return { call, id: created.user.id };
  };
  try {
    const owner = await person('owner@acme-example.com');
    const staff = await person('staff@example.test');
    const { workspace: ws } = await owner.call('POST', '/api/workspaces', { name: 'Integration Workspace' });
    const { project } = await owner.call('POST', `/api/workspaces/${ws.id}/projects`, { task: 'Classify sample documents', modalities: ['Documents'], startingPoint: 'own' });
    const base = `/api/workspaces/${ws.id}/projects/${project.id}`;
    await owner.call('POST', base, { success: { measure: 'recall', target: '95%', baseline: 'current' } });
    await owner.call('POST', base, { dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'], personalData: 'no' } });
    const receipt = signToken(secret, { v: 1, kind: 'receipt', ws: ws.id, project: project.id, by: owner.id, objectKey: 'api-integration/sample', sha256: 'c'.repeat(64), sizeBytes: 12, contentType: 'text/plain', filename: 'sample.txt', exp: Math.floor(Date.now() / 1000) + 60 });
    const { upload } = await owner.call('POST', `${base}/uploads`, { receipt });
    // Labels and their label set go through Postgres too, and land in the reviewed snapshot.
    const { labelSet } = await owner.call('POST', `${base}/label-set`, { labels: [{ name: 'invoice', scope: 'file', tone: 'blue' }] });
    await owner.call('POST', `${base}/items/${upload.id}/annotations`, { labelId: labelSet[0].id });
    const dataset = await owner.call('GET', `${base}/dataset`);
    assert.deepEqual([dataset.items[0].kind, dataset.items[0].labelCount, dataset.issues.length], ['text', 1, 0]);
    const { review } = await owner.call('POST', `${base}/submit`, {});
    const detail = await staff.call('GET', `/api/staff/reviews/${review.id}`);
    assert.equal(detail.project.name, project.name);
    assert.equal(detail.uploads.length, 1);
    await staff.call('POST', `/api/staff/reviews/${review.id}/decision`, { decision: 'approved', checks: { rights: true, consent: true, labels: true, duplicates: true, format: true } });
    const { version } = await owner.call('POST', `${base}/dataset-versions`, {});
    assert.equal(version.number, 1);
    assert.equal(version.files, 1);
    assert.equal((await store.getProject({ workspaceId: ws.id, projectId: project.id })).status, 'versioned');
    const [stored] = await store.listDatasetVersions({ workspaceId: ws.id, projectId: project.id });
    assert.equal(stored.manifest.files[0].sha256, 'c'.repeat(64));
    assert.equal(stored.manifest.annotations[0].labelId, labelSet[0].id);
    assert.equal(stored.manifest.labelSet[0].name, 'invoice');
  } finally { await app.close(); }
});

withStore('receipt replays at quota or during submission never delete registered object bytes', async (store) => {
  const { hashPassword } = await import('../src/lib/passwords.js');
  const password = 'local-receipt-regression-password';
  const owner = await store.createUser({ email: 'receipt@replay.test', name: 'Owner', passwordHash: await hashPassword(password, { cost: 2 ** 12 }) });
  await store.setEmailVerified(owner.id);
  const ws = await workspace(store, owner.id);
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Receipt replay', task: 'Classify', startingPoint: 'own' });
  const scope = { workspaceId: ws.id, projectId: project.id };
  const key = 'ws/receipt/project/uploads/original';
  const objects = new Set([key]);
  let submitDuringCommit = false;
  const secret = 'local-receipt-test-secret-at-least-32-characters';
  const app = await makeApp({ store: { ...store, close: async () => {} }, env: {
    INGEST_PUBLIC_URL: 'http://localhost:4100', INGEST_SHARED_SECRET: secret, PROJECT_MAX_FILES: '1',
  }, ingestClient: {
    async commit() {
      if (submitDuringCommit) {
        submitDuringCommit = false;
        await store.submitForReview({ ...scope, submittedBy: owner.id });
      }
      return key;
    },
    async remove(objectKey) { objects.delete(objectKey); },
  } });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: owner.email, password }) });
    assert.equal(login.statusCode, 200);
    const cookies = { 'valcairn.sid': login.cookies.find(c => c.name === 'valcairn.sid').value };
    const receipt = signToken(secret, { kind: 'receipt', ws: ws.id, project: project.id, by: owner.id, objectKey: 'pending/original', sha256: 'a'.repeat(64), sizeBytes: 12, contentType: 'text/plain', filename: 'sample.txt', exp: Math.floor(Date.now() / 1000) + 60 });
    const postReceipt = () => app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/projects/${project.id}/uploads`, headers: postHeaders, cookies, payload: json({ receipt }) });
    assert.equal((await postReceipt()).statusCode, 200);
    const replay = await postReceipt();
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, 'quota_exceeded');
    assert.equal(objects.has(key), true);
    submitDuringCommit = true;
    assert.equal((await postReceipt()).statusCode, 409);
    assert.equal(objects.has(key), true);
    assert.equal((await store.listUploads(scope)).length, 1);
    assert.equal((await store.listProjectReviews(scope))[0].snapshot.files[0].objectKey, key);
  } finally { await app.close(); }
});

withStore('a member cannot reopen approval after a stale route permission check', async (store) => {
  const { hashPassword } = await import('../src/lib/passwords.js');
  const password = 'local-reopen-regression-password';
  const owner = await user(store);
  const member = await store.createUser({ email: 'member@reopen.test', name: 'Member', passwordHash: await hashPassword(password, { cost: 2 ** 12 }) });
  await store.setEmailVerified(member.id);
  const ws = await workspace(store, owner.id);
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: member.email, role: 'member', tokenHash: 'reopen-race', expiresAt: new Date(Date.now() + 60_000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash('reopen-race')).id, userId: member.id });
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Reopen race', task: 'Classify', startingPoint: 'own' });
  const scope = { workspaceId: ws.id, projectId: project.id };
  const review = await store.submitForReview({ ...scope, submittedBy: owner.id });
  let approveAfterRead = false;
  const app = await makeApp({ store: { ...store, close: async () => {}, async getProject(where) {
    const read = await store.getProject(where);
    if (approveAfterRead && read?.status === 'in_review') {
      approveAfterRead = false;
      await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved' });
    }
    return read;
  } } });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: member.email, password }) });
    assert.equal(login.statusCode, 200);
    approveAfterRead = true;
    const result = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/projects/${project.id}/reopen`, headers: postHeaders, cookies: { 'valcairn.sid': login.cookies.find(c => c.name === 'valcairn.sid').value }, payload: '{}' });
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().code, 'forbidden');
    assert.equal((await store.getProject(scope)).status, 'approved');
    assert.equal((await store.getReview(review.id)).status, 'approved');
    assert.equal((await store.listAudit(ws.id)).some(event => event.action === 'project.reopened'), false);
    await store.reopenProject({ ...scope, actorId: owner.id });
    await store.submitForReview({ ...scope, submittedBy: owner.id });
    assert.equal((await store.reopenProject({ ...scope, actorId: member.id })).status, 'draft');
  } finally { await app.close(); }
});

withStore('migrations are repeatable, detect edits and roll back a failed file', async (_store, pool) => {
  assert.deepEqual(await applyMigrations({ pool }), []);
  const directory = await mkdtemp(join(tmpdir(), 'valcairn-migrations-'));
  const edited = join(directory, '001_init.sql');
  const failing = join(directory, '999_fail.sql');
  try {
    await writeFile(edited, 'SELECT 1;');
    await assert.rejects(applyMigrations({ pool, directory }), /has changed/);
    await unlink(edited);
    await writeFile(failing, 'CREATE TABLE migration_atomic_probe (id integer); SELECT missing_migration_function();');
    await assert.rejects(applyMigrations({ pool, directory }));
    assert.equal((await pool.query("SELECT to_regclass('migration_atomic_probe') AS name")).rows[0].name, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE filename = $1', ['999_fail.sql'])).rows[0].count, 0);
  } finally {
    await unlink(edited).catch(() => {});
    await unlink(failing).catch(() => {});
    await rmdir(directory);
  }
});

const call = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, result) => error ? reject(error) : resolve(result));
});

test('postgres connection policy cannot be downgraded by URL SSL parameters', async () => {
  for (const [mode, expected] of [['disable', false], ['require', { rejectUnauthorized: false }], ['verify-full', { rejectUnauthorized: true }]]) {
    const pool = createPostgresPool({ connectionString: 'postgresql://local@127.0.0.1/test?sslmode=disable&options=-csearch_path%3Dpublic', ssl: mode });
    try {
      assert.deepEqual(pool.options.ssl, expected);
      const url = new URL(pool.options.connectionString);
      assert.equal(url.searchParams.has('sslmode'), false);
      assert.equal(url.searchParams.get('options'), '-csearch_path=public');
    } finally { await pool.end(); }
  }
  assert.throws(() => createPostgresPool({ connectionString: 'not-a-url' }), /Invalid Postgres connection string/);
  assert.throws(() => createPostgresPool({ connectionString: 'postgresql://localhost/test', ssl: 'allow' }), /Invalid Postgres SSL mode/);
});

test('test database safety rejects destination overrides and application aliases', () => {
  const local = 'postgresql://local@127.0.0.1:5432/valcairn_test';
  assert.doesNotThrow(() => validateTestDatabase(local));
  for (const query of ['host=production.internal', 'port=5544', 'dbname=production', 'options=-csearch_path%3Dpublic']) {
    assert.throws(() => validateTestDatabase(`${local}?${query}`), /without query parameters/);
    assert.throws(() => validateTestDatabase(local, `${local}?${query}`), /without query parameters/);
  }
  assert.throws(() => validateTestDatabase(local, 'postgresql://other@localhost:5432/valcairn_test'), /must not target/);
  assert.throws(() => validateTestDatabase(local, 'postgresql://other@LOCALHOST:5432/valcairn_test'), /must not target/);
  assert.throws(() => validateTestDatabase(local, 'postgresql://other@%6cocalhost:5432/valcairn_test'), /must not target/);
  assert.throws(() => validateTestDatabase(local.replace('valcairn_test', 'valcairn%5Ftest'), local), /must not target/);
  assert.throws(() => validateTestDatabase(local, local.replace('valcairn_test', 'valcairn%5Ftest')), /must not target/);
  assert.throws(() => validateTestDatabase('postgresql://local@localhost/valcairn_test'), /explicit-host and port/);
  assert.throws(() => validateTestDatabase('postgresql:///valcairn_test'), /explicit-host/);
  assert.throws(() => validateTestDatabase('postgresql://local@localhost:5432/production'), /dedicated test/);
});

withStore('SQL-like input stays data and conflict errors do not expose rows', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const name = "x'); DROP TABLE users; --";
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name, task: 'test', startingPoint: 'own' });
  assert.equal((await store.getProject({ workspaceId: ws.id, projectId: p.id })).name, name);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 1);
  await assert.rejects(store.createUser({ email: 'OWNER@EXAMPLE.TEST', name: 'duplicate', passwordHash: 'must-not-leak' }), error => {
    assert.equal(error.code, 'email_taken');
    assert.equal(error.detail, undefined);
    assert.equal(error.message.includes('must-not-leak'), false);
    return true;
  });
});

withStore('session data persists across pools, expires and prunes', async (_store, pool) => {
  const first = createPgSessionStore({ ...options, pruneIntervalMs: 0 });
  const second = createPgSessionStore({ ...options, pruneIntervalMs: 0 });
  try {
    const data = { user: { id: 'test-user' }, cookie: { expires: new Date(Date.now() + 60_000) } };
    await call(first, 'set', 'persisted', data);
    await first.close();
    assert.equal((await call(second, 'get', 'persisted')).user.id, 'test-user');
    await call(second, 'set', 'expired', { cookie: { expires: new Date(Date.now() - 1_000) } });
    assert.equal(await call(second, 'get', 'expired'), null);
    assert.equal(await second.pruneExpired(), 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM sessions WHERE sid = $1', ['expired'])).rows[0].count, 0);
    await call(second, 'destroy', 'persisted');
    assert.equal(await call(second, 'get', 'persisted'), null);
  } finally { await second.close(); }
});

withStore('session compare-and-set rejects stale generations and destroyed sessions', async () => {
  const store = createPgSessionStore({ ...options, pruneIntervalMs: 0 });
  try {
    const data = { cookie: { maxAge: 60_000 }, __fastifySessionMetadata: { generation: 'first' } };
    await call(store, 'set', 'session', data);
    await call(store, 'compareAndSet', 'session', 'first', { ...data, __fastifySessionMetadata: { generation: 'second' } });
    await assert.rejects(call(store, 'compareAndSet', 'session', 'first', data), { code: 'ENOENT' });
    await call(store, 'destroy', 'session');
    await assert.rejects(call(store, 'compareAndSet', 'session', 'second', data), { code: 'ENOENT' });
  } finally { await store.close(); }
});

withStore('session store works with the installed Fastify plugin', async () => {
  const store = createPgSessionStore({ ...options, pruneIntervalMs: 0 });
  const app = Fastify();
  try {
    await app.register(cookie);
    await app.register(session, { secret: 'a-test-secret-with-at-least-32-characters', store, cookie: { secure: false, maxAge: 60_000 } });
    app.get('/count', async request => { request.session.set('count', (request.session.get('count') ?? 0) + 1); return { count: request.session.get('count') }; });
    app.post('/rotate', async request => { await request.session.regenerate(); return { ok: true }; });
    app.post('/logout', async request => { await request.session.destroy(); return { ok: true }; });
    const first = await app.inject('/count');
    assert.equal(first.statusCode, 200);
    const cookieHeader = first.headers['set-cookie'].split(';')[0];
    const second = await app.inject({ url: '/count', headers: { cookie: cookieHeader } });
    assert.deepEqual(second.json(), { count: 2 });
    const rotated = await app.inject({ method: 'POST', url: '/rotate', headers: { cookie: cookieHeader } });
    assert.equal(rotated.statusCode, 200);
    const rotatedCookie = rotated.headers['set-cookie'].split(';')[0];
    assert.equal((await app.inject({ method: 'POST', url: '/logout', headers: { cookie: rotatedCookie } })).statusCode, 200);
  } finally { await app.close(); await store.close(); }
});

withStore('reviewers sign in from Postgres; disabling or demoting applies to existing sessions; YC cannot read the admin log', async (store) => {
  const { hashPassword } = await import('../src/lib/passwords.js');
  const hash = (pw) => hashPassword(pw, { cost: 2 ** 12 });
  await store.upsertReviewer({ username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash: await hash('yc-password-12345') });
  await store.upsertReviewer({ username: 'sr008-reviewer', name: 'Speedrun reviewer', role: 'viewer', passwordHash: await hash('sr-password-12345') });
  await store.upsertReviewer({ username: 'admin', name: 'Admin', role: 'admin', passwordHash: await hash('admin-password-123') });
  const app = await makeApp({ store: { ...store, close: async () => {} } });
  const login = (username, password) => app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username, password }) });
  const cookieOf = (res) => ({ 'valcairn.sid': res.cookies.find((c) => c.name === 'valcairn.sid').value });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().signInConfigured, true);
    const yc = await login('YCInsider', 'yc-password-12345');
    const sr = await login('sr008-reviewer', 'sr-password-12345');
    const admin = await login('admin', 'admin-password-123');
    assert.deepEqual([yc.statusCode, sr.statusCode, admin.statusCode], [200, 200, 200]);
    assert.equal((await login('ycinsider', 'wrong-password-x')).statusCode, 401);
    // Customer accounts are separate: a reviewer name is not a customer login and vice versa.
    assert.equal((await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: 'ycinsider', password: 'yc-password-12345' }) })).statusCode, 401);

    const signins = (res) => app.inject({ method: 'GET', url: '/api/admin/signins', cookies: cookieOf(res) });
    assert.equal((await signins(yc)).statusCode, 403);
    assert.equal((await signins(sr)).statusCode, 403);
    assert.equal((await signins(admin)).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/demo/review', cookies: cookieOf(sr) })).statusCode, 200);
    // Reviewers have no workspace memberships, so no customer data.
    assert.equal((await app.inject({ method: 'GET', url: '/api/account', cookies: cookieOf(yc) })).json().user, null);

    // Demote admin: the existing session loses the log at once. Disable Speedrun: its session ends.
    await store.upsertReviewer({ username: 'admin', name: 'Admin', role: 'viewer' });
    assert.equal((await signins(admin)).statusCode, 403);
    await store.setReviewerEnabled({ username: 'sr008-reviewer', enabled: false });
    assert.equal((await app.inject({ method: 'GET', url: '/demo/review', cookies: cookieOf(sr) })).statusCode, 303);
    assert.equal((await app.inject({ method: 'GET', url: '/api/session', cookies: cookieOf(sr) })).json().reviewer, null);
    assert.equal((await login('sr008-reviewer', 'sr-password-12345')).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/demo/review', cookies: cookieOf(yc) })).statusCode, 200, 'YC unaffected');
  } finally { await app.close(); }
});

withStore('sessions, accounts and onboarding progress survive a server restart with Postgres sessions', async (store) => {
  const sessionStore = () => createPgSessionStore({ ...options, ttlMs: 60_000, pruneIntervalMs: 0 });
  const start = () => makeApp({ store: { ...store, close: async () => {} }, sessionStore: sessionStore() });
  let app = await start();
  const post = (url, body, cookies) => app.inject({ method: 'POST', url, headers: postHeaders, cookies, payload: json(body) });
  const signup = await post('/api/account/signup', { name: 'Ada', email: 'ada@acme-robotics.com', password: 'long-enough-password' });
  const cookies = { 'valcairn.sid': signup.cookies.find((c) => c.name === 'valcairn.sid').value };
  await post('/api/account/verify', { code: signup.json().devCode }, cookies);
  const ws = (await post('/api/workspaces', { name: 'Acme Robotics' }, cookies)).json().workspace;
  const project = (await post(`/api/workspaces/${ws.id}/projects`, { task: 'Flag damaged boxes on line 2.', modalities: ['Images'], startingPoint: 'own' }, cookies)).json().project;
  await post(`/api/workspaces/${ws.id}/projects/${project.id}`, { success: { measure: 'recall', target: '95%' } }, cookies);
  await app.close();

  app = await start();
  try {
    const account = (await app.inject({ method: 'GET', url: '/api/account', cookies })).json();
    assert.equal(account.user.email, 'ada@acme-robotics.com', 'still signed in after restart');
    const saved = (await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/projects/${project.id}`, cookies })).json().project;
    assert.equal(saved.success.target, '95%');
    assert.equal(saved.setupStep, 'data');
    // Sign-out removes the stored session, so the old cookie stops working.
    await app.inject({ method: 'POST', url: '/api/account/signout', headers: postHeaders, cookies, payload: '{}' });
    assert.equal((await app.inject({ method: 'GET', url: '/api/account', cookies })).json().user, null);
  } finally { await app.close(); }
});

// ---------- Dataset workspace races: the freeze and the Resolve gate hold across concurrent transactions ----------

// Tracks whether a promise has settled, so a test can prove a statement is waiting on a lock.
const watch = (promise) => {
  const w = { done: false };
  w.result = promise.then((value) => { w.done = true; return { ok: true, value }; }, (error) => { w.done = true; return { ok: false, error }; });
  return w;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function labelledProject(store) {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Line 2', task: 'Spot jams', modalities: ['Video'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: p.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%', baseline: 'current' }, dataSource: { mode: 'upload', provenance: 'ours' } } });
  await store.setLabelSet({ ...where, labelSet: [{ id: 'l_jam', name: 'belt jam', scope: 'span', tone: 'green' }, { id: 'l_ok', name: 'ok', scope: 'file', tone: 'plain' }] });
  const video = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'v1', sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'video/mp4', filename: 'dock.mp4' });
  const label = await store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_jam', startMs: 0, endMs: 1000, createdBy: owner.id });
  return { owner, ws, p, where, video, label };
}

// Holds the project row the way submit does, runs `during` inside that transaction, then commits.
async function holdingProject(pool, projectId, during) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    return await during(client);
  } finally {
    await client.query('COMMIT').catch(() => {});
    client.release();
  }
}

withStore('freeze triggers wait for an in-flight freeze, then refuse labels, notes and file metadata', async (store, pool) => {
  const { owner, ws, p, video } = await labelledProject(store);
  const writes = [
    ['annotation', 'INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, created_by) VALUES ($1, $2, $3, \'l_ok\', $4)', [ws.id, p.id, video.id, owner.id]],
    ['issue note', 'INSERT INTO issue_notes (workspace_id, project_id, issue_key, note, created_by) VALUES ($1, $2, \'k\', \'n\', $3)', [ws.id, p.id, owner.id]],
    ['file type', "UPDATE uploads SET kind = 'audio' WHERE id = $1", [video.id]],
  ];
  for (const [name, sql, values] of writes) {
    await pool.query("UPDATE projects SET status = 'draft' WHERE id = $1", [p.id]);
    const freezer = await pool.connect();
    const writer = await pool.connect();
    try {
      await freezer.query('BEGIN');
      await freezer.query("UPDATE projects SET status = 'in_review' WHERE id = $1", [p.id]);
      await writer.query('BEGIN');
      const write = watch(writer.query(sql, values));
      await pause(150);
      assert.equal(write.done, false, `${name}: waits for the freeze instead of reading the old draft status`);
      await freezer.query('COMMIT');
      const outcome = await write.result;
      assert.equal(outcome.ok, false, `${name}: refused once the freeze committed`);
      assert.match(outcome.error.message, /project_frozen/);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      freezer.release();
    }
  }
});

withStore('a freeze waits for a label write already in flight, so the write lands before it', async (store, pool) => {
  const { owner, ws, p, video } = await labelledProject(store);
  const writer = await pool.connect();
  const freezer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query("INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, created_by) VALUES ($1, $2, $3, 'l_ok', $4)", [ws.id, p.id, video.id, owner.id]);
    const freeze = watch(freezer.query("UPDATE projects SET status = 'in_review' WHERE id = $1", [p.id]));
    await pause(150);
    assert.equal(freeze.done, false, 'the freeze waits for the in-flight write');
    await writer.query('COMMIT');
    assert.equal((await freeze.result).ok, true);
  } finally { writer.release(); freezer.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM annotations WHERE project_id = $1', [p.id])).rows[0].n, 2);
});

withStore('the Resolve gate is checked inside the submit lock: a late unlabelled file, removed note or removed label blocks it', async (store, pool) => {
  const races = [
    ['unlabelled upload', async ({ owner, ws, p }, client) => {
      await client.query(`INSERT INTO uploads (workspace_id, project_id, uploaded_by, object_key, sha256, size_bytes, content_type, filename)
        VALUES ($1, $2, $3, 'late', $4, 5, 'image/png', 'late.png')`, [ws.id, p.id, owner.id, 'b'.repeat(64)]);
    }],
    ['removed label', async ({ label }, client) => { await client.query('DELETE FROM annotations WHERE id = $1', [label.id]); }],
    ['removed note', async ({ p }, client) => { await client.query('DELETE FROM issue_notes WHERE project_id = $1', [p.id]); }],
  ];
  for (const [name, change] of races) {
    await pool.query('TRUNCATE TABLE audit_events, dataset_versions, reviews, uploads, projects, memberships, workspaces, users RESTART IDENTITY CASCADE');
    const ctx = await labelledProject(store);
    if (name === 'removed note') {
      // A duplicate is open until noted; the note is what lets this project through.
      await store.createUpload({ ...ctx.where, uploadedBy: ctx.owner.id, objectKey: 'copy', sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'video/mp4', filename: 'copy.mp4' });
      const copy = (await store.listUploads(ctx.where)).find((u) => u.duplicateOf);
      await store.setIssueNote({ ...ctx.where, key: `duplicate:${copy.id}`, note: 'kept on purpose', createdBy: ctx.owner.id });
    }
    const submit = await holdingProject(pool, ctx.p.id, async (client) => {
      const pending = watch(store.submitForReview({ ...ctx.where, submittedBy: ctx.owner.id, requireResolved: true }));
      await pause(100);
      assert.equal(pending.done, false, `${name}: submit waits for the project lock`);
      await change(ctx, client);
      return pending;
    });
    const outcome = await submit.result;
    assert.equal(outcome.ok, false, `${name}: submit must see the change made before it got the lock`);
    assert.equal(outcome.error.code, 'issues_open', name);
    assert.equal((await store.getProject(ctx.where)).status, 'draft');
  }
});

withStore('label set edits and labelling serialize: no orphan label ids', async (store, pool) => {
  const { owner, where, p, video } = await labelledProject(store);
  // Labelling waits on the lock, and meanwhile the label is removed from the set.
  const add = await holdingProject(pool, p.id, async (client) => {
    const pending = watch(store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_ok', createdBy: owner.id }));
    await pause(100);
    await client.query(`UPDATE projects SET label_set = '[{"id":"l_jam","name":"belt jam","scope":"span","tone":"green"}]'::jsonb WHERE id = $1`, [p.id]);
    return pending;
  });
  assert.equal((await add.result).error?.code, 'invalid_label');
  // Removing a label waits on the lock, and meanwhile it gets used.
  await store.setLabelSet({ ...where, labelSet: [{ id: 'l_jam', name: 'belt jam', scope: 'span', tone: 'green' }, { id: 'l_ok', name: 'ok', scope: 'file', tone: 'plain' }] });
  const remove = await holdingProject(pool, p.id, async (client) => {
    const pending = watch(store.setLabelSet({ ...where, labelSet: [{ id: 'l_jam', name: 'belt jam', scope: 'span', tone: 'green' }] }));
    await pause(100);
    await client.query("INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, created_by) VALUES ($1, $2, $3, 'l_ok', $4)", [where.workspaceId, p.id, video.id, owner.id]);
    return pending;
  });
  assert.equal((await remove.result).error?.code, 'label_in_use');
  const set = new Set((await store.getProject(where)).labelSet.map((l) => l.id));
  for (const a of await store.listAnnotations(where)) assert.ok(set.has(a.labelId), `annotation ${a.id} points at a label in the set`);
});

withStore('direct SQL cannot change any column of an upload once its project is frozen', async (store, pool) => {
  const { owner, ws, p, video } = await labelledProject(store);
  const other = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Other', task: 't', modalities: [], startingPoint: 'own' });
  const loose = await store.createUpload({ workspaceId: ws.id, projectId: p.id, uploadedBy: owner.id, objectKey: 'loose', sha256: 'e'.repeat(64), sizeBytes: 3, contentType: 'image/png', filename: 'loose.png' });
  const changes = [
    ['filename', "filename = 'changed.png'"], ['content_type', "content_type = 'text/plain'"], ['size_bytes', 'size_bytes = 7'],
    ['sha256', `sha256 = '${'f'.repeat(64)}'`], ['object_key', "object_key = 'moved/elsewhere'"], ['kind', "kind = 'audio'"],
    ['offset_ms', 'offset_ms = 5'], ['uploaded_by', 'uploaded_by = uploaded_by'], ['duplicate_of', 'duplicate_of = NULL'],
    ['created_at', 'created_at = now()'],
  ];
  for (const status of ['in_review', 'approved', 'versioned']) {
    await pool.query('UPDATE projects SET status = $2 WHERE id = $1', [p.id, status]);
    for (const [column, set] of changes) {
      await assert.rejects(pool.query(`UPDATE uploads SET ${set} WHERE id = $1`, [video.id]), /project_frozen/, `${status}: ${column}`);
    }
    // Moving a file out of a frozen project is refused for the old parent; moving one in, for the new parent.
    await assert.rejects(pool.query('UPDATE uploads SET project_id = $2 WHERE id = $1', [loose.id, other.id]), /project_frozen/, `${status}: move out`);
  }
  await pool.query("UPDATE projects SET status = 'draft' WHERE id = $1", [p.id]);
  await pool.query("UPDATE projects SET status = 'in_review' WHERE id = $1", [other.id]);
  await assert.rejects(pool.query('UPDATE uploads SET project_id = $2 WHERE id = $1', [loose.id, other.id]), /project_frozen/, 'move into a frozen project');
  const row = (await pool.query('SELECT filename, content_type, size_bytes, sha256, object_key, kind FROM uploads WHERE id = $1', [video.id])).rows[0];
  assert.deepEqual({ ...row, size_bytes: Number(row.size_bytes) }, { filename: 'dock.mp4', content_type: 'video/mp4', size_bytes: 10, sha256: 'a'.repeat(64), object_key: 'v1', kind: null });

  // Editable projects keep every normal write: metadata changes, duplicate promotion on delete, plain SQL edits.
  await pool.query("UPDATE projects SET status = 'draft' WHERE id = $1", [other.id]);
  const where = { workspaceId: ws.id, projectId: p.id };
  assert.equal((await store.updateUpload({ ...where, uploadId: video.id, patch: { offsetMs: 250 } })).offsetMs, 250);
  const copy = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'loose-copy', sha256: 'e'.repeat(64), sizeBytes: 3, contentType: 'image/png', filename: 'loose copy.png' });
  assert.equal(copy.duplicateOf, loose.id);
  await store.deleteUpload({ ...where, uploadId: loose.id, actorId: owner.id });
  assert.equal((await store.listUploads(where)).find((u) => u.id === copy.id).duplicateOf, null, 'the copy is promoted');
  assert.equal((await pool.query("UPDATE uploads SET filename = 'renamed.mp4' WHERE id = $1", [video.id])).rowCount, 1);
});

withStore('an upload metadata write waits for an in-flight freeze, then is refused', async (store, pool) => {
  const { p, video } = await labelledProject(store);
  const freezer = await pool.connect();
  const writer = await pool.connect();
  try {
    await freezer.query('BEGIN');
    await freezer.query("UPDATE projects SET status = 'in_review' WHERE id = $1", [p.id]);
    await writer.query('BEGIN');
    const write = watch(writer.query("UPDATE uploads SET filename = 'late.mp4', sha256 = $2 WHERE id = $1", [video.id, 'f'.repeat(64)]));
    await pause(150);
    assert.equal(write.done, false, 'waits for the freeze');
    await freezer.query('COMMIT');
    const outcome = await write.result;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /project_frozen/);
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    writer.release();
    freezer.release();
  }
  assert.equal((await pool.query('SELECT filename FROM uploads WHERE id = $1', [video.id])).rows[0].filename, 'dock.mp4');
});

withStore('labels stored before today\'s rules block review until repaired; approved history is only flagged', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Legacy', task: 'Spot tears', modalities: ['Images'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: p.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload', provenance: 'ours' } } });
  await store.setLabelSet({ ...where, labelSet: [{ id: 'box', name: 'tear', scope: 'box', tone: 'orange' }, { id: 'ok', name: 'ok', scope: 'file', tone: 'plain' }] });
  const text = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'legacy-t', sha256: 'a'.repeat(64), sizeBytes: 5, contentType: 'text/plain', filename: 'notes.txt' });
  const png = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'legacy-p', sha256: 'b'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'carton.png' });
  // What the code before 261598d could write: text bytes typed as Image with a box, and a sub-minimum box from before 010.
  await pool.query("UPDATE uploads SET kind = 'image' WHERE id = $1", [text.id]);
  const onText = (await pool.query(`INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by)
    VALUES ($1, $2, $3, 'box', '{"x":0.1,"y":0.1,"w":0.2,"h":0.2}', $4) RETURNING id`, [ws.id, p.id, text.id, owner.id])).rows[0].id;
  const tiny = await withoutBoxConstraint(pool, async () => (await pool.query(`INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by)
    VALUES ($1, $2, $3, 'box', '{"x":0.1,"y":0.1,"w":0.0000001,"h":0.2}', $4) RETURNING id`, [ws.id, p.id, png.id, owner.id])).rows[0].id);
  await store.createAnnotation({ ...where, uploadId: png.id, labelId: 'ok', createdBy: owner.id });

  await assert.rejects(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open >= 3);
  // Repair inside the draft, through the normal store paths: drop the bad labels, then the hand-set type.
  await assert.rejects(store.updateUpload({ ...where, uploadId: text.id, patch: { kind: null } }), { code: 'label_in_use' }, 'the box must go first');
  await store.deleteAnnotation({ ...where, annotationId: onText });
  await store.deleteAnnotation({ ...where, annotationId: tiny });
  await store.updateUpload({ ...where, uploadId: text.id, patch: { kind: null } });
  await store.createAnnotation({ ...where, uploadId: text.id, labelId: 'ok', createdBy: owner.id });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true });
  assert.equal(review.snapshot.annotations.length, 2);
  assert.ok(review.snapshot.annotations.every((a) => a.box == null), 'only the repaired, valid labels were snapshotted');
});

withStore('migration 010: the database refuses boxes outside the stored form, for new and changed rows', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Boxes', task: 't', modalities: [], startingPoint: 'own' });
  const png = await store.createUpload({ workspaceId: ws.id, projectId: p.id, uploadedBy: owner.id, objectKey: 'box-p', sha256: 'c'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'p.png' });
  const insert = (box) => pool.query('INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id', [ws.id, p.id, png.id, 'box', box, owner.id]);
  for (const bad of ['{}', '{"x":0.1,"y":0.1,"w":0.2}', '{"y":0.1,"w":0.2,"h":0.2}', '{"x":0.1,"y":0.1,"w":0.0000001,"h":0.2}', '{"x":0.1,"y":0.1,"w":0.0009,"h":0.2}',
    '{"x":"0.1","y":0.1,"w":0.2,"h":0.2}', '{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"z":1}', '{"x":0.1234567,"y":0.1,"w":0.2,"h":0.2}', '{"x":0.9,"y":0,"w":0.2,"h":0.2}',
    '{"x":-0.000001,"y":0,"w":0.2,"h":0.2}', '{"x":1,"y":0,"w":0.001,"h":0.5}', '[0.1,0.1,0.2,0.2]', '"box"']) {
    await assert.rejects(insert(bad), (err) => err.code === '23514', bad);
  }
  for (const good of ['{"x":0,"y":0,"w":1,"h":1}', '{"x":0.1,"y":0.2,"w":0.001,"h":0.001}', '{"x":0.333334,"y":0,"w":0.666667,"h":1}', '{"x":0.999,"y":0,"w":0.001,"h":0.5}']) {
    assert.equal((await insert(good)).rowCount, 1, good);
  }
  const { id } = (await insert('{"x":0.1,"y":0.1,"w":0.2,"h":0.2}')).rows[0];
  await assert.rejects(pool.query(`UPDATE annotations SET box = '{"x":0.1,"y":0.1,"w":0,"h":0.2}' WHERE id = $1`, [id]), (err) => err.code === '23514', 'updates are checked too');
  const constraint = (await pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'annotations_box_stored_form'")).rows[0];
  assert.equal(constraint.convalidated, false, 'NOT VALID: existing rows were not rewritten or rejected at upgrade');
});

// The 010 constraint's predicate, as text, so tests can drop and re-add it to simulate rows stored before 010.
const BOX_010 = (await import('node:fs')).readFileSync(new URL('../migrations/010_annotation_box_stored_form.sql', import.meta.url), 'utf8')
  .match(/ADD CONSTRAINT annotations_box_stored_form ([\s\S]*?);\s*$/)[1];
const VIOLATIONS_SQL = (await import('node:fs')).readFileSync(new URL('../scripts/sql/annotation-box-violations.sql', import.meta.url), 'utf8');
async function withoutBoxConstraint(pool, fn) {
  await pool.query('ALTER TABLE annotations DROP CONSTRAINT annotations_box_stored_form');
  try { return await fn(); } finally { await pool.query(`ALTER TABLE annotations ADD CONSTRAINT annotations_box_stored_form ${BOX_010}`); }
}

withStore('an extra-key box stored before 010 blocks a new review after the upgrade; frozen history is flagged, unchanged', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Extra key', task: 'Spot tears', modalities: ['Images'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: p.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload', provenance: 'ours' } } });
  await store.setLabelSet({ ...where, labelSet: [{ id: 'box', name: 'tear', scope: 'box', tone: 'orange' }] });
  const png = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'xk-p', sha256: 'd'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'p.png' });
  const legacy = await withoutBoxConstraint(pool, async () => (await pool.query(`INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by)
    VALUES ($1, $2, $3, 'box', '{"x":0,"y":0,"w":0.5,"h":0.5,"extra":true}', $4) RETURNING id`, [ws.id, p.id, png.id, owner.id])).rows[0].id);
  // Two issues: the box itself, and the PNG, which an invalid box no longer counts as labelling.
  await assert.rejects(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open === 2);
  assert.equal((await pool.query('SELECT box FROM annotations WHERE id = $1', [legacy])).rows[0].box.extra, true, 'the legacy row itself is untouched');

  // Approved history holding such a box (made before this check) is flagged on read and never rewritten.
  await store.deleteAnnotation({ ...where, annotationId: legacy });
  await store.createAnnotation({ ...where, uploadId: png.id, labelId: 'box', box: { x: 0, y: 0, w: 0.5, h: 0.5 }, createdBy: owner.id });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });
  await pool.query(`UPDATE dataset_versions SET manifest = jsonb_set(manifest, '{annotations,0,box}', '{"x":0,"y":0,"w":0.5,"h":0.5,"extra":true}') WHERE id = $1`, [version.id]);
  const before = (await pool.query('SELECT manifest::text FROM dataset_versions WHERE id = $1', [version.id])).rows[0].manifest;
  const [stored] = await store.listDatasetVersions(where);
  const { countInvalid } = await import('../src/lib/dataset.js');
  assert.deepEqual(countInvalid(stored.manifest), { labels: 1, kinds: 0 });
  assert.equal((await pool.query('SELECT manifest::text FROM dataset_versions WHERE id = $1', [version.id])).rows[0].manifest, before);
});

withStore('the operator query lists exactly the rows that make VALIDATE CONSTRAINT fail', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Query', task: 't', modalities: [], startingPoint: 'own' });
  const png = await store.createUpload({ workspaceId: ws.id, projectId: p.id, uploadedBy: owner.id, objectKey: 'q-p', sha256: 'e'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'p.png' });
  const rows = {
    ok: '{"x":0,"y":0,"w":1,"h":1}', okMin: '{"x":0.1,"y":0.2,"w":0.001,"h":0.001}', okEdge: '{"x":0.333334,"y":0,"w":0.666667,"h":1}',
    extraKey: '{"x":0,"y":0,"w":0.5,"h":0.5,"extra":true}', sevenDecimals: '{"x":0.1234567,"y":0,"w":0.5,"h":0.5}',
    numericString: '{"x":"0.1","y":0,"w":0.5,"h":0.5}', missingKey: '{"x":0.1,"y":0.1,"w":0.2}', tiny: '{"x":0.1,"y":0.1,"w":0.0000001,"h":0.2}',
    belowMin: '{"x":0.1,"y":0.1,"w":0.0009,"h":0.2}', empty: '{}',
  };
  // Only rows 008's older check allowed can predate 010: overrunning boxes were already refused, so they are not legacy.
  const ids = {};
  await withoutBoxConstraint(pool, async () => {
    // 008's own check casts with ::numeric, so a non-numeric string like "abc" could never have been stored; numeric strings could.
    for (const [name, box] of Object.entries(rows)) {
      ids[name] = (await pool.query('INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id', [ws.id, p.id, png.id, 'box', box, owner.id])).rows[0].id;
    }
  });
  const flagged = new Set((await pool.query(VIOLATIONS_SQL)).rows.map((r) => r.id));
  const invalid = Object.keys(rows).filter((n) => !n.startsWith('ok'));
  assert.deepEqual([...flagged].sort(), invalid.map((n) => ids[n]).sort(), 'every invalid row and no valid one');
  await assert.rejects(pool.query('ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form'), (err) => err.code === '23514');
  // Remove one flagged row at a time: VALIDATE keeps failing until the query is empty, then succeeds.
  for (const name of invalid) {
    await pool.query('DELETE FROM annotations WHERE id = $1', [ids[name]]);
    const left = (await pool.query(VIOLATIONS_SQL)).rowCount;
    const validated = await pool.query('ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form').then(() => true, () => false);
    assert.equal(validated, left === 0, `after removing ${name}: ${left} left, validate ${validated}`);
  }
  // Leave the constraint NOT VALID for later tests, as a real upgrade would.
  await pool.query('ALTER TABLE annotations DROP CONSTRAINT annotations_box_stored_form');
  await pool.query(`ALTER TABLE annotations ADD CONSTRAINT annotations_box_stored_form ${BOX_010}`);
});

test('the stored-form check the app runs in Postgres is migration 010 word for word', async () => {
  const { boxStoredForm } = await import('../src/lib/box-sql.js');
  const squash = (sql) => sql.replace(/\s+/g, ' ').trim();
  const fromMigration = BOX_010.match(/box IS NULL OR (CASE[\s\S]*END)\s*\)\s*NOT VALID/)[1];
  assert.equal(squash(boxStoredForm('box')), squash(fromMigration));
});

withStore('a raw box with digits a double cannot hold is caught before JavaScript rounds it, and frozen history is flagged', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Precision', task: 'Spot tears', modalities: ['Images'], startingPoint: 'own' });
  const where = { workspaceId: ws.id, projectId: p.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload', provenance: 'ours' } } });
  await store.setLabelSet({ ...where, labelSet: [{ id: 'box', name: 'tear', scope: 'box', tone: 'orange' }] });
  const png = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'hp-p', sha256: 'f'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'p.png' });
  const RAW = '{"x":0.100000000000000001,"y":0,"w":0.5,"h":0.5}';
  // 010 refuses this today, so it can only be a row stored before the upgrade.
  await assert.rejects(pool.query('INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [ws.id, p.id, png.id, 'box', RAW, owner.id]), (err) => err.code === '23514');
  const legacy = await withoutBoxConstraint(pool, async () => (await pool.query('INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, box, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id', [ws.id, p.id, png.id, 'box', RAW, owner.id])).rows[0].id);
  assert.equal((await pool.query(VIOLATIONS_SQL)).rows.map((r) => r.id).includes(legacy), true, 'the operator query lists it');

  const listed = (await store.listAnnotations(where)).find((a) => a.id === legacy);
  assert.equal(listed.box.x, 0.1, 'node-postgres reads it as 0.1, which looks canonical');
  assert.equal(listed.storedFormInvalid, true, 'Postgres says what 010 says about the raw value');
  // Two issues: the box, and the PNG, which an invalid box does not count as labelling.
  await assert.rejects(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open === 2);
  assert.equal((await pool.query('SELECT box::text FROM annotations WHERE id = $1', [legacy])).rows[0].box, '{"h": 0.5, "w": 0.5, "x": 0.100000000000000001, "y": 0}', 'the raw row is untouched');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM reviews WHERE project_id = $1', [p.id])).rows[0].n, 0, 'no snapshot was taken');

  // Repaired through the normal path, review goes through; then history made before this check carries the raw value.
  await store.deleteAnnotation({ ...where, annotationId: legacy });
  const fresh = await store.createAnnotation({ ...where, uploadId: png.id, labelId: 'box', box: { x: 0.1, y: 0, w: 0.5, h: 0.5 }, createdBy: owner.id });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true });
  assert.deepEqual((await store.getReview(review.id)).rawInvalidBoxIds, []);
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });
  assert.deepEqual((await store.listDatasetVersions(where))[0].rawInvalidBoxIds, []);
  await pool.query(`UPDATE reviews SET snapshot = jsonb_set(snapshot, '{annotations,0,box}', $2::jsonb) WHERE id = $1`, [review.id, RAW]);
  await pool.query(`UPDATE dataset_versions SET manifest = jsonb_set(manifest, '{annotations,0,box}', $2::jsonb) WHERE id = $1`, [version.id, RAW]);
  const text = async () => (await pool.query('SELECT r.snapshot::text AS s, v.manifest::text AS m FROM reviews r, dataset_versions v WHERE r.id = $1 AND v.id = $2', [review.id, version.id])).rows[0];
  const before = await text();
  const { countInvalid } = await import('../src/lib/dataset.js');
  const [stored] = await store.listDatasetVersions(where);
  assert.deepEqual(stored.rawInvalidBoxIds, [fresh.id]);
  assert.deepEqual(countInvalid(stored.manifest, stored.rawInvalidBoxIds), { labels: 1, kinds: 0 });
  assert.deepEqual(countInvalid(stored.manifest), { labels: 0, kinds: 0 }, 'without the database verdict the rounded value looks fine');
  const reread = await store.getReview(review.id);
  assert.deepEqual(countInvalid(reread.snapshot, reread.rawInvalidBoxIds), { labels: 1, kinds: 0 });
  assert.deepEqual(await text(), before, 'warnings never rewrite the snapshot or manifest');
});

withStore('an invalid rule written while submit waits on the lock is seen by the gate', async (store, pool) => {
  const { owner, p, where } = await labelledProject(store);
  let submit;
  await holdingProject(pool, p.id, async (client) => {
    await client.query(`UPDATE projects SET success = '{"measure":"recall","target":"   "}' WHERE id = $1`, [p.id]);
    submit = watch(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }));
    await pause(150);
    assert.equal(submit.done, false, 'submit waits for the rule write');
  });
  const result = await submit.result;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'issues_open');
  assert.equal((await store.getProject(where)).status, 'draft');
});

withStore('a requested enhance run cannot be changed or deleted, even by direct SQL', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const run = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'r', baseModelId: 'example-base', datasets: [{ projectId: ws.id, version: 1 }], steps: ['sft'], compute: 'nebius', spendCapUsd: 100 } });
  await pool.query('UPDATE enhance_runs SET spend_cap_usd = 120 WHERE id = $1', [run.id]);
  const current = await store.getEnhanceRun({ workspaceId: ws.id, runId: run.id });
  await store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id, expectedUpdatedAt: current.updatedAt });
  for (const sql of ['UPDATE enhance_runs SET spend_cap_usd = 99999 WHERE id = $1', "UPDATE enhance_runs SET status = 'draft', requested_at = NULL, requested_by = NULL WHERE id = $1", 'DELETE FROM enhance_runs WHERE id = $1']) {
    await assert.rejects(pool.query(sql, [run.id]), (err) => /run_frozen/.test(err.message), sql);
  }
  assert.equal((await store.getEnhanceRun({ workspaceId: ws.id, runId: run.id })).spendCapUsd, 120);
  await assert.rejects(pool.query("INSERT INTO enhance_runs (workspace_id, name, base_model_id, status, created_by) VALUES ($1, 'x', 'example-base', 'requested', $2)", [ws.id, owner.id]), (err) => err.code === '23514', 'a requested row needs a complete plan');
  await assert.rejects(pool.query("INSERT INTO model_pulls (workspace_id, model_id, requested_by) VALUES ($1, 'Bad Id', $2)", [ws.id, owner.id]), (err) => err.code === '23514');
});

withStore('jobs: inputs and finished jobs cannot change and events cannot be edited, even by direct SQL', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'e'.repeat(64), keyPrefix: 'vrk_eeeeee' });
  const job = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: 'sql-key-0001', createdBy: owner.id });
  await assert.rejects(pool.query(`UPDATE jobs SET spec = '{"checks":["shell"]}'::jsonb WHERE id = $1`, [job.id]), (err) => /job_frozen/.test(err.message));
  await store.leaseJob({ runnerId: runner.id, leaseHash: 'f'.repeat(64) });
  const who = { runnerId: runner.id, jobId: job.id, leaseHash: 'f'.repeat(64) };
  await store.appendJobEvents({ ...who, events: [{ seq: 0, kind: 'log', data: { level: 'info', message: 'a' } }] });
  await assert.rejects(pool.query(`UPDATE job_events SET data = '{}'::jsonb WHERE job_id = $1`, [job.id]), (err) => /job_event_frozen/.test(err.message));
  await assert.rejects(pool.query('DELETE FROM job_events WHERE job_id = $1', [job.id]), (err) => /job_event_frozen/.test(err.message));
  await store.finishJob({ ...who, outcome: 'succeeded', result: { gpu: true } });
  await assert.rejects(pool.query("UPDATE jobs SET status = 'queued', finished_at = NULL WHERE id = $1", [job.id]), (err) => /job_frozen/.test(err.message));
  await assert.rejects(pool.query("INSERT INTO jobs (workspace_id, runner_id, kind, spec, idempotency_key, created_by) VALUES ($1, $2, 'train', '{}'::jsonb, 'sql-key-0002', $3)", [ws.id, runner.id, owner.id]), (err) => err.code === '23514', 'training needs a plan');
  await assert.rejects(pool.query("INSERT INTO jobs (workspace_id, runner_id, kind, spec, idempotency_key, created_by, status) VALUES ($1, $2, 'probe', '{}'::jsonb, 'sql-key-0003', $3, 'running')", [ws.id, runner.id, owner.id]), (err) => err.code === '23514', 'a running job needs a lease');
  // Deleting the workspace removes its runners, jobs and events together.
  await pool.query('DELETE FROM workspaces WHERE id = $1', [ws.id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM job_events WHERE job_id = $1', [job.id])).rows[0].n, 0);
});

// Review 1 (comment 6637458993): a lease that runs out while its call waits for the row lock must be refused.
// Two real connections: one holds the job row; the store's call waits behind it past the lease expiry.
withStore('jobs: a lease that expires while waiting for the row lock is refused, not renewed', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'e'.repeat(64), keyPrefix: 'vrk_eeeeee' });
  const job = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: 'lock-key-0001', createdBy: owner.id });
  const calls = [(w) => store.touchJob(w), (w) => store.appendJobEvents({ ...w, events: [{ seq: 0, kind: 'log', data: { level: 'info', message: 'late' } }] }), (w) => store.finishJob({ ...w, outcome: 'succeeded', result: { network: 'none' } })];
  for (const [i, call] of calls.entries()) {
    // A fresh 500 ms lease for each call (attempts 1 to 3); leasing reclaims the previous, expired one.
    const leaseHash = String(i + 1).repeat(64);
    assert.equal((await store.leaseJob({ runnerId: runner.id, leaseHash, leaseMs: 500 }))?.id, job.id);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]);
      const waiting = call({ runnerId: runner.id, jobId: job.id, leaseHash }).then(() => 'accepted', (err) => err.code);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await blocker.query('COMMIT');
      assert.equal(await waiting, 'lease_lost', `call ${i + 1} waited past its lease`);
    } finally { blocker.release(); }
  }
  const after = await store.getJob({ workspaceId: ws.id, jobId: job.id });
  assert.notEqual(after.status, 'succeeded', 'an expired holder could not finish the job');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM job_events WHERE job_id = $1', [job.id])).rows[0].n, 0, 'nor add events');
});

// Exact-head review of 2afe7bd: the input release is decided under the job row lock, so it is ordered against a cancel
// and a revoke, and it never takes the runner row (revoke locks the runner, then its jobs), so it cannot deadlock.
withStore('jobs: an input release waiting for the job row is refused once a cancel or the lease expiry commits, and does not deadlock with a revoke', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'e'.repeat(64), keyPrefix: 'vrk_eeeeee' });
  const mk = (key) => store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: key, createdBy: owner.id });
  const released = async (jobId) => (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'job.inputs_released' AND target_id = $1", [jobId])).rows[0].n;
  const release = (jobId, h) => store.releaseJobInputs({ runnerId: runner.id, jobId, leaseHash: h.repeat(64), versions: 1 }).then(() => 'released', (err) => err.code);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A cancel holds the job row (the same statement cancelJob runs) while the release starts and waits behind it.
  const first = await mk('release-key-01');
  await store.leaseJob({ runnerId: runner.id, leaseHash: '1'.repeat(64) });
  assert.equal(await release(first.id, '1'), 'released', 'allowed while held and not cancelled');
  const canceller = await pool.connect();
  try {
    await canceller.query('BEGIN');
    await canceller.query("UPDATE jobs SET status = 'cancel_requested', cancelled_by = $2, updated_at = clock_timestamp() WHERE id = $1", [first.id, owner.id]);
    const waiting = release(first.id, '1');
    await sleep(300);
    await canceller.query('COMMIT');
    assert.equal(await waiting, 'invalid_state', 'the cancel committed first');
  } finally { canceller.release(); }
  assert.equal(await released(first.id), 1, 'the refused release is not on record');
  await store.finishJob({ runnerId: runner.id, jobId: first.id, leaseHash: '1'.repeat(64), outcome: 'failed', failure: 'cancelled' });

  // The lease runs out while the release waits for the row: refused, and the job goes back to the queue.
  const second = await mk('release-key-02');
  await store.leaseJob({ runnerId: runner.id, leaseHash: '2'.repeat(64), leaseMs: 500 });
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [second.id]);
    const waiting = release(second.id, '2');
    await sleep(900);
    await blocker.query('COMMIT');
    assert.equal(await waiting, 'lease_lost', 'the lease ran out while the release waited');
  } finally { blocker.release(); }
  assert.equal((await store.getJob({ workspaceId: ws.id, jobId: second.id })).status, 'queued');
  assert.equal(await released(second.id), 0);

  // A revoke in progress holds the runner row (its first statement) and has not reached the job rows yet. The release
  // must not wait for the runner row: locking it after the job row would deadlock once the revoke reaches the jobs.
  // A release committed before the revoke's job update is a grant made before the revoke; the next one is refused.
  assert.equal((await store.leaseJob({ runnerId: runner.id, leaseHash: '3'.repeat(64) }))?.id, second.id);
  const revoker = await pool.connect();
  try {
    await revoker.query('BEGIN');
    await revoker.query("UPDATE runners SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = $1", [runner.id]);
    const outcome = await Promise.race([release(second.id, '3'), new Promise((resolve) => setTimeout(resolve, 2000, 'blocked').unref())]);
    assert.equal(outcome, 'released', 'decided on the job row alone, without waiting for the runner row');
    await revoker.query(`UPDATE jobs SET status = 'failed', failure = 'runner_revoked', lease_hash = NULL, lease_expires_at = NULL,
      finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE runner_id = $1 AND status IN ('leased', 'running', 'cancel_requested')`, [runner.id]);
    await revoker.query('COMMIT');
  } finally { revoker.release(); }
  assert.equal(await release(second.id, '3'), 'lease_lost', 'after the revoke');
  const after = await store.getJob({ workspaceId: ws.id, jobId: second.id });
  assert.deepEqual([after.status, after.failure, await released(second.id)], ['failed', 'runner_revoked', 1]);
});

withStore('jobs: a job is deleted only with its workspace, never one by one', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'e'.repeat(64), keyPrefix: 'vrk_eeeeee' });
  const job = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: {}, idempotencyKey: 'del-key-0001', createdBy: owner.id });
  await assert.rejects(pool.query('DELETE FROM jobs WHERE id = $1', [job.id]), (err) => /job_frozen/.test(err.message));
  await store.cancelJob({ workspaceId: ws.id, jobId: job.id, actorId: owner.id });
  await assert.rejects(pool.query('DELETE FROM jobs WHERE id = $1', [job.id]), (err) => /job_frozen/.test(err.message), 'finished jobs too');
  await pool.query('DELETE FROM workspaces WHERE id = $1', [ws.id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jobs WHERE id = $1', [job.id])).rows[0].n, 0);
});

const capitalDraft = (extra = {}) => ({ purpose: 'Pilot', requestedAmountCents: 5000000, timing: { neededBy: null, termMonths: null }, company: { legalName: 'QA ONLY Co', registrationRef: '', country: '', foundedYear: null, employees: null, website: '', description: '' }, costItems: [{ id: 'ci_1', category: 'compute', label: 'GPU hours', amountCents: 250000, period: 'one_time', basis: 'estimated', source: 'Price list', observedAt: '2026-11-01', evidenceId: null }], references: [], datasetVersions: [], ...extra });
// The hash of exactly what sending would freeze, from the same reads a route makes.
const capitalHash = async (store, mine) => snapshotHash(capitalSnapshot(await store.getCapitalCase(mine), await store.listCreditRecords(mine.workspaceId), await store.listCapitalEvidence(mine)));

withStore('capital: the SQL draft check fails closed: missing keys, wrong types, fractions and huge amounts are false, never NULL', async (store, pool) => {
  const valid = async (draft) => (await pool.query('SELECT capital_draft_valid($1::jsonb) AS ok', [JSON.stringify(draft)])).rows[0].ok;
  const item = (patch) => ({ ...capitalDraft().costItems[0], ...patch });
  const without = (key) => { const i = item({}); delete i[key]; return i; };
  const bad = {
    'empty object': {}, 'array draft': [], 'string draft': 'x', 'null draft': null, 'number draft': 7,
    'costItems object': { costItems: {} }, 'costItems string': { costItems: 'x' }, 'costItems null': { costItems: null },
    'empty item': { costItems: [{}] }, 'string item': { costItems: ['x'] }, 'null item': { costItems: [null] }, 'array item': { costItems: [[]] },
    'no amount': { costItems: [without('amountCents')] }, 'no category': { costItems: [without('category')] }, 'no period': { costItems: [without('period')] }, 'no basis': { costItems: [without('basis')] },
    'string amount': { costItems: [item({ amountCents: '100' })] }, 'fraction': { costItems: [item({ amountCents: 12.5 })] }, 'negative': { costItems: [item({ amountCents: -1 })] }, 'huge': { costItems: [item({ amountCents: 1000000000001 })] },
    'null amount': { costItems: [item({ amountCents: null })] }, 'bool amount': { costItems: [item({ amountCents: true })] }, 'unknown basis': { costItems: [item({ basis: 'actual' })] }, 'null basis': { costItems: [item({ basis: null })] },
    'incurred without evidence': { costItems: [item({ basis: 'incurred' })] }, 'incurred null evidence': { costItems: [item({ basis: 'incurred', evidenceId: null })] }, 'incurred number evidence': { costItems: [item({ basis: 'incurred', evidenceId: 7 })] },
    'too many': { costItems: Array.from({ length: 41 }, (_, i) => item({ id: `ci_${i}` })) },
    'amount zero': { costItems: [], requestedAmountCents: 0 }, 'amount fraction': { costItems: [], requestedAmountCents: 1.5 }, 'amount string': { costItems: [], requestedAmountCents: '5' }, 'amount huge': { costItems: [], requestedAmountCents: 1000000000001 }, 'amount object': { costItems: [], requestedAmountCents: {} },
  };
  for (const [name, draft] of Object.entries(bad)) assert.strictEqual(await valid(draft), false, name);
  for (const [name, draft] of Object.entries({ 'empty list': { costItems: [] }, 'null amount key': { costItems: [], requestedAmountCents: null }, 'incomplete but valid': { costItems: [item({})] }, 'complete': capitalDraft(), 'incurred with evidence': { costItems: [item({ basis: 'incurred', evidenceId: 'e1' })] }, 'at the bounds': { costItems: [item({ amountCents: 1000000000000 })], requestedAmountCents: 1 } })) {
    assert.strictEqual(await valid(draft), true, name);
  }
  // The CHECK constraint refuses the same inputs on insert, and the default draft passes.
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  for (const [name, draft] of Object.entries(bad)) {
    await assert.rejects(pool.query("INSERT INTO capital_cases (workspace_id, title, draft, created_by) VALUES ($1, 'x', $2::jsonb, $3)", [ws.id, JSON.stringify(draft), owner.id]), (err) => err.code === '23514', `insert ${name}`);
  }
  assert.equal((await pool.query("INSERT INTO capital_cases (workspace_id, title, created_by) VALUES ($1, 'x', $2) RETURNING draft", [ws.id, owner.id])).rows[0].draft.costItems.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM capital_cases')).rows[0].n, 1);
});

withStore('capital: submitted revisions, credit records and review marks are frozen against direct SQL; links are checked in the database', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const other = await workspace(store, owner.id, { slug: 'other' });
  const foreign = await store.createProject({ workspaceId: other.id, createdBy: owner.id, name: 'Theirs', task: 'x', modalities: [], startingPoint: 'own' });
  const kase = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Pilot', draft: capitalDraft() });
  const mine = { workspaceId: ws.id, caseId: kase.id };
  // A case cannot point at another workspace's project, even by direct SQL.
  await assert.rejects(pool.query('UPDATE capital_cases SET project_id = $2 WHERE id = $1', [kase.id, foreign.id]), (err) => err.code === '23503');
  await assert.rejects(pool.query("INSERT INTO capital_cases (workspace_id, project_id, title, created_by) VALUES ($1, $2, 'x', $3)", [ws.id, foreign.id, owner.id]), (err) => err.code === '23503');
  await assert.rejects(pool.query("UPDATE capital_cases SET status = 'submitted' WHERE id = $1", [kase.id]), (err) => err.code === '23514', 'a non-draft status needs a submitted revision');
  await assert.rejects(pool.query("UPDATE capital_cases SET status = 'approved', submitted_revision = 1 WHERE id = $1", [kase.id]), (err) => err.code === '23514', 'lender states do not exist');
  const evidence = await store.addCapitalEvidence({ ...mine, createdBy: owner.id, item: { kind: 'company_record', title: 'Statement', source: 'Held by the company', reference: {}, verification: 'unverified' } });
  await assert.rejects(pool.query("INSERT INTO capital_evidence (case_id, workspace_id, kind, title, verification, created_by) VALUES ($1, $2, 'company_record', 'x', 'reviewed', $3)", [kase.id, ws.id, owner.id]), (err) => err.code === '23514', 'reviewed is not a state of the customer’s record');

  const sub = await store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 1, contentHash: await capitalHash(store, mine) });
  for (const sql of ["UPDATE capital_submissions SET snapshot = '{}'::jsonb WHERE id = $1", 'UPDATE capital_submissions SET revision = 9 WHERE id = $1', `UPDATE capital_submissions SET content_hash = '${'0'.repeat(64)}' WHERE id = $1`, 'DELETE FROM capital_submissions WHERE id = $1']) {
    await assert.rejects(pool.query(sql, [sub.id]), (err) => /submission_frozen/.test(err.message), sql);
  }
  const insert = 'INSERT INTO capital_submissions (case_id, workspace_id, revision, snapshot, content_hash, submitted_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6)';
  await assert.rejects(pool.query(insert, [kase.id, ws.id, 1, '{}', 'a'.repeat(64), owner.id]), (err) => err.code === '23505', 'one submission per revision');
  await assert.rejects(pool.query(insert, [kase.id, ws.id, 2, '{}', 'a'.repeat(64), owner.id]), (err) => err.code === '23505', 'one open submission per case');
  await assert.rejects(pool.query(insert, [kase.id, ws.id, 2, '{}', 'not-a-hash', owner.id]), (err) => err.code === '23514', 'a submission carries the consented hash');
  const mark = await store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: sub.id, evidenceId: evidence.id, reviewerId: owner.id });
  for (const sql of ['UPDATE capital_review_marks SET evidence_id = $1 WHERE id = $1', 'DELETE FROM capital_review_marks WHERE id = $1']) {
    await assert.rejects(pool.query(sql, [mark.id]), (err) => /review_mark_frozen/.test(err.message), sql);
  }
  await assert.rejects(pool.query('INSERT INTO capital_review_marks (submission_id, evidence_id, reviewer_id) VALUES ($1, $2, $3)', [sub.id, evidence.id, owner.id]), (err) => err.code === '23505', 'one mark per record and submission');
  await store.decideCapitalSubmission({ caseId: kase.id, submissionId: sub.id, reviewerId: owner.id, decision: 'changes_requested', notes: 'x' });
  await assert.rejects(pool.query("UPDATE capital_submissions SET notes = 'y' WHERE id = $1", [sub.id]), (err) => /submission_frozen/.test(err.message), 'a decision is written once');
  await assert.rejects(pool.query("UPDATE capital_submissions SET decision = 'evidence_reviewed' WHERE id = $1", [sub.id]), (err) => /submission_frozen/.test(err.message));
  assert.equal((await store.listCapitalSubmissions(mine))[0].decision, 'changes_requested');
  assert.equal((await store.listCapitalSubmissions(mine))[0].snapshot.evidence[0].verification, 'unverified', 'the frozen snapshot is unchanged by the mark');

  const credit = await store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'claimed', amountCents: 1000000, expiresOn: '2027-06-30', restrictions: '', reference: '' } });
  for (const sql of ['UPDATE credit_records SET amount_cents = 1 WHERE id = $1', 'DELETE FROM credit_records WHERE id = $1']) {
    await assert.rejects(pool.query(sql, [credit.id]), (err) => /credit_record_frozen/.test(err.message), sql);
  }
  await assert.rejects(pool.query("INSERT INTO credit_records (workspace_id, provider, status, amount_cents, created_by) VALUES ($1, 'x', 'claimed', -1, $2)", [ws.id, owner.id]), (err) => err.code === '23514');
  await assert.rejects(pool.query("INSERT INTO credit_records (workspace_id, provider, status, amount_cents, created_by) VALUES ($1, 'x', 'evidenced', 1, $2)", [ws.id, owner.id]), (err) => err.code === '23514', 'evidenced needs a reference');
  await assert.rejects(pool.query("INSERT INTO credit_records (workspace_id, provider, status, amount_cents, supersedes, created_by) VALUES ($1, 'x', 'claimed', 1, $2, $3)", [other.id, credit.id, owner.id]), (err) => err.code === '23503', 'a correction stays in its workspace');
  assert.equal((await store.listCreditRecords(ws.id))[0].expiresOn, '2027-06-30', 'dates come back as the day entered');
});

withStore('capital: parallel sends of one revision make one submission; parallel edits of one revision have one winner', async (store) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const kase = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Race', draft: capitalDraft() });
  const mine = { workspaceId: ws.id, caseId: kase.id };
  const edits = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.updateCapitalCase({ ...mine, expectedRevision: 1, title: `Edit ${i}`, draft: capitalDraft() })));
  assert.equal(edits.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(edits.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'stale_revision'));
  assert.equal((await store.getCapitalCase(mine)).revision, 2);
  const contentHash = await capitalHash(store, mine);
  const sends = await Promise.all(Array.from({ length: 6 }, () => store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 2, contentHash })));
  assert.equal(new Set(sends.map((s) => s.id)).size, 1);
  assert.equal((await store.listCapitalSubmissions(mine)).length, 1);
  assert.equal((await store.listAudit(ws.id)).filter((e) => e.action === 'capital.submitted').length, 1);
  const stale = await Promise.allSettled(Array.from({ length: 3 }, () => store.updateCapitalCase({ ...mine, expectedRevision: 2, title: 'late', draft: capitalDraft() })));
  assert.ok(stale.every((r) => r.status === 'rejected' && r.reason.code === 'invalid_state'), 'frozen while submitted');
});

withStore('capital: references are settled on the locked row: a cited record cannot vanish under the plan, and a send recheck catches a dangling one', async (store, pool) => {
  const owner = await user(store);
  const ws = await workspace(store, owner.id);
  const kase = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Refs', draft: capitalDraft() });
  const mine = { workspaceId: ws.id, caseId: kase.id };
  const evidence = await store.addCapitalEvidence({ ...mine, createdBy: owner.id, item: { kind: 'company_record', title: 'Invoice', source: 'Held by the company', reference: {}, verification: 'unverified' } });
  const citing = capitalDraft({ costItems: [{ ...capitalDraft().costItems[0], id: 'ci_inc', basis: 'incurred', evidenceId: evidence.id }] });
  // Deleting the record and saving a plan that cites it race: exactly one of them can win, never both.
  for (let round = 0; round < 4; round++) {
    const fresh = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: `Race ${round}`, draft: capitalDraft() });
    const where = { workspaceId: ws.id, caseId: fresh.id };
    const ev = await store.addCapitalEvidence({ ...where, createdBy: owner.id, item: { kind: 'company_record', title: 'Invoice', source: 'x', reference: {}, verification: 'unverified' } });
    const draft = capitalDraft({ costItems: [{ ...capitalDraft().costItems[0], basis: 'incurred', evidenceId: ev.id }] });
    const [del, upd] = await Promise.allSettled([store.deleteCapitalEvidence({ ...where, evidenceId: ev.id }), store.updateCapitalCase({ ...where, expectedRevision: 1, title: 'Race', draft })]);
    assert.equal([del, upd].filter((r) => r.status === 'fulfilled').length, 1, `round ${round}: one winner`);
    if (del.status === 'fulfilled') assert.equal(upd.reason.code, 'missing_reference');
    else assert.equal(del.reason.code, 'evidence_in_use');
    const after = await store.getCapitalCase(where);
    const stillThere = (await store.listCapitalEvidence(where)).some((e) => e.id === ev.id);
    assert.equal(after.draft.costItems.some((i) => i.evidenceId === ev.id), stillThere, `round ${round}: no dangling citation`);
  }
  // A dangling citation written around the store (the SQL check only requires a string) is caught by the send recheck.
  await store.updateCapitalCase({ ...mine, expectedRevision: 1, title: 'Refs', draft: citing });
  await pool.query('DELETE FROM capital_evidence WHERE id = $1', [evidence.id]);
  await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 2, contentHash: await capitalHash(store, mine) }), { code: 'missing_reference' });
  assert.equal((await store.listCapitalSubmissions(mine)).length, 0);
  // Same for a dataset version that is not frozen in this workspace.
  await pool.query('UPDATE capital_cases SET draft = $2::jsonb WHERE id = $1', [kase.id, JSON.stringify(capitalDraft({ datasetVersions: [{ projectId: kase.id, version: 1 }] }))]);
  await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 2, contentHash: await capitalHash(store, mine) }), { code: 'missing_reference' });
});

withStore('case runs: database heartbeat freshness is independent of a drifted app clock, and cold, stale and future reports still fail', async (store, pool) => {
  const owner = await user(store, 'case-clock@example.test');
  const ws = await workspace(store, owner.id);
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Policy', task: 'QA ONLY clock regression', modalities: ['Text'], startingPoint: 'model' });
  const at = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...at, patch: { success: { measure: 'exact', target: 'Policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const review = await store.submitForReview({ ...at, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const dataset = await store.createDatasetVersion({ ...at, createdBy: owner.id });
  const set = await store.createEvalSet({ ...at, createdBy: owner.id, name: 'Policy', purpose: 'development' });
  await store.saveEvalCase({ ...at, setId: set.id, expectedRevision: 1, input: { id: 'a', input: 'Window?', expectedAnswer: '30 days', sources: [{ projectId: project.id, versionId: dataset.id, fileId: null }] } });
  const detail = await store.getEvalSet({ ...at, setId: set.id });
  const frozen = await store.freezeEvalSet({ ...at, setId: set.id, expectedRevision: detail.set.revision, actorId: owner.id });
  const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'QA ONLY', keyHash: 'a'.repeat(64), keyPrefix: 'vrk_clock' });
  const start = (key) => store.startCaseRun({ ...at, versionId: frozen.id, runnerId: runner.id, role: 'candidate', recipeVersion: '1', actorId: owner.id, idempotencyKey: `case-clock-${key}`, candidate: { corpus: '30 days', retrievalK: 1 } });
  await assert.rejects(start('cold'), { code: 'invalid_state' });
  await store.reportRunner({ runnerId: runner.id, capabilities: { sandbox: { available: true } } });
  const realNow = Date.now;
  let appNow = realNow();
  Date.now = () => appNow;
  try {
    for (const drift of [-86_400_000, 86_400_000]) {
      appNow = realNow() + drift;
      assert.equal((await start(`fresh-${drift < 0 ? 'behind' : 'ahead'}`)).status, 'queued');
    }
    for (const [key, offset] of [['stale', '-61 seconds'], ['future', '60 seconds']]) {
      const reported = (await pool.query('UPDATE runners SET last_seen_at=clock_timestamp()+$2::interval WHERE id=$1 RETURNING last_seen_at', [runner.id, offset])).rows[0].last_seen_at;
      appNow = reported.getTime() + 1; // The drifted app clock would consider either report fresh.
      await assert.rejects(start(key), { code: 'invalid_state' });
    }
    await pool.query('UPDATE runners SET last_seen_at=NULL WHERE id=$1', [runner.id]);
    await assert.rejects(start('cold-after-drift'), { code: 'invalid_state' });
  } finally { Date.now = realNow; }
});

withStore('evaluation: direct SQL cannot change frozen cases, versions, imports or reports, and deleting the workspace fails closed', async (store, pool) => {
  const owner = await user(store, 'eval-sql@example.test');
  const ws = await workspace(store, owner.id, { slug: 'eval-sql', name: 'Eval SQL' });
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Support', task: 'Answer policy questions.', modalities: ['Text'], startingPoint: 'model' });
  await store.updateProject({ workspaceId: ws.id, projectId: project.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const review = await store.submitForReview({ workspaceId: ws.id, projectId: project.id, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const dataset = await store.createDatasetVersion({ workspaceId: ws.id, projectId: project.id, createdBy: owner.id });
  const set = await store.createEvalSet({ workspaceId: ws.id, projectId: project.id, createdBy: owner.id, name: 'SQL', purpose: 'development' });
  const source = { projectId: project.id, versionId: dataset.id, fileId: null };
  const saved = await store.saveEvalCase({ workspaceId: ws.id, projectId: project.id, setId: set.id, expectedRevision: set.revision, input: { id: 'a', input: 'Question a', expectedAnswer: '30 days', sources: [source] } });
  const detail = await store.getEvalSet({ workspaceId: ws.id, projectId: project.id, setId: set.id });
  const frozen = await store.freezeEvalSet({ workspaceId: ws.id, projectId: project.id, setId: set.id, expectedRevision: detail.set.revision, actorId: owner.id });
  const jsonl = '{"id":"a","status":"answered","output":"30 days"}\n';
  const baseline = await store.importEvalPredictions({ workspaceId: ws.id, projectId: project.id, versionId: frozen.id, role: 'baseline', label: 'old', claimedSystem: {}, claimedScorer: null, filename: 'a.jsonl', jsonl, importedBy: owner.id });
  const candidate = await store.importEvalPredictions({ workspaceId: ws.id, projectId: project.id, versionId: frozen.id, role: 'candidate', label: 'new', claimedSystem: {}, claimedScorer: null, filename: 'b.jsonl', jsonl, importedBy: owner.id });
  const comparison = await store.createEvalComparison({ workspaceId: ws.id, projectId: project.id, setId: set.id, versionId: frozen.id, baselineBatchId: baseline.batch.id, candidateBatchId: candidate.batch.id, createdBy: owner.id });
  const preview = await store.readEvalComparison({ workspaceId: ws.id, comparisonId: comparison.id });
  const report = await store.approveEvalReport({ workspaceId: ws.id, comparisonId: comparison.id, expectedRevision: comparison.revision, contentHash: preview.contentHash, approvedBy: owner.id });
  const predictionId = (await pool.query('SELECT id FROM eval_predictions WHERE batch_id = $1', [baseline.batch.id])).rows[0].id;
  const refused = [
    ['UPDATE eval_cases SET input = $2 WHERE id = $1', [saved.id, 'Changed by SQL']],
    ['DELETE FROM eval_cases WHERE id = $1', [saved.id]],
    ['UPDATE eval_sets SET acceptance = $2::jsonb WHERE id = $1', [set.id, JSON.stringify({ version: 1 })]],
    ['UPDATE eval_set_versions SET content_hash = $2 WHERE id = $1', [frozen.id, 'a'.repeat(64)]],
    ['DELETE FROM eval_set_versions WHERE id = $1', [frozen.id]],
    ['UPDATE eval_batches SET label = $2 WHERE id = $1', [baseline.batch.id, 'renamed']],
    ['DELETE FROM eval_batches WHERE id = $1', [baseline.batch.id]],
    ['UPDATE eval_predictions SET output = $2 WHERE id = $1', [predictionId, 'rewritten']],
    ['DELETE FROM eval_predictions WHERE id = $1', [predictionId]],
    ['UPDATE eval_reports SET decision = $2 WHERE id = $1', [report.id, 'pass']],
    ['DELETE FROM eval_reports WHERE id = $1', [report.id]],
  ];
  for (const [sql, params] of refused) {
    await assert.rejects(pool.query(sql, params), (err) => /eval_frozen/.test(err.message), sql);
  }
  await assert.rejects(pool.query('DELETE FROM workspaces WHERE id = $1', [ws.id]), (err) => /eval_frozen/.test(err.message));
  const reopened = await store.reopenEvalSet({ workspaceId: ws.id, projectId: project.id, setId: set.id, actorId: owner.id });
  await pool.query('UPDATE eval_cases SET input = $2 WHERE set_id = $1', [set.id, 'Edited after reopen']);
  const kept = await pool.query('SELECT manifest, content_hash FROM eval_set_versions WHERE id = $1', [frozen.id]);
  assert.equal(kept.rows[0].manifest.cases[0].input, 'Question a');
  assert.equal(kept.rows[0].content_hash, frozen.contentHash);
  const frozenReport = await pool.query('SELECT snapshot FROM eval_reports WHERE id = $1', [report.id]);
  assert.equal(frozenReport.rows[0].snapshot.cases[0].input, 'Question a');
  assert.equal(reopened.revision, detail.set.revision + 1);
  await assert.rejects(pool.query('DELETE FROM eval_reports WHERE id = $1', [report.id]), (err) => /eval_frozen/.test(err.message));
});
