import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const KEY_LENGTH = 64;
const MAX_COST = 2 ** 20;

// Node's built-in scrypt at the OWASP baseline (N=2^17, r=8, p=1).
export async function hashPassword(password, { cost = 2 ** 17, blockSize = 8, parallelization = 1 } = {}) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost, blockSize, parallelization);
  return ['scrypt', cost, blockSize, parallelization, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [cost, blockSize, parallelization] = parts.slice(1, 4).map(Number);
  if (![cost, blockSize, parallelization].every(Number.isInteger) || cost < 2 || cost > MAX_COST) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, cost, blockSize, parallelization);
  return timingSafeEqual(actual, expected);
}

function derive(password, salt, N, r, p) {
  return scrypt(String(password), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * 1024 * 1024 });
}
