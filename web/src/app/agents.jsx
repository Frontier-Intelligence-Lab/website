import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import { api } from '../api.js';
import { Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';
import { MemoryError, clip, explain as explainMemory, readConnection } from './memory.js';
import { useMemoryClient } from './use-memory-client.js';
import { RuntimeError, createRuntime } from './runtime.js';
import { AGENT_LIMITS, TOOL_NAMES, TURN_OPTIONS, canAgent, explainAgent, keepLocalDraft, newGrant, newRun, recheckSources, recoveryAction, runAgent } from './agent.js';
import { dbName, indexedDbBackend, openLedger, scopeKeyOf, withLedgerLock, withRunLock } from './agent-ledger.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const short = (hash) => (hash ? `${hash.slice(0, 12)}…` : '—');
const RUN_STATUS = { draft: ['Draft', ''], approved: ['Approved', 'tile--blue'], running: ['Running', 'tile--blue'], interrupted: ['Interrupted', 'tile--amber'], completed: ['Completed', 'tile--green'], stopped: ['Stopped', ''], failed: ['Failed', 'tile--orange'] };
const STEP_STATE = { pending: ['Running…', 'tile--blue'], done: ['Done', 'tile--green'], denied: ['Denied', 'tile--orange'], failed: ['Failed', 'tile--orange'], stopped: ['Stopped', ''], interrupted: ['Interrupted', 'tile--amber'] };
const SOURCE_STATE = { unchanged: 'Unchanged since it was read', changed: 'Changed since it was read', superseded: 'Superseded since it was read', deleted: 'Deleted since it was read', out_of_scope: 'No longer in this scope', missing_snapshot: 'No frozen excerpt for this citation' };
const Badge = ({ table, value }) => <span className={`ob-badge ${table[value]?.[1] ?? ''}`}>{table[value]?.[0] ?? value}</span>;
const Fact = ({ label, value }) => <div className="dev-fact"><dt>{label}</dt><dd>{value}</dd></div>;
const explainRuntime = (err) => (err instanceof RuntimeError ? (err.kind === 'unreachable' ? 'Ollama did not answer from this page.' : err.kind === 'no_tools' ? explainAgent({ kind: 'no_tools' }) : `Ollama reported an error${err.message ? ` (${err.message})` : ''}.`) : explainAgent(err));

export async function agentsLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [local, memory] = await Promise.all([api.localModels(), api.localMemory()]);
  return { account, entry, runtimeOrigin: local.runtimeOrigins[0] ?? null, memoryOrigins: memory.origins };
}

