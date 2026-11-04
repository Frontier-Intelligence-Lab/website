# YC / Speedrun demo runbook

A repeatable 6–8 minute walkthrough on a clearly labelled synthetic workspace. Everything shown executes, except training, deployment and financing, which the app labels as planned.

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
