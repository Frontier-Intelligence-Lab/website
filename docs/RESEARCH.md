# Research directories

Research projects are separate from dataset projects. They do not enter the dataset review or approval states, and a research collection does not become an approved training dataset.

This pull request adds the tables, the planner, both stores, the 62-row company catalog, and the Python retrieval worker. It does not register the HTTP routes or the Research screens. Those stay on a follow-up branch until this change is on `master`, because the push hook counts the whole unmerged diff and stops at 2,000 lines.

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
5. A completed run has a stored report. Citations are pages that run quoted. A failed or cancelled run has no report. A run that is still `running` after two minutes is stored as failed with no report.
6. The person accepts selected candidates into a directory. Accepting into prospects counts as curation. Acceptance is another import, so running it again does not duplicate the same claim. A later retrieved page for the same URL upgrades an inaccessible source. It does not downgrade a source that was already retrieved.

Paid web search is not configured and is not called. `RESEARCH_SEARCH_BASE` is not read. The saved-note Agent is not used. If `RESEARCH_MODEL` and `RESEARCH_MODEL_BASE_URL` are both set, the capabilities page says a model is configured. This version still does not call it. If `RESEARCH_PYTHON` cannot be started, that run fails and says so.

## Components

| Piece | Role | In this change |
| --- | --- | --- |
| React (`web/src/app/research.jsx`) | Browse, import, review, run, accept, export | Follow-up pull request. Not deployed. |
| Fastify (`src/research.js`) | Auth, workspace scope, allowlist, persistence | Follow-up pull request. Not deployed. |
| Postgres (`migrations/017_research.sql`) | Application records | In this pull request. Not applied to a database yet. |
| Python worker (`services/research`) | Public HTTPS retrieval | In this pull request. No database credentials. Not deployed. |
| Rust ingest | File upload | Unchanged. Page fetch does not go through it. |
| Provena memory | Saved notes | Unchanged. |
| Python runner | Train, evaluate, export jobs | Unchanged. Research is not a train job. |

## Configuration

| Variable | Effect |
| --- | --- |
| `RESEARCH_PYTHON` | Executable used to spawn the worker. Default `python`. |
| `RESEARCH_MODEL` | Optional. Not called by this version. |
| `RESEARCH_MODEL_BASE_URL` | Optional. Both this and `RESEARCH_MODEL` must be set before the capability is reported as configured. |

## Local catalog import

Dry run, no database write, after the safety checks:

```powershell
node scripts/research-bootstrap.js --environment local --workspace <uuid>
```

`--apply` creates a collection project when `--project` is omitted and imports the catalog. It refuses `NODE_ENV=production`, a non-loopback database host, and a database name that does not contain `test`. `--retrieve` is refused. Do not point it at production.

## Checked locally

This pull request is the schema, planner, both stores, the 62-row catalog, the dry-run bootstrap script, and the Python worker. The size gate counts every unmerged line against `master` and blocks a push over 2,000 lines, so the Fastify routes, reviewer allowlist, and Research screens are a follow-up branch and are not in this pull request.

Planner tests cover catalog mapping, citation quotes, prospect curation, source upgrade, and CSV formula escaping. Python unit tests cover private and shared-address refusal, TLS verification staying on, and named URLs staying ahead of Wikimedia. They do not contact the network. Migration 017 has not been applied to a database. This is not deployed.

## Reviewer sessions

The synthetic-workspace flag stays on. Research POST routes are named one by one on the reviewer allowlist. Reviewers still cannot manage the team, link machines, run jobs, approve plans, send Capital, or change account settings.
