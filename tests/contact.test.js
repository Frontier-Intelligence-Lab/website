import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact } from '../src/lib/contact.js';
import { makeApp, json, postHeaders } from './helpers.js';

const SMTP_ENV = { CONTACT_DELIVERY: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'contact@example.test', SMTP_PASS: 'secret' };
const good = { name: 'Ada', email: 'ada@example.com', organization: 'Analytical Engines', message: 'Hello there.' };
const post = (app, body, headers = postHeaders) => app.inject({ method: 'POST', url: '/api/contact', headers, payload: json(body) });

test('validateContact trims, requires fields and enforces limits', () => {
  assert.equal(validateContact({ ...good, name: '  Ada  ' }).values.name, 'Ada');
  assert.ok(validateContact(good).ok);
  assert.ok(validateContact({}).errors.name && validateContact({}).errors.email && validateContact({}).errors.message);
  assert.ok(validateContact({ ...good, email: 'not-an-email' }).errors.email);
  assert.ok(validateContact({ ...good, message: 'x'.repeat(4001) }).errors.message);
  assert.ok(validateContact({ ...good, website: 'http://spam' }).errors.form);
  assert.ok(!validateContact({ ...good, name: ['array'] }).ok);
});

test('null, array or non-object bodies are invalid input, not a server error', async () => {
  for (const body of [null, [], 'text', 42]) assert.equal(validateContact(body).ok, false, String(body));
  const app = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/contact', headers: postHeaders, payload: 'null' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().errors.name, 'Please tell us your name.');
  await app.close();
});

test('public config exposes the booking link, address and delivery state', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    { ...res.json(), limits: undefined },
    { bookingUrl: 'https://cal.com/ayushozha/15-min-getting-to-know', contactEmail: 'contact@frontierintelligencelab.com', contactConfigured: false, signInConfigured: false, limits: undefined },
  );
  assert.equal(res.json().limits.message, 4000);
  assert.equal((await app.inject({ method: 'GET', url: '/contact' })).statusCode, 200);
  await app.close();
});

test('POST without a same-origin header is rejected', async () => {
  const app = await makeApp();
  assert.equal((await post(app, good, { 'content-type': 'application/json' })).statusCode, 403);
  assert.equal((await post(app, good, { ...postHeaders, origin: 'https://evil.example' })).statusCode, 403);
  await app.close();
});

test('invalid submissions return field errors and send nothing', async () => {
  const sent = [];
  const app = await makeApp({ env: SMTP_ENV, contactTransport: { sendMail: async (m) => { sent.push(m); return { accepted: ['x'] }; } } });
  const res = await post(app, { ...good, email: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().errors.email, /does not look valid/);
  assert.equal(res.json().ok, undefined);
  assert.equal(sent.length, 0);
  await app.close();
});

test('unconfigured delivery fails closed with an honest message', async () => {
  const app = await makeApp();
  const res = await post(app, good);
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /was not sent/);
  await app.close();
});

test('transport failure or rejection never reports success', async () => {
  for (const sendMail of [async () => { throw new Error('ECONNREFUSED'); }, async () => ({ accepted: [], rejected: ['contact@x'] })]) {
    const app = await makeApp({ env: SMTP_ENV, contactTransport: { sendMail } });
    const res = await post(app, good);
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /could not send/);
    assert.equal(res.json().ok, undefined);
    await app.close();
  }
});

test('accepted delivery reports success and sends the right message', async () => {
  const sent = [];
  const app = await makeApp({ env: SMTP_ENV, contactTransport: { sendMail: async (m) => { sent.push(m); return { accepted: [m.to] }; } } });
  const res = await post(app, { ...good, message: '<b>hi</b>' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'contact@frontierintelligencelab.com');
  assert.equal(sent[0].from, 'contact@example.test');
  assert.deepEqual(sent[0].replyTo, { name: 'Ada', address: 'ada@example.com' });
  assert.ok(sent[0].text.includes('Analytical Engines'));
  await app.close();
});

test('contact submissions are rate limited per client', async () => {
  const app = await makeApp({ rateLimits: { contact: 2 } });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(app, good)).statusCode);
  assert.deepEqual(codes, [503, 503, 429]);
  await app.close();
});
