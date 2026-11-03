import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/lib/tokens.js';
import { detectKind, previewType } from '../src/lib/dataset.js';
import { makeApp, json, postHeaders } from './helpers.js';

const SECRET = 'ingest-secret-for-tests-32-characters!';
const INGEST = { INGEST_PUBLIC_URL: 'http://localhost:4100', INGEST_SHARED_SECRET: SECRET, STAFF_EMAILS: 'reviewer@valcairn.test' };
const ingestClient = { commit: async (key) => key.replace('/pending/', '/uploads/'), remove: async () => {} };

function client(app) {
  let cookies = {};
  const call = async (method, url, body) => {
    const res = await app.inject({ method, url, cookies, headers: method === 'GET' ? {} : postHeaders, payload: body === undefined ? undefined : json(body) });
    const sid = res.cookies.find((c) => c.name === 'valcairn.sid');
    if (sid) cookies = { 'valcairn.sid': sid.value };
    return res;
  };
  return { get: (url) => call('GET', url), post: (url, body = {}) => call('POST', url, body) };
}

async function person(app, email) {
  const c = client(app);
  const s = await c.post('/api/account/signup', { name: email.split('@')[0], email, password: 'long-enough-password' });
  await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

const receipt = (fields) => signToken(SECRET, { v: 1, kind: 'receipt', objectKey: `ws/${fields.ws}/projects/${fields.project}/pending/${Math.random()}`, sha256: 'b'.repeat(64), sizeBytes: 1200, contentType: 'image/png', filename: 'box.png', exp: Math.floor(Date.now() / 1000) + 60, ...fields });

async function setup() {
  const app = await makeApp({ env: INGEST, ingestClient });
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const { project } = (await owner.post(`/api/workspaces/${ws.id}/projects`, { task: 'Spot belt jams on line 2.', modalities: ['Video', 'Audio'], startingPoint: 'own' })).json();
  const base = `/api/workspaces/${ws.id}/projects/${project.id}`;
  await owner.post(base, { dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'], personalData: 'no' } });
  const add = async (fields) => (await owner.post(`${base}/uploads`, { receipt: receipt({ ws: ws.id, project: project.id, by: owner.id, ...fields }) })).json().upload;
  return { app, owner, ws, base, add };
}

test('data types come from the stored content type, and only inert types get inline previews', () => {
  assert.equal(detectKind({ contentType: 'video/mp4', filename: 'a.bin' }), 'video');
  assert.equal(detectKind({ contentType: 'application/x-mcap', filename: 'a.mcap' }), 'robot');
  assert.equal(detectKind({ contentType: 'application/vnd.apache.parquet', filename: 'a.parquet' }), 'table');
  assert.equal(detectKind({ contentType: 'text/plain', filename: 'plc.log' }), 'logs');
  assert.equal(detectKind({ contentType: 'application/x-ndjson', filename: 'a.jsonl' }), 'text');
  assert.equal(detectKind({ contentType: 'application/zip', filename: 'a.zip' }), 'file');
  assert.equal(previewType('image/png'), 'image/png');
  assert.equal(previewType('text/csv'), 'text/plain; charset=utf-8');
  assert.equal(previewType('image/svg+xml'), null);
  assert.equal(previewType('application/pdf'), null);
});

test('the dataset lists items by type with signed previews; viewers see previews but cannot download', async () => {
  const { app, owner, ws, base, add } = await setup();
  const video = await add({ contentType: 'video/mp4', filename: 'dock.mp4', sha256: '1'.repeat(64) });
  await add({ contentType: 'application/x-mcap', filename: 'arm.mcap', sha256: '2'.repeat(64) });
  const res = await owner.get(`${base}/dataset`);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();
  assert.deepEqual(data.items.map((i) => i.kind), ['video', 'robot']);
  assert.equal(data.items[0].objectKey, undefined);
  const url = new URL(data.items[0].previewUrl);
  assert.equal(url.origin + url.pathname, 'http://localhost:4100/v1/preview');
  const grant = verifyToken(SECRET, url.searchParams.get('token'), 'preview');
  assert.equal(grant.type, 'video/mp4');
  assert.match(grant.key, /\/uploads\//);
  assert.equal(data.items[1].previewUrl, null, 'MCAP is not rendered inline');
  const csp = (await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy'];
  assert.match(csp, /media-src 'self' http:\/\/localhost:4100/);
  assert.match(csp, /img-src 'self' http:\/\/localhost:4100/);

  const viewer = await person(app, 'v@acme-robotics.com');
  const token = (await owner.post(`/api/workspaces/${ws.id}/invitations`, { invites: [{ email: 'v@acme-robotics.com', role: 'viewer' }] })).json().devLinks[0].link.split('/invite/')[1];
  await viewer.post(`/api/invitations/${token}/accept`);
  assert.ok((await viewer.get(`${base}/dataset`)).json().items[0].previewUrl);
  assert.equal((await viewer.get(`${base}/items/${video.id}/download`)).statusCode, 403);
  assert.equal((await viewer.post(`${base}/label-set`, { labels: [] })).statusCode, 403);
  const dl = (await owner.get(`${base}/items/${video.id}/download`)).json().url;
  assert.ok(verifyToken(SECRET, new URL(dl).searchParams.get('token'), 'download'));
  await app.close();
});

test('label sets and labels: spans only on timed files, labels in use cannot be removed', async () => {
  const { app, owner, base, add } = await setup();
  const video = await add({ contentType: 'video/mp4', filename: 'dock.mp4', sha256: '1'.repeat(64) });
  const image = await add({ contentType: 'image/png', filename: 'carton.png', sha256: '2'.repeat(64) });
  assert.equal((await owner.post(`${base}/label-set`, { labels: [{ name: 'Jam' }, { name: 'jam' }] })).statusCode, 400);
  const { labelSet } = (await owner.post(`${base}/label-set`, { labels: [{ name: 'belt jam', scope: 'span', tone: 'green' }, { name: 'torn', scope: 'file', tone: 'nope' }] })).json();
  assert.equal(labelSet[1].tone, 'plain');
  const [jam, torn] = labelSet;

  assert.equal((await owner.post(`${base}/items/${image.id}/annotations`, { labelId: jam.id, startMs: 0, endMs: 10 })).statusCode, 400, 'images have no timeline');
  assert.equal((await owner.post(`${base}/items/${video.id}/annotations`, { labelId: jam.id, startMs: 50, endMs: 10 })).statusCode, 400);
  const span = (await owner.post(`${base}/items/${video.id}/annotations`, { labelId: jam.id, startMs: 41000, endMs: 72000 })).json().annotation;
  assert.equal(span.endMs, 72000);
  const tag = (await owner.post(`${base}/items/${image.id}/annotations`, { labelId: torn.id, startMs: 5, endMs: 9 })).json().annotation;
  assert.equal(tag.startMs, null, 'whole-file labels ignore times');

  const removed = await owner.post(`${base}/label-set`, { labels: [jam] });
  assert.equal(removed.json().code, 'label_in_use');
  assert.equal((await owner.post(`${base}/label-set`, { labels: [{ ...jam, scope: 'file' }, torn] })).json().code, 'label_in_use');
  assert.equal((await owner.post(`${base}/label-set`, { labels: [{ ...jam, name: 'jam on belt 2' }, torn] })).json().labelSet[0].id, jam.id, 'renaming keeps the id');
  assert.equal((await owner.post(`${base}/annotations/${tag.id}/delete`)).statusCode, 200);
  assert.equal((await owner.post(`${base}/label-set`, { labels: [jam] })).statusCode, 200);

  const sensor = (await owner.post(`${base}/items/${image.id}`, { kind: 'sensor', offsetMs: 800 })).json().item;
  assert.deepEqual([sensor.kind, sensor.detectedKind, sensor.offsetMs], ['sensor', 'image', 800]);
  assert.equal((await owner.post(`${base}/items/${image.id}`, { kind: 'hologram' })).statusCode, 400);
  assert.equal((await owner.post(`${base}/items/${image.id}`, { kind: null })).json().item.kind, 'image');
  await app.close();
});

test('open issues block review until fixed or noted; the version carries labels and notes, frozen', async () => {
  const { app, owner, base, add } = await setup();
  const first = await add({ contentType: 'video/mp4', filename: 'dock.mp4', sha256: '1'.repeat(64) });
  await add({ contentType: 'video/mp4', filename: 'dock copy.mp4', sha256: '1'.repeat(64) });
  let { issues } = (await owner.get(`${base}/dataset`)).json();
  assert.deepEqual(issues.map((i) => i.key).sort(), [`duplicate:${issues.find((i) => i.key.startsWith('duplicate:')).uploadId}`, 'labels:none'].sort());

  const blocked = await owner.post(`${base}/submit`);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'issues_open');
  assert.equal((await owner.post(`${base}/issues/note`, { key: 'labels:none', note: '' })).statusCode, 400);
  assert.equal((await owner.post(`${base}/issues/note`, { key: 'not-an-issue', note: 'x' })).statusCode, 404);

  const { labelSet } = (await owner.post(`${base}/label-set`, { labels: [{ name: 'belt jam', scope: 'span' }] })).json();
  ({ issues } = (await owner.get(`${base}/dataset`)).json());
  assert.ok(issues.some((i) => i.key === 'unlabelled:video' && i.count === 1), 'the copy is not counted twice');
  await owner.post(`${base}/items/${first.id}/annotations`, { labelId: labelSet[0].id, startMs: 1000, endMs: 2000 });
  const dup = issues.find((i) => i.key.startsWith('duplicate:'));
  await owner.post(`${base}/issues/note`, { key: dup.key, note: 'Recorded twice on purpose; only one copy is reviewed.' });
  ({ issues } = (await owner.get(`${base}/dataset`)).json());
  assert.equal(issues.filter((i) => i.open).length, 0);

  assert.equal((await owner.post(`${base}/submit`)).statusCode, 200);
  assert.equal((await owner.post(`${base}/label-set`, { labels: [] })).json().code, 'project_locked');
  assert.equal((await owner.post(`${base}/items/${first.id}/annotations`, { labelId: labelSet[0].id, startMs: 0, endMs: 1 })).statusCode, 409);
  assert.equal((await owner.post(`${base}/issues/note/delete`, { key: dup.key })).statusCode, 409);

  const staff = await person(app, 'reviewer@valcairn.test');
  const [review] = (await staff.get('/api/staff/reviews')).json().reviews;
  await staff.post(`/api/staff/reviews/${review.id}/decision`, { decision: 'approved', checks: { rights: true, consent: true, labels: true, duplicates: true, format: true } });
  await owner.post(`${base}/dataset-versions`);
  const { versions } = (await owner.get(`${base}/dataset`)).json();
  assert.deepEqual([versions[0].number, versions[0].files.length, versions[0].labels, versions[0].notes], [1, 1, 1, 1]);
  const manifest = await owner.get(`${base}/dataset-versions/1/manifest`);
  assert.match(manifest.headers['content-disposition'], /attachment; filename=".*-v1-manifest\.json"/);
  const body = manifest.json();
  assert.equal(body.files[0].objectKey, undefined);
  assert.equal(body.files[0].kind, 'video');
  assert.equal(body.annotations[0].startMs, 1000);
  assert.equal(body.issueNotes[0].key, dup.key);
  assert.equal((await owner.get(`${base}/dataset-versions/9/manifest`)).statusCode, 404);
  await app.close();
});
