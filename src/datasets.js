import { randomBytes } from 'node:crypto';
import { StoreError } from './store/index.js';
import { signToken, verifyToken } from './lib/tokens.js';
import { createIngestClient } from './lib/ingest-client.js';

const GRANT_TTL_S = 10 * 60;
const DOWNLOAD_TTL_S = 5 * 60;
const CHECKS = ['rights', 'consent', 'labels', 'duplicates', 'format'];
const EDITABLE = ['draft', 'changes_requested'];
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Sample uploads (through services/ingest), Valcairn staff review, and dataset versions.
 * Files never pass through this server: it signs a grant, ingest streams the file to storage and
 * returns a signed receipt, and only receipts that verify here are recorded.
 */
export function registerDatasetRoutes(app, { config, store, helpers, guards, ingestClient }) {
  const { problem } = helpers;
  const { signedIn, verified, member, post, get, fail } = guards;
  const ingest = config.ingest;
  const client = ingest ? ingestClient ?? createIngestClient(ingest) : null;
  const limits = ingest ? { maxFiles: ingest.projectMaxFiles, maxBytes: ingest.projectMaxBytes } : {};

  const loadProject = async (request, reply) => {
    const project = await store.getProject({ workspaceId: request.params.workspaceId, projectId: request.params.projectId });
    if (!project) return problem(reply, 404, 'Not found.');
    request.project = project;
  };
  const uploadsOn = async (request, reply) => {
    if (!ingest) return problem(reply, 503, 'Sample uploads are not configured on this server.');
  };
  const staff = async (request, reply) => {
    if (!config.staffEmails.includes(request.user.email)) return problem(reply, 404, 'Not found.');
  };
  const approver = member('manageMembers');
  const locked = (reply) => problem(reply, 409, 'This project is locked while it is in review or approved. Withdraw or reopen it to make changes.', { code: 'project_locked' });
  const lockedOr = (reply, err) => (err instanceof StoreError && err.code === 'invalid_state' ? locked(reply) : fail(reply, err));
  // Deleting a stored object is best effort: a failure leaves an orphan for cleanup, never a broken record.
  const discard = (key) => client.remove(key).catch((err) => app.log.warn({ err: err.message }, 'could not delete stored object'));

  // One grant per file: ingest refuses a grant it has already used, so a grant cannot add files later.
  app.post('/api/workspaces/:workspaceId/projects/:projectId/upload-grant', { ...post([uploadsOn, signedIn, member('writeProjects'), loadProject]), config: { rateLimit: { max: 600, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { project } = request;
    if (project.startingPoint === 'model') return problem(reply, 400, 'This project starts from an existing model, so it has no data sample.');
    if (!EDITABLE.includes(project.status)) return locked(reply);
    const used = await store.listUploads({ workspaceId: project.workspaceId, projectId: project.id });
    const usedBytes = used.reduce((n, u) => n + u.sizeBytes, 0);
    if (used.length >= limits.maxFiles || usedBytes >= limits.maxBytes) return problem(reply, 409, `This project has reached its sample limit (${limits.maxFiles} files or ${Math.round(limits.maxBytes / 2 ** 30)} GB). Remove files or contact us.`, { code: 'quota_exceeded' });
    const maxBytes = Math.min(ingest.maxBytes, limits.maxBytes - usedBytes);
    const grant = signToken(ingest.secret, {
      v: 1, kind: 'upload', ws: project.workspaceId, project: project.id, by: request.user.id,
      maxBytes, exp: nowS() + GRANT_TTL_S, nonce: randomBytes(12).toString('base64url'),
    });
    return { uploadUrl: `${ingest.publicUrl}/v1/uploads`, grant, maxBytes };
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/uploads', post([uploadsOn, signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const receipt = verifyToken(ingest.secret, request.body?.receipt, 'receipt');
    // A receipt is only valid for the project, workspace and person its grant was issued to.
    if (!receipt || receipt.ws !== request.project.workspaceId || receipt.project !== request.project.id || receipt.by !== request.user.id) {
      return problem(reply, 400, 'That upload receipt is not valid. Upload the file again.');
    }
    if (!EDITABLE.includes(request.project.status)) return locked(reply);
    let objectKey;
    try {
      objectKey = await client.commit(receipt.objectKey);
    } catch (err) {
      request.log.error({ err: err.message }, 'ingest commit failed');
      return problem(reply, 503, 'The file was received but could not be saved. Please upload it again.');
    }
    try {
      const upload = await store.createUpload({
        workspaceId: receipt.ws, projectId: receipt.project, uploadedBy: request.user.id, objectKey, limits,
        sha256: receipt.sha256, sizeBytes: receipt.sizeBytes, contentType: receipt.contentType, filename: text(receipt.filename, 255) || 'file',
      });
      const { objectKey: _, ...shown } = upload;
      return { upload: shown };
    } catch (err) {
      // The store refused the record (locked, over quota, already recorded): do not keep the object.
      if (!(err instanceof StoreError && err.code === 'duplicate_upload')) discard(objectKey);
      if (err instanceof StoreError && err.code === 'quota_exceeded') return problem(reply, 409, 'This project has reached its sample limit.', { code: 'quota_exceeded' });
      return lockedOr(reply, err);
    }
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/uploads/:uploadId/delete', post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    try {
      const removed = await store.deleteUpload({ workspaceId: request.project.workspaceId, projectId: request.project.id, uploadId: request.params.uploadId, actorId: request.user.id });
      if (client) discard(removed.objectKey);
      return { ok: true };
    } catch (err) { return lockedOr(reply, err); }
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/submit', post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const { project } = request;
    if (project.startingPoint === 'model') return problem(reply, 400, 'Projects that start from a model are not reviewed as datasets.');
    if (project.startingPoint === 'unsure') return problem(reply, 400, 'Choose a starting point after your scoping call before submitting.');
    if (!project.dataSource) return problem(reply, 400, 'Record where the data came from first.');
    const uploads = await store.listUploads({ workspaceId: project.workspaceId, projectId: project.id });
    if (project.dataSource.mode === 'upload' && uploads.length === 0) return problem(reply, 400, 'Upload at least one sample file first.');
    try {
      const review = await store.submitForReview({ workspaceId: project.workspaceId, projectId: project.id, submittedBy: request.user.id });
      return { review: { id: review.id, status: review.status, files: review.snapshot.files.length } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This project is already in review or approved.');
      return fail(reply, err);
    }
  });

  // Withdrawing from review is open to editors; reopening an approved project voids the approval, so it needs an admin.
  app.post('/api/workspaces/:workspaceId/projects/:projectId/reopen', post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const { project } = request;
    if (['approved', 'versioned'].includes(project.status) && !['owner', 'admin'].includes(request.role)) return problem(reply, 403, 'Only owners and admins can reopen an approved project.');
    try {
      const reopened = await store.reopenProject({ workspaceId: project.workspaceId, projectId: project.id, actorId: request.user.id });
      return { project: reopened };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This project is already open for changes.');
      return fail(reply, err);
    }
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/dataset-versions', post([signedIn, approver, loadProject]), async (request, reply) => {
    try {
      // The store builds the manifest from the approved review snapshot, so it holds exactly what was reviewed.
      const version = await store.createDatasetVersion({ workspaceId: request.project.workspaceId, projectId: request.project.id, createdBy: request.user.id });
      return { version: { id: version.id, number: version.number, files: version.manifest.files.length, createdAt: version.createdAt } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'A version can be approved only once per Valcairn approval, and only while the project is approved.');
      return fail(reply, err);
    }
  });

  // Internal review queue for Valcairn staff (STAFF_EMAILS). Others get 404, as if it did not exist.
  app.get('/api/staff/reviews', get([signedIn, verified, staff]), async (request) => {
    const status = ['pending', 'approved', 'changes_requested'].includes(request.query?.status) ? request.query.status : 'pending';
    return { reviews: await store.listReviews({ status }) };
  });

  app.get('/api/staff/reviews/:reviewId', get([signedIn, verified, staff]), async (request, reply) => {
    const review = await store.getReview(request.params.reviewId);
    if (!review) return problem(reply, 404, 'Not found.');
    const where = { workspaceId: review.workspaceId, projectId: review.projectId };
    const [project, workspace, uploads] = await Promise.all([store.getProject(where), store.getWorkspace(review.workspaceId), store.listUploads(where)]);
    await store.recordAudit({ workspaceId: review.workspaceId, actorId: request.user.id, action: 'review.opened', targetType: 'project', targetId: review.projectId, metadata: { reviewId: review.id } });
    // Staff decide on the snapshot taken at submission; that is also what a dataset version will contain.
    const reviewed = review.snapshot ?? { task: project.task, success: project.success, dataSource: project.dataSource, files: [] };
    const duplicates = uploads.filter((u) => u.duplicateOf).length;
    const { snapshot, ...rest } = review;
    return {
      review: rest,
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      project: { ...project, task: reviewed.task, success: reviewed.success, dataSource: reviewed.dataSource },
      duplicatesExcluded: review.snapshot ? duplicates : 0,
      uploads: reviewed.files.map(({ objectKey, ...u }) => ({
        ...u,
        downloadUrl: ingest ? `${ingest.publicUrl}/v1/objects?token=${encodeURIComponent(signToken(ingest.secret, { v: 1, kind: 'download', key: objectKey, filename: u.filename, exp: nowS() + DOWNLOAD_TTL_S }))}` : null,
      })),
    };
  });

  app.post('/api/staff/reviews/:reviewId/decision', post([signedIn, verified, staff]), async (request, reply) => {
    const decision = ['approved', 'changes_requested'].includes(request.body?.decision) ? request.body.decision : null;
    const notes = text(request.body?.notes, 4000) || null;
    const raw = request.body?.checks && typeof request.body.checks === 'object' ? request.body.checks : {};
    const checks = Object.fromEntries(CHECKS.map((c) => [c, raw[c] === true]));
    if (!decision) return problem(reply, 400, 'Choose approve or request changes.');
    if (decision === 'changes_requested' && !notes) return problem(reply, 400, 'Tell the customer what to change.', { errors: { notes: 'Required when requesting changes.' } });
    if (decision === 'approved' && !CHECKS.every((c) => checks[c])) return problem(reply, 400, 'Every check must pass before approval.', { errors: { checks: 'Tick every check you confirmed.' } });
    const review = await store.getReview(request.params.reviewId);
    if (!review) return problem(reply, 404, 'Not found.');
    // Reviews must be independent: staff cannot decide on a workspace they belong to.
    if (await store.getMembership(review.workspaceId, request.user.id)) return problem(reply, 403, 'You belong to this workspace, so another reviewer must decide.', { code: 'conflict_of_interest' });
    try {
      const review = await store.decideReview({ reviewId: request.params.reviewId, reviewerId: request.user.id, decision, notes, checks });
      return { review };
    } catch (err) { return fail(reply, err); }
  });
}
