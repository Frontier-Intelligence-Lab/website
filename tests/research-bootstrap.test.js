import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = '00000000-0000-4000-8000-000000000001';
const local = 'postgresql://qa:synthetic-password@127.0.0.1:1/valcairn_bootstrap_test';
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|home|temp|tmp|userprofile)$/i.test(key)));
// Even a regressed guard may not send a packet: pg's socket entry is trapped in this child only.
const trap = 'data:text/javascript,' + encodeURIComponent("import net from 'node:net'; net.Socket.prototype.connect = function () { throw new Error('TEST_NETWORK_ATTEMPT'); };");
const run = (env, args = []) => spawnSync(process.execPath, ['--import', trap, 'scripts/research-bootstrap.js', '--environment', 'test', '--workspace', workspace, ...args],
  { cwd: root, env: { ...baseEnv, NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 10_000, windowsHide: true });

test('bootstrap previews only an explicit PostgreSQL test destination, including canonical IPv6, without opening a socket', () => {
  for (const url of [local, local.replace('127.0.0.1', '[::1]'), local.replace('127.0.0.1', 'localhost')]) {
    const result = run({ DATABASE_URL: url });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual([JSON.parse(result.stdout).dryRun, JSON.parse(result.stdout).records], [true, 62]);
    assert.doesNotMatch(result.stderr, /TEST_NETWORK_ATTEMPT/);
  }
});

test('bootstrap refuses URL and ambient driver redirection before config, catalog, store or network and never falls back to memory', () => {
  const badUrls = [undefined, '', 'not-a-url', local.replace('postgresql:', 'https:'), local.replace('127.0.0.1', 'remote.example.test'),
    local.replace(':1/', '/'), local.replace(':1/', ':0/'), local.replace('qa:synthetic-password@', ''), local.replace('bootstrap_test', 'latest'),
    local.replace('bootstrap_test', 'bootstrap_test%22'), `${local}?host=remote.example.test`, `${local}?hostaddr=203.0.113.2`,
    `${local}?dbname=other`, `${local}?options=-csearch_path%3Dpublic`, `${local}?sslmode=require`, `${local}#other`];
  const cases = badUrls.map((url) => ({ DATABASE_URL: url }));
  for (const key of ['NODE_PG_FORCE_NATIVE', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGDATABASE', 'PGPASSWORD']) {
    cases.push({ DATABASE_URL: local, [key]: 'synthetic-override' });
  }
  cases.push({ DATABASE_URL: local, NODE_ENV: 'production' });
  for (const env of cases) {
    // A nonexistent catalog proves refusal precedes file loading too, while --apply forces the durable path if allowed.
    const result = run(env, ['--apply', '--catalog', 'must-not-read-this-file.json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Refusing|DATABASE_URL/);
    assert.doesNotMatch(result.stderr, /TEST_NETWORK_ATTEMPT|ENOENT|synthetic-password|remote\.example\.test/);
  }
});
