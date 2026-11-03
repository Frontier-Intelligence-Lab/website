import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { makeApp, json, postHeaders } from './helpers.js';

const PROD = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) };

test('TRUST_PROXY defaults to false and only accepts explicit proxies in production', () => {
  assert.equal(loadConfig(PROD).trustProxy, false);
  assert.equal(parseTrustProxy('false', true), false);
  assert.deepEqual(parseTrustProxy('10.0.1.5, 172.18.0.0/16,loopback', true), ['10.0.1.5', '172.18.0.0/16', 'loopback']);
  assert.deepEqual(parseTrustProxy('fd00::1/64', true), ['fd00::1/64']);
  assert.throws(() => loadConfig({ ...PROD, TRUST_PROXY: 'true' }), /not allowed in production/);
  assert.equal(parseTrustProxy('true', false), true);
  for (const bad of ['traefik', '10.0.0.0/33', '1.2.3.4/8/1', 'fd00::1/129', '999.1.1.1']) {
    assert.throws(() => parseTrustProxy(bad, true), /not an IP, CIDR or keyword/, bad);
  }
});

test('production rejects insecure cookies; development allows them', () => {
  assert.equal(loadConfig(PROD).cookieSecure, true);
  assert.throws(() => loadConfig({ ...PROD, COOKIE_SECURE: 'false' }), /COOKIE_SECURE=false is not allowed/);
  assert.equal(loadConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }).cookieSecure, false);
});

test('spoofed X-Forwarded-For cannot reset rate limits when no proxy is trusted', async () => {
  const app = await makeApp({ rateLimits: { login: 1 } });
  const attempt = (ip) => app.inject({ method: 'POST', url: '/api/login', headers: { ...postHeaders, 'x-forwarded-for': ip }, remoteAddress: '203.0.113.9', payload: json({ username: 'someone', password: 'anything-at-all' }) });
  assert.equal((await attempt('198.51.100.1')).statusCode, 503);
  assert.equal((await attempt('198.51.100.2')).statusCode, 429);
  await app.close();
});

test('a trusted proxy address is honored for the client IP', async () => {
  const app = await makeApp({ env: { TRUST_PROXY: '203.0.113.9' }, rateLimits: { login: 1 } });
  const attempt = (ip) => app.inject({ method: 'POST', url: '/api/login', headers: { ...postHeaders, 'x-forwarded-for': ip }, remoteAddress: '203.0.113.9', payload: json({ username: 'someone', password: 'anything-at-all' }) });
  assert.equal((await attempt('198.51.100.1')).statusCode, 503);
  assert.equal((await attempt('198.51.100.1')).statusCode, 429);
  assert.equal((await attempt('198.51.100.2')).statusCode, 503);
  await app.close();
});
