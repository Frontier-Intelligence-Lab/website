import { StoreError } from '../store/errors.js';
import { ruleProblem } from './onboarding.js';

// Data types, preview rules, label rules and the issue list for a project's dataset.
// Shared by the stores (which apply them under the project lock), the API routes and tests.

export const KINDS = ['video', 'audio', 'image', 'text', 'sensor', 'robot', 'table', 'logs', 'file'];
// Kinds that live on a timeline, so they can carry span labels and a sync offset.
export const TIMED = ['video', 'audio', 'sensor', 'robot', 'logs'];
export const TONES = ['orange', 'blue', 'violet', 'green', 'amber', 'teal', 'plain'];
export const SCOPES = ['span', 'file', 'box'];
const MAX_MS = 31622400000;
const isMs = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_MS;
const invalid = (message) => new StoreError('invalid_label', message);
// Boxes are stored as fractions of the image with six decimals. Each side must be at least 0.1% of the image,
// and a box may overrun the edge only by the rounding tolerance the database allows (1e-6).
const BOX_DECIMALS = 1e6;
export const MIN_BOX_SIDE = 0.001;
const EDGE_UNITS = 1000001; // 1 + 1e-6, in millionths

/**
 * Whether a stored box is exactly { x, y, w, h }: an object with those four keys and no others, each a number.
 * Key order is irrelevant (Postgres returns jsonb keys in its own order). Values are compared separately.
 */
export const isStoredBox = (box) => box != null && typeof box === 'object' && !Array.isArray(box)
  && Object.keys(box).sort().join(',') === 'h,w,x,y' && ['x', 'y', 'w', 'h'].every((k) => typeof box[k] === 'number');

/** Whether the stored bytes are an image a browser can draw on. Ingest refuses SVG, so every image/* type is raster. */
export const isImageContent = (upload) => /^image\/[\w.+-]+$/.test(upload?.contentType ?? '') && upload.contentType !== 'image/svg+xml';

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
    // The file's type can be changed by hand, so the bytes decide whether there is an image to draw on.
    if (!isImageContent(upload)) throw invalid(`“${label.name}” is a box on an image, and this file’s content is not an image (${upload.contentType}). Use a whole-file label.`);
    if (kind !== 'image') throw invalid(`“${label.name}” is a box on an image. Set this file’s data type back to Image first.`);
    const b = box ?? {};
    if (![b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n))) throw invalid('A box needs numeric x, y, width and height.');
    // Validate exactly what will be stored, in whole millionths so the sums are exact (as Postgres' numeric check is).
    const [X, Y, W, H] = [b.x, b.y, b.w, b.h].map((n) => Math.round(n * BOX_DECIMALS) + 0); // + 0 turns -0 into 0
    if (X < 0 || Y < 0 || X > BOX_DECIMALS || Y > BOX_DECIMALS) throw invalid('Draw the box inside the image.');
    if (W < MIN_BOX_SIDE * BOX_DECIMALS || H < MIN_BOX_SIDE * BOX_DECIMALS) throw invalid('Draw a larger box: each side must be at least 0.1% of the image.');
    if (X + W > EDGE_UNITS || Y + H > EDGE_UNITS) throw invalid('Draw the box inside the image.');
    const [x, y, w, h] = [X, Y, W, H].map((n) => n / BOX_DECIMALS);
    return { startMs: null, endMs: null, box: { x, y, w, h } };
  }
  return { startMs: null, endMs: null, box: null };
}

/** A label in use cannot be removed or change what it marks. Returns the first label that would break, or null. */
export function labelSetConflict(current, next, usedIds) {
  return current.find((l) => usedIds.has(l.id) && next.find((n) => n.id === l.id)?.scope !== l.scope) ?? null;
}

/**
 * A type set by hand may describe what the data means (a CSV of readings is Sensor) but cannot claim content the file
 * does not have: Image needs image bytes. Throws `invalid_kind` with a message for the person.
 */
