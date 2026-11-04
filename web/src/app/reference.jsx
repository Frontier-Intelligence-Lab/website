import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { plural } from './shell.jsx';
import { LIMITS, clip, createMemoryClient, explain, newest, readConnection, toPassage } from './memory.js';

/**
 * Opt-in reference material for a chat on this device: passages from the person's own saved notes, fetched from the
 * memory gateway on this computer only when asked, shown in full before anything is sent, and quoted to the model
 * as data. `onChange` receives the passages left ticked, in the order they will be numbered. Only the newest lookup
 * may show results: a stopped, replaced or late one changes nothing.
 */
export function ReferencePicker({ entry, account, draft, disabled, onChange }) {
  const [connection] = useState(() => readConnection(entry.id, account.user.id));
  const client = useMemo(() => (connection ? createMemoryClient(connection) : null), [connection]);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState({ status: 'idle', results: [] }); // idle | searching | found | none | error
  const [unticked, setUnticked] = useState(() => new Set());
  const ops = useRef(newest());
  const chosen = state.results.filter((p) => !unticked.has(p.id));
  const reset = () => { ops.current.stop(); setState({ status: 'idle', results: [] }); setUnticked(new Set()); };

  useEffect(() => { onChange(enabled ? chosen : []); }, [enabled, state.results, unticked]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sending clears the draft; references were for that message only, so they go with it. Turning the option off drops them too.
  useEffect(() => { if (!draft || !enabled) reset(); }, [draft, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the page stops any lookup and closes the client, so nothing late can arrive anywhere.
  useEffect(() => () => { ops.current.stop(); client?.close(); }, [client]);

  async function find() {
    const run = ops.current.start();
    setState({ status: 'searching', results: [] });
    setUnticked(new Set());
    try {
      const results = (await client.search({ query: draft.trim(), limit: LIMITS.passages * 2 }, { signal: run.signal }))
        .filter((r) => r.memory.status === 'active').slice(0, LIMITS.passages).map(toPassage);
      if (!ops.current.isCurrent(run)) return;
      setState({ status: results.length ? 'found' : 'none', results, forDraft: draft });
    } catch (err) {
      if (!ops.current.isCurrent(run)) return;
      setState(err.kind === 'aborted' ? { status: 'idle', results: [] } : { status: 'error', results: [], error: explain(err) });
    }
  }
  const tick = (id, on) => setUnticked((u) => { const next = new Set(u); if (on) next.delete(id); else next.add(id); return next; });

  return (
    <div className="mem-ref">
      <label className="ob-check" style={{ fontSize: 14 }}>
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} />
        Use my saved notes as reference for this message (off unless you turn it on)
      </label>
      {enabled && !client && <p className="ob-muted" style={{ fontSize: 13 }}>No memory is connected in this tab. Connect it on the <Link to={`/w/${entry.slug}/memory`}>Memory page</Link>, then come back here.</p>}
      {enabled && client && (
        <>
          <div className="row-wrap gap-10">
            {state.status === 'searching'
              ? <button type="button" className="btn-small" onClick={reset}>Stop</button>
              : <button type="button" className="btn-small" onClick={find} disabled={disabled || !draft.trim()}>{state.status === 'error' ? 'Try again' : state.results.length ? 'Find again' : 'Find references for this message'}</button>}
            <span className="ob-muted" style={{ fontSize: 12.5 }} aria-live="polite">
              {state.status === 'idle' && 'Nothing is looked up until you ask.'}
              {state.status === 'searching' && 'Searching your notes on this computer…'}
              {state.status === 'none' && 'No saved notes match. The message will be sent without references.'}
              {state.status === 'error' && state.error}
              {state.status === 'found' && `${chosen.length} of ${plural(state.results.length, 'passage')} will be quoted with this message, as information only, exactly as shown.`}
              {state.status === 'found' && state.forDraft !== draft && ' Found for an earlier version of the message.'}
            </span>
          </div>
          {state.results.length > 0 && (
            <ul className="mem-passages" aria-label="Passages to quote">
              {state.results.map((p) => {
                const n = chosen.indexOf(p) + 1;
                return (
                  <li key={p.id}>
                    <label className="ob-check" style={{ fontSize: 13.5 }}>
                      <input type="checkbox" checked={n > 0} disabled={disabled} onChange={(e) => tick(p.id, e.target.checked)} />
                      <span className="cell-stack" style={{ gap: 4 }}>
                        <strong>{n > 0 ? `[${n}] ` : ''}{p.title || 'Untitled'} <span className="ob-muted" style={{ fontWeight: 400 }}>· {p.source?.source_type === 'file' ? `file ${p.source.title ?? ''}${p.edited ? ', edited since import' : ''}` : 'note'}{p.reasons.length ? ` · why: ${p.reasons.join(', ')}` : ''}</span></strong>
                        <span className="mem-snippet">{clip(p.content, LIMITS.passageChars)}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
