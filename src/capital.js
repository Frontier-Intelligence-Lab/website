import { StoreError } from './store/index.js';
import { CASE_DECISIONS, COST_BASES, COST_CATEGORIES, COST_PERIODS, CREDIT_STATUSES, EVIDENCE_KINDS, LENDER_STAGES, MAX_AMOUNT_CENTS, MAX_COST_ITEMS, PLANNED, REFERENCE_KINDS, buildEvidencePackage, capitalSnapshot, emptyDraft, totalsByBasis, validateCapitalDraft, validateCaseFields, validateCreditRecord, validateEvidence } from './lib/capital.js';
import { isHash, snapshotHash } from './lib/capital-hash.js';

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const CONSTANTS = { categories: COST_CATEGORIES, periods: COST_PERIODS, bases: COST_BASES, creditStatuses: CREDIT_STATUSES, evidenceKinds: EVIDENCE_KINDS, referenceKinds: REFERENCE_KINDS, lenderStages: LENDER_STAGES, maxAmountCents: MAX_AMOUNT_CENTS, maxCostItems: MAX_COST_ITEMS, planned: PLANNED };
const STAFF_STATUSES = ['submitted', 'changes_requested', 'evidence_reviewed'];

/**
 * Capital: a cost plan, external credit records, a company financing request and its evidence, per organization.
 * Owners, admins and finance members read and edit; owners and admins send an exact revision to Valcairn's internal
 * review. Staff see only what was sent, and can request changes or mark evidence reviewed on that revision; no lender,
 * credit decision or money movement exists here, and nothing is sent anywhere unless the customer sends or exports it.
 */
