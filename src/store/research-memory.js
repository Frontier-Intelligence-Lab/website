import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.js';
import { planImport, qualityReport } from '../lib/research.js';

/**
 * Research methods for the in-memory store. One lock per workspace matches the Postgres workspace row lock.
 * Returned values are copies. A missing workspace or a foreign id is not_found, never another workspace's row.
 */
export function researchMemoryMethods({ stamp, copy, workspaces, audit }) {
  const projects = [];
  const sources = [];
  const entities = [];
  const claims = [];
  const relationships = [];
  const memberships = [];
  const lists = [];
  const listItems = [];
  const runs = [];
  const events = [];
  const revisions = [];
  const duplicates = [];
  const tails = new Map();

  const locked = async (workspaceId, fn) => {
    if (!workspaces.has(workspaceId)) throw new StoreError('not_found');
    const prev = tails.get(workspaceId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tails.set(workspaceId, gate);
    await prev.catch(() => {});
    try { return await fn(); }
    finally { release(); }
  };
  const auditPush = (workspaceId, actorId, action, targetType, targetId, metadata = {}) => {
    audit.push({ id: audit.length + 1, workspaceId, actorId, action, targetType, targetId, metadata: copy(metadata), createdAt: stamp() });
  };
  const projectOf = (workspaceId, projectId) => projects.find((row) => row.id === projectId && row.workspaceId === workspaceId) ?? null;
  const entityOf = (workspaceId, entityId) => entities.find((row) => row.id === entityId && row.workspaceId === workspaceId) ?? null;
  const graph = (workspaceId) => ({
    sources: sources.filter((row) => row.workspaceId === workspaceId),
    entities: entities.filter((row) => row.workspaceId === workspaceId),
    claims: claims.filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row, entityKey: entities.find((entity) => entity.id === row.entityId)?.externalKey, sourceUrl: sources.find((source) => source.id === row.sourceId)?.url ?? null })),
    duplicates: duplicates.filter((row) => row.workspaceId === workspaceId),
  });

  return {
    async listResearchProjects(workspaceId) {
      if (!workspaces.has(workspaceId)) return [];
      return projects.filter((row) => row.workspaceId === workspaceId).map(copy);
    },
    async createResearchProject({ workspaceId, createdBy, template, name, brief, question, checklist }) {
      return locked(workspaceId, async () => {
        const at = stamp();
        const row = { id: randomUUID(), workspaceId, createdBy, template, name, brief, question, checklist: copy(checklist), createdAt: at, updatedAt: at };
        projects.push(row);
        auditPush(workspaceId, createdBy, 'research.project_created', 'research_project', row.id, { template });
        return copy(row);
      });
    },
    async getResearchProject({ workspaceId, projectId }) {
      const row = projectOf(workspaceId, projectId);
      if (!row) return null;
      const projectLists = lists.filter((list) => list.projectId === row.id).map((list) => ({ ...copy(list), count: listItems.filter((item) => item.listId === list.id).length }));
      return { project: copy(row), lists: projectLists, runs: runs.filter((run) => run.projectId === row.id).map(copy) };
    },
    async updateResearchProject({ workspaceId, projectId, patch }) {
      return locked(workspaceId, async () => {
        const row = projectOf(workspaceId, projectId);
        if (!row) throw new StoreError('not_found');
        Object.assign(row, patch, { updatedAt: stamp() });
        return copy(row);
      });
    },
    async importResearchRecords({ workspaceId, projectId, actorId, records, dryRun = false }) {
      return locked(workspaceId, async () => {
        if (!projectOf(workspaceId, projectId)) throw new StoreError('not_found');
        const plan = planImport(graph(workspaceId), records);
        if (!dryRun) {
          const at = stamp();
          const sourceByUrl = new Map(sources.filter((row) => row.workspaceId === workspaceId).map((row) => [row.url, row]));
          for (const source of plan.ops.sources) {
            const row = { id: randomUUID(), workspaceId, url: source.url, publisher: source.publisher, title: source.title, publishedAt: null, retrievedAt: source.retrievedAt, status: source.status, failure: source.failure, contentSha256: source.sha256, excerpt: source.excerpt, httpStatus: null, createdAt: at };
            sources.push(row);
            sourceByUrl.set(row.url, row);
            source.id = row.id;
          }
          for (const update of plan.ops.sourceUpdates) {
            const row = sourceByUrl.get(update.url);
            if (row && row.status !== 'retrieved') Object.assign(row, { status: 'retrieved', excerpt: update.excerpt, contentSha256: update.sha256, retrievedAt: update.retrievedAt, failure: null, publisher: update.publisher, title: update.title });
          }
          const entityByKey = new Map(entities.filter((row) => row.workspaceId === workspaceId).map((row) => [row.externalKey, row]));
          for (const entity of plan.ops.entities) {
            const row = { id: randomUUID(), workspaceId, kind: entity.kind, name: entity.name, externalKey: entity.externalKey, createdAt: at, updatedAt: at };
            entities.push(row);
            entityByKey.set(row.externalKey, row);
            entity.id = row.id;
          }
          for (const claim of plan.ops.claims) {
            const entity = entityByKey.get(claim.entityKey);
            const source = sourceByUrl.get(claim.sourceUrl);
            claims.push({ id: randomUUID(), workspaceId, entityId: entity.id, field: claim.field, value: claim.value, status: claim.status, sourceId: source?.id ?? null, excerpt: claim.excerpt, extractionMethod: claim.method, observedAt: claim.observedAt, retrievedAt: at, contentFingerprint: null, createdAt: at });
          }
          for (const id of plan.ops.conflictClaimIds) {
            const claim = claims.find((row) => row.id === id && row.workspaceId === workspaceId);
            if (claim) claim.status = 'conflicting';
          }
          for (const membership of plan.ops.memberships) {
            const entity = entityByKey.get(membership.entityKey);
            if (entity && !memberships.some((row) => row.projectId === projectId && row.entityId === entity.id && row.directory === membership.directory)) {
              memberships.push({ projectId, entityId: entity.id, directory: membership.directory, createdAt: at });
            }
          }
          for (const pair of plan.ops.duplicates) {
            const left = entityByKey.get(pair.leftKey);
            const right = entityByKey.get(pair.rightKey);
            if (!left?.id || !right?.id) continue;
            const [leftId, rightId] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
            if (!duplicates.some((row) => row.workspaceId === workspaceId && row.leftEntityId === leftId && row.rightEntityId === rightId)) {
              duplicates.push({ id: randomUUID(), workspaceId, leftEntityId: leftId, rightEntityId: rightId, reason: pair.reason, status: 'open', createdAt: at });
            }
          }
          if (plan.summary.importedEntities || plan.summary.importedClaims) auditPush(workspaceId, actorId, 'research.imported', 'research_project', projectId, { importedEntities: plan.summary.importedEntities, importedClaims: plan.summary.importedClaims, dryRun: false });
        }
        return copy(plan.summary);
      });
    },
    async listResearchDirectory({ workspaceId, projectId, directory, q = '', sort = 'name', page = 1, pageSize = 20 }) {
      if (!projectOf(workspaceId, projectId)) return null;
      const needle = q.trim().toLowerCase();
      let rows = memberships.filter((row) => row.projectId === projectId && row.directory === directory)
        .map((row) => entityOf(workspaceId, row.entityId))
        .filter(Boolean);
      if (needle) rows = rows.filter((row) => row.name.toLowerCase().includes(needle));
      rows.sort((a, b) => sort === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : a.name.localeCompare(b.name));
      const total = rows.length;
      const start = (page - 1) * pageSize;
      const pageRows = rows.slice(start, start + pageSize).map((entity) => {
        const entityClaims = claims.filter((claim) => claim.entityId === entity.id);
        return { entity: copy(entity), claimCount: entityClaims.length, conflicting: entityClaims.filter((claim) => claim.status === 'conflicting').length };
      });
      return { total, page, pageSize, rows: pageRows };
    },
    async getResearchEntity({ workspaceId, entityId }) {
      const entity = entityOf(workspaceId, entityId);
      if (!entity) return null;
      const entityClaims = claims.filter((claim) => claim.entityId === entity.id).map((claim) => ({ ...copy(claim), source: copy(sources.find((source) => source.id === claim.sourceId) ?? null) }));
      return {
        entity: copy(entity),
        claims: entityClaims,
        relationships: relationships.filter((row) => row.workspaceId === workspaceId && (row.fromEntityId === entity.id || row.toEntityId === entity.id)).map(copy),
        directories: memberships.filter((row) => row.entityId === entity.id).map(copy),
        duplicates: duplicates.filter((row) => row.workspaceId === workspaceId && (row.leftEntityId === entity.id || row.rightEntityId === entity.id)).map(copy),
        revisions: revisions.filter((row) => row.entityId === entity.id).map(copy),
        lists: listItems.filter((item) => item.entityId === entity.id).map((item) => copy(lists.find((list) => list.id === item.listId))).filter(Boolean),
      };
    },
    async correctResearchClaim({ workspaceId, entityId, actorId, field, value, excerpt }) {
      return locked(workspaceId, async () => {
        const entity = entityOf(workspaceId, entityId);
        if (!entity) throw new StoreError('not_found');
        const at = stamp();
        const prior = claims.filter((claim) => claim.entityId === entity.id && claim.field === field && claim.value !== value && claim.status !== 'unknown');
        const status = prior.length ? 'conflicting' : 'reviewed';
        for (const claim of prior) claim.status = 'conflicting';
        const row = { id: randomUUID(), workspaceId, entityId, field, value, status, sourceId: null, excerpt, extractionMethod: 'human', observedAt: null, retrievedAt: at, contentFingerprint: null, createdAt: at };
        claims.push(row);
        revisions.push({ id: randomUUID(), workspaceId, entityId, actorId, patch: { field, value, status }, createdAt: at });
        entity.updatedAt = at;
        auditPush(workspaceId, actorId, 'research.corrected', 'research_entity', entityId, { field });
        return copy(row);
      });
    },
    async addResearchList({ workspaceId, projectId, createdBy, name, purpose }) {
      return locked(workspaceId, async () => {
        if (!projectOf(workspaceId, projectId)) throw new StoreError('not_found');
        if (lists.some((list) => list.projectId === projectId && list.name === name)) throw new StoreError('invalid_state', 'A list with that name already exists in this project.');
        const row = { id: randomUUID(), workspaceId, projectId, name, purpose, createdBy, createdAt: stamp() };
        lists.push(row);
        return copy(row);
      });
    },
    async addResearchListItem({ workspaceId, listId, entityId, note = '' }) {
      return locked(workspaceId, async () => {
        const list = lists.find((row) => row.id === listId && row.workspaceId === workspaceId);
        const entity = entityOf(workspaceId, entityId);
        if (!list || !entity) throw new StoreError('not_found');
        if (!memberships.some((row) => row.projectId === list.projectId && row.entityId === entity.id)) throw new StoreError('invalid_state', 'Add the record to this project before putting it on a list.');
        if (!listItems.some((item) => item.listId === list.id && item.entityId === entity.id)) listItems.push({ listId: list.id, entityId: entity.id, note, addedAt: stamp() });
        return { listId: list.id, entityId: entity.id };
      });
    },
    async removeResearchListItem({ workspaceId, listId, entityId }) {
      return locked(workspaceId, async () => {
        const list = lists.find((row) => row.id === listId && row.workspaceId === workspaceId);
        if (!list) throw new StoreError('not_found');
        const index = listItems.findIndex((item) => item.listId === listId && item.entityId === entityId);
        if (index < 0) throw new StoreError('not_found');
        listItems.splice(index, 1);
      });
    },
    async researchQuality({ workspaceId, projectId }) {
      const project = projectOf(workspaceId, projectId);
      if (!project) return null;
      const ids = new Set(memberships.filter((row) => row.projectId === projectId).map((row) => row.entityId));
      const report = qualityReport({
        entities: entities.filter((row) => ids.has(row.id)),
        claims: claims.filter((row) => ids.has(row.entityId)),
        sources: sources.filter((row) => row.workspaceId === workspaceId),
        duplicates: duplicates.filter((row) => row.workspaceId === workspaceId && (ids.has(row.leftEntityId) || ids.has(row.rightEntityId))),
        runs: runs.filter((row) => row.projectId === projectId),
      });
      return { checklist: copy(project.checklist), report };
    },
    async createResearchRun({ workspaceId, projectId, createdBy, question, scope, limits, permissions }) {
      return locked(workspaceId, async () => {
        if (!projectOf(workspaceId, projectId)) throw new StoreError('not_found');
        const at = stamp();
        const row = { id: randomUUID(), workspaceId, projectId, createdBy, question, scope, limits, permissions, status: 'proposed', output: null, error: null, createdAt: at, updatedAt: at, finishedAt: null };
        runs.push(row);
        events.push({ id: events.length + 1, runId: row.id, kind: 'progress', message: 'Proposed. No source has been fetched.', createdAt: at });
        return copy(row);
      });
    },
    async getResearchRun({ workspaceId, runId }) {
      const row = runs.find((run) => run.id === runId && run.workspaceId === workspaceId);
      if (!row) return null;
      return { run: copy(row), events: events.filter((event) => event.runId === row.id).map(copy) };
    },
    async recoverResearchRuns({ workspaceId, olderThan }) {
      return locked(workspaceId, async () => {
        let recovered = 0;
        for (const run of runs) {
          if (run.workspaceId === workspaceId && run.status === 'running' && run.updatedAt < olderThan) {
            run.status = 'failed';
            run.error = 'The run was interrupted before a report was stored.';
            run.output = null;
            run.finishedAt = stamp();
            run.updatedAt = run.finishedAt;
            events.push({ id: events.length + 1, runId: run.id, kind: 'failure', message: run.error, createdAt: run.finishedAt });
            recovered += 1;
          }
        }
        return recovered;
      });
    },
    async markResearchRunRunning({ workspaceId, runId }) {
      return locked(workspaceId, async () => {
        const run = runs.find((row) => row.id === runId && row.workspaceId === workspaceId);
        if (!run) throw new StoreError('not_found');
        if (run.status !== 'proposed') throw new StoreError('invalid_state', 'Only a proposed run can start.');
        run.status = 'running';
        run.updatedAt = stamp();
        events.push({ id: events.length + 1, runId: run.id, kind: 'progress', message: 'Started.', createdAt: run.updatedAt });
        return copy(run);
      });
    },
    async appendResearchRunEvent({ workspaceId, runId, kind, message }) {
      const run = runs.find((row) => row.id === runId && row.workspaceId === workspaceId);
      if (!run) throw new StoreError('not_found');
      const event = { id: events.length + 1, runId, kind, message: message.slice(0, 500), createdAt: stamp() };
      events.push(event);
      return copy(event);
    },
    async finishResearchRun({ workspaceId, runId, status, output, error }) {
      return locked(workspaceId, async () => {
        const run = runs.find((row) => row.id === runId && row.workspaceId === workspaceId);
        if (!run) throw new StoreError('not_found');
        if (run.status === 'cancelled') return copy(run);
        if (run.status !== 'running' && run.status !== 'proposed') throw new StoreError('invalid_state', 'This run has already finished.');
        if (status === 'completed' && (output == null || !Array.isArray(output.citations))) throw new StoreError('invalid_state', 'A completed run needs a stored report.');
        if (status === 'failed' && output != null) throw new StoreError('invalid_state', 'A failed run cannot store a successful report.');
        if (!['completed', 'failed', 'cancelled'].includes(status)) throw new StoreError('invalid_state');
        run.status = status;
        run.output = status === 'completed' ? copy(output) : null;
        run.error = error ? String(error).slice(0, 500) : null;
        run.finishedAt = stamp();
        run.updatedAt = run.finishedAt;
        events.push({ id: events.length + 1, runId, kind: status === 'completed' ? 'output' : 'failure', message: run.error || 'Report stored.', createdAt: run.finishedAt });
        return copy(run);
      });
    },
    async cancelResearchRun({ workspaceId, runId }) {
      return locked(workspaceId, async () => {
        const run = runs.find((row) => row.id === runId && row.workspaceId === workspaceId);
        if (!run) throw new StoreError('not_found');
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') throw new StoreError('invalid_state', 'This run has already finished.');
        run.status = 'cancelled';
        run.output = null;
        run.error = 'Cancelled before a report was stored.';
        run.finishedAt = stamp();
        run.updatedAt = run.finishedAt;
        events.push({ id: events.length + 1, runId, kind: 'failure', message: run.error, createdAt: run.finishedAt });
        return copy(run);
      });
    },
    async listResearchExport({ workspaceId, projectId, directory, listId }) {
      if (!projectOf(workspaceId, projectId)) return null;
      let ids;
      if (listId) {
        const list = lists.find((row) => row.id === listId && row.workspaceId === workspaceId && row.projectId === projectId);
        if (!list) return null;
        ids = new Set(listItems.filter((item) => item.listId === list.id).map((item) => item.entityId));
      } else {
        ids = new Set(memberships.filter((row) => row.projectId === projectId && (!directory || row.directory === directory)).map((row) => row.entityId));
      }
      const rows = [];
      for (const entity of entities.filter((row) => ids.has(row.id))) {
        const directoryName = memberships.find((row) => row.projectId === projectId && row.entityId === entity.id)?.directory ?? '';
        for (const claim of claims.filter((row) => row.entityId === entity.id)) {
          const source = sources.find((row) => row.id === claim.sourceId);
          rows.push({ directory: directoryName, kind: entity.kind, name: entity.name, field: claim.field, value: claim.value, claim_status: claim.status, source_url: source?.url ?? '', source_status: source?.status ?? '', retrieved_at: claim.retrievedAt ?? '', excerpt: claim.excerpt });
        }
      }
      return rows;
    },
  };
}
