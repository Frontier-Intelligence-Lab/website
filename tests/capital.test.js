import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { MAX_AMOUNT_CENTS, capitalSnapshot, formatUsd, parseUsd, sumCents, totalsByBasis, validateCapitalDraft, validateCreditRecord, validateEvidence } from '../src/lib/capital.js';
import { canonical, snapshotHash } from '../src/lib/capital-hash.js';
import { makeApp, json, postHeaders, reviewerFixture } from './helpers.js';

// Everything here is a labelled synthetic QA company; no real company, money or lender exists.
const STAFF = 'staff@valcairn-qa.example';

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

const item = (extra = {}) => ({ category: 'compute', label: 'GPU hours for the first fine-tune', amountCents: 250000, period: 'one_time', basis: 'estimated', source: 'Provider price list, read on the date shown', observedAt: '2026-11-01', ...extra });
const draft = (extra = {}) => ({
  purpose: 'Finance the first fine-tune and a pilot deployment', requestedAmountCents: 5000000, timing: { neededBy: '2027-01-15', termMonths: 12 },
  company: { legalName: 'QA ONLY Synthetic Robotics Ltd', registrationRef: 'QA-0001', country: 'Testland', foundedYear: 2024, employees: 8, website: 'https://qa.example', description: 'A synthetic company used only for QA.' },
  costItems: [item()], references: [{ kind: 'incorporation', title: 'Certificate of incorporation', source: 'Company registry record QA-0001' }], datasetVersions: [], ...extra,
});
const credit = (extra = {}) => ({ provider: 'Cloud provider (synthetic)', status: 'claimed', amountCents: 1000000, expiresOn: '2027-06-30', restrictions: 'Compute only; not transferable', reference: '', ...extra });
const record = (title = 'Storage invoice, October (synthetic)') => ({ kind: 'company_record', title, source: 'Invoice QA-INV-10, held by the company' });
// The hash of what sending would freeze, as the owner sees it on the page.
const hashOf = async (c, casePath) => (await c.get(casePath)).json().contentHash;
const send = async (c, casePath, expectedRevision, contentHash) => c.post(`${casePath}/submit`, { expectedRevision, contentHash: contentHash ?? await hashOf(c, casePath), sendToReview: true });

// A synthetic QA organization with one frozen dataset version, one enhance plan and one measured run on the owner's device.
async function setup() {
  const store = createMemoryStore();
  const reviewer = await reviewerFixture();
  const app = await makeApp({ store, env: { STAFF_EMAILS: STAFF, REVIEWERS_JSON: JSON.stringify([{ username: 'ycinsider', name: 'YC reviewer', role: 'viewer', passwordHash: reviewer.passwordHash }]) } });
  const owner = await person(app, 'owner@qa-synthetic.example');
  const ws = (await owner.post('/api/workspaces', { name: 'QA ONLY Synthetic Robotics' })).json().workspace;
  const { project } = (await owner.post(`/api/workspaces/${ws.id}/projects`, { name: 'Support chats', task: 'Answer returns questions by policy.', modalities: ['Text'], startingPoint: 'own' })).json();
  const where = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...where, patch: { success: { measure: 'recall', target: '95%' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training'] } } });
  const review = await store.submitForReview({ ...where, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  await store.createDatasetVersion({ ...where, createdBy: owner.id });
  const run = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'assistant', baseModelId: 'demo-base', datasets: [], steps: ['sft'], compute: null, spendCapUsd: null } });
  const device = await store.createDevice({ workspaceId: ws.id, ownerId: owner.id, label: 'Owner laptop' });
  const bench = await store.recordExecutionRun({ workspaceId: ws.id, ownerId: owner.id, deviceId: device.id, run: { installId: null, modelRef: 'demo-chat:0.6b', modelDigest: 'a'.repeat(64), location: 'local_runtime', kind: 'chat', warm: true, status: 'completed', failure: null, settings: {}, metrics: { wallMs: 1500, outputTokens: 100, evalMs: 1000, tokensPerSec: 100 }, task: null, promptSha256: null } });
  const join = async (email, role) => {
    const c = await person(app, email);
    await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email, role, tokenHash: `${email}-token`, expiresAt: new Date(Date.now() + 86400000) }] });
    await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash(`${email}-token`)).id, userId: c.id });
    return c;
  };
  return { app, store, owner, ws, project, run, device, bench, join, reviewerPassword: reviewer.password, base: `/api/workspaces/${ws.id}/capital` };
}

test('money is cents only: parsing, formatting and sums refuse anything that is not a safe whole number', () => {
  assert.equal(parseUsd('1,234.56'), 123456);
  assert.equal(parseUsd('$80'), 8000);
  assert.equal(parseUsd('0.5'), 50);
  assert.equal(parseUsd('10,000,000,000'), MAX_AMOUNT_CENTS);
  for (const bad of ['12.345', '-5', '1e3', '', ' ', '10,000,000,000.01', '99999999999', 1234, null, undefined, {}]) assert.equal(parseUsd(bad), null, String(bad));
  assert.equal(formatUsd(123456), '$1,234.56');
  assert.equal(formatUsd(5), '$0.05');
  assert.equal(formatUsd(0), '$0.00');
  for (const bad of [-1, 1.5, '100', NaN, Infinity, MAX_AMOUNT_CENTS + 1]) assert.equal(formatUsd(bad), '—', String(bad));
  assert.equal(sumCents([1, 2, 3]), 6);
  assert.equal(sumCents([]), 0);
  for (const bad of [[1, 0.5], ['1'], [NaN], [-1], [MAX_AMOUNT_CENTS + 1], [2 ** 53]]) assert.equal(sumCents(bad), null, JSON.stringify(bad));
});

test('totals are kept apart by basis and by period: no horizon, no proration, nothing added across either', () => {
  const totals = totalsByBasis([item({ amountCents: 100 }), item({ amountCents: 100, period: 'monthly' }), item({ amountCents: 100, period: 'annual' }), item({ amountCents: 200, basis: 'quoted' }), item({ amountCents: 7, basis: 'incurred', period: 'monthly' }), item({ amountCents: 1, basis: 'incurred', period: 'monthly' })]);
  assert.deepEqual(totals, {
    quoted: { one_time: 200, monthly: 0, annual: 0 },
    estimated: { one_time: 100, monthly: 100, annual: 100 },
    incurred: { one_time: 0, monthly: 8, annual: 0 },
  });
  assert.equal(Object.values(totals.estimated).some((v) => v === 300), false, 'periods are never summed into one figure');
  assert.equal(totalsByBasis([item({ amountCents: 1.5 })]).estimated.one_time, null, 'a bad amount yields no total');
});

