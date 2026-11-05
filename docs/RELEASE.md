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
| `LOCAL_MEMORY_ORIGINS` | Unset means the build's default loopback gateway origins (Memory and Agents pages on); explicitly empty turns both off. Decide before the rollout; see Memory and Agents below. |

Ingest needs `INGEST_SHARED_SECRET`, `INGEST_STORAGE=s3://…`, `INGEST_ALLOWED_ORIGINS=https://frontierintelligencelab.com`, `INGEST_BIND=0.0.0.0:4100` and the `AWS_*` storage credentials. Set a bucket lifecycle rule that aborts incomplete multipart uploads after 1 day. Pending uploads that were never committed are swept every hour (`INGEST_PENDING_TTL_SECONDS`, default 24 h).

**Runners and jobs (migration 014, pending: PR #13, not on `master`).** When a release carries it, `014_jobs.sql` only creates tables (`runners`, `jobs`, `job_events`) and their triggers, so it is safe after 001 to 013 and the previous web build ignores them. It also replaces the `enhance_runs_compute_check` constraint to allow `runner`; the previous build never writes that value. The app role needs `SELECT, INSERT, UPDATE` on `runners` and `jobs`, `SELECT, INSERT` on `job_events` and `USAGE` on `job_events_id_seq`; the release helper grants exactly these statements and refuses anything broader, including `SELECT` or `UPDATE` on that sequence and any other sequence on a contract table. No `DELETE` on any of the three: they are removed only by the cascade from deleting a workspace (which the app role already may do), and triggers refuse direct deletes of jobs and any change to job events. Without `USAGE` on `job_events_id_seq` every event report fails. No new environment variables. Runners reach the API at `/api/runner/*` with a bearer key, so the reverse proxy must pass the `Authorization` header through unchanged.

*Prerequisite before the first release that carries 014 (operator, after a fresh backup and review; never the helper).* The production database's default privileges were reported (PR #13 review, 4 November 2026; confirm read-only before acting) to give the app role `SELECT, USAGE` on every sequence the migrator creates, so `job_events_id_seq` would be born with `SELECT`, which the helper reports as a privilege beyond the contract and refuses; it never revokes, never alters defaults and never grants around it. Correct the sequence default only, keeping every existing table, sequence (for example `audit_events_id_seq`), ACL and row as it is. Inspect the current entries first (`\ddp` in psql, or `SELECT * FROM pg_default_acl`), then remove `SELECT` from the matching sequence default with the same owner and schema as that entry:

  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE <migrator_role> IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM <app_role>;
  ```

  Verify with `\ddp` that the sequence default now lists only `U` for the app role; the table defaults are untouched. If the release runs before this correction, the helper applies 014, stops at the grant check with "privileges beyond the release contract", swaps nothing and leaves the previous build running; the operator then runs `REVOKE SELECT ON SEQUENCE job_events_id_seq FROM <app_role>;` (as the sequence owner) plus the default correction above and re-runs the release, whose migration step then reports `Applied 0`. The optional real-database proof in `tests/test_deploy.py` exercises exactly this refusal and correction.

**Evaluation of imported answers (migration 015, pending: PR #24, not on `master`).** When a release carries it, `015_evaluation.sql` only creates tables (`eval_sets`, `eval_cases`, `eval_issue_notes`, `eval_set_versions`, `eval_batches`, `eval_predictions`, `eval_comparisons`, `eval_judgments`, `eval_reports`), functions and triggers, so it is safe after 001 to 013 and the previous web build ignores them. It does not read or alter jobs, runners or `enhance_runs`, and it is independent of 014: the helper accepts a database at 013, at 014 alone, at 015 alone or at both, the ledger deciding per group; when both files are present the migrator applies 014 first by filename, and a database that already has 015 still applies 014 later as a new file. The app role needs `SELECT, INSERT, UPDATE` on `eval_sets`, `eval_comparisons` and `eval_judgments` (edited in place), `SELECT, INSERT, UPDATE, DELETE` on the draft rows `eval_cases` and `eval_issue_notes`, `SELECT, INSERT, UPDATE` on `eval_set_versions` only because imports and comparisons take its row lock (its append-only trigger refuses any actual change), and `SELECT, INSERT` on `eval_batches`, `eval_predictions` and `eval_reports`; the release helper grants exactly that and refuses anything broader, in particular `DELETE` on any frozen record. All nine use uuid defaults, so no sequence. Before and after the migration the helper digests set versions, batches, predictions and reports in full, and the frozen identity (pair, rule, case) of comparisons and judgments; a changed or vanished record stops the release. No new environment variable; this slice calls no model.

**Run on this device (migration 012).** `012_devices.sql` only creates tables (`devices`, `device_reports`, `model_installs`, `execution_runs`), so it is safe after 001 to 011 and the previous web build ignores them. The app role needs `SELECT, INSERT, UPDATE` on `devices` and `model_installs` (row locks and upserts) and only `SELECT, INSERT` on `device_reports` and `execution_runs`; the release helper grants exactly that and refuses anything broader. `LOCAL_RUNTIME_ORIGINS` is optional and defaults to Ollama on loopback. Mount a reviewed catalog and set `LOCAL_MODEL_CATALOG_FILE` to offer downloads (start from `docs/local-models.example.json`); a bad catalog stops startup. This file is distinct from `MODEL_CATALOG_FILE` below: it lists what a person may download to their own runtime, in its own format, and the two must not be swapped. Each user adds the production origin to their own `OLLAMA_ORIGINS`; nothing on the server configures that. With the production CSP, including `upgrade-insecure-requests`, Chromium was checked to leave `http://127.0.0.1:11434` unrewritten (a production-mode server returned the Ollama version). Firefox and Safari, and a page served over https, are not yet checked; do that before announcing the feature.

**Models (migration 011).** `011_models.sql` adds `model_pulls` and `enhance_runs`. It only creates new tables, so it is safe on a database that already has 001–010, and the previous web build ignores them. Apply it before the web build that shows Models; the app role needs `SELECT, INSERT` on `model_pulls` and `SELECT, INSERT, UPDATE` on `enhance_runs` (drafts are edited and requested in place, nothing deletes a run, and the freeze trigger protects requested plans), and the release helper grants exactly that. No migration is needed for the catalog itself: the models offered are not in the database or the image but in a JSON file named by the optional `MODEL_CATALOG_FILE`, mounted read-only. Without it the web build starts with an empty catalog (a warning is logged): the Models pages offer nothing to pull and refuse new enhance plans, while pulls and runs already in the database stay readable. An unreadable or invalid file stops the container at startup with the reason, so start a local server against the file first. Removing a model from the file later never touches stored rows: its pulls and requested plans are still returned and shown as not in the current catalog; a draft on it must move to a listed model before it can be approved.

**Capital (migration 013).** `013_capital.sql` adds `capital_cases`, `capital_submissions`, `credit_records`, `capital_evidence` and `capital_review_marks` with freeze and append-only triggers; it only creates tables and functions after 011, and the previous web build ignores them. The app role needs `SELECT, INSERT, UPDATE` on `capital_cases` and `capital_submissions`, `SELECT, INSERT` on `credit_records` and `capital_review_marks`, and `SELECT, INSERT, DELETE` on `capital_evidence`; nothing deletes submissions, credit records or review marks. Capital is private planning, evidence and internal review only: no lender offer, approval, funding, credit spending or money movement exists in this release.

**Memory and Agents (no migration).** Both run in the visitor's browser against services on their own computer and add no server table and no server secret. `LOCAL_MEMORY_ORIGINS` unset means the build's default `http://127.0.0.1:8787,http://localhost:8787` and the Memory and Agents pages are on; set it explicitly empty to turn them off; a non-loopback value stops startup. The Provena gateway on the visitor's machine must be configured with the exact public page origin (`https://frontierintelligencelab.com`), a key bound to one workspace and one person, and its own private transport credential; none of those ever go into Valcairn's environment, and the release helper refuses any Provena or memory key, token or secret name there. The only check so far was a localhost-served page with the production CSP reaching a loopback runtime in Chromium (see Run on this device above); the actual deployed HTTPS origin reaching loopback services for Run on this device, Memory and Agents, and the browser-specific permission prompts in Chromium, Firefox and Safari, remain unverified until root's live QA on that origin, so do not announce any of the three as working there before then.

**Dataset workspace (migrations 007 to 010).** Production is at `001` to `013`: the release of master `787dbd261ab97e37ad08d335d39ab0ce89ca9e60` (4 November 2026) applied `007` to `013` in one run after a verified scratch restore of the 14 tables that existed then, and the following release of `52f1d66db0bc5ba7589b148168ef41b3c9326622` restored and verified all 27 tables and applied 0 migrations on both runs; the migrator applies any later pending file in filename order. On a database still below `010`, all four must be applied, in order, before the matching web build. 008 and 009 each correct the freeze guard before them (008 adds the parent lock, 009 covers every upload column), and 010 adds the stored-form box constraint, so none may be skipped, even where 007 is already applied.

010 is installed `NOT VALID`. Installing it checks every box that is written or changed from then on, but leaves rows already stored alone, so the upgrade cannot fail on, delete or rewrite existing data, including frozen, approved history. Validating it is a separate, later step that checks every existing row too, and it fails while any non-conforming box remains.

After the upgrade, list every box the constraint would refuse with the read-only query in `scripts/sql/annotation-box-violations.sql`. It is the constraint's own predicate, negated, so it catches every case the constraint does (missing or extra keys, non-number values, more than six decimals, sides under 0.001, out-of-bounds or overrunning boxes) and never fails on a non-number value. An empty result means validation will succeed; a tested equivalence in `tests/store-postgres.test.js` keeps the two in step.

- Rows in draft projects show up on Resolve as blocking issues; editors delete or redraw them before the next review.
- Rows in frozen projects (in review, approved, versioned) stay exactly as approved. The Versions and staff pages flag them. Do not delete or rewrite approved data to make validation pass.
- Run `ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form;` only when the query returns no rows. If frozen history still holds non-conforming boxes, leave the constraint `NOT VALID`: new writes are protected either way. Neither needs new environment variables. Migrations create tables as the migrator role, so confirm the app role can `SELECT, INSERT, UPDATE, DELETE` on `annotations` and `issue_notes` (grant it explicitly if your database does not use default privileges). Ingest must be rebuilt for `/v1/preview` (inline, sandboxed previews with byte ranges) before web links to it. The web CSP now allows `blob:` for images and media only, to preview files a person has picked before upload.

Previews give viewers the original bytes: anyone who can preview a file can save it. Hiding Download from viewer and finance roles is not access control over the content. If some roles must see less than the original, that needs deliberately designed derivatives (for example thumbnails or redacted copies), which do not exist yet.

Committed object bytes are retained when an upload registration fails or a file is removed from the editable working set. This protects receipt retries and historical review/version downloads. Current project quotas count working-set records, so they do not bound retained storage after repeated upload/remove operations. Keep usage controlled until reference-aware garbage collection or a physical-storage limit is in place; do not add a blanket committed-object deletion lifecycle that would break historical manifests.

## Order of operations

With the automatic helper (`docs/AUTO_DEPLOY.md`) steps 1, 2, 4 and 5 run in this order: preflight (role contract, reviewers, catalogs), free space, snapshot-consistent backup with a scratch-restore fingerprint proof, image builds, master re-check, catalog validation, grants on existing tables, frozen-record digests, migrations twice, grants again, digests compared, ingest then web swap, public checks; a failure after a swap restores the previous containers.

1. **Back up first.** The helper takes a snapshot-consistent `pg_dump`, restores it into a uniquely named scratch database and compares per-table fingerprints before touching anything. Keep the previous image tags for rollback: after the 4 November 2026 release web and ingest run `valcairn-site:52f1d66db0bc5ba7589b148168ef41b3c9326622` and `valcairn-ingest:52f1d66db0bc5ba7589b148168ef41b3c9326622`, with `787dbd261ab97e37ad08d335d39ab0ce89ca9e60` retained as the previous pair; re-read both from the running containers immediately before the rollout.
2. **Migrate.** Run the migrate image once with the migrator role:
   ```bash
   docker run --rm --network <db-network> --env-file /path/to/migrator.env valcairn-migrate:<tag>
   ```
   The image prints `Applied N migration(s): …`. A second run prints `Applied 0`, which is a safe no-op.
3. **Reviewers are already provisioned.** `admin` (admin), `ycinsider` (viewer) and `sr008-reviewer` (viewer) exist and are enabled in `reviewer_accounts`; the helper's preflight requires exactly these three enabled accounts, and a release never imports, resets, re-provisions or disables them. The commands below are for a fresh environment only:
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
5. **Deploy web.** Keep `SESSION_SECRET`, `COOKIE_SECURE=true`, `TRUST_PROXY`, `STAFF_EMAILS`, the ingest settings and the `SIGNIN_LOG_FILE` mount unchanged; `REVIEWERS_FILE` is already absent (reviewers live in Postgres). The helper replaces each container with the same environment, mounts, networks and labels so that only the image changes, ingest first and web last; any catalog or memory-origin decision is made in the container configuration before the rollout, never by the helper.
6. **Smoke test** (Codex retests the live site independently):
   - `/healthz` returns 200.
   - `ycinsider`, `sr008-reviewer` and `admin` each sign in. Only `admin` sees the sign-in log.
   - A test sign-up, organization, project, upload, staff review and version work end to end.
   - Restart the web container: you stay signed in.

## Rollback

- **Web or ingest problem:** the helper restores the previous containers itself when a health or public check fails after a swap; manually, redeploy the previous tags (`valcairn-site:787dbd261ab97e37ad08d335d39ab0ce89ca9e60` and `valcairn-ingest:787dbd261ab97e37ad08d335d39ab0ce89ca9e60` after the 4 November 2026 release; the latest receipt names the exact pair). Migrations 007–013, and 014 and 015 when a release carries them, only add tables, columns with defaults, functions, triggers and a `NOT VALID` constraint that the previous build does not use (014 also widens one `enhance_runs` check constraint the previous build never exercises), so the old build runs unchanged against a migrated database; reviewer sign-in keeps using `reviewer_accounts`, and there is no `REVIEWERS_FILE` to restore.
- **Migration problem:** each migration file runs in its own transaction and either applies fully or not at all. A failed run leaves the ledger at the last good file. Fix forward with a new numbered file. Never edit an applied file; the runner refuses changed checksums.
- **Data must be undone:** restore the pre-release dump into a fresh database, verify it, then point `DATABASE_URL` at it. Dropping the new constraints alone is not a safe rollback once reviews or versions exist.

## Reviewer provisioning status

| Account | Role | Local (this Mac) | Production |
| --- | --- | --- | --- |
| `admin` | admin | Imported from the local hash | Provisioned 3 November 2026, enabled; preserved by every release |
| `ycinsider` | viewer | Local-only random password | Provisioned 3 November 2026, enabled; preserved by every release |
| `sr008-reviewer` | viewer | Local-only random password | Provisioned 3 November 2026, enabled; preserved by every release |

Local passwords live in an ignored file outside the repository and are not production credentials.
