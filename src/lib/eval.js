// Evaluation cases, quality checks, imported-prediction scoring and acceptance.
// Pure functions: both stores and the routes use these, and the browser may import
// the constants. Nothing here calls a model, a network or a database.

import { StoreError } from '../store/errors.js';

export const MAX_CASES = 200;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_LINE_BYTES = 16 * 1024;
export const MAX_SOURCES = 8;
export const SCORER_ID = 'normalized-exact-v1';
export const RUBRIC_VERSION = 'rubric-v1';
export const PURPOSES = ['development', 'final_assessment'];
export const SEVERITIES = ['critical', 'major', 'minor'];
export const PREDICTION_STATUSES = ['answered', 'abstained', 'error'];
export const DECISIONS = ['pass', 'fail', 'insufficient'];
export const SCORE_BASES = ['human_else_auto', 'human_only', 'auto_exact'];
export const ADJUDICATIONS = ['human', 'automatic'];

export const NORMALIZATION = [
  'Apply Unicode NFKC.',
  'Trim the ends.',
  'Collapse every run of whitespace, including line breaks, to a single space.',
  'If the whole value is wrapped in one pair of straight single or double quotes, remove that one pair.',
  'Lowercase with toLowerCase (not a language-specific case fold).',
];

export const LIMITATIONS = [
  'Imported predictions are customer-supplied results. A batch does not prove which model ran, or its latency, cost, configuration or training-data separation.',
  'Normalized exact match compares strings after the documented normalization. It is not semantic correctness. Token overlap is a diagnostic and never a pass or a fail.',
  'The labels development and final assessment identify how the team uses the set. Neither label means the set is secret, leakage-free or representative of future traffic.',
  'Counts use every eligible case in the frozen set as the denominator. They describe this set only.',
  'This report is not a certification and does not say the assistant is safe for production.',
];

export const PLANNED = [
  'Semantic near-duplicate detection',
  'Automatic verification that a source document is true',
  'A guarantee that personal data has been removed',
  'Proof that the case set covers future questions',
  'Calling a model endpoint, running an uploaded scorer, or starting a training job',
];

