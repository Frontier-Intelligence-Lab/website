import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createMemoryStore } from '../src/store/memory.js';
import { hashPassword } from '../src/lib/passwords.js';
import { api } from '../web/src/api.js';
import { json, makeApp, postHeaders, sessionCookie } from './helpers.js';

let vite, views;
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent' });
  views = await vite.ssrLoadModule('/src/app/eval-case-form.jsx');
});
after(async () => { await vite?.close(); });

const props = (row, sources = [], pending = false) => ({
  row, sources, pending, entry: { id: randomUUID() }, project: { id: randomUUID() }, set: { id: randomUUID(), revision: 7 },
  act: () => { throw new Error('SSR must not submit'); }, onDone() {},
});
const render = (p) => renderToStaticMarkup(createElement(views.CaseForm, p));
const row = (refs = []) => ({ id: randomUUID(), caseKey: 'QA-case', input: 'QA ONLY question?', expectedAnswer: 'QA ONLY predeclared answer', reviewCriteria: null, category: null, severity: 'critical', sourceRefs: refs });

test('before effects, a changed workspace/project/set or read-only/frozen state hides and invalidates an old edit; a query-tab switch preserves it', () => {
  const scope = { workspaceId: randomUUID(), projectId: randomUUID(), setId: randomUUID(), canWrite: true, draft: true };
  const editing = { ...scope, row: row(), revision: 7 };
  assert.equal(views.caseEditForScope(editing, { ...scope, tab: 'quality' }), editing);
  assert.equal(views.caseEditForScope(editing, { ...scope, tab: 'cases' }).revision, 7);
  for (const changed of [
    { ...scope, workspaceId: randomUUID() }, { ...scope, projectId: randomUUID() }, { ...scope, setId: randomUUID() },
    { ...scope, canWrite: false }, { ...scope, draft: false },
  ]) {
    const current = views.caseEditForScope(editing, changed);
    assert.equal(current, null, 'an old selection cannot populate or lock the new context before cleanup');
    const html = render(props(current?.row));
    assert.match(html, /Add a case/);
    assert.doesNotMatch(html, /QA ONLY predeclared answer|Edit QA-case|Cancel edit/);
    assert.equal(views.caseEditForScope(current, scope), null, 'once invalidated, returning to the original scope cannot revive it');
  }
});

test('Edit pre-fills the stored question and answer and leaves an uncited case at None despite a newly available source', () => {
  const original = row();
  const source = { projectId: randomUUID(), versionId: randomUUID(), projectName: 'QA ONLY approved', number: 1, files: [] };
  const html = render(props(original, [source]));
  assert.match(html, /Edit QA-case/);
  assert.match(html, /QA ONLY question\?/);
  assert.match(html, /QA ONLY predeclared answer/);
  assert.match(html, /<option value="" selected="">None<\/option>/);
  assert.doesNotMatch(html, new RegExp(`value="${source.versionId}" selected`));
  assert.match(html, /Save changes/);
  assert.match(html, /type="button"[^>]*>Cancel edit/);
  assert.deepEqual(original.sourceRefs, []);
});

test('unchanged edit payload retains every optional value and source; multiple or unavailable references are not silently collapsed', () => {
  const refs = [0, 1].map(() => ({ projectId: randomUUID(), versionId: randomUUID(), fileId: randomUUID() }));
  const original = row(refs);
  assert.deepEqual(views.caseFormPayload(original, original, 7), {
    expectedRevision: 7, caseId: original.id,
    case: { id: original.caseKey, input: original.input, expectedAnswer: original.expectedAnswer, reviewCriteria: null, category: null, severity: original.severity, sources: refs },
  });
  const html = render(props(original));
  assert.match(html, /Saved source \(unavailable\)/);
  assert.match(html, /Saved file \(unavailable\)/);
  assert.match(html, /2 saved sources are retained/);
  assert.match(html, /<select id="case-source" disabled=""/);
  assert.match(html, /<select id="case-file" disabled=""/);
  assert.deepEqual(original.sourceRefs, refs);
});

test('all editable fields, source controls, submit and Cancel are disabled during persistence or refresh', () => {
  const ref = { projectId: randomUUID(), versionId: randomUUID(), fileId: randomUUID() };
  const html = render(props(row([ref]), [], true));
  const controls = html.match(/<(?:input|textarea|select|button)\b[^>]*>/g);
  assert.ok(controls.length >= 10);
  assert.ok(controls.every((tag) => tag.includes('disabled=""')));
  assert.match(html, /aria-busy="true"/);
});

