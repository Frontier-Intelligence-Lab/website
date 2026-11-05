# Architecture

Valcairn is a set of services that share one Postgres database and one object store. Each service uses the language that best fits its job. This page records which service does what and why. Change it when a decision changes.

```text
Browser ── HTTPS ──► web (Node/Fastify) ── SQL ──► Postgres (source of truth, job queue)
   │                     │
   │  signed upload      │  signed upload grant / signed receipt
   └──────────────► ingest (Rust/axum) ── streams ──► object store (S3-compatible)
                                                        ▲
                   workers (Python) ◄── jobs ── Postgres │  (validation, evaluation, training)
                   control (Go)     ◄── jobs ── Postgres    (deployments, schedules)
```

| Service | Language | Owns | Why this language |
| --- | --- | --- | --- |
| `web` (repo root: `src/`, `web/`) | Node 24, Fastify 5, React 19 | Pages, sessions, accounts, workspaces, roles, onboarding API, review decisions | Request/response and database work. Shares one language with the UI, and is already tested. |
| `services/ingest` | Rust (axum, tokio) | Receiving untrusted files: streaming to storage, size limits, SHA-256, type sniffing, signed receipts | Untrusted input at high volume. Memory safety, predictable latency and low memory per upload. |
| `services/workers` (planned) | Python (uv) | Dataset validation, deduplication, evaluation runs, fine-tuning, distillation, quantization | Best ecosystem for ML: PyTorch, transformers, datasets, vLLM, ONNX. Workers are not used yet. Scoring of customer-supplied answers lives in `web` (`src/lib/eval.js`, `migrations/015_evaluation.sql`). |
| `services/control` (planned) | Go | Deployment controller, schedules, rollouts to customer clouds and edge | Strong infrastructure SDKs (Kubernetes, cloud APIs), simple concurrency, static binaries. |

Workers that run on a customer's own machine (Valcairn Runners, `docs/RUNNERS.md`) do not connect to Postgres. They call `web` over HTTPS with a runner key and lease jobs from the same Postgres queue through it, so tenancy and roles are checked by `web` on every call and the machine needs no inbound port or database credentials.

## Rules that hold across services

- **Postgres is the source of truth.** Services coordinate through tables and a job queue (`FOR UPDATE SKIP LOCKED`), not through each other's memory. The `web` store contract is `docs/STORE_CONTRACT.md`.
- **Files never pass through `web`.** Browsers upload straight to `ingest`, using a short-lived grant signed by `web` (HMAC, `INGEST_SHARED_SECRET`). `ingest` returns a receipt signed with the same secret, and `web` records only receipts it can verify. Object keys are derived from the workspace and grant, never chosen by the client.
- **Previews are inert and short-lived.** For any workspace member, `web` signs a 30-minute `preview` link naming one object and the type to serve it as. `ingest` serves only images, audio, video and plain text inline (`/v1/preview`, with byte ranges for seeking), under `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Downloads (`/v1/objects`) stay attachment-only and are signed only for roles that can edit.
- **Tenancy is enforced by the service that answers.** `web` checks workspace membership on every route. `ingest` accepts only a grant scoped to one workspace, project and size limit. Workers act on job rows that carry their workspace id.
- **Fail closed.** A missing secret, database or storage location turns the feature off with a clear message. It never falls back to something unsafe.
- **No secrets in Git.** Configuration comes from the environment. Each service documents its variables in its own README.

## Local development

| Piece | How |
| --- | --- |
| Postgres 17 | `docker compose -f docker-compose.postgres.yml up -d` (from `feat/postgres-store`) |
| Object store | Local filesystem directory (`INGEST_STORAGE=file:///…`). MinIO or S3 in production (`s3://bucket/prefix`). |
| ingest | `cargo run --manifest-path services/ingest/Cargo.toml` |
| web | `npm run dev`, or `npm run build && npm start` |
