# Valcairn Runners and jobs

A **runner** is a machine a workspace owns, a workstation or a GPU server, linked to Valcairn so jobs can run on it: sandbox checks now, and training, evaluation and export as those workers land. The web server never connects to a runner. The runner always calls in over HTTPS with its own key, so it works from a laptop behind NAT and needs no open port.

Status: the queue, the runner API and their tests are implemented (`migrations/014_jobs.sql`, `src/jobs.js`, `src/lib/jobs.js`). The runner program and the training, evaluation and export workers are separate increments; until they land, a job waits in the queue and nothing executes it.

## How it works

```text
Person (browser, session cookie)                  Runner (its machine, bearer key)
  link runner ── POST /runners ──► key shown once
  queue job ──── POST /jobs ─────► jobs: queued
                                  ◄── POST /api/runner/lease ── one job, a lease token
                                  ◄── heartbeat / events ────── running, progress, cancel?
  cancel ─────── POST /jobs/:id/cancel ► cancel_requested ──► runner sees cancelRequested
                                  ◄── POST .../finish ───────── succeeded / failed / cancelled
```

Job states: `queued` → `leased` → `running` → `succeeded`, `failed` or `cancelled`. While a runner holds a job it can also be `cancel_requested`.

## In the app

**Compute** (`/w/:slug/compute`) lists the workspace's runners with what each one reports: GPUs, sandbox, Ollama models and platform, and whether it is online (reported within the last 90 seconds). Owners and admins link a machine there, which shows the key once with the commands to start the runner. They can also run a sandbox check or disconnect a runner. Each job shows its status, its attempt and a live event timeline. A job that has not finished can be cancelled.

## Rules

- **Who.** Any member can see the workspace's runners and jobs. Only owners and admins link or revoke runners and queue or cancel jobs, because a job runs code on a machine against the workspace's data.
- **Keys.** A runner key (`vrk_` plus 43 base64url characters, 256 bits) is returned once when the runner is linked. Valcairn stores only its SHA-256 and a short prefix for display. A key stops working when the runner is revoked, or when the person who linked it is no longer an owner or admin of the workspace (`runner_owner_inactive`).
- **One job at a time.** A runner holds at most one job, since a training job owns the GPU. Leasing locks the runner row, so two concurrent lease calls cannot both win.
- **Leases.** A lease lasts 60 seconds (`LEASE_MS`) and every heartbeat or event batch extends it. A lease that runs out goes back to the queue, up to `MAX_ATTEMPTS` (3) attempts, then the job fails with `lease_expired`. A token from an expired or replaced lease is refused with `409 lease_lost`, so a runner that went to sleep cannot overwrite a newer attempt.
- **Retries.** A runner may report a failure as retryable (for example `out_of_memory`). It is queued again while attempts remain.
- **Cancel.** Cancelling a queued job ends it at once. Cancelling a held job sets `cancel_requested`. The runner sees `cancelRequested: true` on its next heartbeat or event call, stops its sandbox and reports the end, which is recorded as `cancelled`. If the runner never reports, the lease runs out and the job is still recorded as `cancelled`.
- **Revoke.** Revoking a runner cancels its waiting jobs and fails the job it holds (`runner_revoked`).
- **Frozen inputs.** A job's `spec` is copied when it is created: the approved plan, its plan version and the model's catalog entry. Later catalog or plan changes never alter what a job runs. In Postgres a trigger refuses any change to a job's inputs or to a finished job, and job events are append-only.
- **Plans.** Training, evaluation and export jobs need an enhance plan that was approved (`requested`) with compute set to **Your Valcairn Runner**. A plan approved for a GPU provider is not run on a runner.
- **What is stored.** Events are bounded and typed: `log` (level and up to 2,000 characters), `metric` (a name and a finite number), `stage` (a name and started, finished, skipped or failed) and `artifact` (a name, SHA-256 and size). Failures are stored as a category only (`cancelled`, `sandbox_unavailable`, `sandbox_error`, `out_of_memory`, `disk_full`, `dataset_error`, `model_unavailable`, `runtime_error`, `timeout`, `unsupported`), never as raw error text, which could echo training data. Runner capabilities (platform, GPUs, Ollama models, sandbox) are self-reported by the runner and shown as such.
- **Idempotency.** Queuing a job takes a request key. Sending the same key again returns the same job; reusing it for a different job is `409 idempotency_conflict`. Event batches carry a sequence number per attempt, so a retried batch is stored once.