export function registerCapitalRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, verified, member, post, get, fail } = guards;
  const base = '/api/workspaces/:workspaceId/capital';

  // Financing needs an organization: a personal workspace has no capital module.
  const organization = async (request, reply) => {
    const workspace = await store.getWorkspace(request.params.workspaceId);
    if (workspace?.kind !== 'organization') return problem(reply, 404, 'Not found.');
    request.workspace = workspace;
  };
  const reader = [signedIn, member('readCapital'), organization];
  const writer = [signedIn, member('writeCapital'), organization];
  const sender = [signedIn, member('manageMembers'), organization];
  // Valcairn staff (STAFF_EMAILS) with a confirmed email. Everyone else, demo reviewer accounts included, gets 404.
  const staff = async (request, reply) => {
    if (!config.staffEmails.includes(request.user.email)) return problem(reply, 404, 'Not found.');
  };
  const staffOnly = [signedIn, verified, staff];
  const loadCase = async (request, reply) => {
    const kase = await store.getCapitalCase({ workspaceId: request.params.workspaceId, caseId: request.params.caseId });
    if (!kase) return problem(reply, 404, 'Not found.');
    request.kase = kase;
  };
  const invalid = (reply, errors, message = 'Check the highlighted fields.') => problem(reply, 400, message, { errors });
  const storeFail = (reply, err) => {
    if (!(err instanceof StoreError)) return fail(reply, err);
    if (err.code === 'stale_revision' && err.message === 'content') return problem(reply, 409, 'The evidence or credit records changed since you opened this page. Reload and review again before sending.', { code: 'content_changed' });
    if (err.code === 'stale_revision') return problem(reply, 409, 'Someone saved a newer revision of this case. Reload to see it before changing anything.', { code: 'stale_revision' });
    if (err.code === 'invalid_state') return problem(reply, 409, 'This case is with Valcairn’s internal review. It cannot change until the review is done or it is withdrawn.', { code: 'case_submitted' });
    if (err.code === 'evidence_in_use') return problem(reply, 409, 'A cost item cites this record. Change that item first.', { code: 'evidence_in_use' });
    if (err.code === 'missing_reference') return problem(reply, 409, 'A record this plan cites was removed. Reload the page and check the plan.', { code: 'missing_reference' });
    if (err.code === 'not_found') return problem(reply, 404, 'Not found.');
    return fail(reply, err);
  };
  const revisionOf = (body) => (Number.isSafeInteger(body?.expectedRevision) && body.expectedRevision >= 1 ? body.expectedRevision : null);
  const summary = (kase) => ({ id: kase.id, title: kase.title, status: kase.status, revision: kase.revision, submittedRevision: kase.submittedRevision, projectId: kase.projectId, enhanceRunId: kase.enhanceRunId, requestedAmountCents: kase.draft.requestedAmountCents ?? null, totals: totalsByBasis(kase.draft.costItems), createdAt: kase.createdAt, updatedAt: kase.updatedAt });
  const withoutSnapshot = ({ snapshot, ...submission }) => submission;
  // Marks go to customers without the reviewer's user id.
  const shownMark = ({ id, submissionId, evidenceId, createdAt }) => ({ id, submissionId, evidenceId, createdAt });

  // What a case may link to or cite, all of this workspace: projects, enhance plans, frozen dataset versions, the
  // person's own measured device runs (client-reported) and current credit records.
  const optionsFor = async (workspaceId, userId) => {
    const [projects, runs, devices, credits] = await Promise.all([store.listProjects(workspaceId), store.listEnhanceRuns(workspaceId), store.listDevices({ workspaceId, ownerId: userId }), store.listCreditRecords(workspaceId)]);
    const versions = [];
    for (const p of projects) {
      for (const v of await store.listDatasetVersions({ workspaceId, projectId: p.id })) versions.push({ projectId: p.id, projectName: p.name, version: v.number, reviewId: v.manifest?.reviewId ?? null, files: v.manifest?.files?.length ?? 0, createdAt: v.createdAt });
    }
    const benchmarks = [];
    for (const d of devices) {
      for (const r of await store.listExecutionRuns({ workspaceId, ownerId: userId, deviceId: d.id, limit: 50 })) benchmarks.push({ deviceId: d.id, deviceLabel: d.label, runId: r.id, modelRef: r.modelRef, modelDigest: r.modelDigest, kind: r.kind, status: r.status, warm: r.warm, metrics: r.metrics, task: r.task, createdAt: r.createdAt });
    }
    return {
      projects: projects.map(({ id, name, status }) => ({ id, name, status })),
      runs: runs.map(({ id, name, baseModelId, status, requestedAt }) => ({ id, name, baseModelId, status, requestedAt })),
      versions, benchmarks, credits: credits.filter((c) => !c.supersededBy), constants: CONSTANTS,
    };
  };

  app.get(base, get(reader), async (request) => {
    const { workspaceId } = request.params;
    const [cases, credits, options] = await Promise.all([store.listCapitalCases(workspaceId), store.listCreditRecords(workspaceId), optionsFor(workspaceId, request.user.id)]);
    return { role: request.role, cases: cases.map(summary), credits, options };
  });

  app.post(`${base}/cases`, post(writer), async (request, reply) => {
    const { workspaceId } = request.params;
    const fields = validateCaseFields(request.body, await optionsFor(workspaceId, request.user.id));
    if (fields.errors) return invalid(reply, fields.errors);
    try { return { case: await store.createCapitalCase({ workspaceId, createdBy: request.user.id, ...fields.values, draft: emptyDraft() }) }; }
    catch (err) { return storeFail(reply, err); }
  });

  // The consent view: the case with its evidence and credit records, and the hash of exactly what sending would
  // freeze. This is the only response that carries a content hash; consent is given on what this view shows.
  app.get(`${base}/cases/:caseId`, get([...reader, loadCase]), async (request) => {
    const { workspaceId } = request.params;
    const where = { workspaceId, caseId: request.kase.id };
    const [submissions, evidence, credits, marks, options] = await Promise.all([store.listCapitalSubmissions(where), store.listCapitalEvidence(where), store.listCreditRecords(workspaceId), store.listCapitalReviewMarks(where), optionsFor(workspaceId, request.user.id)]);
    return { role: request.role, case: request.kase, contentHash: snapshotHash(capitalSnapshot(request.kase, credits, evidence)), submissions: submissions.map(withoutSnapshot), evidence, credits, marks: marks.map(shownMark), options };
  });

  // Saving names the revision that was edited. The store refuses a different one, so two people cannot overwrite each
  // other. A save returns no content hash: sending needs the consent view, never a save response.
  app.post(`${base}/cases/:caseId`, post([...writer, loadCase]), async (request, reply) => {
    const { workspaceId } = request.params;
    const { kase } = request;
    const body = request.body ?? {};
    const expectedRevision = revisionOf(body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you edited (expectedRevision).');
    if (kase.status === 'submitted') return storeFail(reply, new StoreError('invalid_state'));
    const [options, evidence] = await Promise.all([optionsFor(workspaceId, request.user.id), store.listCapitalEvidence({ workspaceId, caseId: kase.id })]);
    const fields = validateCaseFields({ title: body.title ?? kase.title, projectId: 'projectId' in body ? body.projectId : kase.projectId, enhanceRunId: 'enhanceRunId' in body ? body.enhanceRunId : kase.enhanceRunId }, options);
    const draft = validateCapitalDraft(body.draft ?? kase.draft, { versions: options.versions, evidenceIds: new Set(evidence.map((e) => e.id)) });
    if (fields.errors || draft.errors) return invalid(reply, { ...fields.errors, ...draft.errors });
    try {
      const saved = await store.updateCapitalCase({ workspaceId, caseId: kase.id, expectedRevision, ...fields.values, draft: draft.values });
      await store.recordAudit({ workspaceId, actorId: request.user.id, action: 'capital_case.updated', targetType: 'capital_case', targetId: saved.id, metadata: { revision: saved.revision } });
      return { case: saved };
    } catch (err) { return storeFail(reply, err); }
  });

  // Sending is the customer's explicit choice: this exact revision and content (the hash covers the draft, links,
  // evidence and credit records as they will be frozen), by an owner or admin, to Valcairn's internal review and
  // nowhere else. The store rechecks both under the lock; a retry of the same revision and content returns the same submission.
  app.post(`${base}/cases/:caseId/submit`, post([...sender, loadCase]), async (request, reply) => {
    const { workspaceId } = request.params;
    const { kase } = request;
    const body = request.body ?? {};
    const expectedRevision = revisionOf(body);
    if (expectedRevision == null) return problem(reply, 400, 'Say which revision you are sending (expectedRevision).');
    if (!isHash(body.contentHash)) return problem(reply, 400, 'Say which content you reviewed (contentHash).', { code: 'content_hash_required' });
    if (body.sendToReview !== true) return problem(reply, 400, 'Confirm that you want to send this revision to Valcairn’s internal review.', { code: 'consent_required' });
    if (kase.status === 'submitted' && kase.submittedRevision !== expectedRevision) return storeFail(reply, new StoreError('invalid_state'));
    if (kase.status !== 'submitted') {
      if (kase.revision !== expectedRevision) return storeFail(reply, new StoreError('stale_revision'));
      const [options, evidence] = await Promise.all([optionsFor(workspaceId, request.user.id), store.listCapitalEvidence({ workspaceId, caseId: kase.id })]);
      const check = validateCapitalDraft(kase.draft, { versions: options.versions, evidenceIds: new Set(evidence.map((e) => e.id)), forSubmit: true });
      if (check.errors) return invalid(reply, check.errors, 'Finish the request before you send it.');
    }
    try {
      const submission = await store.submitCapitalCase({ workspaceId, caseId: kase.id, submittedBy: request.user.id, expectedRevision, contentHash: body.contentHash });
      return { submission: withoutSnapshot(submission), case: await store.getCapitalCase({ workspaceId, caseId: kase.id }) };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This revision was already sent. Change something to make a new revision before sending again.', { code: 'revision_sent' });
      return storeFail(reply, err);
    }
  });

  app.post(`${base}/cases/:caseId/withdraw`, post([...sender, loadCase]), async (request, reply) => {
    try { return { case: await store.withdrawCapitalCase({ workspaceId: request.params.workspaceId, caseId: request.kase.id, actorId: request.user.id }) }; }
    catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This case is not with internal review.', { code: 'not_submitted' });
      return storeFail(reply, err);
    }
  });

  // Evidence is a bounded reference to something that exists; the cited facts are copied in. Files are never accepted here.
  app.post(`${base}/cases/:caseId/evidence`, post([...writer, loadCase]), async (request, reply) => {
    const { workspaceId } = request.params;
    const result = validateEvidence(request.body, await optionsFor(workspaceId, request.user.id));
    if (result.errors) return invalid(reply, result.errors);
    try {
      const item = await store.addCapitalEvidence({ workspaceId, caseId: request.kase.id, createdBy: request.user.id, item: result.values });
      await store.recordAudit({ workspaceId, actorId: request.user.id, action: 'capital_evidence.added', targetType: 'capital_evidence', targetId: item.id, metadata: { caseId: request.kase.id, kind: item.kind } });
      return { evidence: item };
    } catch (err) { return storeFail(reply, err); }
  });

  // The store refuses, on the locked case row, to delete a record an incurred cost item cites.
  app.post(`${base}/cases/:caseId/evidence/:evidenceId/delete`, post([...writer, loadCase]), async (request, reply) => {
    const { workspaceId } = request.params;
    try {
      await store.deleteCapitalEvidence({ workspaceId, caseId: request.kase.id, evidenceId: request.params.evidenceId });
      await store.recordAudit({ workspaceId, actorId: request.user.id, action: 'capital_evidence.removed', targetType: 'capital_evidence', targetId: request.params.evidenceId, metadata: { caseId: request.kase.id } });
      return { ok: true };
    } catch (err) { return storeFail(reply, err); }
  });

  // The package the customer may hand to a lender themselves: the sent revision exactly as frozen, with staff
  // annotations kept apart; or the live draft, labelled as such. Reading it is recorded; Valcairn sends it nowhere.
  app.get(`${base}/cases/:caseId/export`, get([...reader, loadCase]), async (request, reply) => {
    const { workspaceId } = request.params;
    const where = { workspaceId, caseId: request.kase.id };
    const [submissions, evidence, credits, marks] = await Promise.all([store.listCapitalSubmissions(where), store.listCapitalEvidence(where), store.listCreditRecords(workspaceId), store.listCapitalReviewMarks(where)]);
    const submission = submissions.findLast((s) => s.decision !== 'withdrawn') ?? null;
    const revision = submission?.revision ?? request.kase.revision;
    await store.recordAudit({ workspaceId, actorId: request.user.id, action: 'capital.exported', targetType: 'capital_case', targetId: request.kase.id, metadata: { basis: submission ? 'submitted_revision' : 'draft', revision } });
    const safe = (submission?.snapshot.title ?? request.kase.title).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'capital';
    reply.header('content-disposition', `attachment; filename="${safe}-evidence-r${revision}.json"`);
    return buildEvidencePackage({ workspace: request.workspace, kase: request.kase, submission, marks, evidence, credits, exportedBy: request.user, exportedAt: new Date().toISOString() });
  });

  // External credits as the customer states them. A correction is a new record; the old one stays on record.
  app.post(`${base}/credits`, post(writer), async (request, reply) => {
    const { workspaceId } = request.params;
    const result = validateCreditRecord(request.body);
    if (result.errors) return invalid(reply, result.errors);
    const supersedes = request.body?.supersedes == null ? null : typeof request.body.supersedes === 'string' ? request.body.supersedes : undefined;
    if (supersedes === undefined) return problem(reply, 400, 'supersedes must be the id of the record you are correcting.');
    try { return { credit: await store.createCreditRecord({ workspaceId, createdBy: request.user.id, record: result.values, supersedes }) }; }
    catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'That record was already corrected. Correct its latest version instead.', { code: 'already_corrected' });
      return storeFail(reply, err);
    }
  });

  // Internal review queue. Staff see only what was sent, as frozen in that submission: never a live draft, title,
  // evidence or credit record added since. Decisions and marks name the submission the reviewer saw. Reading a case
  // is recorded in the customer's audit log.
  const staffSummary = (c) => ({
    id: c.id, workspaceId: c.workspaceId, workspaceName: c.workspaceName, status: c.status, revision: c.revision, submittedRevision: c.submittedRevision, updatedAt: c.updatedAt,
    title: c.latestSubmission?.snapshot.title ?? null, requestedAmountCents: c.latestSubmission?.snapshot.draft.requestedAmountCents ?? null,
    latestSubmission: c.latestSubmission ? withoutSnapshot(c.latestSubmission) : null,
  });
  const loadForReview = async (request, reply) => {
    const found = await store.getCapitalCaseForReview(request.params.caseId);
    if (!found || found.case.status === 'draft' || !found.submission) return problem(reply, 404, 'Not found.');
    request.review = found;
  };
  // Reviews must be independent: staff cannot decide on a workspace they belong to.
  const independent = async (request, reply) => {
    if (await store.getMembership(request.review.workspace.id, request.user.id)) return problem(reply, 403, 'You belong to this workspace, so another reviewer must decide.', { code: 'conflict_of_interest' });
  };
  const submissionOf = (body) => (typeof body?.submissionId === 'string' ? body.submissionId : null);
  const reviewFail = (reply, err) => {
    if (err instanceof StoreError && err.code === 'stale_revision') return problem(reply, 409, 'The customer withdrew or sent a newer revision since you opened this case. Reload and review the current one; nothing was decided.', { code: 'stale_submission' });
    if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This case is not waiting for review.', { code: 'not_submitted' });
    return storeFail(reply, err);
  };

  app.get('/api/staff/capital', get(staffOnly), async (request) => {
    const status = STAFF_STATUSES.includes(request.query?.status) ? request.query.status : 'submitted';
    return { cases: (await store.listCapitalCasesForReview({ status })).map(staffSummary) };
  });

  app.get('/api/staff/capital/:caseId', get([...staffOnly, loadForReview]), async (request) => {
    const { case: kase, workspace, submission, marks } = request.review;
    await store.recordAudit({ workspaceId: workspace.id, actorId: request.user.id, action: 'capital.review_opened', targetType: 'capital_case', targetId: kase.id, metadata: { submissionId: submission.id, revision: submission.revision } });
    return { case: kase, workspace, submission, marks: marks.map(shownMark), conflict: Boolean(await store.getMembership(workspace.id, request.user.id)), constants: CONSTANTS };
  });

  app.post('/api/staff/capital/:caseId/decision', post([...staffOnly, loadForReview, independent]), async (request, reply) => {
    const decision = CASE_DECISIONS.includes(request.body?.decision) ? request.body.decision : null;
    const notes = text(request.body?.notes, 4000) || null;
    const submissionId = submissionOf(request.body);
    if (!decision) return problem(reply, 400, 'Choose "request changes" or "evidence reviewed". Lender decisions are not made here.');
    if (!submissionId) return problem(reply, 400, 'Say which submission you reviewed (submissionId).');
    if (decision === 'changes_requested' && !notes) return problem(reply, 400, 'Tell the customer what to change.', { errors: { notes: 'Required when requesting changes.' } });
    try { return { submission: withoutSnapshot(await store.decideCapitalSubmission({ caseId: request.review.case.id, submissionId, reviewerId: request.user.id, decision, notes })) }; }
    catch (err) { return reviewFail(reply, err); }
  });

  app.post('/api/staff/capital/:caseId/evidence/:evidenceId/review', post([...staffOnly, loadForReview, independent]), async (request, reply) => {
    const submissionId = submissionOf(request.body);
    if (!submissionId) return problem(reply, 400, 'Say which submission you reviewed (submissionId).');
    try { return { mark: shownMark(await store.markCapitalEvidenceReviewed({ caseId: request.review.case.id, submissionId, evidenceId: request.params.evidenceId, reviewerId: request.user.id })) }; }
    catch (err) { return reviewFail(reply, err); }
  });
}
