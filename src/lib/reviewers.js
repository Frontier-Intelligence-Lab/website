import { hashPassword, verifyPassword } from './passwords.js';

/** Reviewer accounts: [{ "email": "...", "name": "...", "passwordHash": "scrypt$..." }] */
export function parseReviewers(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('Reviewer config must be a JSON array');
  return list.map((entry, i) => {
    const email = String(entry?.email ?? '').trim().toLowerCase();
    const passwordHash = String(entry?.passwordHash ?? '');
    if (!email.includes('@') || !passwordHash.startsWith('scrypt$')) {
      throw new Error(`Reviewer entry ${i} needs an email and a scrypt passwordHash`);
    }
    return { email, name: String(entry.name ?? email), passwordHash };
  });
}

// Verified when the email is unknown so a failed login takes the same time either way.
const dummyHash = await hashPassword('dummy-password-for-constant-time');

export async function authenticateReviewer(reviewers, email, password) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const reviewer = reviewers.find((r) => r.email === normalized);
  const ok = await verifyPassword(password, reviewer?.passwordHash ?? dummyHash);
  return ok && reviewer ? { email: reviewer.email, name: reviewer.name } : null;
}
