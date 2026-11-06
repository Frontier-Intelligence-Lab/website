import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api } from '../web/src/api.js';
import { safeNext, signInResult } from '../web/src/signin.js';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { json, makeApp, postHeaders, sessionCookie } from './helpers.js';

async function fixture() {
  const store = createMemoryStore();
  const ownerPassword = 'QA ONLY ordinary account password';
  const ownerHash = await hashPassword(ownerPassword, { cost: 2 ** 12 });
  const reviewers = [];
  const entries = [];
  const owners = [];
  for (const label of ['yc', 'speedrun']) {
    const user = await store.createUser({ email: `${label}@signin-qa.invalid`, name: `QA ONLY ${label}`, passwordHash: ownerHash });
    await store.setEmailVerified(user.id);
    const workspace = await store.createWorkspace({ kind: 'organization', name: `QA ONLY ${label}`, slug: `qa-signin-${label}`, ownerId: user.id, profile: { synthetic: true } });
    const username = `qa-${label}-reviewer`;
    const password = `QA ONLY ${label} reviewer password `;
    reviewers.push({ username, password, passwordHash: await hashPassword(password, { cost: 2 ** 12 }), name: `QA ONLY ${label} reviewer`, role: 'viewer' });
    entries.push({ username, userId: user.id, workspaceId: workspace.id });
    owners.push({ user, workspace });
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'valcairn-signin-parity-'));
  const mapping = path.join(dir, 'mapping.json');
  writeFileSync(mapping, JSON.stringify(entries));
  const app = await makeApp({ store, env: { REVIEWERS_JSON: JSON.stringify(reviewers), DEMO_REVIEWER_USERS_FILE: mapping }, rateLimits: { login: 20, signin: 20 } });
  return { app, store, reviewers, owners, ownerPassword, close: async () => { await app.close(); assert.equal(path.dirname(dir), path.resolve(tmpdir())); rmSync(dir, { recursive: true }); } };
}

// The real browser API client talks to the real Fastify routes without a network or a real account. Cookie handling
// mirrors fetch(credentials:'same-origin'); this is transport/flow evidence, not a browser interaction claim.
function transport(t, app) {
  let cookies = {};
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, options });
    const response = await app.inject({ method: options.method ?? 'GET', url, headers: options.method === 'POST' ? postHeaders : {}, cookies, payload: options.body });
    const nextCookie = sessionCookie(response);
    if (nextCookie['valcairn.sid']) cookies = nextCookie;
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
  });
  return { requests, cookies: () => cookies, clear: () => { cookies = {}; requests.length = 0; } };
}

test('next destinations are canonical local rooted paths with their query and fragment preserved', () => {
  for (const [value, expected] of [
    ['/', '/'],
    ['/w/qa-only?view=jobs#result', '/w/qa-only?view=jobs#result'],
    ['/w/qa-only?next=%2Fstaff&term=one+two#saved', '/w/qa-only?next=%2Fstaff&term=one+two#saved'],
    ['/w/qa-only/../other?view=jobs#result', '/w/other?view=jobs#result'],
    ['/search?term=one two#saved answer', '/search?term=one%20two#saved%20answer'],
  ]) assert.equal(safeNext(value), expected, value);
});

test('next rejects external, network-path, backslash and parser-stripped control destinations without navigation', () => {
  for (const value of [
    null, undefined, {}, 123, '', 'w/qa-only', '?view=jobs', '#result',
    'https://example.test/w/qa-only', 'https://signin.invalid/w/qa-only', 'javascript:alert(1)',
    '//example.test', '///example.test', '//signin.invalid/w/qa-only',
    '/a/..//example.test', '/%2e%2e//example.test',
    '/\\example.test', '/\\\\example.test', '\\\\example.test',
    '/\t/example.test', '/\r/example.test', '/\n/example.test', '/\r\n/example.test',
    '/\u0000/example.test', '/\u001f/example.test', '/\u007f/example.test', '/w/qa-only?view=\tjobs',
  ]) assert.equal(safeNext(value), null, JSON.stringify(value));
});

test('normal sign-in accepts both reviewer usernames through the existing login service and pins the same Owner workspace as demo', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const browser = transport(t, f.app);
  for (let i = 0; i < f.reviewers.length; i += 1) {
    const reviewer = f.reviewers[i];
    const result = await signInResult({ email: ` ${reviewer.username.toUpperCase()} `, password: reviewer.password }, '/staff');
    assert.deepEqual(result, { to: `/w/${f.owners[i].workspace.slug}` }, 'A next query cannot redirect a reviewer outside its pinned workspace');
    assert.equal(browser.requests[0].url, '/api/login');
    assert.equal(JSON.parse(browser.requests[0].options.body).password, reviewer.password, 'Password whitespace is significant');
    const fromSignin = (await f.app.inject({ url: '/api/account', cookies: browser.cookies() })).json();
    assert.equal(fromSignin.user.id, f.owners[i].user.id);
    assert.equal(fromSignin.workspaces[0].role, 'owner');
    assert.equal(fromSignin.isStaff, false);
    const demo = await f.app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username: reviewer.username, password: reviewer.password }) });
    assert.equal(demo.statusCode, 200);
    assert.equal(demo.json().to, result.to);
    const fromDemo = (await f.app.inject({ url: '/api/account', cookies: sessionCookie(demo) })).json();
    assert.deepEqual(fromSignin, fromDemo, 'Both forms resolve the same shared product projection');
    browser.clear();
  }
});

