import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStepKind } from '../web/src/app/lifecycle.js';

const ROLES = ['owner', 'admin', 'member', 'finance', 'viewer'];

test('frozen projects keep their lifecycle actions even without an acceptance rule', () => {
  const expected = {
    in_review: { owner: 'in-review-withdraw', admin: 'in-review-withdraw', member: 'in-review-withdraw', finance: 'in-review', viewer: 'in-review' },
    approved: { owner: 'approve-version', admin: 'approve-version', member: 'wait-admin', finance: 'wait-admin', viewer: 'wait-admin' },
    versioned: { owner: 'versioned-manage', admin: 'versioned-manage', member: 'versioned', finance: 'versioned', viewer: 'versioned' },
  };
  for (const [status, byRole] of Object.entries(expected)) {
    for (const role of ROLES) {
      for (const hasSuccess of [false, true]) {
        for (const hasData of [false, true]) {
          assert.equal(nextStepKind({ status, startingPoint: 'own', role, hasSuccess, hasData }), byRole[role], `${status} ${role} rule=${hasSuccess} data=${hasData}`);
        }
      }
    }
  }
});

test('editable projects walk through rule, data, then submit; read-only roles get no setup action', () => {
  for (const status of ['draft', 'changes_requested']) {
    assert.equal(nextStepKind({ status, startingPoint: 'own', role: 'member', hasSuccess: false, hasData: false }), 'set-rule');
    assert.equal(nextStepKind({ status, startingPoint: 'own', role: 'member', hasSuccess: true, hasData: false }), 'record-data');
    assert.equal(nextStepKind({ status, startingPoint: 'model', role: 'owner', hasSuccess: true, hasData: false }), 'describe-model');
    assert.equal(nextStepKind({ status, startingPoint: 'own', role: 'admin', hasSuccess: true, hasData: true }), 'submit');
    assert.equal(nextStepKind({ status, startingPoint: 'model', role: 'admin', hasSuccess: true, hasData: true }), null, 'model projects are not reviewed as datasets');
    for (const role of ['finance', 'viewer']) assert.equal(nextStepKind({ status, startingPoint: 'own', role, hasSuccess: false, hasData: false }), null);
  }
  assert.equal(nextStepKind({ status: 'draft', startingPoint: 'unsure', role: 'member', hasSuccess: false, hasData: false }), 'book-call');
  assert.equal(nextStepKind({ status: 'draft', startingPoint: 'unsure', role: 'viewer', hasSuccess: false, hasData: false }), 'wait-call');
});

test('a frozen project that was never scoped (startingPoint unsure) still gets its frozen actions', () => {
  for (const role of ROLES) {
    assert.equal(nextStepKind({ status: 'versioned', startingPoint: 'unsure', role, hasSuccess: false, hasData: false }), ['owner', 'admin'].includes(role) ? 'versioned-manage' : 'versioned');
    assert.equal(nextStepKind({ status: 'in_review', startingPoint: 'unsure', role, hasSuccess: false, hasData: false }), ['owner', 'admin', 'member'].includes(role) ? 'in-review-withdraw' : 'in-review');
  }
});
