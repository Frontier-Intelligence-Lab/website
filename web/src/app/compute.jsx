import { useCallback, useEffect, useState } from 'react';
import { useLoaderData } from 'react-router';
import { api } from '../api.js';
import { FieldError, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';

const MANAGERS = ['owner', 'admin'];
const ONLINE_MS = 90_000;
const FINISHED = ['succeeded', 'failed', 'cancelled'];
const KIND = { probe: 'Sandbox check', train: 'Training', evaluate: 'Evaluation', export: 'Export' };
const STATUS = { queued: 'Waiting for the runner', leased: 'Starting', running: 'Running', cancel_requested: 'Stopping', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' };
const TONE = { succeeded: 'tile--green', failed: 'tile--orange', running: 'tile--blue', leased: 'tile--blue', cancel_requested: 'tile--violet' };
const FAILURE = {
  cancelled: 'Cancelled.', sandbox_unavailable: 'Docker is not running on the runner.', sandbox_error: 'The sandbox stopped with an error.',
  out_of_memory: 'The runner ran out of memory.', disk_full: 'The runner’s disk is full.', dataset_error: 'The dataset could not be read.',
  model_unavailable: 'The model is not available on the runner.', runtime_error: 'The job stopped with an error on the runner.',
  timeout: 'The job ran past its time limit.', unsupported: 'This runner version cannot run this kind of job yet.',
  lease_expired: 'The runner stopped responding, three times.', runner_revoked: 'The runner was disconnected while it held the job.',
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const online = (r) => r.status === 'active' && r.lastSeenAt && Date.now() - new Date(r.lastSeenAt).getTime() < ONLINE_MS;

export async function computeLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [{ runners }, { jobs }, models] = await Promise.all([api.runners(entry.id), api.jobs(entry.id), api.models(entry.id)]);
  // Plans approved to run on a runner; the server checks the plan again when a job is queued.
  const plans = models.runs.filter((r) => r.status === 'requested' && r.compute === 'runner');
  return { account, entry, runners, jobs, plans, catalog: models.catalog };
}

export function Compute() {
  const { account, entry, runners: initialRunners, jobs: initialJobs, plans, catalog } = useLoaderData();
  const [runners, setRunners] = useState(initialRunners);
  const [jobs, setJobs] = useState(initialJobs);
  const [open, setOpen] = useState(null);
  const [notice, setNotice] = useState(null);
  const manager = MANAGERS.includes(entry.role);

  const refresh = useCallback(async () => {
    const [r, j] = await Promise.all([api.runners(entry.id).catch(() => null), api.jobs(entry.id).catch(() => null)]);
    if (r) setRunners(r.runners);
    if (j) setJobs(j.jobs);
  }, [entry.id]);

  // Poll while something can change: a job that has not finished, or a runner that has not reported yet.
  const live = jobs.some((j) => !FINISHED.includes(j.status)) || runners.some((r) => r.status === 'active');
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  const queue = async (runner, body, what) => {
    const res = await api.createJob(entry.id, { runnerId: runner.id, idempotencyKey: crypto.randomUUID(), ...body }).catch(() => null);
    if (!res?.ok) return setNotice({ text: Object.values(res?.data?.errors ?? {})[0] ?? res?.data?.error ?? 'Valcairn could not be reached. Try again.' });
    setNotice({ tone: 'ok', text: `${what} queued on ${runner.label}. It starts when the runner next checks in.` });
    setOpen(res.data.job.id);
    refresh();
  };
  const queueProbe = (runner) => queue(runner, { kind: 'probe' }, 'Sandbox check');

  const active = runners.filter((r) => r.status === 'active');
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Compute" current="compute">
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Compute · {entry.name}</span>
        <h1 className="ob-h1">Compute</h1>
        <p className="ob-lede">Link your own machines as Valcairn Runners. Jobs run there in a locked-down sandbox with no network access. Valcairn never connects to the machine: the runner calls in.</p>
        <div className="ob-chips" style={{ gap: 6 }} aria-label="What runs on a runner">
          <span className="ob-badge tile--green">Available · Sandbox check</span>
          <span className="ob-badge tile--green">Fine-tuning (LoRA) · runner 0.2 or later</span>
          <span className="ob-badge">Planned · Evaluation</span>
          <span className="ob-badge">Export to Ollama · runner 0.3 or later</span>
        </div>
      </div>
      {notice && <p className={`ob-alert${notice.tone === 'ok' ? ' ob-alert--ok' : ''}`} role="status">{notice.text}</p>}
      {manager ? <LinkCard workspaceId={entry.id} onLinked={refresh} /> : <p className="ob-muted">Owners and admins link runners and start jobs. You can see them here.</p>}
      {manager && plans.length > 0 && <PlansCard plans={plans} catalog={catalog} runners={active} onStart={(runner, plan) => queue(runner, { kind: 'train', enhanceRunId: plan.id }, `Training “${plan.name}”`)} />}
      <RunnersCard runners={runners} manager={manager} onProbe={queueProbe} workspaceId={entry.id} onChange={refresh} />
      <JobsCard jobs={jobs} runners={runners} manager={manager} workspaceId={entry.id} open={open} setOpen={setOpen} onChange={refresh} hasRunner={active.length > 0} />
    </WorkspaceShell>
  );
}

function LinkCard({ workspaceId, onLinked }) {
  const [label, setLabel] = useState('');
  const [state, setState] = useState({});
  const [key, setKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setState({ pending: true });
    const res = await api.linkRunner(workspaceId, label).catch(() => null);
    if (!res?.ok) return setState({ error: res?.data?.errors?.label ?? res?.data?.error ?? 'Valcairn could not be reached. Try again.' });
    setState({});
    setLabel('');
    setKey(res.data.key);
    onLinked();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(key); setCopied(true); } catch { setCopied(false); }
  };
  const origin = window.location.origin;
  return (
    <section className="ob-card" aria-labelledby="link-h">
      <div className="row-between"><h2 id="link-h">Link a machine</h2><Tile icon="link" tone="green" /></div>
      {key ? (
        <div className="dev-confirm" role="region" aria-label="New runner key">
          <strong>Copy this key now. It is shown only once.</strong>
          <code className="dev-pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{key}</code>
          <div className="row-wrap gap-10">
            <button type="button" className="btn-app" onClick={copy}>{copied ? 'Copied' : 'Copy key'}</button>
            <button type="button" className="btn-text" onClick={() => { setKey(null); setCopied(false); }}>I saved it</button>
          </div>
          <p className="ob-muted" style={{ fontSize: 13 }}>Save the key to a file only you can read, then start the runner from <code>services/runner</code> (needs Python 3.11 and Docker):</p>
          <pre className="dev-pre">{`$env:VALCAIRN_URL = '${origin}'\n$env:VALCAIRN_RUNNER_KEY_FILE = "$HOME\\.valcairn-runner-key"\nuv run valcairn-runner run`}</pre>
          <p className="ob-muted" style={{ fontSize: 13 }}>macOS and Linux: <code>VALCAIRN_URL={origin} VALCAIRN_RUNNER_KEY_FILE=~/.valcairn-runner-key uv run valcairn-runner run</code></p>
        </div>
      ) : (
        <>
          <p className="ob-muted">A runner leases one job at a time, runs it in a Docker sandbox with no network, and reports progress. Disconnect it at any time.</p>
          <form className="ob-form" style={{ maxWidth: 520 }} onSubmit={submit} noValidate>
            <div className="ob-field">
              <label htmlFor="runner-label">Name this machine</label>
              <input id="runner-label" type="text" value={label} maxLength={80} placeholder="For example Lab workstation" aria-invalid={Boolean(state.error)} aria-describedby="runner-label-error" onChange={(e) => setLabel(e.target.value)} />
              <FieldError id="runner-label-error">{state.error}</FieldError>
            </div>
            <button type="submit" className="btn-app" disabled={state.pending}>{state.pending ? 'Linking…' : 'Link and show key'}</button>
          </form>
        </>
      )}
    </section>
  );
}