export function AgentsPage() {
  const { account, entry, runtimeOrigin, memoryOrigins } = useLoaderData();
  const ids = [entry.id, account.user.id];
  const [connection] = useState(() => readConnection(...ids));
  const client = useMemoryClient(connection); // owned by this page's effect lifecycle; null until it is open
  const runtime = useMemo(() => (runtimeOrigin ? createRuntime(runtimeOrigin) : null), [runtimeOrigin]);
  const [store, setStore] = useState({ status: 'opening' }); // opening | ready (ledger) | error
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [live, setLive] = useState(null); // id of the run executing in this tab
  const [version, setVersion] = useState(0); // bumps after every ledger write so cards reload
  const [notice, setNotice] = useState(null);
  const execRef = useRef(null);
  const ledger = store.ledger ?? null;
  const bump = () => setVersion((v) => v + 1);

  // This person's ledger for this workspace. A refusal is shown, never hidden. Runs left running by a tab that
  // closed (no tab holds their lock) become interrupted; nothing resumes by itself.
  useEffect(() => {
    let cancelled = false;
    let backend = null;
    (async () => {
      try {
        backend = await indexedDbBackend(dbName(...ids));
        const l = openLedger({ scopeKey: scopeKeyOf(...ids), backend });
        await l.markInterrupted();
        const list = await l.runs();
        if (cancelled) return;
        setStore({ status: 'ready', ledger: l });
        setRuns(list);
      } catch (err) { if (!cancelled) setStore({ status: 'error', error: explainAgent(err) }); }
    })();
    return () => { cancelled = true; backend?.close(); };
  }, [entry.id, account.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the page: whatever is executing is cut off and left resumable. (The client is closed by its own hook.)
  useEffect(() => () => execRef.current?.abort('interrupted'), []);
  useEffect(() => { if (ledger) ledger.runs().then(setRuns, (err) => setNotice({ tone: 'warn', text: explainAgent(err) })); }, [ledger, version]);

  const selected = runs.find((r) => r.id === selectedId) ?? null;

  // An execution holds this ledger's lock shared and the run's lock exclusively; the runner then reads the current
  // run, grant and model identity itself, so whatever this tab rendered earlier cannot restart a changed run.
  async function execute(run) {
    if (execRef.current || !ledger || !client || !runtime) return;
    const controller = new AbortController();
    execRef.current = controller;
    setLive(run.id); setNotice(null);
    try {
      const out = await withLedgerLock(ledger.scopeKey, 'shared', () => withRunLock(run.id, () => runAgent({ runId: run.id, ledger, runtime, memory: client, signal: controller.signal, onStep: bump })));
      if (!out) setNotice({ tone: 'warn', text: explainAgent({ kind: 'superseded' }) });
    } catch (err) {
      setNotice({ tone: 'warn', text: explainAgent(err) });
    } finally {
      execRef.current = null;
      setLive(null);
      bump();
    }
  }
  async function approve(run) {
    try {
      await ledger.putGrant(newGrant(run));
      const approved = await ledger.updateRun(run.id, { status: 'approved', approvedAt: new Date().toISOString() });
      bump();
      await execute(approved);
    } catch (err) { setNotice({ tone: 'warn', text: explainAgent(err) }); }
  }
  async function decline(run) {
    try { await ledger.updateRun(run.id, { declinedAt: new Date().toISOString() }); bump(); } catch (err) { setNotice({ tone: 'warn', text: explainAgent(err) }); }
  }
  // Delete history takes the ledger lock exclusively: refused while any tab executes a run, never queued behind it.
  async function clearHistory() {
    try { await withLedgerLock(ledger.scopeKey, 'exclusive', () => ledger.clear()); setSelectedId(null); bump(); setNotice({ tone: 'ok', text: 'Run history deleted from this browser. Notes in the memory store were not touched.' }); } catch (err) { setNotice({ tone: 'warn', text: explainAgent(err) }); }
  }

  const ready = Boolean(ledger && client && runtime);
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Agents" current="agents">
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Agents · {entry.name}</span>
        <h1 className="ob-h1">Agents</h1>
        <p className="ob-lede">One bounded agent that runs on this computer: a local model searches and reads the notes you allow, then drafts a cited answer for you to review. Nothing it reads, asks or writes goes to Valcairn.</p>
        <div className="ob-chips" style={{ gap: 6 }} aria-label="What is offered">
          <span className="ob-badge tile--green">Available · Research my notes</span>
          <span className="ob-badge">Planned · Other templates</span>
          <span className="ob-badge">Not offered · Shared or autonomous agents</span>
        </div>
      </div>
      {notice && <p className={`ob-alert${notice.tone === 'ok' ? ' ob-alert--ok' : ''}`} role="status">{notice.text}</p>}
      <ReadinessCard entry={entry} runtimeOrigin={runtimeOrigin} memoryOrigins={memoryOrigins} connection={connection} store={store} />
      {ready && !selected && <NewRunCard runtime={runtime} connection={connection} scopeKey={scopeKeyOf(...ids)} ledger={ledger} onCreated={(run) => { bump(); setSelectedId(run.id); }} />}
      {selected && <RunPanel key={selected.id} run={selected} slug={entry.slug} ledger={ledger} client={client} version={version} live={live === selected.id} canRun={ready && !live} onApprove={() => approve(selected)} onDecline={() => decline(selected)} onResume={() => execute(selected)} onStop={() => execRef.current?.abort('stopped')} onClose={() => setSelectedId(null)} onChanged={bump} />}
      {ledger && <HistoryCard runs={runs} selectedId={selectedId} live={live} onOpen={setSelectedId} onClear={clearHistory} />}
      <AgentDataNotice runtimeOrigin={runtimeOrigin} memoryOrigin={connection?.origin ?? memoryOrigins[0]} />
    </WorkspaceShell>
  );
}

/* ---------------- Readiness ---------------- */

function ReadinessCard({ entry, runtimeOrigin, memoryOrigins, connection, store }) {
  const Item = ({ ok, children }) => <li><span className={ok ? 'ob-ok' : 'tone-warn'}><Icon name={ok ? 'check' : 'alert'} size={14} stroke={2.4} /></span><span>{children}</span></li>;
  return (
    <section className="ob-card" aria-labelledby="agt-ready-h">
      <div className="row-between"><h2 id="agt-ready-h">What a run uses</h2><Tile icon="target" tone="blue" /></div>
      <ul className="agt-ready" aria-label="Requirements">
        <Item ok={Boolean(runtimeOrigin)}>Model runtime: {runtimeOrigin ? <>Ollama on this computer at <code>{runtimeOrigin}</code>; the model is chosen below from what is installed and marked by the runtime as supporting tool calls. Nothing is downloaded.</> : 'no local runtime origin is configured on this server (LOCAL_RUNTIME_ORIGINS), so no run can start.'}</Item>
        <Item ok={Boolean(connection)}>Memory: {connection ? <>connected in this tab to <code>{connection.origin}</code>, key {connection.who.keyId}, scope {connection.who.tenantId}, this workspace and you.</> : memoryOrigins.length ? <>not connected in this tab. Connect it on the <Link to={`/w/${entry.slug}/memory`}>Memory page</Link>, then come back; the key stays there and is never shown to the model.</> : 'off on this server (LOCAL_MEMORY_ORIGINS is empty).'}</Item>
        <Item ok={store.status === 'ready'}>Run history: {store.status === 'ready' ? 'this browser’s local database, for this workspace and you only.' : store.status === 'opening' ? 'opening this browser’s local database…' : store.error}</Item>
      </ul>
    </section>
  );
}

/* ---------------- New run ---------------- */

function NewRunCard({ runtime, connection, scopeKey, ledger, onCreated }) {
  const [models, setModels] = useState({ status: 'loading', list: [] });
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState(AGENT_LIMITS.modelTurns);
  const [state, setState] = useState({ pending: false, error: null });
  const abortRef = useRef(null);
  async function load() {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setModels({ status: 'loading', list: [] });
    try {
      // Only models the runtime itself marks as chat models with tool calls; embedding-only and cloud models are never listed.
      const list = (await runtime.models({ signal: controller.signal })).filter((m) => !m.remote && canAgent(m.capabilities));
      setModels({ status: 'done', list });
    } catch (err) { if (err.kind !== 'aborted') setModels({ status: 'error', list: [], error: explainRuntime(err) }); }
  }
  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [runtime]); // eslint-disable-line react-hooks/exhaustive-deps
  async function prepare(e) {
    e.preventDefault();
    if (state.pending) return;
    if (!models.list.some((m) => m.name === model)) { setState({ pending: false, error: 'Choose an installed model first.' }); return; }
    setState({ pending: true, error: null });
    try {
      // The identity recorded for the run is read from the runtime now, not from the list shown earlier.
      const listed = (await runtime.models()).find((m) => m.name === model);
      if (!listed || listed.remote || !listed.digest) throw new RuntimeError('not_found', 'The runtime no longer lists this model as installed on this device.');
      const info = await runtime.show(listed.name);
      if (!canAgent(info.capabilities) || !canAgent(listed.capabilities.length ? listed.capabilities : info.capabilities)) throw new RuntimeError('no_tools', 'The runtime does not list this model as a chat model with tool support.');
      const run = await newRun({ scope: connection.scope, scopeKey, model: { name: listed.name, digest: listed.digest, thinking: info.thinking }, question, gateway: connection.origin, runtime: runtime.origin, modelTurns: turns });
      await ledger.createRun(run);
      setQuestion('');
      setState({ pending: false, error: null });
      onCreated(run);
    } catch (err) {
      setState({ pending: false, error: err instanceof RuntimeError ? explainRuntime(err) : explainAgent(err) });
    }
  }
  const L = AGENT_LIMITS;
  return (
    <section className="ob-card" aria-labelledby="agt-new-h">
      <div className="row-between"><h2 id="agt-new-h">Research my notes</h2><span className="ob-muted" style={{ fontSize: 12 }}>The only template for now</span></div>
      <p className="ob-muted">Ask a question your saved notes might answer, for example a release checklist from your deployment notes. The model decides what to search and which found notes to read, within the limits shown, and ends with a draft that cites the notes it read.</p>
      <form className="ob-form agt-form" onSubmit={prepare} noValidate>
        <div className="ob-field">
          <label htmlFor="agt-model">Model</label>
          <select id="agt-model" value={model} disabled={models.status !== 'done' || state.pending} onChange={(e) => setModel(e.target.value)} aria-describedby="agt-model-hint">
            <option value="">{models.status === 'loading' ? 'Reading installed models…' : models.status === 'error' ? 'Ollama did not answer' : models.list.length ? 'Choose an installed model' : 'No installed model supports tool calls'}</option>
            {models.list.map((m) => <option key={m.name} value={m.name}>{m.name}{m.parameterSize ? ` · ${m.parameterSize}` : ''}</option>)}
          </select>
          <span id="agt-model-hint" className="ob-muted" style={{ fontSize: 12.5 }}>{models.status === 'error' ? <>{models.error} <button type="button" className="btn-text" onClick={load}>Try again</button></> : 'Installed in Ollama on this computer and marked by it as supporting structured tool calls. To add a model, use Run on this device.'}</span>
        </div>
        <div className="ob-field">
          <label htmlFor="agt-question">Question</label>
          <textarea id="agt-question" rows={3} value={question} maxLength={L.question} disabled={state.pending} onChange={(e) => setQuestion(e.target.value)} placeholder="Use my saved deployment notes to draft a release checklist. Tell me what is missing and cite each supporting note." aria-describedby="agt-question-count" />
          <span id="agt-question-count" className="ob-muted" style={{ fontSize: 12.5 }}>{question.length.toLocaleString()} of {L.question.toLocaleString()} characters</span>
        </div>
        <div className="ob-field" style={{ maxWidth: 320 }}>
          <label htmlFor="agt-turns">Model turns</label>
          <select id="agt-turns" value={turns} disabled={state.pending} onChange={(e) => setTurns(Number(e.target.value))} aria-describedby="agt-turns-hint">
            {TURN_OPTIONS.map((n) => <option key={n} value={n}>{n}{n === AGENT_LIMITS.modelTurns ? ' (default)' : ''}</option>)}
          </select>
          <span id="agt-turns-hint" className="ob-muted" style={{ fontSize: 12.5 }}>Each search, each note read and the final draft take one turn. A model that reads one note per turn needs more than 4 to read several notes; the other limits do not change.</span>
        </div>
        <dl className="dev-meta">
          <Fact label="Tools the model may call" value={TOOL_NAMES.join(', ')} />
          <Fact label="Limits per run" value={`${turns} model turns · ${L.toolCalls} search or read calls · ${L.passages} notes read, ${L.passageChars.toLocaleString()} characters each · ${L.replyTokens.toLocaleString()} reply tokens per turn · ${L.runMs / 1000} seconds`} />
        </dl>
        {state.error && <p className="ob-alert" role="alert">{state.error}</p>}
        <div><button type="submit" className="btn-app" disabled={!model || !question.trim() || state.pending}>{state.pending ? 'Checking the model…' : 'Prepare the task'}</button> <span className="ob-muted" style={{ fontSize: 12.5 }}>Nothing runs yet: the next screen asks for access first.</span></div>
      </form>
    </section>
  );
}

