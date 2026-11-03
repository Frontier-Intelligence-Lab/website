# Release guide: onboarding with Postgres

Prepared, not executed. Every production step below needs explicit approval first. Never paste production secrets into commands, tickets or chat. Use the hidden prompts and secret files described here.

## What ships

| Image | Build | Runs |
| --- | --- | --- |
| web | `docker build -t valcairn-site:<tag> .` | `node src/server.js` (pages, API, sessions) |
| migrate | `docker build --target migrate -t valcairn-migrate:<tag> .` | `node scripts/migrate.js` by default; also `scripts/reviewers.js` |
| ingest | `docker build -t valcairn-ingest:<tag> services/ingest` | Rust upload service on port 4100 (internal) |

New web configuration (all as runtime secrets or Coolify environment, never build args):

| Variable | Notes |
| --- | --- |
| `DATABASE_URL`, `DATABASE_SSL=verify-full` | App role (not the migrator). Enables Postgres data, sessions and reviewer accounts. |
| `INGEST_PUBLIC_URL`, `INGEST_SHARED_SECRET` | Turns uploads on. The secret must match ingest's. |
| `INGEST_INTERNAL_URL` | Optional private address of ingest for commit/delete calls. |
| `STAFF_EMAILS` | Valcairn staff who may use `/staff`. Must not include external reviewers. |
| `ACCOUNT_SIGNUP` | Leave unset (off) in production until public sign-up is approved. Invited users still need accounts, so decide this before launch. |
| `PROJECT_MAX_FILES`, `PROJECT_MAX_BYTES` | Optional sample quotas. |

Ingest needs `INGEST_SHARED_SECRET`, `INGEST_STORAGE=s3://…`, `INGEST_ALLOWED_ORIGINS=https://frontierintelligencelab.com`, `INGEST_BIND=0.0.0.0:4100` and the `AWS_*` storage credentials. Set a bucket lifecycle rule that aborts incomplete multipart uploads after 1 day. Pending uploads that were never committed are swept every hour (`INGEST_PENDING_TTL_SECONDS`, default 24 h).

Committed object bytes are retained when an upload registration fails or a file is removed from the editable working set. This protects receipt retries and historical review/version downloads. Current project quotas count working-set records, so they do not bound retained storage after repeated upload/remove operations. Keep usage controlled until reference-aware garbage collection or a physical-storage limit is in place; do not add a blanket committed-object deletion lifecycle that would break historical manifests.

## Order of operations

1. **Back up first.** Take a database dump, or a snapshot of the new empty database, and keep the previous web image tag (`valcairn-site:20261103-1610-8b6ce70`) for rollback.
2. **Migrate.** Run the migrate image once with the migrator role:
   ```bash
   docker run --rm --network <db-network> --env-file /path/to/migrator.env valcairn-migrate:<tag>
   ```
   The image prints `Applied N migration(s): …`. A second run prints `Applied 0`, which is a safe no-op.
3. **Provision reviewers**, before the web switches to Postgres, because reviewer sign-in then reads only `reviewer_accounts`:
   - **Import the existing hashes** for `ycinsider` and `admin` from the current private reviewer file. Hashes only; passwords are not needed:
     ```bash
     docker run --rm -i --network <db-network> --env-file /path/to/migrator.env \
       -v /path/to/existing/reviewers.json:/run/reviewers.json:ro \
       valcairn-migrate:<tag> node scripts/reviewers.js import /run/reviewers.json
     ```
     The file must hold only the accounts to import. Check that `ycinsider` is `viewer` and `admin` is `admin`.
   - **Set the Speedrun password** through the hidden prompt. It is typed into the terminal and never passed as an argument:
     ```bash
     docker run --rm -it --network <db-network> --env-file /path/to/migrator.env \
       valcairn-migrate:<tag> node scripts/reviewers.js set-password sr008-reviewer --name "Speedrun reviewer" --role viewer
     ```
   - **Verify** that all three accounts are listed and enabled:
     ```bash
     docker run --rm --network <db-network> --env-file /path/to/migrator.env valcairn-migrate:<tag> node scripts/reviewers.js list
     ```
4. **Deploy ingest** behind Traefik on its own HTTPS origin, then check `GET /healthz`.
5. **Deploy web** with the new variables. Keep `SESSION_SECRET`, `COOKIE_SECURE=true`, `TRUST_PROXY` and the `SIGNIN_LOG_FILE` mount unchanged. Remove `REVIEWERS_FILE` once the import is verified; if it is still set, the server logs that it is ignored.
6. **Smoke test** (Codex retests the live site independently):
   - `/healthz` returns 200.
   - `ycinsider`, `sr008-reviewer` and `admin` each sign in. Only `admin` sees the sign-in log.
   - A test sign-up, organization, project, upload, staff review and version work end to end.
   - Restart the web container: you stay signed in.

## Rollback

- **Web or ingest problem:** redeploy the previous web image tag and stop ingest. Migrations 001–006 only add tables, columns and triggers that the previous web build never reads, so the old build runs unchanged against a migrated database. Reviewer sign-in then uses `REVIEWERS_FILE` again, so keep that file in place until the new release is confirmed.
- **Migration problem:** each migration file runs in its own transaction and either applies fully or not at all. A failed run leaves the ledger at the last good file. Fix forward with a new numbered file. Never edit an applied file; the runner refuses changed checksums.
- **Data must be undone:** restore the pre-release dump into a fresh database, verify it, then point `DATABASE_URL` at it. Dropping the new constraints alone is not a safe rollback once reviews or versions exist.
- **Reviewer access problem:** run `scripts/reviewers.js disable <username>`. It takes effect immediately, including for open sessions.

## Reviewer provisioning status

| Account | Role | Local (this Mac) | Production |
| --- | --- | --- | --- |
| `admin` | admin | Imported from the local hash | Import the existing hash (step 3) |
| `ycinsider` | viewer | Local-only random password | Import the existing hash (step 3) |
| `sr008-reviewer` | viewer | Local-only random password | Set the supplied password through the hidden prompt (step 3) |

Local passwords live in an ignored file outside the repository and are not production credentials.
