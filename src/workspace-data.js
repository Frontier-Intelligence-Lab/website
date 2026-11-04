import { randomBytes } from 'node:crypto';
import { StoreError } from './store/index.js';
import { signToken } from './lib/tokens.js';
import { KINDS, SCOPES, TONES, computeIssues, detectKind, kindOf, previewType } from './lib/dataset.js';

const PREVIEW_TTL_S = 30 * 60;
const DOWNLOAD_TTL_S = 5 * 60;
const MAX_LABELS = 40;
const MAX_OFFSET_MS = 31622400000;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * The dataset workspace for a project: its files by data type with previews, a label set and labels,
 * the issues to settle before review, and the frozen versions. Content edits follow the same freeze
 * as uploads: the store refuses them unless the project is draft or changes requested.
 */
export function registerWorkspaceDataRoutes(app, { config, store, helpers, guards }) {
  const { problem } = helpers;
  const { signedIn, member, post, get, fail } = guards;
  const ingest = config.ingest;
  const path = '/api/workspaces/:workspaceId/projects/:projectId';

  const loadProject = async (request, reply) => {
    const project = await store.getProject({ workspaceId: request.params.workspaceId, projectId: request.params.projectId });
    if (!project) return problem(reply, 404, 'Not found.');
    request.project = project;
  };
  const where = (request) => ({ workspaceId: request.project.workspaceId, projectId: request.project.id });
  const locked = (reply) => problem(reply, 409, 'This project is locked while it is in review or approved. Withdraw or reopen it to make changes.', { code: 'project_locked' });
  const storeFail = (reply, err) => {
    if (err instanceof StoreError && err.code === 'invalid_state') return locked(reply);
    if (err instanceof StoreError && err.code === 'invalid_label') return problem(reply, 400, err.message);
    if (err instanceof StoreError && err.code === 'label_in_use') return problem(reply, 409, `“${err.message}” has labels that would no longer fit. Delete or move those labels first.`, { code: 'label_in_use' });
    if (err instanceof StoreError && err.code === 'not_found') return problem(reply, 404, 'Not found.');
    return fail(reply, err);
  };
  const objectUrl = (route, payload, ttl) => `${ingest.publicUrl}/v1/${route}?token=${encodeURIComponent(signToken(ingest.secret, { v: 1, ...payload, exp: nowS() + ttl }))}`;
  const previewUrl = (u) => {
    const type = previewType(u.contentType);
    return ingest && type && u.sizeBytes > 0 ? objectUrl('preview', { kind: 'preview', key: u.objectKey, type }, PREVIEW_TTL_S) : null;
  };

  const loadAll = async (request) => {
    const w = where(request);
    const [uploads, annotations, notes, versions, reviews, members] = await Promise.all([
      store.listUploads(w), store.listAnnotations(w), store.listIssueNotes(w), store.listDatasetVersions(w), store.listProjectReviews(w), store.listMembers(w.workspaceId),
    ]);
    return { uploads, annotations, notes, versions, reviews, members };
  };
  const issuesFor = (request, data) => computeIssues({ project: request.project, uploads: data.uploads, annotations: data.annotations, notes: data.notes });

  app.get(`${path}/dataset`, get([signedIn, member('readProjects'), loadProject]), async (request) => {
    const { project, role } = request;
    const data = await loadAll(request);
    const counts = new Map();
    for (const a of data.annotations) counts.set(a.uploadId, (counts.get(a.uploadId) ?? 0) + 1);
    const latest = data.reviews.at(-1);
    return {
      project,
      role,
      editable: ['draft', 'changes_requested'].includes(project.status),
      uploadsEnabled: Boolean(ingest),
      items: data.uploads.map(({ objectKey, ...u }) => ({
        ...u, kind: kindOf(u), detectedKind: detectKind(u), chosenKind: u.kind, labelCount: counts.get(u.id) ?? 0,
        previewUrl: previewUrl({ ...u, objectKey }),
      })),
      labelSet: project.labelSet ?? [],
      annotations: data.annotations.map(({ workspaceId, projectId, ...a }) => a),
      issues: issuesFor(request, data),
      latestReview: latest ? { status: latest.status, notes: latest.notes, decidedAt: latest.decidedAt } : null,
      versions: data.versions.map((v) => ({
        id: v.id, number: v.number, createdAt: v.createdAt,
        files: (v.manifest.files ?? []).map((f) => ({ id: f.id, filename: f.filename, sizeBytes: f.sizeBytes, kind: f.kind ?? detectKind(f) })),
        labels: v.manifest.annotations?.length ?? 0,
        labelSet: v.manifest.labelSet ?? [],
        notes: v.manifest.issueNotes?.length ?? 0,
      })),
      members: data.members.map((m) => ({ id: m.user.id, name: m.user.name, role: m.role })),
    };
  });

  // The label set is review content: labels are added, renamed or recoloured freely, but one in use cannot be removed.
  app.post(`${path}/label-set`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const raw = Array.isArray(request.body?.labels) ? request.body.labels : null;
    if (!raw || raw.length > MAX_LABELS) return problem(reply, 400, `Send between 0 and ${MAX_LABELS} labels.`);
    // Checked again atomically by the store; this only gives a frozen project the clearer answer first.
    if (!['draft', 'changes_requested'].includes(request.project.status)) return locked(reply);
    const current = request.project.labelSet ?? [];
    const labels = [];
    for (const item of raw) {
      const name = text(item?.name, 60);
      if (!name) return problem(reply, 400, 'Every label needs a name.');
      if (labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) return problem(reply, 400, `“${name}” is listed twice.`);
      const scope = SCOPES.includes(item?.scope) ? item.scope : 'span';
      const tone = TONES.includes(item?.tone) ? item.tone : 'plain';
      const known = current.find((l) => l.id === item?.id);
      labels.push({ id: known?.id ?? `l_${randomBytes(6).toString('base64url')}`, name, scope, tone });
    }
    try {
      // The store refuses, under the project lock, to drop or re-scope a label that is in use.
      const project = await store.setLabelSet({ ...where(request), labelSet: labels });
      await store.recordAudit({ workspaceId: project.workspaceId, actorId: request.user.id, action: 'label_set.updated', targetType: 'project', targetId: project.id, metadata: { labels: labels.length } });
      return { labelSet: project.labelSet };
    } catch (err) { return storeFail(reply, err); }
  });

  // The person can correct the detected data type (a table that is really sensor readings) and set where a timed file sits on the shared clock.
  app.post(`${path}/items/:uploadId`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const body = request.body ?? {};
    const patch = {};
    if ('kind' in body) {
      if (body.kind !== null && !KINDS.includes(body.kind)) return problem(reply, 400, 'Choose one of the listed data types.');
      patch.kind = body.kind;
    }
    if ('offsetMs' in body) {
      if (body.offsetMs !== null && !(Number.isSafeInteger(body.offsetMs) && Math.abs(body.offsetMs) <= MAX_OFFSET_MS)) return problem(reply, 400, 'The offset must be a whole number of milliseconds.');
      patch.offsetMs = body.offsetMs;
    }
    if (!Object.keys(patch).length) return problem(reply, 400, 'Nothing to change.');
    try {
      const { objectKey, ...upload } = await store.updateUpload({ ...where(request), uploadId: request.params.uploadId, patch });
      return { item: { ...upload, kind: kindOf(upload), detectedKind: detectKind(upload), chosenKind: upload.kind } };
    } catch (err) { return storeFail(reply, err); }
  });

  // The label's scope, the file's type and the freeze are all checked by the store under the project lock.
  app.post(`${path}/items/:uploadId/annotations`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const body = request.body ?? {};
    try {
      const annotation = await store.createAnnotation({
        ...where(request), uploadId: request.params.uploadId, labelId: text(body.labelId, 64),
        startMs: body.startMs ?? null, endMs: body.endMs ?? null, box: body.box ?? null, createdBy: request.user.id,
      });
      const { workspaceId, projectId, ...shown } = annotation;
      return { annotation: shown };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${path}/annotations/:annotationId`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const body = request.body ?? {};
    const patch = Object.fromEntries(['startMs', 'endMs', 'box'].filter((k) => k in body).map((k) => [k, body[k]]));
    if (!Object.keys(patch).length) return problem(reply, 400, 'Nothing to change.');
    try {
      const { workspaceId, projectId, ...shown } = await store.updateAnnotation({ ...where(request), annotationId: request.params.annotationId, patch });
      return { annotation: shown };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${path}/annotations/:annotationId/delete`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    try {
      await store.deleteAnnotation({ ...where(request), annotationId: request.params.annotationId });
      return { ok: true };
    } catch (err) { return storeFail(reply, err); }
  });

  // A note keeps an issue on record and lets the project go to review with it; staff see every note in the snapshot.
  app.post(`${path}/issues/note`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    const key = text(request.body?.key, 200);
    const note = text(request.body?.note, 2000);
    if (!note) return problem(reply, 400, 'Say why this stays as it is.', { errors: { note: 'Required.' } });
    const data = await loadAll(request);
    const issue = issuesFor(request, data).find((i) => i.key === key);
    if (!issue) return problem(reply, 404, 'That issue is no longer open.');
    if (issue.blocking) return problem(reply, 400, 'This one has to be fixed, not noted.');
    try {
      const saved = await store.setIssueNote({ ...where(request), key, note, createdBy: request.user.id });
      return { note: saved };
    } catch (err) { return storeFail(reply, err); }
  });

  app.post(`${path}/issues/note/delete`, post([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    try {
      await store.deleteIssueNote({ ...where(request), key: text(request.body?.key, 200) });
      return { ok: true };
    } catch (err) { return storeFail(reply, err); }
  });

  // Viewers and finance see previews; downloading the original file needs a role that can edit.
  app.get(`${path}/items/:uploadId/download`, get([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    if (!ingest) return problem(reply, 503, 'File storage is not configured on this server.');
    const upload = (await store.listUploads(where(request))).find((u) => u.id === request.params.uploadId);
    if (!upload) return problem(reply, 404, 'Not found.');
    await store.recordAudit({ workspaceId: upload.workspaceId, actorId: request.user.id, action: 'upload.downloaded', targetType: 'upload', targetId: upload.id, metadata: {} });
    return { url: objectUrl('objects', { kind: 'download', key: upload.objectKey, filename: upload.filename }, DOWNLOAD_TTL_S) };
  });

  // Original bytes of a file in a frozen version, resolved only through that version's manifest, so they stay
  // retrievable after the working set changes or the file is removed from it.
  app.get(`${path}/dataset-versions/:number/files/:fileId/download`, get([signedIn, member('writeProjects'), loadProject]), async (request, reply) => {
    if (!ingest) return problem(reply, 503, 'File storage is not configured on this server.');
    const version = (await store.listDatasetVersions(where(request))).find((v) => String(v.number) === String(request.params.number));
    const file = version?.manifest.files?.find((f) => f.id === request.params.fileId);
    if (!file?.objectKey) return problem(reply, 404, 'Not found.');
    await store.recordAudit({ workspaceId: request.project.workspaceId, actorId: request.user.id, action: 'dataset_version.file_downloaded', targetType: 'project', targetId: request.project.id, metadata: { version: version.number, fileId: file.id } });
    return { url: objectUrl('objects', { kind: 'download', key: file.objectKey, filename: file.filename }, DOWNLOAD_TTL_S) };
  });

  // The manifest of a frozen version: paths, types, checksums, labels and notes. Storage keys stay private.
  app.get(`${path}/dataset-versions/:number/manifest`, get([signedIn, member('readProjects'), loadProject]), async (request, reply) => {
    const version = (await store.listDatasetVersions(where(request))).find((v) => String(v.number) === String(request.params.number));
    if (!version) return problem(reply, 404, 'Not found.');
    const { manifest } = version;
    const body = {
      project: { id: request.project.id, name: request.project.name },
      version: version.number, createdAt: version.createdAt, reviewId: manifest.reviewId,
      task: manifest.task, dataSource: manifest.dataSource, labelSet: manifest.labelSet ?? [],
      files: (manifest.files ?? []).map(({ objectKey, ...f }) => ({ ...f, kind: f.kind ?? detectKind(f) })),
      annotations: manifest.annotations ?? [], issueNotes: manifest.issueNotes ?? [],
    };
    const safe = request.project.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'dataset';
    reply.header('content-disposition', `attachment; filename="${safe}-v${version.number}-manifest.json"`);
    return body;
  });
}
