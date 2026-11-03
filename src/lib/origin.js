/**
 * CSRF guard for state-changing requests: the Origin (or Referer) header must
 * match this site's own origin. Works together with SameSite=Lax session cookies.
 */
export function isSameOriginRequest(request, publicOrigin) {
  const origin = request.headers.origin ?? refererOrigin(request.headers.referer);
  if (!origin) return false;
  const allowed = new Set([`${request.protocol}://${request.host}`]);
  if (publicOrigin) allowed.add(publicOrigin);
  return allowed.has(origin);
}

function refererOrigin(referer) {
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}