/* ---------------- One run ---------------- */

function RunPanel({ run, slug, ledger, client, version, live, canRun, onApprove, onDecline, onResume, onStop, onClose, onChanged }) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, [run.id]);
  const recovery = recoveryAction(run); // the one action this stored state allows, decided outside React
  return (
    <section className="ob-card ob-card--strong" aria-labelledby="agt-run-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <div className="cell-stack">
          <h2 id="agt-run-h" ref={headingRef} tabIndex={-1} className="row-wrap gap-10">Run <Badge table={RUN_STATUS} value={run.status} /></h2>
          <span className="ob-muted" style={{ fontSize: 13 }}>Model {run.model.name} · digest <code>{short(run.model.digest)}</code> · prepared {when(run.createdAt)}{run.executions ? ` · ${plural(run.executions, 'execution')}` : ''}</span>
        </div>
        <div className="row-wrap gap-10">
          {live && <button type="button" className="btn-app" onClick={onStop}><Icon name="pause" size={14} /> Stop</button>}
          {!live && ['start', 'resume'].includes(recovery.action) && <button type="button" className="btn-app" onClick={onResume} disabled={!canRun}>{recovery.label}</button>}
          <button type="button" className="btn-ghost" onClick={onClose} disabled={live}>Close</button>
        </div>
      </div>
      <p className="agt-question"><span className="sr-only">Question: </span>{run.task.question}</p>
      {run.status === 'draft' && <GrantCard run={run} canRun={canRun} onApprove={onApprove} onDecline={onDecline} />}
      {run.status !== 'draft' && <StepsList run={run} ledger={ledger} version={version} live={live} />}
      {recovery.note && <p className={run.status === 'failed' ? 'ob-alert' : 'ob-muted'} role={run.status === 'failed' ? 'alert' : 'status'}>{recovery.note}</p>}
      {run.status === 'completed' && <ReviewCard run={run} slug={slug} ledger={ledger} client={client} version={version} onChanged={onChanged} />}
    </section>
  );
}

