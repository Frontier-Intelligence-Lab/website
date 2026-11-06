// Both reviewer entry URLs resolve into the normal workspace routes. The server
// still owns identity, mapping and authorization; this helper grants none of them.
export async function resolveReviewerEntry({ reviewer, fetchAccount, enterWorkspace }) {
  if (!reviewer) return { kind: 'signed_out' };
  if (reviewer.role === 'admin') return { kind: 'audit' };
  try {
    const account = await fetchAccount();
    if (account?.demoAccess) {
      const pinned = account.demoAccess.workspace;
      const entry = account.workspaces?.find((item) => item.id === pinned?.id);
      if (account.user && entry?.slug && entry.slug === pinned.slug) {
        return { kind: 'workspace', to: `/w/${encodeURIComponent(entry.slug)}` };
      }
      return { kind: 'unavailable', status: 403, message: 'This reviewer workspace is not available.' };
    }
    if (account?.user) {
      return { kind: 'unavailable', status: 409, message: 'This browser is signed in to a workspace account. Sign out of it before opening the reviewer workspace.' };
    }
    // A missing entry marker is established only by the existing same-origin
    // POST, never by treating a GET, reviewer username or client URL as a grant.
    const result = await enterWorkspace();
    if (result.status === 401) return { kind: 'signed_out' };
    if (result.ok && typeof result.data?.to === 'string' && result.data.to.startsWith('/w/')) {
      return { kind: 'workspace', to: result.data.to };
    }
    return { kind: 'unavailable', status: result.status >= 400 && result.status <= 599 ? result.status : 503, message: result.data?.error || 'This reviewer workspace is not available.' };
  } catch {
    return { kind: 'unavailable', status: 503, message: 'The reviewer workspace could not be reached. Try again.' };
  }
}
