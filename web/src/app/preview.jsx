import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tile } from './ui.jsx';
import { parseDelimited } from './csv.js';

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

// Text previews read only the first few kilobytes, once per file per page load. The cache and the state are both
// keyed by file id, so a late response for one file can never show up under another file's name.
const SNIPPET_BYTES = 4096;
const snippets = new Map();
function useSnippet(item) {
  const [state, setState] = useState(() => ({ id: item.id, value: snippets.get(item.id) ?? null }));
  useEffect(() => {
    if (snippets.has(item.id)) { setState({ id: item.id, value: snippets.get(item.id) }); return undefined; }
    setState({ id: item.id, value: null });
    if (!item.previewUrl) return undefined;
    let live = true;
    const id = item.id;
    fetch(item.previewUrl, { headers: { range: `bytes=0-${SNIPPET_BYTES - 1}` } })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => ({ text, cut: text.length >= SNIPPET_BYTES || item.sizeBytes > SNIPPET_BYTES }), () => ({ error: true }))
      .then((value) => {
        if (!value.error) snippets.set(id, value);
        if (live) setState({ id, value });
      });
    return () => { live = false; };
  }, [item.id, item.previewUrl, item.sizeBytes]);
  return state.id === item.id ? state.value : null;
}

function Snippet({ item }) {
  const snippet = useSnippet(item);
  if (!snippet) return <span className="ds-preview-empty">Loading preview…</span>;
  if (snippet.error) return <Unavailable item={item} reason="The preview could not be loaded. Reload the page to try again." />;
  if (/^text\/(csv|tab-separated-values)$/.test(item.contentType)) {
    const { rows } = parseDelimited(snippet.text, { separator: item.contentType === 'text/csv' ? ',' : '\t', maxRows: 12, cut: snippet.cut });
    return (
      <div className="ds-snippet mono" aria-label={`First rows of ${item.filename}`}>
        <table><tbody>{rows.map((cells, i) => <tr key={i}>{cells.slice(0, 8).map((cell, j) => <td key={j} className={cell.trim() === '' ? 'is-empty' : undefined}>{cell.trim() === '' ? '—' : cell.replace(/\s+/g, ' ')}</td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  const lines = snippet.text.split(/\r?\n/).slice(0, 40);
  if (snippet.cut && lines.length > 1) lines.pop(); // the last line may be cut mid-way
  if (item.kind === 'logs') {
    return (
      <pre className="ds-snippet ds-snippet--logs mono" aria-label={`First lines of ${item.filename}`}>
        {lines.map((line, i) => <div key={i} className={/\b(ERROR|FATAL)\b/.test(line) ? 'lvl-error' : /\bWARN(ING)?\b/.test(line) ? 'lvl-warn' : undefined}>{line || ' '}</div>)}
      </pre>
    );
  }
  return <pre className="ds-snippet mono" aria-label={`First lines of ${item.filename}`}>{lines.join('\n')}</pre>;
}

/**
 * An image fitted inside its frame, with box labels drawn over the pixels they mark. Boxes are fractions of the
 * image, so they line up whatever size it is shown at. `onDraw` turns on drawing a new box with the pointer.
 */
export function BoxedImage({ url, alt, boxes = [], selected, onSelect, onDraw }) {
  const frame = useRef(null);
  const [natural, setNatural] = useState(null);
  const [size, setSize] = useState(null);
  const [drag, setDrag] = useState(null);
  const [pending, setPending] = useState(null);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = natural && size ? (() => {
    const scale = Math.min(size.w / natural.w, size.h / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    return { w, h, left: (size.w - w) / 2, top: (size.h - h) / 2 };
  })() : null;
  const at = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rect = drag && { x: Math.min(drag.a.x, drag.b.x), y: Math.min(drag.a.y, drag.b.y), w: Math.abs(drag.b.x - drag.a.x), h: Math.abs(drag.b.y - drag.a.y) };
  return (
    <span ref={frame} className="ds-boxed">
      <img src={url} alt={alt} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} style={fit ? { width: fit.w, height: fit.h, left: fit.left, top: fit.top } : undefined} />
      {fit && (
        // One save at a time: a new box can be drawn only after the previous save has settled.
        <span className={`ds-box-layer${onDraw ? (pending ? ' is-busy' : ' is-drawing') : ''}`} style={{ width: fit.w, height: fit.h, left: fit.left, top: fit.top }}
          onPointerDown={onDraw ? (e) => { if (pending || e.button !== 0 || e.target !== e.currentTarget) return; e.currentTarget.setPointerCapture(e.pointerId); const p = at(e); setDrag({ a: p, b: p }); } : undefined}
          onPointerMove={drag ? (e) => setDrag({ ...drag, b: at(e) }) : undefined}
          onPointerUp={drag ? (e) => {
            // Use the release point too: a quick drag may end before any move event arrives.
            const b = at(e);
            const done = { x: Math.min(drag.a.x, b.x), y: Math.min(drag.a.y, b.y), w: Math.abs(b.x - drag.a.x), h: Math.abs(b.y - drag.a.y) };
            setDrag(null);
            // Keep a dashed "saving" outline until the server answers; it is never shown as saved before then.
            if (done.w > 0.01 && done.h > 0.01) { setPending(done); Promise.resolve(onDraw(done)).finally(() => setPending(null)); }
          } : undefined}
          onPointerCancel={drag ? () => setDrag(null) : undefined}>
          {boxes.map((b) => (
            <button key={b.id} type="button" className={`ds-box k-${b.label?.tone ?? 'plain'}`} aria-pressed={selected === b.id}
              aria-label={`${b.label?.name ?? 'Box'} at ${Math.round(b.x * 100)}%, ${Math.round(b.y * 100)}%`}
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
              onClick={onSelect ? () => onSelect(b.id) : undefined} tabIndex={onSelect ? 0 : -1}>
              <span>{b.label?.name ?? 'box'}</span>
            </button>
          ))}
          {pending && <span className="ds-box ds-box--draft ds-box--pending" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%`, width: `${pending.w * 100}%`, height: `${pending.h * 100}%` }} role="status" aria-label="Saving box"><span>Saving…</span></span>}
          {rect && <span className="ds-box ds-box--draft" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} aria-hidden="true" />}
        </span>
      )}
    </span>
  );
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
export function Preview({ item, h = 140, controls = false, contain = false, localUrl, boxes, placeholder }) {
  const [timing, setTiming] = useState({ id: null, ms: null });
  const setDuration = (ms) => setTiming({ id: item.id, ms });
  const duration = timing.id === item.id ? timing.ms : null;
  const url = localUrl ?? item.previewUrl;
  const media = ['image', 'video'].includes(item.kind) || (item.kind !== 'audio' && /^(image|video)\//.test(item.contentType));
  const cls = `ds-preview k-${item.kind}${media && url ? ' ds-preview--media' : ''}${contain ? ' ds-preview--contain' : ''}`;
  let body;
  if (!url && placeholder) {
    // A file still on its way (Import): say what will happen, not that storage is missing.
    body = <Unavailable item={item} reason={TEXT_TYPES.includes(item.contentType) || /^(image|audio|video)\//.test(item.contentType) ? placeholder : 'No preview for this format yet.'} />;
  } else if (!url) {
    body = <Unavailable item={item} reason={item.sizeBytes === 0 ? 'Empty file.' : TEXT_TYPES.includes(item.contentType) || /^(image|audio|video)\//.test(item.contentType) ? 'Previews need file storage, which is not configured here.' : 'No preview for this format yet. It is stored and versioned as is.'} />;
  } else if (item.contentType.startsWith('image/') && boxes?.length) {
    body = <BoxedImage key={item.id} url={url} alt={item.filename} boxes={boxes} />;
  } else if (item.contentType.startsWith('image/')) {
    body = <img key={item.id} src={url} alt={`${item.filename}`} loading="lazy" />;
  } else if (item.contentType.startsWith('video/')) {
    body = <video key={item.id} src={url} preload="metadata" muted playsInline controls={controls} aria-label={item.filename} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} />;
  } else if (item.contentType.startsWith('audio/')) {
    body = (
      <span className="ds-preview-empty" style={{ width: '100%' }}>
        <Tile icon="clock" tone="teal" />
        <strong style={{ color: 'var(--text)' }}>{formatName(item.contentType)} audio</strong>
        <audio key={item.id} src={url} preload="metadata" controls={controls} style={controls ? { width: '100%' } : { display: 'none' }} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} />
      </span>
    );
  } else if (localUrl) {
    body = <Unavailable item={item} reason="Shown after upload." />;
  } else {
    body = <Snippet key={item.id} item={item} />;
  }
  return (
    <span className={cls} style={{ '--h': `${h}px` }}>
      {body}
      {duration != null && Number.isFinite(duration) && !controls && <span className="ds-preview-meta">{fmtTime(duration)}</span>}
    </span>
  );
}
