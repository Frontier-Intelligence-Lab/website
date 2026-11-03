import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate, useParams, useRevalidator } from 'react-router';
import { api, uploadFile } from '../api.js';
import { Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural, roleName } from './shell.jsx';
import { KINDS, KIND_LABEL, KIND_ONE, TIMED, Preview, detectKind, fmtBytes, fmtTime, formatName } from './preview.jsx';

const STATUS = { draft: 'Working set · editable', changes_requested: 'Changes requested · editable', in_review: 'In review · locked', approved: 'Approved · locked', versioned: 'Version approved · locked' };
const TONES = ['violet', 'teal', 'blue', 'green', 'amber', 'orange', 'plain'];

// Preview links are signed for 30 minutes. Reusing a file's link while it is fresh keeps players and images
// from reloading every time the page data refreshes after a save.
const PREVIEW_REUSE_MS = 20 * 60 * 1000;
const previewLinks = new Map();
function stablePreview(item) {
  if (!item.previewUrl) return item;
  const seen = previewLinks.get(item.id);
  if (seen && Date.now() - seen.at < PREVIEW_REUSE_MS) return { ...item, previewUrl: seen.url };
  previewLinks.set(item.id, { url: item.previewUrl, at: Date.now() });
  return item;
}

export async function datasetLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const data = await api.dataset(entry.id, params.projectId);
  if (['model', 'unsure'].includes(data.project.startingPoint)) throw redirect(`/w/${entry.slug}/projects/${data.project.id}`);
  return { account, entry, ...data, items: data.items.map(stablePreview) };
}

/** Loader data plus the person's abilities and a helper that runs an API call and reloads the page data. */
function useDataset() {
  const data = useLoaderData();
  const revalidator = useRevalidator();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const writer = ['owner', 'admin', 'member'].includes(data.role);
  const canEdit = writer && data.editable;
  const act = useCallback(async (fn) => {
    setPending(true); setError(null);
    const res = await fn().catch(() => null);
    setPending(false);
    if (!res?.ok) { setError(res?.data.error ?? 'That did not work. Check your connection and try again.'); return null; }
    revalidator.revalidate();
    return res.data;
  }, [revalidator]);
  const base = `/w/${data.entry.slug}/projects/${data.project.id}`;
  const open = data.issues.filter((i) => i.open).length;
  return { ...data, writer, canEdit, act, error, setError, pending, base, open };
}

function DatasetShell({ d, current, eyebrow, title, lede, actions, children }) {
  return (
    <WorkspaceShell account={d.account} entry={d.entry} role={d.role} title={title === d.project.name ? `Dataset · ${title}` : `${title} · ${d.project.name}`} project={d.project} current={current} openIssues={d.open}>
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <span className="ob-eyebrow">{eyebrow}</span>
          <h1 className="ob-h1">{title}</h1>
          {lede && <p className="ob-lede">{lede}</p>}
        </div>
        {actions && <div>{actions}</div>}
      </div>
      {!d.writer && <p className="ob-alert ob-alert--info">You have {roleName(d.role)} access: you can look through this dataset and its previews, but not change it.</p>}
      {d.writer && !d.editable && <p className="ob-alert ob-alert--info"><strong>{STATUS[d.project.status]}.</strong> Files, labels and notes are frozen while the project is in review or approved. Reopen it from the <Link to={d.base}>project page</Link> to make changes.</p>}
      {d.error && <p className="ob-alert" role="alert">{d.error}</p>}
      {children}
    </WorkspaceShell>
  );
}

const shareBy = (items) => {
  const bytes = new Map();
  for (const it of items) bytes.set(it.kind, (bytes.get(it.kind) ?? 0) + Math.max(it.sizeBytes, 1));
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  return KINDS.filter((k) => bytes.has(k)).map((k) => ({ kind: k, count: items.filter((i) => i.kind === k).length, share: bytes.get(k) / total }));
};

function KindBar({ mix, dim }) {
  return (
    <div className="ds-bar" aria-hidden="true">
      {mix.map((m) => <span key={m.kind} className={`k-${m.kind}${dim && dim !== m.kind ? ' is-dim' : ''}`} style={{ flex: `${m.share} 1 0` }} />)}
    </div>
  );
}

const labelName = (labelSet, id) => labelSet.find((l) => l.id === id)?.name ?? 'removed label';
const memberName = (members, id) => members.find((m) => m.id === id)?.name ?? 'someone';

/* ---------------- Overview ---------------- */