test('the content hash is canonical: key order and store normalization do not change it, content does', () => {
  assert.equal(canonical({ b: [1, { z: 1, a: null }], a: 'x' }), '{"a":"x","b":[1,{"a":null,"z":1}]}');
  const a = snapshotHash({ title: 'T', draft: { purpose: 'p', costItems: [{ id: 'x', amountCents: 1 }] }, credits: [], evidence: [] });
  const b = snapshotHash({ evidence: [], credits: [], draft: { costItems: [{ amountCents: 1, id: 'x' }], purpose: 'p' }, title: 'T' });
  assert.equal(a, b);
  assert.notEqual(a, snapshotHash({ title: 'T', draft: { purpose: 'p', costItems: [{ id: 'x', amountCents: 2 }] }, credits: [], evidence: [] }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('a draft is validated strictly: primitive cents, bounded lists, calendar days, same-workspace links and evidence for incurred costs', () => {
  const versions = [{ projectId: 'p1', version: 1 }];
  const evidenceIds = new Set(['e1']);
  const check = (patch, opts = {}) => validateCapitalDraft(draft(patch), { versions, evidenceIds, ...opts });
  for (const bad of ['5000000', 50.5, -1, 0, MAX_AMOUNT_CENTS + 1, 1e21, true, [500], {}, '']) assert.ok(check({ requestedAmountCents: bad }).errors?.requestedAmountCents, `amount ${JSON.stringify(bad)}`);
  assert.equal(check({ requestedAmountCents: null }).values.requestedAmountCents, null, 'a draft may leave the amount empty');
  assert.ok(check({ costItems: Array.from({ length: 41 }, () => item()) }).errors.costItems);
  assert.match(check({ costItems: [item({ category: 'gpu' })] }).errors.costItems, /compute, deployment/);
  assert.match(check({ costItems: [item({ amountCents: 12.5 })] }).errors.costItems, /whole US cents/);
  assert.match(check({ costItems: [item({ amountCents: '100' })] }).errors.costItems, /whole US cents/);
  assert.match(check({ costItems: [item({ observedAt: '2026-02-30' })] }).errors.costItems, /calendar day/);
  assert.match(check({ costItems: [item({ source: '' })] }).errors.costItems, /where the figure comes from/);
  assert.match(check({ costItems: [item({ basis: 'incurred' })] }).errors.costItems, /cite an evidence record/);
  assert.match(check({ costItems: [item({ basis: 'incurred', evidenceId: 'other' })] }).errors.costItems, /cite an evidence record/);
  const incurred = check({ costItems: [item({ basis: 'incurred', evidenceId: 'e1' }), item({ evidenceId: 'e1' })] }).values.costItems;
  assert.equal(incurred[0].evidenceId, 'e1');
  assert.equal(incurred[1].evidenceId, null, 'only incurred costs cite evidence');
  assert.ok(incurred.every((i) => /^[A-Za-z0-9_-]{1,40}$/.test(i.id)), 'items get ids');
  assert.match(check({ datasetVersions: [{ projectId: 'p2', version: 1 }] }).errors.datasetVersions, /frozen dataset versions of this workspace/);
  assert.deepEqual(check({ datasetVersions: [{ projectId: 'p1', version: 1 }, { projectId: 'p1', version: 1 }] }).values.datasetVersions, [{ projectId: 'p1', version: 1 }]);
  assert.ok(check({ company: { foundedYear: 'abc' } }).errors.company);
  assert.ok(check({ company: { employees: -1 } }).errors.company);
  assert.ok(check({ timing: { termMonths: 121 } }).errors.timing);
  assert.ok(check({ references: Array.from({ length: 21 }, () => ({ kind: 'other', title: 'x' })) }).errors.references);
  const missing = validateCapitalDraft({}, { forSubmit: true }).errors;
  assert.deepEqual(Object.keys(missing).sort(), ['company', 'costItems', 'purpose', 'requestedAmountCents']);
  assert.ok(validateCapitalDraft({}).values, 'an empty draft is a valid draft');
});

test('credit records and evidence are validated: evidenced credits need a reference; evidence cites only what the person may cite', () => {
  assert.ok(validateCreditRecord(credit()).values);
  assert.ok(validateCreditRecord(credit({ status: 'evidenced' })).errors.reference);
  assert.ok(validateCreditRecord(credit({ status: 'evidenced', reference: 'CONF-1' })).values);
  for (const bad of ['100', 1.5, -1, MAX_AMOUNT_CENTS + 1, null]) assert.ok(validateCreditRecord(credit({ amountCents: bad })).errors.amountCents, String(bad));
  assert.ok(validateCreditRecord(credit({ expiresOn: 'June 2027' })).errors.expiresOn);
  assert.ok(validateCreditRecord(credit({ status: 'spendable' })).errors.status);
  const options = { versions: [{ projectId: 'p1', projectName: 'Chats', version: 1, reviewId: 'r1', files: 3, createdAt: 'x' }], runs: [], benchmarks: [{ deviceId: 'd1', runId: 'x1', modelRef: 'demo-chat:0.6b', metrics: { tokensPerSec: 100 } }], credits: [{ id: 'c1', provider: 'P', status: 'claimed', restrictions: 'Compute only', expiresOn: null }] };
  assert.equal(validateEvidence({ kind: 'local_benchmark', title: 'Laptop', reference: { deviceId: 'd1', runId: 'x1' } }, options).values.verification, 'client_reported');
  assert.ok(validateEvidence({ kind: 'local_benchmark', title: 'Laptop', reference: { deviceId: 'd2', runId: 'x1' } }, options).errors.reference);
  assert.deepEqual(validateEvidence({ kind: 'dataset_provenance', title: 'Chats v1', reference: { projectId: 'p1', version: 1 } }, options).values.reference, { projectId: 'p1', projectName: 'Chats', version: 1, reviewId: 'r1', files: 3, createdAt: 'x' });
  assert.ok(validateEvidence({ kind: 'credit_restriction', title: 'Terms', reference: { creditRecordId: 'c2' } }, options).errors.reference);
  assert.ok(validateEvidence({ kind: 'company_record', title: 'Bank statement' }, options).errors.source, 'a company record needs to say where it lives');
  assert.ok(validateEvidence({ kind: 'lender_approval', title: 'x' }, options).errors.kind);
});

test('capital is for owners, admins and finance of an organization; members, viewers, strangers and demo reviewers get nothing', async () => {
  const { app, owner, ws, base, join, reviewerPassword } = await setup();
  const admin = await join('admin@qa-synthetic.example', 'admin');
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const member = await join('member@qa-synthetic.example', 'member');
  const viewer = await join('viewer@qa-synthetic.example', 'viewer');
  for (const c of [owner, admin, finance]) assert.equal((await c.get(base)).statusCode, 200);
  const created = (await finance.post(`${base}/cases`, { title: 'Pilot deployment' })).json().case;
  const casePath = `${base}/cases/${created.id}`;
  for (const [name, c] of [['member', member], ['viewer', viewer]]) {
    assert.equal((await c.get(base)).statusCode, 403, name);
    assert.equal((await c.get(casePath)).statusCode, 403, name);
    assert.equal((await c.get(`${casePath}/export`)).statusCode, 403, `${name} export`);
    assert.equal((await c.post(`${base}/cases`, { title: 'x' })).statusCode, 403, name);
    assert.equal((await c.post(casePath, { expectedRevision: 1, draft: draft() })).statusCode, 403, name);
    assert.equal((await c.post(`${casePath}/submit`, { expectedRevision: 1, contentHash: 'a'.repeat(64), sendToReview: true })).statusCode, 403, name);
    assert.equal((await c.post(`${casePath}/evidence`, record())).statusCode, 403, name);
    assert.equal((await c.post(`${base}/credits`, credit())).statusCode, 403, name);
  }
  assert.equal((await finance.post(`${casePath}/submit`, { expectedRevision: 1, contentHash: 'a'.repeat(64), sendToReview: true })).statusCode, 403, 'finance prepares; owners and admins send');
  assert.equal((await finance.post(`${casePath}/withdraw`)).statusCode, 403);
  const stranger = await person(app, 'stranger@elsewhere.example');
  assert.equal((await stranger.get(base)).statusCode, 404);
  assert.equal((await stranger.get(casePath)).statusCode, 404);
  assert.equal((await stranger.get(`${casePath}/export`)).statusCode, 404);
  assert.equal((await client(app).get(base)).statusCode, 401);
  assert.equal((await client(app).get(`${casePath}/export`)).statusCode, 401);
  // Demo reviewer accounts sign in to /demo only; they are neither customers nor finance staff.
  const reviewer = client(app);
  assert.equal((await reviewer.post('/api/login', { username: 'ycinsider', password: reviewerPassword })).statusCode, 200);
  assert.equal((await reviewer.get(base)).statusCode, 401);
  assert.equal((await reviewer.get(`${casePath}/export`)).statusCode, 401);
  assert.equal((await reviewer.get('/api/staff/capital')).statusCode, 401);
  assert.equal((await reviewer.post(`/api/staff/capital/${created.id}/decision`, { decision: 'evidence_reviewed', submissionId: created.id })).statusCode, 401);
  // Customers who are not staff cannot reach the review queue.
  assert.equal((await owner.get('/api/staff/capital')).statusCode, 404);
  assert.equal((await owner.get(`/api/staff/capital/${created.id}`)).statusCode, 404);
  // A personal workspace has no capital module.
  const personal = (await owner.post('/api/workspaces/personal', { kind: 'independent' })).json().workspace;
  assert.equal((await owner.get(`/api/workspaces/${personal.id}/capital`)).statusCode, 404);
  // The workspace summary a member sees carries no capital fields.
  assert.equal(JSON.stringify((await member.get(`/api/workspaces/${ws.id}`)).json()).includes('Cents'), false);
});

test('cases, credits and evidence are reachable only through their own workspace', async () => {
  const { app, owner, base, project, run } = await setup();
  const other = await person(app, 'other@qa-other.example');
  const ws2 = (await other.post('/api/workspaces', { name: 'QA ONLY Other Co' })).json().workspace;
  const base2 = `/api/workspaces/${ws2.id}/capital`;
  const kase = (await owner.post(`${base}/cases`, { title: 'Pilot', projectId: project.id, enhanceRunId: run.id })).json().case;
  assert.equal(kase.projectId, project.id);
  const theirs = (await other.post(`${base2}/cases`, { title: 'Theirs' })).json().case;
  const credit1 = (await owner.post(`${base}/credits`, credit())).json().credit;
  const ev = (await owner.post(`${base}/cases/${kase.id}/evidence`, record('Statement'))).json().evidence;
  // Linking another workspace's project or run is refused as a validation error; the id is not confirmed to exist.
  const linked = await other.post(`${base2}/cases`, { title: 'x', projectId: project.id, enhanceRunId: run.id });
  assert.equal(linked.statusCode, 400);
  assert.deepEqual(Object.keys(linked.json().errors).sort(), ['enhanceRunId', 'projectId']);
  assert.equal((await other.get(`${base2}/cases/${kase.id}`)).statusCode, 404);
  assert.equal((await other.post(`${base2}/cases/${kase.id}`, { expectedRevision: 1, draft: draft() })).statusCode, 404);
  assert.equal((await other.post(`${base2}/cases/${kase.id}/submit`, { expectedRevision: 1, contentHash: 'a'.repeat(64), sendToReview: true })).statusCode, 404);
  assert.equal((await other.get(`${base2}/cases/${kase.id}/export`)).statusCode, 404);
  assert.equal((await other.post(`${base2}/cases/${kase.id}/evidence/${ev.id}/delete`)).statusCode, 404);
  assert.equal((await other.post(`${base2}/cases/${theirs.id}/evidence/${ev.id}/delete`)).statusCode, 404, 'evidence of another case');
  assert.equal((await other.post(`${base2}/credits`, credit({ supersedes: credit1.id }))).statusCode, 404, 'correcting another workspace’s record');
  assert.equal((await other.post(`${base2}/cases/${theirs.id}`, { expectedRevision: 1, draft: draft({ datasetVersions: [{ projectId: project.id, version: 1 }] }) })).statusCode, 400, 'linking another workspace’s version');
  assert.equal((await owner.get(base)).json().cases.length, 1);
  assert.equal((await other.get(base2)).json().credits.length, 0);
});

test('plan, request and evidence: finance prepares, an owner sends an exact revision, staff review it, corrections make a new revision', async () => {
  const { app, store, owner, ws, base, project, device, bench, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await finance.post(`${base}/cases`, { title: 'Pilot deployment', projectId: project.id })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  assert.deepEqual([kase.status, kase.revision, kase.submittedRevision], ['draft', 1, null]);

  // Evidence: bounded references to things that exist. A benchmark can only cite the person's own device.
  const ev1 = (await owner.post(`${casePath}/evidence`, { kind: 'dataset_provenance', title: 'Support chats v1', reference: { projectId: project.id, version: 1 } })).json().evidence;
  assert.equal(ev1.verification, 'unverified');
  assert.equal(ev1.reference.files, 0);
  const ev2 = (await owner.post(`${casePath}/evidence`, { kind: 'local_benchmark', title: 'Laptop throughput', reference: { deviceId: device.id, runId: bench.id } })).json().evidence;
  assert.equal(ev2.verification, 'client_reported');
  assert.equal(ev2.reference.metrics.tokensPerSec, 100);
  assert.equal((await finance.post(`${casePath}/evidence`, { kind: 'local_benchmark', title: 'Not mine', reference: { deviceId: device.id, runId: bench.id } })).statusCode, 400);
  const ev3 = (await finance.post(`${casePath}/evidence`, record())).json().evidence;
  assert.equal((await finance.post(`${casePath}/evidence`, { kind: 'company_record', title: 'No source' })).statusCode, 400);
  const credit1 = (await finance.post(`${base}/credits`, credit())).json().credit;
  assert.equal(credit1.status, 'claimed');

  // The plan: quoted, estimated and incurred stay apart, and so do periods; an incurred cost cites a real evidence record.
  const items = [item(), item({ basis: 'quoted', amountCents: 400000, label: 'Edge box', category: 'equipment' }), item({ basis: 'incurred', amountCents: 12345, evidenceId: ev3.id, label: 'Storage used in October', category: 'storage', period: 'monthly' })];
  const saved = await finance.post(casePath, { expectedRevision: 1, draft: draft({ costItems: items, datasetVersions: [{ projectId: project.id, version: 1 }] }) });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().case.revision, 2);
  assert.equal(saved.json().contentHash, undefined, 'a save carries no consent hash; sending needs the case view');
  const totals = (await owner.get(base)).json().cases[0].totals;
  assert.deepEqual(totals.quoted, { one_time: 400000, monthly: 0, annual: 0 });
  assert.deepEqual(totals.estimated, { one_time: 250000, monthly: 0, annual: 0 });
  assert.deepEqual(totals.incurred, { one_time: 0, monthly: 12345, annual: 0 });
  assert.equal((await finance.post(casePath, { expectedRevision: 2, draft: draft({ costItems: [item({ basis: 'incurred' })] }) })).statusCode, 400, 'incurred without evidence');
  assert.equal((await finance.post(`${casePath}/evidence/${ev3.id}/delete`)).json().code, 'evidence_in_use');
  const stale = await finance.post(casePath, { expectedRevision: 1, draft: draft() });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_revision');
  assert.equal((await finance.post(casePath, { draft: draft() })).statusCode, 400, 'the revision edited must be named');

  // Sending: explicit consent, the exact revision and content, by an owner. Retrying the same revision does not send twice.
  const hash = await hashOf(owner, casePath);
  assert.equal((await owner.post(`${casePath}/submit`, { expectedRevision: 2, contentHash: hash })).json().code, 'consent_required');
  assert.equal((await owner.post(`${casePath}/submit`, { expectedRevision: 2, sendToReview: true })).json().code, 'content_hash_required');
  assert.equal((await send(owner, casePath, 1)).json().code, 'stale_revision');
  const sent = await send(owner, casePath, 2);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().submission.revision, 2);
  assert.equal(sent.json().submission.contentHash, hash);
  assert.equal(sent.json().submission.snapshot, undefined, 'the response carries no snapshot copy');
  assert.equal(sent.json().case.status, 'submitted');
  const again = await send(owner, casePath, 2, hash);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().submission.id, sent.json().submission.id, 'a retry gets the same submission');
  assert.equal((await store.listAudit(ws.id)).filter((e) => e.action === 'capital.submitted').length, 1);
  assert.equal((await owner.get(casePath)).json().submissions.length, 1);

  // Frozen while it is with internal review.
  assert.equal((await finance.post(casePath, { expectedRevision: 2, draft: draft() })).json().code, 'case_submitted');
  assert.equal((await finance.post(`${casePath}/evidence`, record('Late'))).json().code, 'case_submitted');
  assert.equal((await finance.post(`${casePath}/evidence/${ev1.id}/delete`)).json().code, 'case_submitted');
  assert.equal((await send(owner, casePath, 3, hash)).json().code, 'case_submitted');

  // Staff see the submitted snapshot, never the live draft; opening it is recorded for the customer.
  const queue = (await staff.get('/api/staff/capital')).json().cases;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].requestedAmountCents, 5000000);
  assert.equal(queue[0].title, 'Pilot deployment');
  assert.equal(queue[0].workspaceName, 'QA ONLY Synthetic Robotics');
  const view = (await staff.get(`/api/staff/capital/${kase.id}`)).json();
  assert.equal(view.case.draft, undefined);
  assert.equal(view.case.title, undefined);
  assert.equal(view.evidence, undefined, 'no live evidence list');
  assert.equal(view.credits, undefined, 'no live credit list');
  const sub = view.submission;
  assert.equal(sub.id, sent.json().submission.id);
  assert.equal(sub.snapshot.draft.requestedAmountCents, 5000000);
  assert.deepEqual(sub.snapshot.totals.incurred, { one_time: 0, monthly: 12345, annual: 0 });
  assert.equal(sub.snapshot.credits[0].status, 'claimed');
  assert.equal(sub.snapshot.evidence.length, 3);
  assert.equal(view.conflict, false);
  assert.ok((await store.listAudit(ws.id)).some((e) => e.action === 'capital.review_opened' && e.actorId === staff.id && e.metadata.submissionId === sub.id));
  for (const decision of ['approved', 'funded', 'offer', 'rejected']) assert.equal((await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision, submissionId: sub.id })).statusCode, 400, decision);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed' })).statusCode, 400, 'the submission seen must be named');
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev3.id}/review`, {})).statusCode, 400);
  const marked = await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev3.id}/review`, { submissionId: sub.id });
  assert.equal(marked.statusCode, 200, marked.body);
  assert.deepEqual([marked.json().mark.submissionId, marked.json().mark.evidenceId], [sub.id, ev3.id]);
  assert.equal(marked.json().mark.reviewerId, undefined);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev3.id}/review`, { submissionId: sub.id })).json().mark.id, marked.json().mark.id, 'marking twice is one mark');
  assert.equal((await staff.get(`/api/staff/capital/${kase.id}`)).json().marks.length, 1);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'changes_requested', submissionId: sub.id })).statusCode, 400, 'changes need notes');
  const changes = await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'changes_requested', submissionId: sub.id, notes: 'Add the quote for the edge box.' });
  assert.equal(changes.statusCode, 200, changes.body);
  const afterChanges = (await owner.get(casePath)).json();
  assert.equal(afterChanges.case.status, 'changes_requested');
  assert.equal(afterChanges.submissions[0].decision, 'changes_requested');
  assert.equal(afterChanges.submissions[0].notes, 'Add the quote for the edge box.');
  assert.deepEqual(afterChanges.marks.map((m) => [m.submissionId, m.evidenceId]), [[sub.id, ev3.id]]);
  assert.equal(afterChanges.evidence.find((e) => e.id === ev3.id).verification, 'unverified', 'the customer’s record itself is untouched');
  assert.equal((await staff.get('/api/staff/capital')).json().cases.length, 0, 'the queue holds only submitted cases');
  assert.equal((await staff.get('/api/staff/capital?status=changes_requested')).json().cases.length, 1);

  // A correction is a new revision; the same revision cannot be sent twice.
  assert.equal((await send(owner, casePath, 2)).json().code, 'revision_sent');
  const corrected = await finance.post(casePath, { expectedRevision: 2, draft: draft({ costItems: [items[0], { ...items[1], basis: 'quoted', source: 'Vendor quote Q-77, 2026-11-03' }, items[2]] }) });
  assert.equal(corrected.json().case.revision, 3);
  const resent = await send(owner, casePath, 3);
  assert.equal(resent.statusCode, 200, resent.body);
  assert.equal(resent.json().submission.revision, 3);
  const sub2 = resent.json().submission.id;
  const done = await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: sub2, notes: 'Cost assumptions and records looked at.' });
  assert.equal(done.statusCode, 200, done.body);
  const final = (await owner.get(casePath)).json();
  assert.equal(final.case.status, 'evidence_reviewed');
  assert.equal(final.submissions.length, 2);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: sub2 })).json().code, 'not_submitted');
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev1.id}/review`, { submissionId: sub2 })).json().code, 'not_submitted');
  // Reviewed is still editable: the draft moves on, the reviewed revision stays on record.
  assert.equal((await finance.post(casePath, { expectedRevision: 3, draft: draft() })).json().case.revision, 4);
  assert.equal((await owner.get(casePath)).json().case.status, 'evidence_reviewed');

  // The export is the sent revision exactly as frozen, staff annotations apart, recorded, and says what it is not.
  const exported = await owner.get(`${casePath}/export`);
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers['content-disposition'], /^attachment; filename="Pilot-deployment-evidence-r3\.json"$/);
  const pkg = exported.json();
  assert.equal(pkg.basis, 'submitted_revision');
  assert.equal(pkg.submission.revision, 3);
  assert.equal(pkg.review.decision, 'evidence_reviewed');
  assert.deepEqual(pkg.review.marks, [], 'marks belong to the revision they were made on');
  assert.equal(pkg.content.plan.costItems.length, 3);
  assert.equal(pkg.content.request.requestedAmountCents, 5000000);
  assert.equal(pkg.content.credits.length, 1);
  assert.equal(pkg.content.evidence.length, 3);
  assert.deepEqual(pkg.asOf, { caseId: kase.id, caseStatus: 'evidence_reviewed', caseRevision: 4, submittedRevision: 3, draftChangedSinceSent: true });
  assert.ok(pkg.statements.some((s) => /not verified revenue, a credit decision, lender eligibility/.test(s)));
  assert.ok(pkg.statements.some((s) => /not a Valcairn balance/.test(s)));
  assert.ok(pkg.planned.includes('funding') && pkg.planned.includes('document_upload'));
  assert.doesNotMatch(exported.body, /objectKey|passwordHash|balance":|reviewerId/);
  assert.ok((await store.listAudit(ws.id)).some((e) => e.action === 'capital.exported' && e.actorId === owner.id && e.metadata.revision === 3));
  assert.equal((await finance.get(`${casePath}/export`)).statusCode, 200, 'finance may read the package too');
});

