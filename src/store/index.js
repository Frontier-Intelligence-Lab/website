import { createMemoryStore } from './memory.js';

export { StoreError } from './errors.js';

/**
 * DATABASE_URL set -> Postgres (src/store/postgres.js, which exports createPostgresStore).
 * Unset -> the in-memory store, outside production only. Production without a database
 * returns null, and every account route then fails closed with 503.
 */
export async function createStore(config, logger) {
  if (config.databaseUrl) {
    const { createPostgresStore } = await import('./postgres.js');
    return createPostgresStore({ connectionString: config.databaseUrl, ssl: config.databaseSsl, logger });
  }
  if (config.isProd) return null;
  return createMemoryStore();
}
