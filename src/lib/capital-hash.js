import { createHash } from 'node:crypto';

// Server-side only (node:crypto): the content hash an owner's consent is bound to. The browser receives it and sends
// it back; the store recomputes it under the case lock from the exact data it freezes.

/** JSON with object keys sorted at every level, so the same content hashes the same in both stores. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const snapshotHash = (snapshot) => createHash('sha256').update(canonical(snapshot)).digest('hex');
export const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
