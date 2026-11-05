import { totalsByBasis } from './capital.js';

/**
 * The read-only summary shown to invited /demo reviewers: actual records of one pinned synthetic workspace.
 *
 * Read boundary. The only workspace ever read is the one named by DEMO_WORKSPACE_ID (a UUID validated at startup).
 * Nothing a client sends selects a workspace, project or any other row. The workspace must also carry
 * profile.synthetic === true, strictly, at the time of the request; otherwise the overview is unavailable, and the
 * server never substitutes sample data.
 *
 * Projection. Every field below is named explicitly; no store row is spread into the response, so a new column can
 * never leak by default. Metrics are finite numbers a runner reported and are labelled so; an absent value is
 * omitted, never written as zero. Limited lists say what they count.
 */
export const JOB_LIMIT = 20;
export const ACTIVITY_LIMIT = 25;

export const UNAVAILABLE = {
  store_unavailable: 'This server has no database, so there are no records to show.',
  demo_unconfigured: 'The live overview is not configured on this server (DEMO_WORKSPACE_ID is unset).',
  demo_workspace_missing: 'The configured demo workspace was not found.',
  demo_workspace_not_synthetic: 'The configured workspace is not marked as a synthetic demo, so it is not shown.',
};

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const dig = (value, path) => path.reduce((v, key) => (v != null && typeof v === 'object' ? v[key] : undefined), value);

// Finite numbers a runner reported in a successful result, by job kind (src/lib/jobs.js RESULT_SCHEMAS). Nothing else
// from a result is shown: no hashes, locations, model names, sample prompts or sample answers.
const SCORES = { baseF1: ['evaluation', 'base', 'f1'], tunedF1: ['evaluation', 'tuned', 'f1'], baseExact: ['evaluation', 'base', 'exact'], tunedExact: ['evaluation', 'tuned', 'exact'], heldOutScored: ['evaluation', 'tuned', 'n'] };
export const METRIC_PATHS = {
  probe: { hostGpus: ['hostGpus'] },
  train: {
    trainExamples: ['trainExamples'], heldOutExamples: ['heldOutExamples'], steps: ['steps'], epochs: ['epochs'],
    baseHeldOutLoss: ['baseHeldOutLoss'], tunedHeldOutLoss: ['tunedHeldOutLoss'], trainSeconds: ['trainSeconds'], peakGpuMemoryMb: ['peakGpuMemoryMb'],
    ...SCORES,
  },
  evaluate: { ...SCORES },
  export: {
    ggufSizeBytes: ['gguf', 'sizeBytes'], loadTestConversations: ['loadTest', 'conversations'], loadTestSeconds: ['loadTest', 'seconds'],
    tunedTokensPerSec: ['loadTest', 'tuned', 'tokensPerSec'], baseTokensPerSec: ['loadTest', 'base', 'tokensPerSec'],
  },
};

function metricsOf(job) {
  const values = {};
  for (const [name, path] of Object.entries(METRIC_PATHS[job.kind] ?? {})) {
    const value = finite(dig(job.result, path));
    if (value !== undefined) values[name] = value;
  }
  return { provenance: 'runner_reported', values };
}

const REVIEW_STATUSES = ['pending', 'approved', 'changes_requested', 'withdrawn'];

