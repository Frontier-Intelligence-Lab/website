import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/lib/passwords.js';
import { parseReviewers } from '../src/lib/reviewers.js';
import { makeApp, json, postHeaders, reviewerFixture, sessionCookie } from './helpers.js';

const PRIVATE_FILE = '/private/Dashboard-test.js';
const PRIVATE_BODY = 'reviewer-only dashboard';

test('scrypt hashes verify only for the right password and reject malformed hashes', async () => {
  const hash = await hashPassword('pw-123456789', { cost: 2 ** 12 });
  assert.ok(hash.startsWith('scrypt$4096$8$1$'));
  assert.equal(await verifyPassword('pw-123456789', hash), true);
  assert.equal(await verifyPassword('pw-123456780', hash), false);
  assert.equal(await verifyPassword('pw-123456789', 'plain'), false);
  assert.equal(await verifyPassword('pw-123456789', hash.replace('4096', String(2 ** 21))), false);
});

test('reviewer config is validated and usernames normalized', () => {
  assert.equal(parseReviewers('[{"username":" Admin ","passwordHash":"scrypt$x"}]')[0].username, 'admin');
  assert.equal(parseReviewers('[{"email":"A@B.co","passwordHash":"scrypt$x"}]')[0].username, 'a@b.co');
  assert.throws(() => parseReviewers('{}'));
  assert.throws(() => parseReviewers('[{"username":"admin","passwordHash":"plain"}]'));
  assert.throws(() => parseReviewers('[{"username":"has space","passwordHash":"scrypt$x"}]'));
  assert.throws(() => parseReviewers('[{"username":"admin","passwordHash":"scrypt$x"},{"username":"ADMIN","passwordHash":"scrypt$y"}]'), /repeats/);
});

test('only the configured accounts can sign in, each with its own password', async () => {
  const hash = (pw) => hashPassword(pw, { cost: 2 ** 12 });
  const accounts = [
    { username: 'first', name: 'First', passwordHash: await hash('first-secret-1') },
    { username: 'second', name: 'Second', passwordHash: await hash('second-secret-2') },
  ];
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify(accounts) } });
  const login = (username, password) => app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username, password }) });

  assert.equal((await login('first', 'first-secret-1')).json().reviewer.username, 'first');
  assert.equal((await login('SECOND', 'second-secret-2')).json().reviewer.username, 'second');
  for (const [username, password] of [['first', 'second-secret-2'], ['second', 'first-secret-1'], ['first', 'FIRST-SECRET-1'], ['admin', 'first-secret-1'], ['', ''], ['first', '']]) {
    const res = await login(username, password);
    assert.equal(res.statusCode, 401, `${username}/${password}`);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  const legacyEmailField = await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ email: 'first', password: 'first-secret-1' }) });
  assert.equal(legacyEmailField.statusCode, 401);
  await app.close();
});

test('signed-out requests never receive private pages or reviewer-only code', async () => {
  const app = await makeApp();
  const page = await app.inject({ method: 'GET', url: '/demo/review' });
  assert.equal(page.statusCode, 303);
  assert.equal(page.headers.location, '/demo');

  const chunk = await app.inject({ method: 'GET', url: PRIVATE_FILE });
  assert.equal(chunk.statusCode, 401);
  assert.ok(!chunk.body.includes(PRIVATE_BODY));
  assert.equal(chunk.headers['cache-control'], 'private, no-store');

  const login = await app.inject({ method: 'GET', url: '/demo' });
  assert.equal(login.statusCode, 200);
  assert.equal(login.headers['x-robots-tag'], 'noindex');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/session' })).json(), { reviewer: null });
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().signInConfigured, false);
  await app.close();
});

test('login fails closed when no reviewers are configured', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username: 'someone', password: 'anything-at-all' }) });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /not configured/);
  assert.equal(res.headers['set-cookie'], undefined);
  await app.close();
});

test('wrong credentials get 401 and no session; CSRF-less posts get 403', async () => {
  const r = await reviewerFixture();
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify([r]) } });
  for (const creds of [{ username: r.username, password: 'wrong-password-1' }, { username: 'nobody', password: r.password }]) {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json(creds) });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.match(res.json().error, /did not match/);
  }
  const noOrigin = await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: json({ username: r.username, password: r.password }) });
  assert.equal(noOrigin.statusCode, 403);
  await app.close();
});

test('valid login creates an HttpOnly Lax session that unlocks the dashboard; logout revokes it', async () => {
  const r = await reviewerFixture();
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify([r]) } });
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username: r.username.toUpperCase(), password: r.password }) });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().reviewer.username, r.username);
  assert.equal(login.json().reviewer.passwordHash, undefined);
  const cookie = login.cookies.find((c) => c.name === 'valcairn.sid');
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, 'Lax');
  const cookies = sessionCookie(login);

  const review = await app.inject({ method: 'GET', url: '/demo/review', cookies });
  assert.equal(review.statusCode, 200);
  assert.equal(review.headers['cache-control'], 'private, no-store');
  const chunk = await app.inject({ method: 'GET', url: PRIVATE_FILE, cookies });
  assert.equal(chunk.statusCode, 200);
  assert.ok(chunk.body.includes(PRIVATE_BODY));
  assert.equal((await app.inject({ method: 'GET', url: '/api/session', cookies })).json().reviewer.name, 'Test Reviewer');
  assert.equal((await app.inject({ method: 'GET', url: '/demo', cookies })).headers.location, '/demo/review');

  const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: postHeaders, cookies, payload: '{}' });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/demo/review', cookies })).statusCode, 303);
  assert.equal((await app.inject({ method: 'GET', url: PRIVATE_FILE, cookies })).statusCode, 401);
  await app.close();
});

test('login attempts are rate limited', async () => {
  const r = await reviewerFixture();
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify([r]) }, rateLimits: { login: 2 } });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username: r.username, password: 'bad-password-xx' }) })).statusCode);
  assert.deepEqual(codes, [401, 401, 429]);
  await app.close();
});

test('production config refuses to start without a session secret', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), CONTACT_DELIVERY: 'smtp' }), /SMTP_HOST/);
});