test('staff and the submitted export see only the frozen revision: later evidence, credit records and titles stay private until sent again', async () => {
  const { app, owner, base, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Original title' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  const sent = (await send(owner, casePath, 2)).json().submission;
  // While it is with review, a finance colleague records a new workspace credit (credits are not frozen globally).
  assert.equal((await finance.post(`${base}/credits`, credit({ amountCents: 999 }))).statusCode, 200);
  let view = (await staff.get(`/api/staff/capital/${kase.id}`)).json();
  assert.deepEqual(view.submission.snapshot.credits, [], 'the credit recorded after sending is not shown');
  assert.equal(view.submission.snapshot.evidence.length, 0);
  assert.equal(view.submission.snapshot.title, 'Original title');
  assert.equal(view.credits, undefined, 'no live credit list');
  assert.ok(!JSON.stringify(view.submission.snapshot.credits).includes('"amountCents":999'), 'the new amount is nowhere in the frozen snapshot');
  await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'changes_requested', submissionId: sent.id, notes: 'More evidence please.' });
  // After the decision the customer prepares privately: new evidence, a new title, no new send.
  const ev = (await owner.post(`${casePath}/evidence`, record('Private draft record'))).json().evidence;
  await owner.post(casePath, { expectedRevision: 2, title: 'Renamed privately', draft: draft() });
  const queue = (await staff.get('/api/staff/capital?status=changes_requested')).json().cases;
  assert.equal(queue[0].title, 'Original title');
  view = (await staff.get(`/api/staff/capital/${kase.id}`)).json();
  assert.equal(view.submission.snapshot.title, 'Original title');
  assert.equal(view.submission.snapshot.evidence.length, 0);
  assert.equal(view.submission.snapshot.credits.length, 0);
  assert.equal(JSON.stringify(view).includes('Private draft record'), false);
  assert.equal(JSON.stringify(view).includes('Renamed privately'), false);
  assert.equal(JSON.stringify(view).includes(ev.id), false);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev.id}/review`, { submissionId: sent.id })).json().code, 'not_submitted', 'a decided revision takes no marks');
  const pkg = (await owner.get(`${casePath}/export`)).json();
  assert.equal(pkg.basis, 'submitted_revision');
  assert.equal(pkg.content.title, 'Original title');
  assert.deepEqual([pkg.content.evidence.length, pkg.content.credits.length], [0, 0], 'the export of a sent revision is that revision, untouched');
  assert.equal(pkg.asOf.draftChangedSinceSent, true);
  // Sending the new revision is what makes the new facts visible.
  const resent = await send(owner, casePath, 3);
  assert.equal(resent.statusCode, 200, resent.body);
  view = (await staff.get(`/api/staff/capital/${kase.id}`)).json();
  assert.equal(view.submission.snapshot.title, 'Renamed privately');
  assert.deepEqual(view.submission.snapshot.evidence.map((e) => e.id), [ev.id]);
  assert.equal(view.submission.snapshot.credits[0].amountCents, 999);
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev.id}/review`, { submissionId: view.submission.id })).statusCode, 200);
});

