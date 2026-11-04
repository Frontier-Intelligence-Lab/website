// Which next step the project page offers. Kept free of JSX so it can be tested directly.
// A frozen project (in review, approved, versioned) always shows its own lifecycle actions first, even when setup
// fields are incomplete: the setup pages refuse frozen edits, so pointing there would loop.
export const WRITERS = ['owner', 'admin', 'member'];
export const MANAGERS = ['owner', 'admin'];

export function nextStepKind({ status, startingPoint, role, hasSuccess, hasData }) {
  const writer = WRITERS.includes(role);
  const manager = MANAGERS.includes(role);
  if (status === 'in_review') return writer ? 'in-review-withdraw' : 'in-review';
  if (status === 'approved') return manager ? 'approve-version' : 'wait-admin';
  if (status === 'versioned') return manager ? 'versioned-manage' : 'versioned';
  if (startingPoint === 'unsure') return writer ? 'book-call' : 'wait-call';
  if (!hasSuccess) return writer ? 'set-rule' : null;
  if (!hasData) return writer ? (startingPoint === 'model' ? 'describe-model' : 'record-data') : null;
  if (startingPoint !== 'model' && writer) return 'submit';
  return null;
}
