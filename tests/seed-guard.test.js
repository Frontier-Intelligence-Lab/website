import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { FIXTURE_CATALOG } from './helpers.js';

// Security review of the Compute union: the demo seed checked only the URL's authority, while the installed pg
// connection-string parser reads ?host= (a name or a %2F... socket directory), ?port= and ?user= over it. The seed
// hands DATABASE_URL to pg as written, so what it validates must be what pg connects to. Nothing here connects: every
// seed subprocess runs under a preload that makes any socket or lookup fail with a sentinel, refusals are asserted to
// happen without that sentinel ever appearing, and the driver comparison only constructs a client.

const BLOCKER = pathToFileURL(join(import.meta.dirname, 'fixtures', 'block-network.mjs')).href;
const SENTINEL = 'VALCAIRN_TEST_NETWORK_BLOCKED';
const LOOPBACK = 'postgresql://u:synthetic-pass@127.0.0.1:5432/valcairn_test';
// Every override the installed driver would honour, the ones it ignores, and the shapes that hide them.
const OVERRIDES = {
  'remote host': `${LOOPBACK}?host=remote.example`,
  'socket directory': `${LOOPBACK}?host=%2Ftmp%2Fpostgres`,
  'repeated key, last wins': `${LOOPBACK}?host=127.0.0.1&host=remote.example`,
  'percent-encoded key': `${LOOPBACK}?%68ost=remote.example`,
  'percent-encoded value': `${LOOPBACK}?host=remote%2Eexample`,
  port: `${LOOPBACK}?port=9999`,
  user: `${LOOPBACK}?user=other_synthetic`,
  hostaddr: `${LOOPBACK}?hostaddr=remote.example`,
  dbname: `${LOOPBACK}?dbname=production`,
  database: `${LOOPBACK}?database=production`,
  service: `${LOOPBACK}?service=production`,
  'options after no port': 'postgresql://u:synthetic-pass@localhost/valcairn_test?host=remote.example',
  fragment: `${LOOPBACK}#host=remote.example`,
};

// The real seed as a subprocess, under the network blocker, with the objects directory it must never create.
function seedHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'valcairn-seed-guard-'));
  const objects = join(dir, 'objects');
  const run = (DATABASE_URL, extraEnv = {}) => {
    const env = { ...process.env, NODE_ENV: 'development', MODEL_CATALOG_FILE: FIXTURE_CATALOG, DATABASE_URL };
    delete env.NODE_PG_FORCE_NATIVE;
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, ['--import', BLOCKER, 'scripts/seed-train-demo.js', '--model', 'fixture-dense-8b', '--objects', objects, '--disposable-db'], { env, encoding: 'utf8', timeout: 60_000 });
  };
  const refused = (res, message, label) => {
    const out = `${res.stdout}${res.stderr}`;
    assert.equal(res.status, 2, `${label}: ${out}`);
    assert.match(res.stderr, message, label);
    assert.ok(!out.includes(SENTINEL), `${label}: refused before any connection or lookup was attempted`);
    assert.ok(!out.includes('synthetic-pass'), 'credentials are never printed');
  };
  return { objects, run, refused, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the network blocker: under the preload a connection or lookup fails with the sentinel before any network', () => {
  const attempt = (code) => spawnSync(process.execPath, ['--import', BLOCKER, '-e', code], { encoding: 'utf8', timeout: 30_000 });
  const socket = attempt("import('node:net').then((net) => net.connect(1, '127.0.0.1'))");
  assert.notEqual(socket.status, 0);
  assert.ok(socket.stderr.includes(SENTINEL), socket.stderr);
  const lookup = attempt("import('node:dns').then((dns) => dns.promises.lookup('localhost'))");
  assert.notEqual(lookup.status, 0);
  assert.ok(lookup.stderr.includes(SENTINEL), lookup.stderr);
});

