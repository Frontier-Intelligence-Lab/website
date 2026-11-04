// Capital: a cost plan, external credit records, a company financing request and the evidence package behind it.
// Money is US dollar integer cents. Every amount must already be a primitive safe integer inside the bounds below:
// nothing here coerces strings, rounds fractions or accepts floats. No provider prices, partners or lenders are built in.

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export const MAX_AMOUNT_CENTS = 1_000_000_000_000; // $10 billion; forty items summed stay far inside Number.MAX_SAFE_INTEGER
export const MAX_COST_ITEMS = 40;
export const MAX_REFERENCES = 20;
export const MAX_LINKS = 20;
export const COST_CATEGORIES = ['compute', 'deployment', 'storage', 'equipment'];
export const COST_PERIODS = ['one_time', 'monthly', 'annual'];
export const COST_BASES = ['quoted', 'estimated', 'incurred'];
export const CREDIT_STATUSES = ['claimed', 'evidenced', 'withdrawn'];
export const EVIDENCE_KINDS = ['cost_assumption', 'credit_restriction', 'dataset_provenance', 'model_provenance', 'local_benchmark', 'company_record'];
export const REFERENCE_KINDS = ['incorporation', 'bank_statement', 'tax_filing', 'contract', 'other'];
export const CASE_STATUSES = ['draft', 'submitted', 'changes_requested', 'evidence_reviewed'];
// A case can be edited unless Valcairn staff are looking at its submitted revision right now.
export const EDITABLE_CASE_STATUSES = ['draft', 'changes_requested', 'evidence_reviewed'];
export const CASE_DECISIONS = ['changes_requested', 'evidence_reviewed'];
// Shown as the stages after Valcairn's internal review. None of them exists in the product yet.
export const LENDER_STAGES = [['offer', 'Lender offer'], ['approved', 'Approved'], ['funded', 'Funded']];
export const AMOUNT_MESSAGE = `Amounts are whole US cents, from 0 to ${MAX_AMOUNT_CENTS.toLocaleString('en-US')}.`;

export const isCents = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_CENTS;
const isDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const intIn = (value, min, max) => (Number.isSafeInteger(value) && value >= min && value <= max ? value : null);

/** "1,234.56" or "$80" to cents, by string parsing only: digits, optional thousands commas, at most two decimals. */
export function parseUsd(input) {
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(typeof input === 'string' ? input.trim() : '');
  if (!match) return null;
  const whole = Number(match[1].replaceAll(',', ''));
  const value = whole * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return isCents(value) ? value : null;
}

/** Cents to "$1,234.56" with integer arithmetic only. */
export function formatUsd(value) {
  if (!isCents(value)) return '—';
  return `$${Math.trunc(value / 100).toLocaleString('en-US')}.${String(value % 100).padStart(2, '0')}`;
}

