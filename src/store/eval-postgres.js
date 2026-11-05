import { randomInt } from 'node:crypto';
import { StoreError } from './errors.js';
import { snapshotHash } from '../lib/capital-hash.js';
import {
  MAX_CASES, RUBRIC_VERSION, buildComparison, buildReportSnapshot, checkAdjudication, claimText, computeEvalIssues,
  defaultAcceptance, evalCounts, evalManifest, parseCaseJsonl, parsePredictionJsonl, predictionRecords, sourceCatalog,
  validateAcceptance, validateCase, validateRubricVersion,
} from '../lib/eval.js';

const stale = (message = 'revision') => new StoreError('stale_revision', message);
const invalid = (message) => new StoreError('invalid_state', message);
const expectRevision = (row, expectedRevision) => {
  if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision) throw stale();
};

/**
 * Evaluation methods for Postgres. State changes take the parent row lock and commit in one transaction.
 * Frozen versions, imports and reports are insert-only; the migration refuses later updates and deletes.
 */
export function evalPostgresMethods({ query, transaction, isId, iso, addAudit }) {
  const setRow = (r) => r ? {
    id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name, purpose: r.purpose, status: r.status,
    revision: r.revision, acceptance: r.acceptance, rubricVersion: r.rubric_version, createdBy: r.created_by,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  } : null;
  const caseRow = (r) => ({
    id: r.id, setId: r.set_id, workspaceId: r.workspace_id, caseKey: r.case_key, input: r.input,
    expectedAnswer: r.expected_answer, reviewCriteria: r.review_criteria, category: r.category, severity: r.severity,
    sourceRefs: r.source_refs, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  });
  const noteRow = (r) => ({ key: r.issue_key, note: r.note, createdBy: r.created_by, createdAt: iso(r.created_at) });
  const versionRow = (r) => {
    const manifest = r.manifest;
    return {
      id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, setId: r.set_id, number: r.number, revision: r.revision,
      name: manifest.name, purpose: manifest.purpose, acceptance: manifest.acceptance, rubricVersion: manifest.rubric_version ?? manifest.rubricVersion,
      cases: manifest.cases, qc: manifest.qc, manifest, contentHash: r.content_hash, createdBy: r.created_by, createdAt: iso(r.created_at),
    };
  };
  const batchRow = (r) => ({
    id: r.id, workspaceId: r.workspace_id, versionId: r.version_id, role: r.role, label: r.label, claimedSystem: r.claimed_system,
    claimedScorer: r.claimed_scorer, rubricVersion: r.rubric_version, provenance: r.provenance, contentHash: r.content_hash,
    importedBy: r.imported_by, importedAt: iso(r.imported_at),
  });
  const predictionRow = (r) => ({ id: r.id, batchId: r.batch_id, caseKey: r.case_key, status: r.status, output: r.output, error: r.error_code });
  const comparisonRow = (r) => ({
    id: r.id, workspaceId: r.workspace_id, setId: r.set_id, versionId: r.version_id, baselineBatchId: r.baseline_batch_id,
    candidateBatchId: r.candidate_batch_id, acceptance: r.acceptance, blind: r.blind, revision: r.revision, createdBy: r.created_by,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  });
  const judgmentRow = (r) => ({
    id: r.id, comparisonId: r.comparison_id, caseKey: r.case_key, baselineDecision: r.baseline_decision, candidateDecision: r.candidate_decision,
    adjudicationBaseline: r.adjudication_baseline, adjudicationCandidate: r.adjudication_candidate, note: r.note, reviewerId: r.reviewer_id,
    updatedAt: iso(r.updated_at),
  });
  const reportRow = (r) => r ? {
    id: r.id, workspaceId: r.workspace_id, comparisonId: r.comparison_id, revision: r.revision, snapshot: r.snapshot,
    contentHash: r.content_hash, decision: r.decision, approvedBy: r.approved_by, approvedAt: iso(r.approved_at),
  } : null;

  const lockSet = async (client, workspaceId, projectId, setId) => {
    if (![workspaceId, projectId, setId].every(isId)) throw new StoreError('not_found');
    const row = (await query('SELECT * FROM eval_sets WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE', [setId, workspaceId, projectId], client)).rows[0];
    if (!row) throw new StoreError('not_found');
    return row;
  };
  const draft = (row, expectedRevision) => {
    expectRevision(row, expectedRevision);
    if (row.status !== 'draft') throw invalid('This evaluation set is frozen. Start a new draft to change it. The frozen version is left as it was.');
  };
  const bump = (client, setId) => query('UPDATE eval_sets SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *', [setId], client);
  const catalog = async (client, workspaceId) => {
    if (!isId(workspaceId)) return [];
    const result = await query(`SELECT v.id, v.project_id, v.number, v.manifest, p.name AS project_name
      FROM dataset_versions v JOIN projects p ON p.id = v.project_id AND p.workspace_id = v.workspace_id
      WHERE v.workspace_id = $1 ORDER BY p.name, v.number`, [workspaceId], client);
    const names = new Map(result.rows.map((row) => [row.project_id, row.project_name]));
    return sourceCatalog(result.rows.map((row) => ({ id: row.id, projectId: row.project_id, number: row.number, manifest: row.manifest })), (id) => names.get(id));
  };
  const loadCases = async (client, setId) => (await query('SELECT * FROM eval_cases WHERE set_id = $1 ORDER BY case_key', [setId], client)).rows.map(caseRow);
  const loadNotes = async (client, setId) => (await query('SELECT * FROM eval_issue_notes WHERE set_id = $1 ORDER BY issue_key', [setId], client)).rows.map(noteRow);
  const loadVersion = async (client, workspaceId, versionId) => {
    if (!isId(workspaceId) || !isId(versionId)) return null;
    const row = (await query('SELECT * FROM eval_set_versions WHERE id = $1 AND workspace_id = $2', [versionId, workspaceId], client)).rows[0];
    return row ? versionRow(row) : null;
  };
  const loadPredictions = async (client, batchId) => (await query('SELECT * FROM eval_predictions WHERE batch_id = $1 ORDER BY case_key', [batchId], client)).rows.map(predictionRow);
  const loadBuilt = async (client, comparison, version) => {
    // One transaction client cannot run queries in parallel. Reads on the pool stay sequential too; the cost is a few indexed lookups.
    const baselinePredictions = await loadPredictions(client, comparison.baselineBatchId);
    const candidatePredictions = await loadPredictions(client, comparison.candidateBatchId);
    const judgmentRows = (await query('SELECT * FROM eval_judgments WHERE comparison_id = $1 ORDER BY case_key', [comparison.id], client)).rows.map(judgmentRow);
    const baselineBatch = batchRow((await query('SELECT * FROM eval_batches WHERE id = $1', [comparison.baselineBatchId], client)).rows[0]);
    const candidateBatch = batchRow((await query('SELECT * FROM eval_batches WHERE id = $1', [comparison.candidateBatchId], client)).rows[0]);
    const built = buildComparison({ version, acceptance: comparison.acceptance, baselinePredictions, candidatePredictions, judgments: judgmentRows });
    const snapshot = buildReportSnapshot({ version, baselineBatch, candidateBatch, comparison, built });
    return { baselineBatch, candidateBatch, built, snapshot, contentHash: snapshotHash(snapshot), judgments: judgmentRows };
  };

  return {
    async listEvalSources(workspaceId) { return catalog(undefined, workspaceId); },

    async listEvalSets({ workspaceId, projectId }) {
      if (!isId(workspaceId) || !isId(projectId)) return [];
      const result = await query(`SELECT s.*, (SELECT count(*)::int FROM eval_cases c WHERE c.set_id = s.id) AS case_count
        FROM eval_sets s WHERE s.workspace_id = $1 AND s.project_id = $2 ORDER BY s.created_at`, [workspaceId, projectId]);
      return result.rows.map((row) => ({ ...setRow(row), caseCount: row.case_count }));
    },

    async createEvalSet({ workspaceId, projectId, createdBy, name, purpose }) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed || trimmed.length > 120) throw new StoreError('invalid_import', 'Name the evaluation set in 120 characters or fewer.');
      if (!['development', 'final_assessment'].includes(purpose)) throw new StoreError('invalid_import', 'Choose development or final assessment. Neither label means the set is secret or leakage-free.');
      return transaction(async (client) => {
        if (!isId(workspaceId) || !isId(projectId)) throw new StoreError('not_found');
        const project = (await query('SELECT id FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId], client)).rows[0];
        if (!project) throw new StoreError('not_found');
        const row = (await query(`INSERT INTO eval_sets (workspace_id, project_id, name, purpose, acceptance, rubric_version, created_by)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
        [workspaceId, projectId, trimmed, purpose, JSON.stringify(defaultAcceptance()), RUBRIC_VERSION, createdBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'eval_set.created', targetType: 'eval_set', targetId: row.id, metadata: { purpose } });
        return setRow(row);
      });
    },

    async getEvalSet({ workspaceId, projectId, setId }) {
      if (![workspaceId, projectId, setId].every(isId)) return null;
      const row = (await query('SELECT * FROM eval_sets WHERE id = $1 AND workspace_id = $2 AND project_id = $3', [setId, workspaceId, projectId])).rows[0];
      if (!row) return null;
      const [cases, notes, sources, versionResult, comparisonResult, reportResult] = await Promise.all([
        loadCases(undefined, setId), loadNotes(undefined, setId), catalog(undefined, workspaceId),
        query('SELECT * FROM eval_set_versions WHERE set_id = $1 ORDER BY number', [setId]),
        query('SELECT * FROM eval_comparisons WHERE set_id = $1 ORDER BY created_at', [setId]),
        query(`SELECT r.* FROM eval_reports r JOIN eval_comparisons c ON c.id = r.comparison_id WHERE c.set_id = $1 ORDER BY r.approved_at`, [setId]),
      ]);
      const versions = [];
      for (const version of versionResult.rows.map(versionRow)) {
        const batchResult = await query('SELECT * FROM eval_batches WHERE version_id = $1 ORDER BY imported_at', [version.id]);
        versions.push({ ...version, batches: batchResult.rows.map(batchRow) });
      }
      return {
        set: setRow(row), cases, notes, sources, versions,
        issues: computeEvalIssues({ cases, notes, sources }),
        counts: evalCounts(cases),
        comparisons: comparisonResult.rows.map(comparisonRow),
        reports: reportResult.rows.map(reportRow),
      };
    },

    async updateEvalSet({ workspaceId, projectId, setId, expectedRevision, patch }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        const name = patch.name == null ? row.name : (typeof patch.name === 'string' ? patch.name.trim() : '');
        if (!name || name.length > 120) throw new StoreError('invalid_import', 'Name the evaluation set in 120 characters or fewer.');
        const purpose = patch.purpose == null ? row.purpose : patch.purpose;
        if (!['development', 'final_assessment'].includes(purpose)) throw new StoreError('invalid_import', 'Choose development or final assessment.');
        let acceptance = row.acceptance;
        if (patch.acceptance != null) {
          const validated = validateAcceptance(patch.acceptance);
          if (validated.error) throw new StoreError('invalid_import', validated.error);
          acceptance = validated.rule;
        }
        let rubric = row.rubric_version;
        if (patch.rubricVersion != null) {
          const validated = validateRubricVersion(patch.rubricVersion);
          if (validated.error) throw new StoreError('invalid_import', validated.error);
          rubric = validated.rubric;
        }
        const updated = (await query(`UPDATE eval_sets SET name = $2, purpose = $3, acceptance = $4::jsonb, rubric_version = $5, revision = revision + 1, updated_at = now()
          WHERE id = $1 RETURNING *`, [setId, name, purpose, JSON.stringify(acceptance), rubric], client)).rows[0];
        return setRow(updated);
      });
    },

    async saveEvalCase({ workspaceId, projectId, setId, expectedRevision, caseId = null, input }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        const validated = validateCase(input);
        if (validated.error) throw new StoreError('invalid_import', validated.error);
        const item = validated.case;
        const refs = JSON.stringify(item.sourceRefs);
        let saved;
        if (caseId) {
          if (!isId(caseId)) throw new StoreError('not_found');
          const clash = (await query('SELECT id FROM eval_cases WHERE set_id = $1 AND case_key = $2 AND id <> $3', [setId, item.caseKey, caseId], client)).rows[0];
          if (clash) throw new StoreError('invalid_import', `Case id ${item.caseKey} is already in this set. Nothing was changed.`);
          saved = (await query(`UPDATE eval_cases SET case_key = $3, input = $4, expected_answer = $5, review_criteria = $6, category = $7, severity = $8, source_refs = $9::jsonb, updated_at = now()
            WHERE id = $1 AND set_id = $2 RETURNING *`, [caseId, setId, item.caseKey, item.input, item.expectedAnswer, item.reviewCriteria, item.category, item.severity, refs], client)).rows[0];
          if (!saved) throw new StoreError('not_found');
        } else {
          const count = (await query('SELECT count(*)::int AS n FROM eval_cases WHERE set_id = $1', [setId], client)).rows[0].n;
          if (count >= MAX_CASES) throw new StoreError('quota_exceeded', `An evaluation set holds at most ${MAX_CASES} cases. Nothing was saved.`);
          const clash = (await query('SELECT id FROM eval_cases WHERE set_id = $1 AND case_key = $2', [setId, item.caseKey], client)).rows[0];
          if (clash) throw new StoreError('invalid_import', `Case id ${item.caseKey} is already in this set. Nothing was changed.`);
          saved = (await query(`INSERT INTO eval_cases (set_id, workspace_id, case_key, input, expected_answer, review_criteria, category, severity, source_refs)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
          [setId, workspaceId, item.caseKey, item.input, item.expectedAnswer, item.reviewCriteria, item.category, item.severity, refs], client)).rows[0];
        }
        await bump(client, setId);
        return caseRow(saved);
      });
    },

    async deleteEvalCase({ workspaceId, projectId, setId, caseId, expectedRevision }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        if (!isId(caseId)) throw new StoreError('not_found');
        const removed = (await query('DELETE FROM eval_cases WHERE id = $1 AND set_id = $2 RETURNING *', [caseId, setId], client)).rows[0];
        if (!removed) throw new StoreError('not_found');
        await bump(client, setId);
        return caseRow(removed);
      });
    },

    async importEvalCases({ workspaceId, projectId, setId, expectedRevision, jsonl }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        const parsed = parseCaseJsonl(jsonl);
        const existing = new Set((await query('SELECT case_key FROM eval_cases WHERE set_id = $1', [setId], client)).rows.map((item) => item.case_key));
        for (const item of parsed) {
          if (existing.has(item.caseKey)) throw new StoreError('invalid_import', `Case id ${item.caseKey} is already in this set. Nothing was saved.`);
        }
        if (existing.size + parsed.length > MAX_CASES) throw new StoreError('quota_exceeded', `An evaluation set holds at most ${MAX_CASES} cases. Nothing was saved.`);
        const saved = [];
        for (const item of parsed) {
          const inserted = (await query(`INSERT INTO eval_cases (set_id, workspace_id, case_key, input, expected_answer, review_criteria, category, severity, source_refs)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
          [setId, workspaceId, item.caseKey, item.input, item.expectedAnswer, item.reviewCriteria, item.category, item.severity, JSON.stringify(item.sourceRefs)], client)).rows[0];
          saved.push(caseRow(inserted));
        }
        const updated = (await bump(client, setId)).rows[0];
        return { cases: saved, revision: updated.revision };
      });
    },

    async setEvalIssueNote({ workspaceId, projectId, setId, expectedRevision, key, note, createdBy }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        const cases = await loadCases(client, setId);
        const notes = await loadNotes(client, setId);
        const issue = computeEvalIssues({ cases, notes, sources: await catalog(client, workspaceId) }).find((item) => item.key === key);
        if (!issue?.acknowledgeable) throw invalid('Only a suspected conflict can be acknowledged, and the cases stay unchanged.');
        const text = typeof note === 'string' ? note.trim() : '';
        if (!text || text.length > 2000) throw new StoreError('invalid_import', 'Write a note of at most 2000 characters.');
        const saved = (await query(`INSERT INTO eval_issue_notes (set_id, workspace_id, issue_key, note, created_by)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (set_id, issue_key) DO UPDATE SET note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()
          RETURNING *`, [setId, workspaceId, key, text, createdBy], client)).rows[0];
        await bump(client, setId);
        return noteRow(saved);
      });
    },

    async deleteEvalIssueNote({ workspaceId, projectId, setId, expectedRevision, key }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        draft(row, expectedRevision);
        const removed = await query('DELETE FROM eval_issue_notes WHERE set_id = $1 AND issue_key = $2', [setId, key], client);
        if (!removed.rowCount) throw new StoreError('not_found');
        await bump(client, setId);
      });
    },

    async freezeEvalSet({ workspaceId, projectId, setId, expectedRevision, actorId }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        expectRevision(row, expectedRevision);
        const already = (await query('SELECT * FROM eval_set_versions WHERE set_id = $1 AND revision = $2', [setId, row.revision], client)).rows[0];
        if (row.status === 'frozen' && already) return versionRow(already);
        if (row.status !== 'draft') throw invalid('This evaluation set is already frozen.');
        const cases = await loadCases(client, setId);
        if (!cases.length) throw invalid('Add at least one case before freezing the set.');
        const notes = await loadNotes(client, setId);
        const issues = computeEvalIssues({ cases, notes, sources: await catalog(client, workspaceId) });
        const open = issues.filter((issue) => issue.open).length;
        if (open) throw Object.assign(new StoreError('issues_open', `${open} quality finding${open === 1 ? '' : 's'} still need a repair or, for a suspected conflict, an acknowledgement.`), { open });
        const acceptance = validateAcceptance(row.acceptance);
        if (acceptance.error) throw new StoreError('invalid_import', acceptance.error);
        const set = setRow(row);
        const manifest = evalManifest({ set, cases, issues, counts: evalCounts(cases) });
        const number = (await query('SELECT coalesce(max(number), 0)::int + 1 AS n FROM eval_set_versions WHERE set_id = $1', [setId], client)).rows[0].n;
        const inserted = (await query(`INSERT INTO eval_set_versions (set_id, workspace_id, project_id, number, revision, manifest, content_hash, created_by)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [setId, workspaceId, projectId, number, row.revision, JSON.stringify(manifest), snapshotHash(manifest), actorId], client)).rows[0];
        await query(`UPDATE eval_sets SET status = 'frozen', updated_at = now() WHERE id = $1`, [setId], client);
        await addAudit(client, { workspaceId, actorId, action: 'eval_set.frozen', targetType: 'eval_set', targetId: setId, metadata: { number, contentHash: inserted.content_hash } });
        return versionRow(inserted);
      });
    },

    async reopenEvalSet({ workspaceId, projectId, setId, actorId }) {
      return transaction(async (client) => {
        const row = await lockSet(client, workspaceId, projectId, setId);
        if (row.status !== 'frozen') throw invalid('This evaluation set is already a draft.');
        const updated = (await query(`UPDATE eval_sets SET status = 'draft', revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`, [setId], client)).rows[0];
        await addAudit(client, { workspaceId, actorId, action: 'eval_set.reopened', targetType: 'eval_set', targetId: setId, metadata: { revision: updated.revision } });
        return setRow(updated);
      });
    },

    async getEvalVersion({ workspaceId, versionId }) {
      return loadVersion(undefined, workspaceId, versionId);
    },

    async importEvalPredictions({ workspaceId, projectId, versionId, role, label, claimedSystem, claimedScorer, filename, jsonl, importedBy }) {
      return transaction(async (client) => {
        if (!isId(workspaceId) || !isId(versionId)) throw new StoreError('not_found');
        const locked = (await query('SELECT * FROM eval_set_versions WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE', [versionId, workspaceId, projectId], client)).rows[0];
        if (!locked) throw new StoreError('not_found');
        const version = versionRow(locked);
        if (!['baseline', 'candidate'].includes(role)) throw new StoreError('invalid_import', 'Mark the import as a baseline or a candidate.');
        const name = typeof label === 'string' ? label.trim() : '';
        if (!name || name.length > 80) throw new StoreError('invalid_import', 'Label this import in 80 characters or fewer.');
        const system = {
          identity: claimText(claimedSystem?.identity, 120, 'The claimed system name'),
          configuration: claimText(claimedSystem?.configuration, 500, 'The claimed configuration'),
        };
        const scorer = claimText(claimedScorer, 80, 'The claimed scorer version');
        const rows = parsePredictionJsonl(jsonl, new Set(version.cases.map((item) => item.caseKey)));
        const contentHash = snapshotHash(predictionRecords(rows));
        const existing = (await query('SELECT * FROM eval_batches WHERE version_id = $1 AND role = $2 AND label = $3', [versionId, role, name], client)).rows[0];
        if (existing) {
          if (existing.content_hash === contentHash) return { batch: batchRow(existing), predictions: await loadPredictions(client, existing.id), replayed: true };
          throw invalid(`An import labelled “${name}” already exists for this frozen set with different answers. Keep that import and add a new label. Nothing was saved.`);
        }
        const provenance = { source: 'jsonl-import', filename: filename ? String(filename).slice(0, 200) : null, rowCount: rows.length, byteLength: Buffer.byteLength(jsonl) };
        const batch = (await query(`INSERT INTO eval_batches (workspace_id, version_id, role, label, claimed_system, claimed_scorer, rubric_version, provenance, content_hash, imported_by)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
        [workspaceId, versionId, role, name, JSON.stringify(system), scorer, version.rubricVersion, JSON.stringify(provenance), contentHash, importedBy], client)).rows[0];
        const stored = [];
        for (const item of rows) {
          const inserted = (await query(`INSERT INTO eval_predictions (batch_id, case_key, status, output, error_code) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [batch.id, item.caseKey, item.status, item.output, item.error], client)).rows[0];
          stored.push(predictionRow(inserted));
        }
        await addAudit(client, { workspaceId, actorId: importedBy, action: 'eval_predictions.imported', targetType: 'eval_batch', targetId: batch.id, metadata: { versionId, role, label: name, rows: rows.length } });
        return { batch: batchRow(batch), predictions: stored, replayed: false };
      });
    },

    async listEvalBatches({ workspaceId, versionId }) {
      if (!isId(workspaceId) || !isId(versionId)) return [];
      const result = await query(`SELECT b.* FROM eval_batches b JOIN eval_set_versions v ON v.id = b.version_id
        WHERE b.version_id = $1 AND v.workspace_id = $2 ORDER BY b.imported_at`, [versionId, workspaceId]);
      return result.rows.map(batchRow);
    },

    async listEvalPredictions({ workspaceId, batchId }) {
      if (!isId(workspaceId) || !isId(batchId)) return [];
      const result = await query(`SELECT p.* FROM eval_predictions p
        JOIN eval_batches b ON b.id = p.batch_id JOIN eval_set_versions v ON v.id = b.version_id
        WHERE p.batch_id = $1 AND v.workspace_id = $2 ORDER BY p.case_key`, [batchId, workspaceId]);
      return result.rows.map(predictionRow);
    },

    async createEvalComparison({ workspaceId, projectId, setId, versionId, baselineBatchId, candidateBatchId, createdBy }) {
      return transaction(async (client) => {
        if (![workspaceId, projectId, setId, versionId, baselineBatchId, candidateBatchId].every(isId)) throw new StoreError('not_found');
        const version = (await query('SELECT * FROM eval_set_versions WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND set_id = $4 FOR UPDATE', [versionId, workspaceId, projectId, setId], client)).rows[0];
        if (!version) throw new StoreError('not_found');
        const baseline = (await query(`SELECT id FROM eval_batches WHERE id = $1 AND version_id = $2 AND role = 'baseline'`, [baselineBatchId, versionId], client)).rows[0];
        const candidate = (await query(`SELECT id FROM eval_batches WHERE id = $1 AND version_id = $2 AND role = 'candidate'`, [candidateBatchId, versionId], client)).rows[0];
        if (!baseline || !candidate) throw new StoreError('not_found', 'Choose one baseline import and one candidate import from this frozen set.');
        const existing = (await query('SELECT * FROM eval_comparisons WHERE version_id = $1 AND baseline_batch_id = $2 AND candidate_batch_id = $3', [versionId, baselineBatchId, candidateBatchId], client)).rows[0];
        if (existing) return comparisonRow(existing);
        const acceptance = versionRow(version).acceptance;
        const inserted = (await query(`INSERT INTO eval_comparisons (workspace_id, set_id, version_id, baseline_batch_id, candidate_batch_id, acceptance, created_by)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [workspaceId, setId, versionId, baselineBatchId, candidateBatchId, JSON.stringify(acceptance), createdBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: createdBy, action: 'eval_comparison.created', targetType: 'eval_comparison', targetId: inserted.id, metadata: { versionId } });
        return comparisonRow(inserted);
      });
    },

    async setEvalBlind({ workspaceId, comparisonId, expectedRevision, hideIdentity, swap, randomize = false }) {
      return transaction(async (client) => {
        if (!isId(workspaceId) || !isId(comparisonId)) throw new StoreError('not_found');
        const row = (await query('SELECT * FROM eval_comparisons WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [comparisonId, workspaceId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        expectRevision(row, expectedRevision);
        const next = { hideIdentity: hideIdentity === true, swap: randomize ? randomInt(0, 2) === 1 : swap === true };
        const same = row.blind.hideIdentity === next.hideIdentity && row.blind.swap === next.swap && !randomize;
        if (same) return comparisonRow(row);
        const judged = (await query('SELECT 1 FROM eval_judgments WHERE comparison_id = $1 LIMIT 1', [comparisonId], client)).rowCount;
        if (judged) throw invalid('Blind review is already in progress. The saved left and right assignment stays as it was.');
        const updated = (await query(`UPDATE eval_comparisons SET blind = $2::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`, [comparisonId, JSON.stringify(next)], client)).rows[0];
        return comparisonRow(updated);
      });
    },

    async recordEvalJudgment({ workspaceId, comparisonId, expectedRevision, caseKey, patch, reviewerId }) {
      return transaction(async (client) => {
        if (!isId(workspaceId) || !isId(comparisonId)) throw new StoreError('not_found');
        const row = (await query('SELECT * FROM eval_comparisons WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [comparisonId, workspaceId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        expectRevision(row, expectedRevision);
        const comparison = comparisonRow(row);
        const version = await loadVersion(client, workspaceId, comparison.versionId);
        if (!version.cases.some((item) => item.caseKey === caseKey)) throw new StoreError('not_found', 'That case is not in this frozen evaluation set.');
        const note = patch.note == null || patch.note === '' ? null : claimText(patch.note, 2000, 'The review note');
        const autos = await loadBuilt(client, { ...comparison, id: comparisonId }, version);
        const scored = autos.built.rows.find((item) => item.caseKey === caseKey);
        checkAdjudication(scored.baseline.auto, patch.baselineDecision, patch.adjudicationBaseline, 'The baseline');
        checkAdjudication(scored.candidate.auto, patch.candidateDecision, patch.adjudicationCandidate, 'The candidate');
        const saved = (await query(`INSERT INTO eval_judgments (comparison_id, workspace_id, case_key, baseline_decision, candidate_decision, adjudication_baseline, adjudication_candidate, note, reviewer_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (comparison_id, case_key) DO UPDATE SET
            baseline_decision = EXCLUDED.baseline_decision, candidate_decision = EXCLUDED.candidate_decision,
            adjudication_baseline = EXCLUDED.adjudication_baseline, adjudication_candidate = EXCLUDED.adjudication_candidate,
            note = EXCLUDED.note, reviewer_id = EXCLUDED.reviewer_id, updated_at = now()
          RETURNING *`,
        [comparisonId, workspaceId, caseKey, patch.baselineDecision, patch.candidateDecision, patch.adjudicationBaseline, patch.adjudicationCandidate, note, reviewerId], client)).rows[0];
        const updated = (await query('UPDATE eval_comparisons SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *', [comparisonId], client)).rows[0];
        return { comparison: comparisonRow(updated), judgment: judgmentRow(saved) };
      });
    },

    async readEvalComparison({ workspaceId, comparisonId }) {
      if (!isId(workspaceId) || !isId(comparisonId)) return null;
      const row = (await query('SELECT * FROM eval_comparisons WHERE id = $1 AND workspace_id = $2', [comparisonId, workspaceId])).rows[0];
      if (!row) return null;
      const comparison = comparisonRow(row);
      const version = await loadVersion(undefined, workspaceId, comparison.versionId);
      const detail = await loadBuilt(undefined, comparison, version);
      return { comparison, version, ...detail };
    },

    async approveEvalReport({ workspaceId, comparisonId, expectedRevision, contentHash, approvedBy }) {
      return transaction(async (client) => {
        if (!isId(workspaceId) || !isId(comparisonId)) throw new StoreError('not_found');
        const row = (await query('SELECT * FROM eval_comparisons WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [comparisonId, workspaceId], client)).rows[0];
        if (!row) throw new StoreError('not_found');
        expectRevision(row, expectedRevision);
        const comparison = comparisonRow(row);
        const version = await loadVersion(client, workspaceId, comparison.versionId);
        const detail = await loadBuilt(client, comparison, version);
        if (detail.contentHash !== contentHash) throw stale('content');
        const existing = (await query('SELECT * FROM eval_reports WHERE comparison_id = $1 AND revision = $2', [comparisonId, row.revision], client)).rows[0];
        if (existing) {
          if (existing.content_hash === contentHash) return reportRow(existing);
          throw stale('content');
        }
        const inserted = (await query(`INSERT INTO eval_reports (workspace_id, comparison_id, revision, snapshot, content_hash, decision, approved_by)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
        [workspaceId, comparisonId, row.revision, JSON.stringify(detail.snapshot), contentHash, detail.snapshot.decision.result, approvedBy], client)).rows[0];
        await addAudit(client, { workspaceId, actorId: approvedBy, action: 'eval_report.approved', targetType: 'eval_report', targetId: inserted.id, metadata: { comparisonId, revision: row.revision, decision: inserted.decision } });
        return reportRow(inserted);
      });
    },

    async getEvalReport({ workspaceId, reportId }) {
      if (!isId(workspaceId) || !isId(reportId)) return null;
      return reportRow((await query('SELECT * FROM eval_reports WHERE id = $1 AND workspace_id = $2', [reportId, workspaceId])).rows[0]);
    },

    async listEvalReports({ workspaceId, comparisonId = null, setId = null }) {
      if (!isId(workspaceId)) return [];
      const result = await query(`SELECT r.* FROM eval_reports r JOIN eval_comparisons c ON c.id = r.comparison_id
        WHERE r.workspace_id = $1 AND ($2::uuid IS NULL OR r.comparison_id = $2) AND ($3::uuid IS NULL OR c.set_id = $3)
        ORDER BY r.approved_at`, [workspaceId, comparisonId, setId]);
      return result.rows.map(reportRow);
    },
  };
}
