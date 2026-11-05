import { StoreError } from './store/index.js';
import { isHash } from './lib/capital-hash.js';
import { LIMITATIONS, NORMALIZATION, PLANNED, PURPOSES, SCORE_BASES, SCORER_ID, mapBlindDecisions, publicBatch, toReviewView } from './lib/eval.js';

const IMPORT_BODY = 300 * 1024;

/**
 * Evaluation of imported answers. Owners, admins, members, finance and viewers of the workspace can read.
 * Owners, admins and members edit drafts, import predictions and record review. Only an owner or admin can
 * freeze a set or approve a report. Staff who are not members get the same 404 as anyone else: there is no
 * staff queue for private drafts. Nothing here calls a model.
 */
export function registerEvalRoutes(app, { store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId/projects/:projectId/evaluations';
  const reader = [signedIn, member('readProjects')];
  const writer = [signedIn, member('writeProjects')];
  const approver = [signedIn, member('manageMembers')];

  const storeFail = (reply, err) => {
    if (!(err instanceof StoreError)) return fail(reply, err);
    if (err.code === 'not_found') return problem(reply, 404, 'Not found.');
    if (err.code === 'forbidden') return problem(reply, 403, 'Your role does not allow this.');
    if (err.code === 'stale_revision' && err.message === 'content') {
      return problem(reply, 409, 'The results changed since you opened this page. Reload and review the decision again before approving.', { code: 'content' });
    }
    if (err.code === 'stale_revision') return problem(reply, 409, 'Someone saved a newer revision. Reload to see it before changing anything.', { code: 'stale_revision' });
    if (err.code === 'issues_open') return problem(reply, 409, err.message, { code: 'issues_open', open: err.open });
    if (err.code === 'quota_exceeded') return problem(reply, 409, err.message, { code: 'quota_exceeded' });
    if (err.code === 'invalid_state') return problem(reply, 409, err.message, { code: 'invalid_state' });
    if (err.code === 'invalid_import') return problem(reply, 400, err.message, { code: 'invalid_import' });
    return fail(reply, err);
  };
  const revisionOf = (body) => (Number.isSafeInteger(body?.expectedRevision) && body.expectedRevision >= 1 ? body.expectedRevision : null);
  const where = (request) => ({ workspaceId: request.params.workspaceId, projectId: request.params.projectId });
  const flags = (role) => ({
    role,
    canWrite: ['owner', 'admin', 'member'].includes(role),
    canApprove: ['owner', 'admin'].includes(role),
  });
  const presentVersion = (version) => ({ ...version, batches: (version.batches ?? []).map(publicBatch) });
  const presentReport = ({ snapshot, ...report }) => report;
  const presentSet = (detail, role) => ({
    ...flags(role),
    set: detail.set,
    cases: detail.cases,
    notes: detail.notes,
    issues: detail.issues,
    counts: detail.counts,
    sources: detail.sources,
    versions: detail.versions.map(presentVersion),
    comparisons: detail.comparisons,
    reports: detail.reports.map(presentReport),
    scorer: SCORER_ID,
    purposes: PURPOSES,
    scoreBases: SCORE_BASES,
    normalization: NORMALIZATION,
    limitations: LIMITATIONS,
    planned: PLANNED,
  });
  const loadSet = async (request, reply) => {
    const detail = await store.getEvalSet({ ...where(request), setId: request.params.setId });
    if (!detail) return problem(reply, 404, 'Not found.');
    request.evalSet = detail;
  };
  const loadComparison = async (request, reply) => {
    const detail = await store.readEvalComparison({ workspaceId: request.params.workspaceId, comparisonId: request.params.comparisonId });
    if (!detail || detail.version.projectId !== request.params.projectId) return problem(reply, 404, 'Not found.');
    request.comparisonDetail = detail;
  };
  // The review screen never receives labels, system claims or the saved left/right assignment while identities are hidden.
  const reviewPayload = (detail, role) => {
    const hidden = detail.comparison.blind?.hideIdentity === true;
    const comparison = {
      id: detail.comparison.id,
      setId: detail.comparison.setId,
      versionId: detail.comparison.versionId,
      revision: detail.comparison.revision,
      acceptance: detail.comparison.acceptance,
      blind: hidden ? { hideIdentity: true } : detail.comparison.blind,
      ...(hidden ? {} : { baselineBatchId: detail.comparison.baselineBatchId, candidateBatchId: detail.comparison.candidateBatchId }),
    };
    const { rows, ...summary } = detail.built;
    return {
      ...flags(role),
      comparison,
      summary,
      review: toReviewView({ comparison: detail.comparison, rows }),
      ...(hidden ? {} : { baseline: publicBatch(detail.baselineBatch), candidate: publicBatch(detail.candidateBatch) }),
    };
  };

  app.get(base, get(reader), async (request, reply) => {
    const scope = where(request);
    if (!await store.getProject(scope)) return problem(reply, 404, 'Not found.');
    const [sets, sources] = await Promise.all([store.listEvalSets(scope), store.listEvalSources(scope.workspaceId)]);
    return { ...flags(request.role), sets, sources, purposes: PURPOSES, planned: PLANNED, scorer: SCORER_ID, normalization: NORMALIZATION, limitations: LIMITATIONS };
  });

  app.post(base, post(writer), async (request, reply) => {
    try {
      const set = await store.createEvalSet({ ...where(request), createdBy: request.user.id, name: request.body?.name, purpose: request.body?.purpose });
      return { set };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/:setId`, get([...reader, loadSet]), async (request) => presentSet(request.evalSet, request.role));

  app.post(`${base}/:setId`, post([...writer, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    const body = request.body ?? {};
    const patch = {};
    if ('name' in body) patch.name = body.name;
    if ('purpose' in body) patch.purpose = body.purpose;
    if ('acceptance' in body) patch.acceptance = body.acceptance;
    if ('rubricVersion' in body) patch.rubricVersion = body.rubricVersion;
    try {
      const set = await store.updateEvalSet({ ...where(request), setId: request.params.setId, expectedRevision, patch });
      return { set };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/cases`, post([...writer, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    const caseId = request.body?.caseId == null || request.body.caseId === '' ? null : request.body.caseId;
    if (caseId != null && typeof caseId !== 'string') return problem(reply, 400, 'caseId must be the id of the case you are editing.');
    try {
      const saved = await store.saveEvalCase({ ...where(request), setId: request.params.setId, expectedRevision, caseId, input: request.body?.case ?? request.body });
      return { case: saved };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/cases/:caseId/delete`, post([...writer, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    try {
      await store.deleteEvalCase({ ...where(request), setId: request.params.setId, caseId: request.params.caseId, expectedRevision });
      return { ok: true };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/import`, { ...post([...writer, loadSet]), bodyLimit: IMPORT_BODY }, async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    if (typeof request.body?.jsonl !== 'string') return problem(reply, 400, 'Send the cases as UTF-8 JSONL text in jsonl. Nothing was saved.');
    try {
      return await store.importEvalCases({ ...where(request), setId: request.params.setId, expectedRevision, jsonl: request.body.jsonl });
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/issues/note`, post([...writer, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    if (typeof request.body?.key !== 'string' || !request.body.key) return problem(reply, 400, 'Name the finding you are acknowledging.');
    try {
      const note = await store.setEvalIssueNote({ ...where(request), setId: request.params.setId, expectedRevision, key: request.body.key, note: request.body.note, createdBy: request.user.id });
      return { note };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/issues/note/delete`, post([...writer, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    try {
      await store.deleteEvalIssueNote({ ...where(request), setId: request.params.setId, expectedRevision, key: request.body?.key });
      return { ok: true };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/freeze`, post([...approver, loadSet]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you are freezing (expectedRevision).');
    try {
      const version = await store.freezeEvalSet({ ...where(request), setId: request.params.setId, expectedRevision, actorId: request.user.id });
      return { version: presentVersion(version) };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/reopen`, post([...writer, loadSet]), async (request, reply) => {
    try {
      const set = await store.reopenEvalSet({ ...where(request), setId: request.params.setId, actorId: request.user.id });
      return { set };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/:setId/versions/:versionId`, get([...reader, loadSet]), async (request, reply) => {
    const version = await store.getEvalVersion({ workspaceId: request.params.workspaceId, versionId: request.params.versionId });
    if (!version || version.setId !== request.params.setId || version.projectId !== request.params.projectId) return problem(reply, 404, 'Not found.');
    const batches = await store.listEvalBatches({ workspaceId: request.params.workspaceId, versionId: version.id });
    return { version: presentVersion({ ...version, batches }) };
  });

  app.post(`${base}/:setId/versions/:versionId/predictions`, { ...post([...writer, loadSet]), bodyLimit: IMPORT_BODY }, async (request, reply) => {
    if (typeof request.body?.jsonl !== 'string') return problem(reply, 400, 'Send the predictions as UTF-8 JSONL text in jsonl. Nothing was saved.');
    const version = await store.getEvalVersion({ workspaceId: request.params.workspaceId, versionId: request.params.versionId });
    if (!version || version.setId !== request.params.setId || version.projectId !== request.params.projectId) return problem(reply, 404, 'Not found.');
    const body = request.body ?? {};
    try {
      const result = await store.importEvalPredictions({
        ...where(request), versionId: request.params.versionId, role: body.role, label: body.label,
        claimedSystem: body.claimedSystem ?? {}, claimedScorer: body.claimedScorer, filename: body.filename,
        jsonl: body.jsonl, importedBy: request.user.id,
      });
      return { batch: publicBatch(result.batch), predictions: result.predictions, replayed: result.replayed };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/:setId/comparisons`, post([...writer, loadSet]), async (request, reply) => {
    const body = request.body ?? {};
    try {
      const comparison = await store.createEvalComparison({
        ...where(request), setId: request.params.setId, versionId: body.versionId,
        baselineBatchId: body.baselineBatchId, candidateBatchId: body.candidateBatchId, createdBy: request.user.id,
      });
      return { comparison };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/comparisons/:comparisonId`, get([...reader, loadComparison]), async (request) => reviewPayload(request.comparisonDetail, request.role));

  // Identities and the content hash, for the owner or admin who is about to approve. Members never receive the hash here.
  app.get(`${base}/comparisons/:comparisonId/preview`, get([...approver, loadComparison]), async (request) => {
    const detail = request.comparisonDetail;
    return {
      ...flags(request.role),
      comparison: detail.comparison,
      assignment: detail.comparison.blind,
      baseline: publicBatch(detail.baselineBatch),
      candidate: publicBatch(detail.candidateBatch),
      snapshot: detail.snapshot,
      contentHash: detail.contentHash,
    };
  });

  app.post(`${base}/comparisons/:comparisonId/blind`, post([...writer, loadComparison]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which comparison revision you edited (expectedRevision).');
    const body = request.body ?? {};
    try {
      const comparison = await store.setEvalBlind({
        workspaceId: request.params.workspaceId, comparisonId: request.params.comparisonId, expectedRevision,
        hideIdentity: body.hideIdentity === true, swap: body.swap === true, randomize: body.randomize === true,
      });
      return { comparison: comparison.blind?.hideIdentity ? { id: comparison.id, revision: comparison.revision, blind: { hideIdentity: true } } : comparison };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/comparisons/:comparisonId/judgments`, post([...writer, loadComparison]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which comparison revision you edited (expectedRevision).');
    const caseKey = typeof request.body?.caseKey === 'string' ? request.body.caseKey : '';
    if (!caseKey) return problem(reply, 400, 'Name the case you are reviewing.');
    let patch;
    try { patch = { ...mapBlindDecisions(request.comparisonDetail.comparison.blind, request.body ?? {}), note: request.body?.note }; }
    catch (err) { return storeFail(reply, err); }
    try {
      const saved = await store.recordEvalJudgment({
        workspaceId: request.params.workspaceId, comparisonId: request.params.comparisonId, expectedRevision, caseKey, patch, reviewerId: request.user.id,
      });
      if (request.comparisonDetail.comparison.blind?.hideIdentity === true) {
        return {
          comparison: { id: saved.comparison.id, revision: saved.comparison.revision, blind: { hideIdentity: true } },
          judgment: { caseKey: saved.judgment.caseKey, note: saved.judgment.note, updatedAt: saved.judgment.updatedAt },
        };
      }
      return saved;
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${base}/comparisons/:comparisonId/approve`, post([...approver, loadComparison]), async (request, reply) => {
    const expectedRevision = revisionOf(request.body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which comparison revision you are approving (expectedRevision).');
    if (!isHash(request.body?.contentHash)) return problem(reply, 400, 'Say which decision you reviewed (contentHash).');
    try {
      const report = await store.approveEvalReport({
        workspaceId: request.params.workspaceId, comparisonId: request.params.comparisonId, expectedRevision,
        contentHash: request.body.contentHash, approvedBy: request.user.id,
      });
      return { report: presentReport(report) };
    } catch (err) { return storeFail(reply, err); }
  });

  app.get(`${base}/reports/:reportId`, get(reader), async (request, reply) => {
    const report = await reportInProject(store, request.params);
    if (!report) return problem(reply, 404, 'Not found.');
    return { ...flags(request.role), report };
  });

  app.get(`${base}/reports/:reportId/export`, get(reader), async (request, reply) => {
    const report = await reportInProject(store, request.params);
    if (!report) return problem(reply, 404, 'Not found.');
    const approverUser = await store.getUserById(report.approvedBy);
    const safe = String(report.snapshot?.set?.name ?? 'evaluation').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'evaluation';
    reply.header('content-disposition', `attachment; filename="${safe}-report-r${report.revision}.json"`);
    return {
      schema: 'valcairn.eval-report.export.v1',
      reportId: report.id,
      contentHash: report.contentHash,
      approvedBy: { id: report.approvedBy, name: approverUser?.name ?? 'Unknown' },
      approvedAt: report.approvedAt,
      snapshot: report.snapshot,
    };
  });
}

async function reportInProject(store, { workspaceId, projectId, reportId }) {
  const report = await store.getEvalReport({ workspaceId, reportId });
  if (!report) return null;
  const detail = await store.readEvalComparison({ workspaceId, comparisonId: report.comparisonId });
  if (!detail || detail.version.projectId !== projectId) return null;
  return report;
}
