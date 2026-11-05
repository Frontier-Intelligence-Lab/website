# Evaluation of imported answers

A team that already has a support or document assistant can see which answers fail, tie each failure to the source version they cited, correct the case or the source, and check the next imported answers against a rule they approved.

Training is not part of this loop. A failure may need a better document, a retrieval change, a prompt change, or an abstention. Valcairn does not call a model, run an uploaded scorer, or start a job from these pages.

The labels `development` and `final_assessment` say how the team uses the set. Neither label means the set is secret, leakage-free, or representative of later traffic.

## What a case is

A case belongs to one project. It has a stable id, the question, either an expected answer or written review criteria (or both), optional category and severity (`critical`, `major`, `minor`), and references to frozen dataset versions. A reference is `{ projectId, versionId, fileId }` with `fileId` optional. It must name a version in the same workspace. The version’s frozen rights must include `testing`. The live files of a project are not a source.

Draft cases can be edited. Freezing copies them into an immutable version. Reopening the set starts a new draft and leaves that version, its imports, and its reports unchanged.

## JSONL import

Send UTF-8 JSONL as the string field `jsonl` on the JSON body. The body limit is 300 KiB. The text itself must be at most 256 KiB, each line at most 16 KiB, and the file at most 200 rows. The whole file is checked before anything is written. A bad line, a repeated id, or a row that would pass 200 cases rejects the import and leaves the set as it was.

Case row:

```json
{"id":"case-returns-window","input":"How long does a customer have to return an unopened synthetic demo kettle?","expectedAnswer":"30 days from delivery","reviewCriteria":"Name the 30-day window and that it starts at delivery.","category":"returns","severity":"critical","sources":[{"projectId":"…","versionId":"…","fileId":"…"}]}
```

`expectedAnswer`, `reviewCriteria`, `category`, `severity`, and `fileId` may be null. One of `expectedAnswer` or `reviewCriteria` is still required before the set can freeze.

Prediction row, for one frozen evaluation version:

```json
{"id":"case-returns-window","status":"answered","output":"You can return an unopened kettle within 30 days of delivery."}
```

`status` is `answered`, `abstained`, or `error`. An answered row needs non-empty `output` and no `error`. An error row needs an error code such as `timeout` and must not also include answer text. An abstained row is the same, without an error code. Empty answer text is not stored as a successful answer. A row that is both an error and an answer is rejected, not trimmed. Unknown ids and repeated ids reject the file. Ids that are simply absent stay missing in the comparison; the import does not have to cover every case.

`docs/examples/eval-cases.example.jsonl` and `docs/examples/eval-predictions.example.jsonl` are synthetic. The source ids in the case file are placeholders (`00000000-0000-4000-8000-000000000001` and the two ids after it). Importing that file unchanged fails the source check on purpose. Replace them with a frozen version from your workspace that allows testing. The prediction file matches those three case ids and includes one wrong answer and one run error so the sample is not a model improvement.

## Normalization

Exact comparison and duplicate detection use one rule, in order: Unicode NFKC, trim, collapse every whitespace run to a single space, drop one pair of straight quotes when they wrap the whole value, then `toLowerCase`. This is not semantic equivalence. Token overlap (Jaccard on those tokens) is shown as a diagnostic and never decides pass or fail. The scorer id is `normalized-exact-v1`.

Same-context means that normalized question text. A shared source file with a different question is not treated as a conflict.

## Quality findings

Findings point at the case and a repair. Nothing is rewritten or deleted for you.

- Missing id, question, or a field of the wrong type is rejected at import.
- A repeated case id is rejected.
- The same normalized question and the same normalized expected answer (including both empty) is a blocking duplicate. Delete or edit one case.
- A cited version that is missing, outside the workspace, not allowed for testing, or whose file id is not in that version is blocking.
- A case with neither an expected answer nor review criteria is blocking.
- The same normalized question with different expected answers is a suspected conflict. It stays blocking until a person writes a note. The note is bound to the cases it was written for: editing a member case’s expected answer, review criteria or source references, or adding or removing a member, reopens the conflict for a fresh note. Earlier notes stay on record. The note does not mean either answer was proven wrong.
- A conflict does not hide duplicates. When a question has several expected answers, each group of cases that shares one of those answers is still reported as a duplicate and cannot be acknowledged.
- Category and severity are counted. They are the customer’s labels.

