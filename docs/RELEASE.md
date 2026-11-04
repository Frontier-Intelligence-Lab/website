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
| `MODEL_CATALOG_FILE` | Path of the read-only model catalog JSON mounted into the web container (`docs/model-catalog.example.json` shows the format). Optional; see Models below. |

Ingest needs `INGEST_SHARED_SECRET`, `INGEST_STORAGE=s3://…`, `INGEST_ALLOWED_ORIGINS=https://frontierintelligencelab.com`, `INGEST_BIND=0.0.0.0:4100` and the `AWS_*` storage credentials. Set a bucket lifecycle rule that aborts incomplete multipart uploads after 1 day. Pending uploads that were never committed are swept every hour (`INGEST_PENDING_TTL_SECONDS`, default 24 h).

**Runners and jobs (migration 014).** `014_jobs.sql` only creates tables (`runners`, `jobs`, `job_events`) and their triggers, so it is safe after 001 to 013 and the previous web build ignores them. It also replaces the `enhance_runs_compute_check` constraint to allow `runner`; the previous build never writes that value. Migrations create tables as the migrator role, so grant the app role exactly what it uses, if your database does not use default privileges:

  ```sql
  GRANT SELECT, INSERT, UPDATE ON runners, jobs TO <app_role>;
  GRANT SELECT, INSERT ON job_events TO <app_role>;
  GRANT USAGE ON SEQUENCE job_events_id_seq TO <app_role>;
  ```

  No `DELETE` on any of the three: they are removed only by the cascade from deleting a workspace (which the app role already may do), and triggers refuse direct deletes of jobs and any change to job events. Without `USAGE` on `job_events_id_seq` every event report fails. Do not run this migration against production from a development machine; it ships through the normal release. No new environment variables. Runners reach the API at `/api/runner/*` with a bearer key, so the reverse proxy must pass the `Authorization` header through unchanged.

**Run on this device (migration 012).** `012_devices.sql` only creates tables (`devices`, `device_reports`, `model_installs`, `execution_runs`), so it is safe after 001 to 011 and the previous web build ignores them. Confirm the app role can `SELECT, INSERT, UPDATE` on all four. `LOCAL_RUNTIME_ORIGINS` is optional and defaults to Ollama on loopback. Mount a reviewed catalog and set `LOCAL_MODEL_CATALOG_FILE` to offer downloads (start from `docs/local-models.example.json`); a bad catalog stops startup. This file is distinct from `MODEL_CATALOG_FILE` below: it lists what a person may download to their own runtime, in its own format, and the two must not be swapped. Each user adds the production origin to their own `OLLAMA_ORIGINS`; nothing on the server configures that. With the production CSP, including `upgrade-insecure-requests`, Chromium was checked to leave `http://127.0.0.1:11434` unrewritten (a production-mode server returned the Ollama version). Firefox and Safari, and a page served over https, are not yet checked; do that before announcing the feature.

**Models (migration 011).** `011_models.sql` adds `model_pulls` and `enhance_runs`. It only creates new tables, so it is safe on a database that already has 001–010, and the previous web build ignores them. Apply it before the web build that shows Models, and confirm the app role can `SELECT, INSERT, UPDATE` on both tables (and `DELETE` on `enhance_runs`, which the freeze trigger limits to drafts). No migration is needed for the catalog itself: the models offered are not in the database or the image but in a JSON file named by the optional `MODEL_CATALOG_FILE`, mounted read-only. Without it the web build starts with an empty catalog (a warning is logged): the Models pages offer nothing to pull and refuse new enhance plans, while pulls and runs already in the database stay readable. An unreadable or invalid file stops the container at startup with the reason, so start a local server against the file first. Removing a model from the file later never touches stored rows: its pulls and requested plans are still returned and shown as not in the current catalog; a draft on it must move to a listed model before it can be approved.

**Dataset workspace (migrations 007 to 010).** All four must be applied, in order, before the matching web build. 008 and 009 each correct the freeze guard before them (008 adds the parent lock, 009 covers every upload column), and 010 adds the stored-form box constraint, so none may be skipped, even where 007 is already applied.

010 is installed `NOT VALID`. Installing it checks every box that is written or changed from then on, but leaves rows already stored alone, so the upgrade cannot fail on, delete or rewrite existing data, including frozen, approved history. Validating it is a separate, later step that checks every existing row too, and it fails while any non-conforming box remains.

After the upgrade, list every box the constraint would refuse with the read-only query in `scripts/sql/annotation-box-violations.sql`. It is the constraint's own predicate, negated, so it catches every case the constraint does (missing or extra keys, non-number values, more than six decimals, sides under 0.001, out-of-bounds or overrunning boxes) and never fails on a non-number value. An empty result means validation will succeed; a tested equivalence in `tests/store-postgres.test.js` keeps the two in step.

- Rows in draft projects show up on Resolve as blocking issues; editors delete or redraw them before the next review.
- Rows in frozen projects (in review, approved, versioned) stay exactly as approved. The Versions and staff pages flag them. Do not delete or rewrite approved data to make validation pass.
- Run `ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form;` only when the query returns no rows. If frozen history still holds non-conforming boxes, leave the constraint `NOT VALID`: new writes are protected either way. Neither needs new environment variables. Migrations create tables as the migrator role, so confirm the app role can `SELECT, INSERT, UPDATE, DELETE` on `annotations` and `issue_notes` (grant it explicitly if your database does not use default privileges). Ingest must be rebuilt for `/v1/preview` (inline, sandboxed previews with byte ranges) before web links to it. The web CSP now allows `blob:` for images and media only, to preview files a person has picked before upload.

Previews give viewers the original bytes: anyone who can preview a file can save it. Hiding Download from viewer and finance roles is not access control over the content. If some roles must see less than the original, that needs deliberately designed derivatives (for example thumbnails or redacted copies), which do not exist yet.

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
