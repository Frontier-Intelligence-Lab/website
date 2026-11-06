// Scoring and publication for an executed case run. The runner is untrusted: it sends
// outputs, and this module decides the score. Nothing here calls a model or a network.
// Token overlap is an F1 diagnostic. It never decides pass or fail.

import { snapshotHash } from './capital-hash.js';
import { normalizeText } from './eval.js';

export const RECIPE_ID = 'support-qa';
export const HEARTBEAT_MS = 60_000;
export const RUNNER_ERRORS = ['timeout', 'transport', 'no_source'];
const CASE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ERROR_EXPLANATION = 'This is an error, not a wrong answer.';

export function runnerFresh(lastSeenAt, nowMs) {
  const seen = Date.parse(lastSeenAt ?? '');
  return Number.isFinite(seen) && nowMs - seen >= 0 && nowMs - seen <= HEARTBEAT_MS;
}

export function chunkCorpus(text) {
  const raw = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (raw.length > 100_000) return { error: 'The source text must be at most 100,000 characters.' };
  const passages = [];
  for (let i = 0; raw && i < raw.length && passages.length < 200; i += 2000) {
    const slice = raw.slice(i, i + 2000).trim();
    if (!slice) continue;
    const id = `p${passages.length + 1}`;
    passages.push({ id, citation: id, text: slice });
  }
  return { passages };
}

/** The candidate snapshot stored on the run. `modelId` null means the recipe quotes passages. */
export function validateCandidate({ candidate, catalog }) {
  const body = candidate ?? {};
  const retrievalK = body.retrievalK ?? 1;
  if (!Number.isInteger(retrievalK) || retrievalK < 1 || retrievalK > 20) return { error: 'Retrieval depth must be a whole number from 1 to 20.' };
  const boosts = body.boosts ?? [];
  if (!Array.isArray(boosts) || boosts.length > 20 || boosts.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 80)) {
    return { error: 'Boosts are at most 20 headings of at most 80 characters.' };
  }
  const prompt = body.prompt ?? '';
  if (typeof prompt !== 'string' || prompt.length > 2000) return { error: 'The prompt must be text of at most 2000 characters. It is stored and is not sent to a model.' };
  const modelId = body.modelId ?? null;
  if (modelId != null && (typeof modelId !== 'string' || !catalog.some((item) => item.id === modelId))) {
    return { error: 'Choose a model from the catalog, or none. This server does not call a model.' };
  }
  const corpus = chunkCorpus(body.corpus ?? '');
  if (corpus.error) return corpus;
  const settings = { retrievalK, boosts: boosts.map((item) => item.trim()), prompt, modelId, promptUsed: false };
  return { settings, passages: corpus.passages, specHash: snapshotHash({ settings, passages: corpus.passages }) };
}

export function tokenF1(leftText, rightText) {
  const left = normalizeText(leftText).split(' ').filter(Boolean);
  const right = normalizeText(rightText).split(' ').filter(Boolean);
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  for (const token of right) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of left) {
    const have = counts.get(token) ?? 0;
    if (!have) continue;
    shared += 1;
    counts.set(token, have - 1);
  }
  const precision = shared / left.length;
  const recall = shared / right.length;
  if (precision + recall === 0) return 0;
  return Math.round((2 * precision * recall) / (precision + recall) * 1000) / 1000;
}

function rubricPhrases(criteria) {
  if (typeof criteria !== 'string' || !criteria.trim()) return [];
  return criteria.split('\n').map((line) => line.trim()).filter(Boolean);
}

function scoreRow(item, row, knownCitations) {
  const expected = typeof item.expectedAnswer === 'string' && item.expectedAnswer.trim() ? item.expectedAnswer : null;
  const phrases = rubricPhrases(item.reviewCriteria);
  const exact = expected ? normalizeText(row.output) === normalizeText(expected) : null;
  const rubric = phrases.length ? (phrases.every((phrase) => normalizeText(row.output).includes(normalizeText(phrase))) ? 'pass' : 'fail') : 'not_required';
  const cited = row.citations.filter((citation) => knownCitations.has(citation));
  const citation = !knownCitations.size ? 'not_required' : !row.citations.length ? 'missing' : cited.length === row.citations.length ? 'match' : 'unsupported';
  const textOk = (exact === null || exact === true) && rubric !== 'fail';
  const citeOk = citation === 'match' || citation === 'not_required';
  const verdict = textOk && citeOk ? 'pass' : textOk ? 'needs_judgment' : 'fail';
  const why = [
    exact === true ? 'The answer matches the expected fact after normalization.' : exact === false ? 'The answer does not match the expected fact after normalization.' : null,
    rubric === 'pass' ? 'Every rubric phrase is in the answer.' : rubric === 'fail' ? 'A required rubric phrase is missing from the answer.' : null,
    citation === 'missing' ? 'The answer cites no passage from this run.' : citation === 'unsupported' ? 'The answer cites a passage that is not in this run.' : citation === 'match' ? 'The citation is a passage from this run.' : null,
    'Token overlap is a diagnostic and does not decide the result.',
  ].filter(Boolean);
  return {
    scores: {
      exact, rubric, citation, verdict,
      tokenOverlap: tokenF1(row.output, expected ?? phrases.join(' ')),
      tokenOverlapLabel: 'token overlap',
      decides: 'exact fact, rubric and citation',
    },
    explanation: why.join(' '),
  };
}

