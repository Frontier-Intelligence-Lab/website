import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';
import { checkAnnotation, checkKind, computeIssues, kindFitsAnnotations, kindOf, labelSetConflict } from '../lib/dataset.js';
import { CASE_DECISIONS, capitalSnapshot, citedEvidenceIds, draftComplete, referencesResolve } from '../lib/capital.js';
import { snapshotHash } from '../lib/capital-hash.js';
import { LEASE_MS, MAX_ATTEMPTS } from '../lib/jobs.js';

// Review-relevant content can change only while a project is editable; submitting freezes it.
const EDITABLE = ['draft', 'changes_requested'];
const CONTENT_FIELDS = ['name', 'task', 'modalities', 'startingPoint', 'success', 'dataSource', 'model'];
const HELD = ['leased', 'running', 'cancel_requested'];
const FINISHED = ['succeeded', 'failed', 'cancelled'];

/**
 * In-process store for development and tests. Same contract as the Postgres store
 * (see docs/STORE_CONTRACT.md and tests/store-contract.js); data is lost on restart.
 * Every method is async and returns copies, so callers cannot mutate stored rows.
 */
export function createMemoryStore({ now = () => new Date() } = {}) {
  const users = new Map();
  const codes = [];
  const workspaces = new Map();
  const members = [];
  const invitations = [];
  const joinRequests = [];
  const projects = new Map();
  const uploads = [];
  const reviews = [];
  const versions = [];
  const annotations = [];
  const issueNotes = [];
  const audit = [];
  const reviewerAccounts = new Map();
  const modelPulls = [];
  const enhanceRuns = [];
  const devices = [];
  const deviceReports = [];
  const modelInstalls = [];
  const executionRuns = [];
  const capitalCases = [];
  const capitalSubmissions = [];
  const creditRecords = [];
  const capitalEvidence = [];
  const capitalReviewMarks = [];
  const runners = [];
  const jobs = [];
  const jobEvents = [];
  const publicRunner = ({ keyHash, ...r }) => copy(r);
  const publicJob = ({ leaseHash, ...j }) => copy(j);
  const publicEvent = ({ workspaceId, ...e }) => copy(e);
  const endJob = (j, fields) => Object.assign(j, { leaseHash: null, leaseExpiresAt: null, finishedAt: stamp(), updatedAt: stamp() }, fields);
  // A lease that ran out without word from the runner: retried while attempts remain, honoured if cancel was asked.
  const expireLease = (j) => {
    if (!HELD.includes(j.status) || new Date(j.leaseExpiresAt) > now()) return;
    if (j.status === 'cancel_requested') endJob(j, { status: 'cancelled' });
    else if (j.attempt < j.maxAttempts) Object.assign(j, { status: 'queued', leaseHash: null, leaseExpiresAt: null, updatedAt: stamp() });
    else endJob(j, { status: 'failed', failure: 'lease_expired' });
  };
  const heldJob = ({ runnerId, jobId, leaseHash }) => {
    const j = jobs.find((x) => x.id === jobId && x.runnerId === runnerId);
    if (!j) throw new StoreError('not_found');
    expireLease(j);
    if (!HELD.includes(j.status) || j.leaseHash !== leaseHash) throw new StoreError('lease_lost');
    return j;
  };
  const extend = (j, leaseMs) => Object.assign(j, { status: j.status === 'leased' ? 'running' : j.status, leaseExpiresAt: new Date(now().getTime() + leaseMs).toISOString(), updatedAt: stamp() });
  const pickRun = ({ name, baseModelId, datasets, steps, compute, spendCapUsd }) => ({ name, baseModelId, datasets: structuredClone(datasets), steps: [...steps], compute, spendCapUsd });
  const pickCredit = ({ provider, status, amountCents, expiresOn, restrictions, reference }) => ({ provider, status, amountCents, expiresOn, restrictions, reference });
  const pickEvidence = ({ kind, title, source, reference, verification }) => ({ kind, title, source, reference: structuredClone(reference), verification });
  const caseOf = (workspaceId, caseId) => capitalCases.find((c) => c.id === caseId && c.workspaceId === workspaceId) ?? null;
  // Links behave like the composite foreign keys in Postgres: another workspace's project or run does not exist here.
  const checkCaseLinks = (workspaceId, projectId, enhanceRunId) => {
    if (projectId != null && projects.get(projectId)?.workspaceId !== workspaceId) throw new StoreError('not_found');
    if (enhanceRunId != null && !enhanceRuns.some((r) => r.id === enhanceRunId && r.workspaceId === workspaceId)) throw new StoreError('not_found');
  };
  const withSupersededBy = (r) => ({ ...structuredClone(r), supersededBy: creditRecords.find((x) => x.supersedes === r.id)?.id ?? null });
  const currentCredits = (workspaceId) => creditRecords.filter((r) => r.workspaceId === workspaceId).map(withSupersededBy).filter((r) => !r.supersededBy);
  const openSubmission = (caseId) => capitalSubmissions.find((s) => s.caseId === caseId && !s.decision) ?? null;
  const latestSubmission = (caseId) => structuredClone(capitalSubmissions.filter((s) => s.caseId === caseId).at(-1) ?? null);
  const evidenceOf = (caseId) => capitalEvidence.filter((e) => e.caseId === caseId);
  // Every reference a draft makes must resolve at the moment it is saved or frozen (same check as under the Postgres lock).
  const checkReferences = (row, draft) => {
    const frozenVersions = versions.filter((v) => v.workspaceId === row.workspaceId).map((v) => ({ projectId: v.projectId, version: v.number }));
    if (!referencesResolve(draft, { evidenceIds: new Set(evidenceOf(row.id).map((e) => e.id)), versions: frozenVersions })) throw new StoreError('missing_reference');
  };
  // What staff and the queue may see of a case: never its live title, links or draft.
  const caseMeta = ({ id, workspaceId, status, revision, submittedRevision, createdAt, updatedAt }) => ({ id, workspaceId, status, revision, submittedRevision, createdAt, updatedAt });
  const copy =(value) => (value == null ? null : structuredClone(value));
  const stamp = () => now().toISOString();
  const publicUser = ({ passwordHash, ...user }) => copy(user);
  const publicReviewer = ({ passwordHash, ...account }) => copy(account);
  const ownDevice = ({ workspaceId, ownerId, deviceId }) => devices.find((d) => d.id === deviceId && d.workspaceId === workspaceId && d.ownerId === ownerId) ?? null;
  const activeDevice = (where) => {
    const d = ownDevice(where);
    if (!d) throw new StoreError('not_found');
    if (d.status !== 'active') throw new StoreError('invalid_state');
    return d;
  };
  const latestReport = (deviceId) => copy(deviceReports.filter((r) => r.deviceId === deviceId).at(-1) ?? null);
  const editableProject = (workspaceId, projectId) => {
    const project = projects.get(projectId);
    if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
    if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
    return project;
  };

  return {
    kind: 'memory',

    async createUser({ email, name, passwordHash }) {
      const key = email.toLowerCase();
      if ([...users.values()].some((u) => u.email === key)) throw new StoreError('email_taken');
      const user = { id: randomUUID(), email: key, name, passwordHash, emailVerifiedAt: null, createdAt: stamp() };
      users.set(user.id, user);
      return publicUser(user);
    },
    async getUserById(id) {
      const user = users.get(id);
      return user ? publicUser(user) : null;
    },
    async getUserAuthByEmail(email) {
      const user = [...users.values()].find((u) => u.email === String(email).toLowerCase());
      return user ? { user: publicUser(user), passwordHash: user.passwordHash } : null;
    },
    async setEmailVerified(userId) {
      const user = users.get(userId);
      if (!user) throw new StoreError('not_found');
      user.emailVerifiedAt ??= stamp();
      return publicUser(user);
    },

    async createEmailCode({ userId, email, purpose, codeHash, expiresAt }) {
      for (const c of codes) if (c.userId === userId && c.purpose === purpose && !c.consumedAt) c.consumedAt = stamp();
      codes.push({ id: randomUUID(), userId, email: email.toLowerCase(), purpose, codeHash, expiresAt: new Date(expiresAt).toISOString(), attempts: 0, consumedAt: null });
    },
    async consumeEmailCode({ userId, purpose, codeHash }) {
      const code = codes.findLast((c) => c.userId === userId && c.purpose === purpose && !c.consumedAt);
      if (!code) return { ok: false, reason: 'invalid' };
      if (new Date(code.expiresAt) <= now()) return { ok: false, reason: 'expired' };
      if (code.attempts >= 5) return { ok: false, reason: 'too_many_attempts' };
      code.attempts += 1;
      if (code.codeHash !== codeHash) return { ok: false, reason: code.attempts >= 5 ? 'too_many_attempts' : 'invalid' };
      code.consumedAt = stamp();
      return { ok: true, email: code.email };
    },

    async isSlugAvailable(slug) {
      return ![...workspaces.values()].some((w) => w.slug === slug);
    },
    async createWorkspace({ kind, name, slug, website = null, domain = null, domainVerified = false, joinByDomain = false, industry = null, sizeBand = null, profile = {}, ownerId }) {
      if (![...workspaces.values()].every((w) => w.slug !== slug)) throw new StoreError('slug_taken');
      if (kind === 'personal' && members.some((m) => m.userId === ownerId && workspaces.get(m.workspaceId).kind === 'personal')) {
        throw new StoreError('personal_exists');
      }
      const workspace = {
        id: randomUUID(), kind, name, slug, website, domain: domain?.toLowerCase() ?? null,
        domainVerified: Boolean(domain && domainVerified), joinByDomain: Boolean(domain && domainVerified && joinByDomain),
        industry, sizeBand, profile, createdBy: ownerId, createdAt: stamp(),
      };
      workspaces.set(workspace.id, workspace);
      members.push({ workspaceId: workspace.id, userId: ownerId, role: 'owner', createdAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId: workspace.id, actorId: ownerId, action: 'workspace.created', targetType: 'workspace', targetId: workspace.id, metadata: { kind }, createdAt: stamp() });
      return copy(workspace);
    },
    async getWorkspace(id) {
      return copy(workspaces.get(id));
    },
    async findWorkspaceByJoinDomain(domain) {
      const w = [...workspaces.values()].find((x) => x.kind === 'organization' && x.joinByDomain && x.domainVerified && x.domain === String(domain).toLowerCase());
      return w ? { id: w.id, name: w.name, slug: w.slug, domain: w.domain } : null;
    },
    async listWorkspacesForUser(userId) {
      return members.filter((m) => m.userId === userId).map((m) => ({ workspace: copy(workspaces.get(m.workspaceId)), role: m.role }));
    },
    async getMembership(workspaceId, userId) {
      const m = members.find((x) => x.workspaceId === workspaceId && x.userId === userId);
      return m ? { role: m.role } : null;
    },
    async listMembers(workspaceId) {
      return members.filter((m) => m.workspaceId === workspaceId).map((m) => {
        const u = users.get(m.userId);
        return { user: { id: u.id, name: u.name, email: u.email }, role: m.role };
      });
    },

    async createInvitations({ workspaceId, invitedBy, invites }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      for (const invite of invites) {
        const email = invite.email.toLowerCase();
        for (const i of invitations) if (i.workspaceId === workspaceId && i.email === email && !i.acceptedAt && !i.revokedAt) i.revokedAt = stamp();
        invitations.push({ id: randomUUID(), workspaceId, email, role: invite.role, tokenHash: invite.tokenHash, invitedBy, expiresAt: new Date(invite.expiresAt).toISOString(), acceptedAt: null, revokedAt: null, createdAt: stamp() });
      }
      audit.push({ id: audit.length + 1, workspaceId, actorId: invitedBy, action: 'invitations.created', targetType: 'workspace', targetId: workspaceId, metadata: { count: invites.length }, createdAt: stamp() });
      return invites.length;
    },
    async listInvitations(workspaceId) {
      return invitations
        .filter((i) => i.workspaceId === workspaceId && !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > now())
        .map(({ tokenHash, ...i }) => copy(i));
    },
    async getInvitationByTokenHash(tokenHash) {
      const i = invitations.find((x) => x.tokenHash === tokenHash);
      if (!i) return null;
      const { tokenHash: _, ...rest } = i;
      return { ...copy(rest), workspaceName: workspaces.get(i.workspaceId).name, workspaceSlug: workspaces.get(i.workspaceId).slug };
    },
    async acceptInvitation({ invitationId, userId }) {
      const i = invitations.find((x) => x.id === invitationId);
      if (!i) throw new StoreError('not_found');
      if (i.acceptedAt || i.revokedAt) throw new StoreError('already_decided');
      if (new Date(i.expiresAt) <= now()) throw new StoreError('invite_expired');
      const existing = members.find((m) => m.workspaceId === i.workspaceId && m.userId === userId);
      i.acceptedAt = stamp();
      if (!existing) members.push({ workspaceId: i.workspaceId, userId, role: i.role, createdAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId: i.workspaceId, actorId: userId, action: 'invitation.accepted', targetType: 'invitation', targetId: i.id, metadata: { role: i.role }, createdAt: stamp() });
      return { workspaceId: i.workspaceId, role: existing?.role ?? i.role, alreadyMember: Boolean(existing) };
    },
    async revokeInvitation({ workspaceId, invitationId, actorId }) {
      const i = invitations.find((x) => x.id === invitationId && x.workspaceId === workspaceId);
      if (!i) throw new StoreError('not_found');
      if (i.acceptedAt || i.revokedAt) throw new StoreError('already_decided');
      i.revokedAt = stamp();
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'invitation.revoked', targetType: 'invitation', targetId: i.id, metadata: {}, createdAt: stamp() });
    },
    async updateWorkspaceProfile({ workspaceId, profile }) {
      const w = workspaces.get(workspaceId);
      if (!w) throw new StoreError('not_found');
      w.profile = { ...w.profile, ...copy(profile) };
      return copy(w);
    },

    async createJoinRequest({ workspaceId, userId, note = '' }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      if (members.some((m) => m.workspaceId === workspaceId && m.userId === userId)) throw new StoreError('already_member');
      const existing = joinRequests.find((r) => r.workspaceId === workspaceId && r.userId === userId && r.status === 'pending');
      if (existing) return copy(existing);
      const request = { id: randomUUID(), workspaceId, userId, note, status: 'pending', decidedBy: null, decidedAt: null, createdAt: stamp() };
      joinRequests.push(request);
      return copy(request);
    },
    async listJoinRequests(workspaceId, { status = 'pending' } = {}) {
      return joinRequests.filter((r) => r.workspaceId === workspaceId && r.status === status).map(copy);
    },
    async listJoinRequestsForUser(userId) {
      return joinRequests.filter((r) => r.userId === userId).map((r) => ({ ...copy(r), workspaceName: workspaces.get(r.workspaceId).name }));
    },
    async decideJoinRequest({ workspaceId, requestId, deciderId, approve, role = 'member' }) {
      const request = joinRequests.find((r) => r.id === requestId && r.workspaceId === workspaceId);
      if (!request) throw new StoreError('not_found');
      if (request.status !== 'pending') throw new StoreError('already_decided');
      request.status = approve ? 'approved' : 'declined';
      request.decidedBy = deciderId;
      request.decidedAt = stamp();
      if (approve && !members.some((m) => m.workspaceId === workspaceId && m.userId === request.userId)) {
        members.push({ workspaceId, userId: request.userId, role, createdAt: stamp() });
      }
      audit.push({ id: audit.length + 1, workspaceId, actorId: deciderId, action: approve ? 'join_request.approved' : 'join_request.declined', targetType: 'user', targetId: request.userId, metadata: {}, createdAt: stamp() });
      return copy(request);
    },

    async createProject({ workspaceId, createdBy, name, task, modalities = [], startingPoint }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      const project = {
        id: randomUUID(), workspaceId, createdBy, name, task, modalities: [...modalities], startingPoint,
        success: null, dataSource: null, model: null, labelSet: [], status: 'draft', setupStep: 'success', createdAt: stamp(), updatedAt: stamp(),
      };
      projects.set(project.id, project);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'project.created', targetType: 'project', targetId: project.id, metadata: {}, createdAt: stamp() });
      return copy(project);
    },
    async updateProject({ workspaceId, projectId, patch }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) return null;
      if (CONTENT_FIELDS.some((key) => key in patch) && !EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
      for (const key of [...CONTENT_FIELDS, 'setupStep']) if (key in patch) project[key] = copy(patch[key]);
      project.updatedAt = stamp();
      return copy(project);
    },
    async getProject({ workspaceId, projectId }) {
      const project = projects.get(projectId);
      return project && project.workspaceId === workspaceId ? copy(project) : null;
    },
    async listProjects(workspaceId) {
      return [...projects.values()].filter((p) => p.workspaceId === workspaceId).map(copy);
    },

    async createUpload({ workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, limits = {} }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
      if (uploads.some((u) => u.objectKey === objectKey)) throw new StoreError('duplicate_upload');
      const mine = uploads.filter((u) => u.projectId === projectId);
      if ((limits.maxFiles != null && mine.length + 1 > limits.maxFiles)
        || (limits.maxBytes != null && mine.reduce((n, u) => n + u.sizeBytes, 0) + sizeBytes > limits.maxBytes)) throw new StoreError('quota_exceeded');
      const duplicateOf = mine.find((u) => u.sha256 === sha256 && !u.duplicateOf)?.id ?? null;
      const upload = { id: randomUUID(), workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, duplicateOf, kind: null, offsetMs: null, createdAt: stamp() };
      uploads.push(upload);
      return copy(upload);
    },
    async listUploads({ workspaceId, projectId }) {
      return uploads.filter((u) => u.workspaceId === workspaceId && u.projectId === projectId).map(copy);
    },
    async getUpload(uploadId) {
      return copy(uploads.find((u) => u.id === uploadId));
    },
    async deleteUpload({ workspaceId, projectId, uploadId, actorId }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
      const i = uploads.findIndex((u) => u.id === uploadId && u.projectId === projectId);
      if (i < 0) throw new StoreError('not_found');
      const [removed] = uploads.splice(i, 1);
      // Labels belong to the file and go with it.
      for (let j = annotations.length - 1; j >= 0; j--) if (annotations[j].uploadId === removed.id) annotations.splice(j, 1);
      // The earliest copy of a removed original becomes the new original.
      const copies = uploads.filter((u) => u.duplicateOf === removed.id);
      if (copies.length) {
        copies[0].duplicateOf = null;
        for (const c of copies.slice(1)) c.duplicateOf = copies[0].id;
      }
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'upload.deleted', targetType: 'upload', targetId: uploadId, metadata: { sha256: removed.sha256 }, createdAt: stamp() });
      return copy(removed);
    },

    // Each method checks and writes without awaiting in between, so it is atomic like the Postgres version under its project lock.
    async setLabelSet({ workspaceId, projectId, labelSet }) {
      const project = editableProject(workspaceId, projectId);
      const used = new Set(annotations.filter((a) => a.projectId === projectId).map((a) => a.labelId));
      const conflict = labelSetConflict(project.labelSet ?? [], labelSet, used);
      if (conflict) throw new StoreError('label_in_use', conflict.name);
      project.labelSet = copy(labelSet);
      project.updatedAt = stamp();
      return copy(project);
    },
    async updateUpload({ workspaceId, projectId, uploadId, patch }) {
      const project = editableProject(workspaceId, projectId);
      const upload = uploads.find((u) => u.id === uploadId && u.projectId === project.id);
      if (!upload) throw new StoreError('not_found');
      if ('kind' in patch) checkKind(upload, patch.kind);
      if ('kind' in patch && !kindFitsAnnotations(kindOf({ ...upload, kind: patch.kind }), annotations.filter((a) => a.uploadId === uploadId))) throw new StoreError('label_in_use', upload.filename);
      for (const key of ['kind', 'offsetMs']) if (key in patch) upload[key] = patch[key] ?? null;
      return copy(upload);
    },
    async listAnnotations({ workspaceId, projectId }) {
      return annotations.filter((a) => a.workspaceId === workspaceId && a.projectId === projectId).map(copy);
    },
    async createAnnotation({ workspaceId, projectId, uploadId, labelId, startMs = null, endMs = null, box = null, createdBy }) {
      const project = editableProject(workspaceId, projectId);
      const upload = uploads.find((u) => u.id === uploadId && u.projectId === project.id);
      if (!upload) throw new StoreError('not_found');
      const fit = checkAnnotation({ label: (project.labelSet ?? []).find((l) => l.id === labelId), upload, startMs, endMs, box });
      const annotation = { id: randomUUID(), workspaceId, projectId, uploadId, labelId, ...fit, createdBy, createdAt: stamp() };
      annotations.push(annotation);
      return copy(annotation);
    },
    async updateAnnotation({ workspaceId, projectId, annotationId, patch }) {
      const project = editableProject(workspaceId, projectId);
      const annotation = annotations.find((a) => a.id === annotationId && a.projectId === projectId);
      if (!annotation) throw new StoreError('not_found');
      const upload = uploads.find((u) => u.id === annotation.uploadId);
      const fit = checkAnnotation({ label: (project.labelSet ?? []).find((l) => l.id === annotation.labelId), upload, startMs: patch.startMs ?? annotation.startMs, endMs: patch.endMs ?? annotation.endMs, box: patch.box ?? annotation.box });
      Object.assign(annotation, fit);
      return copy(annotation);
    },
    async deleteAnnotation({ workspaceId, projectId, annotationId }) {
      editableProject(workspaceId, projectId);
      const i = annotations.findIndex((a) => a.id === annotationId && a.projectId === projectId);
      if (i < 0) throw new StoreError('not_found');
      return copy(annotations.splice(i, 1)[0]);
    },
    async listIssueNotes({ workspaceId, projectId }) {
      return issueNotes.filter((n) => n.workspaceId === workspaceId && n.projectId === projectId)
        .sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ key, note, createdBy, createdAt }) => ({ key, note, createdBy, createdAt }));
    },
    async setIssueNote({ workspaceId, projectId, key, note, createdBy }) {
      editableProject(workspaceId, projectId);
      const existing = issueNotes.find((n) => n.projectId === projectId && n.key === key);
      const row = existing ?? { workspaceId, projectId, key };
      Object.assign(row, { note, createdBy, createdAt: stamp() });
      if (!existing) issueNotes.push(row);
      return { key, note, createdBy, createdAt: row.createdAt };
    },
    async deleteIssueNote({ workspaceId, projectId, key }) {
      editableProject(workspaceId, projectId);
      const i = issueNotes.findIndex((n) => n.projectId === projectId && n.key === key);
      if (i < 0) throw new StoreError('not_found');
      issueNotes.splice(i, 1);
    },

    async submitForReview({ workspaceId, projectId, submittedBy, requireResolved = false }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
      if (requireResolved) {
        const where = (x) => x.projectId === projectId;
        const open = computeIssues({ project, uploads: uploads.filter(where), annotations: annotations.filter(where), notes: issueNotes.filter(where) }).filter((i) => i.open).length;
        if (open) throw Object.assign(new StoreError('issues_open'), { open });
      }
      // The reviewer decides on this snapshot, and a dataset version is made only from an approved snapshot.
      const snapshot = {
        task: project.task, modalities: copy(project.modalities), startingPoint: project.startingPoint,
        success: copy(project.success), dataSource: copy(project.dataSource), model: copy(project.model),
        files: uploads.filter((u) => u.projectId === projectId && !u.duplicateOf)
          .map(({ id, sha256, sizeBytes, contentType, filename, objectKey, kind, offsetMs }) => ({ id, sha256, sizeBytes, contentType, filename, objectKey, kind, offsetMs })),
        labelSet: copy(project.labelSet ?? []),
      };
      const fileIds = new Set(snapshot.files.map((f) => f.id));
      snapshot.annotations = annotations.filter((a) => a.projectId === projectId && fileIds.has(a.uploadId))
        .map(({ id, uploadId, labelId, startMs, endMs, box }) => ({ id, uploadId, labelId, startMs, endMs, box }));
      snapshot.issueNotes = issueNotes.filter((n) => n.projectId === projectId).sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ key, note }) => ({ key, note }));
      const review = { id: randomUUID(), workspaceId, projectId, submittedBy, status: 'pending', reviewerId: null, notes: null, checks: {}, snapshot, decidedAt: null, createdAt: stamp() };
      reviews.push(review);
      project.status = 'in_review';
      project.updatedAt = stamp();
      audit.push({ id: audit.length + 1, workspaceId, actorId: submittedBy, action: 'review.submitted', targetType: 'project', targetId: projectId, metadata: { reviewId: review.id }, createdAt: stamp() });
      return copy(review);
    },
    async reopenProject({ workspaceId, projectId, actorId }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      if (!['in_review', 'approved', 'versioned'].includes(project.status)) throw new StoreError('invalid_state');
      const role = members.find((m) => m.workspaceId === workspaceId && m.userId === actorId)?.role;
      if (!['owner', 'admin'].includes(role) && !(role === 'member' && project.status === 'in_review')) throw new StoreError('forbidden');
      const pending = reviews.find((r) => r.projectId === projectId && r.status === 'pending');
      if (pending) Object.assign(pending, { status: 'withdrawn', decidedAt: stamp() });
      const from = project.status;
      project.status = 'draft';
      project.updatedAt = stamp();
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'project.reopened', targetType: 'project', targetId: projectId, metadata: { from }, createdAt: stamp() });
      return copy(project);
    },
    async listReviews({ status = 'pending' } = {}) {
      return reviews.filter((r) => r.status === status).map((r) => {
        const p = projects.get(r.projectId);
        return { ...copy(r), projectName: p.name, workspaceName: workspaces.get(r.workspaceId).name };
      });
    },
    async getReview(reviewId) {
      return copy(reviews.find((r) => r.id === reviewId));
    },
    async listProjectReviews({ workspaceId, projectId }) {
      return reviews.filter((r) => r.workspaceId === workspaceId && r.projectId === projectId).map(copy);
    },
    async decideReview({ reviewId, reviewerId, decision, notes = null, checks = {} }) {
      const review = reviews.find((r) => r.id === reviewId);
      if (!review) throw new StoreError('not_found');
      if (review.status !== 'pending') throw new StoreError('already_decided');
      if (!['approved', 'changes_requested'].includes(decision)) throw new StoreError('invalid_state');
      Object.assign(review, { status: decision, reviewerId, notes, checks: copy(checks), decidedAt: stamp() });
      const project = projects.get(review.projectId);
      project.status = decision;
      project.updatedAt = stamp();
      audit.push({ id: audit.length + 1, workspaceId: review.workspaceId, actorId: reviewerId, action: `review.${decision}`, targetType: 'project', targetId: review.projectId, metadata: { reviewId }, createdAt: stamp() });
      return copy(review);
    },

    async createDatasetVersion({ workspaceId, projectId, createdBy }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      if (project.status !== 'approved') throw new StoreError('invalid_state');
      const approved = reviews.findLast((r) => r.projectId === projectId && r.status === 'approved');
      if (!approved?.snapshot) throw new StoreError('invalid_state');
      const number = versions.filter((v) => v.projectId === projectId).length + 1;
      const manifest = { reviewId: approved.id, ...copy(approved.snapshot) };
      const version = { id: randomUUID(), workspaceId, projectId, number, createdBy, manifest, createdAt: stamp() };
      versions.push(version);
      project.status = 'versioned';
      project.updatedAt = stamp();
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'dataset_version.created', targetType: 'project', targetId: projectId, metadata: { number, reviewId: approved.id }, createdAt: stamp() });
      return copy(version);
    },
    async listDatasetVersions({ workspaceId, projectId }) {
      return versions.filter((v) => v.workspaceId === workspaceId && v.projectId === projectId).map(copy);
    },

    async listModelPulls(workspaceId) {
      return modelPulls.filter((p) => p.workspaceId === workspaceId).map(copy);
    },
    // Asking twice returns the first request: one copy of a model per workspace.
    async requestModelPull({ workspaceId, modelId, requestedBy }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      const existing = modelPulls.find((p) => p.workspaceId === workspaceId && p.modelId === modelId);
      if (existing) return copy(existing);
      const pull = { id: randomUUID(), workspaceId, modelId, status: 'requested', requestedBy, createdAt: stamp() };
      modelPulls.push(pull);
      return copy(pull);
    },
    async listEnhanceRuns(workspaceId) {
      return enhanceRuns.filter((r) => r.workspaceId === workspaceId).map(copy);
    },
    async getEnhanceRun({ workspaceId, runId }) {
      const run = enhanceRuns.find((r) => r.id === runId && r.workspaceId === workspaceId);
      return run ? copy(run) : null;
    },
    async createEnhanceRun({ workspaceId, createdBy, run }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      const at = stamp();
      const row = { id: randomUUID(), workspaceId, ...pickRun(run), status: 'draft', createdBy, requestedBy: null, requestedAt: null, createdAt: at, updatedAt: at };
      enhanceRuns.push(row);
      return copy(row);
    },
    async updateEnhanceRun({ workspaceId, runId, run }) {
      const row = enhanceRuns.find((r) => r.id === runId && r.workspaceId === workspaceId);
      if (!row) throw new StoreError('not_found');
      if (row.status !== 'draft') throw new StoreError('invalid_state');
      // Strictly later than the previous edit, so an approval naming the old version is always detected as stale.
      const at = new Date(Math.max(now().getTime(), new Date(row.updatedAt).getTime() + 1)).toISOString();
      Object.assign(row, pickRun(run), { updatedAt: at });
      return copy(row);
    },
    async requestEnhanceRun({ workspaceId, runId, requestedBy, expectedUpdatedAt }) {
      const row = enhanceRuns.find((r) => r.id === runId && r.workspaceId === workspaceId);
      if (!row) throw new StoreError('not_found');
      if (row.status !== 'draft') throw new StoreError('invalid_state');
      if (expectedUpdatedAt == null || new Date(expectedUpdatedAt).getTime() !== new Date(row.updatedAt).getTime()) throw new StoreError('stale_plan');
      if (!row.datasets.length || !row.steps.length || !row.compute || row.spendCapUsd == null) throw new StoreError('invalid_state');
      Object.assign(row, { status: 'requested', requestedBy, requestedAt: stamp(), updatedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId, actorId: requestedBy, action: 'enhance_run.requested', targetType: 'enhance_run', targetId: runId, metadata: { spendCapUsd: row.spendCapUsd }, createdAt: stamp() });
      return copy(row);
    },

    // Devices belong to one person in one workspace; every read and write is filtered on both.
    async createDevice({ workspaceId, ownerId, label, runtime = 'ollama' }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      const device = { id: randomUUID(), workspaceId, ownerId, label, runtime, status: 'active', lastSeenAt: null, revokedAt: null, createdAt: stamp() };
      devices.push(device);
      audit.push({ id: audit.length + 1, workspaceId, actorId: ownerId, action: 'device.registered', targetType: 'device', targetId: device.id, metadata: { runtime }, createdAt: stamp() });
      return { ...copy(device), latestReport: null };
    },
    async listDevices({ workspaceId, ownerId }) {
      return devices.filter((d) => d.workspaceId === workspaceId && d.ownerId === ownerId).map((d) => ({ ...copy(d), latestReport: latestReport(d.id) }));
    },
    async getDevice({ workspaceId, ownerId, deviceId }) {
      const d = ownDevice({ workspaceId, ownerId, deviceId });
      return d ? { ...copy(d), latestReport: latestReport(d.id) } : null;
    },
    async revokeDevice({ workspaceId, ownerId, deviceId }) {
      const d = ownDevice({ workspaceId, ownerId, deviceId });
      if (!d) throw new StoreError('not_found');
      if (d.status === 'revoked') throw new StoreError('invalid_state');
      Object.assign(d, { status: 'revoked', revokedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId, actorId: ownerId, action: 'device.revoked', targetType: 'device', targetId: deviceId, metadata: {}, createdAt: stamp() });
      return { ...copy(d), latestReport: latestReport(d.id) };
    },
    async recordDeviceReport({ workspaceId, ownerId, deviceId, report }) {
      const d = activeDevice({ workspaceId, ownerId, deviceId });
      const row = { id: randomUUID(), deviceId, ...copy(report), provenance: 'client_reported', createdAt: stamp() };
      deviceReports.push(row);
      d.lastSeenAt = row.createdAt;
      return copy(row);
    },
    async saveModelInstall({ workspaceId, ownerId, deviceId, install }) {
      activeDevice({ workspaceId, ownerId, deviceId });
      const at = stamp();
      let row = modelInstalls.find((i) => i.deviceId === deviceId && i.runtimeRef === install.runtimeRef);
      const verified = ['verified', 'ready'].includes(install.state);
      const keepVerified = verified && row?.verifiedAt && row.digest === install.digest;
      const fields = { ...copy(install), verifiedAt: verified ? (keepVerified ? row.verifiedAt : at) : null, provenance: 'client_reported', updatedAt: at };
      const previous = row?.state ?? null;
      if (row) Object.assign(row, fields);
      else modelInstalls.push(row = { id: randomUUID(), deviceId, ...fields, createdAt: at });
      if (previous !== row.state) audit.push({ id: audit.length + 1, workspaceId, actorId: ownerId, action: `model_install.${row.state}`, targetType: 'model_install', targetId: row.id, metadata: { runtimeRef: row.runtimeRef, digest: row.digest }, createdAt: at });
      return copy(row);
    },
    async listModelInstalls({ workspaceId, ownerId, deviceId }) {
      if (!ownDevice({ workspaceId, ownerId, deviceId })) return [];
      return modelInstalls.filter((i) => i.deviceId === deviceId).sort((a, b) => a.runtimeRef.localeCompare(b.runtimeRef)).map(copy);
    },
    async recordExecutionRun({ workspaceId, ownerId, deviceId, run }) {
      activeDevice({ workspaceId, ownerId, deviceId });
      if (run.installId && !modelInstalls.some((i) => i.id === run.installId && i.deviceId === deviceId)) throw new StoreError('not_found');
      const row = { id: randomUUID(), deviceId, ...copy(run), provenance: 'client_reported', createdAt: stamp() };
      executionRuns.push(row);
      return copy(row);
    },
    async listExecutionRuns({ workspaceId, ownerId, deviceId, limit = 50 }) {
      if (!ownDevice({ workspaceId, ownerId, deviceId })) return [];
      return executionRuns.filter((r) => r.deviceId === deviceId).slice(-limit).reverse().map(copy);
    },

    // Runners and jobs (migrations/014_jobs.sql): a durable queue leased to one runner at a time.
    async createRunner({ workspaceId, createdBy, label, keyHash, keyPrefix }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      const runner = { id: randomUUID(), workspaceId, createdBy, label, keyHash, keyPrefix, status: 'active', capabilities: {}, lastSeenAt: null, revokedAt: null, createdAt: stamp() };
      runners.push(runner);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'runner.linked', targetType: 'runner', targetId: runner.id, metadata: {}, createdAt: stamp() });
      return publicRunner(runner);
    },
    async listRunners(workspaceId) {
      return runners.filter((r) => r.workspaceId === workspaceId).map(publicRunner);
    },
    async getRunner({ workspaceId, runnerId }) {
      const r = runners.find((x) => x.id === runnerId && x.workspaceId === workspaceId);
      return r ? publicRunner(r) : null;
    },
    async findActiveRunnerByKeyHash(keyHash) {
      const r = runners.find((x) => x.keyHash === keyHash && x.status === 'active');
      return r ? publicRunner(r) : null;
    },
    async revokeRunner({ workspaceId, runnerId, actorId }) {
      const r = runners.find((x) => x.id === runnerId && x.workspaceId === workspaceId);
      if (!r) throw new StoreError('not_found');
      if (r.status !== 'active') throw new StoreError('invalid_state');
      Object.assign(r, { status: 'revoked', revokedAt: stamp() });
      // Nothing more may run on it: waiting jobs are cancelled and held ones fail.
      for (const j of jobs.filter((x) => x.runnerId === runnerId && !FINISHED.includes(x.status))) {
        endJob(j, j.status === 'queued' ? { status: 'cancelled', cancelledBy: actorId } : { status: 'failed', failure: 'runner_revoked' });
      }
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'runner.revoked', targetType: 'runner', targetId: runnerId, metadata: {}, createdAt: stamp() });
      return publicRunner(r);
    },
    async reportRunner({ runnerId, capabilities }) {
      const r = runners.find((x) => x.id === runnerId && x.status === 'active');
      if (!r) throw new StoreError('invalid_state');
      Object.assign(r, { capabilities: copy(capabilities), lastSeenAt: stamp() });
      return publicRunner(r);
    },
    async createJob({ workspaceId, runnerId, kind, enhanceRunId = null, spec, idempotencyKey, createdBy }) {
      const existing = jobs.find((j) => j.workspaceId === workspaceId && j.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.kind !== kind || existing.runnerId !== runnerId || existing.enhanceRunId !== enhanceRunId) throw new StoreError('invalid_state');
        return publicJob(existing);
      }
      const runner = runners.find((x) => x.id === runnerId && x.workspaceId === workspaceId);
      if (!runner) throw new StoreError('not_found');
      if (runner.status !== 'active') throw new StoreError('invalid_state');
      if (enhanceRunId != null && !enhanceRuns.some((r) => r.id === enhanceRunId && r.workspaceId === workspaceId)) throw new StoreError('not_found');
      const at = stamp();
      const job = { id: randomUUID(), workspaceId, runnerId, kind, enhanceRunId, spec: copy(spec), status: 'queued', attempt: 0, maxAttempts: MAX_ATTEMPTS, leaseHash: null, leaseExpiresAt: null, result: null, failure: null, idempotencyKey, createdBy, cancelledBy: null, createdAt: at, startedAt: null, finishedAt: null, updatedAt: at };
      jobs.push(job);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'job.created', targetType: 'job', targetId: job.id, metadata: { kind, runnerId }, createdAt: at });
      return publicJob(job);
    },
    async listJobs({ workspaceId, limit = 50 }) {
      const mine = jobs.filter((j) => j.workspaceId === workspaceId);
      mine.forEach(expireLease);
      return mine.slice(-limit).reverse().map(publicJob);
    },
    async getJob({ workspaceId, jobId }) {
      const j = jobs.find((x) => x.id === jobId && x.workspaceId === workspaceId);
      if (!j) return null;
      expireLease(j);
      return publicJob(j);
    },
    async listJobEvents({ workspaceId, jobId, afterId = 0, limit = 500 }) {
      if (!jobs.some((x) => x.id === jobId && x.workspaceId === workspaceId)) return [];
      return jobEvents.filter((e) => e.jobId === jobId && e.id > afterId).slice(0, limit).map(publicEvent);
    },
    async cancelJob({ workspaceId, jobId, actorId }) {
      const j = jobs.find((x) => x.id === jobId && x.workspaceId === workspaceId);
      if (!j) throw new StoreError('not_found');
      expireLease(j);
      if (FINISHED.includes(j.status)) throw new StoreError('invalid_state');
      if (j.status === 'queued') endJob(j, { status: 'cancelled', cancelledBy: actorId });
      else if (j.status !== 'cancel_requested') Object.assign(j, { status: 'cancel_requested', cancelledBy: actorId, updatedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'job.cancel_requested', targetType: 'job', targetId: jobId, metadata: {}, createdAt: stamp() });
      return publicJob(j);
    },
    async leaseJob({ runnerId, leaseHash, leaseMs = LEASE_MS }) {
      const mine = jobs.filter((j) => j.runnerId === runnerId);
      mine.forEach(expireLease);
      // One job at a time per runner: it holds the GPU.
      if (mine.some((j) => HELD.includes(j.status))) return null;
      const next = mine.find((j) => j.status === 'queued');
      if (!next) return null;
      const at = now();
      Object.assign(next, { status: 'leased', attempt: next.attempt + 1, leaseHash, leaseExpiresAt: new Date(at.getTime() + leaseMs).toISOString(), startedAt: next.startedAt ?? at.toISOString(), updatedAt: at.toISOString() });
      return publicJob(next);
    },
    async getRunnerJob({ runnerId, jobId }) {
      const j = jobs.find((x) => x.id === jobId && x.runnerId === runnerId);
      if (!j) return null;
      expireLease(j);
      return publicJob(j);
    },
    async touchJob({ runnerId, jobId, leaseHash, leaseMs = LEASE_MS }) {
      const j = heldJob({ runnerId, jobId, leaseHash });
      extend(j, leaseMs);
      return publicJob(j);
    },
    async appendJobEvents({ runnerId, jobId, leaseHash, events, leaseMs = LEASE_MS }) {
      const j = heldJob({ runnerId, jobId, leaseHash });
      let added = 0;
      for (const e of events) {
        if (jobEvents.some((x) => x.jobId === jobId && x.attempt === j.attempt && x.seq === e.seq)) continue;
        jobEvents.push({ id: jobEvents.length + 1, jobId, workspaceId: j.workspaceId, attempt: j.attempt, seq: e.seq, kind: e.kind, data: copy(e.data), createdAt: stamp() });
        added += 1;
      }
      extend(j, leaseMs);
      return { added, job: publicJob(j) };
    },
    async finishJob({ runnerId, jobId, leaseHash, outcome, result = null, failure = null, retryable = false }) {
      const j = heldJob({ runnerId, jobId, leaseHash });
      if (outcome === 'succeeded') endJob(j, { status: 'succeeded', result: copy(result) });
      else if (j.status === 'cancel_requested' || failure === 'cancelled') endJob(j, { status: 'cancelled' });
      else if (retryable && j.attempt < j.maxAttempts) Object.assign(j, { status: 'queued', leaseHash: null, leaseExpiresAt: null, updatedAt: stamp() });
      else endJob(j, { status: 'failed', failure });
      return publicJob(j);
    },

    // Capital: cases with an editable, revisioned draft; frozen submitted revisions; append-only credit records; evidence references.
    async listCapitalCases(workspaceId) {
      return capitalCases.filter((c) => c.workspaceId === workspaceId).map(copy);
    },
    async getCapitalCase({ workspaceId, caseId }) {
      return copy(caseOf(workspaceId, caseId));
    },
    async createCapitalCase({ workspaceId, createdBy, title, projectId = null, enhanceRunId = null, draft }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      checkCaseLinks(workspaceId, projectId, enhanceRunId);
      const at = stamp();
      const row = { id: randomUUID(), workspaceId, projectId, enhanceRunId, title, status: 'draft', draft: copy(draft), revision: 1, submittedRevision: null, createdBy, createdAt: at, updatedAt: at };
      capitalCases.push(row);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'capital_case.created', targetType: 'capital_case', targetId: row.id, metadata: {}, createdAt: at });
      return copy(row);
    },
    // The caller names the revision it edited; a different revision means someone else saved first.
    async updateCapitalCase({ workspaceId, caseId, expectedRevision, title, projectId = null, enhanceRunId = null, draft }) {
      const row = caseOf(workspaceId, caseId);
      if (!row) throw new StoreError('not_found');
      if (row.status === 'submitted') throw new StoreError('invalid_state');
      if (row.revision !== expectedRevision) throw new StoreError('stale_revision');
      checkCaseLinks(workspaceId, projectId, enhanceRunId);
      checkReferences(row, draft);
      Object.assign(row, { title, projectId, enhanceRunId, draft: copy(draft), revision: row.revision + 1, updatedAt: stamp() });
      return copy(row);
    },
    // Consent binds the exact content: the revision edited and the hash of everything the snapshot will freeze
    // (draft, links, evidence, current credit records). Both are rechecked here against the data being frozen.
    async submitCapitalCase({ workspaceId, caseId, submittedBy, expectedRevision, contentHash }) {
      const row = caseOf(workspaceId, caseId);
      if (!row) throw new StoreError('not_found');
      if (row.status === 'submitted') {
        // A retry of the same revision and content gets the submission it already made; anything else waits for the review.
        const open = openSubmission(row.id);
        if (open && row.submittedRevision === expectedRevision) {
          if (open.contentHash !== contentHash) throw new StoreError('stale_revision', 'content');
          return copy(open);
        }
        throw new StoreError('invalid_state');
      }
      if (row.revision !== expectedRevision) throw new StoreError('stale_revision');
      if (capitalSubmissions.some((s) => s.caseId === row.id && s.revision === row.revision)) throw new StoreError('invalid_state');
      if (!draftComplete(row.draft)) throw new StoreError('invalid_state');
      checkReferences(row, row.draft);
      const snapshot = capitalSnapshot(row, currentCredits(workspaceId), evidenceOf(row.id));
      const hash = snapshotHash(snapshot);
      if (hash !== contentHash) throw new StoreError('stale_revision', 'content');
      const submission = { id: randomUUID(), caseId: row.id, workspaceId, revision: row.revision, snapshot, contentHash: hash, submittedBy, submittedAt: stamp(), decision: null, decidedBy: null, decidedAt: null, notes: null };
      capitalSubmissions.push(submission);
      Object.assign(row, { status: 'submitted', submittedRevision: row.revision, updatedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId, actorId: submittedBy, action: 'capital.submitted', targetType: 'capital_case', targetId: row.id, metadata: { submissionId: submission.id, revision: submission.revision }, createdAt: stamp() });
      return copy(submission);
    },
    async withdrawCapitalCase({ workspaceId, caseId, actorId }) {
      const row = caseOf(workspaceId, caseId);
      if (!row) throw new StoreError('not_found');
      const open = openSubmission(row.id);
      if (row.status !== 'submitted' || !open) throw new StoreError('invalid_state');
      Object.assign(open, { decision: 'withdrawn', decidedBy: actorId, decidedAt: stamp() });
      // The withdrawn revision stays on record; the draft gets a new revision number so it can be sent again.
      Object.assign(row, { status: 'draft', revision: row.revision + 1, updatedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId, actorId, action: 'capital.withdrawn', targetType: 'capital_case', targetId: row.id, metadata: { submissionId: open.id, revision: open.revision }, createdAt: stamp() });
      return copy(row);
    },
    async listCapitalSubmissions({ workspaceId, caseId }) {
      return capitalSubmissions.filter((s) => s.workspaceId === workspaceId && s.caseId === caseId).map(copy);
    },

    async listCreditRecords(workspaceId) {
      return creditRecords.filter((r) => r.workspaceId === workspaceId).map(withSupersededBy);
    },
    // Append-only: a correction is a new row that supersedes one earlier row, which can be corrected only once.
    async createCreditRecord({ workspaceId, createdBy, record, supersedes = null }) {
      if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
      if (supersedes != null) {
        if (!creditRecords.some((r) => r.id === supersedes && r.workspaceId === workspaceId)) throw new StoreError('not_found');
        if (creditRecords.some((r) => r.supersedes === supersedes)) throw new StoreError('invalid_state');
      }
      const row = { id: randomUUID(), workspaceId, ...pickCredit(record), supersedes, createdBy, createdAt: stamp() };
      creditRecords.push(row);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: supersedes ? 'credit_record.corrected' : 'credit_record.created', targetType: 'credit_record', targetId: row.id, metadata: { supersedes }, createdAt: stamp() });
      return withSupersededBy(row);
    },

    async listCapitalEvidence({ workspaceId, caseId }) {
      return capitalEvidence.filter((e) => e.workspaceId === workspaceId && e.caseId === caseId).map(copy);
    },
    async addCapitalEvidence({ workspaceId, caseId, createdBy, item }) {
      const row = caseOf(workspaceId, caseId);
      if (!row) throw new StoreError('not_found');
      if (row.status === 'submitted') throw new StoreError('invalid_state');
      const evidence = { id: randomUUID(), caseId: row.id, workspaceId, ...pickEvidence(item), createdBy, createdAt: stamp() };
      capitalEvidence.push(evidence);
      return copy(evidence);
    },
    async deleteCapitalEvidence({ workspaceId, caseId, evidenceId }) {
      const row = caseOf(workspaceId, caseId);
      if (!row) throw new StoreError('not_found');
      if (row.status === 'submitted') throw new StoreError('invalid_state');
      const i = capitalEvidence.findIndex((e) => e.id === evidenceId && e.caseId === row.id);
      if (i < 0) throw new StoreError('not_found');
      // An incurred cost cites its record; the record stays until that item changes (checked on the same row as edits).
      if (citedEvidenceIds(row.draft).has(evidenceId)) throw new StoreError('evidence_in_use');
      return copy(capitalEvidence.splice(i, 1)[0]);
    },
    async listCapitalReviewMarks({ workspaceId, caseId }) {
      const ids = new Set(capitalSubmissions.filter((s) => s.workspaceId === workspaceId && s.caseId === caseId).map((s) => s.id));
      return capitalReviewMarks.filter((m) => ids.has(m.submissionId)).map(copy);
    },

    // Staff queue across workspaces: only what was sent for review, as frozen in each submission. Live titles,
    // drafts, evidence and credit records changed since are never returned here.
    async listCapitalCasesForReview({ status = 'submitted' } = {}) {
      return capitalCases.filter((c) => c.status === status).map((c) => ({ ...caseMeta(c), workspaceName: workspaces.get(c.workspaceId).name, latestSubmission: latestSubmission(c.id) }));
    },
    async getCapitalCaseForReview(caseId) {
      const c = capitalCases.find((x) => x.id === caseId);
      if (!c) return null;
      const w = workspaces.get(c.workspaceId);
      const submission = latestSubmission(c.id);
      return { case: caseMeta(c), workspace: { id: w.id, name: w.name, kind: w.kind, synthetic: Boolean(w.profile?.synthetic) }, submission, marks: submission ? capitalReviewMarks.filter((m) => m.submissionId === submission.id).map(copy) : [] };
    },
    // A decision names the submission the reviewer saw. If the customer withdrew or sent a newer revision since,
    // that is a different submission and the decision is refused (stale_revision), never applied to the newer one.
    async decideCapitalSubmission({ caseId, submissionId, reviewerId, decision, notes = null }) {
      const row = capitalCases.find((x) => x.id === caseId);
      if (!row) throw new StoreError('not_found');
      const open = openSubmission(caseId);
      if (row.status !== 'submitted' || !open || !CASE_DECISIONS.includes(decision)) throw new StoreError('invalid_state');
      if (open.id !== submissionId) throw new StoreError('stale_revision', 'submission');
      Object.assign(open, { decision, decidedBy: reviewerId, decidedAt: stamp(), notes });
      Object.assign(row, { status: decision, updatedAt: stamp() });
      audit.push({ id: audit.length + 1, workspaceId: row.workspaceId, actorId: reviewerId, action: `capital.${decision}`, targetType: 'capital_case', targetId: caseId, metadata: { submissionId: open.id, revision: open.revision }, createdAt: stamp() });
      return copy(open);
    },
    // An append-only mark on one evidence id frozen in the submission the reviewer saw. The customer's record is not touched.
    async markCapitalEvidenceReviewed({ caseId, submissionId, evidenceId, reviewerId }) {
      const row = capitalCases.find((x) => x.id === caseId);
      if (!row) throw new StoreError('not_found');
      const open = openSubmission(caseId);
      if (row.status !== 'submitted' || !open) throw new StoreError('invalid_state');
      if (open.id !== submissionId) throw new StoreError('stale_revision', 'submission');
      if (!open.snapshot.evidence.some((e) => e.id === evidenceId)) throw new StoreError('not_found');
      const existing = capitalReviewMarks.find((m) => m.submissionId === open.id && m.evidenceId === evidenceId);
      if (existing) return copy(existing);
      const mark = { id: randomUUID(), submissionId: open.id, evidenceId, reviewerId, createdAt: stamp() };
      capitalReviewMarks.push(mark);
      audit.push({ id: audit.length + 1, workspaceId: row.workspaceId, actorId: reviewerId, action: 'capital.evidence_item_reviewed', targetType: 'capital_submission', targetId: open.id, metadata: { caseId, evidenceId }, createdAt: stamp() });
      return copy(mark);
    },

    async upsertReviewer({ username, name, role, passwordHash }) {
      const key = String(username).toLowerCase();
      const existing = reviewerAccounts.get(key);
      if (!existing && !passwordHash) throw new StoreError('not_found');
      const account = { username: key, name, role, passwordHash: passwordHash ?? existing.passwordHash, enabled: existing?.enabled ?? true, createdAt: existing?.createdAt ?? stamp(), updatedAt: stamp() };
      reviewerAccounts.set(key, account);
      return publicReviewer(account);
    },
    async getReviewer(username) {
      const a = reviewerAccounts.get(String(username).toLowerCase());
      return a ? publicReviewer(a) : null;
    },
    async getReviewerAuth(username) {
      const a = reviewerAccounts.get(String(username).toLowerCase());
      return a ? { account: publicReviewer(a), passwordHash: a.passwordHash } : null;
    },
    async setReviewerEnabled({ username, enabled }) {
      const a = reviewerAccounts.get(String(username).toLowerCase());
      if (!a) throw new StoreError('not_found');
      a.enabled = Boolean(enabled);
      a.updatedAt = stamp();
      return publicReviewer(a);
    },
    async listReviewers() {
      return [...reviewerAccounts.values()].map(publicReviewer).sort((a, b) => a.username.localeCompare(b.username));
    },

    async recordAudit({ workspaceId = null, actorId = null, action, targetType = null, targetId = null, metadata = {} }) {
      audit.push({ id: audit.length + 1, workspaceId, actorId, action, targetType, targetId, metadata: copy(metadata), createdAt: stamp() });
    },
    async listAudit(workspaceId, { limit = 50 } = {}) {
      return audit.filter((a) => a.workspaceId === workspaceId).slice(-limit).reverse().map(copy);
    },

    async close() {},
  };
}
