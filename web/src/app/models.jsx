import { useEffect, useRef, useState } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useParams, useRevalidator, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { MAX_RUN_DATASETS } from '../../../src/lib/models.js';
import { FieldError, Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';
import { JOB_WINDOW, computeJobPath, createJobsLoader, execution, exportSummary, jobRow, jobWindow, planJobs, planState, trainingSummary, weightsState } from './plan-jobs.js';

// Memory bars show approximate weight sizes against one 80 GB H100; runtime and training need more than the weights.
const GPU_GB = 80;
const GPU_TONE = { 1: 'blue', 2: 'violet', 4: 'teal' };
const WRITERS = ['owner', 'admin', 'member'];
const MANAGERS = ['owner', 'admin'];
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const archLabel = (m) => (m.architecture === 'moe' ? `MoE · ${m.active} active` : 'dense');
const pct = (gb) => `${Math.min(100, (gb / GPU_GB) * 100).toFixed(1)}%`;
const gpuLabel = (n) => `${n} GPU${n === 1 ? '' : 's'}`;
// Pulls and runs keep their model id after the model leaves the catalog: they stay listed and say so.
const UNLISTED = 'not in the current catalog';
const modelLabel = (catalog, id) => catalog.find((m) => m.id === id)?.name ?? `${id} (${UNLISTED})`;

export async function modelsLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const data = await api.models(entry.id);
  return { account, entry, ...data };
}

export async function enhanceLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [options, existing] = await Promise.all([
    api.enhanceOptions(entry.id),
    params.runId ? api.enhanceRun(entry.id, params.runId) : null,
  ]);
  return { account, entry, options, run: existing?.run ?? null };
}