test('the submitted export is the frozen revision even after corrections; a draft export says it is a draft', async () => {
  const { app, owner, base, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Export' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  const c1 = (await finance.post(`${base}/credits`, credit({ amountCents: 100 }))).json().credit;
  const ev = (await owner.post(`${casePath}/evidence`, record())).json().evidence;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  const before = (await owner.get(`${casePath}/export`)).json();
  assert.equal(before.basis, 'draft');
  assert.equal(before.submission, null);
  assert.equal(before.review, null);
  assert.equal(before.content.credits[0].amountCents, 100);
  const sent = (await send(owner, casePath, 2)).json().submission;
  await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev.id}/review`, { submissionId: sent.id });
  await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'changes_requested', submissionId: sent.id, notes: 'n' });
  // Later corrections and additions change the live case, not what was sent.
  await finance.post(`${base}/credits`, credit({ amountCents: 999, supersedes: c1.id }));
  await owner.post(`${casePath}/evidence`, record('Second record'));
  await owner.post(casePath, { expectedRevision: 2, draft: draft({ requestedAmountCents: 1 }) });
  const pkg = (await owner.get(`${casePath}/export`)).json();
  assert.equal(pkg.basis, 'submitted_revision');
  assert.equal(pkg.submission.contentHash, sent.contentHash);
  assert.equal(pkg.content.credits.length, 1);
  assert.equal(pkg.content.credits[0].amountCents, 100);
  assert.equal(pkg.content.evidence.length, 1);
  assert.equal(pkg.content.request.requestedAmountCents, 5000000);
  assert.deepEqual(pkg.review.marks.map((m) => m.evidenceId), [ev.id]);
  assert.equal(pkg.review.decision, 'changes_requested');
  assert.equal(snapshotHash(capitalSnapshot({ title: pkg.content.title, projectId: pkg.content.projectId, enhanceRunId: pkg.content.enhanceRunId, draft: { ...pkg.content.request, costItems: pkg.content.plan.costItems, datasetVersions: pkg.content.plan.datasetVersions } }, pkg.content.credits, pkg.content.evidence)), sent.contentHash, 'the exported content hashes to the hash the owner consented to');
});

test('a staff action names the submission it saw: after a withdraw and a newer send, the old action is refused and nothing is decided', async () => {
  const { app, owner, base } = await setup();
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Race' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  const ev = (await owner.post(`${casePath}/evidence`, record())).json().evidence;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  await send(owner, casePath, 2);
  const seen = (await staff.get(`/api/staff/capital/${kase.id}`)).json().submission;
  assert.equal(seen.revision, 2);
  // The customer withdraws, changes the request and sends again while the staff tab is still open.
  assert.equal((await owner.post(`${casePath}/withdraw`)).json().case.revision, 3);
  await owner.post(casePath, { expectedRevision: 3, draft: draft({ requestedAmountCents: 1 }) });
  const resent = (await send(owner, casePath, 4)).json().submission;
  assert.notEqual(resent.id, seen.id);
  const stale = await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: seen.id });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_submission');
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/evidence/${ev.id}/review`, { submissionId: seen.id })).json().code, 'stale_submission');
  const live = (await owner.get(casePath)).json();
  assert.equal(live.case.status, 'submitted', 'the newer revision was not decided by the stale action');
  assert.equal(live.submissions.find((s) => s.id === resent.id).decision, null);
  assert.equal(live.marks.length, 0);
  const ok = await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: resent.id });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().submission.revision, 4);
});

