import { Pool } from 'pg';
import { StoreError } from './errors.js';
import { checkAnnotation, checkKind, computeIssues, kindFitsAnnotations, kindOf, labelSetConflict } from '../lib/dataset.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value) => typeof value === 'string' && UUID.test(value);
// Review-relevant content can change only while a project is editable; submitting freezes it.
const EDITABLE = ['draft', 'changes_requested'];
const CONTENT_FIELDS = ['name', 'task', 'modalities', 'startingPoint', 'success', 'dataSource', 'model'];
const lower = (value) => String(value).toLowerCase();
const iso = (value) => value == null ? null : new Date(value).toISOString();

/** One TLS policy for stores, migrations and sessions. URL options cannot override it. */
export function createPostgresPool({ connectionString, ssl = 'disable', logger } = {}) {
  const modes = { disable: false, require: { rejectUnauthorized: false }, 'verify-full': { rejectUnauthorized: true } };
  if (!Object.hasOwn(modes, ssl)) throw new Error('Invalid Postgres SSL mode');
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('Invalid Postgres connection string'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid Postgres connection string');
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }
  const pool = new Pool({ connectionString: url.toString(), ssl: modes[ssl] });
  pool.on('error', () => logger?.error?.('Postgres pool connection error'));
  return pool;
}

function databaseError(error) {
  if (error instanceof StoreError) return error;
  if (error.code === '23505') {
    const code = {
      users_email_lower_key: 'email_taken',
      workspaces_slug_key: 'slug_taken',
      workspaces_personal_owner_id_key: 'personal_exists',
      uploads_object_key_key: 'duplicate_upload',
    }[error.constraint];
    if (code) return new StoreError(code);
  }
  if (error.code === '23503') return new StoreError('not_found');
  // Raised by the freeze triggers in migrations/005_review_integrity.sql.
  if (error.code === 'P0001' && error.message === 'project_frozen') return new StoreError('invalid_state');
  // PostgreSQL details can contain complete rows, including hashes or private data.
  const safe = new Error('Postgres operation failed');
  if (typeof error.code === 'string') safe.code = error.code;
  return safe;
}

const userRow = (r) => r ? {
  id: r.id, email: r.email, name: r.name,
  emailVerifiedAt: iso(r.email_verified_at), createdAt: iso(r.created_at),
} : null;
const workspaceRow = (r) => r ? {
  id: r.id, kind: r.kind, name: r.name, slug: r.slug, website: r.website, domain: r.domain,
  domainVerified: r.domain_verified, joinByDomain: r.join_by_domain,
  industry: r.industry, sizeBand: r.size_band, profile: r.profile,
  createdBy: r.created_by, createdAt: iso(r.created_at),
} : null;
const invitationRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, email: r.email, role: r.role,
  invitedBy: r.invited_by, expiresAt: iso(r.expires_at), acceptedAt: iso(r.accepted_at),
  revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at),
});
const joinRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, userId: r.user_id, note: r.note,
  status: r.status, decidedBy: r.decided_by, decidedAt: iso(r.decided_at),
  createdAt: iso(r.created_at),
});
const projectRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, createdBy: r.created_by, name: r.name,
  task: r.task, modalities: r.modalities, startingPoint: r.starting_point,
  success: r.success, dataSource: r.data_source, model: r.model, labelSet: r.label_set ?? [], status: r.status, setupStep: r.setup_step,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;
const auditRow = (r) => ({
  id: Number(r.id), workspaceId: r.workspace_id, actorId: r.actor_id,
  action: r.action, targetType: r.target_type, targetId: r.target_id,
  metadata: r.metadata, createdAt: iso(r.created_at),
});
const uploadRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, uploadedBy: r.uploaded_by,
  objectKey: r.object_key, sha256: r.sha256, sizeBytes: Number(r.size_bytes),
  contentType: r.content_type, filename: r.filename, duplicateOf: r.duplicate_of,
  kind: r.kind ?? null, offsetMs: r.offset_ms == null ? null : Number(r.offset_ms),
  createdAt: iso(r.created_at),
} : null;
const annotationRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, uploadId: r.upload_id, labelId: r.label_id,
  startMs: r.start_ms == null ? null : Number(r.start_ms), endMs: r.end_ms == null ? null : Number(r.end_ms),
  box: r.box ?? null, createdBy: r.created_by, createdAt: iso(r.created_at),
});
const noteRow = (r) => ({ key: r.issue_key, note: r.note, createdBy: r.created_by, createdAt: iso(r.created_at) });
const reviewRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, submittedBy: r.submitted_by,
  status: r.status, reviewerId: r.reviewer_id, notes: r.notes, checks: r.checks, snapshot: r.snapshot ?? null,
  decidedAt: iso(r.decided_at), createdAt: iso(r.created_at),
} : null;
const reviewerRow = (r) => r ? {
  username: r.username, name: r.name, role: r.role, enabled: r.enabled,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;
const versionRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, number: r.number,
  createdBy: r.created_by, manifest: r.manifest, createdAt: iso(r.created_at),
});

