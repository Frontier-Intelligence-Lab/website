import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/passwords.js';

export const ORIGIN = 'http://localhost:80';
// A tiny stand-in for the Vite build so server tests do not depend on running it.
export const FIXTURE_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dist');

export async function reviewerFixture() {
  const passwordHash = await hashPassword('correct horse battery', { cost: 2 ** 12 });
  return { username: 'reviewer', name: 'Test Reviewer', passwordHash, password: 'correct horse battery' };
}

export async function makeApp({ env = {}, contactTransport, rateLimits } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ...env });
  const app = await buildApp({ config, contactTransport, rateLimits, distDir: FIXTURE_DIST });
  await app.ready();
  return app;
}

export const json = (body) => JSON.stringify(body);
export const postHeaders = { 'content-type': 'application/json', origin: ORIGIN };

export const sessionCookie = (res) => {
  const cookie = res.cookies.find((c) => c.name === 'valcairn.sid');
  return cookie ? { 'valcairn.sid': cookie.value } : {};
};