test('an owner’s consent binds the exact content: evidence or credit records changed since the page was opened make the send stale', async () => {
  const { app, store, owner, ws, base, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Consent' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  const c1 = (await finance.post(`${base}/credits`, credit({ amountCents: 100 }))).json().credit;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  const seenHash = await hashOf(owner, casePath);
  // A colleague adds evidence after the owner loaded the page: same revision, different content.
  await finance.post(`${casePath}/evidence`, record());
  assert.equal((await owner.get(casePath)).json().case.revision, 2, 'evidence does not bump the revision');
  const staleEvidence = await send(owner, casePath, 2, seenHash);
  assert.equal(staleEvidence.statusCode, 409);
  assert.equal(staleEvidence.json().code, 'content_changed');
  assert.equal((await store.listAudit(ws.id)).filter((e) => e.action === 'capital.submitted').length, 0);
  const afterEvidence = await hashOf(owner, casePath);
  assert.notEqual(afterEvidence, seenHash);
  // A credit correction after the owner looked again: stale once more.
  await finance.post(`${base}/credits`, credit({ amountCents: 999, supersedes: c1.id }));
  assert.equal((await send(owner, casePath, 2, afterEvidence)).json().code, 'content_changed');
  // Garbage hashes are refused before anything is read.
  for (const bad of ['abc', 42, null, 'Z'.repeat(64)]) assert.equal((await owner.post(`${casePath}/submit`, { expectedRevision: 2, contentHash: bad, sendToReview: true })).json().code, 'content_hash_required', String(bad));
  const fresh = await hashOf(owner, casePath);
  const sent = await send(owner, casePath, 2, fresh);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().submission.contentHash, fresh);
  const snapshot = (await staff.get(`/api/staff/capital/${kase.id}`)).json().submission.snapshot;
  assert.equal(snapshot.credits[0].amountCents, 999);
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshotHash(snapshot), fresh, 'the frozen snapshot is exactly what the owner consented to');
  // A retry with the consented hash returns the same submission; one with another hash does not.
  assert.equal((await send(owner, casePath, 2, fresh)).json().submission.id, sent.json().submission.id);
  assert.equal((await send(owner, casePath, 2, seenHash)).json().code, 'content_changed');
});

