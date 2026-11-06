import { StoreError } from './store/index.js';
import { allowsTraining } from './lib/models.js';
import { signToken } from './lib/tokens.js';
import { LEASE_MS, bearerKey, buildJobSpec, hashSecret, keyPrefix, newLeaseToken, newRunnerKey, validateCapabilities, validateEvents, validateFinish, validateRunnerLabel } from './lib/jobs.js';

/**
 * Valcairn Runners and jobs. People link a runner (a machine of theirs) with a key shown once, then queue jobs on
 * it; the runner authenticates with that key only, leases one job at a time and reports progress. The web server
 * never connects to a runner: the runner always calls in, so it can sit behind NAT on a laptop.
 */
const INPUT_TTL_S = 15 * 60;
const EVENT_PAGE = 500;

export function registerJobRoutes(app, { config, store, helpers, guards }) {
  const { problem, privateHeaders } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId';
  const invalid = (reply, errors) => problem(reply, 400, 'Check the highlighted fields.', { errors });
  const jobFail = (reply, err) => {
    if (err instanceof StoreError && err.code === 'lease_lost') return problem(reply, 409, 'This runner no longer holds the job.', { code: 'lease_lost' });
    if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This is not possible in the current state.', { code: 'invalid_state' });
    return fail(reply, err);
  };
  const view = (job) => {
    const { idempotencyKey, ...rest } = job;
    return rest;
  };

  app.get(`${base}/runners`, get([signedIn, member('readProjects')]), async (request) => ({ runners: await store.listRunners(request.params.workspaceId) }));

  // Linking a machine that will run code on the workspace's data is for owners and admins.
  app.post(`${base}/runners`, { ...post([signedIn, member('manageMembers')]), config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const result = validateRunnerLabel(request.body?.label);
    if (result.errors) return invalid(reply, result.errors);
    const key = newRunnerKey();
    try {
      const runner = await store.createRunner({ workspaceId: request.params.workspaceId, createdBy: request.user.id, label: result.values.label, keyHash: hashSecret(key), keyPrefix: keyPrefix(key) });
      // The only time the key is returned. It is not stored and cannot be shown again.
      return { runner, key };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/runners/:runnerId/revoke`, post([signedIn, member('manageMembers')]), async (request, reply) => {
    try { return { runner: await store.revokeRunner({ workspaceId: request.params.workspaceId, runnerId: request.params.runnerId, actorId: request.user.id }) }; }
    catch (err) { return jobFail(reply, err); }
  });

  app.get(`${base}/jobs`, get([signedIn, member('readProjects')]), async (request) => ({ jobs: (await store.listJobs({ workspaceId: request.params.workspaceId })).map(view) }));

  app.get(`${base}/jobs/:jobId`, get([signedIn, member('readProjects')]), async (request, reply) => {
    const { workspaceId, jobId } = request.params;
    const job = await store.getJob({ workspaceId, jobId });
    if (!job) return problem(reply, 404, 'Not found.');
    const afterId = Number.parseInt(request.query?.after ?? '0', 10);
    // One page of events; `more` says another page follows (ask again with after = the last id).
    const page = await store.listJobEvents({ workspaceId, jobId, afterId: Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0, limit: EVENT_PAGE + 1 });
    return { job: view(job), events: page.slice(0, EVENT_PAGE), more: page.length > EVENT_PAGE };
  });

  // Running code on a machine and spending its compute is an owner/admin decision, like approving a plan.
  app.post(`${base}/jobs`, post([signedIn, member('manageMembers')]), async (request, reply) => {
    const { workspaceId } = request.params;
    const body = request.body ?? {};
    const idempotencyKey = typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;
    if (!idempotencyKey) return invalid(reply, { idempotencyKey: 'Send a request key of 8 to 100 letters, digits, dashes or underscores.' });
    const runner = typeof body.runnerId === 'string' ? await store.getRunner({ workspaceId, runnerId: body.runnerId }) : null;
    if (!runner) return invalid(reply, { runnerId: 'Choose a runner linked to this workspace.' });
    if (runner.status !== 'active') return invalid(reply, { runnerId: 'This runner was disconnected. Link it again first.' });
    const run = typeof body.enhanceRunId === 'string' ? await store.getEnhanceRun({ workspaceId, runId: body.enhanceRunId }) : null;
    if (body.enhanceRunId != null && !run) return invalid(reply, { enhanceRunId: 'Choose an approved enhance plan.' });
    let trainJob = null;
    if (['evaluate', 'export'].includes(body.kind) && typeof body.trainJobId === 'string') {
      trainJob = await store.getJob({ workspaceId, jobId: body.trainJobId });
      // The adapter lives on the runner that trained it, so it must be the same plan and the same runner.
      if (trainJob && (trainJob.kind !== 'train' || trainJob.enhanceRunId !== run?.id || trainJob.runnerId !== runner.id)) trainJob = null;
    }
    const spec = buildJobSpec({ kind: body.kind, run, catalog: config.modelCatalog, trainJob });
    if (spec.errors) return invalid(reply, spec.errors);
    try {
      return { job: view(await store.createJob({ workspaceId, runnerId: runner.id, kind: body.kind, enhanceRunId: run?.id ?? null, spec: spec.values, idempotencyKey, createdBy: request.user.id })) };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'That request key was already used for a different job.', { code: 'idempotency_conflict' });
      return jobFail(reply, err);
    }
  });

  app.post(`${base}/jobs/:jobId/cancel`, post([signedIn, member('manageMembers')]), async (request, reply) => {
    try { return { job: view(await store.cancelJob({ workspaceId: request.params.workspaceId, jobId: request.params.jobId, actorId: request.user.id })) }; }
    catch (err) { return jobFail(reply, err); }
  });

  // --- Runner API: bearer key only, no cookies. Browsers never send this header on their own, so no Origin check.
  const runnerAuth = async (request, reply) => {
    privateHeaders(reply);
    if (!store) return problem(reply, 503, 'Runners are not available on this server yet.');
    const key = bearerKey(request.headers.authorization);
    const runner = key ? await store.findActiveRunnerByKeyHash(hashSecret(key)) : null;
    if (!runner) return problem(reply, 401, 'This runner key is not valid or was revoked.', { code: 'runner_key_invalid' });
    // The person who linked it must still be able to link runners; otherwise the key stops working.
    const membership = await store.getMembership(runner.workspaceId, runner.createdBy);
    if (!membership || !['owner', 'admin'].includes(membership.role)) return problem(reply, 401, 'The person who linked this runner no longer manages the workspace.', { code: 'runner_owner_inactive' });
    request.runner = runner;
  };
  const runnerRoute = { preHandler: runnerAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };
  const lease = (body) => (typeof body?.leaseToken === 'string' && /^[A-Za-z0-9_-]{32}$/.test(body.leaseToken) ? hashSecret(body.leaseToken) : null);
  const forRunner = (job) => ({ id: job.id, kind: job.kind, status: job.status, attempt: job.attempt, leaseExpiresAt: job.leaseExpiresAt, cancelRequested: job.status === 'cancel_requested' });

  app.post('/api/runner/heartbeat', runnerRoute, async (request, reply) => {
    const result = validateCapabilities(request.body?.capabilities);
    if (result.errors) return invalid(reply, result.errors);
    try {
      const runner = await store.reportRunner({ runnerId: request.runner.id, capabilities: result.values });
      return { runner: { id: runner.id, label: runner.label, workspaceId: runner.workspaceId }, leaseMs: LEASE_MS };
    } catch (err) { return jobFail(reply, err); }
  });

  app.post('/api/runner/lease', runnerRoute, async (request, reply) => {
    const token = newLeaseToken();
    try {
      const job = await store.leaseJob({ runnerId: request.runner.id, leaseHash: hashSecret(token) });
      return job ? { job: { ...forRunner(job), spec: job.spec, leaseToken: token } } : { job: null };
    } catch (err) { return jobFail(reply, err); }
  });

  app.get('/api/runner/jobs/:jobId', runnerRoute, async (request, reply) => {
    const job = await store.getRunnerJob({ runnerId: request.runner.id, jobId: request.params.jobId });
    return job ? { job: forRunner(job) } : problem(reply, 404, 'Not found.');
  });

  app.post('/api/runner/jobs/:jobId/heartbeat', runnerRoute, async (request, reply) => {
    try { return { job: forRunner(await store.touchJob({ runnerId: request.runner.id, jobId: request.params.jobId, leaseHash: lease(request.body) })) }; }
    catch (err) { return jobFail(reply, err); }
  });

  app.post('/api/runner/jobs/:jobId/events', runnerRoute, async (request, reply) => {
    const result = validateEvents(request.body?.events);
    if (result.errors) return invalid(reply, result.errors);
    try {
      const { added, job } = await store.appendJobEvents({ runnerId: request.runner.id, jobId: request.params.jobId, leaseHash: lease(request.body), events: result.values });
      return { added, job: forRunner(job) };
    } catch (err) { return jobFail(reply, err); }
  });

  // The frozen inputs of a plan-based job, only for the runner that holds it: the dataset versions named in the
  // job's spec, resolved through each version's manifest, with short-lived signed download links.
  app.post('/api/runner/jobs/:jobId/inputs', runnerRoute, async (request, reply) => {
    const who = { runnerId: request.runner.id, jobId: request.params.jobId, leaseHash: lease(request.body) };
    const cancelled = () => problem(reply, 409, 'This job was cancelled, so no new inputs are issued.', { code: 'job_cancelled' });
    let job;
    try { job = await store.touchJob(who); }
    catch (err) { return jobFail(reply, err); }
    if (job.kind === 'probe') return problem(reply, 400, 'A sandbox check has no inputs.');
    // A cancelled job gets no new input grants. Links issued before the cancel stay valid until they expire.
    if (job.status === 'cancel_requested') return cancelled();
    if (job.kind === 'case_eval') {
      let payload;
      try { payload = await store.caseRunInputs({ workspaceId: job.workspaceId, jobId: job.id }); }
      catch (err) { return jobFail(reply, err); }
      try { await store.releaseJobInputs({ ...who, versions: 1, files: payload.cases.length }); }
      catch (err) { return err instanceof StoreError && err.code === 'invalid_state' ? cancelled() : jobFail(reply, err); }
      return payload;
    }
    const ingest = config.ingest;
    if (!ingest) return problem(reply, 503, 'File storage is not configured on this server.', { code: 'storage_unavailable' });
    // The complete response, signed links included, is prepared first, outside any lock. Nothing has been granted
    // yet: if the release below is refused, none of it leaves the server.
    const exp = Math.floor(Date.now() / 1000) + INPUT_TTL_S;
    const datasets = [];
    for (const { projectId, version } of job.spec.plan.datasets) {
      const v = (await store.listDatasetVersions({ workspaceId: job.workspaceId, projectId })).find((x) => x.number === version);
      if (!v || !allowsTraining(v.manifest)) return problem(reply, 409, 'A dataset version in this plan is missing or no longer allows training.', { code: 'dataset_unavailable' });
      datasets.push({
        projectId, version,
        files: v.manifest.files.map((f) => ({ id: f.id, filename: f.filename, sha256: f.sha256, sizeBytes: f.sizeBytes, contentType: f.contentType,
          url: `${ingest.publicUrl}/v1/objects?token=${encodeURIComponent(signToken(ingest.secret, { v: 1, kind: 'download', key: f.objectKey, filename: f.filename, exp }))}` })),
      });
    }
    const payload = { baseModel: { id: job.spec.baseModel.id, source: job.spec.baseModel.source, license: job.spec.baseModel.license }, datasets, expiresInSeconds: INPUT_TTL_S };
    // The checks above may be stale by now: the lookups took time, and a cancel, a revoke or the lease's expiry may
    // have been committed meanwhile. The release is decided in the store under the job row lock that cancel and revoke
    // also take, on the lease, job and runner as they are at that moment, and it records exactly this prepared
    // payload (job.inputs_released, with its version and file counts). A cancel or revoke committed first wins and the
    // prepared links are dropped; one committed later cannot withdraw a payload already released, which only expires.
    // After the gate the prepared payload is returned as it is: nothing is signed and nothing is awaited.
    try { await store.releaseJobInputs({ ...who, versions: datasets.length, files: datasets.reduce((n, d) => n + d.files.length, 0) }); }
    catch (err) { return err instanceof StoreError && err.code === 'invalid_state' ? cancelled() : jobFail(reply, err); }
    return payload;
  });

  app.post('/api/runner/jobs/:jobId/finish', runnerRoute, async (request, reply) => {
    const held = await store.getRunnerJob({ runnerId: request.runner.id, jobId: request.params.jobId });
    if (!held) return problem(reply, 404, 'Not found.');
    const result = validateFinish(request.body, held.kind);
    if (result.errors) return invalid(reply, result.errors);
    try {
      const finished = await store.finishJob({ runnerId: request.runner.id, jobId: request.params.jobId, leaseHash: lease(request.body), ...result.values });
      if (held.kind === 'case_eval') await store.settleCaseRun({ workspaceId: held.workspaceId, jobId: held.id });
      return { job: forRunner(finished) };
    }
    catch (err) { return jobFail(reply, err); }
  });

  // Outputs for one case_eval job. The server drops any score the runner sends. A cancel still accepts rows
  // so the kept answers can be shown, and it never stores a score.
  app.post('/api/runner/jobs/:jobId/case-results', { ...runnerRoute, bodyLimit: 256 * 1024 }, async (request, reply) => {
    const who = { runnerId: request.runner.id, jobId: request.params.jobId, leaseHash: lease(request.body) };
    let job;
    try { job = await store.touchJob(who); }
    catch (err) { return jobFail(reply, err); }
    if (job.kind !== 'case_eval') return problem(reply, 400, 'This job does not take case results.');
    try { return { run: await store.appendCaseResults({ workspaceId: job.workspaceId, jobId: job.id, results: request.body?.results }) }; }
    catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, err.message, { code: 'invalid_state' });
      return jobFail(reply, err);
    }
  });
}
