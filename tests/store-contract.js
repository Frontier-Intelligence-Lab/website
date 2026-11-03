import assert from 'node:assert/strict';

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

  withStore('projects are only reachable through their own workspace', async (store) => {
    const owner = await store.createUser({ email: 'o@acme.com', name: 'O', passwordHash: 'h' });
    const a = await store.createWorkspace({ kind: 'organization', name: 'A', slug: 'a', ownerId: owner.id });
    const b = await store.createWorkspace({ kind: 'organization', name: 'B', slug: 'b', ownerId: owner.id });
    const p = await store.createProject({ workspaceId: a.id, createdBy: owner.id, name: 'Defects', task: 'Spot damaged boxes', modalities: ['Images'], startingPoint: 'own' });
    assert.equal(p.status, 'draft');
    assert.deepEqual(p.modalities, ['Images']);
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
