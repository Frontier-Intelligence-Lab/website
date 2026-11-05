/**
 * Who may act as Valcairn staff, and over which workspaces. The server alone decides, from two lists:
 *
 * - STAFF_EMAILS: global staff, every workspace. Unchanged behaviour.
 * - DEMO_STAFF_EMAILS: demo-scoped staff, only the workspace DEMO_WORKSPACE_ID names, and only while that workspace
 *   exists with profile.synthetic === true (strictly). That condition is re-read from the store on every call; no
 *   grant is cached, and nothing a request carries (params, query, headers, body), a user profile, a workspace
 *   profile flag or a membership can widen it. Config refuses an address that is on both lists.
 *
 * Both need a confirmed email. The result is `{ global: true, workspaceId: null }`, `{ global: false, workspaceId,
 * workspaceName }`, or null for everyone else, including demo reviewer accounts, which are never users.
 */
export async function staffScopeFor({ config, store, user }) {
  if (!user?.emailVerifiedAt || typeof user.email !== 'string') return null;
  if (config.staffEmails.includes(user.email)) return { global: true, workspaceId: null };
  if (!config.demoStaffEmails?.includes(user.email) || !config.demoWorkspaceId || !store) return null;
  const workspace = await store.getWorkspace(config.demoWorkspaceId);
  if (!workspace || workspace.profile?.synthetic !== true) return null;
  return { global: false, workspaceId: workspace.id, workspaceName: workspace.name };
}

/** Whether a scope reaches one workspace. A missing scope or workspace id reaches nothing. */
export const scopeAllows = (scope, workspaceId) =>
  Boolean(scope) && (scope.global === true || (typeof workspaceId === 'string' && workspaceId.length > 0 && scope.workspaceId === workspaceId));
