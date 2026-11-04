import { Pool } from 'pg';
import { StoreError } from './errors.js';
import { checkAnnotation, checkKind, computeIssues, kindFitsAnnotations, kindOf, labelSetConflict } from '../lib/dataset.js';
import { boxNotStoredForm, frozenBoxViolations } from '../lib/box-sql.js';
import { CASE_DECISIONS, capitalSnapshot, citedEvidenceIds, draftComplete, referencesResolve } from '../lib/capital.js';
import { snapshotHash } from '../lib/capital-hash.js';
import { LEASE_MS, MAX_ATTEMPTS, stableJson } from '../lib/jobs.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value) => typeof value === 'string' && UUID.test(value);
// Review-relevant content can change only while a project is editable; submitting freezes it.
const EDITABLE = ['draft', 'changes_requested'];
const CONTENT_FIELDS = ['name', 'task', 'modalities', 'startingPoint', 'success', 'dataSource', 'model'];
const HELD = ['leased', 'running', 'cancel_requested'];
const FINISHED = ['succeeded', 'failed', 'cancelled'];
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
      // migrations/013_capital.sql: a revision is submitted once; a credit record is corrected once.
      capital_submissions_case_id_revision_key: 'invalid_state',
      credit_records_supersedes_key: 'invalid_state',
    }[error.constraint];
    if (code) return new StoreError(code);
  }
  if (error.code === '23503') return new StoreError('not_found');
  // Raised by the freeze triggers in migrations/005_review_integrity.sql.
  if (error.code === 'P0001' && error.message === 'project_frozen') return new StoreError('invalid_state');
  // Raised by migrations/011_models.sql once an enhance run is requested.
  if (error.code === 'P0001' && error.message === 'run_frozen') return new StoreError('invalid_state');
  // Raised by migrations/013_capital.sql: submitted revisions and credit records never change.
  // Raised by migrations/014_jobs.sql: a job's inputs and finished jobs never change; events are append-only.
  if (error.code === 'P0001' && ['job_frozen', 'job_event_frozen'].includes(error.message)) return new StoreError('invalid_state');
  if (error.code === 'P0001' && ['submission_frozen', 'credit_record_frozen', 'review_mark_frozen'].includes(error.message)) return new StoreError('invalid_state');
  // PostgreSQL details can contain complete rows, including hashes or private data.
  const safe = new Error('Postgres operation failed');
  if (typeof error.code === 'string') safe.code = error.code;
  return safe;
}

const runnerRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, createdBy: r.created_by, label: r.label, keyPrefix: r.key_prefix, status: r.status,
  capabilities: r.capabilities, lastSeenAt: iso(r.last_seen_at), revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at),
});
const jobRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, runnerId: r.runner_id, kind: r.kind, enhanceRunId: r.enhance_run_id, spec: r.spec,
  status: r.status, attempt: r.attempt, maxAttempts: r.max_attempts, leaseExpiresAt: iso(r.lease_expires_at), result: r.result,
  failure: r.failure, idempotencyKey: r.idempotency_key, createdBy: r.created_by, cancelledBy: r.cancelled_by,
  createdAt: iso(r.created_at), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), updatedAt: iso(r.updated_at),
});
const eventRow = (r) => ({ id: Number(r.id), jobId: r.job_id, attempt: r.attempt, seq: r.seq, kind: r.kind, data: r.data, createdAt: iso(r.created_at) });
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
  // Set only by reads that ask Postgres whether the raw box is in 010's stored form (ANNOTATIONS_CHECKED).
  ...(r.box_not_stored_form ? { storedFormInvalid: true } : {}),
});
const noteRow = (r) => ({ key: r.issue_key, note: r.note, createdBy: r.created_by, createdAt: iso(r.created_at) });
const reviewRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, submittedBy: r.submitted_by,
  status: r.status, reviewerId: r.reviewer_id, notes: r.notes, checks: r.checks, snapshot: r.snapshot ?? null,
  decidedAt: iso(r.decided_at), createdAt: iso(r.created_at),
  ...(r.raw_invalid_box_ids ? { rawInvalidBoxIds: r.raw_invalid_box_ids } : {}),
} : null;
const reviewerRow = (r) => r ? {
  username: r.username, name: r.name, role: r.role, enabled: r.enabled,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;
const versionRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, number: r.number,
  createdBy: r.created_by, manifest: r.manifest, createdAt: iso(r.created_at),
  ...(r.raw_invalid_box_ids ? { rawInvalidBoxIds: r.raw_invalid_box_ids } : {}),
});

