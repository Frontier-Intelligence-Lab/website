// Data types, preview rules and the issue list for a project's dataset. Shared by the API routes and tests.

export const KINDS = ['video', 'audio', 'image', 'text', 'sensor', 'robot', 'table', 'logs', 'file'];
// Kinds that live on a timeline, so they can carry span labels and a sync offset.
export const TIMED = ['video', 'audio', 'sensor', 'robot', 'logs'];
export const TONES = ['orange', 'blue', 'violet', 'green', 'amber', 'teal', 'plain'];

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
