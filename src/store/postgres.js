import { Pool } from 'pg';
import { StoreError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value) => typeof value === 'string' && UUID.test(value);
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
    }[error.constraint];
    if (code) return new StoreError(code);
  }
  if (error.code === '23503') return new StoreError('not_found');
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
  success: r.success, dataSource: r.data_source, status: r.status, setupStep: r.setup_step,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;
const auditRow = (r) => ({
  id: Number(r.id), workspaceId: r.workspace_id, actorId: r.actor_id,
  action: r.action, targetType: r.target_type, targetId: r.target_id,
  metadata: r.metadata, createdAt: iso(r.created_at),
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
        const row = (await query(`INSERT INTO projects (workspace_id, created_by, name, task, modalities, starting_point)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [workspaceId, createdBy, name, task, modalities, startingPoint], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'project.created', targetType: 'project', targetId: row.id });
        return projectRow(row);
      });
    },
    async updateProject({ workspaceId, projectId, patch }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const allowed = ['name', 'task', 'modalities', 'startingPoint', 'success', 'dataSource', 'status', 'setupStep'];
      const changes = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
      const result = await query(`UPDATE projects SET
        name = CASE WHEN $3::jsonb ? 'name' THEN $3::jsonb ->> 'name' ELSE name END,
        task = CASE WHEN $3::jsonb ? 'task' THEN $3::jsonb ->> 'task' ELSE task END,
        modalities = CASE WHEN $3::jsonb ? 'modalities' THEN ARRAY(SELECT jsonb_array_elements_text($3::jsonb -> 'modalities')) ELSE modalities END,
        starting_point = CASE WHEN $3::jsonb ? 'startingPoint' THEN $3::jsonb ->> 'startingPoint' ELSE starting_point END,
        success = CASE WHEN $3::jsonb ? 'success' THEN NULLIF($3::jsonb -> 'success', 'null'::jsonb) ELSE success END,
        data_source = CASE WHEN $3::jsonb ? 'dataSource' THEN NULLIF($3::jsonb -> 'dataSource', 'null'::jsonb) ELSE data_source END,
        status = CASE WHEN $3::jsonb ? 'status' THEN $3::jsonb ->> 'status' ELSE status END,
        setup_step = CASE WHEN $3::jsonb ? 'setupStep' THEN $3::jsonb ->> 'setupStep' ELSE setup_step END,
        updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, projectId, JSON.stringify(changes)]);
      return projectRow(result.rows[0]);
    },
    async getProject({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      return projectRow((await query('SELECT * FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, projectId])).rows[0]);
    },
    async listProjects(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(projectRow);
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
