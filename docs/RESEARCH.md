# Research directories

Research projects are separate from dataset projects. They do not enter the dataset review or approval states, and a research collection does not become an approved training dataset.

This unit registers the HTTP routes and Research workspace screens on top of the reviewed storage and public-worker units. The same existing database, scoped permissions, Python adapter and immutable evidence contracts are reused. Source/build/test completion does not prove deployment.

The same routes serve every workspace. Records, runs, lists and permissions stay inside the workspace that created them. YC and a16z Speedrun are demonstration organizations. The starter briefs name their public websites. They do not state either organization’s private investment criteria, and they are not an endorsement.

## What is reused

The company directory can import `data/frontier-ai-labs-seed.json` (62 organizations). That file is the Frontier AI labs catalog already collected for this system: a name, category, catalog tier, location and official URL. Imported claims stay `extracted` with method `existing_catalog`. The source URL is `catalog://frontier-ai-labs-seed/…`. The official URL is a field from the catalog. Importing it does not fetch the page, and it does not prove the other fields.

There is no sourced investor or partner catalog in this system. The partners directory stays empty until a public page is retrieved or a person adds a record with an excerpt. A partner is an evidenced professional role. Prospects are curated by a person. A catalog import cannot fill that directory.

These sources were not imported: the Crucible demo seed (fictional companies), LinkedIn connection files, and hackathon sponsor notes.

## What a run does

1. A person writes a question and names up to five `https` URLs, and may opt in to public Wikimedia opensearch.
2. The run is stored as `proposed`. Nothing is fetched.
3. Starting the run calls `services/research` (Python standard library). The worker resolves DNS, refuses private, shared (100.64.0.0/10), and loopback addresses, and fetches port 443 only. URLs named on the run are fetched before Wikimedia fills any remaining slots. Certificate verification stays on. On Windows the worker also loads the operating-system root store.
4. The API keeps a finding only when its excerpt is contained in the retrieved text. The worker’s hash is recomputed.
5. The initiating tab refreshes stored state while Start is pending and keeps Cancel available. Cancel first persists cancellation, then aborts the active Python child so remaining requests stop; an already sent request or received page cannot be undone. Closing the active HTTP request also cancels it. A late result cannot replace cancellation. A completed run has a stored report. Citations are pages that run quoted. A failed or cancelled run has no report. A run that is still `running` after two minutes is stored as failed with no report.
6. The person accepts selected candidates into a directory. Accepting into prospects counts as curation. Acceptance is another import, so running it again does not duplicate the same claim. A later retrieved page for the same URL creates a separate immutable source version. Earlier pasted, inaccessible and retrieved evidence keeps its original excerpt, timestamp and status; historical claims never silently acquire a different source snapshot.

Paid web search is not configured and is not called. `RESEARCH_SEARCH_BASE` is not read. The saved-note Agent is not used. If `RESEARCH_MODEL` and `RESEARCH_MODEL_BASE_URL` are both set, the capabilities page says a model is configured. This version still does not call it. If `RESEARCH_PYTHON` cannot be started, that run fails and says so.

The report consists of quoted retrieved text, not model-generated synthesis. HTML navigation or fallback text may appear in the excerpts. Inspect the source and its limitations; a completed fetch is not proof that the question was answered.

## Components

| Piece | Role | In this change |
| --- | --- | --- |
| React (`web/src/app/research.jsx`) | Browse, import, review, run, accept, export | Registered in this API/UI unit. Deployment must be verified separately. |
| Fastify (`src/research.js`) | Auth, workspace scope, allowlist, persistence | Registered in this API/UI unit. Deployment must be verified separately. |
| Postgres (`migrations/017_research.sql`) | Application records | Existing additive migration 017. Production application is a separate release gate. |
| Python worker (`services/research`) | Public HTTPS retrieval | Packaged by the runtime unit; this API authorizes calls. No database credentials enter the worker. |
| Rust ingest | File upload | Unchanged. Page fetch does not go through it. |
| Provena memory | Saved notes | Unchanged. |
| Python runner | Train, evaluate, export jobs | Unchanged. Research is not a train job. |

