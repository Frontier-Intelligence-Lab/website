import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresPool, createPostgresStore } from '../src/store/postgres.js';
import { applyMigrations } from '../scripts/migrate.js';
import { capitalSnapshot } from '../src/lib/capital.js';
import { snapshotHash } from '../src/lib/capital-hash.js';
import { childEnvironment, commandLine, containerEnvironmentCheck, dockerEndpoint, postgresTools, sibling, testDatabase, testDatabaseName } from './pg-tools.js';

// Migration 016 re-creates the three validators that call other validators (013's Capital pair and 015's acceptance rule)
// with schema-qualified nested calls, because pg_restore empties search_path before it copies rows and a SQL-language body
// is resolved with the caller's search_path when it runs.
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const REPAIR = '016_qualified_validators.sql';
const NESTED = { capital_cost_item_valid: '013_capital.sql', capital_draft_valid: '013_capital.sql', eval_acceptance_valid: '015_evaluation.sql' };
const read = async (name) => (await readFile(new URL(name, MIGRATIONS), 'utf8')).replace(/\r\n/g, '\n');
const FUNCTION = /^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?([a-z_]+)\((.*)\) RETURNS boolean LANGUAGE sql IMMUTABLE AS \$\$\n([\s\S]*?)\$\$;$/gm;
const validators = (sql) => Object.fromEntries([...sql.matchAll(FUNCTION)].map(([, name, args, body]) => [name, { args, body }]));

