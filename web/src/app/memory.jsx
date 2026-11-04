import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLoaderData } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';
import { LIMITS, clip, connectMemory, createMemoryClient, derivedSources, explain, fileImport, newest, noteSource, primarySource, readConnection, sourcesForSave, writeConnection } from './memory.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const STATUS = { active: ['Active', 'tile--green'], superseded: ['Superseded', 'tile--amber'], deleted: ['Deleted', 'tile--orange'], held: ['Held', 'tile--violet'], retracted: ['Retracted', 'tile--orange'] };
const EVENT_LABEL = { add: 'Saved', update: 'Edited', delete: 'Deleted', feedback: 'Feedback' };
const StatusBadge = ({ status }) => <span className={`ob-badge ${STATUS[status]?.[1] ?? ''}`}>{STATUS[status]?.[0] ?? status}</span>;
const Fact = ({ label, value }) => <div className="dev-fact"><dt>{label}</dt><dd>{value}</dd></div>;
const sourceLine = (m) => {
  const s = primarySource(m);
  const edited = m.source_references?.some((r) => r.source_type === 'derived');
  return !s ? 'No source recorded' : s.source_type === 'file' ? `File ${s.title ?? ''}${edited ? ' · edited since import' : ''}` : 'Note';
};

export async function memoryLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const { origins } = await api.localMemory();
  return { account, entry, origins };
}

export function MemoryPage() {
  const { account, entry, origins } = useLoaderData();
  const ids = [entry.id, account.user.id];
  const [connection, setConnection] = useState(() => readConnection(...ids));
  const [notice, setNotice] = useState(null);
  const [inspecting, setInspecting] = useState(null);
  const [version, setVersion] = useState(0); // bumps after every write so the lists reload
  const client = useMemo(() => (connection ? createMemoryClient(connection) : null), [connection]);
  // Disconnecting, or leaving the page, aborts everything in flight through this client.
  useEffect(() => () => client?.close(), [client]);
  const changed = () => setVersion((v) => v + 1);

  function connected(conn) { writeConnection(...ids, conn); setConnection(conn); setNotice(null); }
  function disconnect() {
    client?.close();
    writeConnection(...ids, null);
    setConnection(null); setInspecting(null);
    setNotice({ tone: 'ok', text: 'Disconnected. This browser forgot the key. Your memories stay in the store on this computer; connect again to use them.' });
  }

  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Memory" current="memory">
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Memory · {entry.name}</span>
        <h1 className="ob-h1">Memory</h1>
        <p className="ob-lede">Notes you choose to save, kept in a Provena store on this computer with their source and history. This page searches them and can hand chosen passages to a model running here. None of it goes to Valcairn.</p>
        <div className="ob-chips" style={{ gap: 6 }} aria-label="Where memory lives">
          <span className="ob-badge tile--green">Available · Provena on this computer</span>
          <span className="ob-badge">Not offered · Sync to Valcairn</span>
        </div>
      </div>
      {notice && <p className={`ob-alert${notice.tone === 'ok' ? ' ob-alert--ok' : ''}`} role="status">{notice.text}</p>}
      {origins.length === 0 ? (
        <section className="ob-card"><h2>Memory is off on this server</h2><p className="ob-muted">No memory gateway origin is configured (LOCAL_MEMORY_ORIGINS is empty), so this page cannot connect to anything.</p></section>
      ) : !connection ? <ConnectCard origin={origins[0]} workspaceId={entry.id} userId={account.user.id} onConnected={connected} /> : (
        <>
          <ConnectionCard connection={connection} client={client} onDisconnect={disconnect} />
          {inspecting && <InspectCard key={inspecting} client={client} id={inspecting} onClose={() => setInspecting(null)} onChanged={changed} onOpen={setInspecting} />}
          <AddCard client={client} onSaved={(result) => { changed(); setInspecting(result.memory.memory_id); }} />
          <SearchCard client={client} version={version} onInspect={setInspecting} />
          <RecentCard client={client} version={version} onInspect={setInspecting} />
          <DataNotice origin={connection.origin} />
        </>
      )}
    </WorkspaceShell>
  );
}

/* ---------------- Connect ---------------- */

