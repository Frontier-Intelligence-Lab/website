import { StoreError } from './store/index.js';

/**
 * Executed case runs for one frozen evaluation version. Owners and admins start a run on a runner.
 * Readers can reload it. The runner posts outputs; this server scores them. Nothing here calls a model.
 */
export function registerCaseRunRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId/projects/:projectId/evaluations/:setId/versions/:versionId/runs';
  const reader = [signedIn, member('readProjects')];
  const starter = [signedIn, member('manageMembers')];

  const storeFail = (reply, err) => {
    if (!(err instanceof StoreError)) return fail(reply, err);
    if (err.code === 'not_found') return problem(reply, 404, 'Not found.');
    if (err.code === 'invalid_state') return problem(reply, 409, err.message, { code: 'invalid_state' });
    return fail(reply, err);
  };
  const versionOf = async (request, reply) => {
    const { workspaceId, projectId, setId, versionId } = request.params;
    const version = await store.getEvalVersion({ workspaceId, versionId });
    if (!version || version.projectId !== projectId || version.setId !== setId) {
      problem(reply, 404, 'Not found.');
      return null;
    }
    return version;
  };

  app.post(base, post(starter), async (request, reply) => {
    const version = await versionOf(request, reply);
    if (!version) return;
    const body = request.body ?? {};
    try {
      const run = await store.startCaseRun({
        workspaceId: request.params.workspaceId, projectId: request.params.projectId, versionId: version.id,
        runnerId: body.runnerId, role: body.role, candidate: body.candidate, recipeVersion: config.evalRecipeVersion,
        catalog: config.modelCatalog, idempotencyKey: body.idempotencyKey, actorId: request.user.id,
      });
      return { run };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(base, get(reader), async (request, reply) => {
    const version = await versionOf(request, reply);
    if (!version) return;
    const runs = await store.listCaseRuns({ workspaceId: request.params.workspaceId, projectId: request.params.projectId, versionId: version.id });
    return { runs };
  });

  app.get(`${base}/:runId`, get(reader), async (request, reply) => {
    const version = await versionOf(request, reply);
    if (!version) return;
    const run = await store.getCaseRun({ workspaceId: request.params.workspaceId, projectId: request.params.projectId, runId: request.params.runId });
    if (!run || run.versionId !== version.id) return problem(reply, 404, 'Not found.');
    return { run };
  });
}