test('a save is never a send: editing a stale page cannot consent to credit records or evidence added behind the owner', async () => {
  const { app, store, owner, ws, base, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Stale page' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  // 1. The owner opens the consent view: no credit records, no evidence, hash A.
  const page = (await owner.get(casePath)).json();
  assert.deepEqual([page.credits.length, page.evidence.length], [0, 0]);
  const hashA = page.contentHash;
  // 2. A finance colleague records a credit and adds evidence. The revision stays 2, as designed.
  await finance.post(`${base}/credits`, credit({ amountCents: 777 }));
  await finance.post(`${casePath}/evidence`, record('Added behind the owner'));
  // 3. The owner edits a field on the stale page and saves. The save carries no hash and is not a send.
  const saved = await owner.post(casePath, { expectedRevision: 2, draft: draft({ purpose: 'Edited on a stale page' }) });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().case.revision, 3);
  assert.equal(saved.json().contentHash, undefined);
  assert.equal((await store.listAudit(ws.id)).filter((e) => e.action === 'capital.submitted').length, 0);
  // 4. Only what the owner reviewed can be sent: hash A names revision 2's content, so it is stale twice over.
  assert.equal((await send(owner, casePath, 3, hashA)).json().code, 'content_changed');
  assert.equal((await send(owner, casePath, 2, hashA)).json().code, 'stale_revision');
  assert.equal((await staff.get('/api/staff/capital')).json().cases.length, 0, 'nothing reached staff');
  // 5. The reloaded consent view shows the unseen records; sending its hash freezes exactly what it showed.
  const reloaded = (await owner.get(casePath)).json();
  assert.equal(reloaded.credits.length, 1);
  assert.equal(reloaded.evidence.length, 1);
  assert.notEqual(reloaded.contentHash, hashA);
  // A credit corrected after that reload makes the send stale again (the store's check), even with the reloaded hash.
  await finance.post(`${base}/credits`, credit({ amountCents: 1, supersedes: reloaded.credits[0].id }));
  assert.equal((await send(owner, casePath, 3, reloaded.contentHash)).json().code, 'content_changed');
  const again = (await owner.get(casePath)).json();
  const sent = await send(owner, casePath, 3, again.contentHash);
  assert.equal(sent.statusCode, 200, sent.body);
  const snapshot = (await staff.get(`/api/staff/capital/${kase.id}`)).json().submission.snapshot;
  assert.equal(snapshot.draft.purpose, 'Edited on a stale page');
  assert.deepEqual(snapshot.credits.map((c) => c.amountCents), [1]);
  assert.deepEqual(snapshot.evidence.map((e) => e.title), ['Added behind the owner']);
  assert.equal(snapshotHash(snapshot), again.contentHash);
});

