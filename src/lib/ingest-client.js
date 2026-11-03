import { signToken } from './tokens.js';

const TOKEN_TTL_S = 60;
const TIMEOUT_MS = 15_000;

/**
 * Server-to-server calls from web to services/ingest. Each call carries a one-minute token signed
 * with the shared secret and names exactly one object key, so a leaked token cannot touch anything else.
 */
export function createIngestClient(ingest, fetchImpl = globalThis.fetch) {
  const call = async (path, kind, key) => {
    const token = signToken(ingest.secret, { v: 1, kind, key, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S });
    let res;
    try {
      res = await fetchImpl(`${ingest.internalUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('The upload service could not be reached'), { code: 'ingest_unavailable' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error ?? `Upload service answered ${res.status}`), { code: res.status === 404 ? 'ingest_not_found' : 'ingest_failed' });
    return body;
  };
  return {
    /** Moves an uploaded object out of the pending area; returns its permanent key. Safe to retry. */
    commit: async (pendingKey) => (await call('/v1/commit', 'commit', pendingKey)).objectKey,
    /** Deletes a stored object. Already-missing objects count as deleted. */
    remove: async (key) => { await call('/v1/delete', 'delete', key); },
  };
}
