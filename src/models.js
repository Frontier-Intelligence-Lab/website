import { StoreError } from './store/index.js';
import { COMPUTE_OPTIONS, ENHANCE_METHODS, allowsTraining, validateEnhanceRun } from './lib/models.js';

/**
 * Models: the open-weight catalog, models pulled into a workspace, and enhance runs that post-train a pulled
 * model on the workspace's approved dataset versions. Requesting a run records the approved plan and cap;
 * copying weights and running on GPUs are not automated yet, and every response says so.
 * The catalog comes from config (MODEL_CATALOG_FILE). Pulls and runs are read back whether or not their model is
 * still listed; only a new pull, a plan edit or an approval needs the model in the current catalog.
 */
export function registerModelRoutes(app, { config, store, guards, helpers }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId';
  const catalog = config.modelCatalog;
  const catalogModel = (id) => catalog.find((m) => m.id === id) ?? null;

  // Approved versions that are delivered data with recorded rights allowing training. A license or collection
  // request, a missing rights record or an empty version is not training data. Manifests are frozen, so this is stable.
  const eligibleVersions = async (workspaceId) => {
    const projects = await store.listProjects(workspaceId);
    const out = [];
    for (const project of projects) {
      for (const v of await store.listDatasetVersions({ workspaceId, projectId: project.id })) {
        if (!allowsTraining(v.manifest)) continue;
        out.push({ projectId: project.id, projectName: project.name, version: v.number, files: v.manifest?.files?.length ?? 0, labels: v.manifest?.annotations?.length ?? 0, createdAt: v.createdAt });
      }
    }
    return out;
  };
  const pulledIds = async (workspaceId) => new Set((await store.listModelPulls(workspaceId)).map((p) => p.modelId));
  const loadRun = async (request, reply) => {
    const run = await store.getEnhanceRun({ workspaceId: request.params.workspaceId, runId: request.params.runId });
    if (!run) return problem(reply, 404, 'Not found.');
    request.run = run;
  };
  const storeFail = (reply, err) => {
    if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This run has been requested, so its plan can no longer change.', { code: 'run_requested' });
    if (err instanceof StoreError && err.code === 'not_found') return problem(reply, 404, 'Not found.');
    return fail(reply, err);
  };

  app.get('/api/models/catalog', get([signedIn]), async () => ({ models: catalog, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS }));

  app.get(`${base}/models`, get([signedIn, member('readProjects')]), async (request) => {
    const { workspaceId } = request.params;
    const [pulls, runs] = await Promise.all([store.listModelPulls(workspaceId), store.listEnhanceRuns(workspaceId)]);
    return { role: request.role, pulls, runs, catalog, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS };
  });

  app.post(`${base}/models/pulls`, post([signedIn, member('writeProjects')]), async (request, reply) => {
    const model = catalogModel(request.body?.modelId);
    if (!model) return problem(reply, 400, 'Choose a model from the catalog.');
    try {
      const pull = await store.requestModelPull({ workspaceId: request.params.workspaceId, modelId: model.id, requestedBy: request.user.id });
      await store.recordAudit({ workspaceId: request.params.workspaceId, actorId: request.user.id, action: 'model.pull_requested', targetType: 'model', targetId: model.id });
      return { pull };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/enhance-runs/options`, get([signedIn, member('readProjects')]), async (request) => {
    const { workspaceId } = request.params;
    const [pulls, datasets] = await Promise.all([store.listModelPulls(workspaceId), eligibleVersions(workspaceId)]);
    return { pulls, datasets, catalog, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS };
  });

  app.post(`${base}/enhance-runs`, post([signedIn, member('writeProjects')]), async (request, reply) => {
    const { workspaceId } = request.params;
    const result = validateEnhanceRun(request.body, { catalog, pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId) });
    if (result.errors) return problem(reply, 400, 'Check the highlighted fields.', { errors: result.errors });
    try { return { run: await store.createEnhanceRun({ workspaceId, createdBy: request.user.id, run: result.values }) }; }
    catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/enhance-runs/:runId`, get([signedIn, member('readProjects'), loadRun]), async (request) => ({ role: request.role, run: request.run }));

  app.post(`${base}/enhance-runs/:runId`, post([signedIn, member('writeProjects'), loadRun]), async (request, reply) => {
    const { workspaceId } = request.params;
    if (request.run.status !== 'draft') return storeFail(reply, new StoreError('invalid_state'));
    const result = validateEnhanceRun(request.body, { catalog, pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId) });
    if (result.errors) return problem(reply, 400, 'Check the highlighted fields.', { errors: result.errors });
    try { return { run: await store.updateEnhanceRun({ workspaceId, runId: request.run.id, run: result.values }) }; }
    catch (err) { return storeFail(reply, err); }
  });

  // Approving spend is for owners and admins, the same people who approve dataset versions.
  app.post(`${base}/enhance-runs/:runId/request`, post([signedIn, member('manageMembers'), loadRun]), async (request, reply) => {
    const { workspaceId } = request.params;
    if (request.run.status !== 'draft') return storeFail(reply, new StoreError('invalid_state'));
    // The approver names the exact plan they reviewed; the store refuses if it changed since (stale_plan).
    const expectedUpdatedAt = request.body?.expectedUpdatedAt;
    if (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt))) return problem(reply, 400, 'Reload the plan and approve the version you reviewed.', { code: 'stale_plan' });
    if (expectedUpdatedAt !== request.run.updatedAt) return problem(reply, 409, 'This plan changed after you opened it. Review the current plan, then approve it.', { code: 'stale_plan', run: request.run });
    const check = validateEnhanceRun(request.run, { catalog, pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId), forRequest: true });
    if (check.errors) return problem(reply, 400, 'Finish the plan before you request it.', { errors: check.errors });
    try { return { run: await store.requestEnhanceRun({ workspaceId, runId: request.run.id, requestedBy: request.user.id, expectedUpdatedAt }) }; }
    catch (err) {
      if (err instanceof StoreError && err.code === 'stale_plan') return problem(reply, 409, 'This plan changed after you opened it. Review the current plan, then approve it.', { code: 'stale_plan' });
      return storeFail(reply, err);
    }
  });
}
