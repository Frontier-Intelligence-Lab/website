import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/lib/tokens.js';
import { makeApp, json, postHeaders } from './helpers.js';

const SECRET = 'ingest-secret-for-tests-32-characters!';
const INGEST = { INGEST_PUBLIC_URL: 'http://localhost:4100', INGEST_SHARED_SECRET: SECRET, STAFF_EMAILS: 'reviewer@valcairn.test' };

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

async function person(app, email, name = email.split('@')[0]) {
  const c = client(app);
  const s = await c.post('/api/account/signup', { name, email, password: 'long-enough-password' });
  await c.post('/api/account/verify', { code: s.json().devCode });
  c.id = s.json().user.id;
  return c;
}

// Stands in for services/ingest: signs a receipt the way the Rust service does.
const receipt = (fields) => signToken(SECRET, { v: 1, kind: 'receipt', objectKey: `ws/${fields.ws}/projects/${fields.project}/uploads/${Math.random()}`, sha256: 'b'.repeat(64), sizeBytes: 1200, contentType: 'image/png', filename: 'box.png', exp: Math.floor(Date.now() / 1000) + 60, ...fields });

async function projectWithData(app, owner) {
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const { project } = (await owner.post(`/api/workspaces/${ws.id}/projects`, { task: 'Flag damaged boxes on line 2.', modalities: ['Images'], startingPoint: 'own' })).json();
  await owner.post(`/api/workspaces/${ws.id}/projects/${project.id}`, { dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'], personalData: 'no' } });
  return { ws, project, base: `/api/workspaces/${ws.id}/projects/${project.id}` };
}

test('uploads are off without ingest configuration', async () => {
  const app = await makeApp();
  const owner = await person(app, 'o@acme-robotics.com');
  const { base } = await projectWithData(app, owner);
  assert.equal((await owner.post(`${base}/upload-grant`)).statusCode, 503);
  assert.equal((await owner.get(base)).json().uploadsEnabled, false);
  await app.close();
});

test('only receipts signed for this project and person are recorded; CSP allows the ingest origin', async () => {
  const app = await makeApp({ env: INGEST });
  const owner = await person(app, 'o@acme-robotics.com');
  const { ws, project, base } = await projectWithData(app, owner);
  const grant = (await owner.post(`${base}/upload-grant`)).json();
  assert.equal(grant.uploadUrl, 'http://localhost:4100/v1/uploads');
  assert.match((await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy'], /connect-src 'self' http:\/\/localhost:4100/);

  const mine = { ws: ws.id, project: project.id, by: owner.id };
  for (const bad of [
    signToken('a-different-secret-of-at-least-32-chars', { ...mine, kind: 'receipt', exp: 9e9 }),
    receipt({ ...mine, project: '00000000-0000-4000-8000-000000000000' }),
    receipt({ ...mine, by: '00000000-0000-4000-8000-000000000000' }),
    receipt({ ...mine, exp: 1 }),
    signToken(SECRET, { ...mine, kind: 'upload', exp: 9e9 }),
  ]) assert.equal((await owner.post(`${base}/uploads`, { receipt: bad })).statusCode, 400);

  const r = receipt(mine);
  const saved = await owner.post(`${base}/uploads`, { receipt: r });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().upload.objectKey, undefined);
  assert.equal((await owner.post(`${base}/uploads`, { receipt: r })).statusCode, 409);
  assert.equal((await owner.get(base)).json().uploads.length, 1);
  await app.close();
});

test('review: submit, independent staff decision, then a frozen dataset version', async () => {
  const app = await makeApp({ env: INGEST });
  const owner = await person(app, 'o@acme-robotics.com');
  const { ws, project, base } = await projectWithData(app, owner);
  assert.equal((await owner.post(`${base}/submit`)).statusCode, 400, 'needs a sample first');
  await owner.post(`${base}/uploads`, { receipt: receipt({ ws: ws.id, project: project.id, by: owner.id }) });
  assert.equal((await owner.post(`${base}/submit`)).statusCode, 200);
  assert.equal((await owner.post(`${base}/submit`)).statusCode, 409);
  assert.equal((await owner.post(`${base}/upload-grant`)).statusCode, 409, 'uploads close during review');
  assert.equal((await owner.post(`${base}/dataset-versions`)).statusCode, 409, 'no version before approval');

  assert.equal((await owner.get('/api/staff/reviews')).statusCode, 404, 'customers cannot see the queue');
  const staff = await person(app, 'reviewer@valcairn.test', 'Reviewer');
  assert.equal((await staff.get('/api/account')).json().isStaff, true);
  const [queued] = (await staff.get('/api/staff/reviews')).json().reviews;
  assert.equal(queued.workspaceName, 'Acme Robotics');
  const detail = (await staff.get(`/api/staff/reviews/${queued.id}`)).json();
  assert.match(detail.uploads[0].downloadUrl, /^http:\/\/localhost:4100\/v1\/objects\?token=/);
  assert.equal(detail.uploads[0].objectKey, undefined);

  const decide = (body) => staff.post(`/api/staff/reviews/${queued.id}/decision`, body);
  assert.equal((await decide({ decision: 'changes_requested' })).statusCode, 400, 'needs notes');
  assert.equal((await decide({ decision: 'approved', checks: { rights: true } })).statusCode, 400, 'needs every check');
  assert.equal((await decide({ decision: 'changes_requested', notes: 'Labels missing on 3 files' })).statusCode, 200);
  const afterChanges = (await owner.get(base)).json();
  assert.equal(afterChanges.project.status, 'changes_requested');
  assert.equal(afterChanges.latestReview.notes, 'Labels missing on 3 files');

  await owner.post(`${base}/submit`);
  const second = (await staff.get('/api/staff/reviews')).json().reviews[0];
  const all = { rights: true, consent: true, labels: true, duplicates: true, format: true };
  assert.equal((await staff.post(`/api/staff/reviews/${second.id}/decision`, { decision: 'approved', checks: all })).statusCode, 200);

  const member = await person(app, 'm@other.com');
  await owner.post(`/api/workspaces/${ws.id}/invitations`, { invites: [{ email: 'm@other.com', role: 'member' }] });
  const v = await owner.post(`${base}/dataset-versions`);
  assert.equal(v.statusCode, 200, v.body);
  assert.equal(v.json().version.number, 1);
  assert.equal(v.json().version.files, 1);
  assert.equal((await owner.get(base)).json().project.status, 'versioned');
  assert.equal((await member.post(`${base}/dataset-versions`)).statusCode, 404);
  await app.close();
});

test('staff cannot review their own workspace', async () => {
  const app = await makeApp({ env: { ...INGEST, STAFF_EMAILS: 'o@acme-robotics.com' } });
  const owner = await person(app, 'o@acme-robotics.com');
  const { ws, project, base } = await projectWithData(app, owner);
  await owner.post(`${base}/uploads`, { receipt: receipt({ ws: ws.id, project: project.id, by: owner.id }) });
  await owner.post(`${base}/submit`);
  const [r] = (await owner.get('/api/staff/reviews')).json().reviews;
  const res = await owner.post(`/api/staff/reviews/${r.id}/decision`, { decision: 'approved', checks: { rights: true, consent: true, labels: true, duplicates: true, format: true } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'conflict_of_interest');
  await app.close();
});

test('invitations: link preview, email must match, single use, revocable', async () => {
  const app = await makeApp();
  const owner = await person(app, 'o@acme-robotics.com');
  const ws = (await owner.post('/api/workspaces', { name: 'Acme Robotics' })).json().workspace;
  const { devLinks } = (await owner.post(`/api/workspaces/${ws.id}/invitations`, { invites: [{ email: 'Fin@Acme-Robotics.com', role: 'finance' }, { email: 'later@acme-robotics.com', role: 'viewer' }] })).json();
  const token = devLinks[0].link.split('/invite/')[1];

  const anon = client(app);
  const preview = (await anon.get(`/api/invitations/${token}`)).json();
  assert.deepEqual(preview, { workspaceName: 'Acme Robotics', role: 'finance', email: 'fin@acme-robotics.com', state: 'valid' });
  assert.equal((await anon.get('/api/invitations/not-a-real-token-at-all-xx')).statusCode, 404);
  assert.equal((await anon.post(`/api/invitations/${token}/accept`)).statusCode, 401);

  const wrong = await person(app, 'someone@else.com');
  const mismatch = await wrong.post(`/api/invitations/${token}/accept`);
  assert.equal(mismatch.statusCode, 403);
  assert.equal(mismatch.json().code, 'email_mismatch');

  const fin = await person(app, 'fin@acme-robotics.com');
  const accepted = await fin.post(`/api/invitations/${token}/accept`);
  assert.deepEqual(accepted.json(), { workspaceSlug: 'acme-robotics', role: 'finance', alreadyMember: false });
  assert.equal((await fin.post(`/api/invitations/${token}/accept`)).statusCode, 409);
  assert.equal((await anon.get(`/api/invitations/${token}`)).json().state, 'used');

  const [pending] = (await owner.get(`/api/workspaces/${ws.id}`)).json().invitations;
  assert.equal(pending.email, 'later@acme-robotics.com');
  assert.equal((await fin.post(`/api/workspaces/${ws.id}/invitations/${pending.id}/revoke`)).statusCode, 403);
  assert.equal((await owner.post(`/api/workspaces/${ws.id}/invitations/${pending.id}/revoke`)).statusCode, 200);
  assert.equal((await anon.get(`/api/invitations/${devLinks[1].link.split('/invite/')[1]}`)).json().state, 'revoked');
  await app.close();
});

test('academic verification is for personal workspaces and academic domains only', async () => {
  const app = await makeApp();
  const student = await person(app, 'jo@gmail.com');
  const personal = (await student.post('/api/workspaces/personal', { kind: 'student' })).json().workspace;
  const url = `/api/workspaces/${personal.id}/academic`;
  assert.equal((await student.post(`${url}/send`, { email: 'jo@gmail.com' })).statusCode, 400);
  const sent = await student.post(`${url}/send`, { email: 'Jo@Uni.ac.uk' });
  assert.equal(sent.statusCode, 200);
  assert.equal((await student.post(`${url}/verify`, { code: sent.json().devCode === '000000' ? '111111' : '000000' })).statusCode, 400);
  const ok = await student.post(`${url}/verify`, { code: sent.json().devCode });
  assert.equal(ok.json().workspace.profile.academicEmail, 'jo@uni.ac.uk');
  assert.ok(ok.json().workspace.profile.academicVerifiedAt);

  const org = (await student.post('/api/workspaces', { name: 'Jo Labs' })).json().workspace;
  assert.equal((await student.post(`/api/workspaces/${org.id}/academic/send`, { email: 'jo@uni.ac.uk' })).statusCode, 400);
  await app.close();
});
