import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { makeApp, json, postHeaders } from './helpers.js';

async function fixture(role, status = 'in_review', passwordHash = 'test-hash') {
  const store = createMemoryStore();
  const owner = await store.createUser({ email: 'owner@reopen.test', name: 'Owner', passwordHash });
  const actor = role === 'owner' ? owner : await store.createUser({ email: 'actor@reopen.test', name: 'Actor', passwordHash });
  await store.setEmailVerified(actor.id);
  const workspace = await store.createWorkspace({ kind: 'organization', name: 'Reopen', slug: 'reopen', ownerId: owner.id });
  if (role !== 'owner' && role !== 'outsider') {
    await store.createInvitations({ workspaceId: workspace.id, invitedBy: owner.id, invites: [{ email: actor.email, role, tokenHash: 'reopen-invitation', expiresAt: new Date(Date.now() + 60_000) }] });
    const invitation = await store.getInvitationByTokenHash('reopen-invitation');
    await store.acceptInvitation({ invitationId: invitation.id, userId: actor.id });
  }
  const project = await store.createProject({ workspaceId: workspace.id, createdBy: owner.id, name: 'Sample', task: 'Classify', startingPoint: 'own' });
  const scope = { workspaceId: workspace.id, projectId: project.id };
  const review = await store.submitForReview({ ...scope, submittedBy: owner.id });
  if (status !== 'in_review') await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved' });
  if (status === 'versioned') await store.createDatasetVersion({ ...scope, createdBy: owner.id });
  return { store, owner, actor, project, scope, review };
}

test('reopening checks current membership: editors withdraw, only owners/admins reopen approval', async () => {
  for (const role of ['owner', 'admin', 'member', 'finance', 'viewer', 'outsider']) {
    for (const status of ['in_review', 'approved', 'versioned']) {
      const { store, actor, scope, review } = await fixture(role, status);
      const beforeAudit = await store.listAudit(scope.workspaceId);
      const allowed = role === 'owner' || role === 'admin' || (role === 'member' && status === 'in_review');
      if (allowed) {
        assert.equal((await store.reopenProject({ ...scope, actorId: actor.id })).status, 'draft', `${role}/${status}`);
        if (status === 'in_review') assert.equal((await store.getReview(review.id)).status, 'withdrawn');
      } else {
        await assert.rejects(store.reopenProject({ ...scope, actorId: actor.id }), { code: 'forbidden' }, `${role}/${status}`);
        assert.equal((await store.getProject(scope)).status, status);
        assert.deepEqual(await store.listAudit(scope.workspaceId), beforeAudit);
        assert.equal((await store.getReview(review.id)).status, status === 'in_review' ? 'pending' : 'approved');
      }
      await store.close();
    }
  }
});

test('a member cannot reopen when staff approves after the route reads in_review', async () => {
  const password = 'local-reopen-race-password';
  const f = await fixture('member', 'in_review', await hashPassword(password, { cost: 2 ** 12 }));
  let approveAfterRead = false;
  const wrapped = {
    ...f.store,
    async getProject(scope) {
      const project = await f.store.getProject(scope);
      if (approveAfterRead && project?.status === 'in_review') {
        approveAfterRead = false;
        await f.store.decideReview({ reviewId: f.review.id, reviewerId: f.owner.id, decision: 'approved' });
      }
      return project;
    },
  };
  const app = await makeApp({ store: wrapped });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: f.actor.email, password }) });
    assert.equal(login.statusCode, 200);
    const sid = login.cookies.find(c => c.name === 'valcairn.sid');
    approveAfterRead = true;
    const result = await app.inject({ method: 'POST', url: `/api/workspaces/${f.scope.workspaceId}/projects/${f.project.id}/reopen`, headers: postHeaders, cookies: { 'valcairn.sid': sid.value }, payload: '{}' });
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().code, 'forbidden');
    assert.equal((await f.store.getProject(f.scope)).status, 'approved');
    assert.equal((await f.store.getReview(f.review.id)).status, 'approved');
  } finally { await app.close(); }
});