function ConnectCard({ origin, workspaceId, userId, onConnected }) {
  const [key, setKey] = useState('');
  const [state, setState] = useState({ pending: false, error: null });
  const ops = useRef(newest());
  useEffect(() => () => ops.current.stop(), []); // leaving the page stops a pending check
  async function submit(e) {
    e.preventDefault();
    if (!key.trim()) { setState({ pending: false, error: 'Paste the key from the gateway’s key file.' }); return; }
    const run = ops.current.start();
    setState({ pending: true, error: null });
    try {
      const conn = await connectMemory({ origin, key: key.trim(), workspaceId, userId }, { signal: run.signal });
      if (!ops.current.isCurrent(run)) return;
      setKey('');
      onConnected(conn);
    } catch (err) {
      if (!ops.current.isCurrent(run)) return;
      setState({ pending: false, error: err.kind === 'aborted' ? null : explain(err), kind: err.kind });
    }
  }
  const stop = () => { ops.current.stop(); setState({ pending: false, error: null }); };
  return (
    <section className="ob-card" aria-labelledby="mem-connect-h">
      <div className="row-between"><h2 id="mem-connect-h">Connect your memory</h2><Tile icon="data" tone="teal" /></div>
      <p className="ob-muted">A Provena gateway in local-store mode must be running on this computer at <code>{origin}</code>. Its key must be bound to exactly this workspace and you; create it with these two ids, then paste it below. The key stays in this tab, is forgotten when the tab closes or you sign out, and is never sent to Valcairn.</p>
      <pre className="dev-pre"><code>{`--workspace ${workspaceId} --user ${userId}`}</code></pre>
      <form className="ob-form" style={{ maxWidth: 520 }} onSubmit={submit} noValidate>
        <div className="ob-field">
          <label htmlFor="mem-key">Gateway key</label>
          <input id="mem-key" type="password" value={key} autoComplete="off" spellCheck={false} aria-invalid={Boolean(state.error)} aria-describedby="mem-key-error" onChange={(e) => setKey(e.target.value)} />
          <FieldError id="mem-key-error">{state.error}</FieldError>
        </div>
        <div className="row-wrap gap-10">
          <button type="submit" className="btn-app" disabled={state.pending}>{state.pending ? 'Checking…' : 'Connect'}</button>
          {state.pending && <button type="button" className="btn-text" onClick={stop}>Stop</button>}
        </div>
      </form>
      {['unreachable', 'forbidden'].includes(state.kind) && <SetupHelp origin={origin} />}
    </section>
  );
}

function SetupHelp({ origin }) {
  const site = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="ob-alert" role="alert">
      <strong>The gateway at {origin} did not accept this page.</strong> Check, in order:
      <ol className="dev-steps">
        <li>The Provena store and gateway are running on this computer in local-store mode, bound to 127.0.0.1 (Provena’s DEPLOYMENT.md, “Local store mode”).</li>
        <li>The gateway lists exactly this page’s origin in <code>PROVENA_BROWSER_ORIGINS</code>: <code>{site}</code>. It never accepts <code>*</code>.</li>
        <li>If the browser asked whether this site may reach apps on this device, allow it.</li>
      </ol>
    </div>
  );
}

