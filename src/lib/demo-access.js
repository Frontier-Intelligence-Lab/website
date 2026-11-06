import { isReviewerUsername, normalizeUsername } from './reviewers.js';
import { staffScopeFor } from './staff-scope.js';

/**
 * Reviewer entry into the real workspace: how a signed-in external reviewer (YC, Speedrun) opens ITS OWN synthetic
 * demo organization as a DEDICATED normal owner identity, and what that identity may do.
 *
 * The bridge is an explicit configuration, never an inference. DEMO_REVIEWER_USERS_FILE is an array of entries
 * `{ username, userId, workspaceId }`: the reviewer username, the UUID of a verified normal user that root provisioned
 * for exactly this reviewer, and the UUID of the synthetic organization that user owns. It is trusted operator
 * configuration read with JSON.parse; what keeps two reviewers from sharing an identity or an organization is the
 * explicit validation below, which refuses a repeated username, user id or workspace id across entries. The file
 * holds ids only: no password, token or secret, and ids are not credentials. The operator pin DEMO_WORKSPACE_ID plays
 * no part here and may not be one of these workspaces.
 *
 * `resolveDemoAccess` is re-run on every bridged request (there is no cached grant) and fails closed when any link is
 * missing: the reviewer is signed out or disabled, its entry is gone, the session marker names another reviewer,
 * workspace or user, the entry's workspace is missing, not an organization or no longer strictly synthetic, the
 * mapped user is missing or unconfirmed, it is not currently an `owner` of that workspace, or it has any staff scope.
 * Nothing the client sends selects a workspace, user or role.
 *
 * What a bridged request may change is a finite allowlist of registered route patterns (DEMO_ALLOWED_MUTATIONS),
 * matched on Fastify's registered pattern and method, never on the raw URL. Everything else is refused, and the
 * workspace guard additionally pins every workspace route to the entry's workspace.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_KEYS = new Set(['username', 'userId', 'workspaceId']);
const uuid = (value) => (typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : null);

/** `[{ username, userId, workspaceId }]` → validated entries. Throws a readable error that names the entry, never an id. */
export function parseDemoReviewerUsers(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('must be a JSON array of { "username", "userId", "workspaceId" } entries');
  const seen = { username: new Set(), userId: new Set(), workspaceId: new Set() };
  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`entry ${i} must be an object`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) throw new Error(`entry ${i} has an unknown field "${key}"`);
    const username = normalizeUsername(entry.username);
    if (!isReviewerUsername(username)) throw new Error(`entry ${i} needs a reviewer username`);
    const userId = uuid(entry.userId);
    if (!userId) throw new Error(`entry ${i} needs the UUID of the dedicated demo owner`);
    const workspaceId = uuid(entry.workspaceId);
    if (!workspaceId) throw new Error(`entry ${i} needs the UUID of that reviewer's synthetic organization`);
    if (seen.username.has(username)) throw new Error(`entry ${i} repeats a reviewer username`);
    if (seen.userId.has(userId)) throw new Error(`entry ${i} repeats a demo user id: each reviewer needs its own identity`);
    if (seen.workspaceId.has(workspaceId)) throw new Error(`entry ${i} repeats a workspace id: each reviewer needs its own organization`);
    seen.username.add(username);
    seen.userId.add(userId);
    seen.workspaceId.add(workspaceId);
    return { username, userId, workspaceId };
  });
}

/** The configured entry for a reviewer username, or null. Only the server's configuration decides. */
export const demoEntryFor = (config, reviewer) => (reviewer?.username ? (config.demoReviewerUsers ?? []).find((m) => m.username === reviewer.username) ?? null : null);

/**
 * The bridged identity for a current reviewer, or null. `marker` is the session's record of an earlier entry; when
 * given, it must name this reviewer and this entry's workspace and user exactly, so a session can never carry a
 * grant from another configuration.
 */
export async function resolveDemoAccess({ config, store, reviewer, marker = null }) {
  if (!store) return null;
  const mapping = demoEntryFor(config, reviewer);
  if (!mapping) return null;
  if (marker && (marker.username !== reviewer.username || marker.workspaceId !== mapping.workspaceId || marker.userId !== mapping.userId)) return null;
  const workspace = await store.getWorkspace(mapping.workspaceId);
  if (!workspace || workspace.kind !== 'organization' || workspace.profile?.synthetic !== true) return null;
  const user = await store.getUserById(mapping.userId);
  if (!user?.emailVerifiedAt) return null;
  const membership = await store.getMembership(workspace.id, user.id);
  if (membership?.role !== 'owner') return null;
  // A dedicated demo identity never carries staff authority of either kind.
  if (await staffScopeFor({ config, store, user })) return null;
  return {
    reviewer: { username: reviewer.username, role: reviewer.role },
    user,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, kind: workspace.kind },
    role: membership.role,
  };
}

/** What the session records at entry. Only these three ids, all server-chosen. */
export const demoMarker = (access) => ({ username: access.reviewer.username, workspaceId: access.workspace.id, userId: access.user.id });