/** Sum of cents, or null when any value is not cents or the total would leave the safe-integer range. */
export function sumCents(values) {
  let total = 0;
  for (const value of values) {
    if (!isCents(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * Totals by basis and by period: quoted, estimated and incurred are never added together, and neither are one-time,
 * monthly and annual amounts (no planning horizon is invented here). `{ estimated: { one_time, monthly, annual }, ... }`.
 */
export function totalsByBasis(items) {
  const list = Array.isArray(items) ? items : [];
  return Object.fromEntries(COST_BASES.map((basis) => [basis, Object.fromEntries(COST_PERIODS.map((period) => [period, sumCents(list.filter((i) => i?.basis === basis && i?.period === period).map((i) => i?.amountCents))]))]));
}

/**
 * Every reference a draft makes must exist at the moment it is saved or frozen: incurred items cite evidence of the
 * case, dataset versions are frozen versions of the workspace. Stores call this under the case lock.
 */
export function referencesResolve(draft, { evidenceIds, versions }) {
  const items = Array.isArray(draft?.costItems) ? draft.costItems : [];
  const links = Array.isArray(draft?.datasetVersions) ? draft.datasetVersions : [];
  return items.every((i) => i.basis !== 'incurred' || evidenceIds.has(i.evidenceId))
    && links.every((l) => versions.some((v) => v.projectId === l.projectId && v.version === l.version));
}

export const citedEvidenceIds = (draft) => new Set((Array.isArray(draft?.costItems) ? draft.costItems : []).map((i) => i.evidenceId).filter(Boolean));

/** One amount field: absent means not set; anything else must be cents. */
function amountField(value, errors, key, { min = 0 } = {}) {
  if (value == null) return null;
  if (!isCents(value) || value < min) { errors[key] = AMOUNT_MESSAGE; return null; }
  return value;
}

function costItem(raw, index, evidenceIds, errors, newId) {
  const i = raw && typeof raw === 'object' ? raw : {};
  const where = `Cost item ${index + 1}`;
  const label = text(i.label, 120);
  if (!label) errors.costItems ??= `${where}: give it a name.`;
  if (!COST_CATEGORIES.includes(i.category)) errors.costItems ??= `${where}: choose compute, deployment, storage or equipment.`;
  if (!COST_PERIODS.includes(i.period)) errors.costItems ??= `${where}: choose one-time, monthly or annual.`;
  if (!COST_BASES.includes(i.basis)) errors.costItems ??= `${where}: mark it quoted, estimated or incurred.`;
  if (!isCents(i.amountCents)) errors.costItems ??= `${where}: ${AMOUNT_MESSAGE}`;
  const source = text(i.source, 200);
  if (!source) errors.costItems ??= `${where}: say where the figure comes from.`;
  if (!isDay(i.observedAt)) errors.costItems ??= `${where}: the observation date must be a calendar day (YYYY-MM-DD).`;
  const evidenceId = typeof i.evidenceId === 'string' && evidenceIds.has(i.evidenceId) ? i.evidenceId : null;
  // An incurred cost is money already spent: it must cite a real evidence record of this case, never a typed-in figure alone.
  if (i.basis === 'incurred' && !evidenceId) errors.costItems ??= `${where}: an incurred cost must cite an evidence record.`;
  const id = typeof i.id === 'string' && ID.test(i.id) ? i.id : newId();
  return { id, category: i.category, label, amountCents: i.amountCents, period: i.period, basis: i.basis, source, observedAt: i.observedAt, evidenceId: i.basis === 'incurred' ? evidenceId : null };
}

/**
 * The editable draft of a case: cost items, the request, company information, supporting references and links to
 * frozen dataset versions of the same workspace. `versions` are those versions as [{ projectId, version }];
 * `evidenceIds` the ids of this case's evidence records. A draft may be incomplete; `forSubmit` checks what a
 * submission needs. Returns { values } or { errors }.
 */
export function validateCapitalDraft(raw, { versions = [], evidenceIds = new Set(), forSubmit = false, newId = defaultId } = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const purpose = text(body.purpose, 2000);
  const requestedAmountCents = amountField(body.requestedAmountCents, errors, 'requestedAmountCents', { min: 1 });
  const t = body.timing && typeof body.timing === 'object' ? body.timing : {};
  const timing = { neededBy: isDay(t.neededBy) ? t.neededBy : null, termMonths: intIn(t.termMonths, 1, 120) };
  if (t.neededBy != null && !timing.neededBy) errors.timing = 'The date needed must be a calendar day (YYYY-MM-DD).';
  if (t.termMonths != null && timing.termMonths == null) errors.timing = 'The term is a whole number of months, 1 to 120.';
  const c = body.company && typeof body.company === 'object' ? body.company : {};
  const company = {
    legalName: text(c.legalName, 160), registrationRef: text(c.registrationRef, 80), country: text(c.country, 80),
    foundedYear: intIn(c.foundedYear, 1800, new Date().getUTCFullYear() + 1), employees: intIn(c.employees, 0, 10_000_000),
    website: text(c.website, 200), description: text(c.description, 1000),
  };
  if (c.foundedYear != null && company.foundedYear == null) errors.company = 'The founding year must be a four-digit year.';
  if (c.employees != null && company.employees == null) errors.company = 'Employees is a whole number.';

  const rawItems = Array.isArray(body.costItems) ? body.costItems : [];
  if (rawItems.length > MAX_COST_ITEMS) errors.costItems = `At most ${MAX_COST_ITEMS} cost items.`;
  const costItems = rawItems.slice(0, MAX_COST_ITEMS).map((item, index) => costItem(item, index, evidenceIds, errors, newId));
  if (new Set(costItems.map((i) => i.id)).size !== costItems.length) errors.costItems ??= 'Two cost items share an id.';

  const rawRefs = Array.isArray(body.references) ? body.references : [];
  if (rawRefs.length > MAX_REFERENCES) errors.references = `At most ${MAX_REFERENCES} supporting references.`;
  const references = rawRefs.slice(0, MAX_REFERENCES).map((r, index) => {
    const ref = r && typeof r === 'object' ? r : {};
    const title = text(ref.title, 120);
    if (!title || !REFERENCE_KINDS.includes(ref.kind)) errors.references ??= `Reference ${index + 1}: give it a title and a kind.`;
    return { id: typeof ref.id === 'string' && ID.test(ref.id) ? ref.id : newId(), kind: ref.kind, title, source: text(ref.source, 300) };
  });

  const rawLinks = Array.isArray(body.datasetVersions) ? body.datasetVersions : [];
  if (rawLinks.length > MAX_LINKS) errors.datasetVersions = `At most ${MAX_LINKS} dataset versions.`;
  const datasetVersions = [];
  for (const link of rawLinks.slice(0, MAX_LINKS)) {
    const match = versions.find((v) => v.projectId === link?.projectId && v.version === link?.version);
    if (!match) { errors.datasetVersions = 'Only frozen dataset versions of this workspace can be linked.'; break; }
    if (!datasetVersions.some((d) => d.projectId === match.projectId && d.version === match.version)) datasetVersions.push({ projectId: match.projectId, version: match.version });
  }

  if (forSubmit) {
    if (!purpose) errors.purpose ??= 'Say what the financing is for.';
    if (requestedAmountCents == null) errors.requestedAmountCents ??= 'Enter the amount you are requesting.';
    if (!company.legalName) errors.company ??= 'Enter the company’s legal name.';
    if (!costItems.length) errors.costItems ??= 'Add at least one cost item to the plan.';
  }
  return Object.keys(errors).length ? { errors } : { values: { purpose, requestedAmountCents, timing, company, costItems, references, datasetVersions } };
}

let counter = 0;
function defaultId() { return `ci_${Date.now().toString(36)}${(counter++).toString(36)}`; }

/** Title and optional same-workspace project and enhance-run links of a case. */
export function validateCaseFields(raw, { projects = [], runs = [] } = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const title = text(body.title, 120) || 'Capital plan';
  const projectId = body.projectId == null ? null : projects.some((p) => p.id === body.projectId) ? body.projectId : undefined;
  if (projectId === undefined) errors.projectId = 'Choose a project of this workspace.';
  const enhanceRunId = body.enhanceRunId == null ? null : runs.some((r) => r.id === body.enhanceRunId) ? body.enhanceRunId : undefined;
  if (enhanceRunId === undefined) errors.enhanceRunId = 'Choose an enhance run of this workspace.';
  return Object.keys(errors).length ? { errors } : { values: { title, projectId, enhanceRunId } };
}

/** The draft the store holds for a case with nothing filled in yet. */
export const emptyDraft = () => ({ purpose: '', requestedAmountCents: null, timing: { neededBy: null, termMonths: null }, company: { legalName: '', registrationRef: '', country: '', foundedYear: null, employees: null, website: '', description: '' }, costItems: [], references: [], datasetVersions: [] });

/** A submission needs a purpose, an amount and at least one cost item. Stores check this under the case lock. */
export const draftComplete = (draft) => Boolean(draft && text(draft.purpose, 1) && isCents(draft.requestedAmountCents) && draft.requestedAmountCents >= 1 && Array.isArray(draft.costItems) && draft.costItems.length > 0);

/** What a submission freezes: the case's draft and links, its totals, the current credit records and its evidence, as of now. */
export function capitalSnapshot(kase, credits, evidence) {
  return {
    title: kase.title, projectId: kase.projectId, enhanceRunId: kase.enhanceRunId, draft: structuredClone(kase.draft), totals: totalsByBasis(kase.draft.costItems),
    credits: credits.filter((c) => !c.supersededBy).map(({ id, provider, status, amountCents, expiresOn, restrictions, reference }) => ({ id, provider, status, amountCents, expiresOn, restrictions, reference })),
    evidence: evidence.map(({ id, kind, title, source, reference, verification }) => ({ id, kind, title, source, reference: structuredClone(reference), verification })),
  };
}

/**
 * An external credit record as the customer states it. "Evidenced" needs the provider's reference; nothing here
 * makes the amount a balance Valcairn holds or can spend.
 */
export function validateCreditRecord(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const provider = text(body.provider, 80);
  if (!provider) errors.provider = 'Name the provider.';
  const status = CREDIT_STATUSES.includes(body.status) ? body.status : null;
  if (!status) errors.status = 'Mark the credit claimed, evidenced or withdrawn.';
  if (!isCents(body.amountCents)) errors.amountCents = AMOUNT_MESSAGE;
  const expiresOn = body.expiresOn == null ? null : isDay(body.expiresOn) ? body.expiresOn : undefined;
  if (expiresOn === undefined) errors.expiresOn = 'The expiry must be a calendar day (YYYY-MM-DD).';
  const reference = text(body.reference, 200);
  if (status === 'evidenced' && !reference) errors.reference = 'An evidenced credit needs the provider’s confirmation reference.';
  if (Object.keys(errors).length) return { errors };
  return { values: { provider, status, amountCents: body.amountCents, expiresOn, restrictions: text(body.restrictions, 1000), reference } };
}

/**
 * One evidence record: a bounded reference to something that already exists, with the facts copied from it so the
 * record stays stable. `versions`, `runs`, `benchmarks` and `credits` are what this person may cite: frozen dataset
 * versions and enhance plans of the workspace, measured runs on their own devices, and current credit records.
 */
export function validateEvidence(raw, { versions = [], runs = [], benchmarks = [], credits = [] } = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const kind = EVIDENCE_KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) errors.kind = 'Choose what this evidence is.';
  const title = text(body.title, 120);
  if (!title) errors.title = 'Give the record a title.';
  const source = text(body.source, 300);
  const ref = body.reference && typeof body.reference === 'object' ? body.reference : {};
  let reference = {};
  let verification = 'unverified';
  if (kind === 'dataset_provenance') {
    const v = versions.find((x) => x.projectId === ref.projectId && x.version === ref.version);
    if (!v) errors.reference = 'Choose a frozen dataset version of this workspace.';
    else reference = { projectId: v.projectId, projectName: v.projectName, version: v.version, reviewId: v.reviewId ?? null, files: v.files, createdAt: v.createdAt };
  } else if (kind === 'model_provenance') {
    const r = runs.find((x) => x.id === ref.enhanceRunId);
    if (!r) errors.reference = 'Choose an enhance run of this workspace.';
    else reference = { enhanceRunId: r.id, name: r.name, baseModelId: r.baseModelId, status: r.status, requestedAt: r.requestedAt ?? null };
  } else if (kind === 'local_benchmark') {
    const b = benchmarks.find((x) => x.deviceId === ref.deviceId && x.runId === ref.runId);
    if (!b) errors.reference = 'Choose a run measured on one of your own devices.';
    else { reference = { ...b, provenance: 'client_reported' }; verification = 'client_reported'; }
  } else if (kind === 'credit_restriction') {
    const c = credits.find((x) => x.id === ref.creditRecordId);
    if (!c) errors.reference = 'Choose a current credit record.';
    else reference = { creditRecordId: c.id, provider: c.provider, status: c.status, restrictions: c.restrictions, expiresOn: c.expiresOn };
  } else if (kind && !source) errors.source = 'Say where this record lives (a document name, reference or link). Uploading it here is planned.';
  if (Object.keys(errors).length) return { errors };
  return { values: { kind, title, source, reference, verification } };
}

const STATEMENTS = [
  'Amounts are US dollar cents exactly as the customer entered them; Valcairn did not price or verify them.',
  'Quoted, estimated and incurred costs are recorded and totalled separately, and so are one-time, monthly and annual amounts. No planning horizon is applied. Every incurred cost cites an evidence record of this case.',
  'Credit records are provider claims recorded by the customer. They are not a Valcairn balance, cannot be spent through Valcairn, and nothing was issued or consumed.',
  'Local benchmark records were reported by the customer’s own browser and runtime; Valcairn did not measure them.',
  'When the basis is a sent revision, "content" is that frozen revision exactly as sent; "review" holds Valcairn staff annotations made afterwards on that revision. A reviewed mark means staff looked at the referenced record. It is not verified revenue, a credit decision, lender eligibility or an offer of financing.',
  'Nothing in this package was sent to a bank, lender or provider by Valcairn. The customer chose to export it.',
];
export const PLANNED = ['document_upload', 'provider_decisions', 'lender_offer', 'funding', 'reservations', 'reconciliation'];

const contentOf = (snapshot) => {
  const { costItems, datasetVersions, ...request } = snapshot.draft;
  return { title: snapshot.title, projectId: snapshot.projectId, enhanceRunId: snapshot.enhanceRunId, plan: { costItems, totals: snapshot.totals, datasetVersions }, request, credits: snapshot.credits, evidence: snapshot.evidence };
};

/**
 * The export. With a sent revision, `content` is its frozen snapshot, untouched, and `review` the staff decision and
 * marks made on that revision afterwards. Without one, `content` is the live draft with the current evidence and
 * credit records, and says so (`basis: 'draft'`). `asOf` tells how the live case relates to what is exported.
 */
export function buildEvidencePackage({ workspace, kase, submission, marks = [], evidence, credits, exportedBy, exportedAt }) {
  const frozen = Boolean(submission);
  const content = frozen ? contentOf(submission.snapshot) : contentOf(capitalSnapshot(kase, credits, evidence));
  return {
    format: 'valcairn.capital-evidence/2',
    exportedAt,
    exportedBy: { id: exportedBy.id, name: exportedBy.name },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, synthetic: Boolean(workspace.profile?.synthetic) },
    basis: frozen ? 'submitted_revision' : 'draft',
    submission: frozen ? { id: submission.id, revision: submission.revision, submittedAt: submission.submittedAt, contentHash: submission.contentHash } : null,
    content,
    review: frozen ? { decision: submission.decision, decidedAt: submission.decidedAt, notes: submission.notes, marks: marks.filter((m) => m.submissionId === submission.id).map(({ evidenceId, createdAt }) => ({ evidenceId, reviewedAt: createdAt })) } : null,
    asOf: { caseId: kase.id, caseStatus: kase.status, caseRevision: kase.revision, submittedRevision: kase.submittedRevision, draftChangedSinceSent: frozen && kase.revision !== submission.revision },
    statements: STATEMENTS,
    planned: PLANNED,
  };
}
