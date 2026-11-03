import { hashPassword, verifyPassword } from './passwords.js';

// Usernames are matched case-insensitively; letters, digits and . _ - @ + only.
const USERNAME_RE = /^[a-z0-9._@+-]{1,64}$/;
export const normalizeUsername = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Reviewer accounts: [{ "username": "...", "name": "...", "passwordHash": "scrypt$..." }].
 * Only accounts listed here can sign in. Older entries keyed by "email" are still accepted.
 */
export function parseReviewers(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('Reviewer config must be a JSON array');
  const seen = new Set();
  return list.map((entry, i) => {
    const username = normalizeUsername(entry?.username ?? entry?.email);
    const passwordHash = String(entry?.passwordHash ?? '');
    if (!USERNAME_RE.test(username) || !passwordHash.startsWith('scrypt$')) {
      throw new Error(`Reviewer entry ${i} needs a username and a scrypt passwordHash`);
    }
    if (seen.has(username)) throw new Error(`Reviewer entry ${i} repeats the username "${username}"`);
    seen.add(username);
    return { username, name: String(entry.name ?? username), passwordHash };
  });
}

// Verified when the username is unknown so a failed login takes the same time either way.
const dummyHash = await hashPassword('dummy-password-for-constant-time');

export async function authenticateReviewer(reviewers, username, password) {
  const normalized = normalizeUsername(username);
  const reviewer = reviewers.find((r) => r.username === normalized);
  const ok = await verifyPassword(password, reviewer?.passwordHash ?? dummyHash);
  return ok && reviewer ? { username: reviewer.username, name: reviewer.name } : null;
}