export function checkKind(upload, kind) {
  if (kind === 'image' && !isImageContent(upload)) throw new StoreError('invalid_kind', `This file’s content is ${upload.contentType}, not an image, so it cannot be typed as Image.`);
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
 * Stored labels and file types that the current rules would refuse: rows written before a rule existed, or by
 * anything that bypassed the API. New writes are checked in `checkAnnotation` and `checkKind`; this finds the old
 * ones so they can be repaired in a draft and flagged in frozen history, never silently rewritten.
 * Returns { annotations: [{ annotation, upload, reason }], kinds: [{ upload, reason }] }.
 */
export function findInvalid({ uploads, annotations, labelSet = [] }) {
  const kinds = [];
  for (const u of uploads) {
    try { if (u.kind) checkKind(u, u.kind); } catch (err) { kinds.push({ upload: u, reason: err.message }); }
  }
  const bad = [];
  for (const a of annotations) {
    const upload = uploads.find((u) => u.id === a.uploadId);
    if (!upload) continue;
    const label = labelSet.find((l) => l.id === a.labelId);
    try {
      if (!label) throw invalid('Its label is no longer in the label set.');
      // Compare against what a fresh write of this label would need; whole-file labels must carry no times or box.
      // Postgres marks a box 010 would refuse before its numbers are read into JavaScript (see box-sql.js).
      if (a.storedFormInvalid) throw invalid('Its stored box is not in the supported form.');
      const fit = checkAnnotation({ label, upload, startMs: a.startMs, endMs: a.endMs, box: a.box });
      const sameBox = (fit.box == null && a.box == null) || (fit.box != null && isStoredBox(a.box) && ['x', 'y', 'w', 'h'].every((k) => fit.box[k] === a.box[k]));
      if (fit.startMs !== a.startMs || fit.endMs !== a.endMs || !sameBox) throw invalid('Its stored times or box are not in the supported form.');
    } catch (err) {
      bad.push({ annotation: a, upload, reason: err.message });
    }
  }
  return { annotations: bad, kinds };
}

/**
 * Labels and file types in a frozen snapshot or manifest that today's rules would refuse. `storedFormInvalid` lists
 * label ids whose raw box the database found outside the stored form (rawInvalidBoxIds on a Postgres review or version).
 */
export const countInvalid = (frozen, storedFormInvalid = []) => {
  const raw = new Set(storedFormInvalid);
  const annotations = (frozen.annotations ?? []).map((a) => (raw.has(a?.id) ? { ...a, storedFormInvalid: true } : a));
  const found = findInvalid({ uploads: frozen.files ?? [], annotations, labelSet: frozen.labelSet ?? [] });
  return { labels: found.annotations.length, kinds: found.kinds.length };
};

/**
 * Open questions to settle before review; `fix.page` names the screen that fixes one (success, data, import or
 * annotate) and `fix.action` an in-place repair (reset-kind, delete-annotation).
 * An issue goes away when it is fixed, or when someone records a note
 * against its key explaining why it stays. `blocking` issues cannot be noted away.
 */
export function computeIssues({ project, uploads, annotations, notes }) {
  const issues = [];
  const add = (issue) => issues.push({ ...issue, note: notes.find((n) => n.key === issue.key)?.note ?? null });
  const files = uploads.filter((u) => !u.duplicateOf);
  const invalidFound = findInvalid({ uploads, annotations, labelSet: project.labelSet ?? [] });
  const invalidIds = new Set(invalidFound.annotations.map((x) => x.annotation.id));
  // A label that no longer fits its file does not count as labelling it.
  const labelled = new Set(annotations.filter((a) => !invalidIds.has(a.id)).map((a) => a.uploadId));

  // Review is against the bar set before training, so the bar has to exist and say something.
  const rule = ruleProblem(project.success);
  if (rule) {
    add({ key: 'acceptance', group: 'rights', blocking: true, title: project.success ? 'The acceptance rule is incomplete' : 'No acceptance rule yet', detail: `${rule} Review locks the rule with the data, so it has to be complete first.`, fix: { label: 'Set the acceptance rule', page: 'success' } });
  }
  for (const { upload, reason } of invalidFound.kinds) {
    add({ key: `kind:${upload.id}`, group: 'labels', blocking: true, uploadId: upload.id, title: `${upload.filename} is typed as Image`, detail: `${reason} Delete any box labels on it, then reset its data type.`, fix: { label: 'Reset the data type', action: 'reset-kind', uploadId: upload.id } });
  }
  for (const { annotation, upload, reason } of invalidFound.annotations) {
    const name = (project.labelSet ?? []).find((l) => l.id === annotation.labelId)?.name ?? 'A removed label';
    add({ key: `label:${annotation.id}`, group: 'labels', blocking: true, uploadId: upload.id, title: `“${name}” no longer fits ${upload.filename}`, detail: `${reason} Delete it, then label the file again if it needs one.`, fix: { label: 'Delete this label', action: 'delete-annotation', annotationId: annotation.id } });
  }

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
