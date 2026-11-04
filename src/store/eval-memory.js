import { randomUUID, randomInt } from 'node:crypto';
import { StoreError } from './errors.js';
import { snapshotHash } from '../lib/capital-hash.js';
import {
  MAX_CASES, RUBRIC_VERSION, checkAdjudication, computeEvalIssues, defaultAcceptance, evalCounts, evalManifest,
  parseCaseJsonl, parsePredictionJsonl, predictionRecords, sourceCatalog, validateAcceptance, validateCase, validateRubricVersion,
  buildComparison, buildReportSnapshot, claimText,
} from '../lib/eval.js';

const stale = (message = 'revision') => new StoreError('stale_revision', message);
const invalid = (message) => new StoreError('invalid_state', message);

/**
 * Evaluation methods for the in-memory store. Mutations on one set or comparison run one at a time,
 * matching the row locks in Postgres. Returned values are copies.
 */
export function evalMemoryMethods({ stamp, copy, versions, projects, audit }) {
  const sets = [];
  const cases = [];
  const notes = [];
  const setVersions = [];
  const batches = [];
  const predictions = [];
  const comparisons = [];
  const judgments = [];
  const reports = [];
  const tails = new Map();

  const locked = async (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tails.set(key, gate);
    await prev.catch(() => {});
    try { return await fn(); }
    finally { release(); }
  };
  const auditPush = (workspaceId, actorId, action, targetType, targetId, metadata = {}) => {
    audit.push({ id: audit.length + 1, workspaceId, actorId, action, targetType, targetId, metadata: copy(metadata), createdAt: stamp() });
  };
  const setOf = (workspaceId, projectId, setId) => sets.find((row) => row.id === setId && row.workspaceId === workspaceId && row.projectId === projectId) ?? null;
  const casesOf = (setId) => cases.filter((row) => row.setId === setId).sort((a, b) => a.caseKey.localeCompare(b.caseKey));
  const notesOf = (setId) => notes.filter((row) => row.setId === setId).sort((a, b) => a.key.localeCompare(b.key));
  const catalog = (workspaceId) => sourceCatalog(
    versions.filter((version) => version.workspaceId === workspaceId),
    (projectId) => projects.get(projectId)?.name,
  );
  const issuesFor = (setId, workspaceId) => computeEvalIssues({ cases: casesOf(setId), notes: notesOf(setId), sources: catalog(workspaceId) });
  const requireDraft = (set, expectedRevision) => {
    if (!Number.isInteger(expectedRevision) || set.revision !== expectedRevision) throw stale();
    if (set.status !== 'draft') throw invalid('This evaluation set is frozen. Start a new draft to change it. The frozen version is left as it was.');
  };
  const bump = (set) => { set.revision += 1; set.updatedAt = stamp(); };
  const versionOf = (workspaceId, versionId) => setVersions.find((row) => row.id === versionId && row.workspaceId === workspaceId) ?? null;
  const publicSet = (row) => copy(row);
  const publicCaseRow = (row) => copy(row);
  const publicVersion = (row) => copy(row);
  const publicBatch = (row) => copy(row);
  const publicComparison = (row) => copy(row);
  const publicJudgment = (row) => copy(row);
  const publicReport = (row) => copy(row);

  return {
    async listEvalSources(workspaceId) { return catalog(workspaceId); },

    async listEvalSets({ workspaceId, projectId }) {
      return sets.filter((row) => row.workspaceId === workspaceId && row.projectId === projectId)
        .map((row) => ({ ...publicSet(row), caseCount: casesOf(row.id).length }));
    },

    async createEvalSet({ workspaceId, projectId, createdBy, name, purpose }) {
      const project = projects.get(projectId);
      if (!project || project.workspaceId !== workspaceId) throw new StoreError('not_found');
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed || trimmed.length > 120) throw new StoreError('invalid_import', 'Name the evaluation set in 120 characters or fewer.');
      if (!['development', 'final_assessment'].includes(purpose)) throw new StoreError('invalid_import', 'Choose development or final assessment. Neither label means the set is secret or leakage-free.');
      const at = stamp();
      const row = {
        id: randomUUID(), workspaceId, projectId, name: trimmed, purpose, status: 'draft', revision: 1,
        acceptance: defaultAcceptance(), rubricVersion: RUBRIC_VERSION, createdBy, createdAt: at, updatedAt: at,
      };
      sets.push(row);
      auditPush(workspaceId, createdBy, 'eval_set.created', 'eval_set', row.id, { purpose });
      return publicSet(row);
    },

    async getEvalSet({ workspaceId, projectId, setId }) {
      const set = setOf(workspaceId, projectId, setId);
      if (!set) return null;
      const rows = casesOf(setId);
      const issueNotes = notesOf(setId);
      const sources = catalog(workspaceId);
      return {
        set: publicSet(set),
        cases: rows.map(publicCaseRow),
        notes: issueNotes.map(({ key, note, createdBy, createdAt }) => ({ key, note, createdBy, createdAt })),
        issues: issuesFor(setId, workspaceId),
        counts: evalCounts(rows),
        versions: setVersions.filter((row) => row.setId === setId).map((row) => ({
          ...publicVersion(row),
          batches: batches.filter((batch) => batch.versionId === row.id).map(publicBatch),
        })),
        comparisons: comparisons.filter((row) => row.setId === setId).map(publicComparison),
        reports: reports.filter((row) => comparisons.some((item) => item.id === row.comparisonId && item.setId === setId)).map(publicReport),
        sources,
      };
    },

    async updateEvalSet({ workspaceId, projectId, setId, expectedRevision, patch }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        if (patch.name != null) {
          const name = typeof patch.name === 'string' ? patch.name.trim() : '';
          if (!name || name.length > 120) throw new StoreError('invalid_import', 'Name the evaluation set in 120 characters or fewer.');
          set.name = name;
        }
        if (patch.purpose != null) {
          if (!['development', 'final_assessment'].includes(patch.purpose)) throw new StoreError('invalid_import', 'Choose development or final assessment.');
          set.purpose = patch.purpose;
        }
        if (patch.acceptance != null) {
          const { rule, error } = validateAcceptance(patch.acceptance);
          if (error) throw new StoreError('invalid_import', error);
          set.acceptance = rule;
        }
        if (patch.rubricVersion != null) {
          const { rubric, error } = validateRubricVersion(patch.rubricVersion);
          if (error) throw new StoreError('invalid_import', error);
          set.rubricVersion = rubric;
        }
        bump(set);
        return publicSet(set);
      });
    },

    async saveEvalCase({ workspaceId, projectId, setId, expectedRevision, caseId = null, input }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        const { case: row, error } = validateCase(input);
        if (error) throw new StoreError('invalid_import', error);
        const at = stamp();
        if (caseId) {
          const existing = cases.find((item) => item.id === caseId && item.setId === setId);
          if (!existing) throw new StoreError('not_found');
          if (cases.some((item) => item.setId === setId && item.caseKey === row.caseKey && item.id !== caseId)) {
            throw new StoreError('invalid_import', `Case id ${row.caseKey} is already in this set. Nothing was changed.`);
          }
          Object.assign(existing, row, { updatedAt: at });
          bump(set);
          return publicCaseRow(existing);
        }
        if (cases.some((item) => item.setId === setId && item.caseKey === row.caseKey)) {
          throw new StoreError('invalid_import', `Case id ${row.caseKey} is already in this set. Nothing was changed.`);
        }
        if (casesOf(setId).length >= MAX_CASES) throw new StoreError('quota_exceeded', `An evaluation set holds at most ${MAX_CASES} cases. Nothing was saved.`);
        const created = { id: randomUUID(), setId, workspaceId, ...row, createdAt: at, updatedAt: at };
        cases.push(created);
        bump(set);
        return publicCaseRow(created);
      });
    },

    async deleteEvalCase({ workspaceId, projectId, setId, caseId, expectedRevision }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        const index = cases.findIndex((item) => item.id === caseId && item.setId === setId);
        if (index < 0) throw new StoreError('not_found');
        const [removed] = cases.splice(index, 1);
        bump(set);
        return publicCaseRow(removed);
      });
    },

    async importEvalCases({ workspaceId, projectId, setId, expectedRevision, jsonl }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        const rows = parseCaseJsonl(jsonl);
        const have = new Set(casesOf(setId).map((item) => item.caseKey));
        for (const row of rows) {
          if (have.has(row.caseKey)) throw new StoreError('invalid_import', `Case id ${row.caseKey} is already in this set. Nothing was saved.`);
        }
        if (have.size + rows.length > MAX_CASES) throw new StoreError('quota_exceeded', `An evaluation set holds at most ${MAX_CASES} cases. Nothing was saved.`);
        const at = stamp();
        const created = rows.map((row) => ({ id: randomUUID(), setId, workspaceId, ...row, createdAt: at, updatedAt: at }));
        cases.push(...created);
        bump(set);
        return { cases: created.map(publicCaseRow), revision: set.revision };
      });
    },

    async setEvalIssueNote({ workspaceId, projectId, setId, expectedRevision, key, note, createdBy }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        const issue = issuesFor(setId, workspaceId).find((item) => item.key === key);
        if (!issue?.acknowledgeable) throw invalid('Only a suspected conflict can be acknowledged, and the cases stay unchanged.');
        const text = typeof note === 'string' ? note.trim() : '';
        if (!text || text.length > 2000) throw new StoreError('invalid_import', 'Write a note of at most 2000 characters.');
        const existing = notes.find((item) => item.setId === setId && item.key === key);
        const row = existing ?? { setId, workspaceId, key };
        Object.assign(row, { note: text, createdBy, createdAt: stamp() });
        if (!existing) notes.push(row);
        bump(set);
        return { key: row.key, note: row.note, createdBy: row.createdBy, createdAt: row.createdAt };
      });
    },

    async deleteEvalIssueNote({ workspaceId, projectId, setId, expectedRevision, key }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        requireDraft(set, expectedRevision);
        const index = notes.findIndex((item) => item.setId === setId && item.key === key);
        if (index < 0) throw new StoreError('not_found');
        notes.splice(index, 1);
        bump(set);
      });
    },

    async freezeEvalSet({ workspaceId, projectId, setId, expectedRevision, actorId }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        if (!Number.isInteger(expectedRevision) || set.revision !== expectedRevision) throw stale();
        const existing = setVersions.find((row) => row.setId === setId && row.revision === set.revision);
        if (set.status === 'frozen' && existing) return publicVersion(existing);
        if (set.status !== 'draft') throw invalid('This evaluation set is already frozen.');
        const rows = casesOf(setId);
        if (!rows.length) throw invalid('Add at least one case before freezing the set.');
        const issues = issuesFor(setId, workspaceId);
        const open = issues.filter((issue) => issue.open).length;
        if (open) throw Object.assign(new StoreError('issues_open', `${open} quality finding${open === 1 ? '' : 's'} still need a repair or, for a suspected conflict, an acknowledgement.`), { open });
        const { error } = validateAcceptance(set.acceptance);
        if (error) throw new StoreError('invalid_import', error);
        const manifest = copy(evalManifest({ set, cases: rows, issues, counts: evalCounts(rows) }));
        const version = {
          id: randomUUID(), workspaceId, projectId, setId, number: setVersions.filter((row) => row.setId === setId).length + 1,
          revision: set.revision, name: set.name, purpose: set.purpose, acceptance: copy(set.acceptance), rubricVersion: set.rubricVersion,
          cases: manifest.cases, qc: manifest.qc, manifest, contentHash: snapshotHash(manifest), createdBy: actorId, createdAt: stamp(),
        };
        setVersions.push(version);
        set.status = 'frozen';
        set.updatedAt = stamp();
        auditPush(workspaceId, actorId, 'eval_set.frozen', 'eval_set', setId, { number: version.number, contentHash: version.contentHash });
        return publicVersion(version);
      });
    },

    async reopenEvalSet({ workspaceId, projectId, setId, actorId }) {
      return locked(setId, async () => {
        const set = setOf(workspaceId, projectId, setId);
        if (!set) throw new StoreError('not_found');
        if (set.status !== 'frozen') throw invalid('This evaluation set is already a draft.');
        set.status = 'draft';
        set.revision += 1;
        set.updatedAt = stamp();
        auditPush(workspaceId, actorId, 'eval_set.reopened', 'eval_set', setId, { revision: set.revision });
        return publicSet(set);
      });
    },

    async getEvalVersion({ workspaceId, versionId }) {
      return publicVersion(versionOf(workspaceId, versionId));
    },

    async importEvalPredictions({ workspaceId, projectId, versionId, role, label, claimedSystem, claimedScorer, filename, jsonl, importedBy }) {
      const version = versionOf(workspaceId, versionId);
      if (!version || version.projectId !== projectId) throw new StoreError('not_found');
      return locked(`version:${versionId}`, async () => {
        if (!['baseline', 'candidate'].includes(role)) throw new StoreError('invalid_import', 'Mark the import as a baseline or a candidate.');
        const name = typeof label === 'string' ? label.trim() : '';
        if (!name || name.length > 80) throw new StoreError('invalid_import', 'Label this import in 80 characters or fewer.');
        const system = {
          identity: claimText(claimedSystem?.identity, 120, 'The claimed system name'),
          configuration: claimText(claimedSystem?.configuration, 500, 'The claimed configuration'),
        };
        const scorer = claimText(claimedScorer, 80, 'The claimed scorer version');
        const known = new Set(version.cases.map((row) => row.caseKey));
        const rows = parsePredictionJsonl(jsonl, known);
        const records = predictionRecords(rows);
        const contentHash = snapshotHash(records);
        const provenance = { source: 'jsonl-import', filename: filename ? String(filename).slice(0, 200) : null, rowCount: rows.length, byteLength: Buffer.byteLength(jsonl) };
        const existing = batches.find((row) => row.versionId === versionId && row.role === role && row.label === name);
        if (existing) {
          if (existing.contentHash === contentHash) return { batch: publicBatch(existing), predictions: predictions.filter((row) => row.batchId === existing.id).map(copy), replayed: true };
          throw invalid(`An import labelled “${name}” already exists for this frozen set with different answers. Keep that import and add a new label. Nothing was saved.`);
        }
        const batch = {
          id: randomUUID(), workspaceId, versionId, role, label: name, claimedSystem: system, claimedScorer: scorer,
          rubricVersion: version.rubricVersion, provenance, contentHash, importedBy, importedAt: stamp(),
        };
        const stored = rows.map((row) => ({ id: randomUUID(), batchId: batch.id, ...row }));
        batches.push(batch);
        predictions.push(...stored);
        auditPush(workspaceId, importedBy, 'eval_predictions.imported', 'eval_batch', batch.id, { versionId, role, label: name, rows: rows.length });
        return { batch: publicBatch(batch), predictions: stored.map(copy), replayed: false };
      });
    },

    async listEvalBatches({ workspaceId, versionId }) {
      const version = versionOf(workspaceId, versionId);
      if (!version) return [];
      return batches.filter((row) => row.versionId === versionId).map(publicBatch);
    },

    async listEvalPredictions({ workspaceId, batchId }) {
      const batch = batches.find((row) => row.id === batchId);
      if (!batch || !versionOf(workspaceId, batch.versionId)) return [];
      return predictions.filter((row) => row.batchId === batchId).map(copy);
    },

    async createEvalComparison({ workspaceId, projectId, setId, versionId, baselineBatchId, candidateBatchId, createdBy }) {
      return locked(`version:${versionId}`, async () => {
        const version = versionOf(workspaceId, versionId);
        if (!version || version.projectId !== projectId || version.setId !== setId) throw new StoreError('not_found');
        const baseline = batches.find((row) => row.id === baselineBatchId && row.versionId === versionId && row.role === 'baseline');
        const candidate = batches.find((row) => row.id === candidateBatchId && row.versionId === versionId && row.role === 'candidate');
        if (!baseline || !candidate) throw new StoreError('not_found', 'Choose one baseline import and one candidate import from this frozen set.');
        const existing = comparisons.find((row) => row.versionId === versionId && row.baselineBatchId === baselineBatchId && row.candidateBatchId === candidateBatchId);
        if (existing) return publicComparison(existing);
        const at = stamp();
        const row = {
          id: randomUUID(), workspaceId, setId, versionId, baselineBatchId, candidateBatchId,
          acceptance: copy(version.acceptance), blind: { hideIdentity: false, swap: false }, revision: 1,
          createdBy, createdAt: at, updatedAt: at,
        };
        comparisons.push(row);
        auditPush(workspaceId, createdBy, 'eval_comparison.created', 'eval_comparison', row.id, { versionId });
        return publicComparison(row);
      });
    },

    async setEvalBlind({ workspaceId, comparisonId, expectedRevision, hideIdentity, swap, randomize = false }) {
      return locked(`comparison:${comparisonId}`, async () => {
        const comparison = comparisons.find((row) => row.id === comparisonId && row.workspaceId === workspaceId);
        if (!comparison) throw new StoreError('not_found');
        if (!Number.isInteger(expectedRevision) || comparison.revision !== expectedRevision) throw stale();
        const next = {
          hideIdentity: hideIdentity === true,
          swap: randomize ? randomInt(0, 2) === 1 : swap === true,
        };
        const same = comparison.blind.hideIdentity === next.hideIdentity && comparison.blind.swap === next.swap && !randomize;
        if (same) return publicComparison(comparison);
        if (judgments.some((row) => row.comparisonId === comparisonId)) {
          throw invalid('Blind review is already in progress. The saved left and right assignment stays as it was.');
        }
        comparison.blind = next;
        comparison.revision += 1;
        comparison.updatedAt = stamp();
        return publicComparison(comparison);
      });
    },

    async recordEvalJudgment({ workspaceId, comparisonId, expectedRevision, caseKey, patch, reviewerId }) {
      return locked(`comparison:${comparisonId}`, async () => {
        const comparison = comparisons.find((row) => row.id === comparisonId && row.workspaceId === workspaceId);
        if (!comparison) throw new StoreError('not_found');
        if (!Number.isInteger(expectedRevision) || comparison.revision !== expectedRevision) throw stale();
        const version = versionOf(workspaceId, comparison.versionId);
        const caseRow = version?.cases.find((row) => row.caseKey === caseKey);
        if (!caseRow) throw new StoreError('not_found', 'That case is not in this frozen evaluation set.');
        const note = patch.note == null || patch.note === '' ? null : claimText(patch.note, 2000, 'The review note');
        const built = buildComparison({
          version, acceptance: comparison.acceptance,
          baselinePredictions: predictions.filter((row) => row.batchId === comparison.baselineBatchId),
          candidatePredictions: predictions.filter((row) => row.batchId === comparison.candidateBatchId),
          judgments: [],
        });
        const scored = built.rows.find((row) => row.caseKey === caseKey);
        checkAdjudication(scored.baseline.auto, patch.baselineDecision, patch.adjudicationBaseline, 'The baseline');
        checkAdjudication(scored.candidate.auto, patch.candidateDecision, patch.adjudicationCandidate, 'The candidate');
        const existing = judgments.find((row) => row.comparisonId === comparisonId && row.caseKey === caseKey);
        const row = existing ?? { id: randomUUID(), comparisonId, workspaceId, caseKey };
        Object.assign(row, {
          baselineDecision: patch.baselineDecision, candidateDecision: patch.candidateDecision,
          adjudicationBaseline: patch.adjudicationBaseline, adjudicationCandidate: patch.adjudicationCandidate,
          note, reviewerId, updatedAt: stamp(),
        });
        if (!existing) judgments.push(row);
        comparison.revision += 1;
        comparison.updatedAt = stamp();
        return { comparison: publicComparison(comparison), judgment: publicJudgment(row) };
      });
    },

    async readEvalComparison({ workspaceId, comparisonId }) {
      const comparison = comparisons.find((row) => row.id === comparisonId && row.workspaceId === workspaceId);
      if (!comparison) return null;
      const version = versionOf(workspaceId, comparison.versionId);
      const baselineBatch = batches.find((row) => row.id === comparison.baselineBatchId);
      const candidateBatch = batches.find((row) => row.id === comparison.candidateBatchId);
      const built = buildComparison({
        version, acceptance: comparison.acceptance,
        baselinePredictions: predictions.filter((row) => row.batchId === baselineBatch.id),
        candidatePredictions: predictions.filter((row) => row.batchId === candidateBatch.id),
        judgments: judgments.filter((row) => row.comparisonId === comparisonId),
      });
      const snapshot = buildReportSnapshot({ version, baselineBatch, candidateBatch, comparison, built });
      return {
        comparison: publicComparison(comparison),
        version: publicVersion(version),
        baselineBatch: publicBatch(baselineBatch),
        candidateBatch: publicBatch(candidateBatch),
        built,
        snapshot,
        contentHash: snapshotHash(snapshot),
        judgments: judgments.filter((row) => row.comparisonId === comparisonId).map(publicJudgment),
      };
    },

    async approveEvalReport({ workspaceId, comparisonId, expectedRevision, contentHash, approvedBy }) {
      return locked(`comparison:${comparisonId}`, async () => {
        const comparison = comparisons.find((row) => row.id === comparisonId && row.workspaceId === workspaceId);
        if (!comparison) throw new StoreError('not_found');
        if (!Number.isInteger(expectedRevision) || comparison.revision !== expectedRevision) throw stale();
        const detail = await this.readEvalComparison({ workspaceId, comparisonId });
        if (detail.contentHash !== contentHash) throw stale('content');
        const existing = reports.find((row) => row.comparisonId === comparisonId && row.revision === comparison.revision);
        if (existing) {
          if (existing.contentHash === contentHash) return publicReport(existing);
          throw stale('content');
        }
        const report = {
          id: randomUUID(), workspaceId, comparisonId, revision: comparison.revision, snapshot: copy(detail.snapshot),
          contentHash, decision: detail.snapshot.decision.result, approvedBy, approvedAt: stamp(),
        };
        reports.push(report);
        auditPush(workspaceId, approvedBy, 'eval_report.approved', 'eval_report', report.id, { comparisonId, revision: report.revision, decision: report.decision });
        return publicReport(report);
      });
    },

    async getEvalReport({ workspaceId, reportId }) {
      const report = reports.find((row) => row.id === reportId && row.workspaceId === workspaceId);
      return report ? publicReport(report) : null;
    },

    async listEvalReports({ workspaceId, comparisonId = null, setId = null }) {
      return reports.filter((row) => row.workspaceId === workspaceId
        && (comparisonId == null || row.comparisonId === comparisonId)
        && (setId == null || comparisons.find((item) => item.id === row.comparisonId)?.setId === setId)).map(publicReport);
    },
  };
}
