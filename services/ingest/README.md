# ingest

Rust service that receives sample uploads for Valcairn projects. The browser sends files here directly; the web server never handles file bytes. See `docs/ARCHITECTURE.md` for how the pieces fit.

For each upload, the service:

1. Checks the grant in `Authorization: Bearer …`. The web server signs it with `INGEST_SHARED_SECRET`, scopes it to one workspace, project and person, gives it a size limit and a 10-minute expiry, and lets it upload **exactly one file** (single-use nonce).
2. Streams the body into the **pending** area, `pending/ws/<workspace>/projects/<project>/<uuid>`. The client never chooses the key.
3. Enforces the smaller of the grant's limit and `INGEST_MAX_BYTES`, and disconnects a client that goes silent for `INGEST_IDLE_SECONDS`.
4. Detects the file type from its content. It accepts images, audio, video, PDF, archives, Parquet and UTF-8 text/CSV/JSON. It refuses executables, HTML, SVG and XML.
5. Surfaces every storage write error. A failed write, a refused type or an oversized file **aborts the multipart upload and returns no receipt**.
6. Returns a SHA-256 and a signed receipt.

The web server then calls `POST /v1/commit` with a one-minute token naming that key. Ingest moves the object to `ws/<workspace>/projects/<project>/uploads/<uuid>`, and the web server records it. Commits are idempotent. `POST /v1/delete` removes one pending or committed object. Pending objects that are never committed are deleted by an hourly sweeper after `INGEST_PENDING_TTL_SECONDS` (default 24 h).

`GET /v1/objects?token=…` streams a **committed** object for a short-lived download token, always as an attachment with `nosniff`.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `INGEST_SHARED_SECRET` | yes | 32+ characters, the same value as the web server's `INGEST_SHARED_SECRET`. |
| `INGEST_STORAGE` | yes | `file:///absolute/dir` for development, `s3://bucket/prefix` in production (credentials from the standard `AWS_*` variables; `AWS_ENDPOINT` for MinIO or R2). |
| `INGEST_ALLOWED_ORIGINS` | yes | Comma-separated web origins allowed to upload, e.g. `http://localhost:3000`. |
| `INGEST_BIND` | no | Default `127.0.0.1:4100`. |
| `INGEST_MAX_BYTES` | no | Hard cap per file. Default 200 MiB. |
| `INGEST_IDLE_SECONDS` | no | Default 60. |
| `INGEST_SWEEP_SECONDS` | no | How often to remove stale pending uploads. Default 3600. |
| `INGEST_PENDING_TTL_SECONDS` | no | Age after which an uncommitted upload is removed. Default 86400. |

The service refuses to start if a required value is missing or invalid.

## Run and test

```bash
cargo test
INGEST_SHARED_SECRET=… INGEST_STORAGE=file://$PWD/../../.local/objects INGEST_ALLOWED_ORIGINS=http://localhost:3000 cargo run
```

The web server needs `INGEST_PUBLIC_URL` (this service's public origin) and the same `INGEST_SHARED_SECRET` to turn uploads on.

## Known limits

- Single-use grants are remembered in memory, so run one ingest instance or put a shared store behind `claim_grant` before scaling out. Grants expire after 10 minutes either way.
- Malware scanning is not built in yet. Downloads are always served as attachments, never rendered.
- Docker: `docker build -t valcairn-ingest services/ingest`.