export function createPostgresStore(options) {
  const pool = createPostgresPool(options);
  const query = async (text, values = [], client = pool) => {
    try { return await client.query(text, values); }
    catch (error) { throw databaseError(error); }
  };
  const transaction = async (fn) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw databaseError(error);
    } finally { client?.release(); }
  };
  const lockWorkspace = async (client, workspaceId) => {
    if (!isId(workspaceId)) throw new StoreError('not_found');
    const result = await query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId], client);
    if (!result.rowCount) throw new StoreError('not_found');
  };
  const lockProject = async (client, workspaceId, projectId) => {
    if (!isId(workspaceId) || !isId(projectId)) throw new StoreError('not_found');
    const result = await query('SELECT * FROM projects WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, projectId], client);
    if (!result.rowCount) throw new StoreError('not_found');
    return result.rows[0];
  };
  const addAudit = async (client, { workspaceId = null, actorId = null, action, targetType = null, targetId = null, metadata = {} }) => {
    await query(`INSERT INTO audit_events (workspace_id, actor_id, action, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [workspaceId, actorId, action, targetType, targetId, JSON.stringify(metadata)], client);
  };

  return {
    kind: 'postgres',

    async createUser({ email, name, passwordHash }) {
      const result = await query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *', [lower(email), name, passwordHash]);
      return userRow(result.rows[0]);
    },
    async getUserById(id) {
      if (!isId(id)) return null;
      return userRow((await query('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
    },
    async getUserAuthByEmail(email) {
      const row = (await query('SELECT * FROM users WHERE lower(email) = $1', [lower(email)])).rows[0];
      return row ? { user: userRow(row), passwordHash: row.password_hash } : null;
    },
    async setEmailVerified(userId) {
      if (!isId(userId)) throw new StoreError('not_found');
      const result = await query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, clock_timestamp())
        WHERE id = $1 RETURNING *`, [userId]);
      if (!result.rowCount) throw new StoreError('not_found');
      return userRow(result.rows[0]);
    },

    async createEmailCode({ userId, email, purpose, codeHash, expiresAt }) {
      if (!isId(userId)) throw new StoreError('not_found');
      await transaction(async (client) => {
        const user = await query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId], client);
        if (!user.rowCount) throw new StoreError('not_found');
        await query(`UPDATE email_codes SET consumed_at = clock_timestamp()
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`, [userId, purpose], client);
        await query(`INSERT INTO email_codes (user_id, email, purpose, code_hash, expires_at)
          VALUES ($1, $2, $3, $4, $5)`, [userId, lower(email), purpose, codeHash, expiresAt], client);
      });
    },
    async consumeEmailCode({ userId, purpose, codeHash }) {
      if (!isId(userId)) return { ok: false, reason: 'invalid' };
      return transaction(async (client) => {
        // Coordinate issuance and consumption as well as two simultaneous consumers.
        await query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId], client);
        const code = (await query(`SELECT *, expires_at <= clock_timestamp() AS expired FROM email_codes
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [userId, purpose], client)).rows[0];
        if (!code) return { ok: false, reason: 'invalid' };
        if (code.expired) return { ok: false, reason: 'expired' };
        if (code.attempts >= 5) return { ok: false, reason: 'too_many_attempts' };
        const matches = code.code_hash === codeHash;
        await query(`UPDATE email_codes SET attempts = attempts + 1,
          consumed_at = CASE WHEN $2 THEN clock_timestamp() ELSE consumed_at END WHERE id = $1`, [code.id, matches], client);
        if (!matches) return { ok: false, reason: code.attempts + 1 >= 5 ? 'too_many_attempts' : 'invalid' };
        return { ok: true, email: code.email };
      });
    },

    async isSlugAvailable(slug) {
      return !(await query('SELECT id FROM workspaces WHERE slug = $1', [lower(slug)])).rowCount;
    },
    async createWorkspace({ kind, name, slug, website = null, domain = null, domainVerified = false, joinByDomain = false, industry = null, sizeBand = null, profile = {}, ownerId }) {
      if (!isId(ownerId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        if ((await query('SELECT id FROM workspaces WHERE slug = $1', [lower(slug)], client)).rowCount) throw new StoreError('slug_taken');
        const verified = Boolean(domain && domainVerified);
        const row = (await query(`INSERT INTO workspaces
          (kind, name, slug, website, domain, domain_verified, join_by_domain, industry, size_band, profile, personal_owner_id, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) RETURNING *`,
        [kind, name, lower(slug), website, domain == null ? null : lower(domain), verified,
          Boolean(verified && joinByDomain), industry, sizeBand, JSON.stringify(profile), kind === 'personal' ? ownerId : null, ownerId], client)).rows[0];
        await query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [row.id, ownerId], client);
        await addAudit(client, { workspaceId: row.id, actorId: ownerId, action: 'workspace.created', targetType: 'workspace', targetId: row.id, metadata: { kind } });
        return workspaceRow(row);
      });
    },
    async getWorkspace(id) {
      if (!isId(id)) return null;
      return workspaceRow((await query('SELECT * FROM workspaces WHERE id = $1', [id])).rows[0]);
    },
    async findWorkspaceByJoinDomain(domain) {
      const row = (await query(`SELECT id, name, slug, domain FROM workspaces
        WHERE kind = 'organization' AND domain_verified AND join_by_domain AND domain = $1
        ORDER BY created_at, id LIMIT 1`, [lower(domain)])).rows[0];
      return row ?? null;
    },
    async listWorkspacesForUser(userId) {
      if (!isId(userId)) return [];
      return (await query(`SELECT w.*, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 ORDER BY m.created_at, w.id`, [userId])).rows.map(row => ({ workspace: workspaceRow(row), role: row.role }));
    },
    async getMembership(workspaceId, userId) {
      if (!isId(workspaceId) || !isId(userId)) return null;
      return (await query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])).rows[0] ?? null;
    },
    async listMembers(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query(`SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY m.created_at, u.id`, [workspaceId])).rows.map(row => ({ user: { id: row.id, name: row.name, email: row.email }, role: row.role }));
    },

    async createInvitations({ workspaceId, invitedBy, invites }) {
      return transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        for (const invite of invites) {
          const email = lower(invite.email);
          await query(`UPDATE invitations SET revoked_at = clock_timestamp()
            WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [workspaceId, email], client);
          await query(`INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)`, [workspaceId, email, invite.role, invite.tokenHash, invitedBy, invite.expiresAt], client);
        }
        await addAudit(client, { workspaceId, actorId: invitedBy, action: 'invitations.created', targetType: 'workspace', targetId: workspaceId, metadata: { count: invites.length } });
        return invites.length;
      });
    },
    async listInvitations(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query(`SELECT * FROM invitations WHERE workspace_id = $1
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()
        ORDER BY created_at, id`, [workspaceId])).rows.map(invitationRow);
    },
    async getInvitationByTokenHash(tokenHash) {
      const row = (await query(`SELECT i.*, w.name AS workspace_name, w.slug AS workspace_slug
        FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = $1`, [tokenHash])).rows[0];
      return row ? { ...invitationRow(row), workspaceName: row.workspace_name, workspaceSlug: row.workspace_slug } : null;
    },
    async acceptInvitation({ invitationId, userId }) {
      if (!isId(invitationId) || !isId(userId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const target = (await query('SELECT workspace_id FROM invitations WHERE id = $1', [invitationId], client)).rows[0];
        if (!target) throw new StoreError('not_found');
        // Share the workspace lock used by invitation replacement and membership changes.
        await lockWorkspace(client, target.workspace_id);
        const invite = (await query(`SELECT *, expires_at <= clock_timestamp() AS expired
          FROM invitations WHERE id = $1 FOR UPDATE`, [invitationId], client)).rows[0];
        if (!invite) throw new StoreError('not_found');
        if (invite.accepted_at || invite.revoked_at) throw new StoreError('already_decided');
        if (invite.expired) throw new StoreError('invite_expired');
        await query('UPDATE invitations SET accepted_at = clock_timestamp() WHERE id = $1', [invitationId], client);
        const added = await query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
          ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING role`, [invite.workspace_id, userId, invite.role], client);
        const member = added.rows[0] ?? (await query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [invite.workspace_id, userId], client)).rows[0];
        await addAudit(client, { workspaceId: invite.workspace_id, actorId: userId, action: 'invitation.accepted', targetType: 'invitation', targetId: invitationId, metadata: { role: invite.role } });
        return { workspaceId: invite.workspace_id, role: member.role, alreadyMember: added.rowCount === 0 };
      });
    },
    async revokeInvitation({ workspaceId, invitationId, actorId }) {
      if (!isId(invitationId)) throw new StoreError('not_found');
      await transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        const invite = (await query('SELECT * FROM invitations WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, invitationId], client)).rows[0];
        if (!invite) throw new StoreError('not_found');
        if (invite.accepted_at || invite.revoked_at) throw new StoreError('already_decided');
        await query('UPDATE invitations SET revoked_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2', [workspaceId, invitationId], client);
        await addAudit(client, { workspaceId, actorId, action: 'invitation.revoked', targetType: 'invitation', targetId: invitationId });
      });
    },
    async updateWorkspaceProfile({ workspaceId, profile }) {
      if (!isId(workspaceId)) throw new StoreError('not_found');
      const row = (await query('UPDATE workspaces SET profile = profile || $2::jsonb WHERE id = $1 RETURNING *', [workspaceId, JSON.stringify(profile)])).rows[0];
      if (!row) throw new StoreError('not_found');
      return workspaceRow(row);
    },

    async createJoinRequest({ workspaceId, userId, note = '' }) {
      if (!isId(userId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        if ((await query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId], client)).rowCount) throw new StoreError('already_member');
        const existing = (await query("SELECT * FROM join_requests WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'", [workspaceId, userId], client)).rows[0];
        if (existing) return joinRow(existing);
        return joinRow((await query('INSERT INTO join_requests (workspace_id, user_id, note) VALUES ($1, $2, $3) RETURNING *', [workspaceId, userId, note], client)).rows[0]);
      });
    },
    async listJoinRequests(workspaceId, { status = 'pending' } = {}) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM join_requests WHERE workspace_id = $1 AND status = $2 ORDER BY created_at, id', [workspaceId, status])).rows.map(joinRow);
    },
    async listJoinRequestsForUser(userId) {
      if (!isId(userId)) return [];
      return (await query(`SELECT r.*, w.name AS workspace_name FROM join_requests r JOIN workspaces w ON w.id = r.workspace_id
        WHERE r.user_id = $1 ORDER BY r.created_at, r.id`, [userId])).rows.map(row => ({ ...joinRow(row), workspaceName: row.workspace_name }));
    },
    async decideJoinRequest({ workspaceId, requestId, deciderId, approve, role = 'member' }) {
      if (!isId(requestId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        const row = (await query('SELECT * FROM join_requests WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, requestId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        if (row.status !== 'pending') throw new StoreError('already_decided');
        const decided = (await query(`UPDATE join_requests SET status = $3, decided_by = $4, decided_at = clock_timestamp()
          WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, requestId, approve ? 'approved' : 'declined', deciderId], client)).rows[0];
        if (approve) await query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)
          ON CONFLICT (workspace_id, user_id) DO NOTHING`, [workspaceId, row.user_id, role], client);
        await addAudit(client, { workspaceId, actorId: deciderId, action: approve ? 'join_request.approved' : 'join_request.declined', targetType: 'user', targetId: row.user_id });
        return joinRow(decided);
      });
    },

    async createProject({ workspaceId, createdBy, name, task, modalities = [], startingPoint }) {
      if (!isId(workspaceId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const row = (await query(`INSERT INTO projects (workspace_id, created_by, name, task, modalities, starting_point, model)
          VALUES ($1, $2, $3, $4, $5, $6, NULL) RETURNING *`, [workspaceId, createdBy, name, task, modalities, startingPoint], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'project.created', targetType: 'project', targetId: row.id });
        return projectRow(row);
      });
    },
    async updateProject({ workspaceId, projectId, patch }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const allowed = [...CONTENT_FIELDS, 'setupStep'];
      const changes = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
      const touchesContent = CONTENT_FIELDS.some(key => Object.hasOwn(changes, key));
      const result = await query(`UPDATE projects SET
        name = CASE WHEN $3::jsonb ? 'name' THEN $3::jsonb ->> 'name' ELSE name END,
        task = CASE WHEN $3::jsonb ? 'task' THEN $3::jsonb ->> 'task' ELSE task END,
        modalities = CASE WHEN $3::jsonb ? 'modalities' THEN ARRAY(SELECT jsonb_array_elements_text($3::jsonb -> 'modalities')) ELSE modalities END,
        starting_point = CASE WHEN $3::jsonb ? 'startingPoint' THEN $3::jsonb ->> 'startingPoint' ELSE starting_point END,
        success = CASE WHEN $3::jsonb ? 'success' THEN NULLIF($3::jsonb -> 'success', 'null'::jsonb) ELSE success END,
        data_source = CASE WHEN $3::jsonb ? 'dataSource' THEN NULLIF($3::jsonb -> 'dataSource', 'null'::jsonb) ELSE data_source END,
        model = CASE WHEN $3::jsonb ? 'model' THEN NULLIF($3::jsonb -> 'model', 'null'::jsonb) ELSE model END,
        setup_step = CASE WHEN $3::jsonb ? 'setupStep' THEN $3::jsonb ->> 'setupStep' ELSE setup_step END,
        updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND id = $2 AND (NOT $4 OR status = ANY($5::text[])) RETURNING *`,
      [workspaceId, projectId, JSON.stringify(changes), touchesContent, EDITABLE]);
      if (result.rowCount) return projectRow(result.rows[0]);
      // Distinguish a frozen project from one that does not exist here.
      const exists = (await query('SELECT 1 FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, projectId])).rowCount;
      if (exists) throw new StoreError('invalid_state');
      return null;
    },
    async getProject({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      return projectRow((await query('SELECT * FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, projectId])).rows[0]);
    },
    async listProjects(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(projectRow);
    },

    async createUpload({ workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, limits = {} }) {
      return transaction(async (client) => {
        // Serialize duplicate detection, quotas and the editable check with submission, including parallel receipts.
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        if (limits.maxFiles != null || limits.maxBytes != null) {
          const used = (await query('SELECT count(*)::int AS files, COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM uploads WHERE workspace_id = $1 AND project_id = $2', [workspaceId, projectId], client)).rows[0];
          if ((limits.maxFiles != null && used.files + 1 > limits.maxFiles) || (limits.maxBytes != null && Number(used.bytes) + sizeBytes > limits.maxBytes)) throw new StoreError('quota_exceeded');
        }
        const duplicate = (await query('SELECT id FROM uploads WHERE project_id = $1 AND sha256 = $2 AND duplicate_of IS NULL ORDER BY created_at, id LIMIT 1', [projectId, sha256], client)).rows[0];
        const row = (await query(`INSERT INTO uploads
          (workspace_id, project_id, uploaded_by, object_key, sha256, size_bytes, content_type, filename, duplicate_of)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [workspaceId, projectId, uploadedBy, objectKey, sha256, sizeBytes, contentType, filename, duplicate?.id ?? null], client)).rows[0];
        return uploadRow(row);
      });
    },
    async listUploads({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      return (await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id', [workspaceId, projectId])).rows.map(uploadRow);
    },
    async getUpload(uploadId) {
      if (!isId(uploadId)) return null;
      return uploadRow((await query('SELECT * FROM uploads WHERE id = $1', [uploadId])).rows[0]);
    },
    async deleteUpload({ workspaceId, projectId, uploadId, actorId }) {
      if (!isId(uploadId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const removed = (await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE', [workspaceId, projectId, uploadId], client)).rows[0];
        if (!removed) throw new StoreError('not_found');
        // The earliest copy of a removed original becomes the new original; repoint before deleting (FK).
        const copies = (await query('SELECT id FROM uploads WHERE project_id = $1 AND duplicate_of = $2 ORDER BY created_at, id', [projectId, uploadId], client)).rows;
        if (copies.length) {
          await query('UPDATE uploads SET duplicate_of = NULL WHERE id = $1', [copies[0].id], client);
          await query('UPDATE uploads SET duplicate_of = $1 WHERE project_id = $2 AND duplicate_of = $3', [copies[0].id, projectId, uploadId], client);
        }
        await query('DELETE FROM uploads WHERE id = $1', [uploadId], client);
        await addAudit(client, { workspaceId, actorId, action: 'upload.deleted', targetType: 'upload', targetId: uploadId, metadata: { sha256: removed.sha256 } });
        return uploadRow(removed);
      });
    },

    async setLabelSet({ workspaceId, projectId, labelSet }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        // Checked under the same lock that labelling takes, so a label cannot be removed while one is added.
        const used = new Set((await query('SELECT DISTINCT label_id FROM annotations WHERE project_id = $1', [projectId], client)).rows.map(r => r.label_id));
        const conflict = labelSetConflict(project.label_set ?? [], labelSet, used);
        if (conflict) throw new StoreError('label_in_use', conflict.name);
        const row = (await query('UPDATE projects SET label_set = $3::jsonb, updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2 RETURNING *', [workspaceId, projectId, JSON.stringify(labelSet)], client)).rows[0];
        return projectRow(row);
      });
    },
    async updateUpload({ workspaceId, projectId, uploadId, patch }) {
      if (!isId(uploadId)) throw new StoreError('not_found');
      const changes = Object.fromEntries(['kind', 'offsetMs'].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const current = uploadRow((await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [workspaceId, projectId, uploadId], client)).rows[0]);
        if (!current) throw new StoreError('not_found');
        if ('kind' in changes) {
          checkKind(current, changes.kind);
          const labels = (await query('SELECT * FROM annotations WHERE upload_id = $1', [uploadId], client)).rows.map(annotationRow);
          if (!kindFitsAnnotations(kindOf({ ...current, kind: changes.kind }), labels)) throw new StoreError('label_in_use', current.filename);
        }
        const row = (await query(`UPDATE uploads SET
          kind = CASE WHEN $4::jsonb ? 'kind' THEN $4::jsonb ->> 'kind' ELSE kind END,
          offset_ms = CASE WHEN $4::jsonb ? 'offsetMs' THEN ($4::jsonb ->> 'offsetMs')::bigint ELSE offset_ms END
          WHERE workspace_id = $1 AND project_id = $2 AND id = $3 RETURNING *`, [workspaceId, projectId, uploadId, JSON.stringify(changes)], client)).rows[0];
        return uploadRow(row);
      });
    },
    async listAnnotations({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      return (await query('SELECT * FROM annotations WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id', [workspaceId, projectId])).rows.map(annotationRow);
    },
    async createAnnotation({ workspaceId, projectId, uploadId, labelId, startMs = null, endMs = null, box = null, createdBy }) {
      if (!isId(uploadId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const upload = uploadRow((await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [workspaceId, projectId, uploadId], client)).rows[0]);
        if (!upload) throw new StoreError('not_found');
        // The label, its scope and the file's type are read under the project lock, so they cannot change underneath.
        const label = (project.label_set ?? []).find(l => l.id === labelId);
        const fit = checkAnnotation({ label, upload, startMs, endMs, box });
        const row = (await query(`INSERT INTO annotations (workspace_id, project_id, upload_id, label_id, start_ms, end_ms, box, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`, [workspaceId, projectId, uploadId, labelId, fit.startMs, fit.endMs, fit.box && JSON.stringify(fit.box), createdBy], client)).rows[0];
        return annotationRow(row);
      });
    },
    async updateAnnotation({ workspaceId, projectId, annotationId, patch }) {
      if (!isId(annotationId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const current = (await query('SELECT * FROM annotations WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE', [workspaceId, projectId, annotationId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        const a = annotationRow(current);
        const upload = uploadRow((await query('SELECT * FROM uploads WHERE id = $1', [a.uploadId], client)).rows[0]);
        const label = (project.label_set ?? []).find(l => l.id === a.labelId);
        const fit = checkAnnotation({ label, upload, startMs: patch.startMs ?? a.startMs, endMs: patch.endMs ?? a.endMs, box: patch.box ?? a.box });
        const row = (await query('UPDATE annotations SET start_ms = $2, end_ms = $3, box = $4::jsonb WHERE id = $1 RETURNING *', [annotationId, fit.startMs, fit.endMs, fit.box && JSON.stringify(fit.box)], client)).rows[0];
        return annotationRow(row);
      });
    },
    async deleteAnnotation({ workspaceId, projectId, annotationId }) {
      if (!isId(annotationId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const row = (await query('DELETE FROM annotations WHERE workspace_id = $1 AND project_id = $2 AND id = $3 RETURNING *', [workspaceId, projectId, annotationId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        return annotationRow(row);
      });
    },
    async listIssueNotes({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      return (await query('SELECT * FROM issue_notes WHERE workspace_id = $1 AND project_id = $2 ORDER BY issue_key', [workspaceId, projectId])).rows.map(noteRow);
    },
    async setIssueNote({ workspaceId, projectId, key, note, createdBy }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const row = (await query(`INSERT INTO issue_notes (workspace_id, project_id, issue_key, note, created_by) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (project_id, issue_key) DO UPDATE SET note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = clock_timestamp()
          RETURNING *`, [workspaceId, projectId, key, note, createdBy], client)).rows[0];
        return noteRow(row);
      });
    },
    async deleteIssueNote({ workspaceId, projectId, key }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        const row = (await query('DELETE FROM issue_notes WHERE workspace_id = $1 AND project_id = $2 AND issue_key = $3 RETURNING *', [workspaceId, projectId, key], client)).rows[0];
        if (!row) throw new StoreError('not_found');
      });
    },

    async submitForReview({ workspaceId, projectId, submittedBy, requireResolved = false }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!EDITABLE.includes(project.status)) throw new StoreError('invalid_state');
        if (requireResolved && project.data_source?.mode === 'upload') {
          // The gate reads files, labels and notes under the lock every write to them takes, so nothing slips in after the check.
          // One transaction client runs one query at a time, so these are sequential awaits.
          const uploads = await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id', [workspaceId, projectId], client);
          const annotations = await query('SELECT * FROM annotations WHERE project_id = $1', [projectId], client);
          const notes = await query('SELECT * FROM issue_notes WHERE project_id = $1', [projectId], client);
          const open = computeIssues({ project: projectRow(project), uploads: uploads.rows.map(uploadRow), annotations: annotations.rows.map(annotationRow), notes: notes.rows.map(noteRow) }).filter(i => i.open).length;
          if (open) throw Object.assign(new StoreError('issues_open'), { open });
        }
        // The reviewer decides on this snapshot, taken under the same lock that uploads and edits wait on.
        const files = (await query(`SELECT id, sha256, size_bytes, content_type, filename, object_key, kind, offset_ms FROM uploads
          WHERE workspace_id = $1 AND project_id = $2 AND duplicate_of IS NULL ORDER BY created_at, id`, [workspaceId, projectId], client)).rows
          .map(f => ({ id: f.id, sha256: f.sha256, sizeBytes: Number(f.size_bytes), contentType: f.content_type, filename: f.filename, objectKey: f.object_key, kind: f.kind ?? null, offsetMs: f.offset_ms == null ? null : Number(f.offset_ms) }));
        const ids = files.map(f => f.id);
        const annotations = (await query('SELECT * FROM annotations WHERE project_id = $1 AND upload_id = ANY($2::uuid[]) ORDER BY created_at, id', [projectId, ids], client)).rows
          .map(a => ({ id: a.id, uploadId: a.upload_id, labelId: a.label_id, startMs: a.start_ms == null ? null : Number(a.start_ms), endMs: a.end_ms == null ? null : Number(a.end_ms), box: a.box ?? null }));
        const issueNotes = (await query('SELECT * FROM issue_notes WHERE project_id = $1 ORDER BY issue_key', [projectId], client)).rows.map(n => ({ key: n.issue_key, note: n.note }));
        const snapshot = { task: project.task, modalities: project.modalities, startingPoint: project.starting_point, success: project.success, dataSource: project.data_source, model: project.model, labelSet: project.label_set ?? [], files, annotations, issueNotes };
        const row = (await query('INSERT INTO reviews (workspace_id, project_id, submitted_by, snapshot) VALUES ($1, $2, $3, $4::jsonb) RETURNING *', [workspaceId, projectId, submittedBy, JSON.stringify(snapshot)], client)).rows[0];
        await query("UPDATE projects SET status = 'in_review', updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2", [workspaceId, projectId], client);
        await addAudit(client, { workspaceId, actorId: submittedBy, action: 'review.submitted', targetType: 'project', targetId: projectId, metadata: { reviewId: row.id } });
        return reviewRow(row);
      });
    },
    async reopenProject({ workspaceId, projectId, actorId }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (!['in_review', 'approved', 'versioned'].includes(project.status)) throw new StoreError('invalid_state');
        if (!isId(actorId)) throw new StoreError('forbidden');
        const membership = (await query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR SHARE', [workspaceId, actorId], client)).rows[0];
        const role = membership?.role;
        if (!['owner', 'admin'].includes(role) && !(role === 'member' && project.status === 'in_review')) throw new StoreError('forbidden');
        await query("UPDATE reviews SET status = 'withdrawn', decided_at = clock_timestamp() WHERE project_id = $1 AND status = 'pending'", [projectId], client);
        const row = (await query("UPDATE projects SET status = 'draft', updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2 RETURNING *", [workspaceId, projectId], client)).rows[0];
        await addAudit(client, { workspaceId, actorId, action: 'project.reopened', targetType: 'project', targetId: projectId, metadata: { from: project.status } });
        return projectRow(row);
      });
    },
    async listReviews({ status = 'pending' } = {}) {
      return (await query(`SELECT r.*, p.name AS project_name, w.name AS workspace_name
        FROM reviews r JOIN projects p ON p.id = r.project_id JOIN workspaces w ON w.id = r.workspace_id
        WHERE r.status = $1 ORDER BY r.created_at, r.id`, [status])).rows.map(row => ({ ...reviewRow(row), projectName: row.project_name, workspaceName: row.workspace_name }));
    },
    async getReview(reviewId) {
      if (!isId(reviewId)) return null;
      return reviewRow((await query('SELECT * FROM reviews WHERE id = $1', [reviewId])).rows[0]);
    },
    async listProjectReviews({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      return (await query('SELECT * FROM reviews WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id', [workspaceId, projectId])).rows.map(reviewRow);
    },
    async decideReview({ reviewId, reviewerId, decision, notes = null, checks = {} }) {
      if (!isId(reviewId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const target = (await query('SELECT workspace_id, project_id FROM reviews WHERE id = $1', [reviewId], client)).rows[0];
        if (!target) throw new StoreError('not_found');
        // Lock projects before reviews consistently with submission/version creation.
        await lockProject(client, target.workspace_id, target.project_id);
        const review = (await query('SELECT * FROM reviews WHERE id = $1 FOR UPDATE', [reviewId], client)).rows[0];
        if (!review) throw new StoreError('not_found');
        if (review.status !== 'pending') throw new StoreError('already_decided');
        if (!['approved', 'changes_requested'].includes(decision)) throw new StoreError('invalid_state');
        const row = (await query(`UPDATE reviews SET status = $2, reviewer_id = $3, notes = $4,
          checks = $5::jsonb, decided_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [reviewId, decision, reviewerId, notes, JSON.stringify(checks)], client)).rows[0];
        await query('UPDATE projects SET status = $3, updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2', [review.workspace_id, review.project_id, decision], client);
        await addAudit(client, { workspaceId: review.workspace_id, actorId: reviewerId, action: `review.${decision}`, targetType: 'project', targetId: review.project_id, metadata: { reviewId } });
        return reviewRow(row);
      });
    },

    async createDatasetVersion({ workspaceId, projectId, createdBy }) {
      return transaction(async (client) => {
        const project = await lockProject(client, workspaceId, projectId);
        if (project.status !== 'approved') throw new StoreError('invalid_state');
        // Exactly the reviewed content: the approved snapshot of the latest review, never the live project.
        const approved = (await query('SELECT id, status, snapshot FROM reviews WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [projectId], client)).rows[0];
        if (approved?.status !== 'approved' || !approved.snapshot) throw new StoreError('invalid_state');
        const manifest = { reviewId: approved.id, ...approved.snapshot };
        const row = (await query(`INSERT INTO dataset_versions (workspace_id, project_id, number, created_by, manifest)
          SELECT $1, $2, COALESCE(MAX(number), 0) + 1, $3, $4::jsonb
          FROM dataset_versions WHERE project_id = $2 RETURNING *`,
        [workspaceId, projectId, createdBy, JSON.stringify(manifest)], client)).rows[0];
        await query("UPDATE projects SET status = 'versioned', updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2", [workspaceId, projectId], client);
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'dataset_version.created', targetType: 'project', targetId: projectId, metadata: { number: row.number, reviewId: approved.id } });
        return versionRow(row);
      });
    },
    async listDatasetVersions({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      return (await query('SELECT * FROM dataset_versions WHERE workspace_id = $1 AND project_id = $2 ORDER BY number', [workspaceId, projectId])).rows.map(versionRow);
    },

    async upsertReviewer({ username, name, role, passwordHash }) {
      const key = lower(username);
      const row = passwordHash
        ? (await query(`INSERT INTO reviewer_accounts (username, name, role, password_hash) VALUES ($1, $2, $3, $4)
            ON CONFLICT (username) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, updated_at = clock_timestamp()
            RETURNING *`, [key, name, role, passwordHash])).rows[0]
        : (await query('UPDATE reviewer_accounts SET name = $2, role = $3, updated_at = clock_timestamp() WHERE username = $1 RETURNING *', [key, name, role])).rows[0];
      if (!row) throw new StoreError('not_found');
      return reviewerRow(row);
    },
    async getReviewer(username) {
      return reviewerRow((await query('SELECT * FROM reviewer_accounts WHERE username = $1', [lower(username)])).rows[0]);
    },
    async getReviewerAuth(username) {
      const row = (await query('SELECT * FROM reviewer_accounts WHERE username = $1', [lower(username)])).rows[0];
      return row ? { account: reviewerRow(row), passwordHash: row.password_hash } : null;
    },
    async setReviewerEnabled({ username, enabled }) {
      const row = (await query('UPDATE reviewer_accounts SET enabled = $2, updated_at = clock_timestamp() WHERE username = $1 RETURNING *', [lower(username), Boolean(enabled)])).rows[0];
      if (!row) throw new StoreError('not_found');
      return reviewerRow(row);
    },
    async listReviewers() {
      return (await query('SELECT * FROM reviewer_accounts ORDER BY username')).rows.map(reviewerRow);
    },

    async recordAudit(event) { await addAudit(pool, event); },
    async listAudit(workspaceId, { limit = 50 } = {}) {
      if (workspaceId !== null && !isId(workspaceId)) return [];
      const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 50;
      return (await query(`SELECT * FROM audit_events WHERE workspace_id IS NOT DISTINCT FROM $1::uuid
        ORDER BY created_at DESC, id DESC LIMIT $2`, [workspaceId, count])).rows.map(auditRow);
    },
    async close() { await pool.end(); },
  };
}