## Configuration

| Variable | Effect |
| --- | --- |
| `RESEARCH_PYTHON` | Optional executable override. Default `python`; the Docker runtime installs Python 3 and supplies that command without adding an image environment default. The migrator does not install Python. |
| `RESEARCH_MODEL` | Optional. Not called by this version. |
| `RESEARCH_MODEL_BASE_URL` | Optional. Both this and `RESEARCH_MODEL` must be set before the capability is reported as configured. |

## Local catalog import

Dry run, no database write, after the safety checks:

```powershell
node scripts/research-bootstrap.js --environment local --workspace <uuid>
```

`--apply` creates a collection project when `--project` is omitted and imports the catalog. It refuses `NODE_ENV=production`, a non-loopback database host, and a database name that does not contain `test`. `--retrieve` is refused. Do not point it at production.

## Validation and editing contracts

The API preserves import summaries but returns HTTP400 when every row fails. Partial imports retain failures and the UI keeps entered data for repair. Brief and checklist saves send only changed fields; stores apply them against the latest locked record. Checklist patches merge only known boolean keys. Unrelated refreshes preserve dirty brief/checklist fields, and inputs are locked while their write is pending. A failed request does not clear manual records or lists. Manual record identity hashes the complete normalized kind, name and URL instead of truncating them.

Quality shows extracted/inferred/unknown/conflicting claims as not yet supported or reviewed, not as false claims. Stale-source counts use the server's reported age threshold (currently 180 days since retrieval); age does not prove a source is wrong. Both counts are scoped to this project's evidence.

Each named list opens a searchable, sortable, paginated member view and has its own CSV export. `GET .../projects/:projectId/directory?listId=<uuid>` uses the existing directory route; a list filter takes precedence over directory and returns distinct entity members across that project's directories. The list must belong to the requested workspace and project. Writers can remove list membership only; the underlying entity, directory memberships and evidence remain, and Add on the record restores list membership. Viewers can inspect/export but cannot remove or add members. Empty lists and failed mutations are displayed explicitly.

Memory API regressions cover workspace isolation, real catalog persistence, stored cited-run receipts, cancellation with a deferred executor, late-result refusal, sanitized errors, rejected imports and partial project/checklist patches. Worker lifecycle tests cover pre-abort, timeout, pipe errors, late events and termination of an actual local Python child with no network. Shared store regressions cover immutable source versions and concurrent partial edits; PostgreSQL checks require a fresh local test database. These tests are not browser or deployment proof.

The final application image includes only the three worker package files and the existing company catalog. Docker context exceptions do not include the other services, research tests, caches or private files. Root review must verify the final container and actual browser workflow before release; this local repair does not claim deployment.

## Reviewer sessions

The synthetic-workspace flag stays on. Research POST routes are named one by one on the reviewer allowlist. Reviewers still cannot manage the team, link machines, run jobs, approve plans, send Capital, or change account settings.

## Release and verification

The controller registers all 12 Research tables for ledger-aware presence, fingerprinted normal backup/restore and exact application grants. Research events use PostgreSQL identity generation: implicit inserts need no direct sequence privileges, so direct sequence access stays denied. Existing serial job-event privileges remain unchanged.

The historical migration-016 recovery proof is bounded through 016. A separate populated latest-schema test verifies normal dump/restore of Capital, Evaluation and every Research table, including exact source versions and event identity continuity. The 51-table fingerprint builders use aggregation rather than exceeding PostgreSQL's function-argument limit.

Shared memory/PostgreSQL tests cover scope, provenance, dates, partial updates, list inspection/export, terminal states and rejected proposed completion. Tests use only fresh local databases with test names.

Merging source is not a deployment claim. Before migration 017 rollout, install the matching reviewed release controller through the approved runbook, verify current production prerequisites and a fresh normal backup/scratch restore, then test the exact deployed revision. Existing reviewer identities, passwords, customer records, configuration and protected history must be preserved.