async function projectsOf(store, workspaceId) {
  const rows = await store.listProjects(workspaceId);
  const out = [];
  for (const p of rows) {
    const where = { workspaceId, projectId: p.id };
    const [versions, reviews, sets] = await Promise.all([store.listDatasetVersions(where), store.listProjectReviews(where), store.listEvalSets(where)]);
    out.push({
      id: p.id,
      name: p.name,
      status: p.status,
      startingPoint: p.startingPoint,
      modalities: Array.isArray(p.modalities) ? p.modalities.filter((m) => typeof m === 'string') : [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      reviews: Object.fromEntries(REVIEW_STATUSES.map((status) => [status, reviews.filter((r) => r.status === status).length])),
      versions: versions.map((v) => ({
        number: v.number,
        files: Array.isArray(v.manifest?.files) ? v.manifest.files.length : null,
        annotations: Array.isArray(v.manifest?.annotations) ? v.manifest.annotations.length : null,
        createdAt: v.createdAt,
      })),
      evaluationSets: sets.map((s) => ({ id: s.id, name: s.name, status: s.status, purpose: s.purpose, caseCount: count(s.caseCount), revision: s.revision })),
    });
  }
  return out;
}

async function computeOf(store, workspaceId) {
  const [runners, jobs] = await Promise.all([
    store.listRunners(workspaceId),
    // A pure read: the ordinary job API settles expired leases first; a reviewer's read must not write anything.
    store.listJobs({ workspaceId, limit: JOB_LIMIT, settleLeases: false }),
  ]);
  return {
    runners: runners.map((r) => ({
      id: r.id, label: r.label, status: r.status, lastSeenAt: r.lastSeenAt, createdAt: r.createdAt,
      reportedGpus: Array.isArray(r.capabilities?.gpus) ? r.capabilities.gpus.length : null,
    })),
    jobs: {
      limit: JOB_LIMIT,
      basis: 'last_recorded',
      items: jobs.map((j) => ({
        id: j.id, kind: j.kind, status: j.status, attempt: j.attempt, maxAttempts: j.maxAttempts, failure: j.failure,
        createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, metrics: metricsOf(j),
      })),
    },
  };
}

// Approved reports only, from the frozen snapshot: the decision and its counts. No cases, answers, batch labels or
// system claims leave the store here.
async function evaluationOf(store, workspaceId) {
  const reports = await store.listEvalReports({ workspaceId });
  return {
    reports: reports.map((r) => ({
      id: r.id,
      setId: typeof r.snapshot?.set?.id === 'string' ? r.snapshot.set.id : null,
      setName: typeof r.snapshot?.set?.name === 'string' ? r.snapshot.set.name : null,
      setVersion: count(r.snapshot?.set?.number),
      decision: r.decision,
      revision: r.revision,
      approvedAt: r.approvedAt,
      passRate: finite(r.snapshot?.passRate) ?? null,
      denominator: typeof r.snapshot?.denominator === 'string' ? r.snapshot.denominator : null,
      counts: Object.fromEntries(['eligible', 'passes', 'fails', 'reviewed', 'unreviewed', 'insufficient'].map((key) => [key, count(r.snapshot?.counts?.[key])])),
    })),
  };
}

// Status and planning totals only. The title, purpose, company fields, evidence and credit records are the
// customer's draft and stay out; statuses end at Valcairn's internal review, so no lender state exists to show.
async function capitalOf(store, workspace) {
  if (workspace.kind !== 'organization') return { available: false, reason: 'organization_only', cases: [] };
  const cases = await store.listCapitalCases(workspace.id);
  return {
    available: true,
    cases: cases.map((c) => ({
      id: c.id, status: c.status, revision: c.revision, submittedRevision: c.submittedRevision,
      costItems: Array.isArray(c.draft?.costItems) ? c.draft.costItems.length : null,
      requestedAmountCents: count(c.draft?.requestedAmountCents),
      totals: totalsByBasis(c.draft?.costItems),
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    })),
  };
}

async function activityOf(store, workspaceId) {
  const rows = await store.listAudit(workspaceId, { limit: ACTIVITY_LIMIT });
  return { limit: ACTIVITY_LIMIT, items: rows.map((a) => ({ action: a.action, targetType: a.targetType, at: a.createdAt })) };
}

const SECTIONS = [
  ['projects', ['listProjects', 'listDatasetVersions', 'listProjectReviews', 'listEvalSets'], (store, workspace) => projectsOf(store, workspace.id)],
  ['compute', ['listRunners', 'listJobs'], (store, workspace) => computeOf(store, workspace.id)],
  ['evaluation', ['listEvalReports'], (store, workspace) => evaluationOf(store, workspace.id)],
  ['capital', ['listCapitalCases'], capitalOf],
  ['activity', ['listAudit'], (store, workspace) => activityOf(store, workspace.id)],
];

/**
 * `{ overview }` for the configured synthetic workspace, or `{ code }` naming why it is unavailable (see UNAVAILABLE).
 * A section whose store methods are missing is returned as `{ available: false }` rather than as empty data.
 */
export async function buildDemoOverview({ store, workspaceId }) {
  if (!store) return { code: 'store_unavailable' };
  if (!workspaceId) return { code: 'demo_unconfigured' };
  const workspace = await store.getWorkspace(workspaceId);
  if (!workspace) return { code: 'demo_workspace_missing' };
  if (workspace.profile?.synthetic !== true) return { code: 'demo_workspace_not_synthetic' };

  const overview = {
    generatedAt: new Date().toISOString(),
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, kind: workspace.kind, synthetic: true, createdAt: workspace.createdAt },
  };
  for (const [name, methods, build] of SECTIONS) {
    overview[name] = methods.every((m) => typeof store[m] === 'function') ? await build(store, workspace) : { available: false, reason: 'module_unavailable' };
  }
  return { overview };
}
