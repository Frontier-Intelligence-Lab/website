import { StoreError } from '../store/errors.js';

// Data types, preview rules, label rules and the issue list for a project's dataset.
// Shared by the stores (which apply them under the project lock), the API routes and tests.

export const KINDS = ['video', 'audio', 'image', 'text', 'sensor', 'robot', 'table', 'logs', 'file'];
// Kinds that live on a timeline, so they can carry span labels and a sync offset.
export const TIMED = ['video', 'audio', 'sensor', 'robot', 'logs'];
export const TONES = ['orange', 'blue', 'violet', 'green', 'amber', 'teal', 'plain'];
export const SCOPES = ['span', 'file', 'box'];
const MAX_MS = 31622400000;
const isMs = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_MS;
const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const invalid = (message) => new StoreError('invalid_label', message);

const TEXT_TYPES = ['text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'application/json', 'application/x-ndjson'];
const ARCHIVES = ['application/zip', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed', 'application/x-bzip2', 'application/zstd'];

const extension = (filename) => {
  const dot = String(filename ?? '').lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

/** The data type read from the stored content type (set by ingest from the file's bytes) and, for text, the extension. */
export function detectKind({ contentType = '', filename = '' }) {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/x-mcap' || contentType === 'application/x-rosbag') return 'robot';
  if (['application/vnd.apache.parquet', 'text/csv', 'text/tab-separated-values'].includes(contentType)) return 'table';
  if (contentType === 'text/plain' && extension(filename) === 'log') return 'logs';
  if (TEXT_TYPES.includes(contentType) || contentType === 'application/pdf') return 'text';
  return 'file';
}

export const kindOf = (upload) => upload.kind ?? detectKind(upload);

/**
 * The stored form of one label on one file, or an `invalid_label` StoreError saying why it does not fit.
 * Spans need a timeline, boxes need an image, and whole-file labels carry neither.
 */
export function checkAnnotation({ label, upload, startMs = null, endMs = null, box = null }) {
  if (!label) throw invalid('Choose a label from the label set.');
  const kind = kindOf(upload);
  if (label.scope === 'span') {
    if (!TIMED.includes(kind)) throw invalid(`“${label.name}” marks a span of time, and this file has no timeline. Use a whole-file label.`);
    if (!isMs(startMs) || !isMs(endMs) || endMs < startMs) throw invalid('Set a start and an end, with the end after the start.');
    return { startMs, endMs, box: null };
  }
  if (label.scope === 'box') {
    if (kind !== 'image') throw invalid(`“${label.name}” is a box on an image, and this file is not an image.`);
    const b = box ?? {};
    if (![b.x, b.y, b.w, b.h].every(unit) || b.w <= 0 || b.h <= 0 || b.x + b.w > 1.000001 || b.y + b.h > 1.000001) throw invalid('Draw the box inside the image.');
    const round = (n) => Math.round(n * 1e6) / 1e6;
    return { startMs: null, endMs: null, box: { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) } };
  }
  return { startMs: null, endMs: null, box: null };
}

/** A label in use cannot be removed or change what it marks. Returns the first label that would break, or null. */
export function labelSetConflict(current, next, usedIds) {
  return current.find((l) => usedIds.has(l.id) && next.find((n) => n.id === l.id)?.scope !== l.scope) ?? null;
}

/** Whether a file can keep its labels after its data type changes to `kind`. */
export function kindFitsAnnotations(kind, annotations) {
  if (annotations.some((a) => a.startMs != null) && !TIMED.includes(kind)) return false;
  if (annotations.some((a) => a.box) && kind !== 'image') return false;
  return true;
}

/** What the browser may render inline, and as which type. Anything else is download only. */
export function previewType(contentType = '') {
  if (/^(image|video|audio)\/[\w.+-]+$/.test(contentType) && contentType !== 'image/svg+xml') return contentType;
  if (TEXT_TYPES.includes(contentType)) return 'text/plain; charset=utf-8';
  return null;
}

/**
 * Open questions to settle before review; `fix.page` names the screen that fixes one (data, import or annotate).
 * An issue goes away when it is fixed, or when someone records a note
 * against its key explaining why it stays. `blocking` issues cannot be noted away.
 */
export function computeIssues({ project, uploads, annotations, notes }) {
  const issues = [];
  const add = (issue) => issues.push({ ...issue, note: notes.find((n) => n.key === issue.key)?.note ?? null });
  const files = uploads.filter((u) => !u.duplicateOf);
  const labelled = new Set(annotations.map((a) => a.uploadId));

  if (!project.dataSource) {
    add({ key: 'source', group: 'rights', blocking: true, title: 'Where did this data come from?', detail: 'Record its source and how it may be used. Staff read this record; Valcairn cannot verify it.', fix: { label: 'Record the source', page: 'data' } });
  }
  if (project.dataSource?.mode === 'upload' && files.length === 0) {
    add({ key: 'empty-set', group: 'files', blocking: true, title: 'No files yet', detail: 'Import at least one file before review.', fix: { label: 'Import data', page: 'import' } });
  }
  for (const u of uploads) {
    if (u.duplicateOf) {
      const original = uploads.find((o) => o.id === u.duplicateOf);
      add({ key: `duplicate:${u.id}`, group: 'files', uploadId: u.id, title: `Same content as ${original?.filename ?? 'another file'}`, detail: 'Identical SHA-256. Only the first copy is reviewed and versioned, and duplicates can leak between train and test splits.', remove: true });
    }
    if (u.sizeBytes === 0) add({ key: `empty:${u.id}`, group: 'files', uploadId: u.id, title: 'The file is empty', detail: 'It has 0 bytes, so there is nothing to review.', remove: true });
    if (!u.duplicateOf && ARCHIVES.includes(u.contentType)) add({ key: `archive:${u.id}`, group: 'files', uploadId: u.id, title: 'Archive contents are not inspected', detail: 'Valcairn stores the archive as one file and does not open it. Upload the files inside it if they should be reviewed one by one.', remove: true });
  }
  if (files.length && !(project.labelSet ?? []).length) {
    add({ key: 'labels:none', group: 'labels', title: 'No label set yet', detail: 'Define the labels this dataset uses, or note that it is released unlabelled.', fix: { label: 'Define labels', page: 'annotate' } });
  } else if (files.length) {
    const byKind = new Map();
    for (const u of files) if (!labelled.has(u.id)) byKind.set(kindOf(u), [...(byKind.get(kindOf(u)) ?? []), u]);
    for (const [kind, list] of byKind) {
      add({ key: `unlabelled:${kind}`, group: 'labels', kind, uploadId: list[0].id, count: list.length, title: `${list.length} ${kind === 'file' ? 'other' : kind} file${list.length === 1 ? ' has' : 's have'} no labels`, detail: list.slice(0, 3).map((u) => u.filename).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : ''), fix: { label: 'Open in annotator', page: 'annotate', uploadId: list[0].id } });
    }
  }
  return issues.map((i) => ({ ...i, open: i.blocking || !i.note }));
}
