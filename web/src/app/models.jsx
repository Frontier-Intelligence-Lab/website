import { useState } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useParams, useRevalidator, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';

// Memory bars are drawn against one 80 GB H100, the GPU most fine-tunes here run on.
const GPU_GB = 80;
const GPU_TONE = { 1: 'blue', 2: 'violet', 4: 'teal' };
const WRITERS = ['owner', 'admin', 'member'];
const MANAGERS = ['owner', 'admin'];
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const archLabel = (m) => (m.architecture === 'moe' ? `MoE · ${m.active} active` : 'dense');
const pct = (gb) => `${Math.min(100, (gb / GPU_GB) * 100).toFixed(1)}%`;
const gpuLabel = (n) => `${n} GPU${n === 1 ? '' : 's'}`;

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

const pullNote = 'Requested. Valcairn copies the weights into your workspace storage and checks them; automatic copying is planned.';

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
  const selected = catalog.find((m) => m.id === selectedId) ?? shown[0];
  const counts = [1, 2, 4].map((n) => ({ n, count: catalog.filter((m) => m.loraGpus === n).length }));
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title="Model catalog" current="models-catalog">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <span className="ob-eyebrow">Models · {entry.name}</span>
          <h1 className="ob-h1">Model catalog</h1>
          <p className="ob-lede">Open-weight models you can pull into this workspace and enhance on your approved datasets. The weights stay yours.</p>
          <div className="ob-chips" style={{ gap: 6 }}>
            <span className="ob-badge">{plural(catalog.length, 'model')}</span>
            {pulls.length > 0 && <span className="ob-badge tile--blue">{pulls.length} pulled</span>}
          </div>
        </div>
        <Link className="btn-ghost" to={`/w/${entry.slug}/models/mine`}>My models</Link>
      </div>

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
        <div className="cell-stack" style={{ gap: 6 }}><strong style={{ fontSize: 12.5 }}>Memory by format</strong><MemoryBars model={model} /><span className="ob-muted" style={{ fontSize: 11.5 }}>Full bar is one {GPU_GB} GB H100.</span></div>
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
        <dt>Context</dt><dd>{model.contextK}K tokens</dd>
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
            <div className="row-between"><h2>Memory by format</h2><span className="ob-muted" style={{ fontSize: 12 }}>Full bar is one {GPU_GB} GB H100</span></div>
            <MemoryBars model={model} />
          </section>
          <section className="ob-card">
            <h2>Files in your storage</h2>
            {pull?.status === 'ready'
              ? <p className="ob-muted">Files are listed here with their checksums.</p>
              : <p className="ob-muted">{pull ? pullNote : 'No files yet. Pull the model to copy its weights, tokenizer and license files into your workspace storage.'}</p>}
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
          <p className="ob-lede">Every model in this workspace: bases you pulled and the versions you are making from them.</p>
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
            <button type="button" className="ob-chip ds-chip k-orange" aria-pressed={filter === 'runs'} onClick={() => setFilter(filter === 'runs' ? null : 'runs')}><span className="ds-dot" aria-hidden="true" />Enhanced <span className="ob-muted">{runs.length}</span></button>
            <button type="button" className="ob-chip ds-chip k-violet" aria-pressed={filter === 'base'} onClick={() => setFilter(filter === 'base' ? null : 'base')}><span className="ds-dot" aria-hidden="true" />Base <span className="ob-muted">{pulls.length}</span></button>
          </div>
          <ul className="ob-list ob-card mdl-list">
            {filter !== 'base' && [...runs].reverse().map((r) => (
              <li key={r.id}>
                <Tile icon={r.status === 'requested' ? 'clock' : 'pen'} tone="orange" size="sm" />
                <div><strong>{r.name}</strong><span className="ob-muted">From {byId(r.baseModelId)?.name ?? r.baseModelId} · {r.steps.map((s) => methods.find((m) => m.id === s)?.name).filter(Boolean).join(', ') || 'no steps yet'}</span></div>
                <RunBadge run={r} />
                <Link className="btn-ghost" to={`/w/${entry.slug}/models/runs/${r.id}`}>Open</Link>
              </li>
            ))}
            {filter !== 'runs' && [...pulls].reverse().map((p) => {
              const m = byId(p.modelId);
              if (!m) return null;
              return (
                <li key={p.id}>
                  <Glyph model={m} size={28} />
                  <div><strong>{m.name}</strong><span className="ob-muted">Base · {m.license} · requested {date(p.createdAt)}</span></div>
                  <span className="ob-badge tile--teal">{p.status === 'ready' ? 'In your storage' : 'Pull requested'}</span>
                  <Link className="btn-ghost" to={`/w/${entry.slug}/models/catalog/${m.id}`}>Open</Link>
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
          <p className="ob-lede">Post-train a pulled model on your approved data: fine-tune, preference tuning and reinforcement learning, in order.</p>
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
              <div><strong>{r.name}</strong><span className="ob-muted">{catalog.find((m) => m.id === r.baseModelId)?.name ?? r.baseModelId} · {plural(r.datasets.length, 'dataset')} · {plural(r.steps.length, 'step')} · updated {date(r.updatedAt)}</span></div>
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
  if (run?.status === 'requested') return <RequestedRun account={account} entry={entry} role={role} options={options} run={run} />;
  return <RunPlan key={run?.id ?? 'new'} account={account} entry={entry} role={role} options={options} run={run} />;
}

function Pipeline({ model, steps, methods, name }) {
  return (
    <div className="mdl-pipe">
      <div className="mdl-pipe-row">{model ? <Glyph model={model} size={28} /> : <Tile icon="layers" tone="plain" size="sm" />}<strong>{model?.name ?? 'Choose a model'}</strong><span className="ob-muted">base</span></div>
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
  const manager = MANAGERS.includes(role);
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
  const toggleDataset = (d) => set({ datasets: hasDataset(d) ? plan.datasets.filter((x) => !(x.projectId === d.projectId && x.version === d.version)) : [...plan.datasets, { projectId: d.projectId, version: d.version }] });
  const toggleStep = (id) => set({ steps: plan.steps.includes(id) ? plan.steps.filter((s) => s !== id) : methods.map((m) => m.id).filter((s) => s === id || plan.steps.includes(s)) });
  const body = () => ({ ...plan, spendCapUsd: plan.spendCapUsd === '' ? null : Number(plan.spendCapUsd) });

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
    const res = await api.requestEnhanceRun(entry.id, saved.id).catch(() => null);
    if (!res?.ok) {
      const failed = { errors: res?.data.errors ?? {}, error: res?.data.error ?? 'That did not work. Check your connection and try again.' };
      if (!run) return navigate(`/w/${entry.slug}/models/runs/${saved.id}`, { replace: true, state: failed });
      setErrors(failed.errors); setStatus({ pending: false, error: failed.error, saved: false });
      return;
    }
    navigate(`/w/${entry.slug}/models/runs/${saved.id}`, { replace: true });
  }

  if (!run && pulledModels.length === 0) {
    return (
      <WorkspaceShell account={account} entry={entry} role={role} title="New enhance run" current="models-runs">
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="layers" tone="blue" size="lg" />
          <h2>Pull a model first</h2>
          <p className="ob-muted">Enhance runs start from an open-weight model in your workspace.</p>
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
          <p className="ob-lede">Post-train {model?.name ?? 'a pulled model'} on your approved data, one step after another.</p>
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
                      <input type="checkbox" checked={hasDataset(d)} disabled={readOnly} onChange={() => toggleDataset(d)} />
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
            <div className="mdl-step-head"><span className="ob-num">4</span><div className="cell-stack" style={{ gap: 2 }}><h2>Compute</h2><span className="ob-muted" style={{ fontSize: 13 }}>Rented GPUs, billed through Valcairn. Valcairn confirms availability and a quote before anything runs.</span></div></div>
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
              <Pipeline model={model} steps={plan.steps} methods={methods} name={plan.name} />
            </div>
            <div className="ob-field">
              <label htmlFor="run-name">Name</label>
              <input id="run-name" type="text" value={plan.name} placeholder={`${model?.name ?? 'Model'} enhanced`} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="ob-field">
              <label htmlFor="cap">Spending cap (US dollars)</label>
              <input id="cap" type="text" inputMode="numeric" value={plan.spendCapUsd} placeholder="For example 250" disabled={readOnly} aria-invalid={Boolean(errors.spendCapUsd)} aria-describedby="cap-error cap-help" onChange={(e) => set({ spendCapUsd: e.target.value.replace(/[^0-9]/g, '') })} />
              <FieldError id="cap-error">{errors.spendCapUsd}</FieldError>
              <span id="cap-help" className="ob-muted" style={{ fontSize: 12.5 }}>The run stops at the cap and keeps the last finished step.</span>
            </div>
            <dl className="ds-dl">
              <dt>Saved to</dt><dd>{entry.name} storage, after every step</dd>
              <dt>Trains on</dt><dd>Only the dataset versions you choose above</dd>
            </dl>
            {status.error && <p className="ob-alert" role="alert">{status.error}</p>}
            {status.saved && <p className="ob-ok" role="status"><Icon name="check" size={14} stroke={2.5} />Draft saved</p>}
            {writer && <button type="button" className="btn-ghost" disabled={status.pending} onClick={saveDraft}>{status.pending ? 'Saving…' : 'Save draft'}</button>}
            {manager
              ? <button type="button" className="btn-app" disabled={status.pending} onClick={requestRun}>Approve cap and request run</button>
              : writer && <p className="ob-muted" style={{ fontSize: 12.5 }}>An owner or admin approves the spending cap and requests the run.</p>}
          </section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}

function RequestedRun({ account, entry, role, options, run }) {
  const { catalog, methods, compute, datasets: eligible } = options;
  const model = catalog.find((m) => m.id === run.baseModelId);
  const where = compute.find((c) => c.id === run.compute);
  const datasetName = (d) => eligible.find((e) => e.projectId === d.projectId && e.version === d.version)?.projectName ?? 'Dataset';
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={run.name} current="models-runs">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <Link className="ob-eyebrow" to={`/w/${entry.slug}/models/runs`}>Models · Enhance runs</Link>
          <h1 className="ob-h1">{run.name}</h1>
          <p className="ob-lede">{model?.name ?? run.baseModelId}, enhanced on {plural(run.datasets.length, 'dataset version')}. Requested {date(run.requestedAt)} with a ${run.spendCapUsd.toLocaleString('en-US')} cap.</p>
          <div className="ob-chips" style={{ gap: 6 }}><span className="ob-badge tile--orange">Requested · waiting for Valcairn</span><span className="ob-badge">Plan frozen</span></div>
        </div>
      </div>
      <p className="ob-alert ob-alert--info" role="note">Valcairn confirms GPU availability and a quote within your cap, then starts the run. Live training curves, checkpoints and automatic runs are planned; nothing has been trained yet.</p>

      <section className="ob-card mdl-progress">
        {run.steps.map((s, i) => {
          const m = methods.find((x) => x.id === s);
          return (
            <div key={s} className="cell-stack" style={{ gap: 10 }}>
              <div className="row-between" style={{ justifyContent: 'flex-start', gap: 10 }}><span className="ob-num">{i + 1}</span><strong>{m.name}</strong><span className="ob-muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>Waiting</span></div>
              <span className="mdl-meter" aria-hidden="true"><span style={{ width: 0 }} /></span>
              <span className="ob-muted" style={{ fontSize: 12.5 }}>{m.settings}</span>
            </div>
          );
        })}
      </section>

      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <h2>Training progress</h2>
            <p className="ob-muted">Loss and reward curves appear here once the run starts.</p>
          </section>
          <section className="ob-card">
            <h2>Saved weights</h2>
            <p className="ob-muted">Each step saves its weights to your storage as it finishes. Nothing has been saved yet.</p>
          </section>
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Plan</h2>
            <dl className="ds-dl">
              <dt>Base</dt><dd>{model?.name ?? run.baseModelId}</dd>
              <dt>Data</dt><dd>{run.datasets.map((d) => `${datasetName(d)} v${d.version}`).join(' · ')}</dd>
              <dt>Steps</dt><dd>{run.steps.map((s) => methods.find((m) => m.id === s)?.name).join(' → ')}</dd>
              <dt>Compute</dt><dd>{where ? `${where.name} · ${where.gpus} · ${where.region}` : run.compute}</dd>
              <dt>Cap</dt><dd>${run.spendCapUsd.toLocaleString('en-US')}</dd>
            </dl>
          </section>
          <section className="ob-card mdl-panel"><div className="mdl-panel-top"><h2>What this run makes</h2><Pipeline model={model} steps={run.steps} methods={methods} name={run.name} /></div></section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}
