import { COMPAT_SETTINGS, COMPAT_TASKS, validateInstall, validateLabel, validateReport, validateRun } from './lib/devices.js';

/**
 * Run on this device. The browser talks to the person's own local runtime (Ollama on loopback); this server only
 * records what that browser reports and never contacts a runtime or accepts a runtime URL. A device is private to
 * the person who registered it: other members of the workspace, owners included, cannot read or use it.
 */
export function registerDeviceRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId/devices';
  const where = (request) => ({ workspaceId: request.params.workspaceId, ownerId: request.user.id, deviceId: request.params.deviceId });
  const invalid = (reply, errors) => problem(reply, 400, 'Check the highlighted fields.', { errors });
  const deviceFail = (reply, err) => (err?.code === 'invalid_state'
    ? problem(reply, 409, 'This device was disconnected from Valcairn. Connect it again to record new results.', { code: 'device_revoked' })
    : fail(reply, err));
  // Any member may run models on their own machine; the device is theirs alone, so membership is the only role check.
  const mine = [signedIn, member('readProjects')];

  app.get('/api/local-models', get([signedIn]), async () => ({
    catalog: config.localModelCatalog,
    tasks: COMPAT_TASKS,
    taskSettings: COMPAT_SETTINGS,
    // The exact origins the browser may reach; the server itself never connects to them.
    runtimeOrigins: config.localRuntimeOrigins,
  }));

  app.get(base, get(mine), async (request) => ({ devices: await store.listDevices({ workspaceId: request.params.workspaceId, ownerId: request.user.id }) }));

  app.post(base, post(mine), async (request, reply) => {
    const result = validateLabel(request.body?.label);
    if (result.errors) return invalid(reply, result.errors);
    try { return { device: await store.createDevice({ workspaceId: request.params.workspaceId, ownerId: request.user.id, label: result.values.label, runtime: 'ollama' }) }; }
    catch (err) { return fail(reply, err); }
  });

  app.get(`${base}/:deviceId`, get(mine), async (request, reply) => {
    const device = await store.getDevice(where(request));
    if (!device) return problem(reply, 404, 'Not found.');
    const [installs, runs] = await Promise.all([store.listModelInstalls(where(request)), store.listExecutionRuns({ ...where(request), limit: 50 })]);
    return { device, installs, runs };
  });

  app.post(`${base}/:deviceId/revoke`, post(mine), async (request, reply) => {
    try { return { device: await store.revokeDevice(where(request)) }; }
    catch (err) { return deviceFail(reply, err); }
  });

  app.post(`${base}/:deviceId/reports`, post(mine), async (request, reply) => {
    const result = validateReport(request.body);
    if (result.errors) return invalid(reply, result.errors);
    try { return { report: await store.recordDeviceReport({ ...where(request), report: result.values }) }; }
    catch (err) { return deviceFail(reply, err); }
  });

  app.post(`${base}/:deviceId/installs`, post(mine), async (request, reply) => {
    const result = validateInstall(request.body, config.localModelCatalog);
    if (result.errors) return invalid(reply, result.errors);
    try { return { install: await store.saveModelInstall({ ...where(request), install: result.values }) }; }
    catch (err) { return deviceFail(reply, err); }
  });

  app.post(`${base}/:deviceId/runs`, post(mine), async (request, reply) => {
    const result = validateRun(request.body);
    if (result.errors) return invalid(reply, result.errors);
    try { return { run: await store.recordExecutionRun({ ...where(request), run: result.values }) }; }
    catch (err) { return deviceFail(reply, err); }
  });
}