function PlansCard({ plans, catalog, runners, onStart }) {
  const [runnerId, setRunnerId] = useState(runners[0]?.id ?? '');
  const [pending, setPending] = useState(null);
  const runner = runners.find((r) => r.id === runnerId) ?? runners[0];
  const model = (id) => catalog.find((m) => m.id === id)?.name ?? id;
  return (
    <section className="ob-card" aria-labelledby="plans-h">
      <div className="row-between"><h2 id="plans-h">Approved plans for your runner</h2><Tile icon="target" tone="violet" /></div>
      <p className="ob-muted">Each was approved with compute set to your runner. Training runs in the sandbox with no network; about 10% of the examples are held out to compare the base and the tuned model.</p>
      {runners.length > 1 && (
        <div className="ob-field" style={{ maxWidth: 320 }}>
          <label htmlFor="plan-runner">Runner</label>
          <select id="plan-runner" value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>{runners.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
        </div>
      )}
      {plans.map((p) => (
        <div key={p.id} className="row-between" style={{ flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
          <div className="cell-stack">
            <strong>{p.name}</strong>
            <span className="ob-muted" style={{ fontSize: 13 }}>{model(p.baseModelId)} · {plural(p.datasets.length, 'dataset version')} · {p.steps.join(', ')}</span>
          </div>
          <button type="button" className="btn-app" disabled={!runner || pending === p.id} onClick={async () => { setPending(p.id); await onStart(runner, p); setPending(null); }}>
            {runner ? `Start training on ${runner.label}` : 'Link a runner first'}
          </button>
        </div>
      ))}
    </section>
  );
}

function LossChart({ points }) {
  if (points.length < 2) return null;
  const w = 320, h = 90, max = Math.max(...points.map((p) => p.value)), min = Math.min(...points.map((p) => p.value));
  const x = (i) => (i / (points.length - 1)) * (w - 8) + 4;
  const y = (v) => h - 6 - ((v - min) / (max - min || 1)) * (h - 12);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }} role="img" aria-label={`Training loss over ${points.length} logged steps, from ${points[0].value.toFixed(3)} to ${points.at(-1).value.toFixed(3)}`}>
        <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
      </svg>
      <figcaption className="ob-muted" style={{ fontSize: 12 }}>Training loss by step, {points[0].value.toFixed(3)} → {points.at(-1).value.toFixed(3)}</figcaption>
    </figure>
  );
}

