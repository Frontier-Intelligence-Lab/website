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
- Expected conflicts throw `StoreError` (`src/store/errors.js`) with one of these codes: `email_taken`, `slug_taken`, `personal_exists`, `not_found`, `already_decided`, `already_member`.
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
| `updateProject({ workspaceId, projectId, patch })` | project or null. Only `name, task, modalities, startingPoint, success, dataSource, status, setupStep` may change. |
| `getProject({ workspaceId, projectId })` | project or null |
| `listProjects(workspaceId)` | projects |
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
             success: {...}|null, dataSource: {...}|null, status: 'draft'|'submitted', setupStep, createdAt, updatedAt }
```

`profile`, `success` and `dataSource` are JSON objects that the routes validate before they're stored. Store them as `jsonb`.
