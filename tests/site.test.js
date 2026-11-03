import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, postHeaders } from './helpers.js';

test('pages serve the React shell with self-hosted scripts only, no cookies and strict headers', async () => {
  const app = await makeApp();
  for (const url of ['/', '/contact', '/demo']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.ok(res.body.includes('<div id="root">'), url);
    assert.equal(res.headers['set-cookie'], undefined, url);
  }
  const csp = (await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy'];
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  await app.close();
});

test('unknown pages get the app shell with a 404; unknown API and build paths get JSON 404s', async () => {
  const app = await makeApp();
  const page = await app.inject({ method: 'GET', url: '/no-such-page' });
  assert.equal(page.statusCode, 404);
  assert.ok(page.body.includes('<div id="root">'));
  for (const url of ['/api/nope', '/assets/missing.js', '/private/missing.js']) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok([401, 404].includes(res.statusCode), url);
    assert.ok(!res.body.includes('<div id="root">'), url);
  }
  await app.close();
});

test('build assets are served with long caching; nothing outside the build is reachable', async () => {
  const app = await makeApp();
  const bundle = await app.inject({ method: 'GET', url: '/assets/index-test.js' });
  assert.equal(bundle.statusCode, 200);
  assert.match(bundle.headers['cache-control'], /immutable/);
  assert.equal((await app.inject({ method: 'GET', url: '/favicon.svg' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/fonts/LICENSE-Inter-OFL.txt' })).statusCode, 200);
  for (const url of ['/assets/../index.html', '/assets/..%2fpackage.json', '/src/config.js', '/package.json', '/index.html']) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok(!res.body.includes('"dependencies"') && !res.body.includes('loadConfig'), url);
    assert.notEqual(res.headers['content-type'], 'application/javascript; charset=utf-8', url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  await app.close();
});

test('oversized API bodies are rejected with a JSON error', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/contact', headers: postHeaders, payload: JSON.stringify({ message: 'a'.repeat(40_000) }) });
  assert.equal(res.statusCode, 413);
  assert.match(res.json().error, /too large/);
  await app.close();
});