## API for people (session cookie, same-origin POST)

| Method and path | Role | Result |
| --- | --- | --- |
| `GET /api/workspaces/:id/runners` | member | `{ runners }`: id, label, keyPrefix, status, capabilities, lastSeenAt. |
| `POST /api/workspaces/:id/runners` | owner, admin; 20 per 15 min | `{ label }` → `{ runner, key }`. The key is shown only here. |
| `POST /api/workspaces/:id/runners/:runnerId/revoke` | owner, admin | `{ runner }`; `409` if already revoked. |
| `GET /api/workspaces/:id/jobs` | member | `{ jobs }`, newest first, at most 50. |
| `GET /api/workspaces/:id/jobs/:jobId?after=<eventId>` | member | `{ job, events }`, events after the given id. |
| `POST /api/workspaces/:id/jobs` | owner, admin | `{ kind: 'probe'\|'train'\|'evaluate'\|'export', runnerId, enhanceRunId?, idempotencyKey }` → `{ job }`. |
| `POST /api/workspaces/:id/jobs/:jobId/cancel` | owner, admin | `{ job }`; `409` if it already finished. |

## API for runners (`Authorization: Bearer vrk_…`, no cookies)

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /api/runner/heartbeat` | `{ capabilities }` | `{ runner: { id, label, workspaceId }, leaseMs }`. |
| `POST /api/runner/lease` | none | `{ job: { id, kind, status, attempt, spec, leaseToken, leaseExpiresAt, cancelRequested } }` or `{ job: null }`. |
| `GET /api/runner/jobs/:jobId` | none | `{ job }`: status only, for recovery after a dropped response. |
| `POST /api/runner/jobs/:jobId/heartbeat` | `{ leaseToken }` | `{ job }`; extends the lease. |
| `POST /api/runner/jobs/:jobId/events` | `{ leaseToken, events: [{ seq, kind, data }] }` (1 to 50) | `{ added, job }`. |
| `POST /api/runner/jobs/:jobId/inputs` | `{ leaseToken }` | Training, evaluation and export only: `{ baseModel: { id, source, license }, datasets: [{ projectId, version, files: [{ id, filename, sha256, sizeBytes, contentType, url }] }], expiresInSeconds }`. Files come from each frozen version's manifest, with signed download links valid for 15 minutes. Refused with `409 dataset_unavailable` if a version is gone or its rights record no longer allows training, and `503 storage_unavailable` without file storage. Recorded as `job.inputs_released`. |
| `POST /api/runner/jobs/:jobId/finish` | `{ leaseToken, outcome: 'succeeded', result }` or `{ leaseToken, outcome: 'failed', failure, retryable? }` | `{ job }`. |

Errors: `401 runner_key_invalid`, `401 runner_owner_inactive`, `404` (another runner's job), `409 lease_lost`, `400 { errors }` for invalid input. The runner API allows 600 requests per minute per address.

## Edge cases covered by tests

`tests/jobs.test.js` (routes) and the shared store contract (`tests/store-contract.js`, memory and Postgres):

- A key is never listed again. A wrong, malformed or revoked key, or a browser session cookie, gets `401`.
- Demoting the person who linked a runner disables its key.
- Two lease calls never both get a job. A runner gets the next job only after the first ends.
- A wrong or stale lease token is refused. A finished job cannot be finished again or cancelled.
- A retried event batch is stored once. Each attempt has its own event sequence.
- Expired leases are retried three times, then fail as `lease_expired`.
- Cancel works both while a job waits and while it runs.
- Revoking a runner ends its jobs, and a revoked runner gets no new jobs.
- Another workspace's runner gets `404` for this workspace's jobs and cannot be used for them.
- A training job without an approved runner plan is refused, and so is a probe that carries a plan.
- Free-text failures are refused, and oversized or malformed events are refused.
- Postgres refuses edits to a job's inputs, to finished jobs and to job events, and deleting a workspace removes its runners, jobs and events together.
