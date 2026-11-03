import { randomBytes } from 'node:crypto';
import { StoreError } from './store/index.js';
import { signToken, verifyToken } from './lib/tokens.js';

const GRANT_TTL_S = 10 * 60;
const DOWNLOAD_TTL_S = 5 * 60;
const CHECKS = ['rights', 'consent', 'labels', 'duplicates', 'format'];
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Sample uploads (through services/ingest), Valcairn staff review, and dataset versions.
 * Files never pass through this server: it signs a grant, ingest streams the file to storage and
 * returns a signed receipt, and only receipts that verify here are recorded.
 */
export function registerDatasetRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, verified, member, post, get, fail } = guards;
  const ingest = config.ingest;

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

  app.post('/api/workspaces/:workspaceId/projects/:projectId/upload-grant', post([uploadsOn, signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const { project } = request;
    if (project.startingPoint === 'model') return problem(reply, 400, 'This project starts from an existing model, so it has no data sample.');
    if (!['draft', 'changes_requested'].includes(project.status)) return problem(reply, 409, 'Uploads are closed while the sample is in review or approved.');
    const grant = signToken(ingest.secret, {
      v: 1, kind: 'upload', ws: project.workspaceId, project: project.id, by: request.user.id,
      maxBytes: ingest.maxBytes, exp: nowS() + GRANT_TTL_S, nonce: randomBytes(9).toString('base64url'),
    });
    return { uploadUrl: `${ingest.publicUrl}/v1/uploads`, grant, maxBytes: ingest.maxBytes };
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/uploads', post([uploadsOn, signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const receipt = verifyToken(ingest.secret, request.body?.receipt, 'receipt');
    // A receipt is only valid for the project, workspace and person its grant was issued to.
    if (!receipt || receipt.ws !== request.project.workspaceId || receipt.project !== request.project.id || receipt.by !== request.user.id) {
      return problem(reply, 400, 'That upload receipt is not valid. Upload the file again.');
    }
    try {
      const upload = await store.createUpload({
        workspaceId: receipt.ws, projectId: receipt.project, uploadedBy: request.user.id, objectKey: receipt.objectKey,
        sha256: receipt.sha256, sizeBytes: receipt.sizeBytes, contentType: receipt.contentType, filename: text(receipt.filename, 255) || 'file',
      });
      const { objectKey, ...shown } = upload;
      return { upload: shown };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/submit', post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const { project } = request;
    if (project.startingPoint === 'model') return problem(reply, 400, 'Projects that start from a model are not reviewed as datasets.');
    if (!project.dataSource) return problem(reply, 400, 'Record where the data came from first.');
    const uploads = await store.listUploads({ workspaceId: project.workspaceId, projectId: project.id });
    if (project.dataSource.mode === 'upload' && uploads.length === 0) return problem(reply, 400, 'Upload at least one sample file first.');
    try {
      const review = await store.submitForReview({ workspaceId: project.workspaceId, projectId: project.id, submittedBy: request.user.id });
      return { review: { id: review.id, status: review.status } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This project is already in review or approved.');
      return fail(reply, err);
    }
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId/dataset-versions', post([signedIn, approver, loadProject]), async (request, reply) => {
    const { project } = request;
    const where = { workspaceId: project.workspaceId, projectId: project.id };
    const [uploads, reviews] = await Promise.all([store.listUploads(where), store.listProjectReviews(where)]);
    const approved = reviews.findLast((r) => r.status === 'approved');
    if (!approved) return problem(reply, 409, 'A version can be approved only after Valcairn review approves the sample.');
    // The manifest freezes exactly which files and which rights record this version is made of.
    const manifest = {
      files: uploads.filter((u) => !u.duplicateOf).map((u) => ({ id: u.id, sha256: u.sha256, sizeBytes: u.sizeBytes, contentType: u.contentType, filename: u.filename, objectKey: u.objectKey })),
      rights: project.dataSource,
      acceptanceRule: project.success,
      reviewId: approved.id,
    };
    try {
      const version = await store.createDatasetVersion({ ...where, createdBy: request.user.id, manifest });
      return { version: { id: version.id, number: version.number, files: manifest.files.length, createdAt: version.createdAt } };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'invalid_state') return problem(reply, 409, 'This project is not approved for a new version.');
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
    return {
      review,
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      project,
      uploads: uploads.map(({ objectKey, ...u }) => ({
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