test('the consent view carries every business field the snapshot freezes; a hidden-only change leaves the visible summary alone but changes the hash', async () => {
  const { app, owner, base, join, project, device, bench } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Hidden fields', projectId: project.id })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  const c1 = (await finance.post(`${base}/credits`, credit({ restrictions: 'Compute only', reference: '', expiresOn: null }))).json().credit;
  await owner.post(`${casePath}/evidence`, record('Invoice'));
  await owner.post(`${casePath}/evidence`, { kind: 'local_benchmark', title: 'Laptop', reference: { deviceId: device.id, runId: bench.id } });
  await owner.post(casePath, { expectedRevision: 1, draft: draft({ datasetVersions: [{ projectId: project.id, version: 1 }] }) });
  // Everything the snapshot would freeze is in the view, field for field, and hashes to the view's hash.
  const view = (await owner.get(casePath)).json();
  const frozen = capitalSnapshot(view.case, view.credits, view.evidence);
  assert.equal(snapshotHash(frozen), view.contentHash);
  assert.deepEqual(frozen.draft, view.case.draft);
  assert.deepEqual([frozen.title, frozen.projectId, frozen.enhanceRunId], [view.case.title, view.case.projectId, view.case.enhanceRunId]);
  for (const c of frozen.credits) {
    const shown = view.credits.find((x) => x.id === c.id);
    for (const key of ['provider', 'status', 'amountCents', 'expiresOn', 'restrictions', 'reference']) assert.deepEqual(shown[key], c[key], `credit ${key}`);
  }
  for (const e of frozen.evidence) {
    const shown = view.evidence.find((x) => x.id === e.id);
    for (const key of ['kind', 'title', 'source', 'reference', 'verification']) assert.deepEqual(shown[key], e[key], `evidence ${key}`);
  }
  assert.ok(view.options.projects.some((p) => p.id === project.id) && view.options.versions.some((v) => v.projectId === project.id && v.version === 1), 'linked names are available to render');
  // A colleague corrects only the restrictions, reference and expiry: provider, amount and status read the same.
  await finance.post(`${base}/credits`, credit({ restrictions: 'Region X only; not transferable', reference: 'REF-9', expiresOn: '2027-01-01', supersedes: c1.id }));
  const after = (await owner.get(casePath)).json();
  const summary = (c) => [c.provider, c.amountCents, c.status];
  assert.deepEqual(after.credits.filter((c) => !c.supersededBy).map(summary), view.credits.filter((c) => !c.supersededBy).map(summary), 'the visible summary is identical');
  assert.notEqual(after.contentHash, view.contentHash, 'the hash is not');
  assert.equal(after.credits.find((c) => !c.supersededBy).restrictions, 'Region X only; not transferable', 'the changed field is in the view to be read');
  assert.equal((await send(owner, casePath, 2, view.contentHash)).json().code, 'content_changed', 'consent on the earlier view does not cover it');
  const sent = await send(owner, casePath, 2, after.contentHash);
  assert.equal(sent.statusCode, 200, sent.body);
  const snapshot = (await staff.get(`/api/staff/capital/${kase.id}`)).json().submission.snapshot;
  assert.deepEqual(snapshot.credits.map((c) => [c.restrictions, c.reference, c.expiresOn]), [['Region X only; not transferable', 'REF-9', '2027-01-01']]);
  assert.equal(snapshotHash(snapshot), after.contentHash);
});