Semantic near-duplicates, automatic checks that a document is true, a guarantee that personal data is gone, and proof that the set covers future questions are planned. They are not offered as actions.

## Acceptance rule

The rule is a JSON object, version 1. The project’s `success` text is not executed.

- `scoreBasis`: `human_else_auto` (default), `human_only`, or `auto_exact`.
- `minPassRate` and `minCoverage`: numbers from 0 to 1, at most four decimal places.
- `criticalMustPass`, `requireHumanOnCritical`, `requireHumanOnDisagreement` (default true), `requireHumanWhenNoExpectedAnswer` (default true).

Every rate uses the eligible case count, which is every case in the frozen set. Missing, errored, abstained, and unreviewed cases stay in the denominator. Coverage below the rule, a required human decision that is missing, or an unresolved disagreement produces `insufficient_evidence`. A critical case whose outcome is fail, error, or abstained fails the rule when critical cases must pass. A critical case that is missing, unreviewed, disagreed, or insufficient is insufficient evidence, not a proven wrong answer. An error is a run failure (`exact: null`), not a wrong answer. An abstention is an explicit non-answer.

A Wilson 95% interval is included only for cases whose outcome is a decisive pass or fail, and only when at least two such cases exist. It assumes independent Bernoulli trials on those cases. It is not a forecast of future traffic, and it does not decide pass or fail.

## Imports are claims

A prediction batch records the frozen version, the baseline or candidate label, the system name and configuration the customer typed, the scorer version they claimed, the rubric version on the frozen set, who imported it, and when. A repeated import with the same label and the same content returns the original batch. The same label with different content is rejected. The batch does not prove which model ran, or its latency, cost, configuration, or training-data separation.

## Review and reports

Automatic and human results are stored separately. A disagreement stays a disagreement until the reviewer adjudicates `human` or `automatic`. Adjudication is refused when the two sides do not disagree, and `automatic` is refused unless the exact match is a pass or a fail.

Hiding identities shows Left and Right, drops the system names, and can randomize which side is which. The saved assignment is what the report uses. The review response does not reveal that assignment. The approval preview, which only an owner or admin can open, shows the names and the content hash of the decision they are about to freeze.

Approving binds that comparison revision and that hash. A stale tab, or a hash that no longer matches, is refused. Repeating the same revision and hash returns the same report. An approved report cannot be edited or deleted. A correction is a new comparison revision, or a new evaluation-set version, and a new report.

The JSON download is `{ schema, reportId, contentHash, approvedBy: { id, name }, approvedAt, snapshot }`. The hash is of `snapshot` only. The report is not a certification and does not say the assistant is safe for production.

## Who can do what

| Action | Owner | Admin | Member | Finance | Viewer | Staff without membership |
| --- | --- | --- | --- | --- | --- | --- |
| Read sets, quality, comparisons, reports, export | yes | yes | yes | yes | yes | 404 |
| Create and edit drafts, import, review | yes | yes | yes | no | no | 404 |
| Freeze a set, open the approval preview, approve a report | yes | yes | no | no | no | 404 |

A person who is not a member of the workspace gets 404 on every evaluation route. Finance and viewer never gain write access.

## Database

`migrations/015_evaluation.sql` creates the evaluation tables. It does not read or write the jobs tables. `014_jobs.sql` (Runners and jobs) is part of this source and independent of it: 014 sorts first, 015 still applies, and a database that has only one of the two applies the other later as a new file. Do not edit a migration that has already been applied.

Frozen version rows, batches, predictions, and reports reject `UPDATE` and `DELETE` in Postgres, including direct SQL. Case rows and issue notes reject writes while the set is frozen, and accept them again after it is reopened. Deleting a workspace that still has a frozen evaluation version fails, because those child rows cannot be deleted. Tests clear tables with `TRUNCATE`, which does not run those delete triggers. Do not add a bypass so a workspace can be deleted through the frozen rows.

No new environment variable is required. Apply 015 before serving a web build that shows Evaluate. The application role gets exactly the least-privilege statements listed in `docs/RELEASE.md` (the release helper grants those and refuses anything broader; `eval_set_versions` needs `UPDATE` only for the row lock that imports and comparisons take). The triggers, not the grants, stop frozen writes.
