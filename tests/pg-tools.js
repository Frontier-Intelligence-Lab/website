import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Test-only access to a local PostgreSQL for dump and restore proofs. Every destination is checked before use, and every
// client process gets an environment without libpq or Docker variables, so an inherited PGHOSTADDR, PGSERVICE, PGOPTIONS,
// PGPASSFILE, DOCKER_HOST, DOCKER_CONTEXT or similar cannot redirect or alter a connection behind the explicit arguments.
// Docker is always pinned to a local Unix socket or named pipe, and a container is used only after its own environment
// has been read and found free of libpq variables. Nothing here prints a URL, a password or an environment value, and no
// argument list ever carries the password.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DOCKER_LOCAL = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';

/** A database name this suite may create, dump, restore or drop: a plain lowercase identifier with "test" as one of its parts. */
export function testDatabaseName(name) {
  if (!/^[a-z0-9_]{1,63}$/.test(name) || !/(^|_)test(_|$)/.test(name)) throw new Error('A test database name is lowercase letters, digits and underscores, at most 63 characters, with "test" as one of its parts');
  return name;
}

/** Parse TEST_DATABASE_URL into a verified loopback destination; anything that could redirect or alter a connection is refused. */
export function testDatabase(value, env = process.env) {
  // The in-process driver takes host, port, role, database and TLS from the URL and the explicit options; it would still
  // obey these two, so they are refused outright rather than filtered.
  if (env.NODE_PG_FORCE_NATIVE) throw new Error('NODE_PG_FORCE_NATIVE is refused: the native driver obeys libpq environment overrides');
  if (env.PGOPTIONS) throw new Error('PGOPTIONS is refused: it would change session behaviour behind the test connection');
  let url;
  try { url = new URL(value); } catch { throw new Error('TEST_DATABASE_URL is not a URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL must use the postgresql scheme');
  if (!LOOPBACK.has(url.hostname.toLowerCase())) throw new Error('TEST_DATABASE_URL must point at loopback');
  if (!/^[0-9]{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('TEST_DATABASE_URL must carry an explicit port');
  if (url.search || url.hash) throw new Error('TEST_DATABASE_URL must carry no query or fragment: no options, sslmode, host or hostaddr override');
  if (!url.username) throw new Error('TEST_DATABASE_URL must name its role');
  const name = testDatabaseName(decodeURIComponent(url.pathname.slice(1)));
  return { url: url.href, host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, user: decodeURIComponent(url.username), password: url.password ? decodeURIComponent(url.password) : null, name };
}

/** The same server and role, another test database. */
export function sibling(database, name) {
  const url = new URL(database.url);
  url.pathname = `/${testDatabaseName(name)}`;
  return { ...database, name, url: url.href };
}

/** A child environment with every libpq and Docker variable removed; the password, if any, goes back in as PGPASSWORD only. */
export function childEnvironment(database, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(PG|DOCKER_)/i.test(key)));
  if (database?.password) env.PGPASSWORD = database.password;
  return env;
}

/**
 * The local daemon endpoint every docker call is pinned to with `-H`, which the CLI honours before DOCKER_HOST,
 * DOCKER_CONTEXT and the configured current context: the platform socket, or DOCKER_HOST when it names a Unix socket or
 * named pipe itself. A TCP or SSH endpoint, or a selected context, is refused here, before docker runs at all.
 */
export function dockerEndpoint(env = process.env) {
  if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default') throw new Error('DOCKER_CONTEXT is refused: the test transport uses only the local default daemon');
  const host = env.DOCKER_HOST || DOCKER_LOCAL;
  if (!/^(unix:\/\/\/\S+|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+)$/.test(host)) throw new Error('DOCKER_HOST is refused: only a local Unix socket or named pipe may serve the test transport');
  return host;
}

/**
 * `docker exec` starts from the container's creation-time environment, so a libpq variable set there would route or alter
 * the connection behind the explicit arguments. Every name libpq might read (PG followed by a letter) is refused; PGDATA
 * is the server's data directory and PG_* are the image's version facts, neither read by libpq. Values are never shown.
 */
export function containerEnvironmentCheck(entries) {
  const names = entries.map((entry) => entry.split('=')[0]).filter((name) => /^PG[A-Za-z]/i.test(name) && name !== 'PGDATA').sort();
  if (names.length) throw new Error(`PG_TOOLS_CONTAINER is refused: its environment sets libpq variables that could redirect or alter the connection: ${names.join(', ')}`);
}

function dockerCommand(container, env, args) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new Error('PG_TOOLS_CONTAINER must be a plain container name or id');
  return ['docker', ['-H', dockerEndpoint(env), ...args]];
}

/**
 * The program and arguments for one client tool: local binaries (PATH, or the directory PG_BIN) or `docker exec` into the
 * PostgreSQL container named by PG_TOOLS_CONTAINER, whose own tools match its server (the hosted job's service container).
 * Inside the container the server is reached over its socket. The password is never an argument: locally it rides in
 * PGPASSWORD, and a bare `-e PGPASSWORD` tells docker to pass that variable through from its own environment.
 */
export function commandLine(tool, database, args, { container = process.env.PG_TOOLS_CONTAINER, bin = process.env.PG_BIN, env = process.env } = {}) {
  const target = database ? [...(container ? ['-h', '/var/run/postgresql'] : ['-h', database.host, '-p', database.port]), '-U', database.user, '--dbname', database.name] : [];
  return container
    ? dockerCommand(container, env, ['exec', '-i', ...(database?.password ? ['-e', 'PGPASSWORD'] : []), container, tool, ...args, ...target])
    : [bin ? join(bin, tool) : tool, [...args, ...target]];
}

/** Run one client tool: stdout is binary (an archive), stderr text, stdin the archive to restore. */
export function run([file, args], env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    if (input) {
      // A restore that stops early closes its input; that is reported through the exit code, not as a stream error.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** pg_dump and pg_restore for the databases of one verified server. `execute` replaces `run` in tests that must not spawn. */
export function postgresTools({ container = process.env.PG_TOOLS_CONTAINER, bin = process.env.PG_BIN, env = process.env, execute = run } = {}) {
  const options = { container, bin, env };
  let inspected = false;
  // In container mode the container's own environment is read once, over the pinned local daemon, and refused if it
  // carries any libpq variable; nothing runs inside the container before that.
  const ready = async () => {
    if (!container || inspected) return;
    const result = await execute(dockerCommand(container, env, ['inspect', '--format', '{{json .Config.Env}}', container]), childEnvironment(null, env));
    if (result.code !== 0) throw new Error(`docker inspect exited ${result.code}: ${result.stderr.trim()}`);
    containerEnvironmentCheck(JSON.parse(result.stdout.toString()));
    inspected = true;
  };
  const call = async (tool, database, args, input) => {
    const command = commandLine(tool, database, args, options);
    await ready();
    return execute(command, childEnvironment(database, env), input);
  };
  return {
    /** The tool's own version line, or null when it cannot be started. */
    async version(tool) {
      const result = await call(tool, null, ['--version']).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      return result?.code === 0 ? result.stdout.toString().trim() : null;
    },
    /** A custom-format archive of one database, as the release helper takes it. */
    async dump(database) {
      const result = await call('pg_dump', database, ['--format=custom', '--no-owner', '--no-acl']);
      if (result.code !== 0) throw new Error(`pg_dump exited ${result.code}: ${result.stderr.trim()}`);
      return result.stdout;
    },
    /** The documented restore, with no search_path or other session override; `sections` narrows it for a staged recovery. */
    restore: (database, archive, sections = []) => call('pg_restore', database, ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', ...sections], archive),
  };
}
