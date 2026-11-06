import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';
import { RECIPE_ID, acceptBatch, decideRun, presentRun, runnerFresh, unscoredRun, validateCandidate } from '../lib/case-run.js';

const invalid = (message) => new StoreError('invalid_state', message);
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;

/**
 * Executed case runs for the in-memory store. One run is one case_eval job.
 * A score is stored only when the run is complete.
 */
export function caseRunMemoryMethods({ stamp, copy, audit }) {
  const runs = [];
  const results = [];
  const tails = new Map();
  const locked = async (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tails.set(key, gate);
    await prev.catch(() => {});
    try { return await fn(); }
    finally { release(); }
  };
  const auditPush = (workspaceId, actorId, action, targetId, metadata) => {
    audit.push({ id: audit.length + 1, workspaceId, actorId, action, targetType: 'eval_case_run', targetId, metadata: copy(metadata), createdAt: stamp() });
  };
  const runByJob = (workspaceId, jobId) => runs.find((row) => row.workspaceId === workspaceId && row.jobId === jobId) ?? null;
  const rowsOf = (runId) => results.filter((row) => row.runId === runId);
  const postedMap = (runId) => new Map(rowsOf(runId).map((row) => [row.caseKey, row]));
  const show = (run) => presentRun(run, rowsOf(run.id).map(copy));

  return {
    async startCaseRun({ workspaceId, projectId, versionId, runnerId, role, candidate, recipeVersion, catalog = [], idempotencyKey, actorId }) {
      if (!KEY.test(idempotencyKey ?? '')) throw invalid('Send a request key of 8 to 100 letters, digits, dashes or underscores.');
      if (!['baseline', 'candidate'].includes(role)) throw invalid('Mark the run as a baseline or a candidate.');
      if (!VERSION.test(recipeVersion ?? '')) throw invalid('The recipe version is not configured.');
      const checked = validateCandidate({ candidate, catalog });
      if (checked.error) throw invalid(checked.error);
      return locked(versionId, async () => {
        const version = await this.getEvalVersion({ workspaceId, versionId });
        if (!version || version.projectId !== projectId) throw new StoreError('not_found');
        const runner = await this.getRunner({ workspaceId, runnerId });
        if (!runner || runner.status !== 'active') throw new StoreError('not_found');
        if (!runnerFresh(runner.lastSeenAt, Date.now())) throw invalid('This runner has not reported in the last minute. Open Compute and confirm it is online.');
        const spec = { caseEval: { versionId, recipeId: RECIPE_ID, recipeVersion, role, specHash: checked.specHash } };
        let job;
        try {
          job = await this.createJob({ workspaceId, runnerId, kind: 'case_eval', spec, idempotencyKey, createdBy: actorId });
        } catch (err) {
          if (err instanceof StoreError && err.code === 'invalid_state') throw invalid('That request key was already used for a different job.');
          throw err;
        }
        const existing = runByJob(workspaceId, job.id);
        if (existing) return show(existing);
        const run = {
          id: randomUUID(), workspaceId, projectId, versionId, jobId: job.id, role, status: 'queued', scored: false,
          recipeId: RECIPE_ID, recipeVersion, settings: checked.settings, passages: checked.passages,
          runtime: { runtime: 'runner-sandbox', recipe: RECIPE_ID, modelId: checked.settings.modelId },
          createdBy: actorId, createdAt: stamp(), finishedAt: null,
        };
        runs.push(run);
        auditPush(workspaceId, actorId, 'eval_case_run.created', run.id, { role, versionId, jobId: job.id });
        return show(run);
      });
    },

    async appendCaseResults({ workspaceId, jobId, results: body }) {
      const run = runByJob(workspaceId, jobId);
      if (!run) throw new StoreError('not_found');
      return locked(run.id, async () => {
        if (run.finishedAt) throw invalid('This run has already finished.');
        const job = await this.getJob({ workspaceId, jobId });
        if (!job || !['leased', 'running', 'cancel_requested'].includes(job.status)) throw invalid('This run is not being executed.');
        const version = await this.getEvalVersion({ workspaceId, versionId: run.versionId });
        if (!version) throw new StoreError('not_found');
        const accepted = acceptBatch(body, new Set(version.cases.map((item) => item.caseKey)));
        if (accepted.error) throw invalid(accepted.error);
        for (const row of accepted.results) {
          const prior = results.find((item) => item.runId === run.id && item.caseKey === row.caseKey);
          const next = { runId: run.id, ...row, scores: null, explanation: null };
          if (prior) Object.assign(prior, next);
          else results.push(next);
        }
        if (run.status === 'queued') run.status = 'running';
        return show(run);
      });
    },

    async settleCaseRun({ workspaceId, jobId }) {
      const run = runByJob(workspaceId, jobId);
      if (!run) throw new StoreError('not_found');
      return locked(run.id, async () => {
        if (run.finishedAt) return show(run);
        const job = await this.getJob({ workspaceId, jobId });
        if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
          if (job && run.status === 'queued' && ['leased', 'running', 'cancel_requested'].includes(job.status)) run.status = 'running';
          return show(run);
        }
        const version = await this.getEvalVersion({ workspaceId, versionId: run.versionId });
        if (!version) throw new StoreError('not_found');
        const decided = job.status === 'succeeded'
          ? decideRun({ cases: version.cases, posted: postedMap(run.id), corpus: run.passages })
          : unscoredRun(version.cases, postedMap(run.id), run.passages, job.status === 'cancelled' ? 'cancelled' : 'failed');
        for (const row of decided.results) {
          const prior = results.find((item) => item.runId === run.id && item.caseKey === row.caseKey);
          const stored = { runId: run.id, ...row, scores: null };
          if (prior) Object.assign(prior, stored);
          else results.push(stored);
        }
        if (decided.scored) {
          Object.assign(run, { status: 'complete', scored: true, finishedAt: stamp() });
          for (const row of decided.results) Object.assign(results.find((item) => item.runId === run.id && item.caseKey === row.caseKey), { scores: row.scores, explanation: row.explanation });
        } else {
          Object.assign(run, { status: decided.status, scored: false, finishedAt: stamp() });
        }
        return show(run);
      });
    },

    async caseRunInputs({ workspaceId, jobId }) {
      const run = runByJob(workspaceId, jobId);
      if (!run || run.finishedAt) throw new StoreError(run ? 'invalid_state' : 'not_found', run ? 'This run has already finished.' : 'not_found');
      const version = await this.getEvalVersion({ workspaceId, versionId: run.versionId });
      if (!version) throw new StoreError('not_found');
      return {
        cases: version.cases.map(({ caseKey, input }) => ({ caseKey, input })),
        passages: copy(run.passages), settings: copy(run.settings), recipeVersion: run.recipeVersion,
      };
    },

    async getCaseRun({ workspaceId, projectId, runId }) {
      const run = runs.find((row) => row.id === runId && row.workspaceId === workspaceId && row.projectId === projectId);
      if (!run) return null;
      if (!run.finishedAt) {
        const job = await this.getJob({ workspaceId, jobId: run.jobId });
        if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return this.settleCaseRun({ workspaceId, jobId: run.jobId });
      }
      return show(run);
    },

    async listCaseRuns({ workspaceId, projectId, versionId }) {
      const matched = runs.filter((row) => row.workspaceId === workspaceId && row.projectId === projectId && row.versionId === versionId);
      const views = [];
      for (const row of matched) {
        const full = await this.getCaseRun({ workspaceId, projectId, runId: row.id });
        const view = { ...full };
        delete view.results;
        delete view.passages;
        views.push(view);
      }
      return views;
    },
  };
}
