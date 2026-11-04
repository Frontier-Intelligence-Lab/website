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
}
