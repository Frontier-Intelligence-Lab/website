import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib/passwords.js';
import { makeApp, json, postHeaders, sessionCookie } from './helpers.js';

async function accounts() {
  const hash = (pw) => hashPassword(pw, { cost: 2 ** 12 });
  return [
    { username: 'boss', name: 'Boss', role: 'admin', passwordHash: await hash('boss-secret-1') },
    { username: 'guest', name: 'Guest', passwordHash: await hash('guest-secret-2') },
  ];
}

const login = (app, username, password) =>
  app.inject({ method: 'POST', url: '/api/login', headers: postHeaders, payload: json({ username, password }) });
const signins = (app, cookies) => app.inject({ method: 'GET', url: '/api/admin/signins', cookies });

test('roles default to viewer and unknown roles are rejected', async () => {
  const { parseReviewers } = await import('../src/lib/reviewers.js');
  assert.equal(parseReviewers('[{"username":"a","passwordHash":"scrypt$x"}]')[0].role, 'viewer');
  assert.equal(parseReviewers('[{"username":"a","role":"admin","passwordHash":"scrypt$x"}]')[0].role, 'admin');
  assert.throws(() => parseReviewers('[{"username":"a","role":"owner","passwordHash":"scrypt$x"}]'), /unknown role/);
});

test('sign-ins, sign-outs and failures are recorded; only admins can read them', async () => {
  const app = await makeApp({ env: { REVIEWERS_JSON: JSON.stringify(await accounts()) } });

  assert.equal((await signins(app, {})).statusCode, 401);
  assert.equal((await login(app, 'guest', 'wrong-password')).statusCode, 401);
  assert.equal((await login(app, 'typed-my-password-here', 'x')).statusCode, 401);
  const guest = sessionCookie(await login(app, 'GUEST', 'guest-secret-2'));
  const denied = await signins(app, guest);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().events, undefined);
  await app.inject({ method: 'POST', url: '/api/logout', headers: postHeaders, cookies: guest, payload: '{}' });

  const boss = sessionCookie(await login(app, 'boss', 'boss-secret-1'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/session', cookies: boss })).json().reviewer.role, 'admin');
  const res = await signins(app, boss);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  const events = res.json().events.map(({ event, username }) => `${event}:${username}`);
  // Newest first; the unknown username is never stored.
  assert.deepEqual(events, ['signin:boss', 'signout:guest', 'signin:guest', 'failed:null', 'failed:guest']);
  assert.ok(!JSON.stringify(res.json()).includes('typed-my-password-here'));
  assert.ok(res.json().events.every((e) => !Number.isNaN(Date.parse(e.at))));
  await app.close();
});

test('the sign-in log persists to SIGNIN_LOG_FILE across restarts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signins-'));
  const file = path.join(dir, 'signins.jsonl');
  try {
    const env = { REVIEWERS_JSON: JSON.stringify(await accounts()), SIGNIN_LOG_FILE: file };
    const first = await makeApp({ env });
    await login(first, 'guest', 'guest-secret-2');
    await first.close();
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);

    const second = await makeApp({ env });
    const boss = sessionCookie(await login(second, 'boss', 'boss-secret-1'));
    const events = (await signins(second, boss)).json().events.map((e) => `${e.event}:${e.username}`);
    assert.deepEqual(events, ['signin:boss', 'signin:guest']);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