test('seed guard: a loopback authority with any ?option or #fragment is refused before anything is created', () => {
  const h = seedHarness();
  try {
    for (const [name, url] of Object.entries(OVERRIDES)) h.refused(h.run(url), /must carry no \?options or #fragment/, name);
    // The earlier refusals still come first for their own cases, and an empty authority is not a loophole either:
    // the driver would fall back to PGHOST for it, but the URL is refused before that.
    for (const [url, message] of [['postgresql://u:synthetic-pass@/valcairn_test', /not a valid URL|this machine/], ['postgresql://u:synthetic-pass@remote.example/valcairn_test', /this machine/], ['postgresql://u:synthetic-pass@127.0.0.1:5432/valcairn', /"demo", "test" or "qa"/]]) {
      h.refused(h.run(url), message, url.replace('synthetic-pass', '…'));
    }
    assert.equal(existsSync(h.objects), false, 'no object path was created by any refused run');
  } finally { h.done(); }
});

test('seed guard: NODE_PG_FORCE_NATIVE is refused in pg’s own truthiness (any non-empty string, even "0") before pg can load', () => {
  const h = seedHarness();
  try {
    for (const value of ['1', '0', 'false', 'no', ' ']) h.refused(h.run(LOOPBACK, { NODE_PG_FORCE_NATIVE: value }), /Unset NODE_PG_FORCE_NATIVE/, `NODE_PG_FORCE_NATIVE=${JSON.stringify(value)}`);
    assert.equal(existsSync(h.objects), false, 'no object path was created');
  } finally { h.done(); }
});

// What the installed pure-JS driver actually resolves from each shape, constructed only (no connect), so the guard's
// refusals are tied to real behaviour and a driver upgrade that changes it fails here.
const resolved = (connectionString, env = {}) => {
  const saved = Object.fromEntries(['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGSERVICE', 'PGDATABASE', 'PGUSER'].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const { host, port, user, database } = new pg.Client({ connectionString }).connectionParameters;
    return { host, port, user, database };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
  }
};

test('installed pg: which URL options and PG* defaults change the destination, so the guard refuses the honoured ones and relies on none of the ignored ones', () => {
  const base = { host: '127.0.0.1', port: 5432, user: 'u', database: 'valcairn_test' };
  assert.deepEqual(resolved(LOOPBACK), base, 'the guard-accepted shape resolves to the authority and path');
  // Honoured over the authority: these are exactly why ?options are refused.
  assert.equal(resolved(OVERRIDES['remote host']).host, 'remote.example');
  assert.equal(resolved(OVERRIDES['socket directory']).host, '/tmp/postgres');
  assert.equal(resolved(OVERRIDES['repeated key, last wins']).host, 'remote.example');
  assert.equal(resolved(OVERRIDES['percent-encoded key']).host, 'remote.example');
  assert.equal(resolved(OVERRIDES['percent-encoded value']).host, 'remote.example');
  assert.equal(resolved(OVERRIDES.port).port, 9999);
  assert.equal(resolved(OVERRIDES.user).user, 'other_synthetic');
  // Ignored by this pure-JS driver (no libpq here): refused anyway, never relied on.
  assert.deepEqual(resolved(OVERRIDES.hostaddr), base);
  assert.deepEqual(resolved(OVERRIDES.dbname), base);
  assert.deepEqual(resolved(OVERRIDES.database), base, 'the path wins over ?database=');
  assert.deepEqual(resolved(OVERRIDES.service), base);
  assert.deepEqual(resolved(OVERRIDES.fragment), base, 'a fragment changes nothing; refused for simplicity');
  // Environment defaults against the guard-accepted shape: host and database come from the URL, so PGHOST and
  // PGDATABASE never apply; PGHOSTADDR and PGSERVICE are never read; PGPORT applies only when the URL names no port,
  // and then still to the loopback host; PGUSER applies only when the URL names no user.
  const hostile = { PGHOST: 'remote.example', PGHOSTADDR: 'remote.example', PGSERVICE: 'production', PGDATABASE: 'production', PGUSER: 'other_synthetic' };
  assert.deepEqual(resolved(LOOPBACK, hostile), base);
  assert.deepEqual(resolved('postgresql://u:synthetic-pass@localhost/valcairn_test', { ...hostile, PGPORT: '9999' }), { host: 'localhost', port: 9999, user: 'u', database: 'valcairn_test' });
  assert.deepEqual(resolved(LOOPBACK, { PGPORT: '9999' }), base, 'a port in the URL wins over PGPORT');
  assert.equal(resolved('postgresql://127.0.0.1:5432/valcairn_test', { PGUSER: 'other_synthetic' }).user, 'other_synthetic', 'identity only, never the destination');
  // An empty authority is where PGHOST would apply; the guard refuses that URL before the driver sees it.
  assert.equal(resolved('postgresql://u:synthetic-pass@/valcairn_test', { PGHOST: 'remote.example' }).host, 'remote.example');
  // The native backend is selected by the same truthiness the seed refuses: any non-empty string.
  for (const value of ['1', '0', 'false']) assert.equal(Boolean(value), true, value);
  assert.equal(Boolean(''), false);
});
