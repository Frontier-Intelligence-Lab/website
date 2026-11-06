import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReviewerEntry } from '../web/src/reviewer-entry.js';

const reviewer = { username: 'qa-reviewer', role: 'viewer' };
const workspace = { id: 'synthetic-workspace', slug: 'synthetic-reviewer-qa' };
const entered = () => ({ user: { id: 'synthetic-owner' }, workspaces: [{ ...workspace, role: 'owner' }], demoAccess: { workspace } });
const unexpected = () => { throw new Error('Unexpected entry attempt'); };

test('returning mapped reviewer opens the shared workspace home without re-entering', async () => {
  const result = await resolveReviewerEntry({ reviewer, fetchAccount: async () => entered(), enterWorkspace: unexpected });
  assert.deepEqual(result, { kind: 'workspace', to: '/w/synthetic-reviewer-qa' });
});

test('a reviewer without an entry marker enters only through the server POST callback', async () => {
  const calls = [];
  const result = await resolveReviewerEntry({
    reviewer,
    fetchAccount: async () => { calls.push('read-account'); return { user: null }; },
    enterWorkspace: async () => { calls.push('post-entry'); return { ok: true, status: 200, data: { to: '/w/other-synthetic-qa' } }; },
  });
  assert.deepEqual(calls, ['read-account', 'post-entry']);
  assert.deepEqual(result, { kind: 'workspace', to: '/w/other-synthetic-qa' }, 'The server, not the username or client record, chooses first entry');
});

test('normal account sessions are not replaced by a reviewer-derived identity', async () => {
  const result = await resolveReviewerEntry({ reviewer, fetchAccount: async () => ({ user: { id: 'synthetic-normal-user' }, workspaces: [workspace] }), enterWorkspace: unexpected });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.status, 409);
});

test('admin keeps its audit overview and a signed-out session grants no entry', async () => {
  assert.deepEqual(await resolveReviewerEntry({ reviewer: { role: 'admin' }, fetchAccount: unexpected, enterWorkspace: unexpected }), { kind: 'audit' });
  assert.deepEqual(await resolveReviewerEntry({ reviewer: null, fetchAccount: unexpected, enterWorkspace: unexpected }), { kind: 'signed_out' });
});

test('revoked or missing reviewer mapping never falls back to another workspace or audit view', async () => {
  for (const response of [
    { ok: false, status: 401, data: {} },
    { ok: false, status: 403, data: { error: 'Synthetic entry unavailable' } },
  ]) {
    const result = await resolveReviewerEntry({ reviewer, fetchAccount: async () => ({ user: null }), enterWorkspace: async () => response });
    assert.equal(result.kind, response.status === 401 ? 'signed_out' : 'unavailable');
    assert.notEqual(result.kind, 'workspace');
  }
});

test('an inconsistent projected workspace fails closed without minting a replacement', async () => {
  const account = entered();
  account.workspaces = [{ id: 'synthetic-foreign-workspace', slug: 'synthetic-foreign-qa' }];
  const result = await resolveReviewerEntry({ reviewer, fetchAccount: async () => account, enterWorkspace: unexpected });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.status, 403);
});

test('entry failures and malformed destinations are visible refusals, not overview fallbacks', async () => {
  for (const to of ['https://example.invalid/qa', '//example.invalid/qa', '/staff', undefined]) {
    const result = await resolveReviewerEntry({ reviewer, fetchAccount: async () => ({ user: null }), enterWorkspace: async () => ({ ok: true, status: 200, data: { to } }) });
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.status, 503);
  }
  for (const failing of ['account', 'entry']) {
    const result = await resolveReviewerEntry({
      reviewer,
      fetchAccount: async () => { if (failing === 'account') throw new Error('Synthetic connection failure'); return { user: null }; },
      enterWorkspace: async () => { throw new Error('Synthetic connection failure'); },
    });
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.status, 503);
  }
});