function blankScore(row, { keepError }) {
  return { ...row, scores: null, explanation: keepError && row.errorKind ? row.explanation : null };
}

/** One posted case from the runner. Any score field is ignored. */
export function acceptPosted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Each result must be an object.' };
  const caseKey = typeof raw.caseKey === 'string' ? raw.caseKey.trim() : '';
  if (!CASE_KEY.test(caseKey)) return { error: 'A result needs a case id from this frozen set.' };
  const errorKind = raw.errorKind ?? null;
  if (errorKind != null && !RUNNER_ERRORS.includes(errorKind)) return { error: `${caseKey} has an unknown error. Use timeout, transport or no_source.` };
  const output = raw.output ?? null;
  if (errorKind && output != null && output !== '') return { error: `${caseKey} is an error and also has answer text. Nothing was saved.` };
  if (!errorKind && (typeof output !== 'string' || !output.trim() || output.length > 8000)) return { error: `${caseKey} needs answer text of at most 8000 characters.` };
  if (raw.passages != null && (!Array.isArray(raw.passages) || raw.passages.length > 8)) return { error: `${caseKey} has too many retrieved passages.` };
  const passages = (raw.passages ?? []).map((item) => {
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 500) : '';
    const citation = typeof item?.citation === 'string' ? item.citation.trim().slice(0, 80) : '';
    return text ? { text, citation } : null;
  });
  if (passages.some((item) => !item)) return { error: `${caseKey} has a passage that is not text.` };
  if (raw.citations != null && (!Array.isArray(raw.citations) || raw.citations.length > 8 || raw.citations.some((item) => typeof item !== 'string' || item.length > 80))) {
    return { error: `${caseKey} has a citation that is not a short string.` };
  }
  const latencyMs = raw.latencyMs ?? null;
  if (latencyMs != null && (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 600_000)) return { error: `${caseKey} has a latency that is not a whole number of milliseconds.` };
  return {
    result: {
      caseKey, errorKind, output: errorKind ? null : output.trim(), passages,
      citations: (raw.citations ?? []).map((item) => item.trim()).filter(Boolean), latencyMs,
    },
  };
}

export function acceptBatch(rows, knownKeys) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 40) return { error: 'Send from 1 to 40 case results.' };
  const seen = new Set();
  const results = [];
  for (const raw of rows) {
    const accepted = acceptPosted(raw);
    if (accepted.error) return accepted;
    if (seen.has(accepted.result.caseKey)) return { error: `Case ${accepted.result.caseKey} is repeated. Nothing was saved.` };
    if (!knownKeys.has(accepted.result.caseKey)) return { error: `${accepted.result.caseKey} is not in this frozen set. Nothing was saved.` };
    seen.add(accepted.result.caseKey);
    results.push(accepted.result);
  }
  return { results };
}

function materialize(cases, posted, corpus) {
  const known = new Set(corpus.map((item) => item.citation));
  if (!corpus.length) {
    return cases.map((item) => ({
      caseKey: item.caseKey, output: null, errorKind: 'no_source', passages: [], citations: [], latencyMs: null, scores: null,
      explanation: ERROR_EXPLANATION,
    }));
  }
  return cases.map((item) => {
    const row = posted.get(item.caseKey);
    if (!row) {
      return { caseKey: item.caseKey, output: null, errorKind: 'missing', passages: [], citations: [], latencyMs: null, scores: null, explanation: 'This case has no answer. The run has no score.' };
    }
    if (row.errorKind) return { ...row, scores: null, explanation: ERROR_EXPLANATION };
    return { ...row, ...scoreRow(item, row, known) };
  });
}

/** Product status for a runner that finished the recipe. Errors never become a score. */
export function decideRun({ cases, posted, corpus }) {
  const results = materialize(cases, posted, corpus);
  const errors = results.filter((row) => row.errorKind).length;
  if (!errors) return { status: 'complete', scored: true, results };
  const status = errors === results.length ? 'failed' : 'partial';
  return { status, scored: false, results: results.map((row) => blankScore(row, { keepError: true })) };
}

/** A cancelled or failed job keeps the rows it had and never keeps a score. */
export function unscoredRun(cases, posted, corpus, status) {
  const results = materialize(cases, posted, corpus).map((row) => blankScore(row, { keepError: true }));
  return { status, scored: false, results };
}

export function presentResult(row, scored) {
  if (scored) return row;
  return { ...row, scores: null, explanation: row.errorKind ? row.explanation : null };
}

export function presentRun(run, results) {
  const scored = run.scored === true && run.status === 'complete';
  return {
    id: run.id, workspaceId: run.workspaceId, projectId: run.projectId, versionId: run.versionId, jobId: run.jobId,
    role: run.role, status: run.status, scored, recipeId: run.recipeId, recipeVersion: run.recipeVersion,
    settings: run.settings, passageCount: run.passages.length, passages: run.passages, runtime: run.runtime,
    createdBy: run.createdBy, createdAt: run.createdAt, finishedAt: run.finishedAt ?? null,
    results: (results ?? []).map((row) => presentResult(row, scored)),
  };
}