/** The destination the server resolves for an entry: the real Models page of the reviewer's own organization. */
export const demoDestination = (access) => `/w/${access.workspace.slug}/models`;

// What a bridged session can and cannot do, for the UI to explain. The server decides; these only describe it.
export const DEMO_CAPABILITIES = Object.freeze({
  plan: true, dataset: true, evaluate: true, modelPulls: true, enhanceDrafts: true, device: true, capitalDrafts: true, research: true,
  team: false, accountChanges: false, runners: false, jobs: false, approvePlans: false, sendCapital: false, credits: false, staff: false,
});

// Mutations a bridged session may perform, as REGISTERED Fastify route patterns (POST). Planning, dataset and label
// editing, evaluation, model pull requests and enhance-plan drafts, the identity's own local-device records,
// Capital drafts with evidence, and public-source research inside the pinned workspace. Each is checked against
// the registered routes at startup (src/app.js).
const P = '/api/workspaces/:workspaceId/projects/:projectId';
export const DEMO_ALLOWED_MUTATIONS = Object.freeze([
  '/api/workspaces/:workspaceId/projects',
  P,
  `${P}/upload-grant`, `${P}/uploads`, `${P}/uploads/:uploadId/delete`, `${P}/submit`, `${P}/reopen`, `${P}/dataset-versions`,
  `${P}/label-set`, `${P}/items/:uploadId`, `${P}/items/:uploadId/annotations`, `${P}/annotations/:annotationId`, `${P}/annotations/:annotationId/delete`,
  `${P}/issues/note`, `${P}/issues/note/delete`,
  `${P}/evaluations`, `${P}/evaluations/:setId`, `${P}/evaluations/:setId/cases`, `${P}/evaluations/:setId/cases/:caseId/delete`,
  `${P}/evaluations/:setId/import`, `${P}/evaluations/:setId/issues/note`, `${P}/evaluations/:setId/issues/note/delete`,
  `${P}/evaluations/:setId/freeze`, `${P}/evaluations/:setId/reopen`, `${P}/evaluations/:setId/versions/:versionId/predictions`,
  `${P}/evaluations/:setId/comparisons`, `${P}/evaluations/comparisons/:comparisonId/blind`,
  `${P}/evaluations/comparisons/:comparisonId/judgments`, `${P}/evaluations/comparisons/:comparisonId/approve`,
  '/api/workspaces/:workspaceId/models/pulls', '/api/workspaces/:workspaceId/enhance-runs', '/api/workspaces/:workspaceId/enhance-runs/:runId',
  '/api/workspaces/:workspaceId/devices', '/api/workspaces/:workspaceId/devices/:deviceId/reports', '/api/workspaces/:workspaceId/devices/:deviceId/installs',
  '/api/workspaces/:workspaceId/devices/:deviceId/runs', '/api/workspaces/:workspaceId/devices/:deviceId/revoke',
  '/api/workspaces/:workspaceId/capital/cases', '/api/workspaces/:workspaceId/capital/cases/:caseId',
  '/api/workspaces/:workspaceId/capital/cases/:caseId/evidence', '/api/workspaces/:workspaceId/capital/cases/:caseId/evidence/:evidenceId/delete',
  '/api/workspaces/:workspaceId/research/projects',
  '/api/workspaces/:workspaceId/research/projects/:projectId',
  '/api/workspaces/:workspaceId/research/projects/:projectId/imports',
  '/api/workspaces/:workspaceId/research/projects/:projectId/sources',
  '/api/workspaces/:workspaceId/research/projects/:projectId/lists',
  '/api/workspaces/:workspaceId/research/projects/:projectId/checklist',
  '/api/workspaces/:workspaceId/research/projects/:projectId/runs',
  '/api/workspaces/:workspaceId/research/entities/:entityId/corrections',
  '/api/workspaces/:workspaceId/research/lists/:listId/items',
  '/api/workspaces/:workspaceId/research/lists/:listId/items/:entityId/remove',
  '/api/workspaces/:workspaceId/research/runs/:runId/start',
  '/api/workspaces/:workspaceId/research/runs/:runId/cancel',
  '/api/workspaces/:workspaceId/research/runs/:runId/accept',
]);
// Reads outside a workspace that the real pages need. Every other signed-in route either carries :workspaceId (then
// the workspace guard pins it) or is refused.
export const DEMO_ALLOWED_READS = Object.freeze(['/api/account', '/api/local-models', '/api/local-memory', '/api/models/catalog']);

const MUTATIONS = new Set(DEMO_ALLOWED_MUTATIONS);
const READS = new Set(DEMO_ALLOWED_READS);

/** Whether a bridged session may reach this registered route at all (the workspace pin is checked separately). */
export function demoRouteAllowed(request) {
  const url = request.routeOptions?.url;
  const method = request.routeOptions?.method;
  if (typeof url !== 'string' || typeof method !== 'string') return false;
  if (method === 'GET') return READS.has(url) || url.includes(':workspaceId');
  return method === 'POST' && MUTATIONS.has(url);
}
