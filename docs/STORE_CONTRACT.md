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
- Expected conflicts throw `StoreError` (`src/store/errors.js`) with one of these codes: `email_taken`, `slug_taken`, `personal_exists`, `not_found`, `already_decided`, `already_member`, `invite_expired`, `duplicate_upload`, `invalid_state`, `quota_exceeded`, `forbidden`, `issues_open`, `label_in_use`, `invalid_label`, `invalid_kind`, `stale_plan`, `stale_revision`, `evidence_in_use`, `missing_reference`.
- **Approval integrity.** A project's review-relevant content is editable only while its status is `draft` or `changes_requested`. That content is `name, task, modalities, startingPoint, success, dataSource, model`, the `labelSet` (changed only through `setLabelSet`), its uploads (including each upload's `kind` and `offsetMs`), its annotations and its issue notes. In `in_review`, `approved` and `versioned`, every write to it (`updateProject` content fields, `setLabelSet`, `createUpload`, `deleteUpload`, `updateUpload`, `createAnnotation`, `updateAnnotation`, `deleteAnnotation`, `setIssueNote`, `deleteIssueNote`) throws `invalid_state`. The check and the write must be atomic: one conditional statement, or a check under the project row lock that submission also takes. Postgres additionally enforces this with triggers (`005_review_integrity.sql`, `007_dataset_workspace.sql`, `008_dataset_locking.sql`, whose guard takes a share lock on the parent project so a write cannot pass the check while a freeze is in flight, `009_freeze_upload_updates.sql`, which applies that guard to every `UPDATE` of an upload, with no column exceptions, and `010_annotation_box_stored_form.sql`, which makes the database accept only boxes in the stored form).
- **Rules that depend on other rows are checked under the project lock.** The Resolve gate (`submitForReview` with `requireResolved`), label-set changes against labels in use, and a label's fit to its file (scope, data type, box bounds; `checkAnnotation` in `src/lib/dataset.js`) are evaluated in the same transaction, under the same project lock, as the write they guard. Routes may pre-check for clearer messages but never instead. Lifecycle `status` is never patchable through `updateProject`.
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
| `updateProject({ workspaceId, projectId, patch })` | project or null. Only `name, task, modalities, startingPoint, success, dataSource, model, setupStep` may change. `status` and `labelSet` are never patchable here: lifecycle methods own `status`, and `setLabelSet` owns `labelSet`. |
| `getProject({ workspaceId, projectId })` | project or null |
| `listProjects(workspaceId)` | projects |
| `getInvitationByTokenHash(tokenHash)` | invitation plus `workspaceName`, `workspaceSlug` (no `tokenHash`), or null. Includes accepted, revoked and expired ones so callers can explain why a link fails. |
| `acceptInvitation({ invitationId, userId })` | `{ workspaceId, role, alreadyMember }`. Marks the invitation accepted and adds the membership in one transaction; an existing membership keeps its role. Throws `not_found`, `already_decided` (accepted or revoked) or `invite_expired`. |
| `revokeInvitation({ workspaceId, invitationId, actorId })` | — · `not_found` (including another workspace's invitation), `already_decided` |
| `updateWorkspaceProfile({ workspaceId, profile })` | workspace. Shallow-merges keys into `profile`. |
| `createUpload({ workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, limits })` | upload. `duplicateOf` is the id of an earlier original upload in the same project with the same `sha256`, else null. Optional `limits: { maxFiles, maxBytes }` are checked under the project lock. Throws `not_found`, `duplicate_upload` (same `objectKey`), `invalid_state` (frozen) or `quota_exceeded`. |
| `deleteUpload({ workspaceId, projectId, uploadId, actorId })` | removed working-set upload. Only while editable. The earliest copy of a removed original becomes the new original. Committed object bytes must be retained: historical review/version snapshots or an in-flight registration may still reference the key. Physical reclamation needs a separate reference-aware policy. |
| `listUploads({ workspaceId, projectId })` / `getUpload(id)` | uploads (with `objectKey`; routes strip it before responding) |
| `setLabelSet({ workspaceId, projectId, labelSet })` | project. Labels are `{ id, name, scope: 'span'\|'file'\|'box', tone }`. A label in use may be renamed or recoloured, but not removed or re-scoped: `label_in_use` (message: the label's name). |
| `updateUpload({ workspaceId, projectId, uploadId, patch })` | upload. `patch` may set `kind` (one of `video, audio, image, text, sensor, robot, table, logs, file`, or `null` for the detected type) and `offsetMs` (position on the shared clock, or `null`). A type its labels no longer fit (spans need a timed type, boxes an image) throws `label_in_use`. `kind: 'image'` on a file whose stored content type is not `image/*` throws `invalid_kind`: a type set by hand can describe the data (a CSV of readings is `sensor`) but cannot claim content the bytes do not have. `not_found`, `invalid_state` |
| `listAnnotations({ workspaceId, projectId })` | annotations `{ id, uploadId, labelId, startMs, endMs, box, createdBy, createdAt }`, oldest first. Postgres adds `storedFormInvalid: true` to a label whose raw `box` 010 would refuse, decided in SQL before the numbers are parsed, so digits a JavaScript number cannot hold are not lost to the check. A whole-file label has no times and no box; a box is `{ x, y, w, h }` in fractions of the image. |
| `createAnnotation({ workspaceId, projectId, uploadId, labelId, startMs, endMs, box, createdBy })` | annotation. The upload must belong to the project (`not_found`). The label must be in the current label set and fit the file (`invalid_label`, with a readable message). Box labels need image content (checked against `contentType`, not the editable `kind`) and the stored box: coordinates are rounded to six decimals first and then validated, each side at least `0.001`, inside the image within a `1e-6` rounding tolerance. Deleting an upload deletes its annotations. |
| `updateAnnotation({ workspaceId, projectId, annotationId, patch })` | annotation. `patch` may set `startMs`, `endMs` or `box`; the result is re-checked like a new label. `not_found`, `invalid_label`, `invalid_state` |
| `deleteAnnotation({ workspaceId, projectId, annotationId })` | removed annotation · `not_found`, `invalid_state` |
| `listIssueNotes({ workspaceId, projectId })` / `setIssueNote({ workspaceId, projectId, key, note, createdBy })` / `deleteIssueNote({ workspaceId, projectId, key })` | notes `{ key, note, createdBy, createdAt }` sorted by key / the note (replaces one with the same key) / — · `not_found`. A note keeps an issue from `src/lib/dataset.js` on record so the project can go to review. |
| `submitForReview({ workspaceId, projectId, submittedBy, requireResolved })` | review (`status: 'pending'`) with `snapshot: { task, modalities, startingPoint, success, dataSource, model, labelSet, files: [{ id, sha256, sizeBytes, contentType, filename, objectKey, kind, offsetMs }], annotations: [{ id, uploadId, labelId, startMs, endMs }], issueNotes: [{ key, note }] }`. Annotations (with `box`) are those on the snapshot's files. With `requireResolved`, open issues (`computeIssues`) are counted under the lock and any throw `issues_open` (`err.open` is the count). They include a missing acceptance rule (`success`) for every kind of data source, and stored labels or file types that today's rules would refuse (`findInvalid`), so rows written before a rule existed must be repaired before a new review. Original files only, no duplicates. In one transaction under the project lock: project status `draft` or `changes_requested` becomes `in_review`, else `invalid_state`. |
| `reopenProject({ workspaceId, projectId, actorId })` | project, now `draft`. From `in_review` it withdraws the pending review (`status: 'withdrawn'`). From `approved` or `versioned` it voids the approval for new versions. The store checks current membership and current state atomically: owner/admin can reopen all three states; member can withdraw only `in_review`; other or missing roles throw `forbidden`. Other states throw `invalid_state`. |
| `listReviews({ status })` | across all workspaces (staff queue), each with `projectName`, `workspaceName` |
| `getReview(id)` / `listProjectReviews({ workspaceId, projectId })` | review / reviews oldest first. In Postgres, `getReview` adds `rawInvalidBoxIds`: ids of snapshot labels whose raw box 010 would refuse (pass to `countInvalid`). |
| `decideReview({ reviewId, reviewerId, decision, notes, checks })` | review. `decision` is `approved` or `changes_requested`, and the project status becomes the same value in one transaction. Throws `not_found` or `already_decided` (including withdrawn reviews). |
| `createDatasetVersion({ workspaceId, projectId, createdBy })` | version `{ number, manifest }`. The store builds `manifest = { reviewId, ...snapshot }` from the latest review, which must be `approved`. Never built from the live project. Only when the project status is `approved` (one version per approval), else `invalid_state`. Sets status `versioned`. Numbers are race-free (unique `(project_id, number)`). |
| `listModelPulls(workspaceId)` / `requestModelPull({ workspaceId, modelId, requestedBy })` | pulls `{ id, workspaceId, modelId, status: 'requested'\|'ready'\|'failed', requestedBy, createdAt }`. One per workspace and catalog model: asking again returns the first. |
| `listEnhanceRuns(workspaceId)` / `getEnhanceRun({ workspaceId, runId })` | runs `{ id, workspaceId, name, baseModelId, datasets: [{ projectId, version }], steps, compute, spendCapUsd, status: 'draft'\|'requested', createdBy, requestedBy, requestedAt, createdAt, updatedAt }`, oldest first; `null` outside the workspace. |
| `createEnhanceRun({ workspaceId, createdBy, run })` / `updateEnhanceRun({ workspaceId, runId, run })` | run, a `draft`. The route validates `run` (`validateEnhanceRun` in `src/lib/models.js`). Updating a requested run throws `invalid_state`. Each update gets an `updatedAt` strictly later than the previous one, so every edit is a distinct plan version. |
| `requestEnhanceRun({ workspaceId, runId, requestedBy, expectedUpdatedAt })` | `expectedUpdatedAt` is the plan version the approver reviewed; missing or no longer current throws `stale_plan`, checked under the row lock, so a concurrently changed cap is never frozen. Otherwise the run, now `requested`, with `requestedBy` and `requestedAt`, plus an `enhance_run.requested` audit event. Needs datasets, steps, compute and a cap, and a draft, else `invalid_state`. The plan never changes afterwards. |
| `listDatasetVersions({ workspaceId, projectId })` | versions, oldest first |
| `createDevice({ workspaceId, ownerId, label, runtime })` | device `{ id, workspaceId, ownerId, label, runtime: 'ollama', status: 'active'\|'revoked', lastSeenAt, revokedAt, createdAt, latestReport: null }`, plus a `device.registered` audit event. A device belongs to one user in one workspace. |
| `listDevices({ workspaceId, ownerId })` / `getDevice({ workspaceId, ownerId, deviceId })` | the owner's devices, each with `latestReport` / one device or null. Any other user, owners and admins included, gets an empty list or null. |
| `revokeDevice({ workspaceId, ownerId, deviceId })` | device, now `revoked`, plus `device.revoked`. History is kept. `not_found`; `invalid_state` if already revoked. |
| `recordDeviceReport({ workspaceId, ownerId, deviceId, report })` | report `{ id, deviceId, reachable, runtimeVersion, models, running, browser, provenance: 'client_reported', createdAt }`; sets the device's `lastSeenAt`. `not_found`; `invalid_state` when revoked. The route validates `report` (`validateReport` in `src/lib/devices.js`). |
| `saveModelInstall({ workspaceId, ownerId, deviceId, install })` | install `{ id, deviceId, runtimeRef, catalogId, digest, sizeBytes, details, state, failure, verifiedAt, provenance, createdAt, updatedAt }`, one per `(deviceId, runtimeRef)`. `state` is `downloading`, `installed`, `verified`, `ready`, `failed` or `removed`; `verified` and `ready` need a digest, and `verifiedAt` is kept while the same digest stays verified or ready. A state change writes `model_install.<state>`. `not_found`; `invalid_state` when revoked. |
| `listModelInstalls({ workspaceId, ownerId, deviceId })` | installs by `runtimeRef`; empty for any other user. |
| `recordExecutionRun({ workspaceId, ownerId, deviceId, run })` | run `{ id, deviceId, installId, modelRef, modelDigest, location: 'local_runtime', kind: 'chat'\|'compat_test', warm, status: 'completed'\|'stopped'\|'failed', failure, settings, metrics, task, promptSha256, provenance, createdAt }`. `installId` must be an install on the same device (`not_found`); `invalid_state` when revoked. Prompts and replies are never stored. |
| `listExecutionRuns({ workspaceId, ownerId, deviceId, limit })` | runs, newest first, at most 200. |
| `listCapitalCases(workspaceId)` / `getCapitalCase({ workspaceId, caseId })` | cases `{ id, workspaceId, projectId, enhanceRunId, title, status: 'draft'\|'submitted'\|'changes_requested'\|'evidence_reviewed', draft, revision, submittedRevision, createdBy, createdAt, updatedAt }`, oldest first / one case or `null` outside its workspace. `draft` is the bounded JSON the routes validate (`validateCapitalDraft` in `src/lib/capital.js`): purpose, `requestedAmountCents`, timing, company, `costItems` (at most 40, each `amountCents` a safe integer of US cents from 0 to 10¹², `basis` quoted, estimated or incurred; an incurred item cites an `evidenceId` of this case), references and `datasetVersions`. No lender state exists. |
| `createCapitalCase({ workspaceId, createdBy, title, projectId, enhanceRunId, draft })` | case (`revision: 1`), plus `capital_case.created`. `projectId` and `enhanceRunId` must belong to the same workspace (`not_found`, a composite foreign key in Postgres). |
| `updateCapitalCase({ workspaceId, caseId, expectedRevision, title, projectId, enhanceRunId, draft })` | case with `revision + 1`. `expectedRevision` must equal the current revision (`stale_revision`), so two editors cannot overwrite each other; `invalid_state` while `submitted`. Under the same lock, every reference the draft makes must resolve (`referencesResolve`: an incurred item cites evidence of this case, a dataset link names a frozen version of this workspace), else `missing_reference`. The whole draft is replaced. |
| `submitCapitalCase({ workspaceId, caseId, submittedBy, expectedRevision, contentHash })` | submission `{ id, caseId, workspaceId, revision, snapshot, contentHash, submittedBy, submittedAt, decision: null, decidedBy, decidedAt, notes }`. In one transaction under the case lock: `revision` must equal `expectedRevision` (`stale_revision`); the draft must be complete (`draftComplete`) and that revision not sent before (`invalid_state`); references are rechecked (`missing_reference`); the snapshot (`capitalSnapshot`: title, links, draft, totals by basis and period, current credit records, evidence) is built from the locked rows and its `snapshotHash` (`src/lib/capital-hash.js`, SHA-256 of canonical JSON) must equal `contentHash`, else `stale_revision` with message `content`: consent binds the exact content shown, not just the draft. The snapshot and hash are frozen; status becomes `submitted` with `submittedRevision`; `capital.submitted` is recorded. Sending the same revision with the same hash again while it is with review returns the existing submission, so a retry never duplicates a request; another hash is `stale_revision`. A different revision while submitted throws `invalid_state`. |
| `withdrawCapitalCase({ workspaceId, caseId, actorId })` | case, now `draft` with `revision + 1`; the open submission gets `decision: 'withdrawn'`; `capital.withdrawn`. `invalid_state` unless submitted. |
| `listCapitalSubmissions({ workspaceId, caseId })` | submissions oldest first, snapshots included (routes strip them from lists). |
| `listCreditRecords(workspaceId)` / `createCreditRecord({ workspaceId, createdBy, record, supersedes })` | records `{ id, workspaceId, provider, status: 'claimed'\|'evidenced'\|'withdrawn', amountCents, expiresOn: 'YYYY-MM-DD'\|null, restrictions, reference, supersedes, supersededBy, createdBy, createdAt }`, oldest first / the new record. Append-only: a correction is a new row that `supersedes` one earlier row of the same workspace (`not_found`), and a row can be corrected once (`invalid_state`). A claimed amount is a statement, never a balance. Credits are not frozen by a submission: the snapshot keeps the records as they were. |
| `listCapitalEvidence({ workspaceId, caseId })` / `addCapitalEvidence({ workspaceId, caseId, createdBy, item })` / `deleteCapitalEvidence({ workspaceId, caseId, evidenceId })` | evidence `{ id, caseId, workspaceId, kind, title, source, reference, verification: 'unverified'\|'client_reported', createdBy, createdAt }`. The route validates `item` (`validateEvidence`): a bounded reference with the cited facts copied in, never file bytes. Adding or deleting throws `invalid_state` while the case is submitted; deleting a record an incurred cost item cites throws `evidence_in_use`, checked on the locked case row; `not_found` outside the case or workspace. Staff never change these rows. |
| `listCapitalReviewMarks({ workspaceId, caseId })` | marks `{ id, submissionId, evidenceId, reviewerId, createdAt }` across the case's submissions (routes strip `reviewerId` for customers). |
| `listCapitalCasesForReview({ status })` / `getCapitalCaseForReview(caseId)` | staff queue across workspaces: `{ id, workspaceId, workspaceName, status, revision, submittedRevision, createdAt, updatedAt, latestSubmission }` / `{ case (same fields), workspace: { id, name, kind, synthetic }, submission (latest), marks (on it) }` or `null`. Neither returns a live title, draft, evidence or credit record: staff see only what was frozen in a submission. |
| `decideCapitalSubmission({ caseId, submissionId, reviewerId, decision, notes })` | the submission, decided. `decision` is `changes_requested` or `evidence_reviewed` only (anything else `invalid_state`); the case must be `submitted` with an open submission (`invalid_state`) and that submission must be `submissionId`, the one the reviewer saw (`stale_revision` with message `submission` otherwise: a withdrawn-and-resent case is never decided by a stale action); case status becomes the decision; `capital.<decision>` is recorded, in one transaction. A decision is written once: Postgres refuses any later change to the row. |
| `markCapitalEvidenceReviewed({ caseId, submissionId, evidenceId, reviewerId })` | an append-only mark, plus `capital.evidence_item_reviewed`. Only while the case is `submitted` with `submissionId` open (`invalid_state`, `stale_revision`), and only for an evidence id frozen in that submission's snapshot (`not_found`). Marking again returns the same mark. The customer's evidence row is untouched. |
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
             success: {...}|null, dataSource: {...}|null, model: {...}|null,
             labelSet: [{ id, name, scope: 'span'|'file'|'box', tone }], status: 'draft'|'in_review'|'changes_requested'|'approved'|'versioned', setupStep, createdAt, updatedAt }
```

`listDatasetVersions` likewise adds `rawInvalidBoxIds` per version in Postgres. The memory store holds JavaScript values, so it has nothing to add.

`profile`, `success`, `dataSource` and `model` are JSON objects that the routes validate before they're stored. Store them as `jsonb`.

## Changelog

- **v13:** Capital (`013_capital.sql`): `capital_cases` (bounded JSON draft checked by `capital_draft_valid`, which never returns NULL, integer `revision`, `submitted_revision`), `capital_submissions` (frozen snapshots with the consented `content_hash`, one per case revision, one open per case, decision written once), `credit_records` (append-only, one correction per row, amounts in bigint cents), `capital_evidence` (the customer's claims, never edited by staff) and `capital_review_marks` (append-only staff marks keyed to one submission and one frozen evidence id). Amount bounds, status values, same-workspace links (composite foreign keys, which adds `UNIQUE (id, workspace_id)` to `projects` and `enhance_runs`) and the freeze rules are enforced in SQL as well as in both stores. New error codes `stale_revision`, `evidence_in_use`, `missing_reference`. Statuses stop at Valcairn's internal review; lender offer, approval and funding do not exist in the schema.

- **v12:** Run on this device: `devices`, `device_reports`, `model_installs` and `execution_runs` (`012_devices.sql`), all scoped to one owner and marked `client_reported`. Failures store only an error category, never runtime text.

- **v11:** Enhance-run approval names the plan version it approves (`expectedUpdatedAt`, `stale_plan`), and every plan edit gets a strictly later `updatedAt`. Training eligibility (`allowsTraining` in `src/lib/models.js`) needs an uploaded rights record that allows training and at least one delivered file. Plans refuse more than 20 dataset versions instead of truncating.

- **v10:** Models. `model_pulls` and `enhance_runs` (`011_models.sql`). A requested run is frozen by a trigger, including against direct SQL updates and deletes. Copying weights and running on GPUs are not automated: a pull stays `requested` and a run stays `requested` until Valcairn acts on it.
- **v9:**
  - `ruleProblem` (`src/lib/onboarding.js`) is the one check for a complete acceptance rule: a known measure; for a metric, a `target` string; for `rubric` or `data_quality`, a `criteria` string; nonblank after trimming and within 40 or 1000 characters. Saving, Resolve and the submit gate use it, so a stored rule written around the API (blank, wrong type, unknown measure, too long) blocks review. It only reads the rule; nothing is normalized on read. New API input is still trimmed and cut to those limits before saving, as before.
  - Postgres decides whether a stored box is in 010's form in SQL (`src/lib/box-sql.js`, the predicate of 010 word for word): `storedFormInvalid` on annotations, `rawInvalidBoxIds` on reviews and versions. The gate, Resolve and history warnings use it. Frozen snapshots and manifests are still only flagged.
- **v8:**
  - Review needs an acceptance rule: `requireResolved` blocks on a missing `success` for every data source, under the submit lock.
  - Stored labels and types that today's rules refuse are blocking issues (`findInvalid`) with in-place repairs. Frozen snapshots and versions are only flagged (`warnings` in the version and staff APIs), never rewritten.
  - Postgres: `010_annotation_box_stored_form.sql` adds `annotations_box_stored_form`, `NOT VALID`: required numeric keys, whole millionths, sides ≥ 0.001, edge tolerance 1e-6, for every new or changed row.
- **v7:**
  - Postgres: `009_freeze_upload_updates.sql` freezes every column of an upload in a frozen project, not just its type and offset.
  - Box labels need image content (`contentType`), and box geometry is validated after rounding. `kind: 'image'` needs image content (`invalid_kind`).
- **v6:**
  - `setLabelSet` replaces label-set edits through `updateProject`; `updateAnnotation`; box labels (`annotations.box`).
  - The Resolve gate and label rules moved into the stores, under the project lock. New error codes `issues_open`, `label_in_use`, `invalid_label`.
  - Postgres: `008_dataset_locking.sql` (locking freeze guard on uploads, annotations and issue notes; `box` column).
- **v5:**
  - Dataset workspace: `projects.labelSet`, `uploads.kind` and `uploads.offsetMs`, annotations and issue notes, all frozen with the rest of the review content and included in the snapshot.
  - Postgres: `007_dataset_workspace.sql` (`annotations`, `issue_notes`, new columns, freeze triggers).
  - Submitting a project whose data is uploaded requires every open issue to be fixed or noted (`issues_open`, routes only).
- **v5:** Reopen permissions are enforced in the store against current membership/state (`forbidden`); working-set removal and refused receipt registration retain committed object bytes to protect retries and immutable history. No schema migration is required.
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
