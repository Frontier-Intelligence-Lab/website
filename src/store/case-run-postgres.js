import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';
import { MAX_ATTEMPTS, stableJson } from '../lib/jobs.js';
import { RECIPE_ID, acceptBatch, decideRun, listRunView, presentRun, runnerFresh, unscoredRun, validateCandidate } from '../lib/case-run.js';

const invalid = (message) => new StoreError('invalid_state', message);
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;
const HELD = ['leased', 'running', 'cancel_requested'];
const FINISHED = ['succeeded', 'failed', 'cancelled'];

/**
 * Executed case runs for Postgres. The job row and the run row are inserted in one transaction.
 * A score is written only after the run is marked complete, which is the one update the freeze trigger allows.
 */
export function caseRunPostgresMethods({ query, transaction, isId, iso, addAudit }) {
  const runRow = (r) => ({
    id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, versionId: r.version_id, jobId: r.job_id,
    role: r.role, status: r.status, scored: r.scored === true, recipeId: r.recipe_id, recipeVersion: r.recipe_version,
    settings: r.settings, passages: r.passages, runtime: r.runtime, createdBy: r.created_by,
    createdAt: iso(r.created_at), finishedAt: iso(r.finished_at),
  });
  const resultRow = (r) => ({
    caseKey: r.case_key, output: r.output, errorKind: r.error_kind, passages: r.passages, citations: r.citations,
    scores: r.scores, explanation: r.explanation, latencyMs: r.latency_ms,
  });
  const load = async (client, runId) => {
    const run = (await query('SELECT * FROM eval_case_runs WHERE id = $1', [runId], client)).rows[0];
    const rows = (await query('SELECT * FROM eval_case_results WHERE run_id = $1 ORDER BY case_key', [runId], client)).rows.map(resultRow);
    return presentRun(runRow(run), rows);
  };
  const casesOf = async (client, versionId) => {
    const row = (await query('SELECT manifest FROM eval_set_versions WHERE id = $1', [versionId], client)).rows[0];
    return row?.manifest?.cases ?? [];
  };
  const postedMap = (rows) => new Map(rows.map((row) => [row.caseKey, row]));
  const writeRows = async (client, runId, results) => {
    for (const row of results) {
      await query(`INSERT INTO eval_case_results (run_id, case_key, output, error_kind, passages, citations, scores, explanation, latency_ms)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NULL, $7, $8)
        ON CONFLICT (run_id, case_key) DO UPDATE SET output = EXCLUDED.output, error_kind = EXCLUDED.error_kind,
          passages = EXCLUDED.passages, citations = EXCLUDED.citations, explanation = EXCLUDED.explanation,
          latency_ms = EXCLUDED.latency_ms, scores = NULL`,
      [runId, row.caseKey, row.output, row.errorKind, JSON.stringify(row.passages ?? []), JSON.stringify(row.citations ?? []), row.explanation, row.latencyMs], client);
    }
  };

  return {
    async startCaseRun({ workspaceId, projectId, versionId, runnerId, role, candidate, recipeVersion, catalog = [], idempotencyKey, actorId }) {
      if (![workspaceId, projectId, versionId, runnerId, actorId].every(isId)) throw new StoreError('not_found');
      if (!KEY.test(idempotencyKey ?? '')) throw invalid('Send a request key of 8 to 100 letters, digits, dashes or underscores.');
      if (!['baseline', 'candidate'].includes(role)) throw invalid('Mark the run as a baseline or a candidate.');
      if (!VERSION.test(recipeVersion ?? '')) throw invalid('The recipe version is not configured.');
      const checked = validateCandidate({ candidate, catalog });
      if (checked.error) throw invalid(checked.error);
      const spec = { caseEval: { versionId, recipeId: RECIPE_ID, recipeVersion, role, specHash: checked.specHash } };
      return transaction(async (client) => {
        const version = (await query('SELECT project_id FROM eval_set_versions WHERE id = $1 AND workspace_id = $2 FOR SHARE', [versionId, workspaceId], client)).rows[0];
        if (!version || version.project_id !== projectId) throw new StoreError('not_found');
        const runner = (await query('SELECT status, last_seen_at, clock_timestamp() AS observed_at FROM runners WHERE id = $1 AND workspace_id = $2 FOR SHARE', [runnerId, workspaceId], client)).rows[0];
        if (!runner || runner.status !== 'active') throw new StoreError('not_found');
        if (!runnerFresh(iso(runner.last_seen_at), Date.parse(iso(runner.observed_at)))) throw invalid('This runner has not reported in the last minute. Open Compute and confirm it is online.');
        const same = (row) => row.kind === 'case_eval' && row.runner_id === runnerId && row.enhance_run_id == null && stableJson(row.spec) === stableJson(spec);
        const prior = (await query('SELECT * FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, idempotencyKey], client)).rows[0];
        let job = prior;
        if (prior) {
          if (!same(prior)) throw invalid('That request key was already used for a different job.');
        } else {
          job = (await query(`INSERT INTO jobs (workspace_id, runner_id, kind, enhance_run_id, spec, idempotency_key, created_by, max_attempts)
            VALUES ($1, $2, 'case_eval', NULL, $3::jsonb, $4, $5, $6) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
          [workspaceId, runnerId, JSON.stringify(spec), idempotencyKey, actorId, MAX_ATTEMPTS], client)).rows[0];
          if (!job) {
            job = (await query('SELECT * FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, idempotencyKey], client)).rows[0];
            if (!same(job)) throw invalid('That request key was already used for a different job.');
          } else {
            await addAudit(client, { workspaceId, actorId, action: 'job.created', targetType: 'job', targetId: job.id, metadata: { kind: 'case_eval', runnerId } });
          }
        }
        const existing = (await query('SELECT id FROM eval_case_runs WHERE job_id = $1', [job.id], client)).rows[0];
        if (existing) return load(client, existing.id);
        const runId = randomUUID();
        const inserted = (await query(`INSERT INTO eval_case_runs (id, workspace_id, project_id, version_id, job_id, role, status, recipe_id, recipe_version, settings, passages, runtime, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
          ON CONFLICT (job_id) DO NOTHING RETURNING id`,
        [runId, workspaceId, projectId, versionId, job.id, role, RECIPE_ID, recipeVersion, JSON.stringify(checked.settings), JSON.stringify(checked.passages),
          JSON.stringify({ runtime: 'runner-sandbox', recipe: RECIPE_ID, modelId: checked.settings.modelId }), actorId], client)).rows[0];
        const id = inserted?.id ?? (await query('SELECT id FROM eval_case_runs WHERE job_id = $1', [job.id], client)).rows[0].id;
        if (inserted) await addAudit(client, { workspaceId, actorId, action: 'eval_case_run.created', targetType: 'eval_case_run', targetId: id, metadata: { role, versionId, jobId: job.id } });
        return load(client, id);
      });
    },

    async appendCaseResults({ workspaceId, jobId, results: body }) {
      if (!isId(workspaceId) || !isId(jobId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const run = (await query('SELECT * FROM eval_case_runs WHERE workspace_id = $1 AND job_id = $2 FOR UPDATE', [workspaceId, jobId], client)).rows[0];
        if (!run) throw new StoreError('not_found');
        if (run.finished_at) throw invalid('This run has already finished.');
        const job = (await query('SELECT status FROM jobs WHERE id = $1 AND workspace_id = $2', [jobId, workspaceId], client)).rows[0];
        if (!job || !HELD.includes(job.status)) throw invalid('This run is not being executed.');
        const accepted = acceptBatch(body, new Set((await casesOf(client, run.version_id)).map((item) => item.caseKey)));
        if (accepted.error) throw invalid(accepted.error);
        await writeRows(client, run.id, accepted.results.map((row) => ({ ...row, explanation: null })));
        if (run.status === 'queued') await query("UPDATE eval_case_runs SET status = 'running' WHERE id = $1 AND finished_at IS NULL", [run.id], client);
        return load(client, run.id);
      });
    },

    async settleCaseRun({ workspaceId, jobId }) {
      if (!isId(workspaceId) || !isId(jobId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const run = (await query('SELECT * FROM eval_case_runs WHERE workspace_id = $1 AND job_id = $2 FOR UPDATE', [workspaceId, jobId], client)).rows[0];
        if (!run) throw new StoreError('not_found');
        if (run.finished_at) return load(client, run.id);
        const job = (await query('SELECT status FROM jobs WHERE id = $1 AND workspace_id = $2', [jobId, workspaceId], client)).rows[0];
        if (!job || !FINISHED.includes(job.status)) {
          if (job && run.status === 'queued' && HELD.includes(job.status)) await query("UPDATE eval_case_runs SET status = 'running' WHERE id = $1 AND finished_at IS NULL", [run.id], client);
          return load(client, run.id);
        }
        const cases = await casesOf(client, run.version_id);
        const posted = postedMap((await query('SELECT * FROM eval_case_results WHERE run_id = $1', [run.id], client)).rows.map(resultRow));
        const decided = job.status === 'succeeded'
          ? decideRun({ cases, posted, corpus: run.passages })
          : unscoredRun(cases, posted, run.passages, job.status === 'cancelled' ? 'cancelled' : 'failed');
        await writeRows(client, run.id, decided.results.map((row) => ({ ...row, scores: null })));
        if (decided.scored) {
          const marked = (await query("UPDATE eval_case_runs SET status = 'complete', scored = true, finished_at = clock_timestamp() WHERE id = $1 AND finished_at IS NULL RETURNING id", [run.id], client)).rows[0];
          if (!marked) return load(client, run.id);
          for (const row of decided.results) {
            const updated = await query('UPDATE eval_case_results SET scores = $3::jsonb, explanation = $4 WHERE run_id = $1 AND case_key = $2 AND scores IS NULL',
              [run.id, row.caseKey, JSON.stringify(row.scores), row.explanation], client);
            if (!updated.rowCount) throw invalid('A complete run lost a case result.');
          }
        } else {
          await query('UPDATE eval_case_runs SET status = $2, scored = false, finished_at = clock_timestamp() WHERE id = $1 AND finished_at IS NULL', [run.id, decided.status], client);
        }
        return load(client, run.id);
      });
    },

    async caseRunInputs({ workspaceId, jobId }) {
      if (!isId(workspaceId) || !isId(jobId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const run = (await query('SELECT * FROM eval_case_runs WHERE workspace_id = $1 AND job_id = $2 FOR SHARE', [workspaceId, jobId], client)).rows[0];
        if (!run) throw new StoreError('not_found');
        if (run.finished_at) throw invalid('This run has already finished.');
        const cases = await casesOf(client, run.version_id);
        return { cases: cases.map(({ caseKey, input }) => ({ caseKey, input })), passages: run.passages, settings: run.settings, recipeVersion: run.recipe_version };
      });
    },

    async getCaseRun({ workspaceId, projectId, runId }) {
      if (![workspaceId, projectId, runId].every(isId)) return null;
      const row = (await query('SELECT * FROM eval_case_runs WHERE id = $1 AND workspace_id = $2 AND project_id = $3', [runId, workspaceId, projectId])).rows[0];
      if (!row) return null;
      if (!row.finished_at) {
        const job = await this.getJob({ workspaceId, jobId: row.job_id });
        if (job && FINISHED.includes(job.status)) return this.settleCaseRun({ workspaceId, jobId: row.job_id });
      }
      return load(undefined, row.id);
    },

    async listCaseRuns({ workspaceId, projectId, versionId }) {
      if (![workspaceId, projectId, versionId].every(isId)) return [];
      const rows = (await query('SELECT id FROM eval_case_runs WHERE workspace_id = $1 AND project_id = $2 AND version_id = $3 ORDER BY created_at, id', [workspaceId, projectId, versionId])).rows;
      const views = [];
      for (const row of rows) {
        const full = await this.getCaseRun({ workspaceId, projectId, runId: row.id });
        if (!full) continue;
        views.push(listRunView(full));
      }
      return views;
    },
  };
}