export function DatasetOverview() {
  const d = useDataset();
  const navigate = useNavigate();
  const [kind, setKind] = useState(null);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(d.items[0]?.id ?? null);
  const [limit, setLimit] = useState(60);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const flagged = useMemo(() => new Set(d.issues.filter((i) => i.open && i.uploadId).flatMap((i) => (i.key.startsWith('unlabelled:') ? d.items.filter((it) => it.kind === i.kind && !it.duplicateOf && it.labelCount === 0).map((it) => it.id) : [i.uploadId]))), [d.issues, d.items]);
  const mix = shareBy(d.items);
  const visible = d.items.filter((it) => (!kind || it.kind === kind) && (!issuesOnly || flagged.has(it.id)));
  const sel = d.items.find((it) => it.id === selectedId) ?? visible[0] ?? null;
  const totalBytes = d.items.reduce((n, it) => n + it.sizeBytes, 0);
  const labels = sel ? d.annotations.filter((a) => a.uploadId === sel.id) : [];
  const original = sel?.duplicateOf ? d.items.find((it) => it.id === sel.duplicateOf) : null;

  async function download() {
    const res = await d.act(() => api.downloadUrl(d.entry.id, d.project.id, sel.id));
    if (res?.url) window.location.assign(res.url);
  }
  async function remove() {
    const ok = await d.act(() => api.deleteUpload(d.entry.id, d.project.id, sel.id));
    if (ok) { setConfirmRemove(false); setSelectedId(null); }
  }

  return (
    <DatasetShell d={d} current="dataset" eyebrow={`Dataset · ${d.entry.name}`} title={d.project.name} lede={d.project.task}
      actions={<>
        <Link className="btn-ghost" to={`${d.base}/dataset/annotate`}>Annotate</Link>
        {d.open > 0 && <Link className="btn-ghost" to={`${d.base}/dataset/resolve`} style={{ borderColor: 'var(--t-orange)', color: 'var(--t-orange)' }}>{d.open} to resolve before review</Link>}
        {d.canEdit && <Link className="btn-app" to={`${d.base}/dataset/import`}><Icon name="upload" size={16} />Import data</Link>}
      </>}>
      <div className="ob-chips" style={{ marginTop: -12 }}>
        <span className={`ob-badge ${d.editable ? 'tile--blue' : ''}`}>{STATUS[d.project.status] ?? d.project.status}</span>
        <span className="ob-badge">{plural(d.items.length, 'file')} · {fmtBytes(totalBytes)}</span>
        <span className="ob-badge">{d.versions.length ? `Latest version: v${d.versions.at(-1).number}` : 'No versions yet'}</span>
      </div>

      {d.items.length === 0 ? (
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="upload" tone="teal" size="lg" />
          <h2>No files yet</h2>
          <p className="ob-muted">Import video, audio, images, text, tables, sensor readings, robot recordings or logs. Each file is checked, hashed and stored privately to this workspace.</p>
          {d.canEdit ? <Link className="btn-app" to={`${d.base}/dataset/import`}>Import data</Link> : <p className="ob-muted">Someone who can edit this project can import files.</p>}
        </section>
      ) : (
        <>
          <section className="ob-card" aria-label="Composition" style={{ gap: 14 }}>
            <div className="row-between"><h2>What’s in it</h2><span className="ob-muted">share of storage by data type</span></div>
            <KindBar mix={mix} dim={kind} />
            <div className="ob-chips" role="group" aria-label="Filter by data type">
              <button type="button" className="ob-chip ds-chip" aria-pressed={!kind && !issuesOnly} onClick={() => { setKind(null); setIssuesOnly(false); }}>All · {d.items.length}</button>
              {mix.map((m) => (
                <button key={m.kind} type="button" className={`ob-chip ds-chip k-${m.kind}`} aria-pressed={kind === m.kind} onClick={() => setKind(kind === m.kind ? null : m.kind)}>
                  <span className="ds-dot" aria-hidden="true" />{KIND_LABEL[m.kind]} <span className="ob-muted">{m.count}</span>
                </button>
              ))}
              {flagged.size > 0 && <button type="button" className="ob-chip ds-chip k-orange" aria-pressed={issuesOnly} onClick={() => setIssuesOnly(!issuesOnly)} style={{ borderStyle: issuesOnly ? 'solid' : 'dashed' }}>Needs attention · {flagged.size}</button>}
            </div>
          </section>

          <div className="ds-split">
            <section className="ds-main" aria-label="Files">
              {visible.length === 0 ? <p className="ob-muted">Nothing matches this filter.</p> : (
                <div className="ds-grid">
                  {visible.slice(0, limit).map((it) => (
                    <button key={it.id} type="button" className={`ds-card k-${it.kind}`} aria-pressed={sel?.id === it.id} onClick={() => setSelectedId(it.id)}>
                      <Preview item={it} h={140} />
                      <span className="ds-card-body">
                        <span className="ds-card-name"><span className="ds-dot" aria-hidden="true" /><span>{it.filename}</span></span>
                        <span className="ob-muted" style={{ fontSize: 12.5 }}>{KIND_ONE[it.kind]} · {formatName(it.contentType)} · {fmtBytes(it.sizeBytes)}</span>
                        {it.duplicateOf ? <span className="tone-warn" style={{ fontSize: 12.5 }}>Duplicate · not reviewed twice</span>
                          : flagged.has(it.id) ? <span className="tone-warn" style={{ fontSize: 12.5 }}>{it.labelCount ? 'Needs attention' : 'No labels yet'}</span>
                            : <span className="tone-ok" style={{ fontSize: 12.5 }}>{plural(it.labelCount, 'label')}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="row-between ob-muted" style={{ flexWrap: 'wrap' }}>
                <span>Showing {Math.min(limit, visible.length)} of {visible.length}{visible.length !== d.items.length ? ` (${d.items.length} in all)` : ''}</span>
                {visible.length > limit && <button type="button" className="btn-small" onClick={() => setLimit(limit + 60)}>Show more</button>}
                <span>Content verification: method not chosen yet</span>
              </div>
            </section>

            {sel && (
              <aside className="ob-card ob-card--shadow ds-side ds-inspector" aria-label="Selected file" style={{ flex: '1 1 340px' }}>
                <Preview item={sel} h={230} controls contain />
                <div className="card--pad">
                  <div className="cell-stack" style={{ gap: 6 }}>
                    <span className={`ds-badge k-${sel.kind}`} style={{ alignSelf: 'flex-start' }}>{KIND_ONE[sel.kind]}{sel.chosenKind ? ' · set by hand' : ''}</span>
                    <strong style={{ fontSize: 17, overflowWrap: 'anywhere' }}>{sel.filename}</strong>
                  </div>
                  <dl className="ds-dl">
                    <dt>Format</dt><dd>{formatName(sel.contentType)} <span className="ob-muted">({sel.contentType})</span></dd>
                    <dt>Size</dt><dd>{fmtBytes(sel.sizeBytes)}</dd>
                    <dt>SHA-256</dt><dd className="mono" style={{ fontSize: 12 }} title={sel.sha256}>{sel.sha256.slice(0, 16)}…</dd>
                    <dt>Imported</dt><dd>{new Date(sel.createdAt).toLocaleString()} by {memberName(d.members, sel.uploadedBy)}</dd>
                    {sel.offsetMs != null && <><dt>Clock offset</dt><dd>{sel.offsetMs > 0 ? '+' : ''}{(sel.offsetMs / 1000).toFixed(1)} s</dd></>}
                  </dl>
                  {d.canEdit && (
                    <label className="ob-field" style={{ gap: 6 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>Data type</span>
                      <select className="ds-select" value={sel.chosenKind ?? ''} disabled={d.pending} onChange={(e) => d.act(() => api.updateItem(d.entry.id, d.project.id, sel.id, { kind: e.target.value || null }))}>
                        <option value="">Detected: {KIND_ONE[sel.detectedKind]}</option>
                        {KINDS.filter((k) => k !== sel.detectedKind).map((k) => <option key={k} value={k}>{KIND_ONE[k]}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="card-rule cell-stack" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 14 }}>Labels</strong>
                    <div className="ob-chips" style={{ gap: 6 }}>
                      {labels.length === 0 ? <span className="ob-badge">none yet</span> : labels.map((a) => {
                        const l = d.labelSet.find((x) => x.id === a.labelId);
                        return <span key={a.id} className={`ds-badge k-${l?.tone ?? 'plain'}`}>{labelName(d.labelSet, a.labelId)}{a.startMs != null ? ` ${fmtTime(a.startMs)}–${fmtTime(a.endMs)}` : ''}</span>;
                      })}
                    </div>
                  </div>
                  <div className="card-rule cell-stack" style={{ gap: 6 }}>
                    <strong style={{ fontSize: 14 }}>File checks</strong>
                    <span className="tone-ok" style={{ fontSize: 13.5 }}>✓ Type read from the file’s bytes: {formatName(sel.contentType)}</span>
                    <span className="tone-ok" style={{ fontSize: 13.5 }}>✓ SHA-256 recorded at import</span>
                    {original && <span className="tone-warn" style={{ fontSize: 13.5 }}>! Same content as {original.filename}</span>}
                    {sel.sizeBytes === 0 && <span className="tone-warn" style={{ fontSize: 13.5 }}>! Empty file</span>}
                    <span className="ob-muted" style={{ fontSize: 12.5 }}>A checksum proves the file has not changed since import. It does not prove you may use it.</span>
                  </div>
                  <div className="ob-row-actions">
                    <button type="button" className="btn-app" onClick={() => navigate(`${d.base}/dataset/annotate/${sel.id}`)}>{TIMED.includes(sel.kind) ? 'Open in annotator' : 'Label this file'}</button>
                    {d.writer && d.uploadsEnabled && <button type="button" className="btn-ghost" onClick={download} disabled={d.pending}><Icon name="download" size={16} />Download</button>}
                    {d.canEdit && !confirmRemove && <button type="button" className="btn-text" onClick={() => setConfirmRemove(true)}>Remove</button>}
                  </div>
                  {confirmRemove && (
                    <div className="ob-alert" role="alert">
                      <p style={{ margin: '0 0 10px' }}>Remove {sel.filename} and its {plural(labels.length, 'label')} from the working set? Versions already approved keep their copy.</p>
                      <div className="ob-row-actions"><button type="button" className="btn-app" disabled={d.pending} onClick={remove}>Remove file</button><button type="button" className="btn-text" onClick={() => setConfirmRemove(false)}>Cancel</button></div>
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        </>
      )}
    </DatasetShell>
  );
}

/* ---------------- Annotate ---------------- */

const FRAME_MS = 1000 / 30;

function LabelSetEditor({ d }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('span');
  const [tone, setTone] = useState(TONES[d.labelSet.length % TONES.length]);
  const [open, setOpen] = useState(d.labelSet.length === 0);
  const used = new Set(d.annotations.map((a) => a.labelId));
  const save = (labels) => d.act(() => api.setLabelSet(d.entry.id, d.project.id, labels));
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await save([...d.labelSet, { name: name.trim(), scope, tone }]);
    if (ok) { setName(''); setTone(TONES[(d.labelSet.length + 1) % TONES.length]); }
  }
  return (
    <details className="ob-card" style={{ padding: '0 18px' }} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Edit label set · {plural(d.labelSet.length, 'label')}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 16 }}>
        {d.labelSet.map((l) => (
          <div key={l.id} className={`row-between k-${l.tone}`} style={{ gap: 10 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><span className="ds-swatch" aria-hidden="true" /><strong style={{ fontSize: 14 }}>{l.name}</strong><span className="ob-muted" style={{ fontSize: 12 }}>{l.scope === 'span' ? 'time span' : 'whole file'}</span></span>
            {used.has(l.id) ? <span className="ob-muted" style={{ fontSize: 12 }}>in use</span>
              : <button type="button" className="btn-text" disabled={d.pending} onClick={() => save(d.labelSet.filter((x) => x.id !== l.id))} aria-label={`Remove label ${l.name}`}>Remove</button>}
          </div>
        ))}
        <form onSubmit={add} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input type="text" aria-label="New label name" placeholder="New label, e.g. damaged pallet" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 180px', minHeight: 38 }} />
          <select className="ds-select" aria-label="What it marks" value={scope} onChange={(e) => setScope(e.target.value)}><option value="span">Time span</option><option value="file">Whole file</option></select>
          <select className="ds-select" aria-label="Colour" value={tone} onChange={(e) => setTone(e.target.value)}>{TONES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <button type="submit" className="btn-small" disabled={d.pending || !name.trim()}>Add label</button>
        </form>
      </div>
    </details>
  );
}

// Real waveform from the decoded audio, computed in the browser. Skipped for large files rather than faked.
const waveforms = new Map();
function useWaveform(item) {
  const [peaks, setPeaks] = useState(() => waveforms.get(item?.id) ?? null);
  useEffect(() => {
    if (!item?.previewUrl || item.kind !== 'audio' || item.sizeBytes > 40 * 1048576 || waveforms.has(item.id)) return undefined;
    let live = true;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return undefined;
    fetch(item.previewUrl).then((r) => r.arrayBuffer()).then((buf) => new Ctx().decodeAudioData(buf)).then((audio) => {
      const ch = audio.getChannelData(0);
      const n = 240;
      const step = Math.max(1, Math.floor(ch.length / n));
      const out = [];
      for (let i = 0; i < n; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 16) max = Math.max(max, Math.abs(ch[j]));
        out.push(max);
      }
      const top = Math.max(...out, 0.0001);
      const value = out.map((v) => v / top);
      waveforms.set(item.id, value);
      if (live) setPeaks(value);
    }).catch(() => {});
    return () => { live = false; };
  }, [item?.id, item?.previewUrl, item?.kind, item?.sizeBytes]);
  return peaks;
}

function Lane({ item, d, span, offset, duration, selected, onSelect, onSeek, time, draftFrom }) {
  const peaks = useWaveform(item);
  const pct = (ms) => `${Math.max(0, Math.min(100, ((ms + offset) / span) * 100))}%`;
  const segs = d.annotations.filter((a) => a.uploadId === item.id && a.startMs != null);
  const end = duration != null ? ((duration + offset) / span) * 100 : null;
  return (
    <div className={`ds-track k-${item.kind}`}>
      <div className="ds-track-head">
        <strong><span className="ds-dot" aria-hidden="true" />{item.filename}</strong>
        <span className="ob-muted" style={{ fontSize: 12 }}>{KIND_ONE[item.kind]}{offset ? ` · offset ${offset > 0 ? '+' : ''}${(offset / 1000).toFixed(1)} s` : ''}</span>
      </div>
      <div className="ds-lane" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * span); }} role="presentation">
        {peaks && <span className="ds-wave" aria-hidden="true" style={{ left: pct(0), right: end != null ? `${Math.max(0, 100 - end)}%` : 0 }}>{peaks.map((p, i) => <span key={i} style={{ height: `${Math.max(4, p * 100)}%` }} />)}</span>}
        {end != null && end < 100 && <span className="ds-out-of-range" style={{ left: `${end}%` }} aria-hidden="true" />}
        {segs.map((a) => {
          const l = d.labelSet.find((x) => x.id === a.labelId);
          return (
            <button key={a.id} type="button" className={`ds-seg k-${l?.tone ?? 'plain'}`} aria-pressed={selected === a.id}
              aria-label={`${l?.name ?? 'label'} from ${fmtTime(a.startMs)} to ${fmtTime(a.endMs)}`}
              style={{ left: pct(a.startMs), width: `max(6px, calc(${pct(a.endMs)} - ${pct(a.startMs)}))` }}
              onClick={(e) => { e.stopPropagation(); onSelect(a); }}>{l?.name ?? 'label'}</button>
          );
        })}
        {draftFrom != null && <span className="ds-seg ds-seg--draft" style={{ left: pct(draftFrom), width: `max(2px, calc(${pct(time)} - ${pct(draftFrom)}))` }} aria-hidden="true" />}
        <span className="ds-playhead" style={{ left: pct(time) }} aria-hidden="true" />
      </div>
    </div>
  );
}

export function DatasetAnnotate() {
  const d = useDataset();
  const navigate = useNavigate();
  const params = useParams();
  const files = d.items.filter((it) => !it.duplicateOf);
  const playableItem = (it) => it.previewUrl && /^(video|audio)\//.test(it.contentType);
  const item = files.find((it) => it.id === params.uploadId) ?? files.find(playableItem) ?? files.find((it) => TIMED.includes(it.kind)) ?? files[0] ?? null;
  const spanLabels = d.labelSet.filter((l) => l.scope === 'span');
  const fileLabels = d.labelSet.filter((l) => l.scope === 'file');
  const [tool, setTool] = useState(spanLabels[0]?.id ?? null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [markIn, setMarkIn] = useState(null);
  const [selected, setSelected] = useState(null);
  const [extra, setExtra] = useState([]);
  const [lengths, setLengths] = useState({});
  const [manual, setManual] = useState({ from: '', to: '' });
  const media = useRef(null);
  const followers = useRef({});
  const playable = item && item.previewUrl && /^(video|audio)\//.test(item.contentType);
  const timed = item && TIMED.includes(item.kind);
  const others = files.filter((it) => it.id !== item?.id && TIMED.includes(it.kind));
  const tracks = [item, ...extra.map((id) => others.find((o) => o.id === id)).filter(Boolean)].filter(Boolean);
  const offsetOf = (it) => (it.offsetMs ?? 0) - (item?.offsetMs ?? 0);
  const lengthOf = (t) => (t.id === item?.id ? duration : lengths[t.id] ?? null);
  const ends = tracks.slice(1).map((t) => (lengthOf(t) != null ? lengthOf(t) + offsetOf(t) : null)).filter((v) => v != null);
  const span = Math.max(duration ?? 0, ...ends, ...d.annotations.filter((a) => tracks.some((t) => t.id === a.uploadId) && a.endMs != null).map((a) => a.endMs + offsetOf(tracks.find((t) => t.id === a.uploadId))), 10000);
  const selectedAnn = d.annotations.find((a) => a.id === selected) ?? null;

  useEffect(() => { setTime(0); setDuration(null); setMarkIn(null); setSelected(null); setPlaying(false); }, [item?.id]);
  useEffect(() => { if (!tool && spanLabels[0]) setTool(spanLabels[0].id); }, [tool, spanLabels]);

  const seek = useCallback((ms) => {
    const next = Math.max(0, duration != null ? Math.min(duration, ms) : ms);
    setTime(next);
    if (media.current) media.current.currentTime = next / 1000;
  }, [duration]);
  const togglePlay = useCallback(() => {
    const el = media.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }, []);
  const addSpan = useCallback(async (from, to, labelId = tool) => {
    if (!labelId) return d.setError('Add a time-span label to the label set first.');
    const [a, b] = from <= to ? [from, to] : [to, from];
    const res = await d.act(() => api.annotate(d.entry.id, d.project.id, item.id, { labelId, startMs: Math.round(a), endMs: Math.round(Math.max(b, a + 1)) }));
    if (res) { setMarkIn(null); setSelected(res.annotation.id); }
  }, [d, item, tool]);

  // Secondary tracks play along, shifted by their clock offset.
  useEffect(() => {
    for (const t of tracks.slice(1)) {
      const el = followers.current[t.id];
      if (!el) continue;
      const at = (time - offsetOf(t)) / 1000;
      if (at < 0 || (el.duration && at > el.duration)) { if (!el.paused) el.pause(); continue; }
      if (Math.abs(el.currentTime - at) > 0.25) el.currentTime = at;
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  });

  useEffect(() => {
    if (!d.canEdit && !playable) return undefined;
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea, [contenteditable]')) return;
      if (e.key === ' ' && playable) { e.preventDefault(); togglePlay(); }
      else if (e.key === ',' && playable) seek(time - FRAME_MS);
      else if (e.key === '.' && playable) seek(time + FRAME_MS);
      else if ((e.key === 'i' || e.key === 'I') && d.canEdit && timed) setMarkIn(time);
      else if ((e.key === 'o' || e.key === 'O') && d.canEdit && timed && markIn != null) addSpan(markIn, time);
      else if (/^[1-9]$/.test(e.key) && spanLabels[Number(e.key) - 1]) setTool(spanLabels[Number(e.key) - 1].id);
      else if (e.key === 'Escape') setMarkIn(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d.canEdit, playable, timed, time, markIn, spanLabels, togglePlay, seek, addSpan]);

  if (!item) {
    return (
      <DatasetShell d={d} current="annotate" eyebrow={`Annotate · ${d.project.name}`} title="Annotate">
        <LabelSetEditor d={d} />
        <section className="ob-card"><h2>Nothing to label yet</h2><p className="ob-muted">Import files first, then label them here.</p>{d.canEdit && <Link className="btn-app" to={`${d.base}/dataset/import`} style={{ alignSelf: 'flex-start' }}>Import data</Link>}</section>
      </DatasetShell>
    );
  }
  const i = files.indexOf(item);
  const go = (it) => navigate(`${d.base}/dataset/annotate/${it.id}`);
  const fileTags = d.annotations.filter((a) => a.uploadId === item.id && a.startMs == null);
  const toggleTag = (l) => {
    const existing = fileTags.find((a) => a.labelId === l.id);
    return d.act(() => (existing ? api.deleteAnnotation(d.entry.id, d.project.id, existing.id) : api.annotate(d.entry.id, d.project.id, item.id, { labelId: l.id })));
  };
  const saveOffset = (t, seconds) => {
    const ms = Math.round(Number(seconds) * 1000) + (item.offsetMs ?? 0);
    if (Number.isFinite(ms)) d.act(() => api.updateItem(d.entry.id, d.project.id, t.id, { offsetMs: ms }));
  };

  return (
    <DatasetShell d={d} current="annotate" eyebrow={`Annotate · ${d.project.name}`} title={item.filename}
      actions={<>
        <select className="ds-select" aria-label="Choose a file" value={item.id} onChange={(e) => go(files.find((f) => f.id === e.target.value))} style={{ maxWidth: 260 }}>
          {files.map((f) => <option key={f.id} value={f.id}>{KIND_ONE[f.kind]} · {f.filename}</option>)}
        </select>
        <button type="button" className="btn-ghost" disabled={i <= 0} onClick={() => go(files[i - 1])}>Previous</button>
        <button type="button" className="btn-app" disabled={i >= files.length - 1} onClick={() => go(files[i + 1])}>Next file <Icon name="arrow" size={16} /></button>
      </>}>
      <div className="ds-split">
        <section className="ds-main" aria-label="Player">
          {playable ? (
            <div className={`ds-stage${item.contentType.startsWith('audio/') ? ' ds-stage--audio' : ''}`}>
              {item.contentType.startsWith('video/')
                ? <video ref={media} src={item.previewUrl} preload="auto" playsInline aria-label={item.filename} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime * 1000)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={togglePlay} />
                : <audio ref={media} src={item.previewUrl} preload="auto" controls onLoadedMetadata={(e) => setDuration(e.currentTarget.duration * 1000)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime * 1000)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />}
            </div>
          ) : (
            <div className="ob-card" style={{ padding: 0, overflow: 'hidden' }}><Preview item={item} h={320} contain controls /></div>
          )}
          {playable && (
            <div className="ds-transport">
              <button type="button" className="btn-small" onClick={() => seek(time - 5000)} aria-label="Back 5 seconds">−5s</button>
              <button type="button" className="btn-app" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} style={{ minWidth: 56 }}><Icon name={playing ? 'pause' : 'play'} size={16} stroke={2.2} /></button>
              <button type="button" className="btn-small" onClick={() => seek(time + 5000)} aria-label="Forward 5 seconds">+5s</button>
              <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{fmtTime(time, true)} <span className="ob-muted">/ {fmtTime(duration)}</span></span>
              {d.canEdit && timed && (markIn == null
                ? <button type="button" className="btn-small" onClick={() => setMarkIn(time)} disabled={!tool}>Mark in (I)</button>
                : <><button type="button" className="btn-small" onClick={() => addSpan(markIn, time)} style={{ borderColor: 'var(--t-blue)', color: 'var(--t-blue)' }}>Mark out (O) · from {fmtTime(markIn, true)}</button><button type="button" className="btn-text" onClick={() => setMarkIn(null)}>Cancel</button></>)}
              <span className="ds-kbd-help" style={{ marginLeft: 'auto' }}>Space play · , . frame · I/O in and out · 1–9 label</span>
            </div>
          )}
          {!playable && timed && d.canEdit && spanLabels.length > 0 && (
            <form className="ob-card" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }} onSubmit={(e) => { e.preventDefault(); addSpan(Number(manual.from) * 1000, Number(manual.to) * 1000); setManual({ from: '', to: '' }); }}>
              <div className="ob-field" style={{ flex: '1 1 100%' }}><strong style={{ fontSize: 14 }}>Mark a span by time</strong><span className="ob-muted">This format has no player here yet, so enter the times in seconds from the start of the recording.</span></div>
              <label className="ob-field" style={{ gap: 4 }}><span style={{ fontSize: 13 }}>From (s)</span><input type="text" inputMode="decimal" value={manual.from} onChange={(e) => setManual({ ...manual, from: e.target.value })} style={{ width: 110, minHeight: 38 }} /></label>
              <label className="ob-field" style={{ gap: 4 }}><span style={{ fontSize: 13 }}>To (s)</span><input type="text" inputMode="decimal" value={manual.to} onChange={(e) => setManual({ ...manual, to: e.target.value })} style={{ width: 110, minHeight: 38 }} /></label>
              <button type="submit" className="btn-small" disabled={d.pending || manual.from === '' || manual.to === '' || !tool}>Add span</button>
            </form>
          )}
        </section>

        <aside className="ds-side" aria-label="Labels">
          <section className="ob-card" style={{ gap: 10 }}>
            <div className="row-between"><h2>Label set</h2>{spanLabels.length > 0 && timed && <span className="ob-muted">press a number to pick</span>}</div>
            {d.labelSet.length === 0 && <p className="ob-muted">No labels yet. {d.canEdit ? 'Add the labels this dataset uses below.' : 'An editor defines them.'}</p>}
            {timed && spanLabels.map((l, n) => (
              <button key={l.id} type="button" className={`ds-palette-item k-${l.tone}`} aria-pressed={tool === l.id} onClick={() => setTool(l.id)}>
                <span className="ds-swatch" aria-hidden="true" />{l.name}<span className="ob-muted" style={{ fontSize: 12, fontWeight: 500 }}>span</span>{n < 9 && <kbd>{n + 1}</kbd>}
              </button>
            ))}
            {fileLabels.length > 0 && (
              <div className="cell-stack" style={{ gap: 8, paddingTop: timed && spanLabels.length ? 8 : 0 }}>
                <strong style={{ fontSize: 13.5 }}>Whole-file labels</strong>
                <div className="ob-chips" style={{ gap: 6 }}>
                  {fileLabels.map((l) => <button key={l.id} type="button" className={`ob-chip ds-chip k-${l.tone}`} aria-pressed={fileTags.some((a) => a.labelId === l.id)} disabled={!d.canEdit || d.pending} onClick={() => toggleTag(l)}><span className="ds-dot" aria-hidden="true" />{l.name}</button>)}
                </div>
              </div>
            )}
            {!timed && spanLabels.length > 0 && <p className="ob-muted">{KIND_ONE[item.kind]} files have no timeline, so only whole-file labels apply.</p>}
          </section>
          {d.canEdit && <LabelSetEditor d={d} />}
          {selectedAnn && (
            <section className="ob-card" style={{ gap: 12 }}>
              <span className="ob-muted" style={{ fontSize: 12, fontWeight: 600 }}>Selected</span>
              <strong style={{ fontSize: 17 }}>{labelName(d.labelSet, selectedAnn.labelId)}</strong>
              <dl className="ds-dl" style={{ gridTemplateColumns: '96px minmax(0, 1fr)' }}>
                <dt>File</dt><dd>{d.items.find((it) => it.id === selectedAnn.uploadId)?.filename}</dd>
                <dt>Span</dt><dd className="mono">{fmtTime(selectedAnn.startMs, true)} → {fmtTime(selectedAnn.endMs, true)} ({((selectedAnn.endMs - selectedAnn.startMs) / 1000).toFixed(1)} s)</dd>
                <dt>Marked by</dt><dd>{memberName(d.members, selectedAnn.createdBy)}</dd>
              </dl>
              <div className="ob-row-actions">
                <button type="button" className="btn-small" onClick={() => seek(selectedAnn.startMs + offsetOf(d.items.find((it) => it.id === selectedAnn.uploadId)))}>Jump to start</button>
                {d.canEdit && selectedAnn.uploadId === item.id && <button type="button" className="btn-small" style={{ color: 'var(--t-orange)' }} disabled={d.pending} onClick={async () => { if (await d.act(() => api.deleteAnnotation(d.entry.id, d.project.id, selectedAnn.id))) setSelected(null); }}>Delete</button>}
              </div>
            </section>
          )}
        </aside>
      </div>

      {timed && (
        <section className="card ds-tracks" aria-label="Synced tracks">
          <div className="ds-tracks-inner">
            <div className="card-head" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <h2>Tracks · aligned by clock offset</h2>
              {others.length > 0 && (
                <select className="ds-select" aria-label="Add a track" value="" onChange={(e) => e.target.value && setExtra([...extra, e.target.value])}>
                  <option value="">Add a synced track…</option>
                  {others.filter((o) => !extra.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{KIND_ONE[o.kind]} · {o.filename}</option>)}
                </select>
              )}
            </div>
            <div className="ds-ruler">
              <div className="ds-track-head" />
              <div className="ds-lane" role="presentation" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * span); }}>
                {Array.from({ length: 11 }, (_, n) => <span key={n} className="ds-tick mono" style={{ left: `${n * 10}%` }}>{fmtTime((span * n) / 10)}</span>)}
              </div>
            </div>
            {tracks.map((t) => (
              <Lane key={t.id} item={t} d={d} span={span} offset={offsetOf(t)} duration={lengthOf(t)} selected={selected} time={time}
                draftFrom={t.id === item.id ? markIn : null} onSelect={(a) => setSelected(a.id)} onSeek={seek} />
            ))}
            {tracks.slice(1).map((t) => t.previewUrl && /^(video|audio)\//.test(t.contentType) && (
              <audio key={t.id} ref={(el) => { followers.current[t.id] = el; }} src={t.previewUrl} preload="auto" muted={t.contentType.startsWith('video/')} style={{ display: 'none' }} onLoadedMetadata={(e) => { const ms = e.currentTarget.duration * 1000; setLengths((all) => ({ ...all, [t.id]: ms })); }} />
            ))}
            {extra.length > 0 && (
              <div className="card-foot" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
                <span className="ob-muted">Offsets, relative to {item.filename}:</span>
                {tracks.slice(1).map((t) => (
                  <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    {t.filename}
                    <input type="text" inputMode="decimal" aria-label={`Offset of ${t.filename} in seconds`} defaultValue={(offsetOf(t) / 1000).toFixed(1)} disabled={!d.canEdit}
                      onBlur={(e) => Number(e.target.value) * 1000 !== offsetOf(t) && saveOffset(t, e.target.value)} style={{ width: 80, minHeight: 34 }} />
                    s
                    <button type="button" className="btn-text" onClick={() => setExtra(extra.filter((x) => x !== t.id))}>Hide</button>
                  </label>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </DatasetShell>
  );
}

/* ---------------- Resolve ---------------- */

const GROUPS = [
  { id: 'files', title: 'File problems', sub: 'found by checks at import', tone: 'orange' },
  { id: 'labels', title: 'Labels', sub: 'what your label set needs', tone: 'violet' },
  { id: 'rights', title: 'Rights and source', sub: 'only you can answer these', tone: 'blue' },
];

function IssueCard({ d, issue }) {
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState('');
  const item = issue.uploadId ? d.items.find((it) => it.id === issue.uploadId) : null;
  const fixTo = issue.fix && ({ data: `${d.base}/data`, import: `${d.base}/dataset/import`, annotate: `${d.base}/dataset/annotate${issue.fix.uploadId ? `/${issue.fix.uploadId}` : ''}` })[issue.fix.page];
  const saveNote = async (e) => {
    e.preventDefault();
    if (await d.act(() => api.noteIssue(d.entry.id, d.project.id, issue.key, note))) { setWriting(false); setNote(''); }
  };
  return (
    <div className={`ob-card ds-issue${issue.open ? '' : ' ds-issue--done'}`}>
      {item && <div className="ds-issue-thumb"><Preview item={item} h={96} /></div>}
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {item && <div className="row-wrap gap-10"><span className={`ds-badge k-${item.kind}`}>{KIND_ONE[item.kind]}</span><strong style={{ fontSize: 14.5, overflowWrap: 'anywhere' }}>{item.filename}</strong></div>}
        <span style={{ fontSize: 15, fontWeight: 600 }}>{issue.title}</span>
        <span className="ob-muted">{issue.detail}</span>
        {issue.note && <span className="ob-ok" style={{ fontSize: 13.5 }}><Icon name="check" size={14} stroke={2.6} />Kept, with a note: “{issue.note}”</span>}
        {d.canEdit && (
          <div className="ob-row-actions" style={{ paddingTop: 4 }}>
            {issue.note ? <button type="button" className="btn-text" disabled={d.pending} onClick={() => d.act(() => api.deleteIssueNote(d.entry.id, d.project.id, issue.key))}>Remove note</button> : <>
              {fixTo && <Link className="btn-app" to={fixTo} style={{ minHeight: 38, fontSize: 13 }}>{issue.fix.label}</Link>}
              {issue.remove && item && <button type="button" className="btn-app" style={{ minHeight: 38, fontSize: 13 }} disabled={d.pending} onClick={() => d.act(() => api.deleteUpload(d.entry.id, d.project.id, item.id))}>Remove this file</button>}
              {!issue.blocking && !writing && <button type="button" className="btn-ghost" style={{ minHeight: 38, fontSize: 13 }} onClick={() => setWriting(true)}>Keep it, add a note</button>}
            </>}
          </div>
        )}
        {writing && (
          <form onSubmit={saveNote} className="ob-field" style={{ gap: 8 }}>
            <label htmlFor={`note-${issue.key}`} style={{ fontSize: 13.5, fontWeight: 600 }}>Why does this stay? Staff read this note.</label>
            <textarea id={`note-${issue.key}`} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="ob-row-actions"><button type="submit" className="btn-app" style={{ minHeight: 38, fontSize: 13 }} disabled={d.pending || !note.trim()}>Save note</button><button type="button" className="btn-text" onClick={() => setWriting(false)}>Cancel</button></div>
          </form>
        )}
      </div>
    </div>
  );
}

export function DatasetResolve() {
  const d = useDataset();
  const navigate = useNavigate();
  const total = d.issues.length;
  const files = d.items.filter((it) => !it.duplicateOf);
  const reviewable = d.project.dataSource && d.editable;
  async function send() {
    if (await d.act(() => api.submitReview(d.entry.id, d.project.id))) navigate(d.base);
  }
  return (
    <DatasetShell d={d} current="resolve" eyebrow={`Resolve · ${d.project.name}`} title="Resolve before review"
      lede="Valcairn staff review the working set as one snapshot. Fix what you can, or keep it with a note that says why."
      actions={total > 0 && (
        <div className="progress-row" style={{ minWidth: 240 }}>
          <div className="row-between"><span className="ob-muted">Open</span><strong style={{ fontSize: 20 }}>{d.open} <span className="ob-muted" style={{ fontSize: 14, fontWeight: 500 }}>of {total}</span></strong></div>
          <div className="bar bar--thick"><span style={{ width: `${((total - d.open) / total) * 100}%` }} /></div>
        </div>
      )}>
      <div className="ds-split">
        <section className="ds-main" aria-label="Issues" style={{ gap: 22 }}>
          {total === 0 && <section className="ob-card"><Tile icon="check" tone="green" /><h2>Nothing to resolve</h2><p className="ob-muted">Every file passed its checks and every question has an answer.</p></section>}
          {GROUPS.map((g) => {
            const list = d.issues.filter((i) => i.group === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} className={`k-${g.tone}`}><span className="ds-dot" aria-hidden="true" /><h2 style={{ fontSize: 16, fontWeight: 600 }}>{g.title}</h2><span className="ob-muted">{g.sub}</span></div>
                {list.map((issue) => <IssueCard key={issue.key} d={d} issue={issue} />)}
              </div>
            );
          })}
        </section>
        <aside className="ds-side" aria-label="Review readiness">
          <section className="ob-card ob-card--shadow" style={{ gap: 14 }}>
            <h2>What review will receive</h2>
            {files.length > 0 && <KindBar mix={shareBy(files)} />}
            <dl className="ds-dl" style={{ gridTemplateColumns: '1fr auto' }}>
              <dt>Files</dt><dd style={{ fontWeight: 600 }}>{files.length} <span className="ob-muted" style={{ fontWeight: 400 }}>· {fmtBytes(files.reduce((n, f) => n + f.sizeBytes, 0))}</span></dd>
              <dt>Duplicates left out</dt><dd style={{ fontWeight: 600 }}>{d.items.length - files.length}</dd>
              <dt>Labels</dt><dd style={{ fontWeight: 600 }}>{d.annotations.length} · {plural(d.labelSet.length, 'type')}</dd>
              <dt>Source record</dt><dd style={{ fontWeight: 600 }}>{d.project.dataSource ? 'Recorded' : 'Missing'}</dd>
              <dt>Notes for staff</dt><dd style={{ fontWeight: 600 }}>{d.issues.filter((i) => i.note).length}</dd>
              <dt>Content verification</dt><dd style={{ fontWeight: 600 }}>Method not chosen yet</dd>
            </dl>
            <p className="ob-muted">Checksums prove a file did not change after import. They do not prove you may use it.</p>
            {d.canEdit && reviewable
              ? <button type="button" className="btn-app btn-block" disabled={d.open > 0 || d.pending} onClick={send}>{d.open > 0 ? `Resolve ${d.open} more to send for review` : d.pending ? 'Sending…' : 'Send snapshot for review'}</button>
              : <p className="ob-muted">{d.editable ? 'Record where the data came from before sending it for review.' : `${STATUS[d.project.status]}.`}</p>}
          </section>
          <section className="ob-card">
            <h2>After you send it</h2>
            <ul className="ob-list">
              <li><span className="ob-num">1</span><div><strong>Editing locks</strong><span className="ob-muted">Files, labels and notes freeze while staff review the snapshot.</span></div></li>
              <li><span className="ob-num">2</span><div><strong>Changes requested?</strong><span className="ob-muted">It unlocks, and you send it again.</span></div></li>
              <li><span className="ob-num">3</span><div><strong>Approved</strong><span className="ob-muted">An admin freezes the next version from exactly what was reviewed.</span></div></li>
            </ul>
          </section>
        </aside>
      </div>
    </DatasetShell>
  );
}

/* ---------------- Import ---------------- */

const UNDERSTOOD = [
  ['video', 'MP4, MOV, MKV, WebM, AVI'], ['audio', 'WAV, FLAC, MP3, Ogg, M4A'], ['image', 'JPEG, PNG, TIFF, WebP, GIF, HEIC'],
  ['text', 'TXT, Markdown, JSON, JSON lines, PDF'], ['table', 'CSV, TSV, Parquet'], ['sensor', 'a table with a time column: set the type to Sensor'],
  ['robot', 'MCAP, ROS bag'], ['logs', '.log text files'],
];

export function DatasetImport() {
  const d = useDataset();
  const revalidator = useRevalidator();
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const urls = useRef([]);
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const set = (i, patch) => setRows((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function upload(fileList) {
    const list = [...fileList].filter((f) => !f.name.startsWith('.'));
    if (!list.length || busy) return;
    const start = rows.length;
    setRows((all) => [...all, ...list.map((f) => {
      const local = /^(image|video)\//.test(f.type) && f.size < 200 * 1048576 ? URL.createObjectURL(f) : null;
      if (local) urls.current.push(local);
      return { name: f.webkitRelativePath || f.name, size: f.size, type: f.type, local, state: 'waiting', progress: 0 };
    })]);
    setBusy(true);
    for (const [k, file] of list.entries()) {
      const i = start + k;
      const grant = await api.uploadGrant(d.entry.id, d.project.id).catch(() => null);
      if (!grant?.ok) { set(i, { state: 'failed', error: grant?.data.error ?? 'Could not start the upload.' }); if (grant?.data.code === 'quota_exceeded' || grant?.data.code === 'project_locked') break; continue; }
      if (file.size > grant.data.maxBytes) { set(i, { state: 'failed', error: `Larger than the ${fmtBytes(grant.data.maxBytes)} limit.` }); continue; }
      set(i, { state: 'uploading' });
      try {
        const sent = await uploadFile(grant.data, file, (p) => set(i, { progress: p }));
        const saved = await api.recordUpload(d.entry.id, d.project.id, sent.receipt);
        if (!saved.ok) throw new Error(saved.data.error ?? 'The upload could not be recorded.');
        const u = saved.data.upload;
        set(i, { state: u.duplicateOf ? 'duplicate' : 'done', contentType: u.contentType, kind: detectKind(u), progress: 1 });
      } catch (err) {
        set(i, { state: 'failed', error: err.message });
      }
    }
    setBusy(false);
    revalidator.revalidate();
  }

  const done = rows.filter((r) => r.state === 'done').length;
  const dup = rows.filter((r) => r.state === 'duplicate').length;
  const failed = rows.filter((r) => r.state === 'failed').length;
  const kinds = new Set(rows.filter((r) => r.kind).map((r) => r.kind));

  return (
    <DatasetShell d={d} current="import" eyebrow={`Import · ${d.project.name}`} title="Import data"
      lede="Drop any mix of files or a whole folder. Valcairn reads each file’s first bytes to work out what it is, so a renamed or extension-less file still lands in the right place.">
      <div className="ob-segment" role="group" aria-label="Source">
        <button type="button" aria-pressed="true">Files and folders</button>
        <button type="button" aria-pressed="false" disabled title="Planned">Cloud bucket · Planned</button>
        <button type="button" aria-pressed="false" disabled title="Planned">Public link · Planned</button>
        <button type="button" aria-pressed="false" disabled title="Planned">API · Planned</button>
      </div>
      <div className="ds-split">
        <section className="ds-main" aria-label="Files in this import" style={{ gap: 16 }}>
          {!d.uploadsEnabled ? <p className="ob-alert">File storage is not configured on this server, so imports are off.</p>
            : !d.canEdit ? <p className="ob-alert ob-alert--info">{d.writer ? 'Imports are closed while the project is locked.' : 'Only owners, admins and members can import files.'}</p>
              : (
                <div className="ob-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }} style={{ cursor: busy ? 'progress' : undefined }}>
                  <Tile icon="upload" tone="blue" size="lg" />
                  <strong>{busy ? 'Uploading…' : 'Drop files or a folder here'}</strong>
                  <span>{plural(d.items.length, 'file')} in this project so far. Each file is checked, hashed and stored privately as it arrives.</span>
                  <span className="ob-row-actions" style={{ justifyContent: 'center', marginTop: 6 }}>
                    <button type="button" className="btn-app" disabled={busy} onClick={() => filesInput.current?.click()}>Choose files</button>
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => folderInput.current?.click()}>Choose a folder</button>
                  </span>
                  <input ref={filesInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                  <input ref={folderInput} type="file" multiple webkitdirectory="" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                </div>
              )}
          {rows.length > 0 && (
            <div className="card">
              <div className="card-head"><h2>This import · {plural(rows.length, 'file')}{kinds.size ? ` · ${plural(kinds.size, 'type')} detected` : ''}</h2><span className="ob-muted">Each file joins the working set as soon as it is stored.</span></div>
              <ul className="ob-list" style={{ padding: '0 20px' }} aria-live="polite">
                {rows.map((r, n) => {
                  const kind = r.kind ?? detectKind({ contentType: r.type, filename: r.name });
                  return (
                    <li key={n} className="ds-file-row">
                      <div className="ds-issue-thumb"><Preview item={{ id: `local-${n}`, kind, contentType: r.contentType ?? r.type ?? '', filename: r.name, sizeBytes: r.size, previewUrl: null }} h={56} localUrl={r.local} /></div>
                      <div style={{ flex: '1 1 220px' }}>
                        <strong style={{ overflowWrap: 'anywhere' }}>{r.name}</strong>
                        <span className="ob-muted">{fmtBytes(r.size)}{r.contentType ? ` · read as ${formatName(r.contentType)}` : ''}{r.contentType && r.type && r.contentType !== r.type ? ` (named as ${r.type})` : ''}</span>
                      </div>
                      {r.kind && <span className={`ds-badge k-${r.kind}`}>{KIND_ONE[r.kind]}</span>}
                      <div className="progress-row" style={{ flex: '0 1 200px', minWidth: 150, gap: 5 }}>
                        <span className={r.state === 'failed' ? 'ob-error' : r.state === 'duplicate' ? 'tone-warn' : r.state === 'done' ? 'tone-ok' : 'tone-info'} style={{ fontSize: 13 }}>
                          {r.state === 'uploading' ? `Uploading ${Math.round(r.progress * 100)}%` : r.state === 'done' ? 'Stored' : r.state === 'duplicate' ? 'Stored · same content as an earlier file' : r.state === 'failed' ? r.error : 'Waiting'}
                        </span>
                        <div className="bar"><span style={{ width: `${(r.state === 'failed' ? 1 : r.progress) * 100}%`, background: r.state === 'failed' ? 'var(--t-orange)' : r.state === 'duplicate' ? 'var(--warn)' : r.state === 'done' ? 'var(--ok)' : 'var(--info)' }} /></div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="card-foot ob-actions">
                <span className="ob-muted">{done} stored · {dup} duplicate{dup === 1 ? '' : 's'} · {failed} refused or failed</span>
                <Link className="btn-app" to={`${d.base}/dataset`}>View dataset</Link>
              </div>
            </div>
          )}
        </section>
        <aside className="ds-side" aria-label="What Valcairn reads">
          <section className="ob-card">
            <h2>Understood today</h2>
            <ul className="ob-list">
              {UNDERSTOOD.map(([k, formats]) => <li key={k} style={{ alignItems: 'center' }}><span className={`ds-badge k-${k}`} style={{ minWidth: 68, textAlign: 'center' }}>{KIND_ONE[k]}</span><div><span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{formats}</span></div></li>)}
            </ul>
            <p className="ob-muted card-rule">Archives are stored as one file and not opened. Executables, HTML and SVG are refused.</p>
          </section>
          <div className="ob-note tile--green"><Tile icon="shield" tone="green" size="sm" /><span><strong>Every file, on arrival:</strong> SHA-256 recorded while it uploads, type read from the first bytes rather than the name, and nothing is kept unless the record is saved.</span></div>
        </aside>
      </div>
    </DatasetShell>
  );
}

/* ---------------- Versions ---------------- */

export function DatasetVersions() {
  const d = useDataset();
  const working = d.items.filter((it) => !it.duplicateOf);
  const [view, setView] = useState('ws');
  const manager = ['owner', 'admin'].includes(d.role);
  const latest = d.versions.at(-1);
  const shown = view === 'ws' ? null : d.versions.find((v) => String(v.number) === view);
  const base = latest ?? null;
  const count = (files) => Object.fromEntries(KINDS.map((k) => [k, files.filter((f) => f.kind === k).length]));
  const now = count(working);
  const then = base ? count(base.files) : null;
  const rows = KINDS.filter((k) => now[k] || then?.[k] || (shown && count(shown.files)[k]));
  const max = Math.max(1, ...rows.map((k) => Math.max(now[k], then?.[k] ?? 0)));
  const scale = (n) => (n ? Math.max(2, Math.sqrt(n / max) * 100) : 0);
  const added = base ? working.filter((f) => !base.files.some((b) => b.id === f.id)).length : working.length;
  const removed = base ? base.files.filter((b) => !working.some((f) => f.id === b.id)).length : 0;

  return (
    <DatasetShell d={d} current="versions" eyebrow={`Versions · ${d.project.name}`} title="Versions"
      lede="A version is frozen when an admin approves it after Valcairn’s review. Its files, labels, notes and source record cannot change; the working set keeps moving.">
      <div className="ds-split">
        <nav aria-label="Version history" style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" className="ob-option" aria-pressed={view === 'ws'} onClick={() => setView('ws')} style={{ '--pick': 'var(--text)', width: '100%', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
            <span className="row-between"><strong>Working set</strong><span className={`ob-badge ${d.editable ? 'tile--blue' : ''}`}>{d.editable ? 'Editable' : 'Locked'}</span></span>
            <span>{plural(working.length, 'file')} · {fmtBytes(working.reduce((n, f) => n + f.sizeBytes, 0))}</span>
          </button>
          {[...d.versions].reverse().map((v) => (
            <button key={v.id} type="button" className="ob-option" aria-pressed={view === String(v.number)} onClick={() => setView(String(v.number))} style={{ '--pick': 'var(--text)', width: '100%', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
              <span className="row-between"><strong>v{v.number}</strong><span className="ob-badge tile--green">Frozen</span></span>
              <span>Approved {new Date(v.createdAt).toLocaleDateString()}</span>
              <span style={{ color: 'var(--text-2)' }}>{plural(v.files.length, 'file')} · {plural(v.labels, 'label')}</span>
            </button>
          ))}
          {d.versions.length === 0 && <p className="ob-muted">No versions yet. The first one is frozen after Valcairn approves a review.</p>}
          {d.project.status === 'approved' && manager && <button type="button" className="btn-app" disabled={d.pending} onClick={() => d.act(() => api.createVersion(d.entry.id, d.project.id))}>Approve version {(latest?.number ?? 0) + 1}</button>}
        </nav>

        <section className="ds-main" aria-label="Comparison" style={{ flex: '999 1 480px' }}>
          <div className="ob-card ob-card--shadow" style={{ gap: 14 }}>
            <div className="row-between" style={{ flexWrap: 'wrap' }}>
              <h2>{shown ? `v${shown.number} contents` : base ? `Working set compared with v${base.number}` : 'Working set'}</h2>
              <span className="ob-muted">{shown ? 'frozen · cannot change' : base ? 'striped = added since then' : 'nothing frozen yet'}</span>
            </div>
            {rows.length === 0 && <p className="ob-muted">No files yet.</p>}
            {rows.map((k) => {
              const a = shown ? count(shown.files)[k] : base ? then[k] : now[k];
              const b = shown ? a : now[k];
              return (
                <div key={k} className={`ds-compare k-${k}`}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600 }}><span className="ds-dot" aria-hidden="true" />{KIND_LABEL[k]}</span>
                  <span className="ds-compare-bar" aria-hidden="true"><span style={{ width: `${scale(Math.min(a, b))}%` }} />{b > a && <span className="is-added" style={{ left: `${scale(a)}%`, width: `${scale(b) - scale(a)}%` }} />}</span>
                  <span className="mono" style={{ fontSize: 12.5, textAlign: 'right' }}>{!shown && base && a !== b ? `${a} → ${b}` : b}</span>
                </div>
              );
            })}
            <div className="ob-chips card-rule" style={{ gap: 6 }}>
              {shown ? <>
                <span className="ob-badge">SHA-256 for every file</span><span className="ob-badge">{plural(shown.labels, 'label')}</span>
                <span className="ob-badge">label set · {plural(shown.labelSet.length, 'label')}</span><span className="ob-badge">{plural(shown.notes, 'note')} for staff</span>
              </> : base ? <>
                <span className="ob-badge tile--green">+{added} file{added === 1 ? '' : 's'}</span>
                {removed > 0 && <span className="ob-badge tile--orange">−{removed} file{removed === 1 ? '' : 's'}</span>}
                <span className="ob-badge">{d.annotations.length - base.labels >= 0 ? '+' : ''}{d.annotations.length - base.labels} labels</span>
              </> : <span className="ob-badge">Freeze a version through review first</span>}
            </div>
          </div>

          <div className="ob-card">
            <h2>Export {shown ? `v${shown.number}` : 'a version'}</h2>
            <div className="ob-grid ob-grid--tight">
              <div className="ob-option" aria-disabled={!shown}>
                <strong>Manifest</strong>
                <span>JSON with every file’s name, type, size, SHA-256, labels, label set and notes.</span>
                {shown ? <a className="btn-small" href={api.manifestUrl(d.entry.id, d.project.id, shown.number)} download style={{ alignSelf: 'flex-start' }}><Icon name="download" size={14} />Download</a> : <span className="ob-badge" style={{ alignSelf: 'flex-start' }}>Pick a version</span>}
              </div>
              <div className="ob-option">
                <strong>Original files</strong>
                <span>{d.writer ? 'Download any file from the dataset view; links last five minutes.' : 'Your role can preview files but not download them.'}</span>
                <span className="ob-badge tile--green" style={{ alignSelf: 'flex-start' }}>Available</span>
              </div>
              <div className="ob-option" aria-disabled="true" style={{ borderStyle: 'dashed', background: 'var(--surface-2)' }}><strong>WebDataset shards</strong><span>Streaming tar shards for training jobs.</span><span className="ob-badge" style={{ alignSelf: 'flex-start' }}>Planned</span></div>
              <div className="ob-option" aria-disabled="true" style={{ borderStyle: 'dashed', background: 'var(--surface-2)' }}><strong>Hugging Face push</strong><span>Publish to a private Hub repository.</span><span className="ob-badge" style={{ alignSelf: 'flex-start' }}>Planned</span></div>
            </div>
          </div>
        </section>

        <aside className="ds-side" aria-label="Access" style={{ flex: '1 1 300px' }}>
          <section className="ob-card">
            <h2>Who can use it</h2>
            <ul className="ob-list">
              {d.members.map((m) => (
                <li key={m.id}><span className="avatar" aria-hidden="true">{m.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span><div><strong>{m.name}</strong><span className="ob-muted">{['owner', 'admin', 'member'].includes(m.role) ? 'Can edit and download' : 'Can view and preview'}</span></div><span className="ob-badge" style={{ alignSelf: 'center' }}>{roleName(m.role)}</span></li>
              ))}
              <li><span className="avatar" aria-hidden="true" style={{ background: 'var(--chip)', color: 'var(--text-2)' }}>↗</span><div><strong>People outside {d.entry.name}</strong><span className="ob-muted">Share a frozen version by link</span></div><span className="ob-badge" style={{ alignSelf: 'center' }}>Planned</span></li>
            </ul>
            {d.entry.kind === 'organization' && manager && <Link className="btn-ghost" to={`/w/${d.entry.slug}/setup/team`}>Invite to the workspace</Link>}
          </section>
          <section className="ob-card">
            <h2>Next steps for a version</h2>
            <div className="ob-links" style={{ borderTop: 0 }}>
              <a aria-disabled="true"><span>Train a model on it</span><span className="ob-badge">Planned</span></a>
              <a aria-disabled="true"><span>Deploy a trained model</span><span className="ob-badge">Planned</span></a>
              <a aria-disabled="true" style={{ borderBottom: 0 }}><span>Use it to raise financing</span><span className="ob-badge">Planned</span></a>
            </div>
          </section>
        </aside>
      </div>
    </DatasetShell>
  );
}
