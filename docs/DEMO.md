# YC / Speedrun demo runbook

A repeatable 6–8 minute walkthrough on a clearly labelled synthetic workspace. Everything shown in part one executes. Part two trains, evaluates and exports a model on a GPU machine and needs the runner (merged) and its training and export handlers (PR 16); cloud deployment and financing are labelled as planned.

## Before the demo (once)

1. Postgres running and migrated (`npm run db:migrate`). Ingest running (see `services/ingest/README.md`). Web running with `INGEST_*` set.
2. Seed the synthetic workspace and files:
   ```bash
   node --env-file-if-exists=.env scripts/seed-demo.js
   ```
   This prints the demo owner and staff-reviewer passwords once; keep them outside Git. Add `demo.reviewer@valcairn.example` to `STAFF_EMAILS` and restart web. It also writes synthetic files to `.local/demo-files/`: 6 box images, `labels.csv` and `line2-box-001-copy.png`, an exact copy for the duplicate check.
3. Use two browser profiles: profile A for the demo owner, profile B for the staff reviewer. Staff approval is separate from the external YC/Speedrun reviewer accounts, which only see `/demo`.

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
| 10 | "Training, evaluation and deployment are next." | Point at the **Planned** labels. Nothing runs yet; say so. |

## Part two: train on your own machine, evaluate and run it locally (about 5 minutes)

This part needs a machine with an NVIDIA GPU, Docker with GPU support, Ollama and Python 3.11, and the Valcairn Runner and its training and export handlers (`services/runner`; the training and export handlers are PR 16). Until PR 16 is merged, training and export jobs end as `unsupported`. Training a small model on the 252 synthetic conversations takes about a minute on one recent GPU.

### Before the demo (once)

1. Start web with `MODEL_CATALOG_FILE=docs/model-catalog.demo.json` (one small Apache-2.0 model). Start ingest with file storage, for example `INGEST_STORAGE=file:///…/.local/objects`.
2. Seed a training-ready synthetic workspace, using the same storage directory:
   ```bash
   DATABASE_URL=postgresql://<user>@127.0.0.1:5432/valcairn_demo node scripts/seed-train-demo.js --model qwen3-0.6b --objects .local/objects --disposable-db
   ```
   It writes only to a disposable local database: `DATABASE_URL` must be set (it never falls back to the in-memory store), point at this machine and name a database containing `demo`, `test` or `qa`, carry no `?options` or `#fragment` (the driver would read `?host=`, `?port=` or `?user=` over the authority, so the seed accepts only `user:password@host:port/name`), `NODE_PG_FORCE_NATIVE` must be unset (the checks are written for the pure-JS driver, not the native backend it selects), and `--disposable-db` confirms it. It refuses before writing anything otherwise. Its dataset review is a synthetic fixture, recorded as approved by the seed script and not by a person. It prints the workspace path and the demo owner's password once. It writes `acme-support.synthetic.jsonl`: 252 support conversations for three fictional robots, approved as dataset version 1 with a rights record that allows training. It also creates an enhance plan approved for **Your Valcairn Runner**.
3. On the GPU machine, in `services/runner`: `docker build -t valcairn-train:0.1 images/train` and `docker pull ghcr.io/ggml-org/llama.cpp@sha256:e414b8b4a5b8618b13292095cde7bd6520b01124c6d1c3b800c4b0382a2851cb`.
4. Rehearse once. The first training run fetches the base weights (about 1.5 GB), and the first export converts the base model. Both are cached for the live run.

### The walkthrough

| # | Say | Do |
| --- | --- | --- |
| 1 | "Their machine, their GPU. We never connect to it; it calls us." | `/w/<slug>/compute` → **Link a machine**, name it, **Link and show key**. Save the key to a file and start the runner with the command shown. The runner turns **Online** and lists the GPU, Docker with GPU support and the local Ollama models. |
| 2 | "Every job runs in a sandbox with no network." | **Run sandbox check**. Open **Details**: it ran with network `none` and read the GPU from inside the container. |
| 3 | "This plan was approved, with its data rights, before anything ran." | **Approved plans for your runner** → **Start training on …**. The timeline shows the dataset downloaded and checked against its version hash, then training, with the loss curve filling in. |
| 4 | "We hold out examples it never sees, and compare with the unchanged base model." | When it finishes, point at **Held-out loss** and **Held-out answers** for base against tuned, then at the two held-out examples. In our rehearsal: loss 4.47 → 0.08 and token F1 21.7% → 99.1% on 24 held-out examples; the base model invented a 12-month warranty where the true answer is 36 months. Read out your own run's numbers, not these. They show adaptation to this narrow synthetic task (252 closely related conversations, 24 withheld), not general model quality. |
| 5 | "It ships as a file they own, running locally." | **Export to Ollama on this runner**. When it finishes: the Ollama model name, the GGUF hash and size, and the speed of tuned against base. On the runner machine, `ollama run valcairn-<id>` answers in the support team's format. |

Say plainly what is not shown: multi-GPU training runs through `accelerate` but was only exercised on one GPU; preference tuning and reinforcement learning steps are skipped; re-evaluating a finished run later is planned.

### If something fails live

- **The runner stays Waiting:** the key file or `VALCAIRN_URL` is wrong. The runner logs `Valcairn refused this runner` for a bad or revoked key.
- **Training fails with `sandbox_unavailable`:** Docker is not running, or GPU support in Docker is off (`docker run --rm --gpus all ubuntu:24.04 nvidia-smi` should list the GPU).
- **`dataset_error`:** the seeded file is not in the ingest storage directory. Seed again with the same `--objects` path that ingest uses.

## Reset between runs

Use a fresh project each time: projects are cheap, and old ones stay as history. To start completely clean on a local database only:

```bash
docker compose -f docker-compose.postgres.yml down -v && docker compose -f docker-compose.postgres.yml up -d --wait
npm run db:migrate && node --env-file-if-exists=.env scripts/seed-demo.js
```

That deletes all local data, including local reviewer accounts. Re-provision them with `scripts/reviewers.js`.

## If something fails live

- **Upload says the service could not be reached:** ingest isn't running, or `INGEST_PUBLIC_URL`/CORS is wrong. Check `curl <ingest>/healthz`.
- **`/staff` returns to Start:** the reviewer's email isn't in `STAFF_EMAILS`, or the web server wasn't restarted after adding it.
- **The reviewer can't decide:** reviewers cannot decide on a workspace they belong to. Use the separate staff account.
