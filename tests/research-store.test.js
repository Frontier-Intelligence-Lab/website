import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../src/store/memory.js';
import { createPostgresPool, createPostgresStore } from '../src/store/postgres.js';
import { applyMigrations } from '../scripts/migrate.js';
import { candidatesFromPages, emptyChecklist, sha256Text } from '../src/lib/research.js';
import { sibling, testDatabase } from './pg-tools.js';

// A separate fresh test database prevents this file racing other suites' public-table resets.
const testUrl = process.env.TEST_DATABASE_URL;
const database = testUrl ? testDatabase(testUrl) : null;
let ownedUrl;
let ownedName;
let admin;
async function makePostgres() {
  if (!ownedUrl) {
    ownedName = `valcairn_research_store_test_${randomUUID().replaceAll('-', '')}`;
    admin = createPostgresPool({ connectionString: database.url, ssl: 'disable' });
    await admin.query(`CREATE DATABASE "${ownedName}"`);
    ownedUrl = sibling(database, ownedName).url;
  }
  const pool = createPostgresPool({ connectionString: ownedUrl, ssl: 'disable' });
  try {
    await applyMigrations({ pool });
    await pool.query('TRUNCATE users, workspaces CASCADE');
  } finally { await pool.end(); }
  return createPostgresStore({ connectionString: ownedUrl, ssl: 'disable' });
}
test.after(async () => {
  if (!admin) return;
  try { await admin.query(`DROP DATABASE "${ownedName}"`); }
  finally { await admin.end(); }
});

async function setup(store) {
  const owner = await store.createUser({ email: 'synthetic-research@example.test', name: 'Synthetic research QA', passwordHash: 'test-only-unusable' });
  const workspace = await store.createWorkspace({ kind: 'organization', name: 'Synthetic research QA', slug: 'synthetic-research', ownerId: owner.id });
  const project = await store.createResearchProject({ workspaceId: workspace.id, createdBy: owner.id, template: 'collection', name: 'Collection', brief: 'Original brief', question: 'What does the source say?', checklist: emptyChecklist() });
  return { owner, workspace, project };
}
const pageRecord = (text, retrievedAt = '2026-11-05T00:00:00.000Z') => candidatesFromPages([{
  url: 'https://example.com/research', title: 'Synthetic source', status: 'retrieved', text, excerpt: text,
  sha256: sha256Text(text), retrievedAt,
}])[0];
const importInto = (store, state, records) => store.importResearchRecords({ workspaceId: state.workspace.id, projectId: state.project.id, actorId: state.owner.id, records });
const findEntity = async (store, state, directory = 'companies') => (await store.listResearchDirectory({ workspaceId: state.workspace.id, projectId: state.project.id, directory })).rows[0].entity;
const projectDetail = (store, state) => store.getResearchProject({ workspaceId: state.workspace.id, projectId: state.project.id });