const CASE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const RUBRIC = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const bad = (message, details) => Object.assign(new StoreError('invalid_import', message), details ? { details } : {});
const byteLength = (value) => new TextEncoder().encode(value).length;
// Stable short id for a finding that must fit an issue-note key. Not a security hash.
const foldKey = (prefix, value) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${prefix}:${(hash >>> 0).toString(16)}`;
};

/** Documented normalization for duplicate detection and exact comparison. Not semantic equivalence. */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  let out = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (out.length >= 2) {
    const q = out[0];
    if ((q === '"' || q === "'") && out.at(-1) === q) out = out.slice(1, -1).trim();
  }
  return out.toLowerCase();
}

export function tokenOverlap(a, b) {
  const left = new Set(normalizeText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function unitInterval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10000) / 10000;
  if (rounded < 0 || rounded > 1) return null;
  // JSON numbers must match the migration's plain decimal check (no exponent).
  if (!/^(0|1|0?\.[0-9]{1,4}|1\.0{1,4})$/.test(String(rounded))) return null;
  return rounded;
}

export function defaultAcceptance() {
  return {
    version: 1,
    scoreBasis: 'human_else_auto',
    minPassRate: 0.9,
    minCoverage: 1,
    criticalMustPass: true,
    requireHumanOnCritical: true,
    requireHumanOnDisagreement: true,
    requireHumanWhenNoExpectedAnswer: true,
  };
}

/** A structured acceptance rule. Prose, including project.success, is never executed. */
export function validateAcceptance(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rule = {
    version: 1,
    scoreBasis: SCORE_BASES.includes(body.scoreBasis) ? body.scoreBasis : null,
    minPassRate: unitInterval(body.minPassRate),
    minCoverage: unitInterval(body.minCoverage),
    criticalMustPass: body.criticalMustPass === true,
    requireHumanOnCritical: body.requireHumanOnCritical === true,
    requireHumanOnDisagreement: body.requireHumanOnDisagreement !== false,
    requireHumanWhenNoExpectedAnswer: body.requireHumanWhenNoExpectedAnswer !== false,
  };
  if (!rule.scoreBasis) return { error: 'Choose how a case is scored: human review, normalized exact match, or human review with exact match only where nobody has reviewed.' };
  if (rule.minPassRate == null) return { error: 'Set the pass rate between 0 and 1. It is applied to every eligible case, not only the ones that returned an answer.' };
  if (rule.minCoverage == null) return { error: 'Set the required coverage between 0 and 1. Missing and unreviewed cases stay in the denominator.' };
  return { rule };
}

export function validateRubricVersion(value) {
  const rubric = text(value, 40);
  if (!RUBRIC.test(rubric)) return { error: 'Use a rubric version such as rubric-v1 (letters, numbers, dots, dashes).' };
  return { rubric };
}

function optionalText(value, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

function sourceRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.toLowerCase() : '';
  const versionId = typeof raw.versionId === 'string' ? raw.versionId.toLowerCase() : '';
  const fileId = raw.fileId == null || raw.fileId === '' ? null : String(raw.fileId).toLowerCase();
  if (!UUID.test(projectId) || !UUID.test(versionId)) return null;
  if (fileId != null && !UUID.test(fileId)) return null;
  return { projectId, versionId, fileId };
}

/** One case in stored form, or an invalid_import error. */
export function validateCase(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const caseKey = typeof body.id === 'string' ? body.id.trim() : typeof body.caseKey === 'string' ? body.caseKey.trim() : '';
  const input = typeof body.input === 'string' ? body.input.trim() : '';
  const expectedAnswer = optionalText(body.expectedAnswer, 4000);
  const reviewCriteria = optionalText(body.reviewCriteria, 2000);
  const category = optionalText(body.category, 80);
  const severity = body.severity == null || body.severity === '' ? null : body.severity;
  const sources = body.sources ?? body.sourceRefs ?? [];
  if (!CASE_KEY.test(caseKey)) return { error: 'A case id must start with a letter or number and use only letters, numbers, dots, underscores, colons and dashes (80 characters at most).' };
  if (!input || input.length > 4000) return { error: `Case ${caseKey} needs a question or input of at most 4000 characters.` };
  if (expectedAnswer === undefined) return { error: `Case ${caseKey} has an expected answer that is not text of at most 4000 characters.` };
  if (reviewCriteria === undefined) return { error: `Case ${caseKey} has review criteria that are not text of at most 2000 characters.` };
  if (category === undefined) return { error: `Case ${caseKey} has a category that is not text of at most 80 characters.` };
  if (severity != null && !SEVERITIES.includes(severity)) return { error: `Case ${caseKey} has a severity that is not critical, major or minor.` };
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) return { error: `Case ${caseKey} may cite at most ${MAX_SOURCES} source versions.` };
  const sourceRefs = [];
  for (const source of sources) {
    const ref = sourceRef(source);
    if (!ref) return { error: `Case ${caseKey} has a source that is not a project id, a dataset version id and an optional file id.` };
    sourceRefs.push(ref);
  }
  return { case: { caseKey, input, expectedAnswer, reviewCriteria, category, severity, sourceRefs } };
}

function parseJsonl(jsonl, { maxRows, mapLine }) {
  if (typeof jsonl !== 'string') throw bad('Send the import as UTF-8 JSONL text.');
  const bytes = byteLength(jsonl);
  if (bytes > MAX_IMPORT_BYTES) throw bad(`The import is ${bytes} bytes. The limit is ${MAX_IMPORT_BYTES} bytes, and nothing was saved.`);
  const lines = jsonl.split(/\r?\n/);
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (byteLength(line) > MAX_LINE_BYTES) throw bad(`Line ${i + 1} is longer than ${MAX_LINE_BYTES} bytes. Nothing was saved.`, { line: i + 1 });
    if (rows.length >= maxRows) throw bad(`An import can contain at most ${maxRows} rows. Nothing was saved.`);
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { throw bad(`Line ${i + 1} is not a JSON object. Nothing was saved.`, { line: i + 1 }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad(`Line ${i + 1} is not a JSON object. Nothing was saved.`, { line: i + 1 });
    const row = mapLine(parsed, i + 1);
    if (seen.has(row.caseKey)) throw bad(`Line ${i + 1} repeats case id ${row.caseKey}. Nothing was saved.`, { line: i + 1, caseKey: row.caseKey });
    seen.add(row.caseKey);
    rows.push(row);
  }
  if (!rows.length) throw bad('The import has no rows. Nothing was saved.');
  return rows;
}

export function parseCaseJsonl(jsonl) {
  return parseJsonl(jsonl, {
    maxRows: MAX_CASES,
    mapLine(parsed, line) {
      const { case: row, error } = validateCase(parsed);
      if (error) throw bad(`Line ${line}: ${error} Nothing was saved.`, { line });
      return row;
    },
  });
}

export function parsePredictionJsonl(jsonl, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys);
  return parseJsonl(jsonl, {
    maxRows: MAX_CASES,
    mapLine(parsed, line) {
      const caseKey = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      const status = parsed.status;
      if (!CASE_KEY.test(caseKey)) throw bad(`Line ${line} has no usable case id. Nothing was saved.`, { line });
      if (!known.has(caseKey)) throw bad(`Line ${line} cites ${caseKey}, which is not in this frozen evaluation set. Nothing was saved.`, { line, caseKey });
      if (!PREDICTION_STATUSES.includes(status)) throw bad(`Line ${line} (${caseKey}) needs a status of answered, abstained or error. Nothing was saved.`, { line, caseKey });
      const output = parsed.output;
      const error = parsed.error;
      if (status === 'answered') {
        if (typeof output !== 'string' || output.trim() === '' || output.length > 8000) {
          throw bad(`Line ${line} (${caseKey}) is answered but has no answer text. An empty answer was not stored as a success.`, { line, caseKey });
        }
        if (error != null && error !== '') throw bad(`Line ${line} (${caseKey}) is answered and also has an error. Nothing was saved.`, { line, caseKey });
        return { caseKey, status, output, error: null };
      }
      if (typeof output === 'string' && output.trim() !== '') {
        throw bad(`Line ${line} (${caseKey}) is ${status} but also includes answer text. That text was not dropped and the row was not saved.`, { line, caseKey });
      }
      if (output != null && typeof output !== 'string') throw bad(`Line ${line} (${caseKey}) has an output that is not text. Nothing was saved.`, { line, caseKey });
      if (status === 'error') {
        if (typeof error !== 'string' || !ERROR_CODE.test(error)) throw bad(`Line ${line} (${caseKey}) is an error and needs an error code such as timeout. Nothing was saved.`, { line, caseKey });
        return { caseKey, status, output: null, error };
      }
      if (error != null && error !== '') throw bad(`Line ${line} (${caseKey}) is abstained and also has an error. Nothing was saved.`, { line, caseKey });
      return { caseKey, status, output: null, error: null };
    },
  });
}

/**
 * Wilson score interval at 95% for decisive pass/fail cases only.
 * Returns null when fewer than two decisive cases exist. The assumptions travel with the numbers.
 */
export function wilson95(successes, n) {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 2 || successes < 0 || successes > n) return null;
  const z = 1.959963984540054;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    method: 'wilson',
    level: 0.95,
    successes,
    n,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    assumptions: [
      'Each decisive case is treated as an independent Bernoulli trial with one shared unknown pass rate.',
      'Only cases whose outcome is a decisive pass or fail are in n. Missing, errored, abstained, unreviewed, disagreed and insufficient cases are outside this interval and stay inside the eligible denominator of the decision.',
      'A small, curated or synthetic set does not meet that assumption for future traffic. The interval is not a forecast of production questions.',
    ],
  };
}

function catalogOf(sources) {
  const byId = new Map();
  for (const source of sources ?? []) {
    byId.set(source.versionId, {
      ...source,
      fileIds: source.fileIds instanceof Set ? source.fileIds : new Set(source.fileIds ?? []),
    });
  }
  return byId;
}

/**
 * Quality findings for a draft. Nothing here rewrites a case.
 * `sources` is the workspace catalog of frozen dataset versions: { versionId, projectId, number, testing, fileIds }.
 * Same-context means the same normalized input. A shared source file with a different question is not guessed at.
 */
export function computeEvalIssues({ cases, notes = [], sources = [] }) {
  const catalog = catalogOf(sources);
  const noted = new Set(notes.map((n) => n.key));
  const issues = [];
  const add = (issue) => issues.push({ ...issue, note: notes.find((n) => n.key === issue.key)?.note ?? null });

  for (const row of cases) {
    if (!row.expectedAnswer && !row.reviewCriteria) {
      add({
        key: `case:${row.caseKey}:expectation`, group: 'expectation', blocking: true, acknowledgeable: false,
        caseKeys: [row.caseKey], title: `${row.caseKey} has no expected answer or review criteria`,
        detail: 'Add the answer a reviewer should see, or write the criteria a person will judge against. The case is not deleted for you.',
        fix: { label: 'Edit this case', action: 'edit-case', caseKey: row.caseKey },
      });
    }
    if (!row.sourceRefs?.length) {
      add({
        key: `case:${row.caseKey}:sources`, group: 'sources', blocking: true, acknowledgeable: false,
        caseKeys: [row.caseKey], title: `${row.caseKey} cites no source version`,
        detail: 'Cite a frozen dataset version in this workspace. The current editable files of a project are not a source.',
        fix: { label: 'Add a source', action: 'edit-case', caseKey: row.caseKey },
      });
    }
    row.sourceRefs?.forEach((ref, index) => {
      const found = catalog.get(ref.versionId);
      let problem = null;
      if (!found || found.projectId !== ref.projectId) problem = 'That dataset version is not in this workspace, or it belongs to a different project than the one cited.';
      else if (!found.testing) problem = 'That frozen version does not permit testing. Training-only rights are not reused here.';
      else if (ref.fileId && !found.fileIds.has(ref.fileId)) problem = 'That file is not in the frozen version. A file added later, or the live working set, does not count.';
      if (!problem) return;
      add({
        key: `case:${row.caseKey}:source:${index}`, group: 'sources', blocking: true, acknowledgeable: false,
        caseKeys: [row.caseKey], title: `${row.caseKey} cites a source that cannot be used`,
        detail: problem, fix: { label: 'Replace the source', action: 'edit-case', caseKey: row.caseKey },
      });
    });
  }

  const groups = new Map();
  for (const row of cases) {
    const key = normalizeText(row.input);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [norm, group] of groups) {
    if (group.length < 2) continue;
    const answers = new Set(group.map((row) => (row.expectedAnswer == null ? '\u0000' : normalizeText(row.expectedAnswer))));
    const caseKeys = group.map((row) => row.caseKey);
    if (answers.size > 1) {
      const key = foldKey('conflict', norm);
      add({
        key, group: 'conflict', blocking: true, acknowledgeable: true, caseKeys,
        title: 'Suspected conflict for human review',
        detail: `${caseKeys.join(', ')} use the same normalized question and different expected answers. This is a review finding, not a proven factual error. Nothing was changed. Acknowledge it if both cases should stay, or edit one of them.`,
        fix: { label: 'Review the cases', action: 'edit-case', caseKey: caseKeys[0] },
      });
    } else {
      add({
        key: foldKey('duplicate', norm), group: 'duplicate', blocking: true, acknowledgeable: false, caseKeys,
        title: 'Exact duplicate questions',
        detail: `${caseKeys.join(', ')} normalize to the same question and the same expected answer. Duplicates are not removed automatically. Edit or delete one before freezing.`,
        fix: { label: 'Edit a duplicate', action: 'edit-case', caseKey: caseKeys[0] },
      });
    }
  }

  const withOpen = issues.map((issue) => ({ ...issue, open: issue.blocking && !(issue.acknowledgeable && noted.has(issue.key)) }));
  return withOpen;
}

export function evalCounts(cases) {
  const severities = { critical: 0, major: 0, minor: 0, unset: 0 };
  const byCategory = new Map();
  for (const row of cases) {
    const severity = row.severity ?? 'unset';
    severities[severity] += 1;
    const category = row.category ?? '(none)';
    const bucket = byCategory.get(category) ?? { category, cases: 0, critical: 0, major: 0, minor: 0, unset: 0 };
    bucket.cases += 1;
    bucket[severity] += 1;
    byCategory.set(category, bucket);
  }
  return { cases: cases.length, severities, categories: [...byCategory.values()] };
}

export function scoreSide(expectedAnswer, prediction) {
  const hasExpected = typeof expectedAnswer === 'string' && expectedAnswer.trim() !== '';
  if (!hasExpected) {
    return { applicable: false, result: 'not_applicable', exact: null, tokenOverlap: null, status: prediction?.status ?? 'missing', error: prediction?.error ?? null };
  }
  if (!prediction) return { applicable: true, result: 'missing', exact: null, tokenOverlap: null, status: 'missing', error: null };
  if (prediction.status === 'error') return { applicable: true, result: 'error', exact: null, tokenOverlap: null, status: 'error', error: prediction.error ?? null };
  if (prediction.status === 'abstained') return { applicable: true, result: 'abstained', exact: null, tokenOverlap: null, status: 'abstained', error: null };
  const exact = normalizeText(prediction.output) === normalizeText(expectedAnswer);
  return {
    applicable: true, result: exact ? 'pass' : 'fail', exact, tokenOverlap: tokenOverlap(prediction.output, expectedAnswer),
    status: 'answered', error: null,
  };
}

export function disagrees(autoResult, humanDecision) {
  if (!humanDecision) return false;
  if (autoResult === 'pass' || autoResult === 'fail') return humanDecision !== autoResult;
  if (autoResult === 'not_applicable' && humanDecision === 'insufficient') return false;
  return humanDecision === 'pass' || humanDecision === 'fail';
}

/**
 * One side's outcome. Automatic and human results stay separate; a disagreement stays
 * `disagreement` until an adjudication names which one the decision uses.
 */
export function resolveOutcome({ auto, humanDecision, adjudication, acceptance }) {
  const conflict = disagrees(auto.result, humanDecision);
  if (conflict && adjudication === 'human' && humanDecision) return { outcome: humanDecision, disagreement: true, adjudicated: 'human' };
  if (conflict && adjudication === 'automatic' && (auto.result === 'pass' || auto.result === 'fail')) return { outcome: auto.result, disagreement: true, adjudicated: 'automatic' };
  if (conflict && acceptance.requireHumanOnDisagreement) return { outcome: 'disagreement', disagreement: true, adjudicated: null };
  if (conflict && acceptance.scoreBasis === 'auto_exact' && (auto.result === 'pass' || auto.result === 'fail')) return { outcome: auto.result, disagreement: true, adjudicated: null };
  if (humanDecision) return { outcome: humanDecision, disagreement: conflict, adjudicated: conflict ? 'human' : null };
  if (acceptance.scoreBasis === 'human_only') return { outcome: 'unreviewed', disagreement: false, adjudicated: null };
  if (auto.result === 'pass' || auto.result === 'fail' || auto.result === 'error' || auto.result === 'abstained' || auto.result === 'missing') {
    return { outcome: auto.result, disagreement: false, adjudicated: null };
  }
  return { outcome: 'insufficient', disagreement: false, adjudicated: null };
}

function predictionMap(rows) {
  return new Map((rows ?? []).map((row) => [row.caseKey, row]));
}

function judgmentMap(rows) {
  return new Map((rows ?? []).map((row) => [row.caseKey, row]));
}

export function sideRoles(blind) {
  if (!blind?.hideIdentity) return { hidden: false, left: 'baseline', right: 'candidate' };
  const swap = blind.swap === true;
  return { hidden: true, left: swap ? 'candidate' : 'baseline', right: swap ? 'baseline' : 'candidate' };
}

function covered(outcome, humanDecision, auto, basis) {
  if (basis === 'human_only') return humanDecision != null;
  if (basis === 'auto_exact') return auto.status !== 'missing';
  return humanDecision != null || auto.result === 'pass' || auto.result === 'fail';
}

function bump(bucket, outcome) {
  bucket.eligible += 1;
  if (Object.hasOwn(bucket, outcome)) bucket[outcome] += 1;
  else bucket.other += 1;
}

/**
 * Comparison figures. Every rate uses the eligible case count. Missing, errored and unreviewed
 * cases are never dropped from the denominator.
 */
export function buildComparison({ version, baselinePredictions, candidatePredictions, judgments, acceptance }) {
  const cases = version.cases ?? [];
  const baseline = predictionMap(baselinePredictions);
  const candidate = predictionMap(candidatePredictions);
  const reviews = judgmentMap(judgments);
  const rows = cases.map((row) => {
    const judgment = reviews.get(row.caseKey) ?? null;
    const autoBaseline = scoreSide(row.expectedAnswer, baseline.get(row.caseKey));
    const autoCandidate = scoreSide(row.expectedAnswer, candidate.get(row.caseKey));
    const baselineResolved = resolveOutcome({ auto: autoBaseline, humanDecision: judgment?.baselineDecision ?? null, adjudication: judgment?.adjudicationBaseline ?? null, acceptance });
    const candidateResolved = resolveOutcome({ auto: autoCandidate, humanDecision: judgment?.candidateDecision ?? null, adjudication: judgment?.adjudicationCandidate ?? null, acceptance });
    return {
      caseKey: row.caseKey, input: row.input, expectedAnswer: row.expectedAnswer, reviewCriteria: row.reviewCriteria,
      category: row.category, severity: row.severity, sourceRefs: row.sourceRefs,
      baseline: { prediction: baseline.get(row.caseKey) ?? null, auto: autoBaseline, human: judgment?.baselineDecision ?? null, adjudication: judgment?.adjudicationBaseline ?? null, ...baselineResolved },
      candidate: { prediction: candidate.get(row.caseKey) ?? null, auto: autoCandidate, human: judgment?.candidateDecision ?? null, adjudication: judgment?.adjudicationCandidate ?? null, ...candidateResolved },
      note: judgment?.note ?? null,
      reviewed: Boolean(judgment && (judgment.baselineDecision || judgment.candidateDecision)),
    };
  });

  const eligible = rows.length;
  const tally = (side) => rows.reduce((acc, row) => {
    const prediction = row[side].prediction;
    if (!prediction) acc.missing += 1;
    else {
      acc.submitted += 1;
      if (prediction.status === 'error') acc.failed += 1;
      else if (prediction.status === 'abstained') acc.abstained += 1;
      else acc.answered += 1;
    }
    return acc;
  }, { eligible, submitted: 0, missing: 0, failed: 0, abstained: 0, answered: 0 });

  const passes = rows.filter((row) => row.candidate.outcome === 'pass').length;
  const decisive = rows.filter((row) => row.candidate.outcome === 'pass' || row.candidate.outcome === 'fail');
  const groups = new Map();
  const ensure = (kind, key) => {
    const id = `${kind}:${key}`;
    if (!groups.has(id)) groups.set(id, { [kind]: key, eligible: 0, pass: 0, fail: 0, error: 0, abstained: 0, missing: 0, insufficient: 0, unreviewed: 0, disagreement: 0, other: 0 });
    return groups.get(id);
  };
  for (const row of rows) {
    bump(ensure('category', row.category ?? '(none)'), row.candidate.outcome);
    bump(ensure('severity', row.severity ?? 'unset'), row.candidate.outcome);
  }

  const improvements = rows.filter((row) => row.candidate.outcome === 'pass' && row.baseline.outcome !== 'pass').map((row) => row.caseKey);
  const regressions = rows.filter((row) => row.baseline.outcome === 'pass' && row.candidate.outcome !== 'pass').map((row) => row.caseKey);
  const criticalOpen = rows.filter((row) => row.severity === 'critical' && row.candidate.outcome !== 'pass');
  const criticalDecisive = new Set(['fail', 'error', 'abstained']);
  const criticalFailures = criticalOpen.filter((row) => criticalDecisive.has(row.candidate.outcome));
  const criticalUnresolved = criticalOpen.filter((row) => !criticalDecisive.has(row.candidate.outcome));
  const reasons = [];
  const coveredCount = rows.filter((row) => covered(row.candidate.outcome, row.candidate.human, row.candidate.auto, acceptance.scoreBasis)).length;
  const coverage = eligible ? coveredCount / eligible : 0;
  if (coverage + 1e-12 < acceptance.minCoverage) reasons.push(`Coverage is ${coveredCount} of ${eligible} eligible cases, below the required ${acceptance.minCoverage}. Missing and unreviewed cases were not dropped.`);
  const needsHuman = rows.filter((row) => {
    if (row.severity === 'critical' && acceptance.requireHumanOnCritical && !row.candidate.human) return true;
    if (!row.expectedAnswer && acceptance.requireHumanWhenNoExpectedAnswer && !row.candidate.human) return true;
    if (row.candidate.outcome === 'disagreement') return true;
    return false;
  });
  if (needsHuman.length) reasons.push(`${needsHuman.length} case${needsHuman.length === 1 ? '' : 's'} still need a human decision or an adjudication (${needsHuman.slice(0, 8).map((row) => row.caseKey).join(', ')}${needsHuman.length > 8 ? '…' : ''}).`);
  if (acceptance.criticalMustPass && criticalUnresolved.length) {
    reasons.push(`${criticalUnresolved.length} critical case${criticalUnresolved.length === 1 ? '' : 's'} ${criticalUnresolved.map((row) => `${row.caseKey} (${row.candidate.outcome})`).join(', ')} ${criticalUnresolved.length === 1 ? 'is' : 'are'} missing, unreviewed or not a decisive pass or fail. That is insufficient evidence, not a proven wrong answer.`);
  }
  const passRate = eligible ? passes / eligible : 0;
  let result = 'pass';
  if (reasons.length) result = 'insufficient_evidence';
  else if (acceptance.criticalMustPass && criticalFailures.length) {
    result = 'fail';
    reasons.push(`${criticalFailures.length} critical case${criticalFailures.length === 1 ? '' : 's'} did not pass: ${criticalFailures.map((row) => `${row.caseKey} (${row.candidate.outcome})`).join(', ')}.`);
  } else if (passRate + 1e-12 < acceptance.minPassRate) {
    result = 'fail';
    reasons.push(`The pass rate is ${passes} of ${eligible} eligible cases, below ${acceptance.minPassRate}.`);
  }
  if (!eligible) {
    result = 'insufficient_evidence';
    reasons.push('The frozen set has no cases.');
  }

  return {
    rows,
    counts: {
      eligible,
      baseline: tally('baseline'),
      candidate: tally('candidate'),
      reviewed: rows.filter((row) => row.reviewed).length,
      unreviewed: rows.filter((row) => !row.candidate.human).length,
      disagreements: rows.filter((row) => row.candidate.disagreement && !row.candidate.adjudicated).length,
      passes,
      fails: rows.filter((row) => row.candidate.outcome === 'fail').length,
      insufficient: rows.filter((row) => row.candidate.outcome === 'insufficient' || row.candidate.outcome === 'disagreement' || row.candidate.outcome === 'unreviewed').length,
    },
    passRate,
    denominator: 'eligible',
    coverage: { covered: coveredCount, eligible, fraction: eligible ? coverage : 0 },
    wilson95: wilson95(decisive.filter((row) => row.candidate.outcome === 'pass').length, decisive.length),
    byCategory: [...groups.values()].filter((row) => row.category),
    bySeverity: [...groups.values()].filter((row) => row.severity),
    improvements,
    regressions,
    criticalFailures: criticalFailures.map((row) => ({ caseKey: row.caseKey, outcome: row.candidate.outcome, category: row.category, auto: row.candidate.auto.result, human: row.candidate.human })),
    decision: { result, reasons },
    followUps: rows.filter((row) => row.severity === 'critical' ? row.candidate.outcome !== 'pass' : ['fail', 'error', 'abstained'].includes(row.candidate.outcome)).map((row) => ({
      caseKey: row.caseKey, outcome: row.candidate.outcome, severity: row.severity, category: row.category,
    })),
  };
}

export function buildReportSnapshot({ version, baselineBatch, candidateBatch, comparison, built }) {
  return {
    schema: 'valcairn.eval-report.v1',
    limitations: LIMITATIONS,
    normalization: NORMALIZATION,
    scorer: { id: SCORER_ID, decides: 'normalized exact string match only', tokenOverlap: 'diagnostic only' },
    set: {
      id: version.setId, versionId: version.id, number: version.number, name: version.name, purpose: version.purpose,
      contentHash: version.contentHash, rubricVersion: version.rubricVersion,
    },
    acceptance: comparison.acceptance,
    blind: comparison.blind,
    batches: {
      baseline: publicBatch(baselineBatch),
      candidate: publicBatch(candidateBatch),
    },
    counts: built.counts,
    passRate: built.passRate,
    denominator: built.denominator,
    coverage: built.coverage,
    wilson95: built.wilson95,
    byCategory: built.byCategory,
    bySeverity: built.bySeverity,
    improvements: built.improvements,
    regressions: built.regressions,
    criticalFailures: built.criticalFailures,
    decision: built.decision,
    followUps: built.followUps,
    cases: built.rows,
  };
}

export function publicCase(row) {
  return {
    id: row.id, caseKey: row.caseKey, input: row.input, expectedAnswer: row.expectedAnswer,
    reviewCriteria: row.reviewCriteria, category: row.category, severity: row.severity,
    sourceRefs: row.sourceRefs ?? [],
  };
}

/** Frozen case-set manifest. Purpose is a label, not a claim that the set is secret or leakage-free. */
export function evalManifest({ set, cases, issues, counts }) {
  return {
    schema: 'valcairn.eval-set.v1',
    setId: set.id,
    name: set.name,
    purpose: set.purpose,
    revision: set.revision,
    rubricVersion: set.rubricVersion,
    acceptance: set.acceptance,
    cases: cases.map(publicCase).sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    qc: {
      open: issues.filter((issue) => issue.open).length,
      issues: issues.map(({ key, title, detail, blocking, acknowledgeable, open, caseKeys }) => ({ key, title, detail, blocking, acknowledgeable, open, caseKeys })),
      counts,
    },
    limitations: [
      'The purpose label does not mean this set is secret, leakage-free or representative of later traffic.',
      'An acknowledged conflict stays visible. Acknowledgement does not mean either expected answer was proven wrong.',
    ],
  };
}

export function predictionRecords(rows) {
  return [...rows].sort((a, b) => a.caseKey.localeCompare(b.caseKey)).map(({ caseKey, status, output, error }) => ({ caseKey, status, output, error }));
}

export function sourceCatalog(versions, projectName) {
  return versions.map((version) => {
    const files = version.manifest?.files ?? [];
    const uses = version.manifest?.dataSource?.allowedUses;
    return {
      projectId: version.projectId,
      projectName: projectName(version.projectId) ?? 'Project',
      versionId: version.id,
      number: version.number,
      testing: Array.isArray(uses) && uses.includes('testing'),
      fileIds: files.map((file) => file.id),
      files: files.map((file) => ({ id: file.id, filename: file.filename })),
    };
  });
}

export function publicBatch(batch) {
  return {
    id: batch.id, role: batch.role, label: batch.label, claimedSystem: batch.claimedSystem, claimedScorer: batch.claimedScorer,
    rubricVersion: batch.rubricVersion, provenance: batch.provenance, contentHash: batch.contentHash, importedAt: batch.importedAt,
    provenanceLimit: 'Customer-supplied import. Model identity, latency, cost, configuration and training-data separation were not verified.',
  };
}

/** Blind review payload. Roles are omitted while identities are hidden. */
export function toReviewView(detail) {
  const roles = sideRoles(detail.comparison.blind);
  const pick = (row, role) => ({
    output: row[role].prediction?.status === 'answered' ? row[role].prediction.output : null,
    status: row[role].prediction?.status ?? 'missing',
    error: row[role].prediction?.error ?? null,
    auto: row[role].auto,
    decision: row[role].human,
    adjudication: row[role].adjudication,
    outcome: row[role].outcome,
    disagreement: row[role].disagreement,
  });
  return {
    hidden: roles.hidden,
    ...(roles.hidden ? {} : { leftRole: roles.left, rightRole: roles.right }),
    cases: detail.rows.map((row) => ({
      caseKey: row.caseKey,
      input: row.input,
      expectedAnswer: row.expectedAnswer,
      reviewCriteria: row.reviewCriteria,
      category: row.category,
      severity: row.severity,
      sourceRefs: row.sourceRefs,
      note: row.note,
      left: pick(row, roles.left),
      right: pick(row, roles.right),
    })),
  };
}

export function mapBlindDecisions(blind, body) {
  const decision = (value, label) => {
    if (value == null || value === '') return null;
    if (!DECISIONS.includes(value)) throw bad(`${label} must be pass, fail or insufficient.`);
    return value;
  };
  const adjudication = (value, label) => {
    if (value == null || value === '') return null;
    if (!ADJUDICATIONS.includes(value)) throw bad(`${label} adjudication must be human or automatic.`);
    return value;
  };
  const roles = sideRoles(blind);
  if (roles.hidden) {
    if (body.baselineDecision != null || body.candidateDecision != null) throw bad('This review hides which system is which. Record a decision for the left and right answers.');
    return {
      [roles.left + 'Decision']: decision(body.leftDecision, 'Left'),
      [roles.right + 'Decision']: decision(body.rightDecision, 'Right'),
      ['adjudication' + (roles.left === 'baseline' ? 'Baseline' : 'Candidate')]: adjudication(body.leftAdjudication, 'Left'),
      ['adjudication' + (roles.right === 'baseline' ? 'Baseline' : 'Candidate')]: adjudication(body.rightAdjudication, 'Right'),
    };
  }
  return {
    baselineDecision: decision(body.baselineDecision, 'Baseline'),
    candidateDecision: decision(body.candidateDecision, 'Candidate'),
    adjudicationBaseline: adjudication(body.adjudicationBaseline, 'Baseline'),
    adjudicationCandidate: adjudication(body.adjudicationCandidate, 'Candidate'),
  };
}

export const SYNTHETIC_CASES = `{"id":"case-returns-window","input":"How long does a customer have to return an unopened synthetic demo kettle?","expectedAnswer":"30 days from delivery","reviewCriteria":"Name the 30-day window and that it starts at delivery.","category":"returns","severity":"critical","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
{"id":"case-warranty-power","input":"The synthetic demo kettle will not power on. What should the agent do?","expectedAnswer":"Ask for the order number and offer a replacement. Do not promise a refund before the order is found.","reviewCriteria":null,"category":"warranty","severity":"major","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002"}]}
{"id":"case-store-hours","input":"What time does the synthetic demo shop close on Sunday?","expectedAnswer":null,"reviewCriteria":"The answer must match the Sunday hours in the cited policy, or say the policy does not state them.","category":"hours","severity":"minor","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
`;

export const SYNTHETIC_PREDICTIONS = `{"id":"case-returns-window","status":"answered","output":"You can return an unopened kettle within 30 days of delivery."}
{"id":"case-warranty-power","status":"answered","output":"I can refund you right now."}
{"id":"case-store-hours","status":"error","error":"timeout"}
`;

/** Reject an adjudication that would hide a disagreement or invent an automatic pass. */
export function checkAdjudication(auto, humanDecision, adjudication, label) {
  if (!adjudication) return;
  if (!disagrees(auto.result, humanDecision)) throw bad(`${label} is not a disagreement, so there is nothing to adjudicate.`);
  if (adjudication === 'human' && !humanDecision) throw bad(`${label} needs a human decision before that decision can be kept.`);
  if (adjudication === 'automatic' && auto.result !== 'pass' && auto.result !== 'fail') {
    throw bad(`${label} has no exact-match pass or fail to keep. Choose the human decision, or leave the disagreement open.`);
  }
}

export function claimText(value, max, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw bad(`${label} must be text of at most ${max} characters.`);
  return value.trim();
}
