import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterSave, consentStep, consentValid, sendBody } from '../web/src/app/capital-consent.js';

// The send card's behaviour, as the Request view drives it: a dirty form can only be saved, a send carries only the
// hash the consent view showed, consent is bound to that hash, and it starts over after every save.
const at = (over = {}) => consentStep({ status: 'draft', revision: 2, submittedRevision: null, dirty: false, consent: false, pending: false, ...over });

test('a dirty form can only be saved: it never sends, whatever the consent box says', () => {
  for (const consent of [true, false]) {
    for (const status of ['draft', 'changes_requested', 'evidence_reviewed']) {
      const step = at({ dirty: true, consent, status, submittedRevision: status === 'draft' ? null : 2 });
      assert.deepEqual(step, { action: 'save', nextRevision: 3 }, `${status} consent ${consent}`);
    }
  }
});

test('a send needs a clean form and a fresh consent, and names exactly the loaded revision and hash', () => {
  assert.deepEqual(at({ consent: false }), { action: 'none', reason: 'consent_required' });
  assert.deepEqual(at({ consent: true }), { action: 'send', revision: 2 });
  assert.deepEqual(at({ consent: true, status: 'changes_requested', submittedRevision: 1 }), { action: 'send', revision: 2 }, 'a corrected revision can go back');
  assert.deepEqual(sendBody({ revision: 2, contentHash: 'h' }), { expectedRevision: 2, contentHash: 'h', sendToReview: true });
  assert.equal(Object.hasOwn(sendBody({ revision: 2, contentHash: 'h' }), 'draft'), false, 'a send carries no content of its own');
});

test('consent is bound to the loaded hash: a changed hash clears it even when the visible summary is identical, the same hash keeps it', () => {
  const given = { consentHash: 'A', contentHash: 'A' };
  assert.equal(consentValid(given), true);
  assert.equal(consentValid({ consentHash: 'A', contentHash: 'A' }), true, 'a reload that brings the same hash keeps consent');
  // A colleague corrected only a credit's restrictions: provider, amount and status still read the same, the hash does not.
  assert.equal(consentValid({ consentHash: 'A', contentHash: 'B' }), false, 'a hidden-only change invalidates consent');
  assert.equal(consentValid({ consentHash: null, contentHash: 'B' }), false);
  assert.equal(consentValid({ consentHash: 'B', contentHash: 'B' }), true, 'consent given again on the new hash is valid');
  assert.equal(at({ consent: consentValid({ consentHash: 'A', contentHash: 'B' }) }).action, 'none', 'nothing sends on an invalidated consent');
  assert.deepEqual(at({ consent: consentValid({ consentHash: 'B', contentHash: 'B' }) }), { action: 'send', revision: 2 });
});

test('after a save consent is cleared and the owner is told to review the reloaded view before sending', () => {
  assert.deepEqual(afterSave(), { consentHash: null, notice: 'saved' });
  // The sequence the review found: dirty + consent ticked -> save only; then the reloaded view with consent cleared -> nothing sends until re-ticked.
  assert.equal(at({ dirty: true, consent: true }).action, 'save');
  const reloaded = { ...afterSave(), revision: 3, contentHash: 'C' };
  assert.equal(at({ dirty: false, consent: consentValid(reloaded), revision: reloaded.revision }).action, 'none');
  assert.equal(at({ dirty: false, consent: consentValid({ consentHash: 'C', contentHash: 'C' }), revision: reloaded.revision }).action, 'send');
});

test('nothing sends while a request or a reload is in flight, while the case is with review, or when this revision was already sent', () => {
  assert.deepEqual(at({ consent: true, pending: true }), { action: 'none', reason: 'pending' });
  assert.deepEqual(at({ consent: true, dirty: true, pending: true }), { action: 'none', reason: 'pending' }, 'no second save either');
  assert.deepEqual(at({ consent: true, status: 'submitted', submittedRevision: 2 }), { action: 'none', reason: 'in_review' });
  assert.deepEqual(at({ consent: true, status: 'changes_requested', submittedRevision: 2 }), { action: 'none', reason: 'already_sent' });
  assert.deepEqual(at({ consent: true, status: 'evidence_reviewed', submittedRevision: 2 }), { action: 'none', reason: 'already_sent' });
});