test('real UI edit payload updates four existing case UUIDs with only approved sources; stale/frozen edits refuse and original answers/rule persist', async (t) => {
  const store = createMemoryStore();
  const password = 'QA ONLY case edit password';
  const owner = await store.createUser({ email: 'case-edit@qa.invalid', name: 'QA ONLY', passwordHash: await hashPassword(password, { cost: 2 ** 12 }) });
  await store.setEmailVerified(owner.id);
  const ws = await store.createWorkspace({ kind: 'organization', name: 'QA ONLY', slug: 'qa-case-edit', ownerId: owner.id });
  const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'QA ONLY policy', task: 'Question answering', modalities: ['Text'], startingPoint: 'model' });
  const at = { workspaceId: ws.id, projectId: project.id };
  await store.updateProject({ ...at, patch: { success: { measure: 'exact', target: 'predeclared policy answer' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
  const review = await store.submitForReview({ ...at, submittedBy: owner.id });
  await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
  const version = await store.createDatasetVersion({ ...at, createdBy: owner.id });
  const set = await store.createEvalSet({ ...at, createdBy: owner.id, name: 'QA ONLY predeclared', purpose: 'development' });
  const mine = { ...at, setId: set.id };
  for (let i = 0; i < 4; i += 1) {
    const current = await store.getEvalSet(mine);
    await store.saveEvalCase({ ...mine, expectedRevision: current.set.revision, input: { id: `QA-${i}`, input: `QA ONLY distinct question ${i}`, expectedAnswer: `QA ONLY predeclared answer ${i}`, reviewCriteria: null, category: null, severity: 'major', sources: [] } });
  }
  const before = await store.getEvalSet(mine);
  const app = await makeApp({ store });
  t.after(() => app.close());
  const signed = await app.inject({ method: 'POST', url: '/api/account/signin', headers: postHeaders, payload: json({ email: owner.email, password }) });
  assert.equal(signed.statusCode, 200, signed.body);
  const cookies = sessionCookie(signed);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const response = await app.inject({ method: options.method ?? 'GET', url, headers: postHeaders, cookies, payload: options.body });
    return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
  });
  const savedSource = { projectId: project.id, versionId: version.id, fileId: null };
  let oldPayload;
  for (const original of before.cases) {
    const current = await store.getEvalSet(mine);
    const fields = { ...original, sourceRefs: [savedSource] };
    const payload = views.caseFormPayload(original, fields, current.set.revision);
    if (!oldPayload) oldPayload = payload;
    const response = await api.saveEvalCase(ws.id, project.id, set.id, payload);
    assert.equal(response.ok, true, JSON.stringify(response.data));
    assert.equal(response.data.case.id, original.id, 'editing updates rather than deleting/recreating the existing row');
  }
  const after = await store.getEvalSet(mine);
  assert.equal(after.cases.length, 4);
  assert.deepEqual(after.set.acceptance, before.set.acceptance);
  assert.equal(after.set.rubricVersion, before.set.rubricVersion);
  for (const original of before.cases) {
    const saved = after.cases.find((item) => item.id === original.id);
    const { updatedAt, sourceRefs, ...unchanged } = saved;
    const { updatedAt: previousTime, sourceRefs: previousRefs, ...expected } = original;
    assert.deepEqual(unchanged, expected);
    assert.deepEqual(sourceRefs, [savedSource]);
  }
  const stale = await api.saveEvalCase(ws.id, project.id, set.id, { ...oldPayload, case: { ...oldPayload.case, expectedAnswer: 'QA ONLY refused unsaved edit' } });
  assert.equal(stale.status, 409);
  assert.deepEqual((await store.getEvalSet(mine)).cases, after.cases);
  assert.equal((await store.getEvalSet(mine)).versions.length, 0, 'draft editing creates no frozen result or score');
  await store.freezeEvalSet({ ...mine, expectedRevision: after.set.revision, actorId: owner.id });
  const frozen = await api.saveEvalCase(ws.id, project.id, set.id, { ...oldPayload, expectedRevision: after.set.revision });
  assert.equal(frozen.status, 409);
  assert.deepEqual((await store.getEvalSet(mine)).cases, after.cases);
});
