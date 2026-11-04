import { StoreError } from './store/index.js';
import { COMPUTE_OPTIONS, ENHANCE_METHODS, MODEL_CATALOG, catalogModel, validateEnhanceRun } from './lib/models.js';

/**
 * Models: the open-weight catalog, models pulled into a workspace, and enhance runs that post-train a pulled
 * model on the workspace's approved dataset versions. Requesting a run records the approved plan and cap;
 * copying weights and running on GPUs are not automated yet, and every response says so.
 */
export function registerModelRoutes(app, { store, guards, helpers }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId';

  // Approved versions whose recorded rights allow training. Version manifests are frozen, so this is stable.
  const eligibleVersions = async (workspaceId) => {
    const projects = await store.listProjects(workspaceId);
    const out = [];
    for (const project of projects) {
      for (const v of await store.listDatasetVersions({ workspaceId, projectId: project.id })) {
        const source = v.manifest?.dataSource;
        const allowsTraining = source?.mode !== 'upload' || (source.allowedUses ?? []).includes('training');
        if (!allowsTraining) continue;
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

  app.get('/api/models/catalog', get([signedIn]), async () => ({ models: MODEL_CATALOG, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS }));

  app.get(`${base}/models`, get([signedIn, member('readProjects')]), async (request) => {
    const { workspaceId } = request.params;
    const [pulls, runs] = await Promise.all([store.listModelPulls(workspaceId), store.listEnhanceRuns(workspaceId)]);
    return { role: request.role, pulls, runs, catalog: MODEL_CATALOG, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS };
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
    return { pulls, datasets, catalog: MODEL_CATALOG, methods: ENHANCE_METHODS, compute: COMPUTE_OPTIONS };
  });

  app.post(`${base}/enhance-runs`, post([signedIn, member('writeProjects')]), async (request, reply) => {
    const { workspaceId } = request.params;
    const result = validateEnhanceRun(request.body, { pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId) });
    if (result.errors) return problem(reply, 400, 'Check the highlighted fields.', { errors: result.errors });
    try { return { run: await store.createEnhanceRun({ workspaceId, createdBy: request.user.id, run: result.values }) }; }
    catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/enhance-runs/:runId`, get([signedIn, member('readProjects'), loadRun]), async (request) => ({ role: request.role, run: request.run }));

  app.post(`${base}/enhance-runs/:runId`, post([signedIn, member('writeProjects'), loadRun]), async (request, reply) => {
    const { workspaceId } = request.params;
    if (request.run.status !== 'draft') return storeFail(reply, new StoreError('invalid_state'));
    const result = validateEnhanceRun(request.body, { pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId) });
    if (result.errors) return problem(reply, 400, 'Check the highlighted fields.', { errors: result.errors });
    try { return { run: await store.updateEnhanceRun({ workspaceId, runId: request.run.id, run: result.values }) }; }
    catch (err) { return storeFail(reply, err); }
  });

  // Approving spend is for owners and admins, the same people who approve dataset versions.
  app.post(`${base}/enhance-runs/:runId/request`, post([signedIn, member('manageMembers'), loadRun]), async (request, reply) => {
    const { workspaceId } = request.params;
    if (request.run.status !== 'draft') return storeFail(reply, new StoreError('invalid_state'));
    const check = validateEnhanceRun(request.run, { pulled: await pulledIds(workspaceId), eligible: await eligibleVersions(workspaceId), forRequest: true });
    if (check.errors) return problem(reply, 400, 'Finish the plan before you request it.', { errors: check.errors });
    try { return { run: await store.requestEnhanceRun({ workspaceId, runId: request.run.id, requestedBy: request.user.id }) }; }
    catch (err) { return storeFail(reply, err); }
  });
}