function ConnectionCard({ connection, client, onDisconnect }) {
  const [check, setCheck] = useState({ status: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const ops = useRef(newest());
  async function refresh() {
    const run = ops.current.start();
    setCheck({ status: 'checking' });
    try {
      await client.whoami({ signal: run.signal });
      if (ops.current.isCurrent(run)) setCheck({ status: 'ok', at: new Date().toISOString() });
    } catch (err) {
      if (ops.current.isCurrent(run) && err.kind !== 'aborted') setCheck({ status: 'error', error: explain(err) });
    }
  }
  useEffect(() => { refresh(); return () => ops.current.stop(); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  const { who } = connection;
  return (
    <section className="ob-card" aria-labelledby="mem-conn-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <div className="cell-stack">
          <h2 id="mem-conn-h">Memory on this computer</h2>
          <span className="ob-muted" style={{ fontSize: 13 }} aria-live="polite">
            {check.status === 'checking' ? 'Checking the gateway…' : check.status === 'error' ? check.error : `Connected to ${connection.origin} · key ${who.keyId} · scope ${who.tenantId}, this workspace and you${check.at ? ` · checked ${when(check.at)}` : ''}`}
          </span>
        </div>
        <div className="row-wrap gap-10">
          <button type="button" className="btn-ghost" onClick={refresh} disabled={check.status === 'checking'}>{check.status === 'error' ? 'Try again' : 'Refresh'}</button>
          {confirming ? (
            <span className="row-wrap gap-10" role="group" aria-label="Confirm disconnect">
              <button type="button" className="btn-app" onClick={onDisconnect}>Disconnect</button>
              <button type="button" className="btn-text" onClick={() => setConfirming(false)}>Keep it</button>
            </span>
          ) : <button type="button" className="btn-text" onClick={() => setConfirming(true)}>Disconnect…</button>}
        </div>
      </div>
      {who.role === 'viewer' && <p className="ob-alert" role="status">This key can read but not save. Create an editor key to add notes.</p>}
      <p className="ob-muted" style={{ fontSize: 13 }}>Disconnecting forgets the key in this browser only and stops anything still running. Memories stay in the store’s database file on this computer.</p>
    </section>
  );
}

/* ---------------- Add ---------------- */

function AddCard({ client, onSaved }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [imported, setImported] = useState(null); // { source, text } of the picked file; otherwise the note is its own source
  const [state, setState] = useState({ pending: false, reading: null, error: null, fileError: null, saved: null });
  const fileRef = useRef(null);
  const ops = useRef(newest());
  const importer = useRef(fileImport());
  useEffect(() => () => { ops.current.stop(); importer.current.cancel(); }, []);
  const canSave = content.trim().length > 0 && content.length <= LIMITS.content && title.length <= LIMITS.title;
  // While a save or a file read is in flight the whole form is locked: nothing typed meanwhile can be lost when the
  // form clears, and a read cannot land on a form that a save is about to clear.
  const locked = state.pending || Boolean(state.reading);
  const edited = Boolean(imported) && content !== imported.text;

  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file || locked) return;
    if (!(/^text\//.test(file.type) || /\.(txt|md|markdown)$/i.test(file.name))) { setState((s) => ({ ...s, fileError: 'Pick a plain text file (.txt or .md).', saved: null })); return; }
    setState((s) => ({ ...s, reading: file.name, fileError: null, saved: null }));
    const outcome = await importer.current.pick(file);
    if (outcome.status === 'stale') return; // cleared, stopped, replaced or the page left: the form stays as it is now
    setState((s) => ({ ...s, reading: null, fileError: outcome.status === 'failed' ? explain(outcome.error) : null }));
    if (outcome.status === 'applied') {
      setImported({ source: outcome.source, text: outcome.text });
      setTitle(file.name.slice(0, LIMITS.title));
      setContent(outcome.text);
    } else if (fileRef.current) fileRef.current.value = '';
  }
  function stopReading() { importer.current.cancel(); setState((s) => ({ ...s, reading: null })); if (fileRef.current) fileRef.current.value = ''; }
  function clearAll() { importer.current.cancel(); setImported(null); setTitle(''); setContent(''); setState((s) => ({ ...s, reading: null })); if (fileRef.current) fileRef.current.value = ''; }
  async function save(e) {
    e.preventDefault();
    if (!canSave || locked) return;
    const run = ops.current.start();
    setState({ pending: true, error: null, fileError: null, saved: null });
    try {
      const source = imported?.source ?? noteSource(title.trim());
      const result = await client.add({ title: title.trim(), content, source_references: sourcesForSave({ source, importedText: imported?.text, content }) }, { signal: run.signal });
      if (!ops.current.isCurrent(run)) return;
      clearAll();
      setState({ pending: false, error: null, fileError: null, saved: result });
      onSaved(result);
    } catch (err) {
      if (!ops.current.isCurrent(run)) return;
      setState({ pending: false, error: explain(err), fileError: null, saved: null });
    }
  }
  return (
    <section className="ob-card" aria-labelledby="mem-add-h">
      <div className="row-between"><h2 id="mem-add-h">Save a note</h2><span className="ob-muted" style={{ fontSize: 12 }}>Only what you type or pick here</span></div>
      <form className="ob-form" style={{ maxWidth: 'none' }} onSubmit={save} noValidate aria-busy={locked}>
        <div className="ob-field">
          <label htmlFor="mem-file">Import a text file <span className="ob-optional">(optional)</span></label>
          <input id="mem-file" ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={pick} disabled={locked} aria-describedby="mem-file-hint mem-file-error" />
          <span id="mem-file-hint" className="ob-muted" style={{ fontSize: 12.5 }}>One UTF-8 text file you choose, up to {LIMITS.fileBytes.toLocaleString()} bytes. Its name, size and a digest of its bytes are kept as the source; the digest identifies the file, nothing about rights. Nothing on this computer is scanned.</span>
          <FieldError id="mem-file-error">{state.fileError}</FieldError>
          {state.reading && <span className="ob-muted" role="status" style={{ fontSize: 13 }}>Reading {state.reading}… Save waits for it. <button type="button" className="btn-text" onClick={stopReading}>Stop</button></span>}
          {imported && <span className="ob-ok"><Icon name="check" size={14} stroke={2.4} /> {imported.source.title} · {plural(imported.source.metadata.chars, 'character')} <button type="button" className="btn-text" onClick={clearAll} disabled={locked}>Clear</button></span>}
        </div>
        <div className="ob-field">
          <label htmlFor="mem-title">Title <span className="ob-optional">(optional)</span></label>
          <input id="mem-title" type="text" value={title} maxLength={LIMITS.title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="ob-field">
          <label htmlFor="mem-content">Note</label>
          <textarea id="mem-content" rows={6} value={content} disabled={locked} onChange={(e) => { setContent(e.target.value); setState((s) => ({ ...s, saved: null })); }} aria-invalid={content.length > LIMITS.content} aria-describedby="mem-content-count" />
          <span id="mem-content-count" className={content.length > LIMITS.content ? 'ob-error' : 'ob-muted'} style={{ fontSize: 12.5 }}>
            {content.length.toLocaleString()} of {LIMITS.content.toLocaleString()} characters
            {imported && (edited ? ' · changed since import: it will be saved with the file’s digest and marked as edited' : ' · as imported')}
          </span>
        </div>
        {state.error && <p className="ob-alert" role="alert">{state.error}</p>}
        {state.saved && <p className="ob-alert ob-alert--ok" role="status">{state.saved.created ? 'Saved to memory on this computer.' : 'Already saved: a note with exactly this content exists, so nothing new was added.'}</p>}
        <div><button type="submit" className="btn-app" disabled={!canSave || locked}>{state.pending ? 'Saving… (the form is locked until it finishes)' : state.reading ? 'Reading the file…' : 'Save to memory'}</button></div>
      </form>
    </section>
  );
}

/* ---------------- Search and list ---------------- */

function MemoryList({ items, onInspect, caption }) {
  return (
    <>
      {caption && <p className="ob-muted" style={{ fontSize: 13 }}>{caption}</p>}
      <ol className="ob-list mem-list">
        {items.map(({ memory: m, reasons }) => (
          <li key={m.memory_id}>
            <div>
              <span className="row-wrap gap-10"><strong>{m.title || 'Untitled'}</strong><StatusBadge status={m.status} /></span>
              <span className="mem-snippet">{clip(m.content, 240)}</span>
              <span className="ob-muted">{sourceLine(m)} · {when(m.updated_at)}{reasons?.length ? ` · Why: ${reasons.join(', ')}` : ''}</span>
            </div>
            <button type="button" className="btn-small" onClick={() => onInspect(m.memory_id)} aria-label={`Inspect ${m.title || 'untitled note'}`}>Inspect</button>
          </li>
        ))}
      </ol>
    </>
  );
}

function SearchCard({ client, version, onInspect }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(10);
  const [state, setState] = useState({ status: 'idle', results: [] });
  const ops = useRef(newest());
  useEffect(() => () => ops.current.stop(), []);
  // A write elsewhere on the page changes what a search returns, so shown results are run again.
  useEffect(() => { if (state.status === 'done') run(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(e) {
    e?.preventDefault?.();
    const q = query.trim();
    if (!q) return;
    const op = ops.current.start();
    setState({ status: 'searching', results: [] });
    try {
      const results = await client.search({ query: q, limit }, { signal: op.signal });
      if (ops.current.isCurrent(op)) setState({ status: 'done', results, query: q });
    } catch (err) {
      if (!ops.current.isCurrent(op)) return;
      setState(err.kind === 'aborted' ? { status: 'idle', results: [] } : { status: 'error', results: [], error: explain(err) });
    }
  }
  // Stop is a form button that gives way to the submit button on re-render. The browser decides what a click did
  // only after the handlers ran, so the default action is cancelled explicitly: a Stop must never become a submit.
  const stop = (e) => { e.preventDefault(); ops.current.stop(); setState({ status: 'idle', results: [], stopped: true }); };
  return (
    <section className="ob-card" aria-labelledby="mem-search-h">
      <div className="row-between"><h2 id="mem-search-h">Search</h2><span className="ob-muted" style={{ fontSize: 12 }}>Ranked by the store on this computer</span></div>
      <form className="mem-search" onSubmit={run}>
        <label htmlFor="mem-q" className="sr-only">Search your notes</label>
        <input id="mem-q" type="search" value={query} maxLength={LIMITS.query} placeholder="Words from a note" onChange={(e) => setQuery(e.target.value)} />
        <label htmlFor="mem-limit" className="sr-only">How many results</label>
        <select id="mem-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[5, 10, 20].map((n) => <option key={n} value={n}>Top {n}</option>)}</select>
        {/* Keyed, so the two are separate elements: the clicked Stop is removed rather than turned into the submit button. */}
        {state.status === 'searching'
          ? <button key="stop" type="button" className="btn-ghost" onClick={stop}>Stop</button>
          : <button key="search" type="submit" className="btn-app" disabled={!query.trim()}>Search</button>}
      </form>
      <div aria-live="polite">
        {state.status === 'idle' && state.stopped && <p className="ob-muted" role="status">Search stopped. No results are shown.</p>}
        {state.status === 'searching' && <p className="ob-muted">Searching…</p>}
        {state.status === 'error' && <p className="ob-alert" role="alert">{state.error} <button type="button" className="btn-text" onClick={run}>Try again</button></p>}
        {state.status === 'done' && state.results.length === 0 && <p className="ob-muted">No saved notes match “{state.query}”.</p>}
        {state.status === 'done' && state.results.length > 0 && <MemoryList items={state.results} onInspect={onInspect} caption={`${state.results.length} ${state.results.length === 1 ? 'match' : 'matches'} for “${state.query}”, best first. “Why” is the store’s own reason, not a confidence.`} />}
      </div>
    </section>
  );
}

function RecentCard({ client, version, onInspect }) {
  const [state, setState] = useState({ status: 'loading', items: [] });
  const ops = useRef(newest());
  async function load() {
    const op = ops.current.start();
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const items = await client.list({ signal: op.signal });
      if (ops.current.isCurrent(op)) setState({ status: 'done', items });
    } catch (err) {
      if (ops.current.isCurrent(op) && err.kind !== 'aborted') setState({ status: 'error', items: [], error: explain(err) });
    }
  }
  useEffect(() => { load(); return () => ops.current.stop(); }, [client, version]); // eslint-disable-line react-hooks/exhaustive-deps
  function exportJson() {
    const text = JSON.stringify({ exported_at: new Date().toISOString(), origin: client.origin, scope: client.scope, count: state.items.length, memories: state.items }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `valcairn-memory-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="ob-card" aria-labelledby="mem-recent-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <h2 id="mem-recent-h">Saved notes</h2>
        <div className="row-wrap gap-10">
          <span className="ob-muted" style={{ fontSize: 12 }}>Newest first, at most {LIMITS.listResults}</span>
          <button type="button" className="btn-ghost" onClick={exportJson} disabled={state.status !== 'done' || !state.items.length}><Icon name="download" size={14} /> Export {state.items.length ? plural(state.items.length, 'note') : 'JSON'}</button>
        </div>
      </div>
      {state.status === 'loading' && <p className="ob-muted" role="status">Loading…</p>}
      {state.status === 'error' && <p className="ob-alert" role="alert">{state.error} <button type="button" className="btn-text" onClick={load}>Try again</button></p>}
      {state.status === 'done' && (state.items.length === 0 ? <p className="ob-muted">Nothing saved yet.</p> : <MemoryList items={state.items.map((m) => ({ memory: m }))} onInspect={onInspect} />)}
    </section>
  );
}

/* ---------------- Inspect, edit, supersede, delete ---------------- */

const SOURCE_KIND = {
  file: 'Imported text file',
  note: 'Typed on this page',
  derived: 'Edited on this page after import: the text below has moved on from the file',
};
const sourceKind = (s) => (s.source_type === 'note' && s.source_id.startsWith('supersedes:') ? 'Written here to replace an earlier note' : SOURCE_KIND[s.source_type] ?? s.source_type);

function InspectCard({ client, id, onClose, onChanged, onOpen }) {
  const [state, setState] = useState({ status: 'loading' });
  const [mode, setMode] = useState('view'); // view | edit | supersede | delete
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const headingRef = useRef(null);
  const ops = useRef(newest());
  async function load() {
    const op = ops.current.start();
    setState({ status: 'loading' });
    try {
      const [memory, history] = await Promise.all([client.get(id, { signal: op.signal }), client.history(id, { signal: op.signal })]);
      if (!ops.current.isCurrent(op)) return;
      // The store orders same-second events arbitrarily; the timestamps themselves are finer.
      setState({ status: 'done', memory, history: [...history].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) });
    } catch (err) {
      if (ops.current.isCurrent(op) && err.kind !== 'aborted') setState({ status: 'error', error: explain(err) });
    }
  }
  useEffect(() => { load(); headingRef.current?.focus(); return () => ops.current.stop(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn, after) {
    const op = ops.current.start();
    setPending(true); setError(null);
    try {
      const out = await fn(op.signal);
      if (!ops.current.isCurrent(op)) return;
      setPending(false); setMode('view');
      onChanged();
      if (after) after(out); else load();
    } catch (err) {
      if (!ops.current.isCurrent(op)) return;
      setPending(false);
      if (err.kind !== 'aborted') setError(explain(err));
    }
  }
  const m = state.memory;
  // An edit of an imported note keeps the file reference untouched and adds a derived marker, so the digest never
  // appears to vouch for text it does not match.
  const edit = (note) => {
    const patch = { ...(note.title !== (m.title ?? '') ? { title: note.title } : {}), ...(note.content !== m.content ? { content: note.content } : {}) };
    const derived = 'content' in patch ? derivedSources(m) : null;
    return act((signal) => client.update(id, derived ? { ...patch, source_references: derived } : patch, { signal }));
  };
  return (
    <section className="ob-card ob-card--strong" aria-labelledby="mem-inspect-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <h2 id="mem-inspect-h" ref={headingRef} tabIndex={-1}>{state.status === 'done' ? (m.title || 'Untitled') : 'Inspecting…'}</h2>
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
      </div>
      {state.status === 'loading' && <p className="ob-muted" role="status">Loading…</p>}
      {state.status === 'error' && <p className="ob-alert" role="alert">{state.error} <button type="button" className="btn-text" onClick={load}>Try again</button></p>}
      {state.status === 'done' && (
        <>
          <div className="row-wrap gap-10"><StatusBadge status={m.status} /><span className="ob-muted" style={{ fontSize: 13 }}>Saved {when(m.created_at)} · Updated {when(m.updated_at)} · Scope {m.scope.tenant_id}</span></div>
          <h3 className="mem-h3">Source</h3>
          {m.source_references?.length ? (
            <dl className="dev-meta">
              {m.source_references.map((s) => (
                <Fragment key={s.source_id}>
                  <Fact label="Kind" value={sourceKind(s)} />
                  {s.title && s.source_type !== 'derived' && <Fact label="Name" value={s.title} />}
                  <Fact label="Reference" value={<code>{s.source_id}</code>} />
                  {s.source_type === 'file' && <Fact label="Digest of" value="the file’s bytes as picked; it identifies that file and says nothing about rights or about the current text" />}
                  {s.metadata?.size_bytes != null && <Fact label="Size" value={`${s.metadata.size_bytes.toLocaleString()} bytes · ${plural(s.metadata.chars ?? 0, 'character')}`} />}
                </Fragment>
              ))}
            </dl>
          ) : <p className="ob-muted">No source recorded.</p>}
          <h3 className="mem-h3">Content</h3>
          {mode === 'edit' || mode === 'supersede' ? (
            <NoteForm
              initial={m} pending={pending} submitLabel={mode === 'edit' ? 'Save changes' : 'Save as the newer note'} onCancel={() => setMode('view')}
              onSubmit={(note) => (mode === 'edit'
                ? edit(note)
                : act((signal) => client.supersede(id, { ...note, source: { source_type: 'note', source_id: `supersedes:${id}`, title: note.title || null } }, { signal }), (out) => onOpen(out.memory.memory_id)))}
            />
          ) : <pre className="mem-content">{m.content}</pre>}
          {error && <p className="ob-alert" role="alert">{error}</p>}
          {mode === 'view' && m.status === 'active' && (
            <div className="row-wrap gap-10">
              <button type="button" className="btn-ghost" onClick={() => setMode('edit')}>Edit</button>
              <button type="button" className="btn-ghost" onClick={() => setMode('supersede')}>Supersede…</button>
              <button type="button" className="btn-text" onClick={() => setMode('delete')}>Delete…</button>
            </div>
          )}
          {mode === 'view' && m.status !== 'active' && <p className="ob-muted" style={{ fontSize: 13 }}>{m.status === 'deleted' ? 'Deleted: it no longer appears in search or chat references. Its history stays.' : 'Superseded by a newer note: it still appears in search, ranked lower, and is not quoted to a model.'}</p>}
          {mode === 'delete' && (
            <div className="dev-confirm" role="group" aria-label="Confirm delete">
              <p style={{ fontSize: 13 }}>Delete this note? It leaves search and chat references now. Its history stays, marked deleted, so earlier answers that quoted it remain explainable.</p>
              <div className="row-wrap gap-10">
                <button type="button" className="btn-app" disabled={pending} onClick={() => act((signal) => client.remove(id, { signal }))}>{pending ? 'Deleting…' : 'Delete'}</button>
                <button type="button" className="btn-text" onClick={() => setMode('view')}>Keep it</button>
              </div>
            </div>
          )}
          <h3 className="mem-h3">History</h3>
          <ol className="ob-list">
            {state.history.map((h) => (
              <li key={h.history_id}><div><strong>{EVENT_LABEL[h.event] ?? h.event}</strong><span className="ob-muted">{when(h.created_at)}{h.actor_id ? ` · by ${h.actor_id}` : ''}{h.details?.updated_fields?.length ? ` · changed ${h.details.updated_fields.join(', ')}` : ''}</span></div></li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** Edit or supersede form. Locked while its save is in flight, so nothing typed meanwhile is lost when it closes. */
function NoteForm({ initial, pending, submitLabel, onSubmit, onCancel }) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [content, setContent] = useState(initial.content);
  const ok = content.trim().length > 0 && content.length <= LIMITS.content;
  return (
    <form className="ob-form" style={{ maxWidth: 'none' }} onSubmit={(e) => { e.preventDefault(); if (ok && !pending) onSubmit({ title: title.trim(), content }); }} noValidate aria-busy={pending}>
      <div className="ob-field"><label htmlFor="mem-edit-title">Title</label><input id="mem-edit-title" type="text" value={title} maxLength={LIMITS.title} disabled={pending} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="ob-field"><label htmlFor="mem-edit-content">Note</label><textarea id="mem-edit-content" rows={8} value={content} disabled={pending} onChange={(e) => setContent(e.target.value)} aria-invalid={!ok} /></div>
      <div className="row-wrap gap-10">
        <button type="submit" className="btn-app" disabled={!ok || pending}>{pending ? 'Saving…' : submitLabel}</button>
        <button type="button" className="btn-text" onClick={onCancel} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

function DataNotice({ origin }) {
  return (
    <details>
      <summary>What leaves this computer</summary>
      <div className="ob-muted" style={{ fontSize: 13.5, padding: '0 0 16px', display: 'grid', gap: 8 }}>
        <p><strong>Stays here:</strong> your notes, imported files, searches, the key, and any passage handed to a model. They go from this page to the Provena gateway at {origin} and to Ollama on this computer, never through Valcairn, and never to anywhere a gateway might redirect.</p>
        <p><strong>Sent to Valcairn:</strong> nothing from this page beyond loading it. Valcairn does not learn that you connected, what you saved or what you searched.</p>
        <p><strong>Kept by the store:</strong> every note with its source reference, each edit as history, a deletion as a marker rather than an erasure, and which note superseded which. An imported file keeps the digest of its bytes even after you edit the text; the edit is marked. Export gives you the listed notes as JSON.</p>
        <p><strong>Not offered:</strong> syncing memory to Valcairn or to another machine. There is no fallback to a hosted service.</p>
      </div>
    </details>
  );
}