test('migration 016 repeats the nesting validators of 013 and 015 exactly, adding only the schema to each nested call', async () => {
  const after = validators(await read(REPAIR));
  assert.deepEqual(Object.keys(after), Object.keys(NESTED));
  for (const [name, origin] of Object.entries(NESTED)) {
    const before = validators(await read(origin))[name];
    assert.equal(after[name].args, before.args, name);
    assert.equal(after[name].body, before.body.replace(/\b(capital_cents_valid|capital_cost_item_valid|eval_unit_interval)\(/g, 'public.$1('), name);
    assert.doesNotMatch(after[name].body, /(?<!public\.)\b(capital|eval)_\w+\(/, `${name}: every nested call is qualified`);
  }
  // Functions only: no table, grant, row or session statement rides along with the repair.
  const statements = (await read(REPAIR)).replace(/^--.*$/gm, '');
  assert.equal(statements.match(/^CREATE OR REPLACE FUNCTION public\./gm).length, 3);
  assert.doesNotMatch(statements, /\b(CREATE TABLE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|DROP|TRUNCATE|SET)\b/i);
});

test('those three are the only migration validators that call a user function by unqualified name', async () => {
  // SQL-language validators run inside CHECK constraints while rows are copied; trigger functions attach in post-data and
  // never run during a restore. A later migration that adds another unqualified nested validator fails here.
  const sources = await Promise.all((await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql') && name < REPAIR).map(read));
  const names = new Set(sources.flatMap((sql) => [...sql.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?([a-z_]+)\(/gm)].map(([, name]) => name)));
  const nesting = {};
  for (const [name, { body }] of sources.flatMap((sql) => Object.entries(validators(sql)))) {
    const callees = [...new Set([...body.matchAll(/(?<![.\w])([a-z_]+)\(/g)].map(([, callee]) => callee).filter((callee) => names.has(callee)))].sort();
    if (callees.length) nesting[name] = callees;
  }
  assert.deepEqual(nesting, { capital_cost_item_valid: ['capital_cents_valid'], capital_draft_valid: ['capital_cents_valid', 'capital_cost_item_valid'], eval_acceptance_valid: ['eval_unit_interval'] });
});

test('the test database guard refuses anything that could redirect or alter a connection, and client tools get a libpq-free environment', () => {
  const good = 'postgresql://role:secret@127.0.0.1:5432/valcairn_test';
  const database = testDatabase(good, {});
  assert.deepEqual([database.host, database.port, database.user, database.password, database.name], ['127.0.0.1', '5432', 'role', 'secret', 'valcairn_test']);
  const refused = {
    'other scheme': 'mysql://role@127.0.0.1:5432/valcairn_test', 'remote host': 'postgresql://role@db.example.test:5432/valcairn_test', 'no port': 'postgresql://role@127.0.0.1/valcairn_test',
    'options override': 'postgresql://role@127.0.0.1:5432/valcairn_test?options=-csearch_path%3Dpublic', 'hostaddr override': 'postgresql://role@127.0.0.1:5432/valcairn_test?hostaddr=203.0.113.9',
    'sslmode override': 'postgresql://role@127.0.0.1:5432/valcairn_test?sslmode=require', fragment: 'postgresql://role@127.0.0.1:5432/valcairn_test#x', 'no role': 'postgresql://127.0.0.1:5432/valcairn_test',
    'not a test name': 'postgresql://role@127.0.0.1:5432/valcairn', 'test inside a word': 'postgresql://role@127.0.0.1:5432/latest', uppercase: 'postgresql://role@127.0.0.1:5432/Valcairn_test',
    'quote in the name': 'postgresql://role@127.0.0.1:5432/valcairn_test%22', 'hyphen in the name': 'postgresql://role@127.0.0.1:5432/valcairn-test', 'not a url': 'valcairn_test',
  };
  for (const [why, url] of Object.entries(refused)) assert.throws(() => testDatabase(url, {}), Error, why);
  assert.throws(() => testDatabase(good, { NODE_PG_FORCE_NATIVE: '1' }), /NODE_PG_FORCE_NATIVE/);
  assert.throws(() => testDatabase(good, { PGOPTIONS: '-c search_path=public' }), /PGOPTIONS/);
  assert.equal(sibling(database, 'valcairn_restore_test_1').url, 'postgresql://role:secret@127.0.0.1:5432/valcairn_restore_test_1');
  assert.throws(() => sibling(database, 'valcairn_restore_1'), /test database name/);
  assert.throws(() => testDatabaseName('valcairn_test; drop database x'), /test database name/);
  // Every libpq and Docker variable is dropped from the child, whatever its case; only the URL's own password returns, as PGPASSWORD.
  const inherited = { PATH: '/usr/bin', HOME: '/h', PGHOSTADDR: '127.0.0.2', PGSERVICE: 'production', PGOPTIONS: '-c search_path=public', PGPASSFILE: '/x', pgsslmode: 'require', PGPASSWORD: 'other', DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONTEXT: 'elsewhere', DOCKER_CONFIG: '/d', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/c' };
  assert.deepEqual(childEnvironment(database, inherited), { PATH: '/usr/bin', HOME: '/h', PGPASSWORD: 'secret' });
  assert.deepEqual(childEnvironment({ ...database, password: null }, inherited), { PATH: '/usr/bin', HOME: '/h' });
  // Argument lists name only the verified destination and never the password, locally or through docker.
  const local = commandLine('pg_dump', database, ['--format=custom'], { container: '', bin: '' });
  assert.deepEqual(local, ['pg_dump', ['--format=custom', '-h', '127.0.0.1', '-p', '5432', '-U', 'role', '--dbname', 'valcairn_test']]);
  assert.equal(commandLine('pg_dump', database, [], { container: '', bin: '/opt/pg/bin' })[0], join('/opt/pg/bin', 'pg_dump'));
  const pinned = dockerEndpoint({});
  const hosted = commandLine('pg_restore', database, ['--exit-on-error'], { container: 'pg17', bin: '', env: {} });
  assert.deepEqual(hosted, ['docker', ['-H', pinned, 'exec', '-i', '-e', 'PGPASSWORD', 'pg17', 'pg_restore', '--exit-on-error', '-h', '/var/run/postgresql', '-U', 'role', '--dbname', 'valcairn_test']]);
  assert.deepEqual(commandLine('pg_dump', { ...database, password: null }, ['--version'], { container: 'pg17', env: {} })[1], ['-H', pinned, 'exec', '-i', 'pg17', 'pg_dump', '--version', '-h', '/var/run/postgresql', '-U', 'role', '--dbname', 'valcairn_test']);
  assert.throws(() => commandLine('pg_dump', database, [], { container: 'pg17 --privileged', env: {} }), /PG_TOOLS_CONTAINER/);
  for (const [, args] of [local, hosted]) assert.equal(args.includes('secret'), false);
});

test('docker is pinned to a local socket and a container is used only after its own environment proves free of libpq variables; refusals spawn nothing', async () => {
  const database = testDatabase('postgresql://role:secret@127.0.0.1:5432/valcairn_test', {});
  const pinned = dockerEndpoint({});
  // The pin: the platform socket, or DOCKER_HOST when it is itself a Unix socket or named pipe; any TCP or SSH endpoint,
  // even on loopback, and any selected context are refused before docker runs.
  assert.match(pinned, /^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/);
  assert.equal(dockerEndpoint({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }), 'unix:///run/user/1000/docker.sock');
  assert.equal(dockerEndpoint({ DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine', DOCKER_CONTEXT: 'default' }), 'npipe:////./pipe/dockerDesktopLinuxEngine');
  for (const [why, env] of Object.entries({ 'tcp on loopback': { DOCKER_HOST: 'tcp://127.0.0.1:2375' }, 'tls tcp': { DOCKER_HOST: 'tcp://127.0.0.1:2376', DOCKER_TLS_VERIFY: '1' }, ssh: { DOCKER_HOST: 'ssh://user@127.0.0.1' }, 'bare path': { DOCKER_HOST: '/var/run/docker.sock' }, 'pipe with options': { DOCKER_HOST: 'npipe:////./pipe/docker_engine --tlsverify' } })) {
    assert.throws(() => dockerEndpoint(env), /DOCKER_HOST is refused/, why);
  }
  assert.throws(() => dockerEndpoint({ DOCKER_CONTEXT: 'desktop-linux' }), /DOCKER_CONTEXT is refused/);
  // The container's creation-time environment: the official image's own names pass; any libpq name is refused by name only.
  containerEnvironmentCheck(['PATH=/usr/local/sbin:/usr/local/bin', 'GOSU_VERSION=1.17', 'LANG=en_US.utf8', 'PG_MAJOR=17', 'PG_VERSION=17.8', 'PG_SHA256=abc', 'PGDATA=/var/lib/postgresql/data', 'POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=secret']);
  for (const entry of ['PGHOSTADDR=127.0.0.2', 'PGSERVICE=production', 'PGOPTIONS=-c search_path=public', 'PGPASSFILE=/x', 'PGSSLMODE=require', 'PGPASSWORD=secret', 'PGHOST=db', 'pghostaddr=127.0.0.2']) {
    assert.throws(() => containerEnvironmentCheck(['PATH=/usr/bin', entry]), (error) => error.message.includes(entry.split('=')[0]) && !error.message.includes(entry.split('=')[1]), entry);
  }
  // No spawn: `execute` records every command; a refusal happens before any, and a hostile container is abandoned after its inspection.
  const recorder = (answers) => { const calls = []; return { calls, execute: async (command) => { calls.push(command); return answers(command); } }; };
  const refused = recorder(() => { throw new Error('executed'); });
  await assert.rejects(postgresTools({ container: 'pg17', env: { DOCKER_HOST: 'tcp://127.0.0.1:2375' }, execute: refused.execute }).version('pg_dump'), /DOCKER_HOST is refused/);
  await assert.rejects(postgresTools({ container: 'pg17', env: { DOCKER_CONTEXT: 'elsewhere' }, execute: refused.execute }).version('pg_dump'), /DOCKER_CONTEXT is refused/);
  await assert.rejects(postgresTools({ container: 'pg17 --privileged', env: {}, execute: refused.execute }).version('pg_dump'), /PG_TOOLS_CONTAINER must be/);
  assert.deepEqual(refused.calls, []);
  const hostile = recorder(() => ({ code: 0, stdout: Buffer.from(JSON.stringify(['PATH=/usr/bin', 'PGHOSTADDR=127.0.0.2'])), stderr: '' }));
  await assert.rejects(postgresTools({ container: 'pg17', env: { DOCKER_HOST: 'unix:///var/run/docker.sock' }, execute: hostile.execute }).dump(database), /PGHOSTADDR/);
  assert.deepEqual(hostile.calls, [['docker', ['-H', 'unix:///var/run/docker.sock', 'inspect', '--format', '{{json .Config.Env}}', 'pg17']]], 'the inspection ran over the pinned socket and nothing else');
  // A clean container: inspected once, then every tool call goes through the same pinned socket.
  const clean = recorder(([, args]) => ({ code: 0, stdout: Buffer.from(args[2] === 'inspect' ? JSON.stringify(['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/data']) : 'pg_dump (PostgreSQL) 17.8'), stderr: '' }));
  const tools = postgresTools({ container: 'pg17', env: {}, execute: clean.execute });
  assert.deepEqual([await tools.version('pg_dump'), await tools.version('pg_restore')], ['pg_dump (PostgreSQL) 17.8', 'pg_dump (PostgreSQL) 17.8']);
  assert.deepEqual(clean.calls.map(([, args]) => args.slice(0, 3)), [['-H', pinned, 'inspect'], ['-H', pinned, 'exec'], ['-H', pinned, 'exec']]);
});

// The real restore needs a local test database (as tests/store-postgres.test.js) plus pg_dump and pg_restore at least as
// new as the server: on PATH, in the directory PG_BIN, or inside the Docker container named by PG_TOOLS_CONTAINER (the
// hosted job points this at its PostgreSQL 17 service, whose tools match; the runner's own may be older). Only sibling
// databases of the test database are created, every name carries "test", and all are dropped at the end. Without the
// tools the test skips with the reason, except in the hosted job, where it fails: the proof must run there.
const connectionString = process.env.TEST_DATABASE_URL;

const draft = (extra = {}) => ({ purpose: 'Pilot', requestedAmountCents: 5000000, timing: { neededBy: null, termMonths: null }, company: { legalName: 'QA ONLY Co', registrationRef: '', country: '', foundedYear: null, employees: null, website: '', description: '' }, costItems: [{ id: 'ci_1', category: 'compute', label: 'GPU hours', amountCents: 250000, period: 'one_time', basis: 'estimated', source: 'Price list', observedAt: '2026-11-01', evidenceId: null }], references: [], datasetVersions: [], ...extra });
const item = (patch) => ({ ...draft().costItems[0], ...patch });
const without = (object, key) => { const copy = { ...object }; delete copy[key]; return copy; };
const rule = (patch = {}) => ({ version: 1, scoreBasis: 'human_else_auto', minPassRate: 0.9, minCoverage: 1, criticalMustPass: true, requireHumanOnCritical: true, requireHumanOnDisagreement: true, requireHumanWhenNoExpectedAnswer: true, ...patch });
// Inputs each repaired validator must refuse (false, never NULL) and accept, evaluated in the source and in every restored database.
const PROBES = {
  capital_draft_valid: {
    rejected: {
      'null draft': null, 'array draft': [], 'no costItems': {}, 'costItems object': { costItems: {} }, 'null item': { costItems: [null] },
      'missing amount': { costItems: [without(item({}), 'amountCents')] }, 'missing basis': { costItems: [without(item({}), 'basis')] }, 'null amount': { costItems: [item({ amountCents: null })] },
      'string amount': { costItems: [item({ amountCents: '100' })] }, negative: { costItems: [item({ amountCents: -1 })] }, fraction: { costItems: [item({ amountCents: 12.5 })] },
      'over the bound': { costItems: [item({ amountCents: 1000000000001 })] }, 'unknown category': { costItems: [item({ category: 'travel' })] },
      'incurred without evidence': { costItems: [item({ basis: 'incurred', evidenceId: null })] }, 'too many items': { costItems: Array.from({ length: 41 }, () => item({})) },
      'requested zero': { costItems: [], requestedAmountCents: 0 }, 'requested fraction': { costItems: [], requestedAmountCents: 1.5 }, 'requested string': { costItems: [], requestedAmountCents: '5' },
    },
    accepted: { 'empty list': { costItems: [] }, 'null requested amount': { costItems: [], requestedAmountCents: null }, complete: draft(), 'incurred with evidence': { costItems: [item({ basis: 'incurred', evidenceId: 'e1' })] }, 'at the bounds': { costItems: [item({ amountCents: 1000000000000 })], requestedAmountCents: 1 } },
  },
  eval_acceptance_valid: {
    rejected: {
      'null rule': null, 'array rule': [], 'version 2': rule({ version: 2 }), 'string version': rule({ version: '1' }), 'missing pass rate': without(rule(), 'minPassRate'), 'null pass rate': rule({ minPassRate: null }),
      'string rate': rule({ minPassRate: '0.9' }), 'rate above one': rule({ minPassRate: 1.5 }), 'negative coverage': rule({ minCoverage: -0.1 }), 'five decimals': rule({ minPassRate: 0.12345 }),
      'unknown basis': rule({ scoreBasis: 'auto' }), 'string flag': rule({ criticalMustPass: 'yes' }), 'missing flag': without(rule(), 'requireHumanOnCritical'),
    },
    accepted: { complete: rule(), 'at the bounds': rule({ minPassRate: 0, minCoverage: 1 }), 'four decimals': rule({ minPassRate: 0.1234, minCoverage: 0.5 }) },
  },
};
const EXPECTED = Object.fromEntries(Object.entries(PROBES).flatMap(([fn, { rejected, accepted }]) => [...Object.keys(rejected).map((k) => [`${fn}: ${k}`, false]), ...Object.keys(accepted).map((k) => [`${fn}: ${k}`, true])]));
// Every verdict through one connection; with `bare` the session search_path is emptied first, exactly as pg_restore does.
async function verdicts(pool, bare) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (bare) await client.query("SET LOCAL search_path = ''");
    const out = {};
    for (const [fn, { rejected, accepted }] of Object.entries(PROBES)) {
      for (const [name, value] of Object.entries({ ...rejected, ...accepted })) out[`${fn}: ${name}`] = (await client.query(`SELECT public.${fn}($1::jsonb) AS ok`, [JSON.stringify(value)])).rows[0].ok;
    }
    return out;
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}

// Count and digest of every row of every public table (order-independent, as the release helper compares a restore) and
// the definition of every public function.
async function fingerprint(database) {
  const pool = createPostgresPool({ connectionString: database.url, ssl: 'disable' });
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const rows = {};
    for (const { tablename } of (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows) {
      rows[tablename] = (await client.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text), '')) AS digest FROM "${tablename}" t`)).rows[0];
    }
    const functions = (await client.query("SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY p.proname")).rows.map((r) => r.def);
    return { rows, functions };
  } finally { client.release(); await pool.end(); }
}

// A synthetic workspace through the store. Capital: a sent case (frozen submission, evidence, reviewed mark, a claimed
// credit) and an open draft whose items cover the incurred and zero-amount branches. Evaluation: an approved project with a
// dataset version, a set with a case and an acknowledged issue, its frozen version, two imports, a judged comparison and an
// approved report. Nothing here is real data.
async function populate(database) {
  const store = createPostgresStore({ connectionString: database.url, ssl: 'disable' });
  try {
    const owner = await store.createUser({ email: 'owner@example.test', name: 'Owner', passwordHash: 'test-hash' });
    const ws = await store.createWorkspace({ kind: 'organization', name: 'Example', slug: 'example', ownerId: owner.id });
    const sent = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Pilot', draft: draft() });
    const mine = { workspaceId: ws.id, caseId: sent.id };
    const evidence = await store.addCapitalEvidence({ ...mine, createdBy: owner.id, item: { kind: 'company_record', title: 'Statement', source: 'Held by the company', reference: {}, verification: 'unverified' } });
    await store.createCreditRecord({ workspaceId: ws.id, createdBy: owner.id, record: { provider: 'Cloud', status: 'claimed', amountCents: 1000000, expiresOn: '2027-06-30', restrictions: '', reference: '' } });
    const contentHash = snapshotHash(capitalSnapshot(await store.getCapitalCase(mine), await store.listCreditRecords(ws.id), await store.listCapitalEvidence(mine)));
    const submission = await store.submitCapitalCase({ ...mine, submittedBy: owner.id, expectedRevision: 1, contentHash });
    await store.markCapitalEvidenceReviewed({ caseId: sent.id, submissionId: submission.id, evidenceId: evidence.id, reviewerId: owner.id });
    const open = await store.createCapitalCase({ workspaceId: ws.id, createdBy: owner.id, title: 'Open', draft: draft({ costItems: [] }) });
    const cited = await store.addCapitalEvidence({ workspaceId: ws.id, caseId: open.id, createdBy: owner.id, item: { kind: 'cost_assumption', title: 'Invoice', source: 'x', reference: {}, verification: 'unverified' } });
    await store.updateCapitalCase({ workspaceId: ws.id, caseId: open.id, expectedRevision: 1, title: 'Open', draft: draft({ costItems: [item({ basis: 'incurred', evidenceId: cited.id }), item({ id: 'ci_2', category: 'storage', period: 'monthly', basis: 'quoted', amountCents: 0 })] }) });

    const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Support', task: 'Answer policy questions.', modalities: ['Text'], startingPoint: 'model' });
    await store.updateProject({ workspaceId: ws.id, projectId: project.id, patch: { success: { measure: 'exact', target: 'the cited policy' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['testing'] } } });
    const review = await store.submitForReview({ workspaceId: ws.id, projectId: project.id, submittedBy: owner.id });
    await store.decideReview({ reviewId: review.id, reviewerId: owner.id, decision: 'approved', checks: {} });
    const dataset = await store.createDatasetVersion({ workspaceId: ws.id, projectId: project.id, createdBy: owner.id });
    const at = { workspaceId: ws.id, projectId: project.id };
    const set = await store.createEvalSet({ ...at, createdBy: owner.id, name: 'Policy', purpose: 'final_assessment' });
    const source = { projectId: project.id, versionId: dataset.id, fileId: null };
    await store.saveEvalCase({ ...at, setId: set.id, expectedRevision: set.revision, input: { id: 'returns', input: 'Question returns', expectedAnswer: '30 days', reviewCriteria: 'Name the window.', category: 'returns', severity: 'critical', sources: [source] } });
    let detail = await store.getEvalSet({ ...at, setId: set.id });
    await store.saveEvalCase({ ...at, setId: set.id, expectedRevision: detail.set.revision, input: { id: 'returns-2', input: 'Question returns', expectedAnswer: '14 days', sources: [source] } });
    detail = await store.getEvalSet({ ...at, setId: set.id });
    const issue = detail.issues.find((entry) => entry.acknowledgeable);
    if (issue) await store.setEvalIssueNote({ ...at, setId: set.id, expectedRevision: detail.set.revision, key: issue.key, note: 'Both windows are documented.', createdBy: owner.id });
    detail = await store.getEvalSet({ ...at, setId: set.id });
    const frozen = await store.freezeEvalSet({ ...at, setId: set.id, expectedRevision: detail.set.revision, actorId: owner.id });
    const imported = async (role, label, jsonl) => (await store.importEvalPredictions({ ...at, versionId: frozen.id, role, label, claimedSystem: {}, claimedScorer: null, filename: `${role}.jsonl`, jsonl, importedBy: owner.id })).batch.id;
    const lines = (output) => ['returns', 'returns-2'].map((id) => JSON.stringify({ id, status: 'answered', output })).join('\n') + '\n';
    const baseline = await imported('baseline', 'old', lines('30 days'));
    const candidate = await imported('candidate', 'new', lines('14 days'));
    const comparison = await store.createEvalComparison({ ...at, setId: set.id, versionId: frozen.id, baselineBatchId: baseline, candidateBatchId: candidate, createdBy: owner.id });
    const judged = await store.recordEvalJudgment({ workspaceId: ws.id, comparisonId: comparison.id, expectedRevision: comparison.revision, caseKey: 'returns', reviewerId: owner.id, patch: { baselineDecision: 'pass', candidateDecision: 'fail', adjudicationBaseline: null, adjudicationCandidate: null, note: 'Wrong window.' } });
    const preview = await store.readEvalComparison({ workspaceId: ws.id, comparisonId: comparison.id });
    const report = await store.approveEvalReport({ workspaceId: ws.id, comparisonId: comparison.id, expectedRevision: judged.comparison.revision, contentHash: preview.contentHash, approvedBy: owner.id });
    return { ...mine, contentHash, versionId: frozen.id, versionHash: frozen.contentHash, reportId: report.id, reportHash: report.contentHash, notes: issue ? 1 : 0 };
  } finally { await store.close(); }
}

const FROZEN = ['capital_submissions', 'credit_records', 'capital_review_marks', 'eval_set_versions', 'eval_batches', 'eval_predictions', 'eval_reports'];

test('a backup holding Capital and Evaluation rows restores with the normal pg_restore arguments only once 016 is applied', { skip: !connectionString && 'TEST_DATABASE_URL is not set', timeout: 300_000 }, async (t) => {
  const base = testDatabase(connectionString);
  const tools = postgresTools();
  const hosted = Boolean(process.env.GITHUB_ACTIONS);
  const versions = Object.fromEntries(await Promise.all(['pg_dump', 'pg_restore'].map(async (tool) => [tool, await tools.version(tool)])));
  const admin = createPostgresPool({ connectionString: base.url, ssl: 'disable' });
  const serverMajor = Math.floor((await admin.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v / 10000);
  const majors = Object.values(versions).map((line) => Number(/\(PostgreSQL\) (\d+)/.exec(line ?? '')?.[1]) || 0);
  const unavailable = majors.some((major) => !major) ? 'pg_dump and pg_restore are not available (PATH, PG_BIN or PG_TOOLS_CONTAINER)'
    : Math.min(...majors) < serverMajor ? `client tools (major ${majors.join('/')}) are older than the PostgreSQL ${serverMajor} server` : null;
  if (unavailable) {
    await admin.end();
    if (hosted) assert.fail(`${unavailable}; the hosted PostgreSQL job must run the real restore`);
    return t.skip(unavailable);
  }
  t.diagnostic(`${process.env.PG_TOOLS_CONTAINER ? 'container' : 'local'} tools: ${versions.pg_dump}; ${versions.pg_restore}; server major ${serverMajor}`);
  const tag = randomBytes(4).toString('hex');
  const databases = Object.fromEntries(['source', 'before', 'after'].map((role) => [role, sibling(base, `valcairn_restore_test_${tag}_${role}`)]));
  const work = await mkdtemp(join(tmpdir(), 'valcairn-restore-'));
  const pools = [];
  const pool = (database) => { const p = createPostgresPool({ connectionString: database.url, ssl: 'disable' }); pools.push(p); return p; };
  try {
    for (const { name } of Object.values(databases)) await admin.query(`CREATE DATABASE "${name}"`);
    // 1. The schema as released through 015, populated through the store.
    const through015 = join(work, 'through-015');
    await mkdir(through015);
    const earlier = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql') && name < REPAIR);
    for (const name of earlier) await copyFile(new URL(name, MIGRATIONS), join(through015, name));
    const source = pool(databases.source);
    assert.equal((await applyMigrations({ pool: source, directory: through015 })).length, 15);
    const fixture = await populate(databases.source);
    const sourceBefore = await fingerprint(databases.source);
    const counts = (print) => Object.fromEntries(['capital_cases', 'capital_submissions', 'capital_evidence', 'credit_records', 'capital_review_marks', 'eval_sets', 'eval_cases', 'eval_issue_notes', 'eval_set_versions', 'eval_batches', 'eval_predictions', 'eval_comparisons', 'eval_judgments', 'eval_reports', 'schema_migrations'].map((table) => [table, print.rows[table].count]));
    assert.deepEqual(counts(sourceBefore), { capital_cases: 2, capital_submissions: 1, capital_evidence: 2, credit_records: 1, capital_review_marks: 1, eval_sets: 1, eval_cases: 2, eval_issue_notes: fixture.notes, eval_set_versions: 1, eval_batches: 2, eval_predictions: 4, eval_comparisons: 1, eval_judgments: 1, eval_reports: 1, schema_migrations: 15 });
    assert.deepEqual(await verdicts(source, false), EXPECTED, 'the 013 and 015 validators work on the ordinary search_path');
    await assert.rejects(verdicts(source, true), { code: '42883' }, 'and cannot resolve their nested calls on the search_path pg_restore uses');

    // 2. Baseline failure, preserved: the normal restore of a real dump stops at the first COPY that runs a nesting validator and rolls back.
    const dumpBefore = await tools.dump(databases.source);
    const failed = await tools.restore(databases.before, dumpBefore);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /COPY failed for table "(capital_cases|eval_sets|eval_comparisons)": ERROR:\s+function (capital_cost_item_valid|eval_unit_interval)\(jsonb\) does not exist/);
    assert.deepEqual((await fingerprint(databases.before)).rows, {}, 'the target transaction rolled back: no table');
    t.diagnostic(`baseline pg_restore exit ${failed.code}: ${failed.stderr.trim().split('\n').find((line) => line.includes('COPY failed'))}`);

    // 3. On the old schema itself (pre-data only, so no foreign keys yet), a row insert under the restore session's empty
    // search_path fails for exactly the tables whose CHECK runs a nesting validator and passes where the validator is built-ins only.
    assert.equal((await tools.restore(databases.before, dumpBefore, ['--section=pre-data'])).code, 0);
    const before = pool(databases.before);
    const attempt = async (sql, params) => {
      const client = await before.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL search_path = ''");
        try { await client.query(sql, params); return null; } catch (error) { return `${error.code} ${error.message}`; }
      } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    };
    const [id, other] = [randomUUID(), randomUUID()];
    assert.match(await attempt("INSERT INTO public.capital_cases (workspace_id, title, draft, created_by) VALUES ($1, 'x', $2::jsonb, $1)", [id, JSON.stringify(draft())]), /^42883 function capital_cost_item_valid\(jsonb\) does not exist/);
    assert.match(await attempt("INSERT INTO public.eval_sets (workspace_id, project_id, name, purpose, acceptance, rubric_version, created_by) VALUES ($1, $1, 'x', 'development', $2::jsonb, 'r1', $1)", [id, JSON.stringify(rule())]), /^42883 function eval_unit_interval\(jsonb\) does not exist/);
    assert.match(await attempt('INSERT INTO public.eval_comparisons (workspace_id, set_id, version_id, baseline_batch_id, candidate_batch_id, acceptance, created_by) VALUES ($1, $1, $1, $1, $2, $3::jsonb, $1)', [id, other, JSON.stringify(rule())]), /^42883 function eval_unit_interval\(jsonb\) does not exist/);
    assert.equal(await attempt("INSERT INTO public.eval_cases (set_id, workspace_id, case_key, input, source_refs) VALUES ($1, $1, 'k', 'q', '[]'::jsonb)", [id]), null, 'eval_source_refs_valid is built-ins only');
    assert.equal(await attempt("INSERT INTO public.credit_records (workspace_id, provider, status, amount_cents, created_by) VALUES ($1, 'x', 'claimed', 1, $1)", [id]), null, 'plain CHECKs need no function');

    // 4. 016 applies once, a rerun applies nothing, and no row changes; exactly three functions change and resolve under any search_path.
    assert.deepEqual(await applyMigrations({ pool: source }), [REPAIR]);
    assert.deepEqual(await applyMigrations({ pool: source }), []);
    const sourceAfter = await fingerprint(databases.source);
    const { schema_migrations: ledgerBefore, ...rowsBefore } = sourceBefore.rows;
    const { schema_migrations: ledgerAfter, ...rowsAfter } = sourceAfter.rows;
    assert.deepEqual(rowsAfter, rowsBefore, 'every row of every other table is byte-for-byte as before');
    assert.deepEqual([ledgerBefore.count, ledgerAfter.count], [15, 16]);
    assert.equal(sourceAfter.functions.length, sourceBefore.functions.length);
    assert.deepEqual(sourceAfter.functions.filter((def, i) => def !== sourceBefore.functions[i]).map((def) => /FUNCTION public\.([a-z_]+)\(/.exec(def)[1]), Object.keys(NESTED));
    assert.deepEqual(await verdicts(source, true), EXPECTED);
    assert.deepEqual(await verdicts(source, false), EXPECTED);

    // 5. The same normal restore now succeeds and reproduces every row, frozen records included, and every function.
    const dumpAfter = await tools.dump(databases.source);
    const restored = await tools.restore(databases.after, dumpAfter);
    assert.equal(restored.code, 0, restored.stderr);
    assert.doesNotMatch(restored.stderr, /error/i);
    const afterPrint = await fingerprint(databases.after);
    assert.deepEqual(Object.fromEntries(FROZEN.map((table) => [table, afterPrint.rows[table]])), Object.fromEntries(FROZEN.map((table) => [table, sourceAfter.rows[table]])), 'frozen rows');
    assert.deepEqual(afterPrint, sourceAfter, 'all public tables and functions');
    const after = pool(databases.after);
    assert.deepEqual(await verdicts(after, false), EXPECTED);
    assert.deepEqual(await verdicts(after, true), EXPECTED);
    const [{ workspace_id: workspaceId, created_by: createdBy }] = (await after.query('SELECT workspace_id, created_by FROM capital_cases LIMIT 1')).rows;
    const [{ project_id: projectId }] = (await after.query('SELECT project_id FROM eval_sets LIMIT 1')).rows;
    for (const [name, value] of Object.entries(PROBES.capital_draft_valid.rejected)) {
      await assert.rejects(after.query("INSERT INTO capital_cases (workspace_id, title, draft, created_by) VALUES ($1, 'x', $2::jsonb, $3)", [workspaceId, JSON.stringify(value), createdBy]), { code: '23514' }, `restored CHECK refuses ${name}`);
    }
    for (const [name, value] of Object.entries(PROBES.eval_acceptance_valid.rejected)) {
      await assert.rejects(after.query("INSERT INTO eval_sets (workspace_id, project_id, name, purpose, acceptance, rubric_version, created_by) VALUES ($1, $2, 'x', 'development', $3::jsonb, 'r1', $4)", [workspaceId, projectId, JSON.stringify(value), createdBy]), { code: '23514' }, `restored CHECK refuses ${name}`);
    }
    await assert.rejects(after.query("UPDATE capital_submissions SET snapshot = '{}'::jsonb"), /submission_frozen/, 'the freeze trigger survived the restore');
    await assert.rejects(after.query('DELETE FROM credit_records'), /credit_record_frozen/);
    await assert.rejects(after.query("UPDATE eval_set_versions SET content_hash = repeat('a', 64)"), /eval_frozen/);
    await assert.rejects(after.query('DELETE FROM eval_reports'), /eval_frozen/);
    const restoredStore = createPostgresStore({ connectionString: databases.after.url, ssl: 'disable' });
    try {
      const [submission] = await restoredStore.listCapitalSubmissions(fixture);
      assert.equal(submission.contentHash, fixture.contentHash);
      assert.equal(snapshotHash(submission.snapshot), fixture.contentHash, 'the frozen Capital snapshot still hashes to the consented value');
      assert.equal((await restoredStore.getCapitalCase(fixture)).status, 'submitted');
      const version = await restoredStore.getEvalVersion({ workspaceId: fixture.workspaceId, versionId: fixture.versionId });
      assert.equal(version.contentHash, fixture.versionHash);
      const report = await restoredStore.getEvalReport({ workspaceId: fixture.workspaceId, reportId: fixture.reportId });
      assert.equal(snapshotHash(report.snapshot), fixture.reportHash, 'the frozen report still hashes to its approved value');
    } finally { await restoredStore.close(); }

    // 6. A backup taken before 016 is recovered in stages: the schema (restored above), then 016's statements, then the rows and the rest.
    await before.query(await read(REPAIR));
    assert.equal((await tools.restore(databases.before, dumpBefore, ['--section=data', '--section=post-data'])).code, 0);
    assert.deepEqual((await fingerprint(databases.before)).rows, sourceBefore.rows, 'every pre-016 row, ledger included');
    assert.deepEqual(await applyMigrations({ pool: before }), [REPAIR], 'the migrator then records 016 without changing anything');
    const recovered = await fingerprint(databases.before);
    assert.deepEqual({ ...recovered, rows: without(recovered.rows, 'schema_migrations') }, { ...sourceAfter, rows: without(sourceAfter.rows, 'schema_migrations') }, 'the recovered database matches the repaired source, apart from when 016 was recorded');
    assert.equal(recovered.rows.schema_migrations.count, 16);
  } finally {
    for (const p of pools) await p.end().catch(() => {});
    for (const { name } of Object.values(databases)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end();
    await rm(work, { recursive: true, force: true });
  }
});
