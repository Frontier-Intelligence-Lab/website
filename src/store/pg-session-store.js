import { createPostgresPool } from './postgres.js';

/** Callback-compatible @fastify/session store. Migrate the database before use. */
export function createPgSessionStore({ connectionString, ssl = 'disable', logger, ttlMs = 8 * 60 * 60 * 1000, pruneIntervalMs = 15 * 60 * 1000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');
  if (!Number.isFinite(pruneIntervalMs) || pruneIntervalMs < 0) throw new TypeError('pruneIntervalMs must be nonnegative');
  const pool = createPostgresPool({ connectionString, ssl, logger });
  const finish = (operation, callback) => {
    if (typeof callback !== 'function') return operation;
    operation.then(value => callback(null, value), callback);
  };
  const encoded = (session) => {
    const data = JSON.stringify(session);
    const cookie = session.cookie;
    const expiresAt = cookie?.expires != null
      ? new Date(cookie.expires)
      : new Date(Date.now() + (cookie?.originalMaxAge ?? cookie?.maxAge ?? ttlMs));
    if (!Number.isFinite(expiresAt.getTime())) throw new TypeError('Invalid session expiry');
    return [data, expiresAt];
  };

  const store = {
    get(sid, callback) {
      return finish(pool.query('SELECT data FROM sessions WHERE sid = $1 AND expires_at > now()', [sid])
        .then(result => result.rows[0]?.data ?? null), callback);
    },
    set(sid, session, callback) {
      const operation = Promise.resolve().then(() => {
        const [data, expiresAt] = encoded(session);
        return pool.query(`INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`, [sid, data, expiresAt]);
      }).then(() => undefined);
      return finish(operation, callback);
    },
    // Required by current @fastify/session to reject stale saves after regeneration/logout.
    compareAndSet(sid, expectedGeneration, session, callback) {
      const operation = Promise.resolve().then(async () => {
        const [data, expiresAt] = encoded(session);
        const result = await pool.query(`UPDATE sessions SET data = $3::jsonb, expires_at = $4
          WHERE sid = $1 AND expires_at > now()
          AND COALESCE(data #>> '{__fastifySessionMetadata,generation}', sid) = $2`, [sid, expectedGeneration, data, expiresAt]);
        if (!result.rowCount) throw Object.assign(new Error('The session does not exist or has changed'), { code: 'ENOENT' });
      });
      return finish(operation, callback);
    },
    destroy(sid, callback) {
      return finish(pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => undefined), callback);
    },
    async pruneExpired() {
      const result = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
      return result.rowCount;
    },
    async close() {
      clearInterval(timer);
      await pool.end();
    },
  };
  const timer = pruneIntervalMs ? setInterval(() => {
    store.pruneExpired().catch(() => logger?.error?.('Postgres session pruning failed'));
  }, pruneIntervalMs) : undefined;
  timer?.unref();
  return store;
}
