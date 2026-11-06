import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { STALE_MS, sha256Text } from '../src/lib/research.js';
import { makeApp, json, postHeaders } from './helpers.js';

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
  const signup = await c.post('/api/account/signup', { name: email.split('@')[0], email, password: 'long-enough-password' });
  assert.equal(signup.statusCode, 200, signup.body);
  await c.post('/api/account/verify', { code: signup.json().devCode });
  return c;
}

async function workspace(owner, name) {
  const res = await owner.post('/api/workspaces', { name });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().workspace;
}

const page = (url, text) => ({ url, finalUrl: url, status: 'retrieved', title: 'Example Research', text, excerpt: text, sha256: sha256Text(text), publisher: 'example.com', retrievedAt: '2026-11-05T00:00:00.000Z' });

async function untilStatus(owner, url, status) {
  let run = null;
  for (let i = 0; i < 50 && run?.status !== status; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    run = (await owner.get(url)).json().run;
  }
  return run;
}

test('two workspaces keep research records apart, and the labs catalog imports once', async () => {
  const store = createMemoryStore();
  const app = await makeApp({ store });
  const yc = await person(app, 'yc-research@example.com');
  const speedrun = await person(app, 'speedrun-research@example.com');
  const ycWs = await workspace(yc, 'YC Research');
  const srWs = await workspace(speedrun, 'Speedrun Research');
  const created = await yc.post(`/api/workspaces/${ycWs.id}/research/projects`, { template: 'collection' });
  assert.equal(created.statusCode, 200, created.body);
  const projectId = created.json().project.id;
  assert.match(created.json().project.brief, /not evidence of a commercial relationship/);
  assert.equal((await yc.post(`/api/workspaces/${ycWs.id}/research/projects`, {})).statusCode, 400);
  assert.equal((await speedrun.get(`/api/workspaces/${ycWs.id}/research/projects/${projectId}`)).statusCode, 404);
  assert.equal((await yc.get(`/api/workspaces/${srWs.id}/research/projects`)).statusCode, 404);

  const preview = await yc.post(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/imports`, { catalog: 'frontier-ai-labs', dryRun: true });
  assert.equal(preview.json().summary.importedEntities, 62);
  assert.equal(preview.json().dryRun, true);
  assert.equal((await yc.get(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/directory?directory=companies`)).json().total, 0);
  const applied = await yc.post(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/imports`, { catalog: 'frontier-ai-labs' });
  assert.equal(applied.json().summary.importedEntities, 62);
  const again = await yc.post(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/imports`, { catalog: 'frontier-ai-labs' });
  assert.equal(again.json().summary.importedEntities, 0);
  assert.equal(again.json().summary.skippedEntities, 62);
  for (const directory of ['founders', 'partners', 'tools', 'repositories', 'prospects']) {
    assert.equal((await yc.get(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/directory?directory=${directory}`)).json().total, 0, directory);
  }
  const companies = await yc.get(`/api/workspaces/${ycWs.id}/research/projects/${projectId}/directory?directory=companies&q=OpenAI`);
  assert.equal(companies.json().total, 1);
  const entityId = companies.json().rows[0].entity.id;
  assert.equal((await speedrun.get(`/api/workspaces/${srWs.id}/research/entities/${entityId}`)).statusCode, 404);
  const entity = await yc.get(`/api/workspaces/${ycWs.id}/research/entities/${entityId}`);
  assert.equal(entity.json().claims.every((claim) => claim.status === 'extracted'), true);
  assert.match(entity.json().claims[0].source.url, /^catalog:\/\//);
  const caps = await yc.get(`/api/workspaces/${ycWs.id}/research/capabilities`);
  assert.equal(caps.json().webSearch.available, false);
  assert.equal(caps.json().catalog.investors, 0);
  await app.close();
});

test('a cited run can be accepted, a cancel wins, and a failed run stores no report', async () => {
  const store = createMemoryStore();
  const app = await makeApp({ store });
  const owner = await person(app, 'runs@example.com');
  const ws = await workspace(owner, 'Run Lab');
  const projectId = (await owner.post(`/api/workspaces/${ws.id}/research/projects`, { template: 'landscape' })).json().project.id;
  const base = `/api/workspaces/${ws.id}/research`;
  const empty = await owner.post(`${base}/projects/${projectId}/runs`, { question: 'What is public?' });
  const startedEmpty = await owner.post(`${base}/runs/${empty.json().run.id}/start`, {});
  assert.equal(startedEmpty.json().run.status, 'failed');
  assert.equal(startedEmpty.json().run.output, null);

  const quoted = 'Example Research publishes this sentence.';
  app.researchExecutor = async () => ({ pages: [page('https://example.com/research', quoted), { status: 'retrieved', url: 'https://example.com/bad', text: 'Something else.', excerpt: 'Not present', title: 'Bad', sha256: 'c'.repeat(64) }, { status: 'failed', url: 'https://example.com/down', text: '', excerpt: '', failure: 'HTTP 404' }] });
  const proposed = await owner.post(`${base}/projects/${projectId}/runs`, { question: 'What does the page say?', urls: ['https://example.com/research', 'https://example.com/bad', 'https://example.com/down'], directory: 'companies' });
  const done = await owner.post(`${base}/runs/${proposed.json().run.id}/start`, {});
  assert.equal(done.json().run.status, 'completed', done.body);
  assert.equal(done.json().run.output.findings.length, 1);
  assert.equal(done.json().run.output.citations.length, 1);
  assert.match(done.json().run.output.limitations.join(' '), /saved-note Agent/i);
  const accepted = await owner.post(`${base}/runs/${proposed.json().run.id}/accept`, { externalKeys: [done.json().run.output.candidates[0].externalKey] });
  assert.equal(accepted.json().summary.importedEntities, 1);
  const listed = await owner.get(`${base}/projects/${projectId}/directory?directory=companies&q=Example%20Research`);
  assert.equal(listed.json().total, 1);
  app.researchExecutor = async () => ({ pages: [page('https://example.com/prospect', quoted)] });
  const prospectRun = await owner.post(`${base}/projects/${projectId}/runs`, { question: 'What does the prospect page say?', urls: ['https://example.com/prospect'], directory: 'prospects' });
  const prospectDone = await owner.post(`${base}/runs/${prospectRun.json().run.id}/start`, {});
  assert.equal(prospectDone.json().run.output.candidates[0].curated, true);
  const prospectAccepted = await owner.post(`${base}/runs/${prospectRun.json().run.id}/accept`, { externalKeys: [prospectDone.json().run.output.candidates[0].externalKey] });
  assert.equal(prospectAccepted.statusCode, 200, prospectAccepted.body);
  assert.equal(prospectAccepted.json().summary.importedEntities, 1);
  assert.equal((await owner.get(`${base}/projects/${projectId}/directory?directory=prospects`)).json().total, 1);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  app.researchExecutor = () => gate;
  const held = (await owner.post(`${base}/projects/${projectId}/runs`, { question: 'Hold', urls: ['https://example.com/research'] })).json().run;
  const pending = owner.post(`${base}/runs/${held.id}/start`, {});
  const running = await untilStatus(owner, `${base}/runs/${held.id}`, 'running');
  assert.equal(running.status, 'running');
  assert.equal((await owner.post(`${base}/runs/${held.id}/cancel`, {})).json().run.status, 'cancelled');
  release({ pages: [page('https://example.com/research', quoted)] });
  const cancelled = await pending;
  assert.equal(cancelled.json().run.status, 'cancelled');
  assert.equal(cancelled.json().run.output, null);

  let finishStuck;
  const stuckGate = new Promise((resolve) => { finishStuck = resolve; });
  app.researchExecutor = () => stuckGate;
  const stuck = (await owner.post(`${base}/projects/${projectId}/runs`, { question: 'Stuck', urls: ['https://example.com/research'] })).json().run;
  const hanging = owner.post(`${base}/runs/${stuck.id}/start`, {});
  assert.equal((await untilStatus(owner, `${base}/runs/${stuck.id}`, 'running')).status, 'running');
  await store.recoverResearchRuns({ workspaceId: ws.id, olderThan: new Date(Date.now() + 60_000).toISOString() });
  finishStuck({ pages: [page('https://example.com/research', quoted)] });
  const recovered = await hanging;
  assert.equal(recovered.json().run.status, 'failed');
  assert.equal(recovered.json().run.output, null);
  assert.match(recovered.json().run.error, /interrupted/);
  await app.close();
});

test('corrections keep the old value, exports escape formulas, and viewers cannot write', async () => {
  const app = await makeApp();
  const owner = await person(app, 'owner-research@example.com');
  const viewer = await person(app, 'viewer-research@example.com');
  const ws = await workspace(owner, 'Evidence Lab');
  const projectId = (await owner.post(`/api/workspaces/${ws.id}/research/projects`, { template: 'diligence' })).json().project.id;
  const base = `/api/workspaces/${ws.id}/research`;
  const imported = await owner.post(`${base}/projects/${projectId}/imports`, { records: [{
    externalKey: 'manual:organization:formula', kind: 'organization', name: 'Formula Lab', directory: 'companies',
    source: { url: 'https://example.com/formula', publisher: 'Example', title: 'Formula Lab', status: 'catalog', excerpt: 'Formula Lab' },
    claims: [{ field: 'name', value: '=1+1', status: 'extracted', method: 'human_paste', excerpt: 'Formula Lab' }],
  }] });
  assert.equal(imported.json().summary.importedEntities, 1, imported.body);
  const entityId = (await owner.get(`${base}/projects/${projectId}/directory?directory=companies`)).json().rows[0].entity.id;
  const corrected = await owner.post(`${base}/entities/${entityId}/corrections`, { field: 'name', value: 'Formula Lab', excerpt: 'The page title is Formula Lab.' });
  assert.equal(corrected.json().claim.status, 'conflicting');
  const entity = await owner.get(`${base}/entities/${entityId}`);
  assert.equal(entity.json().claims.filter((claim) => claim.status === 'conflicting').length, 2);
  const csv = await owner.get(`${base}/projects/${projectId}/exports?directory=companies`);
  assert.match(csv.body, /"'=1\+1"/);
  const invite = await owner.post(`/api/workspaces/${ws.id}/invitations`, { invites: [{ email: 'viewer-research@example.com', role: 'viewer' }] });
  const token = invite.json().devLinks[0].link.split('/invite/')[1];
  assert.equal((await viewer.post(`/api/invitations/${token}/accept`, {})).statusCode, 200);
  assert.equal((await viewer.get(`${base}/projects/${projectId}/directory?directory=companies`)).statusCode, 200);
  assert.equal((await viewer.post(`${base}/projects/${projectId}/imports`, { catalog: 'frontier-ai-labs', dryRun: true })).statusCode, 403);
  const prospect = await owner.post(`${base}/projects/${projectId}/imports`, { records: [{
    externalKey: 'manual:person:ada', kind: 'person', name: 'Ada Example', directory: 'prospects', curated: true,
    source: { url: 'https://example.com/ada', publisher: 'Example', title: 'Ada Example', status: 'inaccessible', failure: 'The page was not fetched. A person pasted this excerpt.', excerpt: 'Ada Example' },
    claims: [{ field: 'name', value: 'Ada Example', status: 'extracted', method: 'human_paste', excerpt: 'Ada Example' }],
  }] });
  assert.equal(prospect.json().summary.importedEntities, 1, prospect.body);
  const refused = await owner.post(`${base}/projects/${projectId}/imports`, { records: [{
    externalKey: 'manual:person:nocurator', kind: 'person', name: 'No Curator', directory: 'prospects',
    source: { url: 'https://example.com/no', publisher: 'Example', title: 'No Curator', status: 'inaccessible', failure: 'The page was not fetched.', excerpt: 'No Curator' },
    claims: [{ field: 'name', value: 'No Curator', status: 'extracted', method: 'human_paste', excerpt: 'No Curator' }],
  }] });
  assert.equal(refused.json().summary.failed, 1);
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().summary.importedEntities, 0);
  assert.equal((await owner.get(`${base}/projects/${projectId}/directory?directory=prospects`)).json().total, 1);
  const pasted = await owner.post(`${base}/projects/${projectId}/imports`, { records: [{
    externalKey: 'manual:organization:upgrade', kind: 'organization', name: 'Upgrade Lab', directory: 'companies',
    source: { url: 'https://example.com/upgrade', publisher: 'Example', title: 'Upgrade Lab', status: 'inaccessible', failure: 'The page was not fetched. A person pasted this excerpt.', excerpt: 'Upgrade Lab was pasted.' },
    claims: [{ field: 'name', value: 'Upgrade Lab', status: 'extracted', method: 'human_paste', excerpt: 'Upgrade Lab was pasted.' }],
  }] });
  assert.equal(pasted.json().summary.importedEntities, 1, pasted.body);
  const fetched = await owner.post(`${base}/projects/${projectId}/imports`, { records: [{
    externalKey: 'retrieved:organization:upgrade', kind: 'organization', name: 'Upgrade Lab', directory: 'companies',
    source: { url: 'https://example.com/upgrade', publisher: 'Example', title: 'Upgrade Lab', status: 'retrieved', excerpt: 'Upgrade Lab publishes this sentence.', sha256: 'd'.repeat(64), retrievedAt: '2026-11-05T00:00:00.000Z' },
    claims: [{ field: 'page_excerpt', value: 'Upgrade Lab publishes this sentence.', status: 'extracted', method: 'retrieved_text', excerpt: 'Upgrade Lab publishes this sentence.' }],
  }] });
  assert.equal(fetched.json().summary.duplicates, 1, fetched.body);
  const upgradeId = (await owner.get(`${base}/projects/${projectId}/directory?directory=companies&q=Upgrade%20Lab`)).json().rows.find((row) => row.entity.externalKey === 'manual:organization:upgrade').entity.id;
  const upgrade = await owner.get(`${base}/entities/${upgradeId}`);
  assert.equal(upgrade.json().claims.every((claim) => claim.source.status === 'inaccessible'), true, 'Fetching the URL later must not rewrite pasted claims as retrieved evidence');
  const list = await owner.post(`${base}/projects/${projectId}/lists`, { name: 'Shortlist', purpose: 'Read these' });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal((await owner.post(`${base}/projects/${projectId}/lists`, { name: 'Shortlist', purpose: 'Again' })).statusCode, 409);
  assert.equal((await owner.post(`${base}/projects/${projectId}`, true)).statusCode, 400);
  await app.close();
});

test('all-failed research imports return a useful 400 with no stored entity', async () => {
  const app = await makeApp();
  try {
    const owner = await person(app, 'invalid-import-qa@example.com');
    const ws = await workspace(owner, 'Synthetic import QA');
    const base = `/api/workspaces/${ws.id}/research`;
    const project = (await owner.post(`${base}/projects`, { template: 'collection' })).json().project;
    const result = await owner.post(`${base}/projects/${project.id}/imports`, { records: [{
      externalKey: 'synthetic:invalid', kind: 'organization', name: 'Synthetic failure', directory: 'companies',
      source: { url: 'http://example.invalid/qa-only', status: 'inaccessible', excerpt: 'Synthetic unsaved text' },
      claims: [{ field: 'name', value: 'Synthetic failure', status: 'extracted', method: 'human_paste', excerpt: 'Synthetic unsaved text' }],
    }] });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().summary.failed, 1);
    assert.match(result.json().error, /https/);
    assert.equal((await owner.get(`${base}/projects/${project.id}/directory?directory=companies`)).json().total, 0);
  } finally { await app.close(); }
});

test('research cancel aborts its executor and late output never becomes a report', async () => {
  const app = await makeApp();
  try {
    const owner = await person(app, 'abort-executor-qa@example.com');
    const ws = await workspace(owner, 'Synthetic cancel QA');
    const base = `/api/workspaces/${ws.id}/research`;
    const project = (await owner.post(`${base}/projects`, { template: 'landscape' })).json().project;
    const proposed = (await owner.post(`${base}/projects/${project.id}/runs`, { question: 'Synthetic question', urls: ['https://example.invalid/qa-only'] })).json().run;
    let signal;
    let release;
    app.researchExecutor = (_payload, options) => {
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    };
    const started = owner.post(`${base}/runs/${proposed.id}/start`, {});
    for (let n = 0; n < 50 && !signal; n += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(signal);
    const cancelled = await owner.post(`${base}/runs/${proposed.id}/cancel`, {});
    assert.equal(cancelled.json().run.status, 'cancelled');
    assert.equal(signal.aborted, true);
    assert.equal((await started).json().run.status, 'cancelled', 'Start settles even when a misbehaving executor ignores its signal');
    release({ pages: [page('https://example.invalid/qa-only', 'Synthetic late text')] });
    await new Promise((resolve) => setImmediate(resolve));
    const final = (await owner.get(`${base}/runs/${proposed.id}`)).json();
    assert.equal(final.run.output, null);
    assert.equal(final.run.status, 'cancelled');
    assert.equal(final.events.some((event) => event.kind === 'output'), false);
  } finally { await app.close(); }
});

test('research worker errors do not expose raw runtime text', async () => {
  const app = await makeApp();
  try {
    const owner = await person(app, 'worker-error-qa@example.com');
    const ws = await workspace(owner, 'Synthetic error QA');
    const base = `/api/workspaces/${ws.id}/research`;
    const project = (await owner.post(`${base}/projects`, { template: 'landscape' })).json().project;
    const run = (await owner.post(`${base}/projects/${project.id}/runs`, { question: 'Synthetic question', urls: ['https://example.invalid/qa-only'] })).json().run;
    app.researchExecutor = async () => { throw new Error('SYNTHETIC_PRIVATE_RUNTIME_DETAIL'); };
    const result = await owner.post(`${base}/runs/${run.id}/start`, {});
    assert.equal(result.json().run.status, 'failed');
    assert.equal(result.json().run.output, null);
    assert.doesNotMatch(result.body, /SYNTHETIC_PRIVATE_RUNTIME_DETAIL/);
    assert.match(result.json().run.error, /worker failed/);
  } finally { await app.close(); }
});

test('research project routes forward only submitted fields and checklist changes', async () => {
  const store = createMemoryStore();
  const patches = [];
  const update = store.updateResearchProject;
  store.updateResearchProject = async (input) => { patches.push(input.patch); return update(input); };
  const app = await makeApp({ store });
  try {
    const owner = await person(app, 'partial-patch-qa@example.com');
    const ws = await workspace(owner, 'Synthetic patch QA');
    const base = `/api/workspaces/${ws.id}/research`;
    const project = (await owner.post(`${base}/projects`, { template: 'collection' })).json().project;
    const [name, brief] = await Promise.all([
      owner.post(`${base}/projects/${project.id}`, { name: 'Synthetic new name' }),
      owner.post(`${base}/projects/${project.id}`, { brief: 'Synthetic new brief' }),
    ]);
    assert.equal(name.statusCode, 200); assert.equal(brief.statusCode, 200);
    const result = (await owner.get(`${base}/projects/${project.id}`)).json().project;
    assert.equal(result.name, 'Synthetic new name');
    assert.equal(result.brief, 'Synthetic new brief');
    assert.deepEqual(patches, [{ name: 'Synthetic new name' }, { brief: 'Synthetic new brief' }]);
    assert.equal((await owner.post(`${base}/projects/${project.id}/checklist`, { checklist: { claimsEvidenced: true } })).statusCode, 200);
    assert.deepEqual(patches.at(-1), { checklist: { claimsEvidenced: true } });
    assert.equal((await owner.post(`${base}/projects/${project.id}/checklist`, { checklist: { sourcesRecorded: 'yes' } })).statusCode, 400);
    assert.equal((await owner.post(`${base}/projects/${project.id}/checklist`, { checklist: {} })).statusCode, 400);
  } finally { await app.close(); }
});

test('research list inspection is scoped, searchable and reversible without deleting records', async () => {
  const app = await makeApp();
  try {
    const owner = await person(app, 'list-owner-qa@example.com');
    const viewer = await person(app, 'list-viewer-qa@example.com');
    const outsider = await person(app, 'list-outsider-qa@example.com');
    const ws = await workspace(owner, 'Synthetic list QA');
    const foreign = await workspace(outsider, 'Synthetic foreign list QA');
    const base = `/api/workspaces/${ws.id}/research`;
    const project = (await owner.post(`${base}/projects`, { template: 'collection' })).json().project;
    const otherProject = (await owner.post(`${base}/projects`, { template: 'collection' })).json().project;
    const records = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
      externalKey: `synthetic:${name}`, kind: 'organization', name: `${name} QA`, directory: 'companies',
      source: { url: `https://example.invalid/qa/${name}`, status: 'catalog', excerpt: `${name} QA` },
      claims: [{ field: 'name', value: `${name} QA`, status: 'extracted', method: 'human_paste', excerpt: `${name} QA` }],
    }));
    await owner.post(`${base}/projects/${project.id}/imports`, { records });
    await owner.post(`${base}/projects/${project.id}/imports`, { records: [{ ...records[0], directory: 'prospects', curated: true }] });
    const entities = (await owner.get(`${base}/projects/${project.id}/directory?directory=companies`)).json().rows;
    const list = (await owner.post(`${base}/projects/${project.id}/lists`, { name: 'Synthetic shortlist' })).json().list;
    const otherList = (await owner.post(`${base}/projects/${otherProject.id}/lists`, { name: 'Other project shortlist' })).json().list;
    const [alpha, beta] = entities.map((row) => row.entity);
    for (const entity of [alpha, beta]) assert.equal((await owner.post(`${base}/lists/${list.id}/items`, { entityId: entity.id })).statusCode, 200);
    const endpoint = `${base}/projects/${project.id}/directory?listId=${list.id}`;
    const members = await owner.get(endpoint);
    assert.equal(members.statusCode, 200, members.body);
    assert.equal(members.json().total, 2, 'Multiple directory memberships must not duplicate list members');
    assert.deepEqual(members.json().rows.map((row) => row.entity.name), ['Alpha QA', 'Beta QA']);
    assert.equal((await owner.get(`${endpoint}&q=Beta&sort=updated&page=1`)).json().rows[0].entity.id, beta.id);
    assert.equal((await owner.get(`${endpoint}&page=0`)).statusCode, 400);
    assert.equal((await owner.get(`${base}/projects/${project.id}/directory`)).statusCode, 400);
    assert.equal((await owner.get(`${base}/projects/${project.id}/directory?listId=invalid`)).statusCode, 400);
    assert.equal((await owner.get(`${base}/projects/${project.id}/directory?listId=${otherList.id}`)).statusCode, 404);
    assert.equal((await owner.get(`${base}/projects/${otherProject.id}/directory?listId=${list.id}`)).statusCode, 404);
    assert.equal((await outsider.get(`${base}/projects/${project.id}/directory?listId=${list.id}`)).statusCode, 404);
    assert.equal((await outsider.get(`/api/workspaces/${foreign.id}/research/projects/${project.id}/directory?listId=${list.id}`)).statusCode, 404);
    const exported = await owner.get(`${base}/projects/${project.id}/exports?listId=${list.id}`);
    assert.match(exported.body, /Alpha QA/); assert.match(exported.body, /Beta QA/); assert.doesNotMatch(exported.body, /Gamma QA/);
    assert.equal((await owner.post(`${base}/lists/${list.id}/items/${alpha.id}/remove`, {})).statusCode, 200);
    assert.equal((await owner.get(endpoint)).json().total, 1);
    assert.equal((await owner.get(`${base}/entities/${alpha.id}`)).json().claims.length, 1);
    assert.equal((await owner.get(`${base}/projects/${project.id}/directory?directory=companies`)).json().total, 3);
    assert.equal((await owner.post(`${base}/lists/${list.id}/items`, { entityId: alpha.id })).statusCode, 200);
    assert.equal((await owner.get(endpoint)).json().total, 2);
    const invitation = await owner.post(`/api/workspaces/${ws.id}/invitations`, { invites: [{ email: 'list-viewer-qa@example.com', role: 'viewer' }] });
    await viewer.post(`/api/invitations/${invitation.json().devLinks[0].link.split('/invite/')[1]}/accept`, {});
    assert.equal((await viewer.get(endpoint)).statusCode, 200);
    assert.equal((await viewer.post(`${base}/lists/${list.id}/items/${alpha.id}/remove`, {})).statusCode, 403);
    const quality = (await owner.get(`${base}/projects/${project.id}/quality`)).json();
    assert.equal(quality.staleAfterDays, STALE_MS / (24 * 60 * 60 * 1000));
    assert.equal(quality.report.unsupported, 3);
  } finally { await app.close(); }
});