function contract(label, makeStore, skip = false) {
  const check = (name, fn) => test(`${label}: research ${name}`, { skip }, async () => {
    const store = await makeStore();
    try { await fn(store, await setup(store)); }
    finally { await store.close(); }
  });

  check('retains distinct source versions and exact claim provenance across refetches', async (store, state) => {
    const first = pageRecord('First source fact.', '2026-01-01T00:00:00.000Z');
    const second = pageRecord('Second source fact.');
    const pasted = { ...first, source: { ...first.source, status: 'inaccessible', sha256: null, retrievedAt: null, failure: 'Not fetched.' } };
    await importInto(store, state, [pasted]);
    await importInto(store, state, [first]);
    await importInto(store, state, [second]);
    const entity = await findEntity(store, state);
    const detail = await store.getResearchEntity({ workspaceId: state.workspace.id, entityId: entity.id });
    const excerpts = detail.claims.filter((claim) => claim.field === 'page_excerpt');
    assert.equal(excerpts.length, 3);
    assert.equal(new Set(excerpts.map((claim) => claim.source.id)).size, 3);
    assert.deepEqual(excerpts.map((claim) => [claim.value, claim.source.status, claim.source.contentSha256, claim.source.retrievedAt]), [
      ['First source fact.', 'inaccessible', null, null],
      ['First source fact.', 'retrieved', first.source.sha256, first.source.retrievedAt],
      ['Second source fact.', 'retrieved', second.source.sha256, second.source.retrievedAt],
    ]);
    assert.equal(excerpts.every((claim) => claim.excerpt === claim.source.excerpt), true);
    const repeat = await importInto(store, state, [second]);
    assert.equal(repeat.importedEntities, 0);
    assert.equal(repeat.importedClaims, 0);
    assert.equal(repeat.skippedClaims, second.claims.length);
    const after = await store.getResearchEntity({ workspaceId: state.workspace.id, entityId: entity.id });
    assert.deepEqual(after.claims, detail.claims);
  });

  check('scopes quality to project claims and citation-only run evidence', async (store, state) => {
    await importInto(store, state, [pageRecord('Current source fact.')]);
    const otherProject = await store.createResearchProject({ workspaceId: state.workspace.id, createdBy: state.owner.id, template: 'landscape', name: 'Other', brief: '', question: 'Other?', checklist: emptyChecklist() });
    const other = { ...state, project: otherProject };
    const old = pageRecord('Old source fact.', '2000-01-01');
    old.externalKey = 'synthetic:other';
    old.source = { ...old.source, url: 'https://example.com/old' };
    const failed = { ...old, externalKey: 'synthetic:failed', source: { url: 'https://example.com/failed', status: 'failed', failure: 'Synthetic failure.' } };
    await importInto(store, other, [old, failed]);
    assert.equal((await store.researchQuality({ workspaceId: state.workspace.id, projectId: state.project.id })).report.failedSources, 0);
    assert.equal((await store.researchQuality({ workspaceId: state.workspace.id, projectId: state.project.id })).report.staleSources, 0);
    const run = await store.createResearchRun({ workspaceId: state.workspace.id, projectId: state.project.id, createdBy: state.owner.id, question: 'Quote another source', scope: {}, limits: {}, permissions: {} });
    await store.markResearchRunRunning({ workspaceId: state.workspace.id, runId: run.id });
    await store.finishResearchRun({ workspaceId: state.workspace.id, runId: run.id, status: 'completed', output: { citations: [{ url: old.source.url, sha256: old.source.sha256, retrievedAt: '2000-01-01T00:00:00.000Z' }] } });
    const report = (await store.researchQuality({ workspaceId: state.workspace.id, projectId: state.project.id })).report;
    assert.equal(report.failedSources, 0);
    assert.equal(report.staleSources, 1);
    assert.equal(report.citationGaps, 0);
  });

  check('counts a multi-directory entity once and exports matching membership rows', async (store, state) => {
    const record = pageRecord('Directory source fact.');
    await importInto(store, state, [record, { ...record, directory: 'prospects', curated: true }]);
    const entity = await findEntity(store, state);
    const where = { workspaceId: state.workspace.id, projectId: state.project.id };
    assert.equal((await store.researchQuality(where)).report.entities, 1);
    const selected = await store.listResearchExport({ ...where, directory: 'prospects' });
    assert.equal(selected.length, record.claims.length);
    assert.equal(selected.every((row) => row.directory === 'prospects'), true);
    const all = await store.listResearchExport(where);
    assert.equal(all.length, record.claims.length * 2);
    assert.deepEqual([...new Set(all.map((row) => row.directory))].sort(), ['companies', 'prospects']);
    const list = await store.addResearchList({ ...where, createdBy: state.owner.id, name: 'Synthetic shortlist', purpose: 'Test membership export.' });
    await store.addResearchListItem({ workspaceId: state.workspace.id, listId: list.id, entityId: entity.id });
    assert.equal((await store.listResearchExport({ ...where, listId: list.id })).length, all.length);
    const listed = await store.listResearchDirectory({ ...where, listId: list.id, pageSize: 1 });
    assert.equal(listed.total, 1, 'Two directory memberships must not duplicate a list entity');
    assert.deepEqual(listed.rows.map((row) => row.entity.id), [entity.id]);
    await importInto(store, state, [{ ...record, externalKey: 'synthetic:second-list-record', name: 'Another synthetic source' }]);
    const otherEntity = (await store.listResearchDirectory({ ...where, directory: 'companies', q: 'Another' })).rows[0].entity;
    await store.addResearchListItem({ workspaceId: state.workspace.id, listId: list.id, entityId: otherEntity.id });
    const firstPage = await store.listResearchDirectory({ ...where, directory: 'founders', listId: list.id, page: 1, pageSize: 1 });
    const secondPage = await store.listResearchDirectory({ ...where, listId: list.id, page: 2, pageSize: 1 });
    assert.equal(firstPage.total, 2, 'List selection spans its project directories');
    assert.equal(firstPage.rows[0].entity.id, otherEntity.id);
    assert.equal(secondPage.rows[0].entity.id, entity.id);
    assert.equal((await store.listResearchDirectory({ ...where, listId: list.id, q: 'Another' })).total, 1);
    assert.equal((await store.listResearchDirectory({ ...where, directory: 'prospects' })).total, 1);
    const otherProject = await store.createResearchProject({ workspaceId: state.workspace.id, createdBy: state.owner.id, template: 'collection', name: 'Other project', brief: '', question: 'Other?', checklist: emptyChecklist() });
    assert.equal(await store.listResearchDirectory({ ...where, projectId: otherProject.id, listId: list.id }), null);
    const foreignWorkspace = await store.createWorkspace({ kind: 'organization', name: 'Other synthetic workspace', slug: 'other-synthetic-research', ownerId: state.owner.id });
    assert.equal(await store.listResearchDirectory({ ...where, workspaceId: foreignWorkspace.id, listId: list.id }), null);
    assert.equal(await store.listResearchDirectory({ ...where, listId: 'invalid-list-id' }), null);
  });

  check('rejects invalid dates before either store writes and normalizes valid ISO dates', async (store, state) => {
    const valid = pageRecord('Date source fact.', '2026-11-05');
    valid.claims = valid.claims.map((claim) => ({ ...claim, observedAt: '2026-11-05T01:00:00+01:00' }));
    const badDates = ['not-a-date', '2026-02-30', '2026-01-01T24:00:00Z', 0, {}];
    const bad = badDates.flatMap((date, index) => [
      { ...valid, externalKey: `bad-source-${index}`, source: { ...valid.source, retrievedAt: date } },
      { ...valid, externalKey: `bad-claim-${index}`, claims: [{ ...valid.claims[0], observedAt: date }] },
    ]);
    const result = await importInto(store, state, [...bad, valid]);
    assert.equal(result.failed, bad.length);
    assert.equal(result.importedEntities, 1);
    const entity = await findEntity(store, state);
    const detail = await store.getResearchEntity({ workspaceId: state.workspace.id, entityId: entity.id });
    assert.equal(detail.claims[0].source.retrievedAt, '2026-11-05T00:00:00.000Z');
    assert.equal(detail.claims[0].observedAt, '2026-11-05T00:00:00.000Z');
  });

  check('updates only editable fields and preserves concurrent independent patches', async (store, state) => {
    const where = { workspaceId: state.workspace.id, projectId: state.project.id };
    const before = (await projectDetail(store, state)).project;
    for (const patch of [{ workspaceId: randomUUID() }, { id: randomUUID() }, { createdBy: randomUUID() }, { checklist: { unknown: true } }, { checklist: { claimsEvidenced: 'yes' } }]) {
      await assert.rejects(store.updateResearchProject({ ...where, patch }), { code: 'invalid_state' });
    }
    await Promise.all([
      store.updateResearchProject({ ...where, patch: { brief: 'Updated brief' } }),
      store.updateResearchProject({ ...where, patch: { checklist: { claimsEvidenced: true } } }),
      store.updateResearchProject({ ...where, patch: { checklist: { datesShown: true } } }),
    ]);
    const after = (await projectDetail(store, state)).project;
    assert.equal(after.brief, 'Updated brief');
    assert.equal(after.checklist.claimsEvidenced, true);
    assert.equal(after.checklist.datesShown, true);
    for (const key of ['id', 'workspaceId', 'createdBy', 'name', 'question', 'template']) assert.equal(after[key], before[key]);
  });

  check('finishes only with terminal status and cancellation never stores a late report', async (store, state) => {
    const proposed = await store.createResearchRun({ workspaceId: state.workspace.id, projectId: state.project.id, createdBy: state.owner.id, question: 'Unstarted synthetic preflight?', scope: {}, limits: {}, permissions: {} });
    const proposedWhere = { workspaceId: state.workspace.id, runId: proposed.id };
    const before = await store.getResearchRun(proposedWhere);
    await assert.rejects(store.finishResearchRun({ ...proposedWhere, status: 'completed', output: { citations: [] } }), { code: 'invalid_state' });
    assert.deepEqual(await store.getResearchRun(proposedWhere), before, 'Refused completion must not change status, output, timestamps or events');
    const failed = await store.finishResearchRun({ ...proposedWhere, status: 'failed', error: 'Synthetic preflight refused before launch.' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.output, null);
    assert.deepEqual((await store.getResearchRun(proposedWhere)).events.map((event) => event.kind), ['progress', 'failure']);
    const run = await store.createResearchRun({ workspaceId: state.workspace.id, projectId: state.project.id, createdBy: state.owner.id, question: 'Synthetic lifecycle?', scope: {}, limits: {}, permissions: {} });
    const where = { workspaceId: state.workspace.id, runId: run.id };
    await store.markResearchRunRunning(where);
    for (const status of ['proposed', 'running', 'unknown', null]) await assert.rejects(store.finishResearchRun({ ...where, status }), { code: 'invalid_state' });
    let saved = (await store.getResearchRun(where)).run;
    assert.equal(saved.status, 'running');
    assert.equal(saved.finishedAt, null);
    const disguisedArray = Object.assign([], { citations: [] });
    for (const output of [null, {}, [], 'report', 1, disguisedArray]) {
      await assert.rejects(store.finishResearchRun({ ...where, status: 'completed', output }), { code: 'invalid_state' });
      assert.equal((await store.getResearchRun(where)).run.status, 'running');
    }
    await assert.rejects(store.finishResearchRun({ ...where, status: 'failed', output: { citations: [] } }), { code: 'invalid_state' });
    await store.cancelResearchRun(where);
    saved = await store.finishResearchRun({ ...where, status: 'completed', output: { citations: [] } });
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.output, null);
    saved = await store.finishResearchRun({ ...where, status: 'completed', output: disguisedArray });
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.output, null);
  });
}

contract('memory store', async () => createMemoryStore());
contract('postgres store', makePostgres, !testUrl);

test('postgres research source snapshots and terminal/output constraints survive direct SQL', { skip: !testUrl }, async () => {
  const store = await makePostgres();
  const pool = createPostgresPool({ connectionString: ownedUrl, ssl: 'disable' });
  try {
    const state = await setup(store);
    await importInto(store, state, [pageRecord('Frozen source fact.')]);
    await assert.rejects(pool.query("UPDATE research_sources SET excerpt = 'Rewritten'"), { code: 'P0001' });
    const run = await store.createResearchRun({ workspaceId: state.workspace.id, projectId: state.project.id, createdBy: state.owner.id, question: 'SQL checks?', scope: {}, limits: {}, permissions: {} });
    await assert.rejects(pool.query('UPDATE research_runs SET finished_at = clock_timestamp() WHERE id = $1', [run.id]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE research_runs SET status = 'completed', finished_at = clock_timestamp(), output = '{}'::jsonb WHERE id = $1", [run.id]), { code: '23514' });
    assert.equal((await store.getResearchRun({ workspaceId: state.workspace.id, runId: run.id })).run.status, 'proposed');
  } finally { await store.close(); await pool.end(); }
});
