import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/lib/passwords.js';

export const ORIGIN = 'http://localhost:80';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// A tiny stand-in for the Vite build so server tests do not depend on running it.
export const FIXTURE_DIST = path.join(HERE, 'fixtures', 'dist');
// Synthetic model catalog, selected through MODEL_CATALOG_FILE like a deployment's; tests read ids from it.
export const FIXTURE_CATALOG = path.join(HERE, 'fixtures', 'model-catalog.json');
// The documented example an operator starts from; tests only check that it passes the same validation.
export const EXAMPLE_CATALOG = path.join(HERE, '..', 'docs', 'model-catalog.example.json');

export async function reviewerFixture() {
  const passwordHash = await hashPassword('correct horse battery', { cost: 2 ** 12 });
  return { username: 'reviewer', name: 'Test Reviewer', passwordHash, password: 'correct horse battery' };
}

export async function makeApp({ env = {}, contactTransport, mailTransport, ingestClient, store, sessionStore, rateLimits } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ...env });
  const app = await buildApp({ config, contactTransport, mailTransport, ingestClient, store, sessionStore, rateLimits, distDir: FIXTURE_DIST });
  await app.ready();
  return app;
}

export const json = (body) => JSON.stringify(body);
export const postHeaders = { 'content-type': 'application/json', origin: ORIGIN };

export const sessionCookie = (res) => {
  const cookie = res.cookies.find((c) => c.name === 'valcairn.sid');
  return cookie ? { 'valcairn.sid': cookie.value } : {};
};
