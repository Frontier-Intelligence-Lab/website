import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreError } from './store/index.js';
import { createResearchWorker, researchWorkerMessage } from './lib/research-worker.js';
import {
  CHECKLIST_KEYS, DIRECTORIES, DIRECTORY_LABELS, STALE_MS, TEMPLATES, candidatesFromPages, checklistPatch, emptyChecklist,
  recordsFromLabsCatalog, reportFromPages, sha256Text, templateDraft, toCsv,
} from './lib/research.js';

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'frontier-ai-labs-seed.json');
const PAGE_SIZE = 20;
const INTERRUPT_MS = 2 * 60 * 1000;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function publicHttps(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    return url.toString();
  } catch { return null; }
}

function catalogInfo() {
  try {
    const rows = JSON.parse(readFileSync(CATALOG, 'utf8'));
    return { available: Array.isArray(rows) && rows.length > 0, count: Array.isArray(rows) ? rows.length : 0, name: 'Frontier AI labs catalog' };
  } catch {
    return { available: false, count: 0, name: 'Frontier AI labs catalog' };
  }
}

function labsRecords() {
  let rows;
  try { rows = JSON.parse(readFileSync(CATALOG, 'utf8')); }
  catch { throw new StoreError('invalid_state', 'The Frontier AI labs catalog is not available on this server.'); }
  try { return recordsFromLabsCatalog(rows); }
  catch (err) { throw new StoreError('invalid_import', err.message || 'The labs catalog could not be read.'); }
}

/** Recompute the hash. A page whose text does not match the hash is not quotable. */
function normalizePages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map((page) => {
    if (!page || typeof page !== 'object') return { status: 'failed', url: '', text: '', excerpt: '', failure: 'The worker returned an unusable page.' };
    const next = { ...page, text: typeof page.text === 'string' ? page.text : '', excerpt: typeof page.excerpt === 'string' ? page.excerpt : '' };
    if (next.status !== 'retrieved') return next;
    const digest = sha256Text(next.text);
    if (!next.text || (next.sha256 && next.sha256 !== digest)) {
      return { ...next, status: 'failed', text: '', excerpt: '', sha256: null, failure: 'The retrieved text did not match its hash.' };
    }
    return { ...next, sha256: digest };
  });
}

function capabilities(config) {
  const model = Boolean(config.research?.model && config.research?.modelBaseUrl);
  const catalog = catalogInfo();
  return {
    directories: DIRECTORIES.map((id) => ({ id, label: DIRECTORY_LABELS[id] })),
    webSearch: { available: false, detail: 'Paid web search is not configured and is not called.' },
    wikimediaSearch: { available: true, detail: 'Public Wikimedia opensearch. Choose it on a run. No key is required.' },
    urlFetch: { available: true, detail: 'The Python worker fetches https URLs you name, at most 5, port 443 only.' },
    modelExtraction: { available: model, detail: model ? 'A model is configured. Runs still extract retrieved text only and do not call it.' : 'Set RESEARCH_MODEL and RESEARCH_MODEL_BASE_URL to configure a model. This server does not call one until that work is explicitly enabled.' },
    worker: { available: 'not_probed', detail: 'Python starts only when a run starts. A missing interpreter fails that run.' },
    catalog: { ...catalog, investors: 0, investorGap: 'No sourced investor or partner directory is in this system. That directory stays empty until a public source is retrieved or you add a record with an excerpt.' },
    savedNoteAgent: { available: false, detail: 'The saved-note Agent is a different feature and is not used here.' },
  };
}

/**
 * Research routes. Dataset approval does not apply. Reviewers reach only the POST patterns
 * named in DEMO_ALLOWED_MUTATIONS. An empty body is a 400, never a 500.
 */