function GrantCard({ run, canRun, onApprove, onDecline }) {
  const L = run.limits;
  return (
    <div className="dev-confirm" role="group" aria-labelledby="agt-grant-h">
      <h3 id="agt-grant-h" className="mem-h3">Approve access for this run</h3>
      <p style={{ fontSize: 13.5 }}>Search and read my saved notes in exactly this scope, read-only, for this run only. The model never sees the gateway key, cannot write to memory, and has no other tool. What a note says can still sway which notes the model searches and reads and how it words the draft: you review the draft beside the exact excerpts it read.</p>
      <dl className="dev-meta">
        <Fact label="Memory gateway" value={<code>{run.gateway}</code>} />
        <Fact label="Scope" value={`tenant ${run.scope.tenant_id} · workspace ${run.scope.workspace_id} · person ${run.scope.user_id}`} />
        <Fact label="Allowed tools" value={run.policy.tools.join(', ')} />
        <Fact label="Limits" value={`${L.modelTurns} turns · ${L.toolCalls} calls · ${L.passages} notes · ${L.runMs / 1000} s`} />
        <Fact label="Policy" value={<code>{short(run.policy.policyHash)}</code>} />
        <Fact label="Kept locally" value="this task, every step, each note excerpt read, and the draft, unencrypted in this browser’s profile" />
      </dl>
      {run.declinedAt && <p className="ob-muted" role="status" style={{ fontSize: 13 }}>Access was not granted at {when(run.declinedAt)}. The task stays a draft; nothing ran and no note was read. You can still approve it.</p>}
      <div className="row-wrap gap-10">
        <button type="button" className="btn-app" onClick={onApprove} disabled={!canRun}>Approve and run</button>
        <button type="button" className="btn-text" onClick={onDecline}>Decline</button>
      </div>
    </div>
  );
}

