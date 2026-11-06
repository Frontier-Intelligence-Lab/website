import assert from 'node:assert/strict';
import { capitalSnapshot, emptyDraft } from '../src/lib/capital.js';
import { snapshotHash } from '../src/lib/capital-hash.js';

// Shared behaviour every store must have. tests/store-memory.test.js runs it against the
// in-memory store; the Postgres store runs the same suite against a real database.
// `makeStore` must return a fresh, empty store each call.
export function runStoreContract(test, makeStore, label) {
  const later = (days) => new Date(Date.now() + days * 86400000);

  const withStore = (name, fn) => test(`${label}: ${name}`, async () => {
    const store = await makeStore();
    try { await fn(store); } finally { await store.close(); }
  });

  withStore('users are unique by case-insensitive email and never expose the hash', async (store) => {
    const user = await store.createUser({ email: 'Alex@Acme-Robotics.com', name: 'Alex', passwordHash: 'scrypt$x' });
    assert.equal(user.email, 'alex@acme-robotics.com');
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.emailVerifiedAt, null);
    await assert.rejects(store.createUser({ email: 'ALEX@acme-robotics.com', name: 'Other', passwordHash: 'scrypt$y' }), { code: 'email_taken' });
    const auth = await store.getUserAuthByEmail('alex@ACME-robotics.com');
    assert.equal(auth.passwordHash, 'scrypt$x');
    assert.equal(auth.user.id, user.id);
    assert.equal(await store.getUserAuthByEmail('nobody@example.com'), null);
    assert.equal((await store.getUserById(user.id)).name, 'Alex');
    assert.ok((await store.setEmailVerified(user.id)).emailVerifiedAt);
  });

  withStore('email codes are single use, expire, replace older codes and lock after 5 attempts', async (store) => {
    const { id: userId } = await store.createUser({ email: 'a@b.co', name: 'A', passwordHash: 'h' });
    await store.createEmailCode({ userId, email: 'a@b.co', purpose: 'signup', codeHash: 'old', expiresAt: later(1) });
    await store.createEmailCode({ userId, email: 'a@b.co', purpose: 'signup', codeHash: 'new', expiresAt: later(1) });
    assert.deepEqual(await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'old' }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'new' }), { ok: true, email: 'a@b.co' });
    assert.equal((await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'new' })).ok, false);

    await store.createEmailCode({ userId, email: 'a@b.co', purpose: 'signup', codeHash: 'gone', expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'gone' })).reason, 'expired');

    await store.createEmailCode({ userId, email: 'a@b.co', purpose: 'signup', codeHash: 'right', expiresAt: later(1) });
    for (let i = 0; i < 5; i++) await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'wrong' });
    assert.equal((await store.consumeEmailCode({ userId, purpose: 'signup', codeHash: 'right' })).reason, 'too_many_attempts');
  });

  withStore('creating a workspace makes its creator the owner, atomically', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', domain: 'Acme.com', domainVerified: true, joinByDomain: true, ownerId: owner.id });
    assert.equal(ws.kind, 'organization');
    assert.equal(ws.domain, 'acme.com');
    assert.equal(ws.joinByDomain, true);
    assert.deepEqual(await store.getMembership(ws.id, owner.id), { role: 'owner' });
    assert.equal(await store.isSlugAvailable('acme'), false);
    await assert.rejects(store.createWorkspace({ kind: 'organization', name: 'Acme 2', slug: 'acme', ownerId: owner.id }), { code: 'slug_taken' });
    const listed = await store.listWorkspacesForUser(owner.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].role, 'owner');
    assert.equal((await store.listMembers(ws.id))[0].user.email, 'o@acme.com');
    assert.equal((await store.listAudit(ws.id))[0].action, 'workspace.created');
  });

  withStore('domain join needs a verified domain; personal workspaces are one per user', async (store) => {
    const u = await store.createUser({ email: 'u@lab.edu', name: 'U', passwordHash: 'h' });
    const unverified = await store.createWorkspace({ kind: 'organization', name: 'Lab', slug: 'lab', domain: 'lab.edu', domainVerified: false, joinByDomain: true, ownerId: u.id });
    assert.equal(unverified.joinByDomain, false);
    assert.equal(await store.findWorkspaceByJoinDomain('lab.edu'), null);
    await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', domain: 'acme.com', domainVerified: true, joinByDomain: true, ownerId: u.id });
    assert.equal((await store.findWorkspaceByJoinDomain('ACME.com')).slug, 'acme');

    await store.createWorkspace({ kind: 'personal', name: 'U', slug: 'u-personal', ownerId: u.id });
    await assert.rejects(store.createWorkspace({ kind: 'personal', name: 'U again', slug: 'u-personal-2', ownerId: u.id }), { code: 'personal_exists' });
  });

  withStore('join requests are idempotent and approval adds exactly one membership', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const joiner = await store.createUser({ email: 'j@acme.com', name: 'J', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const first = await store.createJoinRequest({ workspaceId: ws.id, userId: joiner.id, note: 'hi' });
    const again = await store.createJoinRequest({ workspaceId: ws.id, userId: joiner.id });
    assert.equal(again.id, first.id);
    await assert.rejects(store.createJoinRequest({ workspaceId: ws.id, userId: owner.id }), { code: 'already_member' });
    assert.equal((await store.listJoinRequests(ws.id)).length, 1);
    assert.equal((await store.listJoinRequestsForUser(joiner.id))[0].workspaceName, 'Acme');

    const decided = await store.decideJoinRequest({ workspaceId: ws.id, requestId: first.id, deciderId: owner.id, approve: true });
    assert.equal(decided.status, 'approved');
    assert.deepEqual(await store.getMembership(ws.id, joiner.id), { role: 'member' });
    await assert.rejects(store.decideJoinRequest({ workspaceId: ws.id, requestId: first.id, deciderId: owner.id, approve: false }), { code: 'already_decided' });

    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    await assert.rejects(store.decideJoinRequest({ workspaceId: other.id, requestId: first.id, deciderId: owner.id, approve: true }), { code: 'not_found' });
  });

  withStore('invitations replace earlier pending ones for the same email and hide token hashes', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: 'P@acme.com', role: 'member', tokenHash: 't1', expiresAt: later(7) }] });
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: 'p@acme.com', role: 'finance', tokenHash: 't2', expiresAt: later(7) }, { email: 'q@acme.com', role: 'viewer', tokenHash: 't3', expiresAt: later(7) }] });
    const pending = await store.listInvitations(ws.id);
    assert.equal(pending.length, 2);
    assert.equal(pending.find((i) => i.email === 'p@acme.com').role, 'finance');
    assert.ok(pending.every((i) => i.tokenHash === undefined));
  });

  withStore('invitations are accepted once, by token, and expired or revoked ones are refused', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const guest = await store.createUser({ email: 'g@acme.com', name: 'G', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [
      { email: 'g@acme.com', role: 'finance', tokenHash: 'tok-ok', expiresAt: later(7) },
      { email: 'late@acme.com', role: 'viewer', tokenHash: 'tok-old', expiresAt: new Date(Date.now() - 1000) },
      { email: 'gone@acme.com', role: 'viewer', tokenHash: 'tok-gone', expiresAt: later(7) },
    ] });
    const invite = await store.getInvitationByTokenHash('tok-ok');
    assert.equal(invite.workspaceName, 'Acme');
    assert.equal(invite.tokenHash, undefined);
    assert.equal(await store.getInvitationByTokenHash('nope'), null);

    assert.deepEqual(await store.acceptInvitation({ invitationId: invite.id, userId: guest.id }), { workspaceId: ws.id, role: 'finance', alreadyMember: false });
    assert.deepEqual(await store.getMembership(ws.id, guest.id), { role: 'finance' });
    await assert.rejects(store.acceptInvitation({ invitationId: invite.id, userId: guest.id }), { code: 'already_decided' });
    const old = await store.getInvitationByTokenHash('tok-old');
    await assert.rejects(store.acceptInvitation({ invitationId: old.id, userId: guest.id }), { code: 'invite_expired' });
    const gone = await store.getInvitationByTokenHash('tok-gone');
    await store.revokeInvitation({ workspaceId: ws.id, invitationId: gone.id, actorId: owner.id });
    await assert.rejects(store.acceptInvitation({ invitationId: gone.id, userId: guest.id }), { code: 'already_decided' });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    await assert.rejects(store.revokeInvitation({ workspaceId: other.id, invitationId: invite.id, actorId: owner.id }), { code: 'not_found' });
    assert.equal((await store.listInvitations(ws.id)).length, 0);

    const updated = await store.updateWorkspaceProfile({ workspaceId: ws.id, profile: { academicEmail: 'g@uni.edu' } });
    assert.equal(updated.profile.academicEmail, 'g@uni.edu');
  });

  withStore('uploads, review and dataset versions follow the project lifecycle', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const staff = await store.createUser({ email: 'r@valcairn.test', name: 'R', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'P', task: 'Spot damaged boxes', modalities: ['Images'], startingPoint: 'own' });
    const file = { uploadedBy: owner.id, sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'image/png', filename: 'a.png' };
    const u1 = await store.createUpload({ workspaceId: ws.id, projectId: p.id, objectKey: 'k1', ...file });
    assert.equal(u1.duplicateOf, null);
    const u2 = await store.createUpload({ workspaceId: ws.id, projectId: p.id, objectKey: 'k2', ...file });
    assert.equal(u2.duplicateOf, u1.id);
    await assert.rejects(store.createUpload({ workspaceId: ws.id, projectId: p.id, objectKey: 'k1', ...file }), { code: 'duplicate_upload' });
    await assert.rejects(store.createUpload({ workspaceId: other.id, projectId: p.id, objectKey: 'k3', ...file }), { code: 'not_found' });
    assert.equal((await store.listUploads({ workspaceId: ws.id, projectId: p.id })).length, 2);
    assert.equal((await store.listUploads({ workspaceId: other.id, projectId: p.id })).length, 0);
    assert.equal((await store.getUpload(u1.id)).objectKey, 'k1');

    await assert.rejects(store.createDatasetVersion({ workspaceId: ws.id, projectId: p.id, createdBy: owner.id }), { code: 'invalid_state' });
    const review = await store.submitForReview({ workspaceId: ws.id, projectId: p.id, submittedBy: owner.id });
    assert.deepEqual(review.snapshot.files.map((f) => f.id), [u1.id], 'duplicates are not part of the reviewed set');
    assert.equal((await store.getProject({ workspaceId: ws.id, projectId: p.id })).status, 'in_review');
    await assert.rejects(store.submitForReview({ workspaceId: ws.id, projectId: p.id, submittedBy: owner.id }), { code: 'invalid_state' });
    const queue = await store.listReviews({ status: 'pending' });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].workspaceName, 'Acme');
    // A workspace-scoped queue (demo-scoped staff) holds that workspace's rows and nothing else.
    assert.deepEqual((await store.listReviews({ status: 'pending', workspaceId: ws.id })).map((r) => r.id), [review.id]);
    assert.deepEqual(await store.listReviews({ status: 'pending', workspaceId: other.id }), []);
    assert.deepEqual(await store.listReviews({ status: 'pending', workspaceId: 'not-an-id' }), []);

    await store.decideReview({ reviewId: review.id, reviewerId: staff.id, decision: 'changes_requested', notes: 'Labels missing', checks: { rights: true, labels: false } });
    assert.equal((await store.getProject({ workspaceId: ws.id, projectId: p.id })).status, 'changes_requested');
    await assert.rejects(store.decideReview({ reviewId: review.id, reviewerId: staff.id, decision: 'approved' }), { code: 'already_decided' });
    const second = await store.submitForReview({ workspaceId: ws.id, projectId: p.id, submittedBy: owner.id });
    await store.decideReview({ reviewId: second.id, reviewerId: staff.id, decision: 'approved', checks: { rights: true, labels: true } });
    assert.equal((await store.listProjectReviews({ workspaceId: ws.id, projectId: p.id })).length, 2);

    const v1 = await store.createDatasetVersion({ workspaceId: ws.id, projectId: p.id, createdBy: owner.id });
    assert.equal(v1.number, 1);
    assert.equal(v1.manifest.reviewId, second.id);
    assert.deepEqual(v1.manifest.files.map((f) => f.sha256), [u1.sha256]);
    assert.equal(v1.manifest.task, 'Spot damaged boxes');
    assert.equal((await store.getProject({ workspaceId: ws.id, projectId: p.id })).status, 'versioned');
    await assert.rejects(store.createDatasetVersion({ workspaceId: ws.id, projectId: p.id, createdBy: owner.id }), { code: 'invalid_state' }, 'one version per approval');
    await assert.rejects(store.createDatasetVersion({ workspaceId: other.id, projectId: p.id, createdBy: owner.id }), { code: 'not_found' });
    assert.deepEqual((await store.listDatasetVersions({ workspaceId: ws.id, projectId: p.id })).map((v) => v.number), [1]);
  });

  withStore('reviewed content is frozen until the project is reopened, and reopening voids the approval', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const staff = await store.createUser({ email: 'r@valcairn.test', name: 'R', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'P', task: 'Spot damaged boxes', modalities: ['Images'], startingPoint: 'own' });
    const where = { workspaceId: ws.id, projectId: p.id };
    const file = (n) => ({ ...where, uploadedBy: owner.id, objectKey: `k${n}`, sha256: String(n).repeat(64).slice(0, 64), sizeBytes: 10, contentType: 'image/png', filename: `${n}.png` });
    await store.updateProject({ ...where, patch: { dataSource: { mode: 'upload', provenance: 'ours' } } });
    await store.createUpload(file(1));

    const frozen = async (label) => {
      await assert.rejects(store.updateProject({ ...where, patch: { dataSource: { mode: 'upload', provenance: 'licensed' } } }), { code: 'invalid_state' }, `${label}: rights`);
      await assert.rejects(store.updateProject({ ...where, patch: { success: { target: '1%' } } }), { code: 'invalid_state' }, `${label}: rule`);
      await assert.rejects(store.updateProject({ ...where, patch: { task: 'Something else' } }), { code: 'invalid_state' }, `${label}: task`);
      await assert.rejects(store.createUpload(file(label.length + 2)), { code: 'invalid_state' }, `${label}: held receipt`);
      const [u] = await store.listUploads(where);
      await assert.rejects(store.deleteUpload({ ...where, uploadId: u.id, actorId: owner.id }), { code: 'invalid_state' }, `${label}: delete`);
    };

    const r1 = await store.submitForReview({ ...where, submittedBy: owner.id });
    await frozen('in review');
    // Lifecycle status cannot be patched directly.
    assert.equal((await store.updateProject({ ...where, patch: { status: 'approved', setupStep: 'done' } })).status, 'in_review');

    await store.reopenProject({ ...where, actorId: owner.id });
    assert.equal((await store.getReview(r1.id)).status, 'withdrawn');
    await store.createUpload(file(3));
    const r2 = await store.submitForReview({ ...where, submittedBy: owner.id });
    assert.equal(r2.snapshot.files.length, 2);
    await store.decideReview({ reviewId: r2.id, reviewerId: staff.id, decision: 'approved', checks: {} });
    await frozen('approved');

    await store.reopenProject({ ...where, actorId: owner.id });
    await assert.rejects(store.createDatasetVersion({ ...where, createdBy: owner.id }), { code: 'invalid_state' }, 'reopening voids the approval');
    await store.updateProject({ ...where, patch: { dataSource: { mode: 'upload', provenance: 'licensed' } } });
    const r3 = await store.submitForReview({ ...where, submittedBy: owner.id });
    await store.decideReview({ reviewId: r3.id, reviewerId: staff.id, decision: 'approved', checks: {} });
    const v = await store.createDatasetVersion({ ...where, createdBy: owner.id });
    assert.equal(v.manifest.reviewId, r3.id);
    assert.equal(v.manifest.dataSource.provenance, 'licensed');
    await frozen('versioned');
    await assert.rejects(store.reopenProject({ workspaceId: ws.id, projectId: 'nope', actorId: owner.id }), { code: 'not_found' });
    await store.reopenProject({ ...where, actorId: owner.id });
    await assert.rejects(store.reopenProject({ ...where, actorId: owner.id }), { code: 'invalid_state' }, 'a draft is already open');
  });

  withStore('uploads respect project quotas; deleting an original promotes its earliest copy', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'P', task: 'Spot damaged boxes', modalities: ['Images'], startingPoint: 'own' });
    const where = { workspaceId: ws.id, projectId: p.id };
    const add = (key, sha, size = 10, limits) => store.createUpload({ ...where, uploadedBy: owner.id, objectKey: key, sha256: sha.repeat(64), sizeBytes: size, contentType: 'image/png', filename: `${key}.png`, limits });
    const a = await add('a', 'a');
    const b = await add('b', 'a');
    const c = await add('c', 'a');
    assert.equal(b.duplicateOf, a.id);
    await assert.rejects(add('d', 'd', 10, { maxFiles: 3 }), { code: 'quota_exceeded' });
    await assert.rejects(add('d', 'd', 21, { maxBytes: 50 }), { code: 'quota_exceeded' });
    await add('d', 'd', 20, { maxFiles: 4, maxBytes: 50 });

    const removed = await store.deleteUpload({ ...where, uploadId: a.id, actorId: owner.id });
    assert.equal(removed.objectKey, 'a');
    const left = Object.fromEntries((await store.listUploads(where)).map((u) => [u.objectKey, u.duplicateOf]));
    assert.deepEqual(left, { b: null, c: b.id, d: null });
    await assert.rejects(store.deleteUpload({ ...where, uploadId: a.id, actorId: owner.id }), { code: 'not_found' });
  });

  withStore('label sets, labels, file types and issue notes are review content: snapshotted, then frozen', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'P', task: 'Spot jams', modalities: ['Video'], startingPoint: 'own' });
    assert.deepEqual(p.labelSet, []);
    const where = { workspaceId: ws.id, projectId: p.id };
    const video = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: 'v1', sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'video/mp4', filename: 'dock.mp4' });
    assert.equal(video.kind, null);
    assert.equal(video.offsetMs, null);
    const labelSet = [{ id: 'l_jam', name: 'belt jam', scope: 'span', tone: 'green' }];
    assert.deepEqual((await store.setLabelSet({ ...where, labelSet })).labelSet, labelSet);

    const moved = await store.updateUpload({ ...where, uploadId: video.id, patch: { kind: 'sensor', offsetMs: -800 } });
    assert.equal(moved.kind, 'sensor');
    assert.equal(moved.offsetMs, -800);
    assert.equal((await store.updateUpload({ ...where, uploadId: video.id, patch: { kind: null } })).kind, null);
    await assert.rejects(store.updateUpload({ workspaceId: other.id, projectId: p.id, uploadId: video.id, patch: { kind: 'audio' } }), { code: 'not_found' });

    const span = await store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_jam', startMs: 41000, endMs: 72000, createdBy: owner.id });
    assert.equal(span.startMs, 41000);
    await assert.rejects(store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_jam', createdBy: owner.id }), { code: 'invalid_label' }, 'a span label needs times');
    const fullSet = [...labelSet, { id: 'l_ok', name: 'ok', scope: 'file', tone: 'plain' }];
    await store.setLabelSet({ ...where, labelSet: fullSet });
    const whole = await store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_ok', createdBy: owner.id });
    assert.equal(whole.startMs, null);
    await assert.rejects(store.createAnnotation({ workspaceId: other.id, projectId: p.id, uploadId: video.id, labelId: 'l_jam', createdBy: owner.id }), { code: 'not_found' });
    await store.deleteAnnotation({ ...where, annotationId: whole.id });
    await assert.rejects(store.deleteAnnotation({ ...where, annotationId: whole.id }), { code: 'not_found' });
    assert.equal((await store.listAnnotations(where)).length, 1);
    assert.deepEqual(await store.listAnnotations({ workspaceId: other.id, projectId: p.id }), []);

    await store.setIssueNote({ ...where, key: 'labels:none', note: 'first', createdBy: owner.id });
    assert.equal((await store.setIssueNote({ ...where, key: 'labels:none', note: 'second', createdBy: owner.id })).note, 'second');
    assert.deepEqual((await store.listIssueNotes(where)).map((n) => [n.key, n.note]), [['labels:none', 'second']]);
    await store.setIssueNote({ ...where, key: 'gone', note: 'x', createdBy: owner.id });
    await store.deleteIssueNote({ ...where, key: 'gone' });
    await assert.rejects(store.deleteIssueNote({ ...where, key: 'gone' }), { code: 'not_found' });

    await store.updateProject({ ...where, patch: { dataSource: { mode: 'upload', provenance: 'ours' } } });
    const review = await store.submitForReview({ ...where, submittedBy: owner.id });
    assert.deepEqual(review.snapshot.labelSet, fullSet);
    assert.deepEqual(review.snapshot.annotations.map((a) => [a.uploadId, a.labelId, a.startMs, a.endMs]), [[video.id, 'l_jam', 41000, 72000]]);
    assert.deepEqual(review.snapshot.issueNotes, [{ key: 'labels:none', note: 'second' }]);
    assert.equal(review.snapshot.files[0].offsetMs, -800);

    await assert.rejects(store.setLabelSet({ ...where, labelSet: [] }), { code: 'invalid_state' });
    await assert.rejects(store.updateUpload({ ...where, uploadId: video.id, patch: { kind: 'audio' } }), { code: 'invalid_state' });
    await assert.rejects(store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_jam', createdBy: owner.id }), { code: 'invalid_state' });
    await assert.rejects(store.deleteAnnotation({ ...where, annotationId: span.id }), { code: 'invalid_state' });
    await assert.rejects(store.setIssueNote({ ...where, key: 'labels:none', note: 'third', createdBy: owner.id }), { code: 'invalid_state' });
    await assert.rejects(store.deleteIssueNote({ ...where, key: 'labels:none' }), { code: 'invalid_state' });

    // Reopening unlocks them again; deleting a file takes its labels with it.
    await store.reopenProject({ ...where, actorId: owner.id });
    await store.deleteUpload({ ...where, uploadId: video.id, actorId: owner.id });
    assert.deepEqual(await store.listAnnotations(where), []);
  });

  withStore('the store enforces the Resolve gate and label rules itself, so racing writes cannot slip past them', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const fresh = async (name) => {
      const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name, task: 'Spot jams', modalities: ['Video'], startingPoint: 'own' });
      const where = { workspaceId: ws.id, projectId: p.id };
      await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%', baseline: 'current' }, dataSource: { mode: 'upload', provenance: 'ours' } } });
      await store.setLabelSet({ ...where, labelSet: [{ id: 'l_jam', name: 'jam', scope: 'span', tone: 'green' }, { id: 'l_ok', name: 'ok', scope: 'file', tone: 'plain' }, { id: 'l_box', name: 'tear', scope: 'box', tone: 'orange' }] });
      const video = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: `${name}-v`, sha256: 'a'.repeat(64), sizeBytes: 10, contentType: 'video/mp4', filename: 'dock.mp4' });
      await store.createAnnotation({ ...where, uploadId: video.id, labelId: 'l_jam', startMs: 0, endMs: 10, createdBy: owner.id });
      return { where, video };
    };
    const image = (where, key) => store.createUpload({ ...where, uploadedBy: owner.id, objectKey: key, sha256: 'c'.repeat(64), sizeBytes: 10, contentType: 'image/png', filename: 'carton.png' });

    const a = await fresh('a');
    const img = await image(a.where, 'a-img');
    await assert.rejects(store.submitForReview({ ...a.where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open === 1);
    await assert.rejects(store.createAnnotation({ ...a.where, uploadId: img.id, labelId: 'l_jam', startMs: 0, endMs: 5, createdBy: owner.id }), { code: 'invalid_label' }, 'no spans on images');
    await assert.rejects(store.createAnnotation({ ...a.where, uploadId: img.id, labelId: 'l_box', box: { x: 0.5, y: 0.5, w: 0.6, h: 0.1 }, createdBy: owner.id }), { code: 'invalid_label' }, 'box inside the image');
    await assert.rejects(store.createAnnotation({ ...a.where, uploadId: img.id, labelId: 'gone', createdBy: owner.id }), { code: 'invalid_label' });
    const box = await store.createAnnotation({ ...a.where, uploadId: img.id, labelId: 'l_box', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, createdBy: owner.id });
    assert.deepEqual(box.box, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual((await store.updateAnnotation({ ...a.where, annotationId: box.id, patch: { box: { x: 0, y: 0, w: 1, h: 1 } } })).box, { x: 0, y: 0, w: 1, h: 1 });
    await assert.rejects(store.updateUpload({ ...a.where, uploadId: img.id, patch: { kind: 'text' } }), { code: 'label_in_use' });
    await assert.rejects(store.setLabelSet({ ...a.where, labelSet: [{ id: 'l_jam', name: 'jam', scope: 'span', tone: 'green' }] }), (err) => err.code === 'label_in_use' && err.message === 'tear');
    await assert.rejects(store.setLabelSet({ ...a.where, labelSet: [{ id: 'l_jam', name: 'jam', scope: 'file', tone: 'green' }, { id: 'l_box', name: 'tear', scope: 'box', tone: 'orange' }] }), { code: 'label_in_use' }, 'a used label cannot change scope');
    const review = await store.submitForReview({ ...a.where, submittedBy: owner.id, requireResolved: true });
    assert.deepEqual(review.snapshot.annotations.find((x) => x.id === box.id).box, { x: 0, y: 0, w: 1, h: 1 });

    // Racing a new unlabelled file against submit: never both succeed.
    const b = await fresh('b');
    const [upload, submit] = await Promise.allSettled([image(b.where, 'b-img'), store.submitForReview({ ...b.where, submittedBy: owner.id, requireResolved: true })]);
    assert.ok(!(upload.status === 'fulfilled' && submit.status === 'fulfilled'), 'an unlabelled file and a passing submit cannot both land');

    // Racing label removal against its first use: never both succeed.
    const c = await fresh('c');
    const [remove, use] = await Promise.allSettled([
      store.setLabelSet({ ...c.where, labelSet: [{ id: 'l_jam', name: 'jam', scope: 'span', tone: 'green' }] }),
      store.createAnnotation({ ...c.where, uploadId: c.video.id, labelId: 'l_ok', createdBy: owner.id }),
    ]);
    assert.ok(!(remove.status === 'fulfilled' && use.status === 'fulfilled'), 'a label cannot be removed and used at once');
  });

  withStore('boxes need image bytes, not just an Image type, and are validated as stored', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'P', task: 'Spot tears', modalities: ['Images'], startingPoint: 'own' });
    const where = { workspaceId: ws.id, projectId: p.id };
    await store.setLabelSet({ ...where, labelSet: [{ id: 'b', name: 'tear', scope: 'box', tone: 'orange' }] });
    const file = (key, contentType, filename) => store.createUpload({ ...where, uploadedBy: owner.id, objectKey: key, sha256: key.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a'), sizeBytes: 9, contentType, filename });
    const text = await file('t1', 'text/plain', 'notes.txt');
    const csv = await file('c1', 'text/csv', 'readings.csv');
    const png = await file('p1', 'image/png', 'carton.png');
    const box = (uploadId, b) => store.createAnnotation({ ...where, uploadId, labelId: 'b', box: b, createdBy: owner.id });

    // A type set by hand describes meaning (CSV readings are sensor data) but cannot claim image content.
    await assert.rejects(store.updateUpload({ ...where, uploadId: text.id, patch: { kind: 'image' } }), (err) => err.code === 'invalid_kind' && /text\/plain/.test(err.message));
    assert.equal((await store.updateUpload({ ...where, uploadId: csv.id, patch: { kind: 'sensor' } })).kind, 'sensor');
    await assert.rejects(box(text.id, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), (err) => err.code === 'invalid_label' && /not an image/.test(err.message));
    // Real image bytes typed as something else: the box waits until the type is Image again.
    await store.updateUpload({ ...where, uploadId: png.id, patch: { kind: 'file' } });
    await assert.rejects(box(png.id, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), (err) => err.code === 'invalid_label' && /back to Image/.test(err.message));
    await store.updateUpload({ ...where, uploadId: png.id, patch: { kind: null } });

    // Geometry is checked on the rounded values that are stored.
    for (const bad of [{ x: 0.1, y: 0.1, w: 0.0000001, h: 0.2 }, { x: 0.1, y: 0.1, w: 0.2, h: 0.0004 }, { x: 0.1, y: 0.1, w: 0.0009, h: 0.2 },
      { x: 0.9, y: 0, w: 0.2, h: 0.2 }, { x: -0.000001, y: 0, w: 0.5, h: 0.5 }, { x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 0.5 }, { x: '0.1', y: 0, w: 0.5, h: 0.5 }, null]) {
      await assert.rejects(box(png.id, bad), { code: 'invalid_label' }, JSON.stringify(bad));
    }
    assert.deepEqual((await box(png.id, { x: 0, y: 0, w: 1, h: 1 })).box, { x: 0, y: 0, w: 1, h: 1 });
    assert.ok(Object.is((await box(png.id, { x: -0.0000001, y: 0, w: 0.5, h: 0.5 })).box.x, 0), 'a value that rounds to 0 is stored as 0, never -0');
    assert.deepEqual((await box(png.id, { x: 0.1, y: 0.2, w: 0.001, h: 0.001 })).box, { x: 0.1, y: 0.2, w: 0.001, h: 0.001 }, 'the smallest allowed box');
    // Rounding at the edge can overrun 1 by one step; that is inside the stored tolerance and accepted by both stores.
    assert.deepEqual((await box(png.id, { x: 0.3333335, y: 0, w: 0.6666665, h: 1 })).box, { x: 0.333334, y: 0, w: 0.666667, h: 1 });
    const ok = await box(png.id, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
    await assert.rejects(store.updateAnnotation({ ...where, annotationId: ok.id, patch: { box: { x: 0.25, y: 0.5, w: 0.0000001, h: 0.25 } } }), { code: 'invalid_label' });
    await assert.rejects(store.updateAnnotation({ ...where, annotationId: ok.id, patch: { box: { x: 0.25, y: 0.5, w: 0.8, h: 0.25 } } }), { code: 'invalid_label' });
    assert.deepEqual((await store.updateAnnotation({ ...where, annotationId: ok.id, patch: { box: { x: 0.1234564, y: 0.5, w: 0.2, h: 0.25 } } })).box, { x: 0.123456, y: 0.5, w: 0.2, h: 0.25 });
  });

  withStore('review needs an acceptance rule, checked by the store in the submit transaction', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    for (const dataSource of [{ mode: 'upload', provenance: 'ours' }, { mode: 'license', query: 'retail shelf images' }]) {
      const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: dataSource.mode, task: 'Spot tears', modalities: ['Images'], startingPoint: dataSource.mode === 'upload' ? 'own' : 'need' });
      const where = { workspaceId: ws.id, projectId: p.id };
      await store.updateProject({ ...where, patch: { dataSource } });
      if (dataSource.mode === 'upload') {
        await store.setLabelSet({ ...where, labelSet: [{ id: 'ok', name: 'ok', scope: 'file', tone: 'plain' }] });
        const file = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: `${p.id}-f`, sha256: 'a'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'a.png' });
        await store.createAnnotation({ ...where, uploadId: file.id, labelId: 'ok', createdBy: owner.id });
      }
      await assert.rejects(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open === 1, `${dataSource.mode}: no rule`);
      assert.equal((await store.getProject(where)).status, 'draft');
      await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%', baseline: 'current' } } });
      assert.equal((await store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true })).status, 'pending', `${dataSource.mode}: with a rule`);
    }
  });

  withStore('a stored rule that bypassed the API blocks review in every data mode until it is complete', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    // The store saves what it is given; only the API normalizes. These are rules an older or direct write could leave.
    const legacy = [
      { measure: 'recall', target: '   ' }, { measure: 'data_quality', criteria: ' \n ' }, { measure: 'data_quality', criteria: { empty: true } },
      { measure: 'precision', target: [] }, { measure: 'unknown', target: '95%' }, { measure: 'rubric', criteria: 'x'.repeat(1001) },
    ];
    const modes = [{ mode: 'upload', provenance: 'ours' }, { mode: 'license', query: 'retail shelf images' }, { mode: 'commission', brief: 'Collect shelf photos' }];
    for (const dataSource of modes) {
      const p = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: dataSource.mode, task: 'Spot tears', modalities: ['Images'], startingPoint: dataSource.mode === 'upload' ? 'own' : 'need' });
      const where = { workspaceId: ws.id, projectId: p.id };
      await store.updateProject({ ...where, patch: { dataSource } });
      if (dataSource.mode === 'upload') {
        await store.setLabelSet({ ...where, labelSet: [{ id: 'ok', name: 'ok', scope: 'file', tone: 'plain' }] });
        const file = await store.createUpload({ ...where, uploadedBy: owner.id, objectKey: `${p.id}-f`, sha256: 'b'.repeat(64), sizeBytes: 5, contentType: 'image/png', filename: 'a.png' });
        await store.createAnnotation({ ...where, uploadId: file.id, labelId: 'ok', createdBy: owner.id });
      }
      for (const success of legacy) {
        await store.updateProject({ ...where, patch: { success } });
        await assert.rejects(store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true }), (err) => err.code === 'issues_open' && err.open === 1, `${dataSource.mode}: ${JSON.stringify(success).slice(0, 60)}`);
        const stored = await store.getProject(where);
        assert.equal(stored.status, 'draft');
        assert.deepEqual(stored.success, success, 'the gate reads the rule; it does not rewrite it');
      }
      await store.updateProject({ ...where, patch: { success: { measure: 'data_quality', target: null, criteria: 'Every image has a box for each tear' } } });
      assert.equal((await store.submitForReview({ ...where, submittedBy: owner.id, requireResolved: true })).status, 'pending', `${dataSource.mode}: once complete`);
    }
  });

  withStore('model pulls are one per workspace and model; enhance runs freeze once requested', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    // The store records any well-formed model id; whether it is in the catalog is the route's concern.
    const first = await store.requestModelPull({ workspaceId: ws.id, modelId: 'example-base', requestedBy: owner.id });
    assert.equal(first.status, 'requested');
    assert.equal((await store.requestModelPull({ workspaceId: ws.id, modelId: 'example-base', requestedBy: owner.id })).id, first.id);
    assert.equal((await store.listModelPulls(ws.id)).length, 1);
    assert.equal((await store.listModelPulls(other.id)).length, 0);

    const plan = { name: 'returns-assistant', baseModelId: 'example-base', datasets: [], steps: ['sft'], compute: null, spendCapUsd: null };
    const run = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: plan });
    assert.equal(run.status, 'draft');
    assert.equal(await store.getEnhanceRun({ workspaceId: other.id, runId: run.id }), null, 'scoped to its workspace');
    await assert.rejects(store.updateEnhanceRun({ workspaceId: other.id, runId: run.id, run: plan }), { code: 'not_found' });
    await assert.rejects(store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id, expectedUpdatedAt: run.updatedAt }), { code: 'invalid_state' }, 'an incomplete plan cannot be requested');
    const complete = { ...plan, datasets: [{ projectId: ws.id, version: 1 }], steps: ['sft', 'grpo'], compute: 'nebius', spendCapUsd: 250 };
    const reviewed = await store.updateEnhanceRun({ workspaceId: ws.id, runId: run.id, run: complete });
    assert.deepEqual(reviewed.steps, ['sft', 'grpo']);
    // Someone raises the cap after the approver opened the plan: approving the old version must fail, not freeze the new cap.
    const raised = await store.updateEnhanceRun({ workspaceId: ws.id, runId: run.id, run: { ...complete, spendCapUsd: 9000 } });
    assert.notEqual(raised.updatedAt, reviewed.updatedAt, 'every edit is a new version');
    await assert.rejects(store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id, expectedUpdatedAt: reviewed.updatedAt }), { code: 'stale_plan' });
    await assert.rejects(store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id }), { code: 'stale_plan' }, 'an approval must name the version it approves');
    assert.equal((await store.getEnhanceRun({ workspaceId: ws.id, runId: run.id })).status, 'draft');
    const current = await store.updateEnhanceRun({ workspaceId: ws.id, runId: run.id, run: complete });
    const requested = await store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id, expectedUpdatedAt: current.updatedAt });
    assert.equal(requested.status, 'requested');
    assert.equal(requested.requestedBy, owner.id);
    assert.ok(requested.requestedAt);
    await assert.rejects(store.updateEnhanceRun({ workspaceId: ws.id, runId: run.id, run: { ...complete, spendCapUsd: 9999 } }), { code: 'invalid_state' });
    await assert.rejects(store.requestEnhanceRun({ workspaceId: ws.id, runId: run.id, requestedBy: owner.id, expectedUpdatedAt: requested.updatedAt }), { code: 'invalid_state' });
    assert.equal((await store.getEnhanceRun({ workspaceId: ws.id, runId: run.id })).spendCapUsd, 250);
    assert.equal((await store.listEnhanceRuns(ws.id)).length, 1);
    assert.ok((await store.listAudit(ws.id)).some((e) => e.action === 'enhance_run.requested'));
  });

  withStore('devices belong to one person in one workspace; revoked devices accept no new records', async (store) => {
    const alice = await store.createUser({ email: 'a@acme.com', name: 'A', passwordHash: 'h' });
    const bob = await store.createUser({ email: 'b@acme.com', name: 'B', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: alice.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: alice.id });
    const device = await store.createDevice({ workspaceId: ws.id, ownerId: alice.id, label: 'Work laptop' });
    const mine = { workspaceId: ws.id, ownerId: alice.id, deviceId: device.id };
    assert.equal(device.status, 'active');
    assert.equal(device.latestReport, null);
    // Another person, or the same person in another workspace, cannot see or use it.
    for (const where of [{ ...mine, ownerId: bob.id }, { ...mine, workspaceId: other.id }]) {
      assert.equal(await store.getDevice(where), null);
      assert.deepEqual(await store.listModelInstalls(where), []);
      assert.deepEqual(await store.listExecutionRuns(where), []);
      await assert.rejects(store.recordDeviceReport({ ...where, report: { reachable: false, runtimeVersion: null, models: [], running: [], browser: {} } }), { code: 'not_found' });
      await assert.rejects(store.revokeDevice(where), { code: 'not_found' });
    }
    assert.deepEqual(await store.listDevices({ workspaceId: ws.id, ownerId: bob.id }), []);

    const report = await store.recordDeviceReport({ ...mine, report: { reachable: true, runtimeVersion: '0.40.13', models: [{ name: 'demo-chat:0.6b', digest: 'a'.repeat(64), sizeBytes: 522653767 }], running: [], browser: { hardwareConcurrency: 16 } } });
    assert.equal(report.provenance, 'client_reported');
    const listed = (await store.listDevices({ workspaceId: ws.id, ownerId: alice.id }))[0];
    assert.equal(listed.latestReport.runtimeVersion, '0.40.13');
    assert.equal(listed.lastSeenAt, report.createdAt);

    const install = { runtimeRef: 'demo-chat:0.6b', catalogId: 'demo-chat-0.6b', digest: 'a'.repeat(64), sizeBytes: 522653767, details: { family: 'demo' }, failure: null };
    const installed = await store.saveModelInstall({ ...mine, install: { ...install, state: 'installed' } });
    assert.equal(installed.verifiedAt, null);
    const verified = await store.saveModelInstall({ ...mine, install: { ...install, state: 'verified' } });
    assert.equal(verified.id, installed.id, 'one row per model reference on a device');
    assert.ok(verified.verifiedAt);
    assert.equal((await store.saveModelInstall({ ...mine, install: { ...install, state: 'ready' } })).verifiedAt, verified.verifiedAt, 'the same digest keeps its verification');
    const removed = await store.saveModelInstall({ ...mine, install: { ...install, state: 'removed' } });
    assert.equal(removed.verifiedAt, null);
    const actions = (await store.listAudit(ws.id)).map((e) => e.action);
    for (const a of ['device.registered', 'model_install.installed', 'model_install.verified', 'model_install.ready', 'model_install.removed']) assert.ok(actions.includes(a), a);

    const run = { installId: installed.id, modelRef: 'demo-chat:0.6b', modelDigest: 'a'.repeat(64), location: 'local_runtime', kind: 'compat_test', warm: false, status: 'completed', failure: null, settings: { numCtx: 2048 }, metrics: { wallMs: 812, outputTokens: 3, evalMs: 40 }, task: { id: 'arithmetic', passed: true }, promptSha256: null };
    const recorded = await store.recordExecutionRun({ ...mine, run });
    assert.equal(recorded.provenance, 'client_reported');
    assert.deepEqual(recorded.task, { id: 'arithmetic', passed: true });
    const foreign = await store.createDevice({ workspaceId: ws.id, ownerId: bob.id, label: 'Bob' });
    const bobInstall = await store.saveModelInstall({ workspaceId: ws.id, ownerId: bob.id, deviceId: foreign.id, install: { ...install, state: 'installed' } });
    await assert.rejects(store.recordExecutionRun({ ...mine, run: { ...run, installId: bobInstall.id } }), { code: 'not_found' }, 'a run cannot cite another device’s install');
    assert.equal((await store.listExecutionRuns(mine)).length, 1);

    const revoked = await store.revokeDevice(mine);
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revokedAt);
    await assert.rejects(store.revokeDevice(mine), { code: 'invalid_state' });
    await assert.rejects(store.recordExecutionRun({ ...mine, run }), { code: 'invalid_state' });
    await assert.rejects(store.saveModelInstall({ ...mine, install: { ...install, state: 'installed' } }), { code: 'invalid_state' });
    assert.equal((await store.listExecutionRuns(mine)).length, 1, 'history is kept after revocation');
  });

  withStore('capital cases: revisioned drafts, idempotent submission, frozen revisions, append-only credits, scoped evidence', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Acme', slug: 'acme', ownerId: owner.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'other', ownerId: owner.id });
    const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Chats', task: 'Answer', modalities: ['Text'], startingPoint: 'own' });
    const foreign = await store.createProject({ workspaceId: other.id, createdBy: owner.id, name: 'Theirs', task: 'Answer', modalities: ['Text'], startingPoint: 'own' });
    await assert.rejects(store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Pilot', projectId: foreign.id, draft: emptyDraft() }), { code: 'not_found' }, 'a project of another workspace cannot be linked');
    const kase = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Pilot', projectId: project.id, draft: emptyDraft() });
    assert.deepEqual([kase.status, kase.revision, kase.submittedRevision, kase.projectId], ['draft', 1, null, project.id]);
    const mine = { workspaceId: ws.id, caseId: kase.id };
    assert.equal(await store.getCapitalCase({ workspaceId: other.id, caseId: kase.id }), null, 'scoped to its workspace');
    await assert.rejects(store.updateCapitalCase({ workspaceId: other.id, caseId: kase.id, expectedRevision: 1, title: 'x', draft: emptyDraft() }), { code: 'not_found' });
    await assert.rejects(store.updateCapitalCase({ ...mine, expectedRevision: 2, title: 'x', draft: emptyDraft() }), { code: 'stale_revision' });
    const item = { id: 'ci_1', category: 'compute', label: 'GPU hours', amountCents: 250000, period: 'one_time', basis: 'estimated', source: 'Price list', observedAt: '2026-11-01', evidenceId: null };
    const complete = { ...emptyDraft(), purpose: 'Pilot', requestedAmountCents: 5000000, costItems: [item] };
    // The hash of exactly what sending would freeze, computed from the same reads a route makes.
    const hashNow = async () => snapshotHash(capitalSnapshot(await store.getCapitalCase(mine), await store.listCreditRecords(ws.id), await store.listCapitalEvidence(mine)));
    const edited = await store.updateCapitalCase({ ...mine, expectedRevision: 1, title: 'Pilot', projectId: project.id, draft: { ...emptyDraft(), costItems: [item] } });
    assert.equal(edited.revision, 2);
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 2, contentHash: await hashNow() }), { code: 'invalid_state' }, 'an incomplete draft cannot be sent');
    assert.equal((await store.updateCapitalCase({ ...mine, expectedRevision: 2, title: 'Pilot', projectId: project.id, draft: complete })).revision, 3);
    // References are checked on the locked row: an incurred item must cite evidence that exists, a link a version that exists.
    const dangling = { ...complete, costItems: [{ ...item, basis: 'incurred', evidenceId: '00000000-0000-4000-8000-000000000000' }] };
    await assert.rejects(store.updateCapitalCase({ ...mine, expectedRevision: 3, title: 'Pilot', projectId: project.id, draft: dangling }), { code: 'missing_reference' });
    await assert.rejects(store.updateCapitalCase({ ...mine, expectedRevision: 3, title: 'Pilot', projectId: project.id, draft: { ...complete, datasetVersions: [{ projectId: project.id, version: 9 }] } }), { code: 'missing_reference' });
    assert.equal((await store.getCapitalCase(mine)).revision, 3, 'a refused save changes nothing');
    const credit = await store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'claimed', amountCents: 1000000, expiresOn: '2027-06-30', restrictions: 'Compute only', reference: '' } });
    const evidence = await store.addCapitalEvidence({ ...mine, createdBy: owner.id, item: { kind: 'company_record', title: 'Statement', source: 'Held by the company', reference: {}, verification: 'unverified' } });
    assert.deepEqual(await store.listCapitalEvidence({ workspaceId: other.id, caseId: kase.id }), []);
    await assert.rejects(store.deleteCapitalEvidence({ workspaceId: other.id, caseId: kase.id, evidenceId: evidence.id }), { code: 'not_found' });
    const cited = { ...complete, costItems: [item, { ...item, id: 'ci_2', basis: 'incurred', amountCents: 5, evidenceId: evidence.id }] };
    assert.equal((await store.updateCapitalCase({ ...mine, expectedRevision: 3, title: 'Pilot', projectId: project.id, draft: cited })).revision, 4);
    await assert.rejects(store.deleteCapitalEvidence({ ...mine, evidenceId: evidence.id }), { code: 'evidence_in_use' }, 'a cited record cannot be removed from under the plan');
    assert.equal((await store.updateCapitalCase({ ...mine, expectedRevision: 4, title: 'Pilot', projectId: project.id, draft: complete })).revision, 5);

    // Consent binds the revision and the content: a hash of anything else is stale, even for the right revision.
    const consented = await hashNow();
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 4, contentHash: consented }), { code: 'stale_revision' });
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: 'f'.repeat(64) }), (err) => err.code === 'stale_revision' && err.message === 'content');
    await store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Other', status: 'claimed', amountCents: 1, expiresOn: null, restrictions: '', reference: '' } });
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: consented }), (err) => err.code === 'stale_revision' && err.message === 'content', 'a credit record added since the owner looked makes the send stale');
    assert.equal((await store.listCapitalSubmissions(mine)).length, 0, 'nothing was sent');
    const fresh = await hashNow();
    const sub = await store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: fresh });
    assert.deepEqual([sub.revision, sub.decision, sub.caseId, sub.contentHash], [5, null, kase.id, fresh]);
    assert.equal(sub.snapshot.draft.requestedAmountCents, 5000000);
    assert.deepEqual(sub.snapshot.totals.estimated, { one_time: 250000, monthly: 0, annual: 0 });
    assert.equal(sub.snapshot.credits.length, 2);
    assert.deepEqual(sub.snapshot.evidence.map((e) => e.id), [evidence.id]);
    assert.equal(snapshotHash(sub.snapshot), fresh, 'the frozen snapshot is exactly the consented content');
    const submitted = await store.getCapitalCase(mine);
    assert.deepEqual([submitted.status, submitted.submittedRevision], ['submitted', 5]);
    assert.equal((await store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: fresh })).id, sub.id, 'a retry returns the same submission');
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: consented }), { code: 'stale_revision' }, 'a retry with other content is not a retry');
    assert.equal((await store.listCapitalSubmissions(mine)).length, 1);
    assert.deepEqual(await store.listCapitalSubmissions({ workspaceId: other.id, caseId: kase.id }), []);
    await assert.rejects(store.updateCapitalCase({ ...mine, expectedRevision: 5, title: 'x', draft: complete }), { code: 'invalid_state' });
    await assert.rejects(store.addCapitalEvidence({ ...mine, createdBy: owner.id, item: { kind: 'company_record', title: 'Late', source: 'x', reference: {}, verification: 'unverified' } }), { code: 'invalid_state' });
    await assert.rejects(store.deleteCapitalEvidence({ ...mine, evidenceId: evidence.id }), { code: 'invalid_state' });

    // Staff see the frozen submission only, and act on the one they name.
    const queued = await store.listCapitalCasesForReview({ status: 'submitted' });
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].title, queued[0].draft, queued[0].latestSubmission.id], [undefined, undefined, sub.id]);
    // A workspace-scoped queue (demo-scoped staff) holds that workspace's rows and nothing else.
    assert.deepEqual((await store.listCapitalCasesForReview({ status: 'submitted', workspaceId: ws.id })).map((c) => c.id), [kase.id]);
    assert.deepEqual(await store.listCapitalCasesForReview({ status: 'submitted', workspaceId: other.id }), []);
    assert.deepEqual(await store.listCapitalCasesForReview({ status: 'submitted', workspaceId: 'not-an-id' }), []);
    const found = await store.getCapitalCaseForReview(kase.id);
    assert.equal(found.workspace.name, 'Acme');
    assert.equal(found.submission.id, sub.id);
    assert.deepEqual([found.case.title, found.case.draft, found.evidence, found.credits, found.marks], [undefined, undefined, undefined, undefined, []]);
    await assert.rejects(store.decideCapitalSubmission({ caseId: kase.id, submissionId: sub.id, reviewerId: owner.id, decision: 'approved' }), { code: 'invalid_state' }, 'there is no approval');
    await assert.rejects(store.decideCapitalSubmission({ caseId: kase.id, submissionId: kase.id, reviewerId: owner.id, decision: 'changes_requested', notes: 'x' }), { code: 'stale_revision' }, 'a decision names the submission seen');
    await assert.rejects(store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: kase.id, evidenceId: evidence.id, reviewerId: owner.id }), { code: 'stale_revision' });
    await assert.rejects(store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: sub.id, evidenceId: credit.id, reviewerId: owner.id }), { code: 'not_found' }, 'only evidence frozen in that submission can be marked');
    const mark = await store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: sub.id, evidenceId: evidence.id, reviewerId: owner.id });
    assert.deepEqual([mark.submissionId, mark.evidenceId, mark.reviewerId], [sub.id, evidence.id, owner.id]);
    assert.equal((await store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: sub.id, evidenceId: evidence.id, reviewerId: owner.id })).id, mark.id, 'one mark per record and submission');
    assert.deepEqual((await store.listCapitalReviewMarks(mine)).map((m) => m.id), [mark.id]);
    assert.deepEqual(await store.listCapitalReviewMarks({ workspaceId: other.id, caseId: kase.id }), []);
    assert.equal((await store.listCapitalEvidence(mine))[0].verification, 'unverified', 'the customer’s record is not edited by a mark');
    const decided = await store.decideCapitalSubmission({ caseId: kase.id, submissionId: sub.id, reviewerId: owner.id, decision: 'changes_requested', notes: 'Add a quote.' });
    assert.deepEqual([decided.decision, decided.notes, decided.decidedBy], ['changes_requested', 'Add a quote.', owner.id]);
    assert.equal((await store.getCapitalCase(mine)).status, 'changes_requested');
    await assert.rejects(store.decideCapitalSubmission({ caseId: kase.id, submissionId: sub.id, reviewerId: owner.id, decision: 'evidence_reviewed' }), { code: 'invalid_state' });
    await assert.rejects(store.markCapitalEvidenceReviewed({ caseId: kase.id, submissionId: sub.id, evidenceId: evidence.id, reviewerId: owner.id }), { code: 'invalid_state' });
    await assert.rejects(store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 5, contentHash: fresh }), { code: 'invalid_state' }, 'the same revision is sent once');
    assert.equal((await store.updateCapitalCase({ ...mine, expectedRevision: 5, title: 'Pilot', projectId: project.id, draft: complete })).revision, 6);
    const second = await store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 6, contentHash: await hashNow() });
    assert.equal(second.revision, 6);
    assert.deepEqual((await store.getCapitalCaseForReview(kase.id)).marks, [], 'marks stay with the submission they were made on');
    await assert.rejects(store.withdrawCapitalCase({ workspaceId: other.id, caseId: kase.id, actorId: owner.id }), { code: 'not_found' });
    const withdrawn = await store.withdrawCapitalCase({ ...mine, actorId: owner.id });
    assert.deepEqual([withdrawn.status, withdrawn.revision, withdrawn.submittedRevision], ['draft', 7, 6]);
    assert.deepEqual((await store.listCapitalSubmissions(mine)).map((s) => s.decision), ['changes_requested', 'withdrawn']);
    await assert.rejects(store.withdrawCapitalCase({ ...mine, actorId: owner.id }), { code: 'invalid_state' });
    await assert.rejects(store.decideCapitalSubmission({ caseId: kase.id, submissionId: second.id, reviewerId: owner.id, decision: 'evidence_reviewed' }), { code: 'invalid_state' }, 'a withdrawn submission is decided by nobody');
    assert.equal((await store.listCapitalCasesForReview({ status: 'submitted' })).length, 0);
    assert.equal((await store.deleteCapitalEvidence({ ...mine, evidenceId: evidence.id })).id, evidence.id);

    const corrected = await store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'evidenced', amountCents: 900000, expiresOn: null, restrictions: '', reference: 'CONF-1' }, supersedes: credit.id });
    assert.equal(corrected.supersedes, credit.id);
    await assert.rejects(store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'withdrawn', amountCents: 0, expiresOn: null, restrictions: '', reference: '' }, supersedes: credit.id }), { code: 'invalid_state' }, 'one correction per record');
    await assert.rejects(store.createCreditRecord({ workspaceId: other.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'claimed', amountCents: 1, expiresOn: null, restrictions: '', reference: '' }, supersedes: credit.id }), { code: 'not_found' });
    const credits = await store.listCreditRecords(ws.id);
    assert.deepEqual(credits.map((c) => [c.amountCents, c.supersededBy]), [[1000000, corrected.id], [1, null], [900000, null]]);
    assert.equal(credits[0].expiresOn, '2027-06-30');
    assert.deepEqual(await store.listCreditRecords(other.id), []);
    assert.equal((await store.listCapitalSubmissions(mine))[0].snapshot.credits.find((c) => c.id === credit.id).amountCents, 1000000, 'a frozen snapshot keeps the record as it was');
    const actions = (await store.listAudit(ws.id)).map((e) => e.action);
    for (const a of ['capital_case.created', 'capital.submitted', 'capital.changes_requested', 'capital.evidence_item_reviewed', 'capital.withdrawn', 'credit_record.created', 'credit_record.corrected']) assert.ok(actions.includes(a), a);
  });

  withStore('reviewer accounts are separate from customer users and never expose hashes', async (store) => {
    await store.upsertReviewer({ username: 'YCInsider', name: 'YC reviewer', role: 'viewer', passwordHash: 'scrypt$a' });
    await store.upsertReviewer({ username: 'admin', name: 'Admin', role: 'admin', passwordHash: 'scrypt$b' });
    assert.equal(await store.getUserAuthByEmail('ycinsider'), null);
    const auth = await store.getReviewerAuth('ycinsider');
    assert.deepEqual([auth.account.username, auth.account.role, auth.account.enabled, auth.passwordHash], ['ycinsider', 'viewer', true, 'scrypt$a']);
    assert.equal((await store.getReviewer('ycinsider')).passwordHash, undefined);
    // Updating without a new hash keeps the existing one.
    await store.upsertReviewer({ username: 'ycinsider', name: 'YC', role: 'admin' });
    assert.equal((await store.getReviewerAuth('ycinsider')).passwordHash, 'scrypt$a');
    assert.equal((await store.getReviewer('ycinsider')).role, 'admin');
    assert.equal((await store.setReviewerEnabled({ username: 'ycinsider', enabled: false })).enabled, false);
    await assert.rejects(store.setReviewerEnabled({ username: 'ghost', enabled: true }), { code: 'not_found' });
    await assert.rejects(store.upsertReviewer({ username: 'ghost', name: 'G', role: 'viewer' }), { code: 'not_found' }, 'a new reviewer needs a hash');
    assert.deepEqual((await store.listReviewers()).map((r) => r.username), ['admin', 'ycinsider']);
    assert.equal(await store.getReviewer('nobody'), null);
  });

  withStore('projects are only reachable through their own workspace', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const a = await store.createWorkspace({ kind: 'organization', name: 'A', slug: 'a', ownerId: owner.id });
    const b = await store.createWorkspace({ kind: 'organization', name: 'B', slug: 'b', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: a.id, createdBy: owner.id, name: 'Defects', task: 'Spot damaged boxes', modalities: ['Images'], startingPoint: 'own' });
    assert.equal(p.status, 'draft');
    assert.equal(p.model, null);
    assert.deepEqual(p.modalities, ['Images']);
    const withModel = await store.updateProject({ workspaceId: a.id, projectId: p.id, patch: { model: { source: 'hub', hubId: 'org/model', rightsConfirmed: true } } });
    assert.deepEqual(withModel.model, { source: 'hub', hubId: 'org/model', rightsConfirmed: true });
    assert.deepEqual((await store.getProject({ workspaceId: a.id, projectId: p.id })).model.hubId, 'org/model');
    assert.equal(await store.getProject({ workspaceId: b.id, projectId: p.id }), null);
    assert.equal(await store.updateProject({ workspaceId: b.id, projectId: p.id, patch: { name: 'Hijack' } }), null);
    const updated = await store.updateProject({ workspaceId: a.id, projectId: p.id, patch: { success: { measure: 'recall', target: '95%' }, setupStep: 'data', id: 'ignored', workspaceId: b.id } });
    assert.equal(updated.success.target, '95%');
    assert.equal(updated.id, p.id);
    assert.equal(updated.workspaceId, a.id);
    assert.equal((await store.listProjects(a.id)).length, 1);
    assert.equal((await store.listProjects(b.id)).length, 0);
  });

  withStore('runners and jobs: keys stay hidden, one lease per runner, events once, bounded retries, cancel and revoke', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'A', slug: 'a-jobs', ownerId: owner.id });
    const other = await store.createWorkspace({ kind: 'organization', name: 'B', slug: 'b-jobs', ownerId: owner.id });
    const hash = (c) => c.repeat(64);
    const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: hash('a'), keyPrefix: 'vrk_abcdef' });
    assert.equal(runner.keyHash, undefined);
    assert.deepEqual([runner.status, runner.lastSeenAt, runner.capabilities], ['active', null, {}]);
    assert.equal((await store.findActiveRunnerByKeyHash(hash('a'))).id, runner.id);
    assert.equal(await store.findActiveRunnerByKeyHash(hash('b')), null);
    assert.equal(await store.getRunner({ workspaceId: other.id, runnerId: runner.id }), null);
    assert.ok((await store.reportRunner({ runnerId: runner.id, capabilities: { gpus: [] } })).lastSeenAt);

    // A plan can be approved to run on the workspace's own runner (migration 014 widens the compute check).
    const draft = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'r', baseModelId: 'example-base', datasets: [{ projectId: ws.id, version: 1 }], steps: ['sft'], compute: 'runner', spendCapUsd: 1 } });
    const plan = await store.requestEnhanceRun({ workspaceId: ws.id, runId: draft.id, requestedBy: owner.id, expectedUpdatedAt: draft.updatedAt });
    assert.deepEqual([plan.compute, plan.status], ['runner', 'requested']);
    const trainJob = await store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'train', enhanceRunId: plan.id, spec: { plan: {} }, idempotencyKey: 'key-train-0001', createdBy: owner.id });
    assert.equal(trainJob.enhanceRunId, plan.id);
    await store.cancelJob({ workspaceId: ws.id, jobId: trainJob.id, actorId: owner.id });

    const mk = (key, extra = {}) => store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: key, createdBy: owner.id, ...extra });
    const job = await mk('key-00000001');
    assert.equal((await mk('key-00000001')).id, job.id, 'same request key, same job');
    await assert.rejects(store.createJob({ workspaceId: other.id, runnerId: runner.id, kind: 'probe', spec: {}, idempotencyKey: 'key-00000002', createdBy: owner.id }), { code: 'not_found' });

    const lease = (h, leaseMs) => store.leaseJob({ runnerId: runner.id, leaseHash: h, leaseMs });
    const held = await lease(hash('1'));
    assert.deepEqual([held.id, held.status, held.attempt, held.spec.checks[0]], [job.id, 'leased', 1, 'gpu']);
    assert.equal(held.leaseHash, undefined);
    await mk('key-00000003');
    assert.equal(await lease(hash('2')), null, 'one job at a time');
    const who = { runnerId: runner.id, jobId: job.id, leaseHash: hash('1') };
    await assert.rejects(store.touchJob({ ...who, leaseHash: hash('9') }), { code: 'lease_lost' });
    assert.equal((await store.touchJob(who)).status, 'running');
    const events = [{ seq: 0, kind: 'log', data: { level: 'info', message: 'a' } }, { seq: 1, kind: 'log', data: { level: 'info', message: 'b' } }];
    assert.equal((await store.appendJobEvents({ ...who, events })).added, 2);
    assert.equal((await store.appendJobEvents({ ...who, events })).added, 0);
    assert.deepEqual((await store.listJobEvents({ workspaceId: ws.id, jobId: job.id })).map((e) => [e.attempt, e.seq, e.data.message]), [[1, 0, 'a'], [1, 1, 'b']]);
    assert.deepEqual(await store.listJobEvents({ workspaceId: other.id, jobId: job.id }), []);
    // Retryable failure: back to the queue, a new attempt, a separate event sequence.
    assert.equal((await store.finishJob({ ...who, outcome: 'failed', failure: 'out_of_memory', retryable: true })).status, 'queued');
    const again = await lease(hash('3'));
    assert.deepEqual([again.id, again.attempt], [job.id, 2]);
    await store.appendJobEvents({ runnerId: runner.id, jobId: job.id, leaseHash: hash('3'), events: [events[0]] });
    assert.equal((await store.listJobEvents({ workspaceId: ws.id, jobId: job.id })).length, 3);
    const done = await store.finishJob({ runnerId: runner.id, jobId: job.id, leaseHash: hash('3'), outcome: 'succeeded', result: { ok: true } });
    assert.deepEqual([done.status, done.result, done.leaseExpiresAt, Boolean(done.finishedAt)], ['succeeded', { ok: true }, null, true]);
    await assert.rejects(store.finishJob({ runnerId: runner.id, jobId: job.id, leaseHash: hash('3'), outcome: 'succeeded', result: {} }), { code: 'lease_lost' });
    await assert.rejects(store.cancelJob({ workspaceId: ws.id, jobId: job.id, actorId: owner.id }), { code: 'invalid_state' });

    // An expired lease is retried until attempts run out, then fails as lease_expired.
    const lost = (await store.listJobs({ workspaceId: ws.id })).find((j) => j.status === 'queued');
    for (let i = 0; i < lost.maxAttempts; i += 1) {
      assert.equal((await lease(hash(String(4 + i)), 1)).id, lost.id);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const expired = await store.getJob({ workspaceId: ws.id, jobId: lost.id });
    assert.deepEqual([expired.status, expired.failure, expired.attempt], ['failed', 'lease_expired', lost.maxAttempts]);

    // Cancel while running is honoured when the runner reports; revoke fails a held job and cancels waiting ones.
    const c1 = await mk('key-00000010');
    await lease(hash('c'));
    assert.equal((await store.cancelJob({ workspaceId: ws.id, jobId: c1.id, actorId: owner.id })).status, 'cancel_requested');
    assert.equal((await store.touchJob({ runnerId: runner.id, jobId: c1.id, leaseHash: hash('c') })).status, 'cancel_requested');
    assert.equal((await store.finishJob({ runnerId: runner.id, jobId: c1.id, leaseHash: hash('c'), outcome: 'failed', failure: 'runtime_error' })).status, 'cancelled');
    const h1 = await mk('key-00000011');
    const w1 = await mk('key-00000012');
    await lease(hash('d'));
    await store.revokeRunner({ workspaceId: ws.id, runnerId: runner.id, actorId: owner.id });
    assert.deepEqual([(await store.getJob({ workspaceId: ws.id, jobId: h1.id })).failure, (await store.getJob({ workspaceId: ws.id, jobId: w1.id })).status], ['runner_revoked', 'cancelled']);
    assert.equal(await store.findActiveRunnerByKeyHash(hash('a')), null);
    await assert.rejects(store.revokeRunner({ workspaceId: ws.id, runnerId: runner.id, actorId: owner.id }), { code: 'invalid_state' });
    await assert.rejects(mk('key-00000013'), { code: 'invalid_state' });
    await assert.rejects(store.reportRunner({ runnerId: runner.id, capabilities: {} }), { code: 'invalid_state' });
    const actions = (await store.listAudit(ws.id)).map((a) => a.action);
    for (const a of ['runner.linked', 'job.created', 'job.cancel_requested', 'runner.revoked']) assert.ok(actions.includes(a), a);
  });

  // Regressions for the independent PR13 review (comment 6637458993); each failed on 6b5fbb7.
  withStore('jobs review: cancel wins over a late success, one key means one complete request, and events page', async (store) => {
    const owner = await store.createUser({ email: 'r@acme.com', name: 'R', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'R', slug: 'r-jobs', ownerId: owner.id });
    const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'a'.repeat(64), keyPrefix: 'vrk_abcdef' });
    const mk = (key, spec) => store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec, idempotencyKey: key, createdBy: owner.id });

    // Idempotency compares the whole frozen spec, key order aside, sequentially and when two requests race.
    const job = await mk('key-review-01', { checks: ['gpu'], source: { a: 1, b: 2 } });
    assert.equal((await mk('key-review-01', { source: { b: 2, a: 1 }, checks: ['gpu'] })).id, job.id);
    await assert.rejects(mk('key-review-01', { checks: ['gpu'], source: { a: 1, b: 3 } }), { code: 'invalid_state' });
    const race = await Promise.allSettled([mk('key-review-02', { checks: ['gpu'] }), mk('key-review-02', { checks: ['sandbox'] })]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'invalid_state');

    // Cancel requested, then the runner reports success: the job is cancelled and the result is not kept.
    const held = await store.leaseJob({ runnerId: runner.id, leaseHash: 'b'.repeat(64) });
    assert.equal(held.id, job.id);
    const who = { runnerId: runner.id, jobId: job.id, leaseHash: 'b'.repeat(64) };
    const events = Array.from({ length: 7 }, (_, i) => ({ seq: i, kind: 'log', data: { level: 'info', message: `e${i}` } }));
    await store.appendJobEvents({ ...who, events });
    assert.equal((await store.cancelJob({ workspaceId: ws.id, jobId: job.id, actorId: owner.id })).status, 'cancel_requested');
    const ended = await store.finishJob({ ...who, outcome: 'succeeded', result: { network: 'none' } });
    assert.deepEqual([ended.status, ended.result ?? null], ['cancelled', null]);

    // Events page by id with a limit; the next page starts after the last id.
    const page = await store.listJobEvents({ workspaceId: ws.id, jobId: job.id, limit: 4 });
    assert.deepEqual(page.map((e) => e.seq), [0, 1, 2, 3]);
    assert.deepEqual((await store.listJobEvents({ workspaceId: ws.id, jobId: job.id, afterId: page.at(-1).id, limit: 4 })).map((e) => e.seq), [4, 5, 6]);
  });

  // Regression for the exact-head review of 2afe7bd: handing a runner its inputs is one decision, made on the lease,
  // the job and the runner as they are at that moment, and recorded only when it is allowed.
  withStore('jobs review: an input release is bound to the current lease, job state and runner, and records only what it allows', async (store) => {
    const owner = await store.createUser({ email: 'i@acme.com', name: 'I', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'I', slug: 'i-jobs', ownerId: owner.id });
    const runner = await store.createRunner({ workspaceId: ws.id, createdBy: owner.id, label: 'Box', keyHash: 'a'.repeat(64), keyPrefix: 'vrk_abcdef' });
    const mk = (key) => store.createJob({ workspaceId: ws.id, runnerId: runner.id, kind: 'probe', spec: { checks: ['gpu'] }, idempotencyKey: key, createdBy: owner.id });
    const released = async () => (await store.listAudit(ws.id)).filter((a) => a.action === 'job.inputs_released');
    const job = await mk('key-inputs-0001');
    const who = { runnerId: runner.id, jobId: job.id, leaseHash: 'b'.repeat(64) };
    await assert.rejects(store.releaseJobInputs(who), { code: 'lease_lost' }, 'not before it holds the job');
    await store.leaseJob({ runnerId: runner.id, leaseHash: 'b'.repeat(64) });
    await assert.rejects(store.releaseJobInputs({ ...who, leaseHash: 'c'.repeat(64) }), { code: 'lease_lost' }, 'not with another lease');
    await assert.rejects(store.releaseJobInputs({ ...who, runnerId: ws.id }), { code: 'not_found' }, 'not for another runner');
    assert.equal((await released()).length, 0, 'a refused release records nothing');
    assert.equal((await store.releaseJobInputs({ ...who, versions: 2, files: 3 })).status, 'running', 'allowed while held, and the lease is extended');
    const [record] = await released();
    assert.deepEqual([record.actorId, record.targetType, record.targetId, record.metadata], [owner.id, 'job', job.id, { runnerId: runner.id, versions: 2, files: 3 }], 'the record carries the counts of the payload the caller prepared');

    // Once cancel is stored there is no release, though the runner still holds the job and can report.
    await store.cancelJob({ workspaceId: ws.id, jobId: job.id, actorId: owner.id });
    await assert.rejects(store.releaseJobInputs(who), { code: 'invalid_state' });
    assert.equal((await store.touchJob(who)).status, 'cancel_requested');
    assert.equal((await store.finishJob({ ...who, outcome: 'failed', failure: 'cancelled' })).status, 'cancelled');

    // A lease that ran out is refused and the job goes back to the queue; a job a revoke has failed is refused too.
    const lost = await mk('key-inputs-0002');
    const lostBy = (h) => ({ runnerId: runner.id, jobId: lost.id, leaseHash: h.repeat(64) });
    await store.leaseJob({ runnerId: runner.id, leaseHash: 'd'.repeat(64), leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await assert.rejects(store.releaseJobInputs(lostBy('d')), { code: 'lease_lost' });
    assert.equal((await store.getJob({ workspaceId: ws.id, jobId: lost.id })).status, 'queued');
    await store.leaseJob({ runnerId: runner.id, leaseHash: 'e'.repeat(64) });
    await store.revokeRunner({ workspaceId: ws.id, runnerId: runner.id, actorId: owner.id });
    await assert.rejects(store.releaseJobInputs(lostBy('e')), { code: 'lease_lost' });
    assert.deepEqual((await released()).map((a) => a.targetId), [job.id], 'only the one allowed release is on record');
  });

  async function evalReady(store, slug) {
    const owner = await store.createUser({ email: `${slug}@eval.test`, name: 'Owner', passwordHash: 'h' });
    const ws = await store.createWorkspace({ kind: 'organization', name: slug, slug, ownerId: owner.id });
    const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Support', task: 'Answer policy questions.', modalities: ['Text'], startingPoint: 'model' });
    await store.updateProject({ workspaceId: ws.id, projectId: project.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
    const review = await store.submitForReview({ workspaceId: ws.id, projectId: project.id, submittedBy: owner.id });
    await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
    const version = await store.createDatasetVersion({ workspaceId: ws.id, projectId: project.id, createdBy: owner.id });
    return { owner, ws, project, version };
  }
  const sourceOf = ({ project, version }) => ({ projectId: project.id, versionId: version.id, fileId: null });
  const evalCase = (ctx, id, extra = {}) => ({ id, input: `Question ${id}`, expectedAnswer: '30 days', reviewCriteria: 'Name the window.', category: 'returns', severity: 'major', sources: [sourceOf(ctx)], ...extra });

  withStore('evaluation imports are atomic and stay inside the workspace', async (store) => {
    const ctx = await evalReady(store, 'eval-import');
    const other = await store.createWorkspace({ kind: 'organization', name: 'Other', slug: 'eval-other', ownerId: ctx.owner.id });
    const set = await store.createEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, createdBy: ctx.owner.id, name: 'Weekday', purpose: 'development' });
    const good = `${JSON.stringify(evalCase(ctx, 'a'))}\n`;
    const imported = await store.importEvalCases({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: 1, jsonl: good });
    assert.equal(imported.cases.length, 1);
    const before = (await store.getEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id })).cases.length;
    await assert.rejects(store.importEvalCases({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: imported.revision, jsonl: `${good}${JSON.stringify(evalCase(ctx, 'b'))}\n` }), { code: 'invalid_import' });
    await assert.rejects(store.importEvalCases({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: imported.revision, jsonl: '{not json\n' }), { code: 'invalid_import' });
    assert.equal((await store.getEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id })).cases.length, before);
    assert.equal(await store.getEvalSet({ workspaceId: other.id, projectId: ctx.project.id, setId: set.id }), null);
    await assert.rejects(store.saveEvalCase({ workspaceId: other.id, projectId: ctx.project.id, setId: set.id, expectedRevision: imported.revision, input: evalCase(ctx, 'c') }), { code: 'not_found' });
  });

  withStore('a refused evaluation-set update leaves the draft and its revision unchanged', async (store) => {
    const ctx = await evalReady(store, 'eval-update');
    const where = { workspaceId: ctx.ws.id, projectId: ctx.project.id };
    const set = await store.createEvalSet({ ...where, createdBy: ctx.owner.id, name: 'Reviewed original name', purpose: 'development' });
    const before = (await store.getEvalSet({ ...where, setId: set.id })).set;
    const rule = { ...before.acceptance, minPassRate: 0.75 };
    for (const patch of [
      { name: 'Mutated although rejected', purpose: 'invalid' },
      { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: { ...rule, scoreBasis: 'guess' } },
      { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: { ...rule, minCoverage: 1.00001 } },
      { name: 'Mutated although rejected', purpose: 'final_assessment', acceptance: rule, rubricVersion: 'Rubric V2!' },
    ]) {
      await assert.rejects(store.updateEvalSet({ ...where, setId: set.id, expectedRevision: 1, patch }), { code: 'invalid_import' }, JSON.stringify(patch));
      assert.deepEqual((await store.getEvalSet({ ...where, setId: set.id })).set, before, `unchanged after ${JSON.stringify(patch)}`);
    }
    const updated = await store.updateEvalSet({ ...where, setId: set.id, expectedRevision: 1, patch: { name: 'Renamed after review', purpose: 'final_assessment', acceptance: rule, rubricVersion: 'rubric-v2' } });
    assert.deepEqual([updated.revision, updated.name, updated.purpose, updated.acceptance.minPassRate, updated.rubricVersion], [2, 'Renamed after review', 'final_assessment', 0.75, 'rubric-v2']);
    await assert.rejects(store.updateEvalSet({ ...where, setId: set.id, expectedRevision: 1, patch: { name: 'Stale' } }), { code: 'stale_revision' });
  });

  withStore('a conflict does not hide duplicates, and an acknowledgement is tied to the facts that were reviewed', async (store) => {
    const ctx = await evalReady(store, 'eval-conflict');
    const where = { workspaceId: ctx.ws.id, projectId: ctx.project.id };
    const second = await store.createProject({ workspaceId: ctx.ws.id, createdBy: ctx.owner.id, name: 'Second', task: 'Answer policy questions.', modalities: ['Text'], startingPoint: 'model' });
    await store.updateProject({ workspaceId: ctx.ws.id, projectId: second.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
    const secondReview = await store.submitForReview({ workspaceId: ctx.ws.id, projectId: second.id, submittedBy: ctx.owner.id });
    await store.decideReview({ reviewId: secondReview.id, reviewerId: ctx.owner.id, decision: 'approved', checks: {} });
    const secondVersion = await store.createDatasetVersion({ workspaceId: ctx.ws.id, projectId: second.id, createdBy: ctx.owner.id });

    const set = await store.createEvalSet({ ...where, createdBy: ctx.owner.id, name: 'Returns', purpose: 'development' });
    const state = () => store.getEvalSet({ ...where, setId: set.id });
    const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify(evalCase(ctx, `c${i}`, { input: 'Is it returnable?', expectedAnswer: i < 9 ? 'yes' : 'no', reviewCriteria: null }))).join('\n');
    await store.importEvalCases({ ...where, setId: set.id, expectedRevision: 1, jsonl: rows });
    let detail = await state();
    const conflict = detail.issues.find((issue) => issue.group === 'conflict');
    const duplicate = detail.issues.find((issue) => issue.group === 'duplicate');
    assert.deepEqual([duplicate.caseKeys.length, duplicate.acknowledgeable, conflict.caseKeys.length], [9, false, 10]);
    await assert.rejects(store.setEvalIssueNote({ ...where, setId: set.id, expectedRevision: detail.set.revision, key: duplicate.key, note: 'Fine.', createdBy: ctx.owner.id }), { code: 'invalid_state' });
    await store.setEvalIssueNote({ ...where, setId: set.id, expectedRevision: detail.set.revision, key: conflict.key, note: 'Reviewed.', createdBy: ctx.owner.id });
    detail = await state();
    assert.deepEqual(detail.issues.filter((issue) => issue.open).map((issue) => issue.group), ['duplicate']);
    await assert.rejects(store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: detail.set.revision, actorId: ctx.owner.id }), (err) => err.code === 'issues_open' && err.open === 1);
    assert.equal((await state()).set.status, 'draft');
    for (const row of detail.cases.filter((item) => !['c0', 'c9'].includes(item.caseKey))) {
      await store.deleteEvalCase({ ...where, setId: set.id, caseId: row.id, expectedRevision: (await state()).set.revision });
    }
    const openConflict = async (label) => {
      const current = await state();
      assert.deepEqual(current.issues.filter((issue) => issue.open).map((issue) => [issue.group, issue.note]), [['conflict', null]], label);
      await assert.rejects(store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: current.set.revision, actorId: ctx.owner.id }), { code: 'issues_open' }, label);
      await store.setEvalIssueNote({ ...where, setId: set.id, expectedRevision: current.set.revision, key: current.issues.find((issue) => issue.group === 'conflict').key, note: `Reviewed after ${label}.`, createdBy: ctx.owner.id });
      assert.equal((await state()).issues.filter((issue) => issue.open).length, 0, label);
    };
    const edit = async (caseKey, patch) => {
      const current = await state();
      const row = current.cases.find((item) => item.caseKey === caseKey);
      await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: current.set.revision, caseId: row.id, input: { ...row, id: caseKey, sources: row.sourceRefs, ...patch } });
    };
    await openConflict('the membership change');
    await edit('c9', { expectedAnswer: 'changed answer never reviewed' });
    await openConflict('the answer edit');
    await edit('c9', { sources: [{ projectId: second.id, versionId: secondVersion.id, fileId: null }] });
    await openConflict('the source edit');
    await edit('c0', { reviewCriteria: 'Name the window.' });
    await openConflict('the criteria edit');
    await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: (await state()).set.revision, input: evalCase(ctx, 'c10', { input: 'Is it returnable?', expectedAnswer: 'sometimes' }) });
    await openConflict('the new member');
    await edit('c0', { category: 'other' });
    const final = await state();
    assert.equal(final.issues.filter((issue) => issue.open).length, 0, 'a label that is not a fact about the answer keeps the acknowledgement');
    assert.ok(final.notes.length >= 6, 'earlier notes stay on record');
    const frozen = await store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: final.set.revision, actorId: ctx.owner.id });
    assert.deepEqual([frozen.qc.open, frozen.qc.issues.length, frozen.cases.length], [0, 1, 3]);
  });

  withStore('a frozen evaluation version, its imports and its report stay fixed', async (store) => {
    const ctx = await evalReady(store, 'eval-freeze');
    const set = await store.createEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, createdBy: ctx.owner.id, name: 'Policy', purpose: 'final_assessment' });
    const saved = await store.saveEvalCase({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: set.revision, input: evalCase(ctx, 'returns', { severity: 'critical', expectedAnswer: '30 days' }) });
    const detail = await store.getEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id });
    assert.equal(detail.issues.filter((issue) => issue.open).length, 0);
    const frozen = await store.freezeEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: detail.set.revision, actorId: ctx.owner.id });
    const again = await store.freezeEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: detail.set.revision, actorId: ctx.owner.id });
    assert.equal(again.id, frozen.id);
    await assert.rejects(store.saveEvalCase({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: detail.set.revision, caseId: saved.id, input: evalCase(ctx, 'returns', { input: 'Changed' }) }), { code: 'invalid_state' });
    const jsonl = '{"id":"returns","status":"answered","output":"30 days"}\n';
    const baseline = await store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen.id, role: 'baseline', label: 'old', claimedSystem: { identity: 'claimed-old', configuration: null }, claimedScorer: null, filename: 'a.jsonl', jsonl, importedBy: ctx.owner.id });
    const replay = await store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen.id, role: 'baseline', label: 'old', claimedSystem: {}, claimedScorer: null, filename: 'a.jsonl', jsonl, importedBy: ctx.owner.id });
    assert.equal(replay.replayed, true);
    assert.equal(replay.batch.id, baseline.batch.id);
    await assert.rejects(store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen.id, role: 'baseline', label: 'old', claimedSystem: {}, claimedScorer: null, filename: 'a.jsonl', jsonl: '{"id":"returns","status":"answered","output":"different"}\n', importedBy: ctx.owner.id }), { code: 'invalid_state' });
    await assert.rejects(store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen.id, role: 'candidate', label: 'new', claimedSystem: {}, claimedScorer: null, filename: 'b.jsonl', jsonl: '{"id":"missing","status":"answered","output":"x"}\n', importedBy: ctx.owner.id }), { code: 'invalid_import' });
    assert.equal((await store.listEvalBatches({ workspaceId: ctx.ws.id, versionId: frozen.id })).filter((batch) => batch.role === 'candidate').length, 0);
    const candidate = await store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen.id, role: 'candidate', label: 'new', claimedSystem: { identity: 'claimed-new' }, claimedScorer: 'customer-scorer', filename: 'b.jsonl', jsonl: '{"id":"returns","status":"error","error":"timeout"}\n', importedBy: ctx.owner.id });
    const comparison = await store.createEvalComparison({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, versionId: frozen.id, baselineBatchId: baseline.batch.id, candidateBatchId: candidate.batch.id, createdBy: ctx.owner.id });
    const read = await store.readEvalComparison({ workspaceId: ctx.ws.id, comparisonId: comparison.id });
    assert.equal(read.built.counts.eligible, 1);
    assert.equal(read.built.counts.candidate.failed, 1);
    assert.equal(read.built.counts.candidate.missing, 0);
    assert.equal(read.built.decision.result, 'insufficient_evidence');
    const judged = await store.recordEvalJudgment({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: comparison.revision, caseKey: 'returns', reviewerId: ctx.owner.id, patch: { baselineDecision: 'pass', candidateDecision: 'fail', adjudicationBaseline: null, adjudicationCandidate: 'human', note: 'The run timed out, so this is a failure to answer.' } });
    const preview = await store.readEvalComparison({ workspaceId: ctx.ws.id, comparisonId: comparison.id });
    assert.equal(preview.built.decision.result, 'fail');
    assert.equal(preview.built.criticalFailures[0].outcome, 'fail');
    const report = await store.approveEvalReport({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: judged.comparison.revision, contentHash: preview.contentHash, approvedBy: ctx.owner.id });
    const same = await store.approveEvalReport({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: judged.comparison.revision, contentHash: preview.contentHash, approvedBy: ctx.owner.id });
    assert.equal(same.id, report.id);
    await assert.rejects(store.approveEvalReport({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: judged.comparison.revision, contentHash: 'a'.repeat(64), approvedBy: ctx.owner.id }), { code: 'stale_revision' });
    await assert.rejects(store.approveEvalReport({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: 1, contentHash: preview.contentHash, approvedBy: ctx.owner.id }), { code: 'stale_revision' });
    assert.equal(snapshotHash(report.snapshot), report.contentHash);
    const reopened = await store.reopenEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, actorId: ctx.owner.id });
    assert.equal(reopened.revision, detail.set.revision + 1);
    await store.saveEvalCase({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: reopened.revision, caseId: saved.id, input: evalCase(ctx, 'returns', { input: 'Edited after reopen', severity: 'critical' }) });
    const kept = await store.getEvalVersion({ workspaceId: ctx.ws.id, versionId: frozen.id });
    assert.equal(kept.cases[0].input, 'Question returns');
    assert.equal(kept.contentHash, frozen.contentHash);
    assert.equal((await store.getEvalReport({ workspaceId: ctx.ws.id, reportId: report.id })).snapshot.cases[0].input, 'Question returns');
  });

  withStore('parallel freezes, imports and approvals do not duplicate evaluation rows', async (store) => {
    const ctx = await evalReady(store, 'eval-race');
    const set = await store.createEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, createdBy: ctx.owner.id, name: 'Race', purpose: 'development' });
    await store.saveEvalCase({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: 1, input: evalCase(ctx, 'a', { severity: null }) });
    const detail = await store.getEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id });
    const frozen = await Promise.all([1, 2].map(() => store.freezeEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, expectedRevision: detail.set.revision, actorId: ctx.owner.id })));
    assert.equal(frozen[0].id, frozen[1].id);
    assert.equal((await store.getEvalSet({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id })).versions.length, 1);
    const jsonl = '{"id":"a","status":"answered","output":"30 days"}\n';
    const imports = await Promise.all([1, 2].map(() => store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen[0].id, role: 'baseline', label: 'same', claimedSystem: {}, claimedScorer: null, filename: 'a.jsonl', jsonl, importedBy: ctx.owner.id })));
    assert.equal(new Set(imports.map((item) => item.batch.id)).size, 1);
    const candidate = await store.importEvalPredictions({ workspaceId: ctx.ws.id, projectId: ctx.project.id, versionId: frozen[0].id, role: 'candidate', label: 'other', claimedSystem: {}, claimedScorer: null, filename: 'b.jsonl', jsonl, importedBy: ctx.owner.id });
    const comparison = await store.createEvalComparison({ workspaceId: ctx.ws.id, projectId: ctx.project.id, setId: set.id, versionId: frozen[0].id, baselineBatchId: imports[0].batch.id, candidateBatchId: candidate.batch.id, createdBy: ctx.owner.id });
    const preview = await store.readEvalComparison({ workspaceId: ctx.ws.id, comparisonId: comparison.id });
    const reports = await Promise.all([1, 2].map(() => store.approveEvalReport({ workspaceId: ctx.ws.id, comparisonId: comparison.id, expectedRevision: comparison.revision, contentHash: preview.contentHash, approvedBy: ctx.owner.id })));
    assert.equal(reports[0].id, reports[1].id);
    assert.equal((await store.listEvalReports({ workspaceId: ctx.ws.id, comparisonId: comparison.id })).length, 1);
  });

  withStore('an executed case run stores a score only when every case is answered', async (store) => {
    const ctx = await evalReady(store, 'case-run');
    const where = { workspaceId: ctx.ws.id, projectId: ctx.project.id };
    const set = await store.createEvalSet({ ...where, createdBy: ctx.owner.id, name: 'Windows', purpose: 'development' });
    await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: 1, input: evalCase(ctx, 'window', { reviewCriteria: null, expectedAnswer: '30 days' }) });
    await store.saveEvalCase({ ...where, setId: set.id, expectedRevision: 2, input: evalCase(ctx, 'other', { reviewCriteria: null, expectedAnswer: '30 days', input: 'Anything else?' }) });
    const detail = await store.getEvalSet({ ...where, setId: set.id });
    assert.equal(detail.issues.filter((issue) => issue.open).length, 0);
    const frozen = await store.freezeEvalSet({ ...where, setId: set.id, expectedRevision: detail.set.revision, actorId: ctx.owner.id });
    const runner = await store.createRunner({ workspaceId: ctx.ws.id, createdBy: ctx.owner.id, label: 'Bench', keyHash: 'c'.repeat(64), keyPrefix: 'vrk_case01' });
    const cold = await store.createRunner({ workspaceId: ctx.ws.id, createdBy: ctx.owner.id, label: 'Cold', keyHash: 'e'.repeat(64), keyPrefix: 'vrk_case02' });
    const base = { ...where, versionId: frozen.id, runnerId: runner.id, role: 'candidate', recipeVersion: '1', catalog: [], actorId: ctx.owner.id };
    const candidate = { corpus: '30 days', prompt: 'Answer from the passage.', retrievalK: 1, boosts: [] };
    const start = (idempotencyKey, extra = {}) => store.startCaseRun({ ...base, candidate, idempotencyKey, ...extra });
    await assert.rejects(start('case-run-cold', { runnerId: cold.id }), { code: 'invalid_state' });
    await assert.rejects(start('case-run-model', { candidate: { ...candidate, modelId: 'not-in-catalog' } }), { code: 'invalid_state' });
    await store.reportRunner({ runnerId: runner.id, capabilities: { sandbox: { available: true } } });
    const run = await start('case-run-pass-1');
    assert.equal((await start('case-run-pass-1')).id, run.id);
    await assert.rejects(start('case-run-pass-1', { candidate: { ...candidate, corpus: 'a different source' } }), { code: 'invalid_state' });
    await assert.rejects(start('case-run-pass-1', { role: 'baseline' }), { code: 'invalid_state' });
    assert.equal(run.settings.promptUsed, false);
    assert.equal(run.runtime.modelId, null);
    assert.equal(run.scored, false);
    const listed = await store.listCaseRuns({ ...where, versionId: frozen.id });
    assert.equal(listed[0].passages, undefined);
    assert.equal(listed[0].results, undefined);
    assert.equal(listed[0].passCount, null);
    assert.equal(listed[0].passageCount, 1);
    const leaseHash = 'd'.repeat(64);
    const hold = async (jobId) => {
      const leased = await store.leaseJob({ runnerId: runner.id, leaseHash });
      assert.equal(leased.id, jobId);
      return { runnerId: runner.id, jobId, leaseHash };
    };
    const inputs = await store.caseRunInputs({ workspaceId: ctx.ws.id, jobId: run.jobId });
    assert.deepEqual(Object.keys(inputs.cases[0]).sort(), ['caseKey', 'input']);
    await hold(run.jobId);
    await assert.rejects(store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: run.jobId, results: [{ caseKey: 'missing-case', output: '30 days' }, { caseKey: 'window', output: '30 days' }] }), { code: 'invalid_state' });
    await assert.rejects(store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: run.jobId, results: [{ caseKey: 'window', output: '30 days' }, { caseKey: 'window', output: 'other' }] }), { code: 'invalid_state' });
    assert.equal((await store.getCaseRun({ ...where, runId: run.id })).results.length, 0);
    const answer = (caseKey, extra = {}) => ({ caseKey, output: '30 days', citations: ['p1'], latencyMs: 4, scores: { verdict: 'pass' }, ...extra });
    await store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: run.jobId, results: [answer('window'), answer('other')] });
    await store.finishJob({ ...(await Promise.resolve({ runnerId: runner.id, jobId: run.jobId, leaseHash })), outcome: 'succeeded', result: { recipe: 'support-qa', recipeVersion: '1', answered: 2, errors: 0 } });
    const passed = await store.getCaseRun({ ...where, runId: run.id });
    assert.equal(passed.status, 'complete');
    assert.equal(passed.scored, true);
    assert.deepEqual(passed.results.map((row) => row.scores.verdict), ['pass', 'pass']);
    assert.equal(passed.results.every((row) => !row.explanation.includes('30 days')), true);
    const again = await store.settleCaseRun({ workspaceId: ctx.ws.id, jobId: run.jobId });
    assert.equal(again.finishedAt, passed.finishedAt);
    await assert.rejects(store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: run.jobId, results: [answer('window', { output: 'changed' })] }), { code: 'invalid_state' });

    const partial = await start('case-run-partial');
    await hold(partial.jobId);
    await store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: partial.jobId, results: [{ caseKey: 'window', errorKind: 'timeout' }, answer('other')] });
    await store.finishJob({ runnerId: runner.id, jobId: partial.jobId, leaseHash, outcome: 'succeeded', result: { recipe: 'support-qa', recipeVersion: '1', answered: 1, errors: 1 } });
    const mixed = await store.settleCaseRun({ workspaceId: ctx.ws.id, jobId: partial.jobId });
    const timedOut = mixed.results.find((row) => row.caseKey === 'window');
    const clean = mixed.results.find((row) => row.caseKey === 'other');
    assert.deepEqual([mixed.status, mixed.scored, timedOut.scores, timedOut.output, clean.scores, clean.explanation, clean.output], ['partial', false, null, null, null, null, '30 days']);
    assert.match(timedOut.explanation, /not a wrong answer/);

    const cancelled = await start('case-run-cancel');
    await hold(cancelled.jobId);
    await store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: cancelled.jobId, results: [answer('window')] });
    await store.finishJob({ runnerId: runner.id, jobId: cancelled.jobId, leaseHash, outcome: 'failed', failure: 'cancelled' });
    const stopped = await store.settleCaseRun({ workspaceId: ctx.ws.id, jobId: cancelled.jobId });
    const kept = stopped.results.find((row) => row.caseKey === 'window');
    const absent = stopped.results.find((row) => row.caseKey === 'other');
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.scored, false);
    assert.deepEqual([kept.output, kept.scores, kept.explanation, absent.errorKind, absent.scores], ['30 days', null, null, 'missing', null]);

    const empty = await start('case-run-empty', { candidate: { corpus: '', prompt: '', retrievalK: 1, boosts: [] } });
    await hold(empty.jobId);
    await store.appendCaseResults({ workspaceId: ctx.ws.id, jobId: empty.jobId, results: [answer('window'), answer('other')] });
    await store.finishJob({ runnerId: runner.id, jobId: empty.jobId, leaseHash, outcome: 'succeeded', result: { recipe: 'support-qa', recipeVersion: '1', answered: 0, errors: 2 } });
    const nosource = await store.settleCaseRun({ workspaceId: ctx.ws.id, jobId: empty.jobId });
    assert.equal(nosource.status, 'failed');
    assert.equal(nosource.scored, false);
    assert.deepEqual(nosource.results.map((row) => [row.errorKind, row.output, row.scores]), [['no_source', null, null], ['no_source', null, null]]);

    const imported = await store.importEvalPredictions({ ...where, versionId: frozen.id, role: 'baseline', label: 'imported', claimedSystem: { identity: 'claimed' }, claimedScorer: null, filename: 'answers.jsonl', jsonl: '{"id":"window","status":"answered","output":"30 days"}\n{"id":"other","status":"answered","output":"30 days"}\n', importedBy: ctx.owner.id });
    const quiet = await start('case-run-list');
    await hold(quiet.jobId);
    await store.finishJob({ runnerId: runner.id, jobId: quiet.jobId, leaseHash, outcome: 'failed', failure: 'cancelled' });
    const fromList = (await store.listCaseRuns({ ...where, versionId: frozen.id })).find((item) => item.id === quiet.id);
    assert.equal(fromList.status, 'cancelled');
    assert.equal(fromList.scored, false);
    assert.equal(fromList.passCount, null);
    const scoredList = (await store.listCaseRuns({ ...where, versionId: frozen.id })).find((item) => item.id === run.id);
    const partialList = (await store.listCaseRuns({ ...where, versionId: frozen.id })).find((item) => item.id === partial.id);
    assert.equal(scoredList.passCount, 2);
    assert.equal(scoredList.results, undefined);
    assert.equal(partialList.status, 'partial');
    assert.equal(partialList.passCount, null);
    assert.equal(imported.batch.label, 'imported');
    assert.equal((await store.getEvalSet({ ...where, setId: set.id })).comparisons.length, 0);
  });
}
