# Storage contract

All account, workspace and project data goes through one store object created by `createStore(config)` in `src/store/index.js`.

| Store | When | Source |
| --- | --- | --- |
| Postgres | `DATABASE_URL` is set | `src/store/postgres.js`, `migrations/` |
| In-memory | `DATABASE_URL` unset, outside production | `src/store/memory.js` |
| None | production without `DATABASE_URL` | account routes return `503` (fail closed) |

The executable definition of the contract is `tests/store-contract.js`. Every store must pass it. Run it with `npm test` for the memory store. The Postgres store runs the same suite when `TEST_DATABASE_URL` is set.

## Rules for every implementation

- Every method is `async` and returns plain objects with camelCase keys. Timestamps are ISO 8601 strings in UTC. `null` means not found.
- Expected conflicts throw `StoreError` (`src/store/errors.js`) with one of these codes: `email_taken`, `slug_taken`, `personal_exists`, `not_found`, `already_decided`, `already_member`, `invite_expired`, `duplicate_upload`, `invalid_state`, `quota_exceeded`.
- **Approval integrity.** A project's review-relevant content is editable only while its status is `draft` or `changes_requested`. That content is `name, task, modalities, startingPoint, success, dataSource, model` and its uploads. In `in_review`, `approved` and `versioned`, every write to it (`updateProject` content fields, `createUpload`, `deleteUpload`) throws `invalid_state`. The check and the write must be atomic: one conditional statement, or a check under the project row lock that submission also takes. Postgres additionally enforces this with triggers (`migrations/005_review_integrity.sql`). Lifecycle `status` is never patchable through `updateProject`.
- Password hashes and token hashes never leave the store. The only exception is `getUserAuthByEmail`, which returns the password hash for login.
- Emails, domains and slugs are compared case-insensitively and stored lower-case.
- Workspace-scoped reads and writes take `workspaceId` and must filter on it. A project id from workspace A must not be readable or writable through workspace B. The routes also check membership before calling the store.
- Multi-row changes are atomic. These must run in one transaction each: `createWorkspace` (workspace, owner membership and audit row), `decideJoinRequest` (decision plus membership), `createInvitations`, `createEmailCode` (expire older codes, insert new one) and `consumeEmailCode`. `consumeEmailCode` must also lock the row so two parallel attempts can't both succeed.

## Methods