test('normal email sign-in keeps the account endpoint, email normalization and verified next destination', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const browser = transport(t, f.app);
  const result = await signInResult({ email: ` ${f.owners[0].user.email.toUpperCase()} `, password: f.ownerPassword }, '/start');
  assert.deepEqual(result, { to: '/start' });
  assert.equal(browser.requests[0].url, '/api/account/signin');
  assert.equal(browser.requests[1].url, '/api/account');
  const account = (await f.app.inject({ url: '/api/account', cookies: browser.cookies() })).json();
  assert.equal(account.demoAccess, undefined, 'A normal account is never converted into a reviewer session');
  assert.equal(account.user.id, f.owners[0].user.id);
});

test('normal account passwords stay unchanged and an unverified email cannot skip verification through next', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const browser = transport(t, f.app);
  const email = 'qa-unverified@signin-qa.invalid';
  await f.store.createUser({ email, name: 'QA ONLY unverified', passwordHash: await hashPassword(f.ownerPassword, { cost: 2 ** 12 }) });
  const before = await f.store.getUserAuthByEmail(email);
  assert.deepEqual(await signInResult({ email, password: f.ownerPassword }, '/w/not-authorized-by-next'), { to: '/verify' });
  assert.deepEqual(await f.store.getUserAuthByEmail(email), before, 'Signing in does not rewrite credentials or verification');
  browser.clear();
  const failed = await signInResult({ email, password: 'QA ONLY wrong account password' });
  assert.equal(failed.to, undefined);
  assert.match(failed.error, /did not match/);
  assert.deepEqual(browser.requests.map((request) => request.url), ['/api/account/signin'], 'A failed email credential never falls through to a reviewer identity');
});

test('unknown, wrong and whitespace-changed reviewer passwords refuse without a session or navigation', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const browser = transport(t, f.app);
  const known = f.reviewers[0];
  for (const fields of [{ email: known.username, password: 'QA ONLY wrong password' }, { email: 'qa-unknown-reviewer', password: known.password }, { email: known.username, password: known.password.trim() }]) {
    const result = await signInResult(fields, '/start');
    assert.equal(result.to, undefined);
    assert.match(result.error, /did not match/);
    assert.equal((await f.app.inject({ url: '/api/account', cookies: browser.cookies() })).json().user, null);
    browser.clear();
  }
});

test('reviewer form dispatch shares the original CSRF and rate limits rather than adding an authentication surface', async (t) => {
  const r = { username: 'qa-rate-reviewer', password: 'QA ONLY rate password', passwordHash: await hashPassword('QA ONLY rate password', { cost: 2 ** 12 }) };
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify([r]) }, rateLimits: { login: 2 } });
  t.after(() => app.close());
  const browser = transport(t, app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.2', headers: { 'content-type': 'application/json' }, payload: json({ username: r.username, password: r.password }) })).statusCode, 403);
  // The two requests simulate /demo then /signin; the latter must use the very same limiter.
  assert.equal((await api.login({ username: r.username, password: 'QA ONLY wrong password' })).status, 401);
  assert.equal((await api.signin({ email: r.username, password: 'QA ONLY wrong password' })).status, 401);
  assert.equal((await api.login({ username: r.username, password: r.password })).status, 429);
  assert.deepEqual(browser.requests.map((request) => request.url), ['/api/login', '/api/login', '/api/login']);
});

test('sign-in handoff preserves admin audit routing and surfaces transport or lost-session errors without navigating', async (t) => {
  let replies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return { ok: value.ok, status: value.status ?? 200, json: async () => value.data };
  });
  replies = [{ ok: true, data: { reviewer: { username: 'qa-audit', role: 'admin' } } }];
  assert.deepEqual(await signInResult({ email: 'qa-audit', password: 'QA ONLY password' }, '/w/foreign'), { to: '/demo/review' });
  replies = [new Error('QA ONLY failed transport')];
  assert.deepEqual(await signInResult({ email: 'qa-audit', password: 'QA ONLY password' }), { error: 'Sign-in failed. Please try again.' });
  replies = [{ ok: true, data: { user: { id: 'qa-only-user' } } }, { ok: true, data: { user: null } }];
  assert.deepEqual(await signInResult({ email: 'qa@example.invalid', password: 'QA ONLY password' }), { error: 'Your workspace could not be loaded. Please try signing in again.' });
});

test('email handoff validates next again and reviewer handoff ignores it and rejects malformed server paths', async (t) => {
  let replies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const value = replies.shift();
    return { ok: true, status: 200, json: async () => value };
  });
  const account = { user: { id: 'qa-only-normal', emailVerifiedAt: '2026-01-01T00:00:00Z' }, workspaces: [{ slug: 'qa-only-own' }] };
  for (const next of ['/\\example.test', '/\n/example.test', '//example.test', '/a/..//example.test']) {
    replies = [{ user: account.user }, account];
    assert.deepEqual(await signInResult({ email: 'qa@example.invalid', password: 'QA ONLY password' }, next), { to: '/w/qa-only-own' });
  }
  replies = [{ user: account.user }, account];
  assert.deepEqual(await signInResult({ email: 'qa@example.invalid', password: 'QA ONLY password' }, '/start?view=jobs#saved'), { to: '/start?view=jobs#saved' });
  for (const to of ['/\\example.test', '/w/../staff', '//example.test', '/w/qa-only\n']) {
    replies = [{ reviewer: { username: 'qa-reviewer' }, to }];
    assert.deepEqual(await signInResult({ email: 'qa-reviewer', password: 'QA ONLY password' }, '/w/foreign'), { to: '/demo/review' });
  }
  replies = [{ reviewer: { username: 'qa-reviewer' }, to: '/w/qa-only-own' }];
  assert.deepEqual(await signInResult({ email: 'qa-reviewer', password: 'QA ONLY password' }, '/\\example.test'), { to: '/w/qa-only-own' });
});