function RunnersCard({ runners, manager, onProbe, workspaceId, onChange }) {
  return (
    <section className="ob-card" aria-labelledby="runners-h">
      <div className="row-between"><h2 id="runners-h">Runners</h2><span className="ob-muted" style={{ fontSize: 12 }}>Reported by each runner</span></div>
      {runners.length === 0 ? <p className="ob-muted">No runners yet. Link a machine above, then start the runner on it.</p> : runners.map((r) => <RunnerRow key={r.id} runner={r} manager={manager} onProbe={onProbe} workspaceId={workspaceId} onChange={onChange} />)}
    </section>
  );
}

function RunnerRow({ runner: r, manager, onProbe, workspaceId, onChange }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const caps = r.capabilities ?? {};
  const state = r.status === 'revoked' ? 'Disconnected' : online(r) ? 'Online' : r.lastSeenAt ? `Offline · last seen ${when(r.lastSeenAt)}` : 'Waiting for the runner to start';
  const revoke = async () => {
    setPending(true);
    await api.revokeRunner(workspaceId, r.id).catch(() => null);
    setPending(false);
    setConfirming(false);
    onChange();
  };
  const probe = async () => { setPending(true); await onProbe(r); setPending(false); };
  return (
    <div className="dev-facts-col" style={{ marginTop: 12 }}>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="cell-stack">
          <strong>{r.label}</strong>
          <span className="ob-muted" style={{ fontSize: 13 }}><span className={`ob-badge ${online(r) ? 'tile--green' : ''}`}>{state}</span> · key <code>{r.keyPrefix}…</code></span>
        </div>
        {manager && r.status === 'active' && (
          <div className="row-wrap gap-10">
            <button type="button" className="btn-ghost" onClick={probe} disabled={pending}>Run sandbox check</button>
            {confirming ? (
              <span className="row-wrap gap-10" role="group" aria-label="Confirm disconnect">
                <button type="button" className="btn-app" onClick={revoke} disabled={pending}>Disconnect runner</button>
                <button type="button" className="btn-text" onClick={() => setConfirming(false)}>Keep it</button>
              </span>
            ) : <button type="button" className="btn-text" onClick={() => setConfirming(true)}>Disconnect…</button>}
          </div>
        )}
      </div>
      {confirming && <p className="ob-muted" style={{ fontSize: 13 }}>Its key stops working at once. A job it is running fails, and waiting jobs are cancelled.</p>}
      {r.lastSeenAt && (
        <dl className="dev-facts" style={{ display: 'grid', gap: 8 }}>
          <div className="dev-fact"><dt>GPUs</dt><dd>{caps.gpus?.length ? caps.gpus.map((g) => `${g.name} · ${Math.round(g.memoryMb / 1024)} GB`).join(', ') : 'None reported'}</dd></div>
          <div className="dev-fact"><dt>Sandbox</dt><dd>{caps.sandbox?.available ? `Docker ${caps.sandbox.version ?? ''}${caps.sandbox.gpu ? ' · GPU' : ' · no GPU'}` : 'Docker not running'}</dd></div>
          <div className="dev-fact"><dt>Ollama</dt><dd>{caps.ollama?.reachable ? `${caps.ollama.version ?? ''} · ${plural(caps.ollama.models?.length ?? 0, 'local model')}` : 'Not reachable'}</dd></div>
          <div className="dev-fact"><dt>Platform</dt><dd>{caps.platform ?? '—'} · runner {caps.runnerVersion ?? '—'}</dd></div>
        </dl>
      )}
    </div>
  );
}