export function registerResearchRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, member, post, get } = guards;
  const reader = [signedIn, member('readProjects')];
  const writer = [signedIn, member('writeProjects')];
  const base = '/api/workspaces/:workspaceId/research';
  const fallback = createResearchWorker({ python: config.research?.python });
  const executor = () => (typeof app.researchExecutor === 'function' ? app.researchExecutor : fallback);
  const modelConfigured = () => Boolean(config.research?.model && config.research?.modelBaseUrl);
  const active = new Map();
  const runKey = (workspaceId, runId) => `${workspaceId}:${runId}`;
  const cancel = async (workspaceId, runId) => {
    const run = await store.cancelResearchRun({ workspaceId, runId });
    active.get(runKey(workspaceId, runId))?.abort();
    return run;
  };
  app.addHook('onClose', async () => {
    for (const controller of active.values()) controller.abort();
  });
  const where = (request) => ({ workspaceId: request.params.workspaceId });
  const flags = (role) => ({ canWrite: ['owner', 'admin', 'member'].includes(role) });

  const fail = (reply, err) => {
    if (!(err instanceof StoreError)) throw err;
    const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'invalid_state' ? 409 : 400;
    const message = err.message && err.message !== err.code ? err.message : (err.code === 'not_found' ? 'Not found.' : 'The request could not be completed.');
    return problem(reply, status, message, { code: err.code });
  };
  const recover = (workspaceId) => store.recoverResearchRuns({ workspaceId, olderThan: new Date(Date.now() - INTERRUPT_MS).toISOString() });

  app.get(`${base}/capabilities`, get(reader), async (request) => ({ ...flags(request.role), ...capabilities(config) }));

  app.get(`${base}/projects`, get(reader), async (request) => {
    const projects = await store.listResearchProjects(request.params.workspaceId);
    return { ...flags(request.role), projects, ...capabilities(config) };
  });

  app.post(`${base}/projects`, post(writer), async (request, reply) => {
    const template = request.body?.template;
    if (!TEMPLATES.includes(template)) return problem(reply, 400, 'Choose a research template: collection, landscape or diligence.');
    const workspace = await store.getWorkspace(request.params.workspaceId);
    const draft = templateDraft(template, workspace?.name ?? '');
    const name = text(request.body?.name, 160) || draft.name;
    const brief = request.body?.brief == null ? draft.brief : text(request.body.brief, 8000);
    const question = request.body?.question == null ? draft.question : text(request.body.question, 2000);
    if (!name || !question) return problem(reply, 400, 'A research project needs a name and a question.');
    let checklist = emptyChecklist();
    if (request.body?.checklist != null) {
      checklist = checklistPatch(request.body.checklist);
      if (!checklist) return problem(reply, 400, 'The checklist needs each item as true or false.');
    }
    try {
      const project = await store.createResearchProject({ ...where(request), createdBy: request.user.id, template, name, brief, question, checklist });
      return { project };
    } catch (err) { return fail(reply, err); }
  });

  app.get(`${base}/projects/:projectId`, get(reader), async (request, reply) => {
    await recover(request.params.workspaceId);
    const detail = await store.getResearchProject({ ...where(request), projectId: request.params.projectId });
    if (!detail) return problem(reply, 404, 'Not found.');
    const counts = {};
    for (const directory of DIRECTORIES) {
      const page = await store.listResearchDirectory({ ...where(request), projectId: request.params.projectId, directory, page: 1, pageSize: 1 });
      counts[directory] = page?.total ?? 0;
    }
    return { ...flags(request.role), ...detail, counts, directories: DIRECTORIES.map((id) => ({ id, label: DIRECTORY_LABELS[id], count: counts[id] })) };
  });

  app.post(`${base}/projects/:projectId`, post(writer), async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
    const current = await store.getResearchProject({ ...where(request), projectId: request.params.projectId });
    if (!current) return problem(reply, 404, 'Not found.');
    const patch = {};
    if ('name' in body) {
      patch.name = text(body.name, 160);
      if (!patch.name) return problem(reply, 400, 'The name cannot be empty.');
    }
    if ('brief' in body) patch.brief = text(body.brief, 8000);
    if ('question' in body) {
      patch.question = text(body.question, 2000);
      if (!patch.question) return problem(reply, 400, 'The question cannot be empty.');
    }
    if (!Object.keys(patch).length) return problem(reply, 400, 'Say what to change.');
    try {
      const project = await store.updateResearchProject({
        ...where(request), projectId: request.params.projectId,
        patch,
      });
      return { project };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/projects/:projectId/imports`, { ...post(writer), bodyLimit: 262144 }, async (request, reply) => {
    const body = request.body ?? {};
    const dryRun = body.dryRun === true;
    let records = body.records;
    if (body.catalog != null) {
      if (body.catalog !== 'frontier-ai-labs') return problem(reply, 400, 'The only catalog this server can import is frontier-ai-labs.');
      if (records != null) return problem(reply, 400, 'Import the catalog or a list of records, not both.');
      try { records = labsRecords(); }
      catch (err) { return fail(reply, err); }
    }
    if (!Array.isArray(records) || records.length < 1 || records.length > 200) return problem(reply, 400, 'Provide between 1 and 200 records, or catalog: "frontier-ai-labs".');
    try {
      const summary = await store.importResearchRecords({ ...where(request), projectId: request.params.projectId, actorId: request.user.id, records, dryRun });
      if (summary.failed && !summary.importedEntities && !summary.importedClaims && !summary.skippedEntities && !summary.skippedClaims) {
        return problem(reply, 400, summary.errors?.[0] || 'None of the records could be saved.', { code: 'invalid_import', summary, dryRun });
      }
      return { summary, dryRun };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/projects/:projectId/sources`, post(writer), async (request, reply) => {
    const url = publicHttps(request.body?.url);
    if (!url) return problem(reply, 400, 'Provide one https URL. Nothing was fetched.');
    const detail = await store.getResearchProject({ ...where(request), projectId: request.params.projectId });
    if (!detail) return problem(reply, 404, 'Not found.');
    return { url, fetched: false, message: 'This URL is accepted for a research run. This request did not fetch it.' };
  });

  app.get(`${base}/projects/:projectId/directory`, get(reader), async (request, reply) => {
    const listId = request.query?.listId ?? null;
    const requestedDirectory = request.query?.directory ?? null;
    if ((!listId && !DIRECTORIES.includes(requestedDirectory)) || (requestedDirectory != null && !DIRECTORIES.includes(requestedDirectory))) return problem(reply, 400, 'Choose one of the six directories, or a list.');
    const directory = listId ? null : requestedDirectory;
    if (listId != null && (typeof listId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listId))) return problem(reply, 400, 'Choose a valid list.');
    const sort = request.query?.sort === 'updated' ? 'updated' : 'name';
    if (request.query?.sort != null && !['name', 'updated'].includes(request.query.sort)) return problem(reply, 400, 'Sort by name or updated.');
    const page = Number(request.query?.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) return problem(reply, 400, 'Page must be a whole number from 1 to 1000.');
    const q = text(request.query?.q ?? '', 200);
    const listing = await store.listResearchDirectory({ ...where(request), projectId: request.params.projectId, directory, listId, q, sort, page, pageSize: PAGE_SIZE });
    if (!listing) return problem(reply, 404, 'Not found.');
    return { ...listing, directory, listId, q, sort };
  });

  app.get(`${base}/projects/:projectId/quality`, get(reader), async (request, reply) => {
    const quality = await store.researchQuality({ ...where(request), projectId: request.params.projectId });
    if (!quality) return problem(reply, 404, 'Not found.');
    return { ...quality, staleAfterDays: STALE_MS / (24 * 60 * 60 * 1000) };
  });

  app.post(`${base}/projects/:projectId/checklist`, post(writer), async (request, reply) => {
    const checklist = request.body?.checklist;
    if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist) || !Object.keys(checklist).length || !Object.entries(checklist).every(([key, value]) => CHECKLIST_KEYS.includes(key) && typeof value === 'boolean')) return problem(reply, 400, 'Provide checklist items as true or false.');
    const current = await store.getResearchProject({ ...where(request), projectId: request.params.projectId });
    if (!current) return problem(reply, 404, 'Not found.');
    try {
      const project = await store.updateResearchProject({
        ...where(request), projectId: request.params.projectId,
        patch: { checklist },
      });
      return { project };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/projects/:projectId/lists`, post(writer), async (request, reply) => {
    const name = text(request.body?.name, 120);
    if (!name) return problem(reply, 400, 'A list needs a name.');
    try {
      const list = await store.addResearchList({ ...where(request), projectId: request.params.projectId, createdBy: request.user.id, name, purpose: text(request.body?.purpose, 500) });
      return { list };
    } catch (err) { return fail(reply, err); }
  });

  app.get(`${base}/projects/:projectId/exports`, get(reader), async (request, reply) => {
    const directory = request.query?.directory;
    if (directory != null && !DIRECTORIES.includes(directory)) return problem(reply, 400, 'Choose one of the six directories.');
    const rows = await store.listResearchExport({ ...where(request), projectId: request.params.projectId, directory: directory ?? null, listId: request.query?.listId ?? null });
    if (!rows) return problem(reply, 404, 'Not found.');
    return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="research.csv"').send(toCsv(rows));
  });

  app.get(`${base}/entities/:entityId`, get(reader), async (request, reply) => {
    const detail = await store.getResearchEntity({ ...where(request), entityId: request.params.entityId });
    if (!detail) return problem(reply, 404, 'Not found.');
    return { ...flags(request.role), ...detail };
  });

  app.post(`${base}/entities/:entityId/corrections`, post(writer), async (request, reply) => {
    const field = text(request.body?.field, 80);
    const value = text(request.body?.value, 2000);
    const excerpt = text(request.body?.excerpt, 2000);
    if (!/^[a-z0-9_]{1,80}$/.test(field) || !value || !excerpt) return problem(reply, 400, 'A correction needs a field, a value and an excerpt.');
    try {
      const claim = await store.correctResearchClaim({ ...where(request), entityId: request.params.entityId, actorId: request.user.id, field, value, excerpt });
      return { claim };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/lists/:listId/items`, post(writer), async (request, reply) => {
    const entityId = text(request.body?.entityId, 80);
    if (!entityId) return problem(reply, 400, 'Say which record to add.');
    try {
      const item = await store.addResearchListItem({ ...where(request), listId: request.params.listId, entityId, note: text(request.body?.note, 500) });
      return { item };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/lists/:listId/items/:entityId/remove`, post(writer), async (request, reply) => {
    try {
      await store.removeResearchListItem({ ...where(request), listId: request.params.listId, entityId: request.params.entityId });
      return { ok: true };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/projects/:projectId/runs`, post(writer), async (request, reply) => {
    const body = request.body ?? {};
    const question = text(body.question, 2000);
    if (!question) return problem(reply, 400, 'A run needs a question.');
    const search = body.search ?? 'none';
    if (!['none', 'wikimedia'].includes(search)) return problem(reply, 400, 'Paid web search is not configured. Choose Wikimedia or supply https URLs.');
    const rawUrls = body.urls == null ? [] : body.urls;
    if (!Array.isArray(rawUrls) || rawUrls.length > 5) return problem(reply, 400, 'A run fetches at most 5 https URLs.');
    const urls = [];
    for (const value of rawUrls) {
      const url = publicHttps(value);
      if (!url) return problem(reply, 400, 'Every source must be an https URL on port 443, with no username or password.');
      if (!urls.includes(url)) urls.push(url);
    }
    const directory = DIRECTORIES.includes(body.directory) ? body.directory : 'companies';
    if (body.directory != null && !DIRECTORIES.includes(body.directory)) return problem(reply, 400, 'Choose one of the six directories.');
    const maxUrls = Math.min(5, Math.max(urls.length, search === 'wikimedia' ? 3 : 0));
    try {
      const run = await store.createResearchRun({
        ...where(request), projectId: request.params.projectId, createdBy: request.user.id, question,
        scope: { directory },
        limits: { maxUrls },
        permissions: { urlFetch: true, wikimedia: search === 'wikimedia', paidSearch: false, shell: false, model: false, urls },
      });
      return { run };
    } catch (err) { return fail(reply, err); }
  });

  app.get(`${base}/runs/:runId`, get(reader), async (request, reply) => {
    await recover(request.params.workspaceId);
    const detail = await store.getResearchRun({ ...where(request), runId: request.params.runId });
    if (!detail) return problem(reply, 404, 'Not found.');
    return { ...flags(request.role), ...detail };
  });

  app.post(`${base}/runs/:runId/cancel`, post(writer), async (request, reply) => {
    try {
      const run = await cancel(request.params.workspaceId, request.params.runId);
      return { run };
    } catch (err) { return fail(reply, err); }
  });

  app.post(`${base}/runs/:runId/start`, post(writer), async (request, reply) => {
    const workspaceId = request.params.workspaceId;
    const runId = request.params.runId;
    const key = runKey(workspaceId, runId);
    if (active.has(key)) return problem(reply, 409, 'This run is already active.', { code: 'invalid_state' });
    const controller = new AbortController();
    active.set(key, controller);
    const disconnected = () => {
      if (!reply.raw.writableEnded) void cancel(workspaceId, runId).catch(() => controller.abort());
    };
    reply.raw.once('close', disconnected);
    const settle = async (status, output, error) => {
      try {
        return await store.finishResearchRun({ workspaceId, runId, status, output, error });
      } catch (err) {
        if (err instanceof StoreError && err.code === 'invalid_state') {
          const current = await store.getResearchRun({ workspaceId, runId });
          if (current) return current.run;
        }
        throw err;
      }
    };
    try {
      await recover(workspaceId);
      const running = await store.markResearchRunRunning({ workspaceId, runId });
      const latest = await store.getResearchRun({ workspaceId, runId });
      if (controller.signal.aborted || latest?.run.status !== 'running') return { run: latest?.run ?? running };
      const urls = Array.isArray(running.permissions?.urls) ? running.permissions.urls : [];
      const wikimedia = running.permissions?.wikimedia === true;
      if (!urls.length && !wikimedia) {
        const run = await settle('failed', null, 'No public URL was supplied, and Wikimedia search was not selected. Nothing was fetched.');
        return { run };
      }
      let pages;
      try {
        let aborted;
        const stop = new Promise((_, reject) => {
          aborted = () => reject(new Error('cancelled'));
          controller.signal.addEventListener('abort', aborted, { once: true });
        });
        let result;
        try {
          result = await Promise.race([
            executor()({ question: running.question, urls, search: wikimedia ? 'wikimedia' : 'none', limits: running.limits }, { signal: controller.signal }),
            stop,
          ]);
        } finally { controller.signal.removeEventListener('abort', aborted); }
        pages = normalizePages(result?.pages);
      } catch (err) {
        const run = await settle(controller.signal.aborted ? 'cancelled' : 'failed', null, controller.signal.aborted ? 'Cancelled before a report was stored.' : researchWorkerMessage(err));
        return { run };
      }
      const current = await store.getResearchRun({ workspaceId, runId });
      if (!current || current.run.status !== 'running') {
        const run = await settle('failed', null, 'Cancelled before a report was stored.');
        return { run };
      }
      for (const page of pages) {
        const message = page.status === 'retrieved' ? `Retrieved ${page.finalUrl || page.url}` : `Failed ${page.url || 'a source'}: ${page.failure || page.status}`;
        await store.appendResearchRunEvent({ workspaceId, runId, kind: page.status === 'retrieved' ? 'source' : 'failure', message });
      }
      const report = reportFromPages({ question: running.question, pages, modelConfigured: modelConfigured() });
      if (!report.findings.length) {
        const run = await settle('failed', null, 'No retrieved page contained text this run could quote.');
        return { run };
      }
      const directory = DIRECTORIES.includes(running.scope?.directory) ? running.scope.directory : 'companies';
      const kind = directory === 'founders' ? 'person' : directory === 'tools' ? 'tool' : directory === 'repositories' ? 'repository' : 'organization';
      const output = { ...report, candidates: candidatesFromPages(pages, { directory, kind }) };
      const run = await settle('completed', output, null);
      return { run };
    } catch (err) { return fail(reply, err); }
    finally {
      reply.raw.off('close', disconnected);
      if (active.get(key) === controller) active.delete(key);
    }
  });

  app.post(`${base}/runs/:runId/accept`, post(writer), async (request, reply) => {
    const keys = request.body?.externalKeys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 20) return problem(reply, 400, 'Choose at least one candidate from this run.');
    const detail = await store.getResearchRun({ ...where(request), runId: request.params.runId });
    if (!detail) return problem(reply, 404, 'Not found.');
    if (detail.run.status !== 'completed' || !Array.isArray(detail.run.output?.candidates)) return problem(reply, 409, 'Accept findings only from a completed run that stored candidates.', { code: 'invalid_state' });
    const wanted = new Set(keys);
    const records = detail.run.output.candidates.filter((row) => wanted.has(row.externalKey));
    if (records.length !== wanted.size) return problem(reply, 400, 'Choose candidates stored on this run.');
    try {
      const summary = await store.importResearchRecords({ workspaceId: detail.run.workspaceId, projectId: detail.run.projectId, actorId: request.user.id, records, dryRun: false });
      if (summary.failed && !summary.importedEntities && !summary.importedClaims && !summary.skippedEntities && !summary.skippedClaims) {
        return problem(reply, 400, summary.errors?.[0] || 'None of the selected records could be saved.');
      }
      return { summary };
    } catch (err) { return fail(reply, err); }
  });
}