const describeStep = (s) => {
  if (s.kind === 'model') return `${s.args?.messages ?? '—'} messages sent${s.result ? ` · ${s.result.toolCalls.length ? `called ${s.result.toolCalls.map((c) => c.name || '?').join(', ')}` : 'replied in text without a tool call; asked again'}` : ''}`;
  if (s.name === 'search_notes') return `query “${s.args?.query ?? ''}” · up to ${s.args?.limit ?? '—'}${s.result?.hits ? ` · ${plural(s.result.hits.length, 'hit')}${s.result.hits.length ? `: ${s.result.hits.map((h) => h.title || h.id).join(', ')}` : ''}` : ''}`;
  if (s.name === 'read_note') return `note ${s.args?.id ?? ''}${s.result?.replayed ? ' · replayed from this run’s frozen excerpt' : ''}${s.result?.contentHash ? ` · hash ${short(s.result.contentHash)}` : ''}`;
  if (s.name === 'finish_draft') return s.result?.citations ? `${plural(s.result.citations.length, 'citation')}` : `${plural(s.args?.citations?.length ?? 0, 'citation')}`;
  return `arguments ${s.args?.preview ?? ''}`;
};

function StepsList({ run, ledger, version, live }) {
  const [steps, setSteps] = useState([]);
  useEffect(() => { ledger.steps(run.id).then(setSteps); }, [ledger, run.id, version]);
  return (
    <div className="cell-stack" style={{ gap: 6 }}>
      <h3 className="mem-h3">Steps</h3>
      <p className="ob-muted" style={{ fontSize: 12.5 }}>Real tool names and what the gateway on this computer answered. The model’s visible text is shown; there is no hidden reasoning to show.</p>
      <ol className="ob-list agt-steps" aria-live="polite" aria-busy={live}>
        {steps.length === 0 && <li><div><span className="ob-muted">{live ? 'Starting…' : 'No step recorded.'}</span></div></li>}
        {steps.map((s) => (
          <li key={s.stepIndex}>
            <div>
              <span className="row-wrap gap-10"><strong>{s.stepIndex + 1}. {s.kind === 'model' ? 'Model turn' : s.name}</strong><Badge table={STEP_STATE} value={s.state} />{s.attempt > 1 && <span className="ob-badge">attempt {s.attempt}</span>}</span>
              <span className="mem-snippet">{describeStep(s)}</span>
              {s.kind === 'model' && s.result?.content && <span className="mem-snippet ob-muted">Model text: {clip(s.result.content, 400)}</span>}
              {s.result?.denied && <span className="ob-error">Denied ({s.result.denied}): {s.result.forModel}</span>}
              {s.error && <span className="ob-error">{s.error.message}</span>}
              <span className="ob-muted">{when(s.startedAt)}{s.endedAt ? ` → ${when(s.endedAt)}` : ''}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------- Review ---------------- */

function ReviewCard({ run, slug, ledger, client, version, onChanged }) {
  const [data, setData] = useState({ status: 'loading' });
  const [check, setCheck] = useState({ status: 'idle' });
  const [keep, setKeep] = useState({ pending: false, error: null });
  const abortRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([ledger.proposal(run.id), ledger.snapshots(run.id)]).then(([proposal, snapshots]) => { if (!cancelled) setData(proposal ? { status: 'done', proposal, snapshots } : { status: 'error', error: 'No draft is recorded for this run.' }); }, (err) => { if (!cancelled) setData({ status: 'error', error: explainAgent(err) }); });
    return () => { cancelled = true; };
  }, [ledger, run.id, version]);
  // Every cited note is read back from the gateway before the draft can be kept; the frozen excerpts are not touched.
  async function recheck(proposal, snapshots) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCheck({ status: 'checking' });
    try {
      const result = await recheckSources({ proposal, snapshots, memory: client, scope: run.scope, signal: controller.signal });
      if (!controller.signal.aborted) setCheck({ status: 'done', ...result });
    } catch (err) { if (!controller.signal.aborted) setCheck({ status: 'error', error: explainMemory(err) }); }
  }
  useEffect(() => { if (data.status === 'done' && data.proposal.state === 'pending') recheck(data.proposal, data.snapshots); return () => abortRef.current?.abort(); }, [data.status, data.proposal?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep is the person's action, so the sources are read back from the gateway inside it, just before the atomic
  // local acceptance of exactly this draft. The check on opening the card is information; this one decides.
  async function keepDraft() {
    if (keep.pending || data.status !== 'done') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setKeep({ pending: true, error: null }); setCheck({ status: 'checking' });
    try {
      const out = await keepLocalDraft({ ledger, proposal: data.proposal, snapshots: data.snapshots, memory: client, scope: run.scope, signal: controller.signal });
      if (controller.signal.aborted) return;
      setCheck({ status: 'done', ...out.check });
      setKeep({ pending: false, error: out.kept ? null : 'A cited note changed after the check, so the draft was not kept. It stays pending with the excerpt the model read.' });
      if (out.kept) onChanged();
    } catch (err) { if (!controller.signal.aborted) { setCheck({ status: 'idle' }); setKeep({ pending: false, error: err?.kind === 'aborted' ? 'The source check did not finish in time, so the draft was not kept. Try again.' : err instanceof MemoryError ? explainMemory(err) : explainAgent(err) }); } }
  }
  async function discard() {
    try { await ledger.rejectProposal(data.proposal.id); onChanged(); } catch (err) { setKeep({ pending: false, error: explainAgent(err) }); }
  }
  if (data.status === 'loading') return <p className="ob-muted" role="status">Loading the draft…</p>;
  if (data.status === 'error') return <p className="ob-alert" role="alert">{data.error}</p>;
  const { proposal, snapshots } = data;
  const byId = new Map(snapshots.map((s) => [s.noteId, s]));
  const stale = check.status === 'done' && !check.ok;
  const stateOf = (id) => check.checks?.find((c) => c.id === id)?.state ?? null;
  return (
    <div className="cell-stack" style={{ gap: 10 }}>
      <h3 className="mem-h3">Draft to review</h3>
      <pre className="mem-content">{proposal.answer}</pre>
      <p className="ob-muted" style={{ fontSize: 12.5 }}>Draft hash <code>{short(proposal.outputHash)}</code>. Citations prove which notes the model read, not that the answer follows from them: read the excerpts yourself.{proposal.citations.length === 0 && <strong> No note is cited, so treat every claim as unsupported.</strong>}</p>
      {proposal.citations.length > 0 && (
        <ul className="mem-passages" aria-label="Cited notes with the excerpt the model read">
          {proposal.citations.map((id) => {
            const s = byId.get(id);
            const st = stateOf(id);
            return (
              <li key={id}>
                <span className="cell-stack" style={{ gap: 4 }}>
                  <strong>{s?.title || 'Untitled'} <span className="ob-muted" style={{ fontWeight: 400 }}>· id {id} · read {when(s?.readAt)} · note updated {when(s?.updatedAt)} · hash <code>{short(s?.contentHash)}</code>{s?.truncated ? ' · excerpt cut at 1,200 characters' : ''}</span></strong>
                  {st && <span className={st === 'unchanged' ? 'ob-ok' : 'ob-error'}>{SOURCE_STATE[st] ?? st}</span>}
                  <span className="mem-snippet">{s?.excerpt ?? 'No frozen excerpt.'}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {proposal.state === 'accepted' && <p className="ob-alert ob-alert--ok" role="status">Kept on this device at {when(proposal.acceptedAt)}{proposal.sourcesCheckedAt ? `, after every cited note was read back unchanged from the gateway at ${when(proposal.sourcesCheckedAt)}` : ''}. It is in this browser’s run history only. To save it as a note, open the <Link to={`/w/${slug}/memory`}>Memory page</Link> and paste it there yourself; nothing is saved to memory by a run.</p>}
      {proposal.state === 'rejected' && <p className="ob-muted" role="status">Discarded at {when(proposal.rejectedAt)}. The run and its steps stay in history.</p>}
      {proposal.state === 'pending' && (
        <>
          {check.status === 'checking' && <p className="ob-muted" role="status">Checking each cited note against the memory gateway…</p>}
          {check.status === 'done' && check.ok && <p className="ob-muted" role="status" style={{ fontSize: 12.5 }}>All cited notes were unchanged when read back at {when(check.checkedAt)}. Keep reads them back once more before storing the draft.</p>}
          {check.status === 'error' && <p className="ob-alert" role="alert">{check.error} <button type="button" className="btn-text" onClick={() => recheck(proposal, snapshots)}>Check again</button></p>}
          {stale && <p className="ob-alert" role="alert">A cited note changed, was superseded or was deleted after the model read it (checked {when(check.checkedAt)}). The excerpt above is what the model actually saw and stays as it is; this draft cannot be kept. Start a new run to use the current notes.</p>}
          {keep.error && <p className="ob-alert" role="alert">{keep.error}</p>}
          <div className="row-wrap gap-10">
            <button type="button" className="btn-app" onClick={keepDraft} disabled={keep.pending || check.status === 'checking' || stale}>{keep.pending ? 'Checking sources, then keeping…' : 'Keep local draft'}</button>
            <button type="button" className="btn-text" onClick={discard} disabled={keep.pending}>Discard</button>
            <span className="ob-muted" style={{ fontSize: 12.5 }}>Keep reads every cited note back from the gateway, then stores exactly this text in this browser. It is never saved to memory by itself.</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- History ---------------- */

function HistoryCard({ runs, selectedId, live, onOpen, onClear }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="ob-card" aria-labelledby="agt-hist-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <h2 id="agt-hist-h">Run history on this device</h2>
        {runs.length > 0 && (confirming ? (
          <span className="row-wrap gap-10" role="group" aria-label="Confirm deleting history">
            <button type="button" className="btn-app" onClick={() => { setConfirming(false); onClear(); }} disabled={Boolean(live)}>Delete history</button>
            <button type="button" className="btn-text" onClick={() => setConfirming(false)}>Keep it</button>
          </span>
        ) : <button type="button" className="btn-text" onClick={() => setConfirming(true)} disabled={Boolean(live)}>Delete history…</button>)}
      </div>
      <p className="ob-muted" style={{ fontSize: 13 }}>Kept in this browser’s local database for this workspace and you, unencrypted: anyone using this browser profile can read it. Deleting it removes the runs, steps, excerpts and drafts here; the notes themselves stay in the memory store.</p>
      {runs.length === 0 ? <p className="ob-muted">No runs yet.</p> : (
        <ol className="ob-list">
          {runs.map((r) => (
            <li key={r.id}>
              <div>
                <span className="row-wrap gap-10"><strong>{clip(r.task.question, 90)}</strong><Badge table={RUN_STATUS} value={r.status} />{r.id === live && <span className="ob-badge tile--blue">In this tab</span>}</span>
                <span className="ob-muted">{r.model.name} · prepared {when(r.createdAt)}{r.finishedAt ? ` · ended ${when(r.finishedAt)}` : ''}</span>
              </div>
              <button type="button" className="btn-small" onClick={() => onOpen(r.id)} disabled={r.id === selectedId} aria-label={`Open run prepared ${when(r.createdAt)}`}>Open</button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AgentDataNotice({ runtimeOrigin, memoryOrigin }) {
  return (
    <details>
      <summary>What leaves this computer</summary>
      <div className="ob-muted" style={{ fontSize: 13.5, padding: '0 0 16px', display: 'grid', gap: 8 }}>
        <p><strong>Stays here:</strong> your question, every search, every note excerpt, the model’s replies and the draft. They go from this page to Ollama at {runtimeOrigin ?? 'the configured runtime'} and to the memory gateway at {memoryOrigin ?? 'the configured origin'}, both on this computer, and nowhere else. The gateway key stays in this tab and is never part of what the model sees.</p>
        <p><strong>Sent to Valcairn:</strong> nothing from this page beyond loading it. Valcairn does not learn that a run happened, what was asked, read or drafted.</p>
        <p><strong>Kept in this browser:</strong> each run’s task, access grant, steps, the frozen excerpt and hash of every note read, and reviewed drafts, in this browser’s local database for this workspace and you. It is not encrypted; Delete history removes it. No server queue exists: a run ends when this tab does, and only you can resume it.</p>
        <p><strong>Not offered:</strong> writing to memory from a run, other tools, several agents at once, shared agents, scheduled or background runs, remote GPUs.</p>
      </div>
    </details>
  );
}
