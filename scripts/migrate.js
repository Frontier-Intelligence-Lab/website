import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPostgresPool } from '../src/store/postgres.js';

const defaultDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Apply numbered SQL files in order; a supplied pool controls the target schema. */
export async function applyMigrations({ pool, connectionString, ssl = 'disable', logger, directory = defaultDirectory } = {}) {
  if (!pool && !connectionString) throw new Error('DATABASE_URL is required to run migrations');
  const ownedPool = !pool;
  pool ??= createPostgresPool({ connectionString, ssl, logger });
  let client;
  try {
    client = await pool.connect();
    // Serialize migration runners for this database/schema, including ledger creation.
    await client.query('SELECT pg_advisory_lock(hashtext(current_database()), hashtext(current_schema()))');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(row => [row.filename, row.checksum]));
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && /^\d+_[a-z0-9_-]+\.sql$/i.test(file.name))
      .map(file => file.name).sort();
    const completed = [];
    for (const filename of files) {
      // Git may check out CRLF on Windows and LF on macOS/Linux.
      const sql = (await readFile(join(directory, filename), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(filename)) {
        if (applied.get(filename) !== checksum) throw new Error(`Applied migration ${filename} has changed`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
      completed.push(filename);
      logger?.info?.({ migration: filename }, 'Database migration applied');
    }
    return completed;
  } finally {
    // Destroy this dedicated connection so session advisory locks cannot leak into the pool.
    client?.release(true);
    if (ownedPool) await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const ssl = process.env.DATABASE_SSL || (process.env.NODE_ENV === 'production' ? 'require' : 'disable');
  try {
    if (process.env.NODE_ENV === 'production' && ssl === 'disable') throw new Error('DATABASE_SSL=disable is refused in production');
    const files = await applyMigrations({ connectionString: process.env.DATABASE_URL, ssl });
    console.log(`Applied ${files.length} migration(s)${files.length ? `: ${files.join(', ')}` : '.'}`);
  } catch (error) {
    // Connection errors can include credentials or query detail; do not print them.
    console.error(`Database migration failed (${error.code ?? error.name}). Check database access and migration files.`);
    process.exitCode = 1;
  }
}
