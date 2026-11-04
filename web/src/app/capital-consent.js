// The owner's consent to send is one explicit act on content they have seen: the case view and the hash it came
// with. Unsaved edits are saved first and the complete view reloads with consent cleared; a save never becomes a
// send, and a hash from anywhere but the view is never sent. Pure, so the behaviour is testable without a browser.

/**
 * What the send card may do right now.
 *   { action: 'none', reason }  nothing to send (in review, already sent as this revision, busy, consent not given)
 *   { action: 'save' }          unsaved edits: save them, then the owner reviews the reloaded view and consents again
 *   { action: 'send', revision } send exactly the revision and hash the view showed
 */
export function consentStep({ status, revision, submittedRevision, dirty, consent, pending }) {
  if (status === 'submitted') return { action: 'none', reason: 'in_review' };
  if (pending) return { action: 'none', reason: 'pending' };
  if (dirty) return { action: 'save', nextRevision: revision + 1 };
  if (status !== 'draft' && submittedRevision === revision) return { action: 'none', reason: 'already_sent' };
  return consent ? { action: 'send', revision } : { action: 'none', reason: 'consent_required' };
}

/** The send request: only the revision and hash the consent view showed. */
export const sendBody = ({ revision, contentHash }) => ({ expectedRevision: revision, contentHash, sendToReview: true });

/** After any change to what the owner is looking at, consent starts over. */
export const afterSave = () => ({ consentHash: null, notice: 'saved' });

/**
 * Consent is given on one content hash, the one the view was loaded with. It stays valid only while the view's hash
 * is that same hash: a reload that brings a different hash clears it, even when every visible summary looks the same,
 * because the hash covers fields a summary may not show. A reload that brings the same hash keeps it.
 */
export const consentValid = ({ consentHash, contentHash }) => Boolean(consentHash) && consentHash === contentHash;
