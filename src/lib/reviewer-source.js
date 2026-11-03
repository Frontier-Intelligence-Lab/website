import { hashPassword, verifyPassword } from './passwords.js';
import { normalizeUsername } from './reviewers.js';

// Verified when the username is unknown, so a failed login takes the same time either way.
const dummyHash = await hashPassword('dummy-password-for-constant-time');

/**
 * Where external demo reviewers (YC, Speedrun, admin) authenticate.
 * With Postgres: the reviewer_accounts table only. Without it (local development): REVIEWERS_FILE / REVIEWERS_JSON.
 * Reviewers are never customer users and never Valcairn staff.
 */
export function createReviewerSource({ store, fileReviewers = [] }) {
  const fromDb = store?.kind === 'postgres';
  const lookup = fromDb
    ? (username) => store.getReviewerAuth(username)
    : async (username) => {
        const r = fileReviewers.find((x) => x.username === username);
        return r ? { account: { username: r.username, name: r.name, role: r.role, enabled: true }, passwordHash: r.passwordHash } : null;
      };

  return {
    source: fromDb ? 'postgres' : 'file',

    async configured() {
      return fromDb ? (await store.listReviewers()).some((r) => r.enabled) : fileReviewers.length > 0;
    },

    /** `{ reviewer }` on success; `{ reviewer: null, known }` otherwise. Disabled accounts never sign in. */
    async authenticate(username, password) {
      const normalized = normalizeUsername(username);
      const found = normalized ? await lookup(normalized) : null;
      const ok = await verifyPassword(password, found?.passwordHash ?? dummyHash);
      if (!ok || !found?.account.enabled) return { reviewer: null, known: Boolean(found) };
      const { username: name, ...rest } = found.account;
      return { reviewer: { username: name, name: rest.name, role: rest.role } };
    },

    /**
     * Re-reads the account behind a signed-in session, so disabling or demoting it applies at once.
     * Returns the reviewer with its current name and role, or null when it should be signed out.
     */
    async current(sessionReviewer) {
      if (!sessionReviewer?.username) return null;
      const found = await lookup(sessionReviewer.username);
      if (!found?.account.enabled) return null;
      return { ...sessionReviewer, name: found.account.name, role: found.account.role };
    },
  };
}