| Method | Returns / throws |
| --- | --- |
| `createUser({ email, name, passwordHash })` | user · `email_taken` |
| `getUserById(id)` | user or null |
| `getUserAuthByEmail(email)` | `{ user, passwordHash }` or null |
| `setEmailVerified(userId)` | user (keeps the first verification time) |
| `createEmailCode({ userId, email, purpose, codeHash, expiresAt })` | — expires the user's earlier unconsumed codes for that purpose |
| `consumeEmailCode({ userId, purpose, codeHash })` | `{ ok: true, email }` or `{ ok: false, reason: 'invalid' \| 'expired' \| 'too_many_attempts' }`. Locks after 5 wrong attempts. |
| `isSlugAvailable(slug)` | boolean |
| `createWorkspace({ kind, name, slug, website, domain, domainVerified, joinByDomain, industry, sizeBand, profile, ownerId })` | workspace · `slug_taken`, `personal_exists`. `joinByDomain` is stored true only when the domain is verified. |
| `getWorkspace(id)` | workspace or null |
| `findWorkspaceByJoinDomain(domain)` | `{ id, name, slug, domain }` for an organization with a verified domain and domain join on, else null |
| `listWorkspacesForUser(userId)` | `[{ workspace, role }]` |
| `getMembership(workspaceId, userId)` | `{ role }` or null |
| `listMembers(workspaceId)` | `[{ user: { id, name, email }, role }]` |
| `createInvitations({ workspaceId, invitedBy, invites: [{ email, role, tokenHash, expiresAt }] })` | count. Revokes an earlier pending invite to the same email. |
| `listInvitations(workspaceId)` | pending, unexpired invites, without `tokenHash` |
| `createJoinRequest({ workspaceId, userId, note })` | request. Returns the existing pending one if any. `already_member`, `not_found` |
| `listJoinRequests(workspaceId, { status })` | requests |
| `listJoinRequestsForUser(userId)` | requests with `workspaceName` |
| `decideJoinRequest({ workspaceId, requestId, deciderId, approve, role })` | request · `not_found`, `already_decided` |
| `createProject({ workspaceId, createdBy, name, task, modalities, startingPoint })` | project (`status: 'draft'`, `setupStep: 'success'`) |
| `updateProject({ workspaceId, projectId, patch })` | project or null. Only `name, task, modalities, startingPoint, success, dataSource, model, status, setupStep` may change. |
| `getProject({ workspaceId, projectId })` | project or null |
| `listProjects(workspaceId)` | projects |
| `getInvitationByTokenHash(tokenHash)` | invitation plus `workspaceName`, `workspaceSlug` (no `tokenHash`), or null. Includes accepted, revoked and expired ones so callers can explain why a link fails. |
| `acceptInvitation({ invitationId, userId })` | `{ workspaceId, role, alreadyMember }`. Marks the invitation accepted and adds the membership in one transaction; an existing membership keeps its role. Throws `not_found`, `already_decided` (accepted or revoked) or `invite_expired`. |
| `revokeInvitation({ workspaceId, invitationId, actorId })` | — · `not_found` (including another workspace's invitation), `already_decided` |
| `updateWorkspaceProfile({ workspaceId, profile })` | workspace. Shallow-merges keys into `profile`. |
| `createUpload({ workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, limits })` | upload. `duplicateOf` is the id of an earlier original upload in the same project with the same `sha256`, else null. Optional `limits: { maxFiles, maxBytes }` are checked under the project lock. Throws `not_found`, `duplicate_upload` (same `objectKey`), `invalid_state` (frozen) or `quota_exceeded`. |
| `deleteUpload({ workspaceId, projectId, uploadId, actorId })` | removed upload (with `objectKey`, so the caller can delete the object). Only while editable. The earliest copy of a removed original becomes the new original. |
| `listUploads({ workspaceId, projectId })` / `getUpload(id)` | uploads (with `objectKey`; routes strip it before responding) |
| `submitForReview({ workspaceId, projectId, submittedBy })` | review (`status: 'pending'`) with `snapshot: { task, modalities, startingPoint, success, dataSource, model, files: [{ id, sha256, sizeBytes, contentType, filename, objectKey }] }`. Original files only, no duplicates. In one transaction under the project lock: project status `draft` or `changes_requested` becomes `in_review`, else `invalid_state`. |
| `reopenProject({ workspaceId, projectId, actorId })` | project, now `draft`. From `in_review` it withdraws the pending review (`status: 'withdrawn'`). From `approved` or `versioned` it voids the approval for new versions. Other states throw `invalid_state`. |
| `listReviews({ status })` | across all workspaces (staff queue), each with `projectName`, `workspaceName` |
| `getReview(id)` / `listProjectReviews({ workspaceId, projectId })` | review / reviews oldest first |
| `decideReview({ reviewId, reviewerId, decision, notes, checks })` | review. `decision` is `approved` or `changes_requested`, and the project status becomes the same value in one transaction. Throws `not_found` or `already_decided` (including withdrawn reviews). |
| `createDatasetVersion({ workspaceId, projectId, createdBy })` | version `{ number, manifest }`. The store builds `manifest = { reviewId, ...snapshot }` from the latest review, which must be `approved`. Never built from the live project. Only when the project status is `approved` (one version per approval), else `invalid_state`. Sets status `versioned`. Numbers are race-free (unique `(project_id, number)`). |
| `listDatasetVersions({ workspaceId, projectId })` | versions, oldest first |
| `upsertReviewer({ username, name, role, passwordHash })` | reviewer `{ username, name, role, enabled }`. `passwordHash` is required for a new account; omitted, the existing hash is kept. External demo reviewers only, separate from users and staff. |
| `getReviewer(username)` / `getReviewerAuth(username)` | reviewer / `{ account, passwordHash }`, or null |
| `setReviewerEnabled({ username, enabled })` / `listReviewers()` | reviewer · `not_found` / reviewers |
| `recordAudit({ workspaceId, actorId, action, targetType, targetId, metadata })` | — |
| `listAudit(workspaceId, { limit })` | newest first |
| `close()` | releases connections |

## Shapes

```text
user       { id, email, name, emailVerifiedAt, createdAt }
workspace  { id, kind: 'organization'|'personal', name, slug, website, domain, domainVerified, joinByDomain,
             industry, sizeBand, profile: {}, createdBy, createdAt }
role       'owner'|'admin'|'member'|'finance'|'viewer'
project    { id, workspaceId, createdBy, name, task, modalities: string[], startingPoint: 'own'|'need'|'model'|'unsure',
             success: {...}|null, dataSource: {...}|null, model: {...}|null, status: 'draft'|'in_review'|'changes_requested'|'approved'|'versioned', setupStep, createdAt, updatedAt }
```

`profile`, `success`, `dataSource` and `model` are JSON objects that the routes validate before they're stored. Store them as `jsonb`.

## Changelog

- **v4:**
  - Approval integrity: frozen content, review snapshots, `reopenProject`, versions made only from an approved snapshot (one per approval).
  - `deleteUpload` and upload quotas (`quota_exceeded`).
  - Reviewer accounts (`reviewer_accounts`).
  - Postgres: `005_review_integrity.sql` (`reviews.snapshot`, `withdrawn` status, freeze triggers) and `006_reviewer_accounts.sql`.
- **v3:**
  - Accepting and revoking invitations by token.
  - Workspace profile updates (academic verification).
  - New `uploads` table (unique `object_key`; index `(project_id, sha256)`).
  - New `reviews` table (`status` in `pending | approved | changes_requested`, `checks jsonb`, `notes`, `reviewer_id`, `decided_at`).
  - New `dataset_versions` table (unique `(project_id, number)`, `manifest jsonb`).
  - Project `status` values are now `draft | in_review | changes_requested | approved | versioned`.
  - New error codes `invite_expired`, `duplicate_upload`, `invalid_state`.
- **v2:** `projects.model` (`jsonb`, nullable, default `null`) for projects that start from an existing model: source (endpoint, files or hub), format, license and rights confirmation, plus test-set details. The Postgres store needs a migration that adds the column, and the column must be included in `createProject`, `updateProject` and the row mapping.