function Glyph({ model, size = 36 }) {
  return <span className={`mdl-glyph tile--${model.tone}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">{model.monogram}</span>;
}

function MemoryBars({ model }) {
  return (
    <div className="mdl-mem">
      {model.formats.map((f) => (
        <div key={f.format} className="mdl-mem-row">
          <span className="ob-muted">{f.format}</span>
          <span className="mdl-meter" aria-hidden="true"><span className={f.format === '4-bit' ? 'k-orange' : 'k-blue'} style={{ width: pct(f.gb) }} /></span>
          <span>{f.gb} GB</span>
        </div>
      ))}
    </div>
  );
}

function PullState({ pull }) {
  if (!pull) return <span className="ob-muted">Not pulled</span>;
  if (pull.status === 'ready') return <span className="ob-ok">In your storage</span>;
  return <span className="mdl-requested">Pull requested</span>;
}

const pullNote = 'Requested only: no weights have been copied. Copying into workspace storage is planned.';

/* ---------------- Catalog ---------------- */

const FILTERS = [
  ['gpu1', '1 GPU', (m) => m.loraGpus === 1, 'k-blue'],
  ['gpu2', '2 GPUs', (m) => m.loraGpus === 2, 'k-violet'],
  ['gpu4', '4 GPUs', (m) => m.loraGpus === 4, 'k-teal'],
  ['vision', 'Vision', (m) => m.modalities.includes('vision')],
  ['reasoning', 'Reasoning', (m) => m.tags.includes('reasoning')],
  ['apache', 'Apache 2.0', (m) => m.license === 'Apache 2.0'],
];

export function ModelCatalog() {
  const { account, entry, role, pulls, catalog } = useLoaderData();
  const [filter, setFilter] = useState(null);
  const [selectedId, setSelectedId] = useState(catalog[0]?.id);
  const pullOf = (id) => pulls.find((p) => p.modelId === id);
  const active = FILTERS.find(([id]) => id === filter);
  const shown = active ? catalog.filter(active[2]) : catalog;
  const selected = shown.find((m) => m.id === selectedId) ?? shown[0];
  const counts = [1, 2, 4].map((n) => ({ n, count: catalog.filter((m) => m.loraGpus === n).length }));
  const shell = { account, entry, role, title: 'Model catalog', current: 'models-catalog' };
  const header = (
    <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Models · {entry.name}</span>
        <h1 className="ob-h1">Model catalog</h1>
        <p className="ob-lede">Open-weight models you can request for this workspace and plan to enhance on your approved datasets. A pull is a recorded request and a run is an approved plan. Copying weights into workspace storage, hosted GPU scheduling and charges are planned; a plan's fine-tuning and export run only as jobs on a runner linked to the workspace. Any weights you receive stay under each model's own license.</p>
        <div className="ob-chips" style={{ gap: 6 }}>
          <span className="ob-badge">{plural(catalog.length, 'model')}</span>
          {pulls.length > 0 && <span className="ob-badge tile--blue">{plural(pulls.length, 'pull request')}</span>}
        </div>
      </div>
      <Link className="btn-ghost" to={`/w/${entry.slug}/models/mine`}>My models</Link>
    </div>
  );
  // The server had no catalog file, or an empty one: say so instead of showing empty filters.
  if (catalog.length === 0) {
    return (
      <WorkspaceShell {...shell}>
        {header}
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="layers" tone="plain" size="lg" />
          <h2>No models available</h2>
          <p className="ob-muted">This deployment has no model catalog yet, so there is nothing to pull. Models pulled earlier stay listed under My models.</p>
        </section>
      </WorkspaceShell>
    );
  }
  return (
    <WorkspaceShell {...shell}>
      {header}

      <section className="ob-card">
        <div className="row-between"><h2>What you can fine-tune</h2><span className="ob-muted" style={{ fontSize: 12 }}>GPUs needed for a LoRA fine-tune</span></div>
        <div className="ds-bar" aria-hidden="true">
          {counts.filter((c) => c.count).map((c) => <span key={c.n} className={`k-${GPU_TONE[c.n]}${filter?.startsWith('gpu') && filter !== `gpu${c.n}` ? ' is-dim' : ''}`} style={{ flex: `${c.count} 1 0` }} />)}
        </div>
        <div className="ob-chips">
          <button type="button" className="ob-chip ds-chip" aria-pressed={!filter} onClick={() => setFilter(null)}>All · {catalog.length}</button>
          {FILTERS.map(([id, label, test, tone]) => (
            <button key={id} type="button" className={`ob-chip ds-chip ${tone ?? 'k-plain'}`} aria-pressed={filter === id} onClick={() => setFilter(filter === id ? null : id)}>
              {tone && <span className="ds-dot" aria-hidden="true" />}{label} <span className="ob-muted">{catalog.filter(test).length}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="ds-split">
        <div className="ds-main">
          {shown.length === 0 ? <p className="ob-muted">No models match this filter.</p> : (
            <div className="ds-grid mdl-grid">
              {shown.map((m) => (
                <button key={m.id} type="button" className={`ds-card k-${GPU_TONE[m.loraGpus]}`} aria-pressed={selected?.id === m.id} onClick={() => setSelectedId(m.id)}>
                  <span className="mdl-plate">
                    <span className="row-between" style={{ alignItems: 'flex-start' }}><Glyph model={m} /><span className="mdl-size"><strong>{m.params}</strong><span className="ob-muted">{archLabel(m)}</span></span></span>
                    <span className="mdl-plate-mem"><span className="mdl-meter" aria-hidden="true"><span style={{ width: pct(m.formats[0].gb), background: 'var(--tone)' }} /></span><span className="ob-muted">{m.formats[0].gb} GB of one {GPU_GB} GB GPU</span></span>
                  </span>
                  <span className="ds-card-body">
                    <span className="ds-card-name"><span className="ds-dot" aria-hidden="true" /><span>{m.name}</span></span>
                    <span className="ob-muted" style={{ fontSize: 12.5 }}>{m.license} · {m.contextK}K context</span>
                    <span style={{ fontSize: 12.5 }}><PullState pull={pullOf(m.id)} /></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {selected && <aside className="ds-side"><ModelPanel entry={entry} role={role} model={selected} pull={pullOf(selected.id)} /></aside>}
      </div>
    </WorkspaceShell>
  );
}

function PullButton({ entry, model, label = 'Pull to workspace' }) {
  const revalidator = useRevalidator();
  const [state, setState] = useState({ pending: false, error: null });
  async function pull() {
    setState({ pending: true, error: null });
    const res = await api.pullModel(entry.id, model.id).catch(() => null);
    if (!res?.ok) return setState({ pending: false, error: res?.data.error ?? 'That did not work. Check your connection and try again.' });
    setState({ pending: false, error: null });
    revalidator.revalidate();
  }
  return (
    <>
      <button type="button" className="btn-app" disabled={state.pending} onClick={pull}><Icon name="download" size={16} stroke={2} />{state.pending ? 'Requesting…' : label}</button>
      {state.error && <p className="ob-error" role="alert">{state.error}</p>}
    </>
  );
}

function ModelActions({ entry, role, model, pull }) {
  const writer = WRITERS.includes(role);
  return (
    <div className="mdl-actions">
      {pull
        ? (writer && <Link className="btn-app" to={`/w/${entry.slug}/models/runs/new?base=${model.id}`}>Enhance on your data</Link>)
        : (writer ? <PullButton entry={entry} model={model} /> : <p className="ob-muted">Owners, admins and members can pull models.</p>)}
      <button type="button" className="btn-ghost" disabled title="Available once the weights are in your storage"><Icon name="download" size={16} stroke={2} />Download weights</button>
      {pull?.status === 'requested' && <p className="ob-muted" style={{ fontSize: 12.5 }}>{pullNote}</p>}
    </div>
  );
}

function ModelPanel({ entry, role, model, pull }) {
  return (
    <section className="ob-card mdl-panel">
      <div className="mdl-panel-top">
        <div className="row-between" style={{ alignItems: 'flex-start' }}><Glyph model={model} size={44} /><span className="mdl-size mdl-size--lg"><strong>{model.params}</strong><span className="ob-muted">parameters, {archLabel(model)}</span></span></div>
        <div className="cell-stack" style={{ gap: 6 }}><strong style={{ fontSize: 12.5 }}>Memory by format</strong><MemoryBars model={model} /><span className="ob-muted" style={{ fontSize: 11.5 }}>Approximate weight size; full bar is one {GPU_GB} GB H100. Running or training needs more.</span></div>
      </div>
      <div className="cell-stack" style={{ gap: 6 }}>
        <span className="ob-chips" style={{ gap: 6 }}>
          {model.modalities.map((x) => <span key={x} className="ob-badge tile--blue">{x === 'vision' ? 'Vision' : 'Text'}</span>)}
          {model.tags.includes('reasoning') && <span className="ob-badge tile--violet">Reasoning</span>}
        </span>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>{model.name}</h2>
      </div>
      <dl className="ds-dl">
        <dt>License</dt><dd>{model.license}{model.commercial ? ' · commercial use' : ''}</dd>
        <dt>Context</dt><dd>{model.contextK}K tokens{model.contextNote ? ` (${model.contextNote})` : ''}</dd>
        <dt>Fine-tune on</dt><dd>{gpuLabel(model.loraGpus)} with LoRA</dd>
        <dt>Source</dt><dd className="mono" style={{ fontSize: 12.5 }}>{model.source}</dd>
        <dt>In workspace</dt><dd><PullState pull={pull} /></dd>
      </dl>
      <ModelActions entry={entry} role={role} model={model} pull={pull} />
      <Link to={`/w/${entry.slug}/models/catalog/${model.id}`} style={{ fontSize: 14, fontWeight: 600 }}>Open the model page</Link>
    </section>
  );
}

/* ---------------- Model page ---------------- */

export function ModelDetail() {
  const { account, entry, role, pulls, catalog, methods } = useLoaderData();
  const { modelId } = useParams();
  const model = catalog.find((m) => m.id === modelId);
  if (!model) throw new Response('Not found', { status: 404 });
  const pull = pulls.find((p) => p.modelId === model.id);
  const writer = WRITERS.includes(role);
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={model.name} current="models-catalog">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <Glyph model={model} size={56} />
          <div className="ob-intro" style={{ gap: 8 }}>
            <Link className="ob-eyebrow" to={`/w/${entry.slug}/models`}>Models · Catalog</Link>
            <h1 className="ob-h1">{model.name}</h1>
            <p className="ob-lede">{model.summary}</p>
            <div className="ob-chips" style={{ gap: 6 }}>
              <span className="ob-badge">{model.license}</span>
              <span className="ob-badge">{model.contextK}K context</span>
              <span className="ob-badge">by {model.maker}</span>
              {pull && <span className="ob-badge tile--teal">{pull.status === 'ready' ? 'In your storage' : 'Pull requested'}</span>}
            </div>
          </div>
        </div>
        <div>
          <button type="button" className="btn-ghost" disabled title="Available once the weights are in your storage"><Icon name="download" size={16} stroke={2} />Download weights</button>
          {pull ? writer && <Link className="btn-app" to={`/w/${entry.slug}/models/runs/new?base=${model.id}`}>Enhance on your data</Link> : writer && <PullButton entry={entry} model={model} />}
        </div>
      </div>

      <div className="mdl-stats ob-card">
        <div><span className="ob-muted">Parameters</span><strong>{model.params}</strong><span className="ob-muted">{archLabel(model)}</span></div>
        <div><span className="ob-muted">Context</span><strong>{model.contextK}K</strong><span className="ob-muted">tokens</span></div>
        <div><span className="ob-muted">Fine-tune on</span><strong>{gpuLabel(model.loraGpus)}</strong><span className="ob-muted">LoRA on H100s</span></div>
        <div><span className="ob-muted">In your storage</span><strong>{pull?.status === 'ready' ? `${model.formats[0].gb} GB` : '—'}</strong><span className="ob-muted">{pull ? (pull.status === 'ready' ? 'ready' : `requested ${date(pull.createdAt)}`) : 'not pulled'}</span></div>
      </div>

      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <div className="row-between"><h2>Memory by format</h2><span className="ob-muted" style={{ fontSize: 12 }}>Approximate weights; full bar is one {GPU_GB} GB H100</span></div>
            <MemoryBars model={model} />
          </section>
          <section className="ob-card">
            <h2>Files in your storage</h2>
            {pull?.status === 'ready'
              ? <p className="ob-muted">Files are listed here with their checksums.</p>
              : <p className="ob-muted">{pull ? pullNote : 'No files in workspace storage. Requesting a pull records interest; copying weights is planned.'}</p>}
          </section>
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Enhance with</h2>
            {methods.map((m) => (
              <div key={m.id} className="mdl-method">
                <Tile icon={m.icon} tone={m.tone} size="sm" />
                <span className="cell-stack" style={{ gap: 2 }}><strong style={{ fontSize: 14 }}>{m.name}</strong><span className="ob-muted" style={{ fontSize: 12.5 }}>{m.detail}</span></span>
              </div>
            ))}
          </section>
          <section className="ob-card">
            <h2>License and source</h2>
            <dl className="ds-dl">
              <dt>License</dt><dd>{model.license}</dd>
              <dt>Commercial use</dt><dd>{model.commercial ? 'Allowed' : 'Not allowed'}</dd>
              <dt>When sharing</dt><dd>{model.licenseNote}</dd>
              <dt>Source</dt><dd className="mono" style={{ fontSize: 12.5 }}>{model.source}</dd>
            </dl>
            <p className="ob-muted" style={{ fontSize: 12 }}>Figures are approximate. Check the model card before you rely on them.</p>
          </section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}

/* ---------------- My models ---------------- */

export function MyModels() {
  const { account, entry, role, pulls, runs, catalog, methods } = useLoaderData();
  const [filter, setFilter] = useState(null);
  const byId = (id) => catalog.find((m) => m.id === id);
  const writer = WRITERS.includes(role);
  const empty = pulls.length === 0 && runs.length === 0;
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title="My models" current="models-mine">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <span className="ob-eyebrow">Models · {entry.name}</span>
          <h1 className="ob-h1">My models</h1>
          <p className="ob-lede">Every model in this workspace: the bases you requested and the enhancement plans drafted or approved on them. No weights are copied into workspace storage (that is planned), and a plan is trained only when a runner linked to the workspace takes its job.</p>
        </div>
        <div>
          <Link className="btn-ghost" to={`/w/${entry.slug}/models`}>Model catalog</Link>
          {writer && pulls.length > 0 && <Link className="btn-app" to={`/w/${entry.slug}/models/runs/new`}>Enhance a model</Link>}
        </div>
      </div>
      {empty ? (
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="layers" tone="blue" size="lg" />
          <h2>No models yet</h2>
          <p className="ob-muted">Pull an open-weight model from the catalog. Then enhance it on your approved datasets.</p>
          <Link className="btn-app" to={`/w/${entry.slug}/models`}>Browse the catalog</Link>
        </section>
      ) : (
        <>
          <div className="ob-chips">
            <button type="button" className="ob-chip ds-chip" aria-pressed={!filter} onClick={() => setFilter(null)}>All · {pulls.length + runs.length}</button>
            <button type="button" className="ob-chip ds-chip k-orange" aria-pressed={filter === 'runs'} onClick={() => setFilter(filter === 'runs' ? null : 'runs')}><span className="ds-dot" aria-hidden="true" />Plans <span className="ob-muted">{runs.length}</span></button>
            <button type="button" className="ob-chip ds-chip k-violet" aria-pressed={filter === 'base'} onClick={() => setFilter(filter === 'base' ? null : 'base')}><span className="ds-dot" aria-hidden="true" />Pull requests <span className="ob-muted">{pulls.length}</span></button>
          </div>
          <ul className="ob-list ob-card mdl-list">
            {filter !== 'base' && [...runs].reverse().map((r) => (
              <li key={r.id}>
                <Tile icon={r.status === 'requested' ? 'clock' : 'pen'} tone="orange" size="sm" />
                <div><strong>{r.name}</strong><span className="ob-muted">From {modelLabel(catalog, r.baseModelId)} · {r.steps.map((s) => methods.find((m) => m.id === s)?.name).filter(Boolean).join(', ') || 'no steps yet'}</span></div>
                <RunBadge run={r} />
                <Link className="btn-ghost" to={`/w/${entry.slug}/models/runs/${r.id}`}>Open</Link>
              </li>
            ))}
            {filter !== 'runs' && [...pulls].reverse().map((p) => {
              const m = byId(p.modelId);
              return (
                <li key={p.id}>
                  {m ? <Glyph model={m} size={28} /> : <Tile icon="layers" tone="plain" size="sm" />}
                  <div><strong>{m?.name ?? p.modelId}</strong><span className="ob-muted">Base · {m?.license ?? UNLISTED} · requested {date(p.createdAt)}</span></div>
                  <span className="ob-badge tile--teal">{p.status === 'ready' ? 'In your storage' : 'Pull requested'}</span>
                  {m ? <Link className="btn-ghost" to={`/w/${entry.slug}/models/catalog/${m.id}`}>Open</Link> : <span className="ob-muted" style={{ fontSize: 12.5 }}>No catalog page</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </WorkspaceShell>
  );
}

function RunBadge({ run }) {
  return run.status === 'requested'
    ? <span className="ob-badge tile--orange">Requested</span>
    : <span className="ob-badge">Draft</span>;
}

/* ---------------- Enhance runs ---------------- */

export function EnhanceRuns() {
  const { account, entry, role, pulls, runs, catalog } = useLoaderData();
  const writer = WRITERS.includes(role);
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title="Enhance runs" current="models-runs">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <span className="ob-eyebrow">Models · {entry.name}</span>
          <h1 className="ob-h1">Enhance runs</h1>
          <p className="ob-lede">Plan post-training of a requested model on your approved data: fine-tune, preference tuning and reinforcement learning, in order. Approving a plan records it; a runner linked to the workspace runs the fine-tuning step as a job, while the other steps and hosted GPUs are planned.</p>
        </div>
        {writer && pulls.length > 0 && <Link className="btn-app" to={`/w/${entry.slug}/models/runs/new`}>New enhance run</Link>}
      </div>
      {runs.length === 0 ? (
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="target" tone="orange" size="lg" />
          <h2>No runs yet</h2>
          <p className="ob-muted">{pulls.length ? 'Plan a run on one of your pulled models. Nothing starts until an owner or admin approves a spending cap.' : 'Pull a model from the catalog first, then plan a run on it.'}</p>
          {pulls.length
            ? writer && <Link className="btn-app" to={`/w/${entry.slug}/models/runs/new`}>Plan a run</Link>
            : <Link className="btn-app" to={`/w/${entry.slug}/models`}>Browse the catalog</Link>}
        </section>
      ) : (
        <ul className="ob-list ob-card mdl-list">
          {[...runs].reverse().map((r) => (
            <li key={r.id}>
              <Tile icon="target" tone="orange" size="sm" />
              <div><strong>{r.name}</strong><span className="ob-muted">{modelLabel(catalog, r.baseModelId)} · {plural(r.datasets.length, 'dataset')} · {plural(r.steps.length, 'step')} · updated {date(r.updatedAt)}</span></div>
              <RunBadge run={r} />
              <Link className="btn-ghost" to={`/w/${entry.slug}/models/runs/${r.id}`}>Open</Link>
            </li>
          ))}
        </ul>
      )}
    </WorkspaceShell>
  );
}

/* ---------------- One run: plan while draft, status once requested ---------------- */

export function EnhanceRun() {
  const { account, entry, options, run } = useLoaderData();
  const role = entry.role;
  if (run?.status === 'requested') return <RequestedRun key={run.id} account={account} entry={entry} role={role} options={options} run={run} />;
  return <RunPlan key={run?.id ?? 'new'} account={account} entry={entry} role={role} options={options} run={run} />;
}

function Pipeline({ model, baseModelId = '', steps, methods, name }) {
  return (
    <div className="mdl-pipe">
      <div className="mdl-pipe-row">{model ? <Glyph model={model} size={28} /> : <Tile icon="layers" tone="plain" size="sm" />}<strong>{model?.name ?? (baseModelId || 'Choose a model')}</strong><span className="ob-muted">{!model && baseModelId ? UNLISTED : 'base'}</span></div>
      {steps.map((s, i) => {
        const m = methods.find((x) => x.id === s);
        return (
          <div key={s} className="mdl-pipe-step">
            <span className="mdl-pipe-line" aria-hidden="true" />
            <div className="mdl-pipe-row"><span className={`mdl-pipe-num tile--${m.tone}`}>{i + 1}</span><span>{m.name}</span><span className="ob-muted mono" style={{ fontSize: 11.5 }}>{m.id.toUpperCase()}</span></div>
          </div>
        );
      })}
      <span className="mdl-pipe-line" aria-hidden="true" />
      <div className="mdl-pipe-row"><span className="mdl-pipe-out" aria-hidden="true"><Icon name="shield" size={15} stroke={2} /></span><strong>{name || 'Your model'}</strong><span className="ob-muted">yours</span></div>
    </div>
  );
}

function RunPlan({ account, entry, role, options, run }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { pulls, datasets: eligible, catalog, methods, compute } = options;
  const pulledModels = catalog.filter((m) => pulls.some((p) => p.modelId === m.id));
  const writer = WRITERS.includes(role);
  // In the reviewer demo the server refuses plan approval; drafts stay editable.
  const manager = MANAGERS.includes(role) && !account.demoAccess;
  const [plan, setPlan] = useState(() => ({
    name: run?.name ?? '',
    baseModelId: run?.baseModelId ?? (pulledModels.some((m) => m.id === params.get('base')) ? params.get('base') : pulledModels[0]?.id ?? ''),
    datasets: run?.datasets ?? [],
    steps: run?.steps ?? methods.map((m) => m.id),
    compute: run?.compute ?? null,
    spendCapUsd: run?.spendCapUsd ?? '',
  }));
  // A new run is saved before it is requested, so a refused request lands on the saved draft with its errors.
  const carried = useLocation().state;
  const [errors, setErrors] = useState(carried?.errors ?? {});
  const [status, setStatus] = useState({ pending: false, error: carried?.error ?? null, saved: false });
  const model = catalog.find((m) => m.id === plan.baseModelId);
  const set = (patch) => { setPlan((p) => ({ ...p, ...patch })); setStatus((s) => ({ ...s, saved: false })); };
  const hasDataset = (d) => plan.datasets.some((x) => x.projectId === d.projectId && x.version === d.version);
  const atLimit = plan.datasets.length >= MAX_RUN_DATASETS;
  const toggleDataset = (d) => set({ datasets: hasDataset(d) ? plan.datasets.filter((x) => !(x.projectId === d.projectId && x.version === d.version)) : [...plan.datasets, { projectId: d.projectId, version: d.version }] });
  const toggleStep = (id) => set({ steps: plan.steps.includes(id) ? plan.steps.filter((s) => s !== id) : methods.map((m) => m.id).filter((s) => s === id || plan.steps.includes(s)) });
  // The cap is sent as typed; the server refuses anything but whole dollars instead of rewriting it.
  const body = () => ({ ...plan, spendCapUsd: String(plan.spendCapUsd ?? '').trim() === '' ? null : String(plan.spendCapUsd).trim() });

  async function save() {
    const res = run ? await api.updateEnhanceRun(entry.id, run.id, body()).catch(() => null) : await api.createEnhanceRun(entry.id, body()).catch(() => null);
    if (!res?.ok) { setErrors(res?.data.errors ?? {}); setStatus({ pending: false, error: res?.data.error ?? 'That did not work. Check your connection and try again.', saved: false }); return null; }
    setErrors({});
    return res.data.run;
  }
  async function saveDraft() {
    setStatus({ pending: true, error: null, saved: false });
    const saved = await save();
    if (!saved) return;
    setStatus({ pending: false, error: null, saved: true });
    if (!run) navigate(`/w/${entry.slug}/models/runs/${saved.id}`, { replace: true });
  }
  async function requestRun() {
    setStatus({ pending: true, error: null, saved: false });
    const saved = await save();
    if (!saved) return;
    const res = await api.requestEnhanceRun(entry.id, saved.id, saved.updatedAt).catch(() => null);
    if (!res?.ok) {
      const failed = { errors: res?.data.errors ?? {}, error: res?.data.error ?? 'That did not work. Check your connection and try again.' };
      if (!run) return navigate(`/w/${entry.slug}/models/runs/${saved.id}`, { replace: true, state: failed });
      setErrors(failed.errors); setStatus({ pending: false, error: failed.error, saved: false });
      return;
    }
    navigate(`/w/${entry.slug}/models/runs/${saved.id}`, { replace: true });
  }

  if (!run && pulledModels.length === 0) {
    const unlisted = pulls.length > 0;
    return (
      <WorkspaceShell account={account} entry={entry} role={role} title="New enhance run" current="models-runs">
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="layers" tone="blue" size="lg" />
          <h2>{unlisted ? 'No pulled model is in the current catalog' : 'Pull a model first'}</h2>
          <p className="ob-muted">{unlisted ? 'Enhance runs start from a catalog model in your workspace. The models pulled here are not in the current catalog.' : 'Enhance runs start from an open-weight model in your workspace.'}</p>
          <Link className="btn-app" to={`/w/${entry.slug}/models`}>Browse the catalog</Link>
        </section>
      </WorkspaceShell>
    );
  }
  const readOnly = !writer || status.pending;
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={run ? run.name : 'New enhance run'} current="models-runs">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <Link className="ob-eyebrow" to={`/w/${entry.slug}/models/runs`}>Models · Enhance runs</Link>
          <h1 className="ob-h1">{run ? run.name : 'New enhance run'}</h1>
          <p className="ob-lede">Plan post-training of {model?.name ?? 'a requested model'} on your approved data, one step after another. Approval records the plan and its cap (recorded, not enforced); the fine-tuning step runs only when a runner linked to the workspace takes the job.</p>
          <div className="ob-chips" style={{ gap: 6 }}><span className="ob-badge">{run ? `Draft · saved ${date(run.updatedAt)}` : 'Not saved yet'}</span>{!writer && <span className="ob-badge">Read only</span>}</div>
        </div>
        <Link className="btn-ghost" to={`/w/${entry.slug}/models/runs`}>Back to runs</Link>
      </div>

      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <div className="mdl-step-head"><span className="ob-num ob-num--done">1</span><div className="cell-stack" style={{ gap: 2 }}><h2>Start from</h2><span className="ob-muted" style={{ fontSize: 13 }}>A model pulled into this workspace</span></div></div>
            <div className="ob-chips">
              {pulledModels.map((m) => (
                <label key={m.id} className="ob-option ob-option--row mdl-option-row">
                  <input type="radio" name="base" checked={plan.baseModelId === m.id} disabled={readOnly} onChange={() => set({ baseModelId: m.id })} />
                  <Glyph model={m} size={28} /><strong>{m.name}</strong><span>{m.params} · {m.license}</span>
                </label>
              ))}
            </div>
            {plan.baseModelId && !model && <p className="ob-muted" style={{ fontSize: 12.5 }}>This draft started from {plan.baseModelId}, which is {UNLISTED}. Choose another pulled model before you save or request it.</p>}
            <FieldError id="base-error">{errors.baseModelId}</FieldError>
          </section>

          <section className="ob-card">
            <div className="mdl-step-head"><span className="ob-num ob-num--done">2</span><div className="cell-stack" style={{ gap: 2 }}><h2>Your data</h2><span className="ob-muted" style={{ fontSize: 13 }}>Approved dataset versions whose rights allow training</span></div></div>
            {eligible.length === 0 ? (
              <p className="ob-muted">No approved dataset versions allow training yet. Approve a version in a <Link to={`/w/${entry.slug}`}>project</Link> whose rights record includes training.</p>
            ) : (
              <ul className="ob-list mdl-data">
                {eligible.map((d) => (
                  <li key={`${d.projectId}:${d.version}`}>
                    <label className="mdl-data-row">
                      <input type="checkbox" checked={hasDataset(d)} disabled={readOnly || (atLimit && !hasDataset(d))} title={atLimit && !hasDataset(d) ? `At most ${MAX_RUN_DATASETS} dataset versions per run` : undefined} onChange={() => toggleDataset(d)} />
                      <Tile icon="data" tone="teal" size="sm" />
                      <span className="cell-stack" style={{ gap: 2 }}><strong>{d.projectName} · v{d.version}</strong><span className="ob-muted">{plural(d.files, 'file')} · {plural(d.labels, 'label')} · approved {date(d.createdAt)}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <FieldError id="data-error">{errors.datasets}</FieldError>
          </section>

          <section className="ob-card">
            <div className="mdl-step-head"><span className="ob-num ob-num--now">3</span><div className="cell-stack" style={{ gap: 2 }}><h2>Steps</h2><span className="ob-muted" style={{ fontSize: 13 }}>They run in this order. Turn one off to skip it.</span></div></div>
            <div className="mdl-steps">
              {methods.map((m) => (
                <label key={m.id} className="ob-option">
                  <span className="row-between" style={{ width: '100%' }}><Tile icon={m.icon} tone={m.tone} size="sm" /><input type="checkbox" checked={plan.steps.includes(m.id)} disabled={readOnly} onChange={() => toggleStep(m.id)} aria-label={`Include ${m.name}`} /></span>
                  <strong>{m.name}</strong>
                  <span>{m.detail}</span>
                  <span className="mono" style={{ fontSize: 12 }}>{m.settings}</span>
                </label>
              ))}
            </div>
            <FieldError id="steps-error">{errors.steps}</FieldError>
          </section>

          <section className="ob-card">
            <div className="mdl-step-head"><span className="ob-num">4</span><div className="cell-stack" style={{ gap: 2 }}><h2>Compute</h2><span className="ob-muted" style={{ fontSize: 13 }}>Rented GPUs are planned. Choosing one records a preference: no quote, booking or charge happens yet.</span></div></div>
            <div className="mdl-compute">
              {compute.map((c) => (
                <label key={c.id} className="ob-option ob-option--row">
                  <input type="radio" name="compute" checked={plan.compute === c.id} disabled={readOnly} onChange={() => set({ compute: c.id })} />
                  <strong>{c.name}</strong><span>{c.gpus} · {c.region}</span>
                </label>
              ))}
              <label className="ob-option ob-option--row" aria-disabled="true" style={{ opacity: 0.6, cursor: 'not-allowed' }}>
                <input type="radio" name="compute" disabled /><strong>Your cloud account</strong><span className="ob-badge">Planned</span>
              </label>
            </div>
            <FieldError id="compute-error">{errors.compute}</FieldError>
          </section>
        </div>

        <aside className="ds-side">
          <section className="ob-card mdl-panel">
            <div className="mdl-panel-top">
              <h2>What this run makes</h2>
              <Pipeline model={model} baseModelId={plan.baseModelId} steps={plan.steps} methods={methods} name={plan.name} />
            </div>
            <div className="ob-field">
              <label htmlFor="run-name">Name</label>
              <input id="run-name" type="text" value={plan.name} placeholder={`${model?.name ?? 'Model'} enhanced`} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="ob-field">
              <label htmlFor="cap">Spending cap (US dollars)</label>
              <input id="cap" type="text" inputMode="numeric" value={plan.spendCapUsd} placeholder="For example 250" disabled={readOnly} aria-invalid={Boolean(errors.spendCapUsd)} aria-describedby="cap-error cap-help" onChange={(e) => set({ spendCapUsd: e.target.value })} />
              <FieldError id="cap-error">{errors.spendCapUsd}</FieldError>
              <span id="cap-help" className="ob-muted" style={{ fontSize: 12.5 }}>An approved planning limit. Enforcing it during a run (reservation, metering, stopping at the cap) is planned.</span>
            </div>
            <dl className="ds-dl">
              <dt>Outputs</dt><dd>A LoRA adapter on the runner that fine-tunes it, exportable to Ollama there. Copying weights into {entry.name} storage is planned.</dd>
              <dt>Planned training data</dt><dd>Only the dataset versions you choose above</dd>
            </dl>
            {status.error && <p className="ob-alert" role="alert">{status.error}</p>}
            {status.saved && <p className="ob-ok" role="status"><Icon name="check" size={14} stroke={2.5} />Draft saved</p>}
            {writer && <button type="button" className="btn-ghost" disabled={status.pending} onClick={saveDraft}>{status.pending ? 'Saving…' : 'Save draft'}</button>}
            {manager
              ? <button type="button" className="btn-app" disabled={status.pending} onClick={requestRun}>Approve cap and request run</button>
              : writer && <p className="ob-muted" style={{ fontSize: 12.5 }}>{account.demoAccess ? 'Approving the cap and requesting the run is off in the reviewer demo; the workspace operator does that separately.' : 'An owner or admin approves the spending cap and requests the run.'}</p>}
          </section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}

// The only step a runner runs today (Compute: "Fine-tuning (LoRA)"), so a plan's training jobs are its runs. The other
// steps are planned, and nothing stands in for them.
const TRAINED_STEP = 'sft';

// Reads the workspace's jobs for one plan and polls while one of its jobs can still change (plan-jobs.js). RequestedRun
// is keyed by plan, so a plan never shows another plan's rows, and a late answer is dropped with the old loader.
// `refresh` runs the same guarded load by hand: polling stops once nothing of this plan is unfinished, so a job
// queued from another tab shows up only on a refresh or a new visit.
function usePlanJobs(workspaceId, runId) {
  const [state, setState] = useState({ jobs: null, error: null, pending: false });
  const loader = useRef(null);
  useEffect(() => {
    const l = createJobsLoader({ fetchJobs: () => api.jobs(workspaceId), live: (jobs) => execution(planJobs(jobs, runId)).live, onState: setState });
    loader.current = l;
    l.load();
    return () => { l.stop(); loader.current = null; };
  }, [workspaceId, runId]);
  return { ...state, refresh: () => loader.current?.load() };
}

function Facts({ rows, label }) {
  return (
    <dl className="dev-facts" style={{ display: 'grid', gap: 8 }} aria-label={label}>
      {rows.map(([k, v]) => <div key={k} className="dev-fact"><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function RequestedRun({ account, entry, role, options, run }) {
  const { catalog, methods, compute, datasets: eligible } = options;
  const model = catalog.find((m) => m.id === run.baseModelId);
  const where = compute.find((c) => c.id === run.compute);
  const datasetName = (d) => eligible.find((e) => e.projectId === d.projectId && e.version === d.version)?.projectName ?? 'Dataset';
  // The plan is frozen; what has happened to it is read from the workspace's job records. Until a list has loaded
  // (`checked`) nothing is claimed about what has or has not run.
  const { jobs, error, pending, refresh } = usePlanJobs(entry.id, run.id);
  const checked = jobs !== null;
  const ex = execution(checked ? planJobs(jobs, run.id) : []);
  const listed = jobWindow(jobs);
  const onRunner = run.compute === 'runner';
  // Absence is claimed only as far as the listed window reaches (plan-jobs.js).
  const state = planState({ checked, error, ex, listed });
  const weights = weightsState({ checked, ex, listed });
  const stepState = (id) => (id === TRAINED_STEP ? state.training : 'Planned');
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={run.name} current="models-runs">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <Link className="ob-eyebrow" to={`/w/${entry.slug}/models/runs`}>Models · Enhance runs</Link>
          <h1 className="ob-h1">{run.name}</h1>
          <p className="ob-lede">Planned enhancement of {modelLabel(catalog, run.baseModelId)} on {plural(run.datasets.length, 'dataset version')}. Requested {date(run.requestedAt)} with a ${run.spendCapUsd.toLocaleString('en-US')} planning limit.</p>
          <div className="ob-chips" style={{ gap: 6 }}><span className={`ob-badge ${state.tone}`}>{state.badge}</span><span className="ob-badge">Plan frozen</span></div>
        </div>
      </div>
      <p className="ob-alert ob-alert--info" role="note">This is an approved plan, not a running job. What has run for it is read below from the workspace’s job records. A runner linked to the workspace can take its fine-tuning and export jobs; hosted GPU quotes, booking, metering and charges are planned, and only the fine-tuning step runs today.</p>

      <section className="ob-card mdl-progress">
        {run.steps.map((s, i) => {
          const m = methods.find((x) => x.id === s);
          return (
            <div key={s} className="cell-stack" style={{ gap: 10 }}>
              <div className="row-between" style={{ justifyContent: 'flex-start', gap: 10 }}><span className="ob-num">{i + 1}</span><strong>{m?.name ?? s}</strong><span className="ob-muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{stepState(s)}</span></div>
              <span className="ob-muted" style={{ fontSize: 12.5 }}>{m?.settings}</span>
            </div>
          );
        })}
      </section>

      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
              <h2>Jobs for this plan</h2>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="ob-muted" style={{ fontSize: 12 }}>{checked ? `${plural(ex.jobs.length, 'listed job')} among` : 'From'} the workspace’s latest {JOB_WINDOW} jobs</span>
                <button type="button" className="btn-text" onClick={refresh} disabled={pending} aria-describedby="plan-jobs-refresh-help">{pending ? 'Refreshing…' : 'Refresh jobs'}</button>
              </span>
            </div>
            {error && <p className="ob-alert" role="alert">{checked ? 'The job list could not be refreshed' : 'The job list could not be loaded'}: {error} <button type="button" className="btn-text" onClick={refresh} disabled={pending}>Retry</button></p>}
            {!checked && !error && <p className="ob-muted" role="status">Checking the workspace’s jobs…</p>}
            {checked && ex.jobs.length === 0 && (
              <p className="ob-muted">
                {listed.complete ? `No job has been queued for this plan; all ${plural(listed.listed, 'job')} of this workspace were checked.` : `No job for this plan among the workspace’s latest ${JOB_WINDOW} jobs; older jobs are not listed here.`}{' '}
                {onRunner ? <>An owner or admin starts its fine-tuning from <Link to={`/w/${entry.slug}/compute`}>Compute</Link>.</> : 'This plan is set to a GPU provider, which is planned; only a plan set to a linked runner can be started today.'}
              </p>
            )}
            {checked && ex.jobs.length > 0 && (
              <>
                <ul className="ob-list mdl-list">
                  {ex.jobs.map(jobRow).map((j, i) => (
                    <li key={j.id ?? i}>
                      <Tile icon="panel" tone="teal" size="sm" />
                      <div><strong>{j.kind}</strong><span className="ob-muted">queued {j.queued}{j.attempt ? ` · ${j.attempt}` : ''}</span></div>
                      <span className={`ob-badge ${j.tone}`}>{j.status}</span>
                      {j.id ? <Link className="btn-ghost" to={computeJobPath(entry.slug, j.id)}>Details</Link> : <span className="ob-muted" style={{ fontSize: 12.5 }}>No record id</span>}
                    </li>
                  ))}
                </ul>
                {!listed.complete && <p className="ob-muted" style={{ fontSize: 12.5 }}>Only jobs among the workspace’s latest {JOB_WINDOW} are listed; older jobs of this plan are not shown here.</p>}
                {ex.trained && (
                  <>
                    <h3 style={{ fontSize: 14 }}>Latest successful training</h3>
                    <Facts rows={trainingSummary(ex.trained.result)} label="Training result, reported by the runner" />
                    <p className="ob-muted" style={{ fontSize: 12 }}>Measured and reported by the runner on held-out examples from this dataset; it does not show general model quality. <Link to={computeJobPath(entry.slug, ex.trained.id)}>Open the job</Link> for its loss curve and events.</p>
                  </>
                )}
              </>
            )}
            <p id="plan-jobs-refresh-help" className="ob-muted" style={{ fontSize: 12 }}>The list refreshes on its own only while a job of this plan is unfinished. After starting one from Compute, or from another tab, use Refresh jobs.</p>
          </section>
          <section className="ob-card">
            <h2>Weights and exports</h2>
            <p className="ob-muted">Nothing is copied into workspace storage: that, and downloading weights from here, is planned. A successful fine-tuning job leaves its LoRA adapter on the runner that trained it, and an export job writes a GGUF into Ollama on that same runner.</p>
            {ex.exported && (
              <>
                <Facts rows={exportSummary(ex.exported.result)} label="Export, as the runner reported it" />
                <p className="ob-muted" style={{ fontSize: 12 }}>Latest successful export, as the runner reported it at the time: the model was exported to Ollama on that runner. Whether it is still there, or loaded, is not checked by Valcairn. <Link to={computeJobPath(entry.slug, ex.exported.id)}>Open the export job</Link>.</p>
              </>
            )}
            {weights && <p className="ob-muted">{weights}</p>}
          </section>
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Plan</h2>
            <dl className="ds-dl">
              <dt>Base</dt><dd>{modelLabel(catalog, run.baseModelId)}</dd>
              <dt>Data</dt><dd>{run.datasets.map((d) => `${datasetName(d)} v${d.version}`).join(' · ')}</dd>
              <dt>Steps</dt><dd>{run.steps.map((s) => methods.find((m) => m.id === s)?.name).join(' → ')}</dd>
              <dt>Compute</dt><dd>{where ? `${where.name} · ${where.gpus} · ${where.region}` : run.compute}</dd>
              <dt>Cap</dt><dd>${run.spendCapUsd.toLocaleString('en-US')}</dd>
            </dl>
          </section>
          <section className="ob-card mdl-panel"><div className="mdl-panel-top"><h2>What this run makes</h2><Pipeline model={model} baseModelId={run.baseModelId} steps={run.steps} methods={methods} name={run.name} /></div></section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}
