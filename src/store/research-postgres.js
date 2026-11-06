import { StoreError } from './errors.js';
import { planImport, qualityReport } from '../lib/research.js';

const iso = (value) => value == null ? null : new Date(value).toISOString();
const projectRow = (r) => r ? { id: r.id, workspaceId: r.workspace_id, createdBy: r.created_by, template: r.template, name: r.name, brief: r.brief, question: r.question, checklist: r.checklist, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null;
const sourceRow = (r) => r ? { id: r.id, workspaceId: r.workspace_id, url: r.url, publisher: r.publisher, title: r.title, publishedAt: iso(r.published_at), retrievedAt: iso(r.retrieved_at), status: r.status, failure: r.failure, contentSha256: r.content_sha256, excerpt: r.excerpt, httpStatus: r.http_status, createdAt: iso(r.created_at) } : null;
const entityRow = (r) => r ? { id: r.id, workspaceId: r.workspace_id, kind: r.kind, name: r.name, externalKey: r.external_key, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null;
const claimRow = (r) => r ? { id: r.id, workspaceId: r.workspace_id, entityId: r.entity_id, field: r.field, value: r.value_text, status: r.status, sourceId: r.source_id, excerpt: r.excerpt, extractionMethod: r.extraction_method, observedAt: iso(r.observed_at), retrievedAt: iso(r.retrieved_at), contentFingerprint: r.content_fingerprint, createdAt: iso(r.created_at) } : null;
const runRow = (r) => r ? { id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, createdBy: r.created_by, question: r.question, scope: r.scope, limits: r.limits, permissions: r.permissions, status: r.status, output: r.output, error: r.error, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), finishedAt: iso(r.finished_at) } : null;

/**
 * Research methods for Postgres. Reads and writes take workspace_id. The import runs in one transaction
 * under a workspace row lock, using the same planner as the memory store.
 */
export function researchPostgresMethods({ query, transaction, isId, addAudit }) {
  const requireWorkspace = async (client, workspaceId) => {
    if (!isId(workspaceId)) throw new StoreError('not_found');
    const found = await query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId], client);
    if (!found.rowCount) throw new StoreError('not_found');
  };
  return {
    async listResearchProjects(workspaceId) {
      if (!isId(workspaceId)) return [];
      return (await query('SELECT * FROM research_projects WHERE workspace_id = $1 ORDER BY updated_at DESC', [workspaceId])).rows.map(projectRow);
    },
    async createResearchProject({ workspaceId, createdBy, template, name, brief, question, checklist }) {
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const row = projectRow((await query(`INSERT INTO research_projects (workspace_id, created_by, template, name, brief, question, checklist)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`, [workspaceId, createdBy, template, name, brief, question, JSON.stringify(checklist)], client)).rows[0]);
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'research.project_created', targetType: 'research_project', targetId: row.id, metadata: { template } });
        return row;
      });
    },
    async getResearchProject({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const project = projectRow((await query('SELECT * FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId])).rows[0]);
      if (!project) return null;
      const lists = (await query(`SELECT l.*, (SELECT count(*)::int FROM research_list_items i WHERE i.list_id = l.id) AS count
        FROM research_lists l WHERE l.project_id = $1 AND l.workspace_id = $2 ORDER BY l.created_at`, [projectId, workspaceId])).rows
        .map((r) => ({ id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, purpose: r.purpose, createdBy: r.created_by, createdAt: iso(r.created_at), count: r.count }));
      const runs = (await query('SELECT * FROM research_runs WHERE project_id = $1 AND workspace_id = $2 ORDER BY created_at DESC', [projectId, workspaceId])).rows.map(runRow);
      return { project, lists, runs };
    },
    async updateResearchProject({ workspaceId, projectId, patch }) {
      if (!isId(projectId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const row = projectRow((await query(`UPDATE research_projects SET name = $3, brief = $4, question = $5, checklist = $6::jsonb, updated_at = clock_timestamp()
          WHERE id = $1 AND workspace_id = $2 RETURNING *`, [projectId, workspaceId, patch.name, patch.brief, patch.question, JSON.stringify(patch.checklist)], client)).rows[0]);
        if (!row) throw new StoreError('not_found');
        return row;
      });
    },
    async importResearchRecords({ workspaceId, projectId, actorId, records, dryRun = false }) {
      if (!isId(projectId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const project = (await query('SELECT id FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId], client)).rows[0];
        if (!project) throw new StoreError('not_found');
        const sourceRows = (await query('SELECT * FROM research_sources WHERE workspace_id = $1', [workspaceId], client)).rows.map(sourceRow);
        const entityRows = (await query('SELECT * FROM research_entities WHERE workspace_id = $1', [workspaceId], client)).rows.map(entityRow);
        const claimRows = (await query(`SELECT c.*, e.external_key, s.url AS source_url FROM research_claims c
          JOIN research_entities e ON e.id = c.entity_id LEFT JOIN research_sources s ON s.id = c.source_id
          WHERE c.workspace_id = $1`, [workspaceId], client)).rows.map((r) => ({ ...claimRow(r), entityKey: r.external_key, sourceUrl: r.source_url }));
        const plan = planImport({ sources: sourceRows, entities: entityRows, claims: claimRows }, records);
        if (dryRun) return plan.summary;
        const sourceByUrl = new Map(sourceRows.map((row) => [row.url, row]));
        for (const source of plan.ops.sources) {
          const inserted = sourceRow((await query(`INSERT INTO research_sources (workspace_id, url, publisher, title, retrieved_at, status, failure, content_sha256, excerpt)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, url) DO UPDATE SET url = EXCLUDED.url RETURNING *`,
          [workspaceId, source.url, source.publisher, source.title, source.retrievedAt, source.status, source.failure, source.sha256, source.excerpt], client)).rows[0]);
          sourceByUrl.set(inserted.url, inserted);
        }
        for (const update of plan.ops.sourceUpdates) {
          const updated = sourceRow((await query(`UPDATE research_sources SET status = 'retrieved', excerpt = $3, content_sha256 = $4, retrieved_at = $5, failure = NULL, publisher = $6, title = $7
            WHERE workspace_id = $1 AND url = $2 AND status <> 'retrieved' RETURNING *`,
          [workspaceId, update.url, update.excerpt, update.sha256, update.retrievedAt, update.publisher, update.title], client)).rows[0]);
          if (updated) sourceByUrl.set(updated.url, updated);
        }
        const entityByKey = new Map(entityRows.map((row) => [row.externalKey, row]));
        for (const entity of plan.ops.entities) {
          const inserted = entityRow((await query(`INSERT INTO research_entities (workspace_id, kind, name, external_key)
            VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, external_key) DO UPDATE SET name = research_entities.name RETURNING *`,
          [workspaceId, entity.kind, entity.name, entity.externalKey], client)).rows[0]);
          entityByKey.set(inserted.externalKey, inserted);
        }
        for (const claim of plan.ops.claims) {
          const entity = entityByKey.get(claim.entityKey);
          const source = sourceByUrl.get(claim.sourceUrl);
          await query(`INSERT INTO research_claims (workspace_id, entity_id, field, value_text, status, source_id, excerpt, extraction_method, observed_at, retrieved_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())
            ON CONFLICT (entity_id, field, value_text, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
          [workspaceId, entity.id, claim.field, claim.value, claim.status, source?.id ?? null, claim.excerpt, claim.method, claim.observedAt], client);
        }
        if (plan.ops.conflictClaimIds.length) {
          await query(`UPDATE research_claims SET status = 'conflicting' WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, plan.ops.conflictClaimIds], client);
        }
        for (const membership of plan.ops.memberships) {
          const entity = entityByKey.get(membership.entityKey);
          if (!entity) continue;
          await query(`INSERT INTO research_memberships (project_id, entity_id, directory) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [projectId, entity.id, membership.directory], client);
        }
        for (const pair of plan.ops.duplicates) {
          const left = entityByKey.get(pair.leftKey);
          const right = entityByKey.get(pair.rightKey);
          if (!left || !right) continue;
          const [leftId, rightId] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
          await query(`INSERT INTO research_duplicate_candidates (workspace_id, left_entity_id, right_entity_id, reason)
            VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [workspaceId, leftId, rightId, pair.reason], client);
        }
        if (plan.summary.importedEntities || plan.summary.importedClaims) {
          await addAudit(client, { workspaceId, actorId: actorId, action: 'research.imported', targetType: 'research_project', targetId: projectId, metadata: { importedEntities: plan.summary.importedEntities, importedClaims: plan.summary.importedClaims } });
        }
        return plan.summary;
      });
    },
    async listResearchDirectory({ workspaceId, projectId, directory, q = '', sort = 'name', page = 1, pageSize = 20 }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const project = (await query('SELECT id FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId])).rows[0];
      if (!project) return null;
      const order = sort === 'updated' ? 'e.updated_at DESC' : 'e.name ASC';
      const offset = (page - 1) * pageSize;
      const needle = q.trim().toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      const total = Number((await query(`SELECT count(*)::int AS n FROM research_memberships m JOIN research_entities e ON e.id = m.entity_id
        WHERE m.project_id = $1 AND m.directory = $2 AND e.workspace_id = $3 AND ($4 = '' OR lower(e.name) LIKE '%' || $4 || '%' ESCAPE '\\')`,
      [projectId, directory, workspaceId, needle])).rows[0].n);
      const rows = (await query(`SELECT e.*, (SELECT count(*)::int FROM research_claims c WHERE c.entity_id = e.id) AS claim_count,
          (SELECT count(*)::int FROM research_claims c WHERE c.entity_id = e.id AND c.status = 'conflicting') AS conflicting
        FROM research_memberships m JOIN research_entities e ON e.id = m.entity_id
        WHERE m.project_id = $1 AND m.directory = $2 AND e.workspace_id = $3 AND ($4 = '' OR lower(e.name) LIKE '%' || $4 || '%' ESCAPE '\\')
        ORDER BY ${order} LIMIT $5 OFFSET $6`, [projectId, directory, workspaceId, needle, pageSize, offset])).rows
        .map((r) => ({ entity: entityRow(r), claimCount: r.claim_count, conflicting: r.conflicting }));
      return { total, page, pageSize, rows };
    },
    async getResearchEntity({ workspaceId, entityId }) {
      if (!isId(workspaceId) || !isId(entityId)) return null;
      const entity = entityRow((await query('SELECT * FROM research_entities WHERE id = $1 AND workspace_id = $2', [entityId, workspaceId])).rows[0]);
      if (!entity) return null;
      const claimRows = (await query(`SELECT c.*, s.url AS source_url, s.status AS source_status, s.publisher, s.title AS source_title, s.excerpt AS source_excerpt, s.retrieved_at AS source_retrieved_at
        FROM research_claims c LEFT JOIN research_sources s ON s.id = c.source_id WHERE c.entity_id = $1 AND c.workspace_id = $2 ORDER BY c.created_at`, [entityId, workspaceId])).rows;
      return {
        entity,
        claims: claimRows.map((r) => ({ ...claimRow(r), source: r.source_id ? { id: r.source_id, url: r.source_url, status: r.source_status, publisher: r.publisher, title: r.source_title, excerpt: r.source_excerpt, retrievedAt: iso(r.source_retrieved_at) } : null })),
        relationships: (await query('SELECT * FROM research_relationships WHERE workspace_id = $1 AND (from_entity_id = $2 OR to_entity_id = $2)', [workspaceId, entityId])).rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, fromEntityId: r.from_entity_id, toEntityId: r.to_entity_id, kind: r.kind, startedOn: r.started_on, endedOn: r.ended_on, claimId: r.claim_id, note: r.note, createdAt: iso(r.created_at) })),
        directories: (await query('SELECT * FROM research_memberships WHERE entity_id = $1', [entityId])).rows.map((r) => ({ projectId: r.project_id, entityId: r.entity_id, directory: r.directory, createdAt: iso(r.created_at) })),
        duplicates: (await query('SELECT * FROM research_duplicate_candidates WHERE workspace_id = $1 AND (left_entity_id = $2 OR right_entity_id = $2)', [workspaceId, entityId])).rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, leftEntityId: r.left_entity_id, rightEntityId: r.right_entity_id, reason: r.reason, status: r.status, createdAt: iso(r.created_at) })),
        revisions: (await query('SELECT * FROM research_revisions WHERE entity_id = $1 AND workspace_id = $2 ORDER BY created_at', [entityId, workspaceId])).rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, entityId: r.entity_id, actorId: r.actor_id, patch: r.patch, createdAt: iso(r.created_at) })),
        lists: (await query(`SELECT l.* FROM research_lists l JOIN research_list_items i ON i.list_id = l.id WHERE i.entity_id = $1 AND l.workspace_id = $2`, [entityId, workspaceId])).rows.map((r) => ({ id: r.id, name: r.name, purpose: r.purpose, projectId: r.project_id })),
      };
    },
    async correctResearchClaim({ workspaceId, entityId, actorId, field, value, excerpt }) {
      if (!isId(entityId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const entity = (await query('SELECT id FROM research_entities WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [entityId, workspaceId], client)).rows[0];
        if (!entity) throw new StoreError('not_found');
        const prior = (await query(`SELECT id FROM research_claims WHERE entity_id = $1 AND field = $2 AND value_text <> $3 AND status <> 'unknown'`, [entityId, field, value], client)).rows;
        const status = prior.length ? 'conflicting' : 'reviewed';
        if (prior.length) await query(`UPDATE research_claims SET status = 'conflicting' WHERE id = ANY($1::uuid[])`, [prior.map((row) => row.id)], client);
        const claim = claimRow((await query(`INSERT INTO research_claims (workspace_id, entity_id, field, value_text, status, excerpt, extraction_method, retrieved_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'human', clock_timestamp()) RETURNING *`, [workspaceId, entityId, field, value, status, excerpt], client)).rows[0]);
        await query(`INSERT INTO research_revisions (workspace_id, entity_id, actor_id, patch) VALUES ($1, $2, $3, $4::jsonb)`, [workspaceId, entityId, actorId, JSON.stringify({ field, value, status })], client);
        await query('UPDATE research_entities SET updated_at = clock_timestamp() WHERE id = $1', [entityId], client);
        await addAudit(client, { workspaceId, actorId, action: 'research.corrected', targetType: 'research_entity', targetId: entityId, metadata: { field } });
        return claim;
      });
    },
    async addResearchList({ workspaceId, projectId, createdBy, name, purpose }) {
      if (!isId(projectId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const project = (await query('SELECT id FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId], client)).rows[0];
        if (!project) throw new StoreError('not_found');
        const row = (await query(`INSERT INTO research_lists (workspace_id, project_id, name, purpose, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [workspaceId, projectId, name, purpose, createdBy], client)).rows[0];
        return { id: row.id, workspaceId, projectId, name: row.name, purpose: row.purpose, createdBy, createdAt: iso(row.created_at) };
      });
    },
    async addResearchListItem({ workspaceId, listId, entityId, note = '' }) {
      if (!isId(listId) || !isId(entityId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const list = (await query('SELECT * FROM research_lists WHERE id = $1 AND workspace_id = $2', [listId, workspaceId], client)).rows[0];
        const entity = (await query('SELECT id FROM research_entities WHERE id = $1 AND workspace_id = $2', [entityId, workspaceId], client)).rows[0];
        if (!list || !entity) throw new StoreError('not_found');
        const member = (await query('SELECT 1 FROM research_memberships WHERE project_id = $1 AND entity_id = $2', [list.project_id, entityId], client)).rowCount;
        if (!member) throw new StoreError('invalid_state', 'Add the record to this project before putting it on a list.');
        await query(`INSERT INTO research_list_items (list_id, entity_id, note) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [listId, entityId, note], client);
        return { listId, entityId };
      });
    },
    async removeResearchListItem({ workspaceId, listId, entityId }) {
      if (!isId(listId) || !isId(entityId)) throw new StoreError('not_found');
      const list = (await query('SELECT id FROM research_lists WHERE id = $1 AND workspace_id = $2', [listId, workspaceId])).rows[0];
      if (!list) throw new StoreError('not_found');
      const removed = await query('DELETE FROM research_list_items WHERE list_id = $1 AND entity_id = $2', [listId, entityId]);
      if (!removed.rowCount) throw new StoreError('not_found');
    },
    async researchQuality({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const project = projectRow((await query('SELECT * FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId])).rows[0]);
      if (!project) return null;
      const entities = (await query(`SELECT e.* FROM research_entities e JOIN research_memberships m ON m.entity_id = e.id WHERE m.project_id = $1 AND e.workspace_id = $2`, [projectId, workspaceId])).rows.map(entityRow);
      const ids = entities.map((row) => row.id);
      const claims = ids.length ? (await query('SELECT * FROM research_claims WHERE workspace_id = $1 AND entity_id = ANY($2::uuid[])', [workspaceId, ids])).rows.map(claimRow) : [];
      const sources = (await query('SELECT * FROM research_sources WHERE workspace_id = $1', [workspaceId])).rows.map(sourceRow);
      const duplicates = ids.length ? (await query('SELECT * FROM research_duplicate_candidates WHERE workspace_id = $1 AND (left_entity_id = ANY($2::uuid[]) OR right_entity_id = ANY($2::uuid[]))', [workspaceId, ids])).rows.map((r) => ({ status: r.status })) : [];
      const runs = (await query('SELECT * FROM research_runs WHERE project_id = $1 AND workspace_id = $2', [projectId, workspaceId])).rows.map(runRow);
      return { checklist: project.checklist, report: qualityReport({ entities, claims, sources, duplicates, runs }) };
    },
    async createResearchRun({ workspaceId, projectId, createdBy, question, scope, limits, permissions }) {
      if (!isId(projectId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        await requireWorkspace(client, workspaceId);
        const project = (await query('SELECT id FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId], client)).rows[0];
        if (!project) throw new StoreError('not_found');
        const run = runRow((await query(`INSERT INTO research_runs (workspace_id, project_id, created_by, question, scope, limits, permissions, status)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'proposed') RETURNING *`,
        [workspaceId, projectId, createdBy, question, JSON.stringify(scope), JSON.stringify(limits), JSON.stringify(permissions)], client)).rows[0]);
        await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, 'progress', 'Proposed. No source has been fetched.')`, [run.id], client);
        return run;
      });
    },
    async getResearchRun({ workspaceId, runId }) {
      if (!isId(workspaceId) || !isId(runId)) return null;
      const run = runRow((await query('SELECT * FROM research_runs WHERE id = $1 AND workspace_id = $2', [runId, workspaceId])).rows[0]);
      if (!run) return null;
      const events = (await query('SELECT * FROM research_run_events WHERE run_id = $1 ORDER BY id', [runId])).rows.map((r) => ({ id: Number(r.id), runId: r.run_id, kind: r.kind, message: r.message, createdAt: iso(r.created_at) }));
      return { run, events };
    },
    async recoverResearchRuns({ workspaceId, olderThan }) {
      if (!isId(workspaceId)) return 0;
      const result = await query(`UPDATE research_runs SET status = 'failed', output = NULL, error = 'The run was interrupted before a report was stored.',
        finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND status = 'running' AND updated_at < $2 RETURNING id`, [workspaceId, olderThan]);
      for (const row of result.rows) {
        await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, 'failure', 'The run was interrupted before a report was stored.')`, [row.id]);
      }
      return result.rowCount;
    },
    async markResearchRunRunning({ workspaceId, runId }) {
      if (!isId(runId)) throw new StoreError('not_found');
      const row = runRow((await query(`UPDATE research_runs SET status = 'running', updated_at = clock_timestamp()
        WHERE id = $1 AND workspace_id = $2 AND status = 'proposed' RETURNING *`, [runId, workspaceId])).rows[0]);
      if (!row) {
        const exists = isId(workspaceId) && (await query('SELECT status FROM research_runs WHERE id = $1 AND workspace_id = $2', [runId, workspaceId])).rows[0];
        if (!exists) throw new StoreError('not_found');
        throw new StoreError('invalid_state', 'Only a proposed run can start.');
      }
      await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, 'progress', 'Started.')`, [runId]);
      return row;
    },
    async appendResearchRunEvent({ workspaceId, runId, kind, message }) {
      if (!isId(runId) || !isId(workspaceId)) throw new StoreError('not_found');
      const run = (await query('SELECT id FROM research_runs WHERE id = $1 AND workspace_id = $2', [runId, workspaceId])).rows[0];
      if (!run) throw new StoreError('not_found');
      const event = (await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, $2, $3) RETURNING *`, [runId, kind, message.slice(0, 500)])).rows[0];
      return { id: Number(event.id), runId, kind, message: event.message, createdAt: iso(event.created_at) };
    },
    async finishResearchRun({ workspaceId, runId, status, output, error }) {
      if (!isId(runId)) throw new StoreError('not_found');
      if (status === 'completed' && (output == null || !Array.isArray(output.citations))) throw new StoreError('invalid_state', 'A completed run needs a stored report.');
      if (status === 'failed' && output != null) throw new StoreError('invalid_state', 'A failed run cannot store a successful report.');
      return transaction(async (client) => {
        const current = (await query('SELECT status FROM research_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (current.status === 'cancelled') return runRow((await query('SELECT * FROM research_runs WHERE id = $1', [runId], client)).rows[0]);
        if (current.status !== 'running' && current.status !== 'proposed') throw new StoreError('invalid_state', 'This run has already finished.');
        const row = runRow((await query(`UPDATE research_runs SET status = $3, output = $4::jsonb, error = $5, finished_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1 AND workspace_id = $2 RETURNING *`, [runId, workspaceId, status, status === 'completed' ? JSON.stringify(output) : null, error ? String(error).slice(0, 500) : null], client)).rows[0]);
        await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, $2, $3)`, [runId, status === 'completed' ? 'output' : 'failure', row.error || 'Report stored.'], client);
        return row;
      });
    },
    async cancelResearchRun({ workspaceId, runId }) {
      if (!isId(runId)) throw new StoreError('not_found');
      return transaction(async (client) => {
        const current = (await query('SELECT status FROM research_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [runId, workspaceId], client)).rows[0];
        if (!current) throw new StoreError('not_found');
        if (['completed', 'failed', 'cancelled'].includes(current.status)) throw new StoreError('invalid_state', 'This run has already finished.');
        const row = runRow((await query(`UPDATE research_runs SET status = 'cancelled', output = NULL, error = 'Cancelled before a report was stored.', finished_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1 RETURNING *`, [runId], client)).rows[0]);
        await query(`INSERT INTO research_run_events (run_id, kind, message) VALUES ($1, 'failure', 'Cancelled before a report was stored.')`, [runId], client);
        return row;
      });
    },
    async listResearchExport({ workspaceId, projectId, directory, listId }) {
      if (!isId(workspaceId) || !isId(projectId)) return null;
      const project = (await query('SELECT id FROM research_projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId])).rows[0];
      if (!project) return null;
      const params = [projectId, workspaceId];
      let filter = 'm.project_id = $1 AND e.workspace_id = $2';
      if (listId) {
        if (!isId(listId)) return null;
        const list = (await query('SELECT id FROM research_lists WHERE id = $1 AND workspace_id = $2 AND project_id = $3', [listId, workspaceId, projectId])).rows[0];
        if (!list) return null;
        params.push(listId);
        filter = `e.id IN (SELECT entity_id FROM research_list_items WHERE list_id = $${params.length}) AND e.workspace_id = $2`;
      } else if (directory) {
        params.push(directory);
        filter += ` AND m.directory = $${params.length}`;
      }
      const result = await query(`SELECT m.directory, e.kind, e.name, c.field, c.value_text, c.status AS claim_status, COALESCE(s.url, '') AS source_url,
          COALESCE(s.status, '') AS source_status, COALESCE(c.retrieved_at::text, '') AS retrieved_at, c.excerpt
        FROM research_entities e
        JOIN research_memberships m ON m.entity_id = e.id AND m.project_id = $1
        JOIN research_claims c ON c.entity_id = e.id
        LEFT JOIN research_sources s ON s.id = c.source_id
        WHERE ${filter} ORDER BY e.name, c.field`, params);
      return result.rows.map((r) => ({ directory: r.directory, kind: r.kind, name: r.name, field: r.field, value: r.value_text, claim_status: r.claim_status, source_url: r.source_url, source_status: r.source_status, retrieved_at: r.retrieved_at, excerpt: r.excerpt }));
    },
  };
}
