# YC / Speedrun demo runbook

A repeatable 6–8 minute walkthrough on a clearly labelled synthetic workspace. Everything shown in part one executes. Part two trains a model on a GPU machine, checks it on a held-out split and exports it, using the merged Valcairn Runner 0.4.0 (`services/runner`) with its training and export handlers; hosted GPU scheduling, cloud deployment and financing are labelled as planned.

YC and Speedrun reviewers can use their existing usernames and passwords at either `/demo` or the **Email or username** form at `/signin`. Both send reviewer usernames to the same `/api/login` verifier, rate limit and session mapping; no password is copied or reset. Ordinary email accounts still use their existing account sign-in service. With `DEMO_REVIEWER_USERS_FILE` configured, `ycinsider` and `sr008-reviewer` open the normal workspace home of their own demonstration organizations (see [Reviewer workspace entry](#reviewer-workspace-entry)). Returning to `/demo` or an old `/demo/review` bookmark also resolves them into that shared product. The unmapped `admin` reviewer retains the operator audit overview and sign-in log at `/demo/review`; an unmapped external reviewer receives an explicit unavailable answer, never another organization.

## One product, specialized records

Normal accounts and YC/Speedrun reviewers use the **same workspace routes, shell, navigation, components, forms, APIs and persistence**, not a separate lite dashboard. Within its pinned organization, each dedicated reviewer owner can use every implemented normal owner workflow: datasets and reviews, evaluation, Research, model plans and approval, local devices/Memory/Agents, Team, runners/jobs and Capital records/internal submissions. Server role, validation, freeze and ownership rules still apply. Account-global changes, creating/switching organizations, staff authority and other workspaces remain outside the reviewer grant.

Only their organizations and records are specialized: YC and a16z Speedrun can have curated real public-source collections, labelled samples and genuinely recorded experiments. Do not manufacture dataset approvals, run results, benchmarks, credits, funding or progress for the presentation. A public-source field is not freshly retrieved unless it actually was; a stored experiment must retain its real evidence and limitations. The synthetic organization flag discloses a demonstration relationship, not that every record is generated data.

Feature access is not a claim that prerequisites exist. A local model/gateway needs the visitor's own runtime, scoped credentials and hardware; a runner job needs an actually linked compatible machine, approved plan and data rights. No operator token is shared. Capital records are claims/plans and internal review, not funded balances or lender approval. This release does not add research LLM synthesis, paid search or hosted GPU scheduling.

## Before the demo (once)

1. Postgres running and migrated (`npm run db:migrate`). Ingest running (see `services/ingest/README.md`). Web running with `INGEST_*` set.
2. Seed the synthetic workspace and files:
   ```bash
   node --env-file-if-exists=.env scripts/seed-demo.js
   ```
   This prints the demo owner and staff-reviewer passwords once; keep them outside Git. It also writes synthetic files to `.local/demo-files/`: 6 box images, `labels.csv` and `line2-box-001-copy.png`, an exact copy for the duplicate check.
3. **Give the demo reviewer scoped access, never global:** set `DEMO_WORKSPACE_ID` to the workspace id the seed printed and add `demo.reviewer@valcairn.example` to `DEMO_STAFF_EMAILS`, then restart web. That account can then open `/staff` and `/staff/capital` for this one workspace only, and only while the workspace exists with `profile.synthetic = true`, which the server re-checks on every request; it never sees another workspace's reviews, files or Capital submissions. Do not add it to `STAFF_EMAILS`: that is global staff authority over every workspace on the server, the server refuses an address that is on both lists, and a production demonstration must use either this scoped pair or an existing approved staff account.
4. Use two browser profiles: profile A for the demo owner, profile B for the staff reviewer. Staff approval is separate from the external YC/Speedrun reviewer owners; they use the normal workspace and do not become staff or decide their own reviews.

## The walkthrough

| # | Say | Do (profile A, `demo.owner@northwind-demo.example`) |
| --- | --- | --- |
| 1 | "A company describes the job, not our product menu." | `/w/northwind-demo` → **Start your first project**. Task: *Flag damaged boxes on packing line 2 from the overhead camera.* Inputs: **Images**. Start: **We have our own data**. |
| 2 | "They set the bar before any training." | Measure **recall**, target **95%**, compared with **how you do it today**. Point at the acceptance-rule sentence. |
| 3 | "Rights come with the data." | Data → **We collected it ourselves**, uses **training + testing**, personal data **Not sure**. |
| 4 | "Files go straight to our Rust ingest service: checked, hashed, stored privately." | **Open dataset** → **Import data**, drop all 8 files from `.local/demo-files/`. Each row shows the type read from its bytes; the copy is stored as a duplicate. **Dataset** shows the composition bar and real previews. |
| 5 | "Labels are part of what gets reviewed." | **Annotate** → add labels *damaged* and *ok* (whole file) and *tear* (box on image). Tag a few images and drag a *tear* box on one. |
| 6 | "Nothing goes to review with open questions." | **Resolve**: the duplicate and unlabelled images are listed. Remove the copy, note why the rest stay, then **Send snapshot for review**. Everything locks. |
| 7 | "Review is independent, and sees exactly what was sent." | Profile B, `demo.reviewer@valcairn.example` → `/staff` → open the review: frozen label set, labels and boxes on the previews, the notes, working **Download**. Note *Personal data: Not sure* → **Request changes**: *Confirm whether workers appear in frame.* |
| 8 | "The customer fixes it; nothing changes silently." | Profile A sees the reviewer notes. Set personal data to **No**, resend from **Resolve**. Profile B ticks all five checks → **Approve**. |
| 9 | "Version 1 is the exact reviewed files, labels and rights." | Profile A → **Approve version 1**. **Versions** shows v1, its manifest and per-file downloads that keep working after **Reopen**, which voids approval for future versions. |
| 10 | "Training and a held-out check run on their own machine next; deployment is planned." | Part two shows training and export on a linked runner. Point at the **Planned** labels on hosted GPUs, deployment and financing; say plainly that those do not run. |

## Part two: train on your own machine, evaluate and run it locally (about 5 minutes)

This part needs a machine with an NVIDIA GPU, Docker with GPU support, Ollama and Python 3.11, and the Valcairn Runner 0.4.0 (`services/runner`), whose training and export handlers are merged. The runner's `evaluate` job kind is still unsupported and ends as `unsupported`; the held-out numbers below come from the training job itself, and scoring imported answers against a frozen set is the separate Evaluate page. Training a small model on a few hundred short synthetic conversations takes about a minute on one recent GPU. The data may be the seeded fixture below or a fresh upload approved through the part-one review; either way, every figure you say comes from the job and report on screen.

### Before the demo (once)

1. Start web with `MODEL_CATALOG_FILE=docs/model-catalog.demo.json` (one small Apache-2.0 model). Start ingest with file storage, for example `INGEST_STORAGE=file:///…/.local/objects`.
2. Seed a training-ready synthetic workspace, using the same storage directory:
   ```bash
   DATABASE_URL=postgresql://<user>@127.0.0.1:5432/valcairn_demo node scripts/seed-train-demo.js --model qwen3-0.6b --objects .local/objects --disposable-db
   ```
   It writes only to a disposable local database: `DATABASE_URL` must be set (it never falls back to the in-memory store), point at this machine and name a database containing `demo`, `test` or `qa`, carry no `?options` or `#fragment` (the driver would read `?host=`, `?port=` or `?user=` over the authority, so the seed accepts only `user:password@host:port/name`), `NODE_PG_FORCE_NATIVE` must be unset (the checks are written for the pure-JS driver, not the native backend it selects), and `--disposable-db` confirms it. It refuses before writing anything otherwise. **Its dataset review is a synthetic fixture:** the approval, with every check ticked, is written by the seed script under a synthetic staff account, and no person reviewed anything. Never present that approval as a human review or as evidence that the review screens were exercised; to show the review itself, upload through Import, resolve, and have the separate staff account decide, as in part one. It prints the workspace path and the demo owner's password once. It writes `acme-support.synthetic.jsonl`, generated support conversations for three fictional robots (the file's row count is a property of the fixture, not a figure to present), recorded as dataset version 1 with a rights record that allows training. It also creates an enhance plan approved for **Your Valcairn Runner**.
3. On the GPU machine, in `services/runner`: `docker build -t valcairn-train:0.4.0 images/train` (the tag the runner expects; an older `valcairn-train:0.1` is never used and applies older rules, see `services/runner/README.md`) and `docker pull ghcr.io/ggml-org/llama.cpp@sha256:e414b8b4a5b8618b13292095cde7bd6520b01124c6d1c3b800c4b0382a2851cb`.
4. Rehearse once. The first training run fetches the base weights (about 1.5 GB), and the first export converts the base model. Both are cached for the live run.

### The walkthrough

| # | Say | Do |
| --- | --- | --- |
| 1 | "Their machine, their GPU. We never connect to it; it calls us." | `/w/<slug>/compute` → **Link a machine**, name it, **Link and show key**. Save the key to a file and start the runner with the command shown. The runner turns **Online** and lists the GPU, Docker with GPU support and the local Ollama models. |
| 2 | "Every job runs in a sandbox with no network." | **Run sandbox check**. Open **Details**: it ran with network `none` and read the GPU from inside the container. |
| 3 | "This plan was approved, with its data rights, before anything ran." | **Approved plans for your runner** → **Start training on …**. The timeline shows the dataset downloaded and checked against its version hash, then training, with the loss curve filling in. |
| 4 | "We hold out examples it never sees, and compare with the unchanged base model." | When it finishes, point at **Held-out loss** and **Held-out answers** for base against tuned, then at the held-out examples. Say only what this job recorded: its `trainExamples` and `heldOutExamples`, the group counts if the runner recorded them (the split is grouped and varies by data, so it is not a fixed number), and the scoring denominator (`n`) of that job or of the approved report you show. Figures from earlier rehearsals, the fixture's row count and any pre-written result are not results and must not be quoted. Whatever the numbers are, they show adaptation to a narrow synthetic task of closely related conversations, not general model quality. If the review that froze the data was the seed's fixture rather than a person's decision, say so here too. |
| 5 | "It ships as a file they own, running locally." | **Export to Ollama on this runner**. When it finishes: the Ollama model name, the GGUF hash and size, and the speed of tuned against base. On the runner machine, `ollama run valcairn-<id>` answers in the support team's format. |

Say plainly what is not shown: multi-GPU training runs through `accelerate` but was only exercised on one GPU; preference tuning and reinforcement learning steps are skipped; re-evaluating a finished run later is planned.

### If something fails live

- **The runner stays Waiting:** the key file or `VALCAIRN_URL` is wrong. The runner logs `Valcairn refused this runner` for a bad or revoked key.
- **Training fails with `sandbox_unavailable`:** Docker is not running, or GPU support in Docker is off (`docker run --rm --gpus all ubuntu:24.04 nvidia-smi` should list the GPU).
- **`dataset_error`:** the seeded file is not in the ingest storage directory. Seed again with the same `--objects` path that ingest uses.

## Reviewer overview

`/demo/review` is now the **admin audit view**, not the workspace product for mapped YC/Speedrun reviewers. A current mapped reviewer is redirected to its normal `/w/<slug>` home; if the entry marker is absent, only the existing same-origin `POST /api/demo/enter` may establish it after server validation. A GET, username, bookmark or client-provided workspace id is never entry authority. A normal workspace-account session is not overwritten by this bridge; use separate browser profiles or explicitly sign out when changing identities.

The unmapped `admin` reviewer retains the read-only operator overview from `GET /api/demo/overview` and its admin-only sign-in log. That overview projects actual records of the synthetic organization pinned by `DEMO_WORKSPACE_ID`: dataset projects/reviews/versions, runner-reported jobs, approved imported-answer evaluation reports and Capital statuses. It is an audit projection, not a second version of the product. It never provides sample fallback figures, private prompts/answers/evidence text, object keys, download links or runner credentials. An unavailable pin is an unavailable answer. The API continues to scope a mapped reviewer to its own organization if called; it never falls back to the operator or another reviewer's organization.

A seed fixture still appears as what the store recorded. Its approval was written by the seed, not by a human; state that explicitly. Use the shared workspace pages to show actual editing, review, evaluation, research and recorded execution workflows.

## Reviewer workspace entry

With `DEMO_REVIEWER_USERS_FILE` set, each mapped reviewer who signs in at `/demo` lands on the normal `/w/<slug>` home of **its own demonstration organization**, working as the **dedicated demo owner** that root provisions for that reviewer: `sr008-reviewer` opens the organization named exactly **a16z Speedrun** as its owner "a16z Speedrun"; `ycinsider` opens the organization named exactly **YC** as its owner "YC". The names are what the reviewer asked to see. A compact, expandable "Data and execution" note explains review context without implying affiliation or endorsement; it preserves sample labels, runtime prerequisites and unavailable-service limits. The two organizations are isolated from each other and from the operator's `DEMO_WORKSPACE_ID` workspace, whose records and frozen history are never reparented or shown to them. There is no mapped-reviewer overview link or alternate sidebar: the same Research, Projects, Models, Device, Memory, Agents, Compute, Capital and Team components are used as for normal accounts. An old overview bookmark resolves to the shared workspace home.

What the server enforces (src/lib/demo-access.js), on every request, with no cached grant:

- The reviewer is signed in and still enabled; its entry names this exact username; the session marker names this reviewer and the entry's workspace and user; the entry's organization exists with `profile.synthetic = true` strictly; the mapped user exists, has a confirmed email, is currently an `owner` of that organization, and has no `STAFF_EMAILS` or `DEMO_STAFF_EMAILS` scope. Any miss ends the entry (401) on the next request, and the overview answers unavailable rather than showing any other workspace.
- Reads: `/api/account` (projection: that organization only, no other memberships, join requests, domain match or staff flags), `/api/local-models`, `/api/local-memory`, `/api/models/catalog`, and every workspace route of that organization. The workspace path is pinned: a foreign workspace path returns 404, including the other reviewer's organization and the operator workspace. Query, body or header hints cannot redirect that scope; an ignored foreign hint does not make an otherwise valid pinned request fail.
- Writes: the explicit finite allowlist covers every currently implemented normal owner action **within that organization**: project/dataset/annotation/review submissions and versions; evaluation sets/imports/decisions; Research project/import/list/checklist/run/candidate/correction actions; model pulls, enhance drafts and cap approval; the identity's local-device reports/installs/runs; invitations and join-request decisions; runner registration/revocation and job queue/cancel; Capital draft/evidence/credit records and consent-bound send/withdraw. The route registry and normal role/validation/freeze checks remain authoritative; this is not a wildcard grant to future routes.
- Refused for reviewers (403 `demo_access_denied`): account sign-up, verification/profile changes, creating organizations or personal workspaces, global discovery/domain matching/join flows, academic identity send/verify and every staff route. Other workspace ids remain 404. Staff approval is independent, and a runner bearer key is obtained only through actual authorized linking, never shared from the operator. Reviewer sign-out ends the reviewer session and entry together and forgets local-memory keys in the tab.
- **Runner credentials have a separate lifecycle.** An issued runner bearer key follows the normal runner revocation and creator-membership rules. Reviewer logout, disablement or mapping removal ends reviewer-cookie access; it does not by itself revoke an already issued runner key while its creator remains an owner/admin of that workspace. Revoke the runner or remove its creator's qualifying workspace membership to end that key. This is not permission to share an operator credential.
- UI restrictions follow the normal workspace role and feature prerequisites, not a `demoAccess` read-only substitute. The organization switch stays pinned; no account-global authority is implied. Memory/Device/Agents remain disconnected until the reviewer connects their own real runtime or gateway. Recorded runs, empty states and failures stay truthful.


Operator setup (root), once per environment:

1. Create two normal accounts with confirmed emails on labelled `.invalid` addresses, display names exactly `YC` and `a16z Speedrun`, with generated passwords that are never handed to reviewers. Create two organizations named exactly `YC` and `a16z Speedrun` with `profile.synthetic = true`, each owned by its account and holding no other member. Never reuse the demo owner, a staff account, an existing customer or the operator workspace.
2. Note each account's user id and each organization's id and write the JSON file in the shape of `docs/examples/demo-reviewer-users.example.json`, one entry per reviewer. The file holds ids only.
3. Mount it read-only, set `DEMO_REVIEWER_USERS_FILE`, restart web. Startup refuses a malformed file, an unknown field, a repeated username, user id or workspace id, or an entry naming the `DEMO_WORKSPACE_ID` workspace. `DEMO_WORKSPACE_ID` and `DEMO_STAFF_EMAILS` keep their meaning for the operator workspace and are not widened to the new organizations; staff review of those needs its own separately granted path.
4. Reviewers keep their existing `/demo` usernames and passwords; nothing about `reviewer_accounts` changes. The `admin` reviewer is mapped only if you add it; unmapped, it keeps the operator overview and the admin-only sign-in log.

## Reset between runs

Use a fresh project each time: projects are cheap, and old ones stay as history. To start completely clean on a local database only:

```bash
docker compose -f docker-compose.postgres.yml down -v && docker compose -f docker-compose.postgres.yml up -d --wait
npm run db:migrate && node --env-file-if-exists=.env scripts/seed-demo.js
```

That deletes all local data, including local reviewer accounts. Re-provision them with `scripts/reviewers.js`.

## If something fails live

- **Upload says the service could not be reached:** ingest isn't running, or `INGEST_PUBLIC_URL`/CORS is wrong. Check `curl <ingest>/healthz`.
- **`/staff` returns to Start:** the demo reviewer's email isn't in `DEMO_STAFF_EMAILS` with `DEMO_WORKSPACE_ID` set to this workspace (see step 3 of "Before the demo"), the workspace is no longer marked synthetic, the email isn't confirmed, or the web server wasn't restarted after the change. Do not edit `STAFF_EMAILS` for a demo.
- **The reviewer can't decide:** reviewers cannot decide on a workspace they belong to. Use the separate staff account.
