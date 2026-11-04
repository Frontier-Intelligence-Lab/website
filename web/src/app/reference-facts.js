import { createElement as h } from 'react';

// Read-only display of an evidence record's entire validated `reference` payload, exactly as stored and frozen:
// every key and value, nested objects and arrays included, with explicit false, null, zero and empty values. Plain
// `createElement` (no JSX) so the rendering can be checked in node tests with react-dom/server. React escapes every
// text node, so stored strings can never become markup.

const LABELS = {
  projectId: 'Project id', projectName: 'Project', version: 'Version', reviewId: 'Review id', files: 'Files', createdAt: 'Recorded at',
  enhanceRunId: 'Enhance run id', name: 'Name', baseModelId: 'Base model', status: 'Status', requestedAt: 'Requested at',
  deviceId: 'Device id', deviceLabel: 'Device', runId: 'Run id', modelRef: 'Model', modelDigest: 'Model digest', kind: 'Run kind', warm: 'Warm start',
  metrics: 'Metrics', task: 'Task', provenance: 'Provenance', id: 'Id', passed: 'Passed',
  wallMs: 'Wall time (ms)', ttftMs: 'Time to first token (ms)', loadMs: 'Load time (ms)', promptTokens: 'Prompt tokens', promptEvalMs: 'Prompt eval (ms)',
  outputTokens: 'Output tokens', evalMs: 'Eval (ms)', tokensPerSec: 'Tokens per second', promptTokensPerSec: 'Prompt tokens per second',
  creditRecordId: 'Credit record id', provider: 'Provider', restrictions: 'Restrictions', expiresOn: 'Expires on',
};
// Identifiers and timestamps: shown in full, but muted so the material facts stand out.
const META = new Set(['projectId', 'reviewId', 'enhanceRunId', 'deviceId', 'runId', 'creditRecordId', 'createdAt', 'requestedAt']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const factLabel = (key) => LABELS[key] ?? key;

/** One scalar, spelled out so nothing reads as missing when it is false, null, zero or empty. */
export function factText(value) {
  if (value === null) return 'null (not set)';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true (yes)' : 'false (no)';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  return String(value);
}

function factValue(value) {
  if (isPlainObject(value)) return Object.keys(value).length ? h(ReferenceFacts, { reference: value, nested: true }) : h('span', { className: 'ob-muted' }, '{} (empty)');
  if (Array.isArray(value)) return value.length ? h('ol', { className: 'cap-facts-list' }, value.map((item, i) => h('li', { key: i }, factValue(item)))) : h('span', { className: 'ob-muted' }, '[] (empty)');
  return h('span', { className: typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? 'mono' : undefined }, factText(value));
}

/** The whole reference as a definition list; an empty reference says so instead of showing nothing. */
export function ReferenceFacts({ reference, nested = false }) {
  if (!isPlainObject(reference) || Object.keys(reference).length === 0) {
    return h('p', { className: 'ob-muted cap-facts-empty' }, 'No reference facts: this record is described only by its title and source.');
  }
  // Material facts first, identifiers and timestamps last; otherwise the stored order (a database may reorder keys).
  const entries = [...Object.entries(reference).filter(([k]) => !META.has(k)), ...Object.entries(reference).filter(([k]) => META.has(k))];
  return h('dl', { className: nested ? 'cap-facts cap-facts--nested' : 'cap-facts' }, entries.flatMap(([key, value]) => [
    h('dt', { key: `${key}:k`, className: META.has(key) ? 'cap-facts-meta' : undefined }, factLabel(key)),
    h('dd', { key: `${key}:v`, className: META.has(key) ? 'cap-facts-meta' : undefined }, factValue(value)),
  ]));
}