const pullRow = (r) => ({ id: r.id, workspaceId: r.workspace_id, modelId: r.model_id, status: r.status, requestedBy: r.requested_by, createdAt: iso(r.created_at) });
const runRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, name: r.name, baseModelId: r.base_model_id, datasets: r.datasets, steps: r.steps,
  compute: r.compute, spendCapUsd: r.spend_cap_usd, status: r.status, createdBy: r.created_by,
  requestedBy: r.requested_by, requestedAt: iso(r.requested_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;

const reportRow = (r) => r ? {
  id: r.id, deviceId: r.device_id, reachable: r.reachable, runtimeVersion: r.runtime_version, models: r.models, running: r.running,
  browser: r.browser, provenance: r.provenance, createdAt: iso(r.created_at),
} : null;
const deviceRow = (r, report = null) => r ? {
  id: r.id, workspaceId: r.workspace_id, ownerId: r.owner_id, label: r.label, runtime: r.runtime, status: r.status,
  lastSeenAt: iso(r.last_seen_at), revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at), latestReport: report,
} : null;
const installRow = (r) => ({
  id: r.id, deviceId: r.device_id, runtimeRef: r.runtime_ref, catalogId: r.catalog_id, digest: r.digest,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), details: r.details, state: r.state, failure: r.failure,
  verifiedAt: iso(r.verified_at), provenance: r.provenance, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const execRow = (r) => ({
  id: r.id, deviceId: r.device_id, installId: r.install_id, modelRef: r.model_ref, modelDigest: r.model_digest, location: r.location,
  kind: r.kind, warm: r.warm, status: r.status, failure: r.failure, settings: r.settings, metrics: r.metrics, task: r.task,
  promptSha256: r.prompt_sha256, provenance: r.provenance, createdAt: iso(r.created_at),
});

const caseRow = (r) => r ? {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, enhanceRunId: r.enhance_run_id, title: r.title, status: r.status,
  draft: r.draft, revision: r.revision, submittedRevision: r.submitted_revision, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
} : null;
const submissionRow = (r) => r ? {
  id: r.id, caseId: r.case_id, workspaceId: r.workspace_id, revision: r.revision, snapshot: r.snapshot, contentHash: r.content_hash, submittedBy: r.submitted_by,
  submittedAt: iso(r.submitted_at), decision: r.decision, decidedBy: r.decided_by, decidedAt: iso(r.decided_at), notes: r.notes,
} : null;
// What staff and the queue may see of a case: never its live title, links or draft.
const caseMetaRow = (r) => ({ id: r.id, workspaceId: r.workspace_id, status: r.status, revision: r.revision, submittedRevision: r.submitted_revision, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const markRow = (r) => ({ id: r.id, submissionId: r.submission_id, evidenceId: r.evidence_id, reviewerId: r.reviewer_id, createdAt: iso(r.created_at) });
// expires_on is a date: read as text so no time zone can shift the day.
const creditRow = (r) => ({
  id: r.id, workspaceId: r.workspace_id, provider: r.provider, status: r.status, amountCents: Number(r.amount_cents), expiresOn: r.expires_on_day ?? null,
  restrictions: r.restrictions, reference: r.reference, supersedes: r.supersedes, supersededBy: r.superseded_by ?? null, createdBy: r.created_by, createdAt: iso(r.created_at),
});
const evidenceRow = (r) => ({
  id: r.id, caseId: r.case_id, workspaceId: r.workspace_id, kind: r.kind, title: r.title, source: r.source, reference: r.reference,
  verification: r.verification, createdBy: r.created_by, createdAt: iso(r.created_at),
});
const CREDITS = `SELECT c.*, c.expires_on::text AS expires_on_day, n.id AS superseded_by FROM credit_records c
  LEFT JOIN credit_records n ON n.supersedes = c.id`;

// Reads that feed Resolve, the submit gate and history warnings ask Postgres for 010's verdict on the raw jsonb,
// before node-postgres turns its numbers into JavaScript numbers and can hide digits a double cannot hold.
const ANNOTATIONS_CHECKED = `SELECT *, ${boxNotStoredForm('box')} AS box_not_stored_form FROM annotations`;

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
  // A device write needs the person's own, active device; the row lock orders it against revocation.
  const lockActiveDevice = async (client, { workspaceId, ownerId, deviceId }) => {
    const d = (await query('SELECT status FROM devices WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 FOR SHARE', [deviceId, workspaceId, ownerId], client)).rows[0];
    if (!d) throw new StoreError('not_found');
    if (d.status !== 'active') throw new StoreError('invalid_state');
  };
  // Every capital write takes the case row lock, so submission, edits, evidence changes and decisions are serialized.
  const lockCase = async (client, workspaceId, caseId) => {
    if (!isId(workspaceId) || !isId(caseId)) throw new StoreError('not_found');
    const row = (await query('SELECT * FROM capital_cases WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, caseId], client)).rows[0];
    if (!row) throw new StoreError('not_found');
    return row;
  };
  // Under the case lock: every reference the draft makes must resolve against the rows that exist right now.
  const checkCaseReferences = async (client, c, draft) => {
    const evidence = (await query('SELECT id FROM capital_evidence WHERE case_id = $1', [c.id], client)).rows.map((r) => r.id);
    const frozen = (await query('SELECT project_id, number FROM dataset_versions WHERE workspace_id = $1', [c.workspace_id], client)).rows.map((r) => ({ projectId: r.project_id, version: r.number }));
    if (!referencesResolve(draft, { evidenceIds: new Set(evidence), versions: frozen })) throw new StoreError('missing_reference');
  };
  const DEVICE_WITH_REPORT = `SELECT d.*, to_jsonb(r) AS report FROM devices d
    LEFT JOIN LATERAL (SELECT * FROM device_reports WHERE device_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true`;
  // A lease that ran out without word from the runner: retried while attempts remain, honoured if cancel was asked.
  // The CASEs read the row's values from before this UPDATE.
  const LEASE_SCOPES = { id: 'id', workspace: 'workspace_id', runner: 'runner_id' };
  const expireLeases = async (scope, value, client = pool) => {
    const column = LEASE_SCOPES[scope];
    if (!column) throw new Error('Unknown lease scope');
    await query(`UPDATE jobs SET
        status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
        failure = CASE WHEN status <> 'cancel_requested' AND attempt >= max_attempts THEN 'lease_expired' ELSE failure END,
        finished_at = CASE WHEN status = 'cancel_requested' OR attempt >= max_attempts THEN clock_timestamp() END,
        lease_hash = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE status IN ('leased', 'running', 'cancel_requested') AND lease_expires_at <= clock_timestamp() AND ${column} = $1`, [value], client);
  };
  const lockHeldJob = async (client, { runnerId, jobId, leaseHash }) => {
    if (!isId(runnerId) || !isId(jobId)) throw new StoreError('not_found');
    await expireLeases('id', jobId, client);
    const j = (await query('SELECT * FROM jobs WHERE id = $1 AND runner_id = $2 FOR UPDATE', [jobId, runnerId], client)).rows[0];
    if (!j) throw new StoreError('not_found');
    if (!HELD.includes(j.status) || j.lease_hash !== leaseHash) throw new StoreError('lease_lost');
    // The row lock may have taken a while: decide on the lease with the clock as it is now, after the wait.
    const { expired } = (await query('SELECT lease_expires_at <= clock_timestamp() AS expired FROM jobs WHERE id = $1', [jobId], client)).rows[0];
    if (expired) throw new StoreError('lease_lost');
    return j;
  };
  const extendLease = async (client, j, leaseMs) => (await query(`UPDATE jobs SET status = CASE WHEN status = 'leased' THEN 'running' ELSE status END,
    lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000), updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
  [j.id, leaseMs], client)).rows[0];
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
      return (await query(`${ANNOTATIONS_CHECKED} WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id`, [workspaceId, projectId])).rows.map(annotationRow);
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
        if (requireResolved) {
          // The gate reads files, labels and notes under the lock every write to them takes, so nothing slips in after the check.
          // One transaction client runs one query at a time, so these are sequential awaits.
          const uploads = await query('SELECT * FROM uploads WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at, id', [workspaceId, projectId], client);
          const annotations = await query(`${ANNOTATIONS_CHECKED} WHERE project_id = $1`, [projectId], client);
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
      return reviewRow((await query(`SELECT *, ${frozenBoxViolations('snapshot')} AS raw_invalid_box_ids FROM reviews WHERE id = $1`, [reviewId])).rows[0]);
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
      return (await query(`SELECT *, ${frozenBoxViolations('manifest')} AS raw_invalid_box_ids FROM dataset_versions WHERE workspace_id = $1 AND project_id = $2 ORDER BY number`, [workspaceId, projectId])).rows.map(versionRow);
    },

    async listModelPulls(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM model_pulls WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(pullRow);
    },
    // Asking twice returns the first request: one copy of a model per workspace.
    async requestModelPull({ workspaceId, modelId, requestedBy }) {
      if (!isId(workspaceId)) throw new StoreError('not_found');
      const inserted = (await query(`INSERT INTO model_pulls (workspace_id, model_id, requested_by) VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, model_id) DO NOTHING RETURNING *`, [workspaceId, modelId, requestedBy])).rows[0];
      return pullRow(inserted ?? (await query('SELECT * FROM model_pulls WHERE workspace_id = $1 AND model_id = $2', [workspaceId, modelId])).rows[0]);
    },
    async listEnhanceRuns(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM enhance_runs WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(runRow);
    },
    async getEnhanceRun({ workspaceId, runId }) {
      if (!isId(workspaceId) || !isId(runId)) return null;
      return runRow((await query('SELECT * FROM enhance_runs WHERE workspace_id = $1 AND id = $2', [workspaceId, runId])).rows[0]);
    },
    async createEnhanceRun({ workspaceId, createdBy, run }) {
      if (!isId(workspaceId)) throw new StoreError('not_found');
      return runRow((await query(`INSERT INTO enhance_runs (workspace_id, name, base_model_id, datasets, steps, compute, spend_cap_usd, created_by)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING *`,
      [workspaceId, run.name, run.baseModelId, JSON.stringify(run.datasets), JSON.stringify(run.steps), run.compute, run.spendCapUsd, createdBy])).rows[0]);
    },
    async updateEnhanceRun({ workspaceId, runId, run }) {
      if (!isId(workspaceId) || !isId(runId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const current = (await query('SELECT status FROM enhance_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, runId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (current.status !== 'draft') throw new StoreError('invalid_state');
        return runRow((await query(`UPDATE enhance_runs SET name = $3, base_model_id = $4, datasets = $5::jsonb, steps = $6::jsonb, compute = $7,
          spend_cap_usd = $8, updated_at = greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond')
          WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [workspaceId, runId, run.name, run.baseModelId, JSON.stringify(run.datasets), JSON.stringify(run.steps), run.compute, run.spendCapUsd], client)).rows[0]);
      });
    },
    async requestEnhanceRun({ workspaceId, runId, requestedBy, expectedUpdatedAt }) {
      if (!isId(workspaceId) || !isId(runId)) throw new StoreError('not_found');
      const expected = expectedUpdatedAt == null ? NaN : Date.parse(expectedUpdatedAt);
      return transaction(async (client) => {
        const current = (await query('SELECT * FROM enhance_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [workspaceId, runId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (current.status !== 'draft') throw new StoreError('invalid_state');
        // Compared at the millisecond precision the API exposes, under the row lock, so a concurrent edit cannot slip in.
        if (Number.isNaN(expected) || new Date(current.updated_at).getTime() !== expected) throw new StoreError('stale_plan');
        if (current.status !== 'draft' || !current.datasets.length || !current.steps.length || !current.compute || current.spend_cap_usd == null) throw new StoreError('invalid_state');
        const row = (await query(`UPDATE enhance_runs SET status = 'requested', requested_by = $3, requested_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, runId, requestedBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: requestedBy, action: 'enhance_run.requested', targetType: 'enhance_run', targetId: runId, metadata: { spendCapUsd: row.spend_cap_usd } });
        return runRow(row);
      });
    },

    // Devices belong to one person in one workspace; every statement filters on both.
    async createDevice({ workspaceId, ownerId, label, runtime = 'ollama' }) {
      if (!isId(workspaceId) || !isId(ownerId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const row = (await query('INSERT INTO devices (workspace_id, owner_id, label, runtime) VALUES ($1, $2, $3, $4) RETURNING *', [workspaceId, ownerId, label, runtime], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: ownerId, action: 'device.registered', targetType: 'device', targetId: row.id, metadata: { runtime } });
        return deviceRow(row);
      });
    },
    async listDevices({ workspaceId, ownerId }) {
      if (!isId(workspaceId) || !isId(ownerId)) return [];
      const rows = (await query(`${DEVICE_WITH_REPORT} WHERE d.workspace_id = $1 AND d.owner_id = $2 ORDER BY d.created_at, d.id`, [workspaceId, ownerId])).rows;
      return rows.map((r) => deviceRow(r, reportRow(r.report)));
    },
    async getDevice({ workspaceId, ownerId, deviceId }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) return null;
      const r = (await query(`${DEVICE_WITH_REPORT} WHERE d.id = $1 AND d.workspace_id = $2 AND d.owner_id = $3`, [deviceId, workspaceId, ownerId])).rows[0];
      return r ? deviceRow(r, reportRow(r.report)) : null;
    },
    async revokeDevice({ workspaceId, ownerId, deviceId }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) throw new StoreError('not_found');
      await transaction(async (client) => {
        const current = (await query('SELECT status FROM devices WHERE id = $1 AND workspace_id = $2 AND owner_id = $3 FOR UPDATE', [deviceId, workspaceId, ownerId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (current.status !== 'active') throw new StoreError('invalid_state');
        await query("UPDATE devices SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = $1", [deviceId], client);
        await addAudit(client, { workspaceId, actorId: ownerId, action: 'device.revoked', targetType: 'device', targetId: deviceId });
      });
      const r = (await query(`${DEVICE_WITH_REPORT} WHERE d.id = $1`, [deviceId])).rows[0];
      return deviceRow(r, reportRow(r.report));
    },
    async recordDeviceReport({ workspaceId, ownerId, deviceId, report }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockActiveDevice(client, { workspaceId, ownerId, deviceId });
        const row = (await query(`INSERT INTO device_reports (device_id, workspace_id, owner_id, reachable, runtime_version, models, running, browser)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb) RETURNING *`,
        [deviceId, workspaceId, ownerId, report.reachable, report.runtimeVersion, JSON.stringify(report.models), JSON.stringify(report.running), JSON.stringify(report.browser)], client)).rows[0];
        await query('UPDATE devices SET last_seen_at = $2 WHERE id = $1', [deviceId, row.created_at], client);
        return reportRow(row);
      });
    },
    async saveModelInstall({ workspaceId, ownerId, deviceId, install }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockActiveDevice(client, { workspaceId, ownerId, deviceId });
        const previous = (await query('SELECT state FROM model_installs WHERE device_id = $1 AND runtime_ref = $2 FOR UPDATE', [deviceId, install.runtimeRef], client)).rows[0];
        // verified_at is kept while the same digest stays verified; a new digest or a lapse is a new verification.
        const row = (await query(`INSERT INTO model_installs (device_id, workspace_id, owner_id, runtime_ref, catalog_id, digest, size_bytes, details, state, failure, verified_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text, $10, CASE WHEN $9::text IN ('verified', 'ready') THEN clock_timestamp() END)
          ON CONFLICT (device_id, runtime_ref) DO UPDATE SET catalog_id = EXCLUDED.catalog_id, digest = EXCLUDED.digest, size_bytes = EXCLUDED.size_bytes,
            details = EXCLUDED.details, state = EXCLUDED.state, failure = EXCLUDED.failure, updated_at = clock_timestamp(),
            verified_at = CASE WHEN EXCLUDED.state NOT IN ('verified', 'ready') THEN NULL
              WHEN model_installs.verified_at IS NOT NULL AND model_installs.digest = EXCLUDED.digest THEN model_installs.verified_at
              ELSE clock_timestamp() END
          RETURNING *`,
        [deviceId, workspaceId, ownerId, install.runtimeRef, install.catalogId, install.digest, install.sizeBytes, JSON.stringify(install.details), install.state, install.failure], client)).rows[0];
        if (previous?.state !== row.state) await addAudit(client, { workspaceId, actorId: ownerId, action: `model_install.${row.state}`, targetType: 'model_install', targetId: row.id, metadata: { runtimeRef: row.runtime_ref, digest: row.digest } });
        return installRow(row);
      });
    },
    async listModelInstalls({ workspaceId, ownerId, deviceId }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) return [];
      return (await query('SELECT * FROM model_installs WHERE device_id = $1 AND workspace_id = $2 AND owner_id = $3 ORDER BY runtime_ref', [deviceId, workspaceId, ownerId])).rows.map(installRow);
    },
    async recordExecutionRun({ workspaceId, ownerId, deviceId, run }) {
      if (![workspaceId, ownerId, deviceId].every(isId) || (run.installId != null && !isId(run.installId))) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockActiveDevice(client, { workspaceId, ownerId, deviceId });
        if (run.installId && !(await query('SELECT 1 FROM model_installs WHERE id = $1 AND device_id = $2', [run.installId, deviceId], client)).rows[0]) throw new StoreError('not_found');
        const row = (await query(`INSERT INTO execution_runs (device_id, workspace_id, owner_id, install_id, model_ref, model_digest, location, kind, warm, status, failure, settings, metrics, task, prompt_sha256)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15) RETURNING *`,
        [deviceId, workspaceId, ownerId, run.installId, run.modelRef, run.modelDigest, run.location, run.kind, run.warm, run.status, run.failure,
          JSON.stringify(run.settings), JSON.stringify(run.metrics), run.task == null ? null : JSON.stringify(run.task), run.promptSha256], client)).rows[0];
        return execRow(row);
      });
    },
    async listExecutionRuns({ workspaceId, ownerId, deviceId, limit = 50 }) {
      if (![workspaceId, ownerId, deviceId].every(isId)) return [];
      return (await query(`SELECT * FROM execution_runs WHERE device_id = $1 AND workspace_id = $2 AND owner_id = $3
        ORDER BY created_at DESC, id DESC LIMIT $4`, [deviceId, workspaceId, ownerId, Math.min(Math.max(1, limit), 200)])).rows.map(execRow);
    },

    // Runners and jobs (migrations/014_jobs.sql). Leasing locks the runner row, so a runner holds one job at a time.
    async createRunner({ workspaceId, createdBy, label, keyHash, keyPrefix }) {
      if (!isId(workspaceId) || !isId(createdBy)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const row = (await query('INSERT INTO runners (workspace_id, created_by, label, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $5) RETURNING *',
          [workspaceId, createdBy, label, keyHash, keyPrefix], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'runner.linked', targetType: 'runner', targetId: row.id });
        return runnerRow(row);
      });
    },
    async listRunners(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM runners WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(runnerRow);
    },
    async getRunner({ workspaceId, runnerId }) {
      if (!isId(workspaceId) || !isId(runnerId)) return null;
      const r = (await query('SELECT * FROM runners WHERE id = $1 AND workspace_id = $2', [runnerId, workspaceId])).rows[0];
      return r ? runnerRow(r) : null;
    },
    async findActiveRunnerByKeyHash(keyHash) {
      if (!/^[0-9a-f]{64}$/.test(keyHash ?? '')) return null;
      const r = (await query("SELECT * FROM runners WHERE key_hash = $1 AND status = 'active'", [keyHash])).rows[0];
      return r ? runnerRow(r) : null;
    },
    async revokeRunner({ workspaceId, runnerId, actorId }) {
      if (![workspaceId, runnerId, actorId].every(isId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const current = (await query('SELECT status FROM runners WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runnerId, workspaceId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (current.status !== 'active') throw new StoreError('invalid_state');
        const row = (await query("UPDATE runners SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = $1 RETURNING *", [runnerId], client)).rows[0];
        await query(`UPDATE jobs SET status = 'cancelled', cancelled_by = $2, finished_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE runner_id = $1 AND status = 'queued'`, [runnerId, actorId], client);
        await query(`UPDATE jobs SET status = 'failed', failure = 'runner_revoked', lease_hash = NULL, lease_expires_at = NULL,
          finished_at = clock_timestamp(), updated_at = clock_timestamp() WHERE runner_id = $1 AND status IN ('leased', 'running', 'cancel_requested')`, [runnerId], client);
        await addAudit(client, { workspaceId, actorId, action: 'runner.revoked', targetType: 'runner', targetId: runnerId });
        return runnerRow(row);
      });
    },
    async reportRunner({ runnerId, capabilities }) {
      if (!isId(runnerId)) throw new StoreError('invalid_state');
      const r = (await query("UPDATE runners SET capabilities = $2::jsonb, last_seen_at = clock_timestamp() WHERE id = $1 AND status = 'active' RETURNING *",
        [runnerId, JSON.stringify(capabilities)])).rows[0];
      if (!r) throw new StoreError('invalid_state');
      return runnerRow(r);
    },
    async createJob({ workspaceId, runnerId, kind, enhanceRunId = null, spec, idempotencyKey, createdBy }) {
      if (![workspaceId, runnerId, createdBy].every(isId) || (enhanceRunId != null && !isId(enhanceRunId))) throw new StoreError('not_found');
      return transaction(async (client) => {
        // The same key must mean the same request, including every frozen input (training run, artifact, plan version).
        const same = (row) => row.kind === kind && row.runner_id === runnerId && (row.enhance_run_id ?? null) === enhanceRunId && stableJson(row.spec) === stableJson(spec);
        const prior = (await query('SELECT * FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, idempotencyKey], client)).rows[0];
        if (prior) {
          if (!same(prior)) throw new StoreError('invalid_state');
          return jobRow(prior);
        }
        const runner = (await query('SELECT status FROM runners WHERE id = $1 AND workspace_id = $2 FOR SHARE', [runnerId, workspaceId], client)).rows[0];
        if (!runner) throw new StoreError('not_found');
        if (runner.status !== 'active') throw new StoreError('invalid_state');
        const row = (await query(`INSERT INTO jobs (workspace_id, runner_id, kind, enhance_run_id, spec, idempotency_key, created_by, max_attempts)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
        [workspaceId, runnerId, kind, enhanceRunId, JSON.stringify(spec), idempotencyKey, createdBy, MAX_ATTEMPTS], client)).rows[0];
        if (!row) {
          // A concurrent request with the same key won the insert.
          const raced = (await query('SELECT * FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, idempotencyKey], client)).rows[0];
          if (!same(raced)) throw new StoreError('invalid_state');
          return jobRow(raced);
        }
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'job.created', targetType: 'job', targetId: row.id, metadata: { kind, runnerId } });
        return jobRow(row);
      });
    },
    async listJobs({ workspaceId, limit = 50 }) {
      if (!isId(workspaceId)) return [];
      await expireLeases('workspace', workspaceId);
      return (await query('SELECT * FROM jobs WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [workspaceId, limit])).rows.map(jobRow);
    },
    async getJob({ workspaceId, jobId }) {
      if (!isId(workspaceId) || !isId(jobId)) return null;
      await expireLeases('id', jobId);
      const r = (await query('SELECT * FROM jobs WHERE id = $1 AND workspace_id = $2', [jobId, workspaceId])).rows[0];
      return r ? jobRow(r) : null;
    },
    async listJobEvents({ workspaceId, jobId, afterId = 0, limit = 500 }) {
      if (!isId(workspaceId) || !isId(jobId)) return [];
      return (await query('SELECT * FROM job_events WHERE job_id = $1 AND workspace_id = $2 AND id > $3 ORDER BY id LIMIT $4',
        [jobId, workspaceId, afterId, limit])).rows.map(eventRow);
    },
    async cancelJob({ workspaceId, jobId, actorId }) {
      if (![workspaceId, jobId, actorId].every(isId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await expireLeases('id', jobId, client);
        const j = (await query('SELECT * FROM jobs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [jobId, workspaceId], client)).rows[0];
        if (!j) throw new StoreError('not_found');
        if (FINISHED.includes(j.status)) throw new StoreError('invalid_state');
        let row = j;
        if (j.status === 'queued') {
          row = (await query(`UPDATE jobs SET status = 'cancelled', cancelled_by = $2, finished_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1 RETURNING *`, [jobId, actorId], client)).rows[0];
        } else if (j.status !== 'cancel_requested') {
          row = (await query("UPDATE jobs SET status = 'cancel_requested', cancelled_by = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [jobId, actorId], client)).rows[0];
        }
        await addAudit(client, { workspaceId, actorId, action: 'job.cancel_requested', targetType: 'job', targetId: jobId });
        return jobRow(row);
      });
    },
    async leaseJob({ runnerId, leaseHash, leaseMs = LEASE_MS }) {
      if (!isId(runnerId)) return null;
      return transaction(async (client) => {
        const runner = (await query("SELECT id FROM runners WHERE id = $1 AND status = 'active' FOR UPDATE", [runnerId], client)).rows[0];
        if (!runner) throw new StoreError('invalid_state');
        await expireLeases('runner', runnerId, client);
        const held = (await query(`SELECT 1 FROM jobs WHERE runner_id = $1 AND status IN ('leased', 'running', 'cancel_requested')`, [runnerId], client)).rows[0];
        if (held) return null;
        const next = (await query("SELECT id FROM jobs WHERE runner_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED", [runnerId], client)).rows[0];
        if (!next) return null;
        const row = (await query(`UPDATE jobs SET status = 'leased', attempt = attempt + 1, lease_hash = $2,
          lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000), started_at = COALESCE(started_at, clock_timestamp()),
          updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [next.id, leaseHash, leaseMs], client)).rows[0];
        return jobRow(row);
      });
    },
    async getRunnerJob({ runnerId, jobId }) {
      if (!isId(runnerId) || !isId(jobId)) return null;
      await expireLeases('id', jobId);
      const r = (await query('SELECT * FROM jobs WHERE id = $1 AND runner_id = $2', [jobId, runnerId])).rows[0];
      return r ? jobRow(r) : null;
    },
    async touchJob({ runnerId, jobId, leaseHash, leaseMs = LEASE_MS }) {
      return transaction(async (client) => jobRow(await extendLease(client, await lockHeldJob(client, { runnerId, jobId, leaseHash }), leaseMs)));
    },
    async appendJobEvents({ runnerId, jobId, leaseHash, events, leaseMs = LEASE_MS }) {
      return transaction(async (client) => {
        const j = await lockHeldJob(client, { runnerId, jobId, leaseHash });
        const added = (await query(`INSERT INTO job_events (job_id, workspace_id, attempt, seq, kind, data)
          SELECT $1, $2, $3, e.seq, e.kind, e.data FROM jsonb_to_recordset($4::jsonb) AS e(seq integer, kind text, data jsonb)
          ON CONFLICT (job_id, attempt, seq) DO NOTHING`, [jobId, j.workspace_id, j.attempt, JSON.stringify(events)], client)).rowCount;
        return { added, job: jobRow(await extendLease(client, j, leaseMs)) };
      });
    },
    async finishJob({ runnerId, jobId, leaseHash, outcome, result = null, failure = null, retryable = false }) {
      return transaction(async (client) => {
        const j = await lockHeldJob(client, { runnerId, jobId, leaseHash });
        const done = "lease_hash = NULL, lease_expires_at = NULL, finished_at = clock_timestamp(), updated_at = clock_timestamp()";
        let row;
        // Cancellation contract (docs/RUNNERS.md): once cancel is requested, the job ends cancelled, whatever the runner reports.
        if (j.status === 'cancel_requested' || (outcome === 'failed' && failure === 'cancelled')) row = (await query(`UPDATE jobs SET status = 'cancelled', ${done} WHERE id = $1 RETURNING *`, [jobId], client)).rows[0];
        else if (outcome === 'succeeded') row = (await query(`UPDATE jobs SET status = 'succeeded', result = $2::jsonb, ${done} WHERE id = $1 RETURNING *`, [jobId, JSON.stringify(result)], client)).rows[0];
        else if (retryable && j.attempt < j.max_attempts) row = (await query("UPDATE jobs SET status = 'queued', lease_hash = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [jobId], client)).rows[0];
        else row = (await query(`UPDATE jobs SET status = 'failed', failure = $2, ${done} WHERE id = $1 RETURNING *`, [jobId, failure], client)).rows[0];
        return jobRow(row);
      });
    },

    // Capital: cases with an editable, revisioned draft; frozen submitted revisions; append-only credit records; evidence references.
    async listCapitalCases(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM capital_cases WHERE workspace_id = $1 ORDER BY created_at, id', [workspaceId])).rows.map(caseRow);
    },
    async getCapitalCase({ workspaceId, caseId }) {
      if (!isId(workspaceId) || !isId(caseId)) return null;
      return caseRow((await query('SELECT * FROM capital_cases WHERE workspace_id = $1 AND id = $2', [workspaceId, caseId])).rows[0]);
    },
    async createCapitalCase({ workspaceId, createdBy, title, projectId = null, enhanceRunId = null, draft }) {
      if (!isId(workspaceId) || (projectId != null && !isId(projectId)) || (enhanceRunId != null && !isId(enhanceRunId))) throw new StoreError('not_found');
      return transaction(async (client) => {
        // The composite foreign keys refuse a project or run of another workspace (not_found).
        const row = (await query(`INSERT INTO capital_cases (workspace_id, project_id, enhance_run_id, title, draft, created_by)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`, [workspaceId, projectId, enhanceRunId, title, JSON.stringify(draft), createdBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'capital_case.created', targetType: 'capital_case', targetId: row.id });
        return caseRow(row);
      });
    },
    // The caller names the revision it edited; a different revision means someone else saved first.
    async updateCapitalCase({ workspaceId, caseId, expectedRevision, title, projectId = null, enhanceRunId = null, draft }) {
      if ((projectId != null && !isId(projectId)) || (enhanceRunId != null && !isId(enhanceRunId))) throw new StoreError('not_found');
      return transaction(async (client) => {
        const current = await lockCase(client, workspaceId, caseId);
        if (current.status === 'submitted') throw new StoreError('invalid_state');
        if (current.revision !== expectedRevision) throw new StoreError('stale_revision');
        await checkCaseReferences(client, current, draft);
        const row = (await query(`UPDATE capital_cases SET title = $3, project_id = $4, enhance_run_id = $5, draft = $6::jsonb, revision = revision + 1, updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND id = $2 AND revision = $7 RETURNING *`, [workspaceId, caseId, title, projectId, enhanceRunId, JSON.stringify(draft), expectedRevision], client)).rows[0];
        return caseRow(row);
      });
    },
    // Consent binds the exact content: the revision edited and the hash of everything the snapshot will freeze
    // (draft, links, evidence, current credit records). Both are rechecked under the lock against the data being frozen.
    async submitCapitalCase({ workspaceId, caseId, submittedBy, expectedRevision, contentHash }) {
      return transaction(async (client) => {
        const c = await lockCase(client, workspaceId, caseId);
        if (c.status === 'submitted') {
          // A retry of the same revision and content gets the submission it already made; anything else waits for the review.
          const open = (await query('SELECT * FROM capital_submissions WHERE case_id = $1 AND decision IS NULL', [caseId], client)).rows[0];
          if (open && c.submitted_revision === expectedRevision) {
            if (open.content_hash !== contentHash) throw new StoreError('stale_revision', 'content');
            return submissionRow(open);
          }
          throw new StoreError('invalid_state');
        }
        if (c.revision !== expectedRevision) throw new StoreError('stale_revision');
        if (!draftComplete(c.draft)) throw new StoreError('invalid_state');
        if ((await query('SELECT 1 FROM capital_submissions WHERE case_id = $1 AND revision = $2', [caseId, c.revision], client)).rowCount) throw new StoreError('invalid_state');
        await checkCaseReferences(client, c, c.draft);
        // One transaction client runs one query at a time, so these are sequential awaits.
        const credits = (await query(`${CREDITS} WHERE c.workspace_id = $1 ORDER BY c.created_at, c.id`, [workspaceId], client)).rows.map(creditRow);
        const evidence = (await query('SELECT * FROM capital_evidence WHERE case_id = $1 ORDER BY created_at, id', [caseId], client)).rows.map(evidenceRow);
        const snapshot = capitalSnapshot(caseRow(c), credits, evidence);
        const hash = snapshotHash(snapshot);
        if (hash !== contentHash) throw new StoreError('stale_revision', 'content');
        const row = (await query(`INSERT INTO capital_submissions (case_id, workspace_id, revision, snapshot, content_hash, submitted_by)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`, [caseId, workspaceId, c.revision, JSON.stringify(snapshot), hash, submittedBy], client)).rows[0];
        await query("UPDATE capital_cases SET status = 'submitted', submitted_revision = $3, updated_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2", [workspaceId, caseId, c.revision], client);
        await addAudit(client, { workspaceId, actorId: submittedBy, action: 'capital.submitted', targetType: 'capital_case', targetId: caseId, metadata: { submissionId: row.id, revision: row.revision } });
        return submissionRow(row);
      });
    },
    async withdrawCapitalCase({ workspaceId, caseId, actorId }) {
      return transaction(async (client) => {
        const c = await lockCase(client, workspaceId, caseId);
        if (c.status !== 'submitted') throw new StoreError('invalid_state');
        const open = (await query(`UPDATE capital_submissions SET decision = 'withdrawn', decided_by = $2, decided_at = clock_timestamp()
          WHERE case_id = $1 AND decision IS NULL RETURNING id, revision`, [caseId, actorId], client)).rows[0];
        if (!open) throw new StoreError('invalid_state');
        // The withdrawn revision stays on record; the draft gets a new revision number so it can be sent again.
        const row = (await query("UPDATE capital_cases SET status = 'draft', revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [caseId], client)).rows[0];
        await addAudit(client, { workspaceId, actorId, action: 'capital.withdrawn', targetType: 'capital_case', targetId: caseId, metadata: { submissionId: open.id, revision: open.revision } });
        return caseRow(row);
      });
    },
    async listCapitalSubmissions({ workspaceId, caseId }) {
      if (!isId(workspaceId) || !isId(caseId)) return [];
      return (await query('SELECT * FROM capital_submissions WHERE workspace_id = $1 AND case_id = $2 ORDER BY revision', [workspaceId, caseId])).rows.map(submissionRow);
    },

    async listCreditRecords(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query(`${CREDITS} WHERE c.workspace_id = $1 ORDER BY c.created_at, c.id`, [workspaceId])).rows.map(creditRow);
    },
    // Append-only: a correction is a new row that supersedes one earlier row, which can be corrected only once.
    async createCreditRecord({ workspaceId, createdBy, record, supersedes = null }) {
      if (supersedes != null && !isId(supersedes)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await lockWorkspace(client, workspaceId);
        if (supersedes != null) {
          if (!(await query('SELECT 1 FROM credit_records WHERE id = $1 AND workspace_id = $2', [supersedes, workspaceId], client)).rowCount) throw new StoreError('not_found');
          if ((await query('SELECT 1 FROM credit_records WHERE supersedes = $1', [supersedes], client)).rowCount) throw new StoreError('invalid_state');
        }
        const row = (await query(`INSERT INTO credit_records (workspace_id, provider, status, amount_cents, expires_on, restrictions, reference, supersedes, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, expires_on::text AS expires_on_day`,
        [workspaceId, record.provider, record.status, record.amountCents, record.expiresOn, record.restrictions, record.reference, supersedes, createdBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: supersedes ? 'credit_record.corrected' : 'credit_record.created', targetType: 'credit_record', targetId: row.id, metadata: { supersedes } });
        return creditRow(row);
      });
    },

    async listCapitalEvidence({ workspaceId, caseId }) {
      if (!isId(workspaceId) || !isId(caseId)) return [];
      return (await query('SELECT * FROM capital_evidence WHERE workspace_id = $1 AND case_id = $2 ORDER BY created_at, id', [workspaceId, caseId])).rows.map(evidenceRow);
    },
    async addCapitalEvidence({ workspaceId, caseId, createdBy, item }) {
      return transaction(async (client) => {
        const c = await lockCase(client, workspaceId, caseId);
        if (c.status === 'submitted') throw new StoreError('invalid_state');
        const row = (await query(`INSERT INTO capital_evidence (case_id, workspace_id, kind, title, source, reference, verification, created_by)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`, [caseId, workspaceId, item.kind, item.title, item.source, JSON.stringify(item.reference), item.verification, createdBy], client)).rows[0];
        return evidenceRow(row);
      });
    },
    async deleteCapitalEvidence({ workspaceId, caseId, evidenceId }) {
      if (!isId(evidenceId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const c = await lockCase(client, workspaceId, caseId);
        if (c.status === 'submitted') throw new StoreError('invalid_state');
        // An incurred cost cites its record; the record stays until that item changes (checked on the locked row).
        if (citedEvidenceIds(c.draft).has(evidenceId)) throw new StoreError('evidence_in_use');
        const row = (await query('DELETE FROM capital_evidence WHERE case_id = $1 AND id = $2 RETURNING *', [caseId, evidenceId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        return evidenceRow(row);
      });
    },
    async listCapitalReviewMarks({ workspaceId, caseId }) {
      if (!isId(workspaceId) || !isId(caseId)) return [];
      return (await query(`SELECT m.* FROM capital_review_marks m JOIN capital_submissions s ON s.id = m.submission_id
        WHERE s.workspace_id = $1 AND s.case_id = $2 ORDER BY m.created_at, m.id`, [workspaceId, caseId])).rows.map(markRow);
    },

    // Staff queue across workspaces: only what was sent for review, as frozen in each submission. Live titles,
    // drafts, evidence and credit records changed since are never returned here.
    async listCapitalCasesForReview({ status = 'submitted' } = {}) {
      return (await query(`SELECT c.id, c.workspace_id, c.status, c.revision, c.submitted_revision, c.created_at, c.updated_at, w.name AS workspace_name, to_jsonb(s) AS latest
        FROM capital_cases c JOIN workspaces w ON w.id = c.workspace_id
        LEFT JOIN LATERAL (SELECT * FROM capital_submissions WHERE case_id = c.id ORDER BY revision DESC LIMIT 1) s ON true
        WHERE c.status = $1 ORDER BY c.updated_at, c.id`, [status])).rows.map((r) => ({ ...caseMetaRow(r), workspaceName: r.workspace_name, latestSubmission: submissionRow(r.latest) }));
    },
    async getCapitalCaseForReview(caseId) {
      if (!isId(caseId)) return null;
      const c = (await query('SELECT * FROM capital_cases WHERE id = $1', [caseId])).rows[0];
      if (!c) return null;
      const w = (await query('SELECT id, name, kind, profile FROM workspaces WHERE id = $1', [c.workspace_id])).rows[0];
      const latest = (await query('SELECT * FROM capital_submissions WHERE case_id = $1 ORDER BY revision DESC LIMIT 1', [caseId])).rows[0];
      const marks = latest ? (await query('SELECT * FROM capital_review_marks WHERE submission_id = $1 ORDER BY created_at, id', [latest.id])).rows.map(markRow) : [];
      return { case: caseMetaRow(c), workspace: { id: w.id, name: w.name, kind: w.kind, synthetic: Boolean(w.profile?.synthetic) }, submission: submissionRow(latest), marks };
    },
    // A decision names the submission the reviewer saw. If the customer withdrew or sent a newer revision since,
    // that is a different submission and the decision is refused (stale_revision), never applied to the newer one.
    async decideCapitalSubmission({ caseId, submissionId, reviewerId, decision, notes = null }) {
      if (!isId(caseId)) throw new StoreError('not_found');
      if (!CASE_DECISIONS.includes(decision)) throw new StoreError('invalid_state');
      return transaction(async (client) => {
        const c = (await query('SELECT * FROM capital_cases WHERE id = $1 FOR UPDATE', [caseId], client)).rows[0];
        if (!c) throw new StoreError('not_found');
        if (c.status !== 'submitted') throw new StoreError('invalid_state');
        const open = (await query('SELECT id FROM capital_submissions WHERE case_id = $1 AND decision IS NULL', [caseId], client)).rows[0];
        if (!open) throw new StoreError('invalid_state');
        if (!isId(submissionId) || open.id !== submissionId) throw new StoreError('stale_revision', 'submission');
        // The freeze trigger lets a decision be written exactly once; the partial unique index keeps one open submission.
        const row = (await query(`UPDATE capital_submissions SET decision = $2, decided_by = $3, decided_at = clock_timestamp(), notes = $4
          WHERE id = $1 AND decision IS NULL RETURNING *`, [open.id, decision, reviewerId, notes], client)).rows[0];
        if (!row) throw new StoreError('invalid_state');
        await query('UPDATE capital_cases SET status = $2, updated_at = clock_timestamp() WHERE id = $1', [caseId, decision], client);
        await addAudit(client, { workspaceId: c.workspace_id, actorId: reviewerId, action: `capital.${decision}`, targetType: 'capital_case', targetId: caseId, metadata: { submissionId: row.id, revision: row.revision } });
        return submissionRow(row);
      });
    },
    // An append-only mark on one evidence id frozen in the submission the reviewer saw. The customer's record is not touched.
    async markCapitalEvidenceReviewed({ caseId, submissionId, evidenceId, reviewerId }) {
      if (!isId(caseId) || !isId(evidenceId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const c = (await query('SELECT * FROM capital_cases WHERE id = $1 FOR UPDATE', [caseId], client)).rows[0];
        if (!c) throw new StoreError('not_found');
        if (c.status !== 'submitted') throw new StoreError('invalid_state');
        const open = (await query('SELECT id, snapshot FROM capital_submissions WHERE case_id = $1 AND decision IS NULL', [caseId], client)).rows[0];
        if (!open) throw new StoreError('invalid_state');
        if (!isId(submissionId) || open.id !== submissionId) throw new StoreError('stale_revision', 'submission');
        if (!(open.snapshot.evidence ?? []).some((e) => e.id === evidenceId)) throw new StoreError('not_found');
        const inserted = (await query(`INSERT INTO capital_review_marks (submission_id, evidence_id, reviewer_id) VALUES ($1, $2, $3)
          ON CONFLICT (submission_id, evidence_id) DO NOTHING RETURNING *`, [open.id, evidenceId, reviewerId], client)).rows[0];
        if (!inserted) return markRow((await query('SELECT * FROM capital_review_marks WHERE submission_id = $1 AND evidence_id = $2', [open.id, evidenceId], client)).rows[0]);
        await addAudit(client, { workspaceId: c.workspace_id, actorId: reviewerId, action: 'capital.evidence_item_reviewed', targetType: 'capital_submission', targetId: open.id, metadata: { caseId, evidenceId } });
        return markRow(inserted);
      });
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
