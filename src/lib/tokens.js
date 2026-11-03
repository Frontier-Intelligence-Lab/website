import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact signed tokens shared with services/ingest (Rust): base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * The MAC covers the encoded payload string, so neither side has to canonicalize JSON.
 * Payloads carry `kind` and `exp` (unix seconds); verify() rejects any other kind or an expired token.
 */
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(secret, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
}

export function verifyToken(secret, token, kind, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.kind !== kind || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  return payload;
}
