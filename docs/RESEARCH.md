# Research persistence and evidence

This change adds workspace-scoped Research storage, a shared import planner, the existing 62-company Frontier AI labs catalog, and release/restore safeguards. Research projects remain separate from dataset projects and never become approved training data merely by being imported.

## Current scope

- Migration 017 stores projects, immutable source snapshots, entities, claims, relationships, directory membership, lists, runs, events, revisions and duplicate candidates.
- The memory and PostgreSQL stores share validation and import planning. Source identity includes its exact snapshot; a later retrieval cannot rewrite an older claim's evidence. Claims retain their source id, hash and retrieval date.
- Project changes accept only submitted editable fields. Checklist booleans merge atomically. Project quality counts only its own evidence; filtered/list exports keep the correct directory labels.
- Completed runs require a running predecessor and a stored report with citations. Failed/cancelled states carry no output. Cancellation wins over late completion. This storage contract does not claim a worker ran simply because a caller created a row.
- The catalog's fields remain extracted claims from an existing file, not independently retrieved or verified facts. There is no sourced investor catalog; no people, investors or prospects are invented. Prospects require human curation.

## Release and verification

The controller registers all 12 Research tables for ledger-aware presence, fingerprinted normal backup/restore and exact application grants. Research events use PostgreSQL identity generation: implicit inserts need no direct sequence privileges, so direct sequence access stays denied. Existing serial job-event privileges remain unchanged.

The historical migration-016 recovery proof is bounded through 016. A separate populated latest-schema test verifies normal dump/restore of Capital, Evaluation and every Research table, including exact source versions and event identity continuity. The 51-table fingerprint builders use aggregation rather than exceeding PostgreSQL's function-argument limit.

Shared memory/PostgreSQL tests cover scope, provenance, dates, partial updates, list inspection/export, terminal states and rejected proposed completion. Tests use only fresh local databases with test names.

## Follow-up units

The public HTTPS worker, local-only catalog bootstrap CLI, runtime Python packaging, Fastify routes and React Research screens are coherent follow-up changes. None is registered or callable in this storage-only unit. The final worker will receive neither database nor mail credentials. Paid search, model extraction and the saved-note Agent are outside this implementation; no run or factual correctness is implied by storage availability.

Merging source is not a deployment claim. Before migration 017 rollout, install the matching reviewed release controller through the approved runbook, verify current production prerequisites and a fresh normal backup/scratch restore, then test the exact deployed revision. Existing reviewer identities, passwords, customer records, configuration and protected history must be preserved.
