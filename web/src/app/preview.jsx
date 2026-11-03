import { useEffect, useState } from 'react';
import { Tile } from './ui.jsx';

// Data types, mirrored from src/lib/dataset.js so the import screen can name a file before the server lists it.
export const KINDS = ['video', 'audio', 'image', 'text', 'sensor', 'robot', 'table', 'logs', 'file'];
export const TIMED = ['video', 'audio', 'sensor', 'robot', 'logs'];
export const KIND_LABEL = { video: 'Video', audio: 'Audio', image: 'Images', text: 'Text', sensor: 'Sensors', robot: 'Robot', table: 'Tables', logs: 'Logs', file: 'Other files' };
export const KIND_ONE = { video: 'Video', audio: 'Audio', image: 'Image', text: 'Text', sensor: 'Sensor', robot: 'Robot', table: 'Table', logs: 'Logs', file: 'File' };
const KIND_ICON = { video: 'play', audio: 'clock', image: 'grid', text: 'tag', sensor: 'updown', robot: 'layers', table: 'grid', logs: 'info', file: 'data' };
const FORMAT = {
  'application/vnd.apache.parquet': 'Parquet', 'application/x-mcap': 'MCAP', 'application/x-rosbag': 'ROS bag', 'application/pdf': 'PDF',
  'text/plain': 'Text', 'text/markdown': 'Markdown', 'text/csv': 'CSV', 'text/tab-separated-values': 'TSV', 'application/json': 'JSON', 'application/x-ndjson': 'JSON lines',
  'audio/x-wav': 'WAV', 'audio/wav': 'WAV', 'audio/mpeg': 'MP3', 'audio/x-flac': 'FLAC', 'video/quicktime': 'MOV', 'video/x-matroska': 'MKV', 'image/jpeg': 'JPEG',
  'application/zip': 'ZIP', 'application/gzip': 'gzip', 'application/x-tar': 'tar', 'application/x-7z-compressed': '7z', 'application/x-bzip2': 'bzip2', 'application/zstd': 'zstd',
};
const TEXT_TYPES = ['text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'application/json', 'application/x-ndjson'];

export function detectKind({ contentType = '', filename = '' }) {
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/x-mcap' || contentType === 'application/x-rosbag') return 'robot';
  if (['application/vnd.apache.parquet', 'text/csv', 'text/tab-separated-values'].includes(contentType)) return 'table';
  if (contentType === 'text/plain' && ext === 'log') return 'logs';
  if (TEXT_TYPES.includes(contentType) || contentType === 'application/pdf') return 'text';
  return 'file';
}

export const formatName = (contentType) => FORMAT[contentType] ?? contentType.split('/').pop().replace(/^x-/, '').toUpperCase();
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
export function fmtTime(ms, withTenths = false) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${withTenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}

// Text previews read only the first few kilobytes, once per file per page load.
const snippets = new Map();
function useSnippet(item, enabled) {
  const [state, setState] = useState(() => snippets.get(item.id) ?? null);
  useEffect(() => {
    if (!enabled || !item.previewUrl || snippets.has(item.id)) return undefined;
    let live = true;
    fetch(item.previewUrl, { headers: { range: 'bytes=0-4095' } })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => ({ text }), () => ({ error: true }))
      .then((value) => { snippets.set(item.id, value); if (live) setState(value); });
    return () => { live = false; };
  }, [item.id, item.previewUrl, enabled]);
  return state;
}

function Snippet({ item }) {
  const snippet = useSnippet(item, true);
  if (!snippet) return <span className="ds-preview-empty">Loading preview…</span>;
  if (snippet.error) return <Unavailable item={item} reason="The preview could not be loaded. Reload the page to try again." />;
  const lines = snippet.text.split(/\r?\n/).slice(0, 40);
  if (lines.length > 1 && snippet.text.length >= 4096) lines.pop(); // the last line may be cut mid-way
  if (item.kind === 'table' || item.kind === 'sensor') {
    const sep = item.contentType === 'text/tab-separated-values' ? '\t' : ',';
    return (
      <div className="ds-snippet mono" aria-label={`First rows of ${item.filename}`}>
        <table><tbody>{lines.slice(0, 12).map((line, i) => <tr key={i}>{line.split(sep).slice(0, 8).map((cell, j) => <td key={j} className={cell.trim() === '' ? 'is-empty' : undefined}>{cell.trim() === '' ? '—' : cell}</td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  if (item.kind === 'logs') {
    return (
      <pre className="ds-snippet ds-snippet--logs mono" aria-label={`First lines of ${item.filename}`}>
        {lines.map((line, i) => <div key={i} className={/\b(ERROR|FATAL)\b/.test(line) ? 'lvl-error' : /\bWARN(ING)?\b/.test(line) ? 'lvl-warn' : undefined}>{line || ' '}</div>)}
      </pre>
    );
  }
  return <pre className="ds-snippet mono" aria-label={`First lines of ${item.filename}`}>{lines.join('\n')}</pre>;
}

function Unavailable({ item, reason }) {
  return (
    <span className="ds-preview-empty">
      <Tile icon={KIND_ICON[item.kind] ?? 'data'} tone="plain" />
      <strong style={{ color: 'var(--text)' }}>{formatName(item.contentType)}</strong>
      <span>{reason}</span>
    </span>
  );
}

/**
 * The file itself where a browser can show it safely (images, video, audio, the start of text files),
 * otherwise an honest placeholder. Nothing here is generated: no stand-in waveforms or frames.
 */
export function Preview({ item, h = 140, controls = false, contain = false, localUrl }) {
  const [duration, setDuration] = useState(null);
  const url = localUrl ?? item.previewUrl;
  const media = ['image', 'video'].includes(item.kind) || (item.kind !== 'audio' && /^(image|video)\//.test(item.contentType));
  const cls = `ds-preview k-${item.kind}${media && url ? ' ds-preview--media' : ''}${contain ? ' ds-preview--contain' : ''}`;
  let body;
  if (!url) {
    body = <Unavailable item={item} reason={item.sizeBytes === 0 ? 'Empty file.' : TEXT_TYPES.includes(item.contentType) || /^(image|audio|video)\//.test(item.contentType) ? 'Previews need file storage, which is not configured here.' : 'No preview for this format yet. It is stored and versioned as is.'} />;
  } else if (item.contentType.startsWith('image/')) {
    body = <img src={url} alt={`${item.filename}`} loading="lazy" />;
  } else if (item.contentType.startsWith('video/')) {
    body = <video src={url} preload="metadata" muted playsInline controls={controls} aria-label={item.filename} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} />;
  } else if (item.contentType.startsWith('audio/')) {
    body = (
      <span className="ds-preview-empty" style={{ width: '100%' }}>
        <Tile icon="clock" tone="teal" />
        <strong style={{ color: 'var(--text)' }}>{formatName(item.contentType)} audio</strong>
        <audio src={url} preload="metadata" controls={controls} style={controls ? { width: '100%' } : { display: 'none' }} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} />
      </span>
    );
  } else if (localUrl) {
    body = <Unavailable item={item} reason="Shown after upload." />;
  } else {
    body = <Snippet item={item} />;
  }
  return (
    <span className={cls} style={{ '--h': `${h}px` }}>
      {body}
      {duration != null && Number.isFinite(duration) && !controls && <span className="ds-preview-meta">{fmtTime(duration)}</span>}
    </span>
  );
}