function JobsCard({ jobs, runners, manager, workspaceId, open, setOpen, onChange, hasRunner }) {
  const label = (id) => runners.find((r) => r.id === id)?.label ?? 'Runner';
  return (
    <section className="ob-card" aria-labelledby="jobs-h">
      <div className="row-between"><h2 id="jobs-h">Jobs</h2><span className="ob-muted" style={{ fontSize: 12 }}>Latest 50</span></div>
      {jobs.length === 0 ? <p className="ob-muted">{hasRunner ? 'No jobs yet. Run a sandbox check on a runner to see one.' : 'Jobs appear here once a runner is linked.'}</p> : (
        <div className="ob-table-wrap">
          <table>
            <thead><tr><th scope="col">Queued</th><th scope="col">Job</th><th scope="col" className="cmp-wide">Runner</th><th scope="col">Status</th><th scope="col" className="cmp-wide">Attempt</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{when(j.createdAt)}</td>
                  <td>{KIND[j.kind] ?? j.kind}</td>
                  <td className="cmp-wide">{label(j.runnerId)}</td>
                  <td><span className={`ob-badge ${TONE[j.status] ?? ''}`}>{STATUS[j.status] ?? j.status}</span></td>
                  <td className="cmp-wide">{j.attempt ? `${j.attempt} of ${j.maxAttempts}` : '—'}</td>
                  <td><button type="button" className="btn-text" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}>{open === j.id ? 'Hide' : 'Details'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <JobDetail key={open} workspaceId={workspaceId} jobId={open} manager={manager} onChange={onChange} onOpen={setOpen} />}
    </section>
  );
}

// Every stage, log and artifact; for each metric only its latest value, so a long training run stays readable.
const visible = (events) => events.filter((e, i) => e.kind !== 'metric' || !events.slice(i + 1).some((n) => n.kind === 'metric' && n.data.name === e.data.name));

function JobDetail({ workspaceId, jobId, manager, onChange, onOpen }) {
  const [job, setJob] = useState(null);
  const [events, setEvents] = useState([]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let stop = false;
    let after = 0;
    let timer;
    const load = async () => {
      const res = await api.job(workspaceId, jobId, after).catch(() => null);
      if (stop || !res?.ok) return;
      setJob(res.data.job);
      if (res.data.events.length) {
        after = res.data.events.at(-1).id;
        setEvents((prev) => [...prev, ...res.data.events.filter((e) => !prev.some((p) => p.id === e.id))]);
      }
      if (!FINISHED.includes(res.data.job.status)) timer = setTimeout(load, 2000);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [workspaceId, jobId]);
  if (!job) return <p className="ob-muted" role="status">Loading the job…</p>;
  const cancel = async () => {
    setPending(true);
    await api.cancelJob(workspaceId, jobId).catch(() => null);
    setPending(false);
    onChange();
  };
  const result = job.result ?? {};
  const exportRun = async () => {
    setPending(true);
    const res = await api.createJob(workspaceId, { kind: 'export', runnerId: job.runnerId, enhanceRunId: job.enhanceRunId, trainJobId: job.id, idempotencyKey: crypto.randomUUID() }).catch(() => null);
    setPending(false);
    onChange();
    if (res?.ok) onOpen(res.data.job.id);
  };
  const score = (s) => (s ? `${(s.f1 * 100).toFixed(1)}% token F1 · ${(s.exact * 100).toFixed(0)}% exact` : '—');
  return (
    <div className="dev-facts-col" style={{ marginTop: 12 }} aria-live="polite">
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3>{KIND[job.kind] ?? job.kind} · {STATUS[job.status] ?? job.status}</h3>
        {manager && !FINISHED.includes(job.status) && job.status !== 'cancel_requested' && <button type="button" className="btn-ghost" onClick={cancel} disabled={pending}>Cancel job</button>}
      </div>
      {job.status === 'failed' && <p className="tone-warn">{FAILURE[job.failure] ?? 'The job failed.'}</p>}
      {job.kind === 'probe' && job.status === 'succeeded' && (
        <p>Sandbox ran with network <strong>{result.network}</strong>; {plural(result.sandboxGpus?.length ?? 0, 'GPU')} visible inside it{result.sandboxGpus?.length ? ` (${result.sandboxGpus.map((g) => `${g.name}, ${Math.round(g.memoryMb / 1024)} GB`).join('; ')})` : ''}. Ollama {result.ollamaReachable ? 'reachable' : 'not reachable'} on the runner.</p>
      )}
      {job.kind === 'train' && job.status === 'succeeded' && (
        <dl className="dev-facts" style={{ display: 'grid', gap: 8 }}>
          <div className="dev-fact"><dt>Held-out loss, base model</dt><dd>{result.baseHeldOutLoss?.toFixed(4)}</dd></div>
          <div className="dev-fact"><dt>Held-out loss, tuned</dt><dd><strong>{result.tunedHeldOutLoss?.toFixed(4)}</strong></dd></div>
          <div className="dev-fact"><dt>Examples</dt><dd>{result.trainExamples} trained · {result.heldOutExamples} held out</dd></div>
          <div className="dev-fact"><dt>Training</dt><dd>{result.steps} steps · {result.trainSeconds} s · {result.gpus?.join(', ')}</dd></div>
          <div className="dev-fact"><dt>Adapter</dt><dd><code>{result.adapter?.sha256?.slice(0, 16)}…</code> · {Math.round((result.adapter?.sizeBytes ?? 0) / 2 ** 20)} MB, on the runner</dd></div>
        </dl>
      )}
      {job.kind === 'train' && job.status === 'succeeded' && result.evaluation && (
        <dl className="dev-facts" style={{ display: 'grid', gap: 8 }} aria-label="Answers on held-out examples">
          <div className="dev-fact"><dt>Held-out answers, base</dt><dd>{score(result.evaluation.base)}</dd></div>
          <div className="dev-fact"><dt>Held-out answers, tuned</dt><dd><strong>{score(result.evaluation.tuned)}</strong></dd></div>
        </dl>
      )}
      {(result.samples ?? []).slice(0, 2).map((s, i) => (
        <div key={i} className="dev-confirm" style={{ gap: 6 }}>
          <span className="ob-muted" style={{ fontSize: 12 }}>Held-out example {i + 1} · never trained on</span>
          <span><strong>Prompt:</strong> {s.prompt}</span>
          <span><strong>Base:</strong> {s.base}</span>
          <span><strong>Tuned:</strong> {s.tuned}</span>
        </div>
      ))}
      {manager && job.kind === 'train' && job.status === 'succeeded' && <button type="button" className="btn-app" onClick={exportRun} disabled={pending} style={{ alignSelf: 'flex-start' }}>Export to Ollama on this runner</button>}
      {job.kind === 'export' && job.status === 'succeeded' && (
        <dl className="dev-facts" style={{ display: 'grid', gap: 8 }} aria-label="Export">
          <div className="dev-fact"><dt>In Ollama as</dt><dd><code>{result.ollamaModel}</code></dd></div>
          <div className="dev-fact"><dt>GGUF</dt><dd><code>{result.gguf?.sha256?.slice(0, 16)}…</code> · {result.gguf?.quantization} · {Math.round((result.gguf?.sizeBytes ?? 0) / 2 ** 20)} MB</dd></div>
          <div className="dev-fact"><dt>Speed, tuned</dt><dd>{result.loadTest?.tuned?.tokensPerSec?.toFixed(1)} tok/s</dd></div>
          <div className="dev-fact"><dt>Speed, base</dt><dd>{result.loadTest?.base ? `${result.loadTest.base.tokensPerSec.toFixed(1)} tok/s (${result.loadTest.base.model})` : 'Base not installed in Ollama'}</dd></div>
          <div className="dev-fact"><dt>Manifest</dt><dd><code>{result.manifestSha256?.slice(0, 16)}…</code> · with model card and license</dd></div>
        </dl>
      )}
      {job.kind === 'train' && <LossChart points={events.filter((e) => e.kind === 'metric' && e.data.name === 'train_loss').map((e) => e.data)} />}
      <ol className="dev-steps" aria-label="Job events">
        {events.length === 0 ? <li className="ob-muted">No events yet.</li> : visible(events).map((e) => (
          <li key={e.id}>
            <span className="ob-muted" style={{ fontSize: 12 }}>{when(e.createdAt)} · attempt {e.attempt}</span>{' '}
            {e.kind === 'stage' && <>Stage <strong>{e.data.name}</strong> {e.data.status}</>}
            {e.kind === 'metric' && <><strong>{e.data.name}</strong> = {Number(e.data.value).toLocaleString()}{e.data.step != null ? ` (step ${e.data.step})` : ''}</>}
            {e.kind === 'log' && <span className={e.data.level === 'error' ? 'tone-warn' : undefined}>{e.data.message}</span>}
            {e.kind === 'artifact' && <>Artifact <strong>{e.data.name}</strong> · <code>{e.data.sha256.slice(0, 12)}…</code></>}
          </li>
        ))}
      </ol>
    </div>
  );
}
