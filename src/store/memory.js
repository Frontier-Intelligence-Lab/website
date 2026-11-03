import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';

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
  const audit = [];
  const copy = (value) => (value == null ? null : structuredClone(value));
  const stamp = () => now().toISOString();
  const publicUser = ({ passwordHash, ...user }) => copy(user);

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
        success: null, dataSource: null, status: 'draft', setupStep: 'success', createdAt: stamp(), updatedAt: stamp(),
      };
      projects.set(project.id, project);
      audit.push({ id: audit.length + 1, workspaceId, actorId: createdBy, action: 'project.created', targetType: 'project', targetId: project.id, metadata: {}, createdAt: stamp() });
      return copy(project);
    },
    async updateProject({ workspaceId, projectId, patch }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) return null;
      const allowed = ['name', 'task', 'modalities', 'startingPoint', 'success', 'dataSource', 'status', 'setupStep'];
      for (const key of allowed) if (key in patch) project[key] = copy(patch[key]);
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

    async recordAudit({ workspaceId = null, actorId = null, action, targetType = null, targetId = null, metadata = {} }) {
      audit.push({ id: audit.length + 1, workspaceId, actorId, action, targetType, targetId, metadata: copy(metadata), createdAt: stamp() });
    },
    async listAudit(workspaceId, { limit = 50 } = {}) {
      return audit.filter((a) => a.workspaceId === workspaceId).slice(-limit).reverse().map(copy);
    },

    async close() {},
  };
}