test('an owner can withdraw from review; a withdrawn case leaves the queue and can be sent again as a new revision', async () => {
  const { app, owner, base, join } = await setup();
  const staff = await person(app, STAFF);
  const kase = (await owner.post(`${base}/cases`, { title: 'Withdrawn later' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  assert.equal((await owner.post(`${casePath}/withdraw`)).json().code, 'not_submitted');
  assert.equal((await send(owner, casePath, 2)).statusCode, 200);
  assert.equal((await staff.get('/api/staff/capital')).json().cases.length, 1);
  const admin = await join('admin@qa-synthetic.example', 'admin');
  const withdrawn = (await admin.post(`${casePath}/withdraw`)).json().case;
  assert.deepEqual([withdrawn.status, withdrawn.revision, withdrawn.submittedRevision], ['draft', 3, 2]);
  assert.equal((await owner.get(casePath)).json().submissions[0].decision, 'withdrawn');
  assert.equal((await staff.get('/api/staff/capital')).json().cases.length, 0);
  assert.equal((await staff.get(`/api/staff/capital/${kase.id}`)).statusCode, 404, 'a case that is not with review is not shown to staff');
  assert.equal((await staff.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: kase.id })).statusCode, 404);
  const pkg = (await owner.get(`${casePath}/export`)).json();
  assert.equal(pkg.basis, 'draft', 'a withdrawn revision is not exported as the submitted one');
  assert.equal((await send(owner, casePath, 3)).json().submission.revision, 3);
});

test('staff who belong to the workspace may look but not decide', async () => {
  const { app, store, owner, ws, base } = await setup();
  const insider = await person(app, STAFF);
  await store.createInvitations({ workspaceId: ws.id, invitedBy: owner.id, invites: [{ email: STAFF, role: 'viewer', tokenHash: 'staff-token', expiresAt: new Date(Date.now() + 86400000) }] });
  await store.acceptInvitation({ invitationId: (await store.getInvitationByTokenHash('staff-token')).id, userId: insider.id });
  const kase = (await owner.post(`${base}/cases`, { title: 'Insider' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  await owner.post(casePath, { expectedRevision: 1, draft: draft() });
  const ev = (await owner.post(`${casePath}/evidence`, record())).json().evidence;
  const sent = (await send(owner, casePath, 2)).json().submission;
  assert.equal((await insider.get(`/api/staff/capital/${kase.id}`)).json().conflict, true);
  assert.equal((await insider.post(`/api/staff/capital/${kase.id}/decision`, { decision: 'evidence_reviewed', submissionId: sent.id })).json().code, 'conflict_of_interest');
  assert.equal((await insider.post(`/api/staff/capital/${kase.id}/evidence/${ev.id}/review`, { submissionId: sent.id })).json().code, 'conflict_of_interest');
  assert.equal((await insider.get(`${base}`)).statusCode, 403, 'a viewer membership gives no finance access either');
});

test('credit records are append-only facts with one correction each, never a balance', async () => {
  const { owner, base, join } = await setup();
  const finance = await join('finance@qa-synthetic.example', 'finance');
  for (const bad of [credit({ amountCents: '100' }), credit({ amountCents: -1 }), credit({ amountCents: 1.5 }), credit({ amountCents: MAX_AMOUNT_CENTS + 1 }), credit({ status: 'evidenced' }), credit({ expiresOn: '2027-13-01' }), credit({ provider: '' })]) {
    assert.equal((await finance.post(`${base}/credits`, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await finance.post(`${base}/credits`, credit({ supersedes: 42 }))).statusCode, 400);
  const first = (await finance.post(`${base}/credits`, credit())).json().credit;
  assert.equal(first.supersededBy, null);
  const corrected = (await finance.post(`${base}/credits`, credit({ status: 'evidenced', amountCents: 900000, reference: 'Provider confirmation QA-CR-1', supersedes: first.id }))).json().credit;
  assert.equal(corrected.supersedes, first.id);
  const twice = await finance.post(`${base}/credits`, credit({ supersedes: first.id }));
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().code, 'already_corrected');
  assert.equal((await finance.post(`${base}/credits`, credit({ supersedes: '00000000-0000-4000-8000-000000000000' }))).statusCode, 404);
  const listed = (await owner.get(base)).json();
  assert.equal(listed.credits.length, 2, 'the corrected record stays on record');
  assert.equal(listed.credits.find((c) => c.id === first.id).supersededBy, corrected.id);
  assert.deepEqual(listed.options.credits.map((c) => c.id), [corrected.id], 'only the current record can be cited');
  assert.doesNotMatch(JSON.stringify(listed), /balance|spendable/i);
  const kase = (await owner.post(`${base}/cases`, { title: 'Credits' })).json().case;
  const ev = (await owner.post(`${base}/cases/${kase.id}/evidence`, { kind: 'credit_restriction', title: 'Credit terms', reference: { creditRecordId: corrected.id } })).json().evidence;
  assert.equal(ev.reference.restrictions, 'Compute only; not transferable');
  assert.equal((await owner.post(`${base}/cases/${kase.id}/evidence`, { kind: 'credit_restriction', title: 'Old terms', reference: { creditRecordId: first.id } })).statusCode, 400, 'a superseded record cannot be cited');
});

test('amounts and sizes are bounded at the API: malformed, huge, negative and fractional values are refused', async () => {
  const { owner, base } = await setup();
  const kase = (await owner.post(`${base}/cases`, { title: 'Bounds' })).json().case;
  const casePath = `${base}/cases/${kase.id}`;
  for (const bad of ['5000000', 50.5, -100, MAX_AMOUNT_CENTS + 1, 1e21, true, [100], {}]) {
    const res = await owner.post(casePath, { expectedRevision: 1, draft: draft({ requestedAmountCents: bad }) });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().errors.requestedAmountCents, JSON.stringify(bad));
  }
  for (const bad of ['250000', 0.01, -1, MAX_AMOUNT_CENTS + 1, null]) {
    const res = await owner.post(casePath, { expectedRevision: 1, draft: draft({ costItems: [item({ amountCents: bad })] }) });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().errors.costItems, JSON.stringify(bad));
  }
  assert.equal((await owner.post(casePath, { expectedRevision: 1, draft: draft({ costItems: Array.from({ length: 41 }, () => item()) }) })).statusCode, 400);
  assert.equal((await owner.post(casePath, { expectedRevision: 1, draft: draft({ purpose: 'x'.repeat(40000) }) })).statusCode, 413, 'an oversized body is refused before it is read');
  for (const bad of [0, -1, 1.5, '1', null]) assert.equal((await owner.post(casePath, { expectedRevision: bad, draft: draft() })).statusCode, 400, `revision ${bad}`);
  assert.equal((await owner.get(casePath)).json().case.revision, 1, 'nothing was saved');
  const ok = await owner.post(casePath, { expectedRevision: 1, draft: draft({ requestedAmountCents: MAX_AMOUNT_CENTS, costItems: [item({ amountCents: MAX_AMOUNT_CENTS }), item({ amountCents: MAX_AMOUNT_CENTS, basis: 'quoted' })] }) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await owner.get(base)).json().cases[0].totals.estimated.one_time, MAX_AMOUNT_CENTS);
});
