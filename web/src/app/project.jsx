import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, SetupShell, Tile, initials, requireWorkspace } from './ui.jsx';

const STEPS = ['Goal', "How you'll judge it", 'Data'];
const MODALITIES = ['Text', 'Documents', 'Images', 'Video', 'Audio', 'Sensor or time series', 'Robot trajectories'];
const STARTS = [
  { id: 'own', icon: 'data', tone: 'teal', title: 'We have our own data', body: 'Describe it and record its rights. It stays private to your workspace.' },
  { id: 'need', icon: 'store', tone: 'green', title: 'We need data', body: 'License an existing dataset, or have one collected and labeled.' },
  { id: 'model', icon: 'layers', tone: 'blue', title: 'We already have a model', body: 'Test it on your task and deploy it. No training required.' },
  { id: 'unsure', icon: 'question', tone: 'violet', title: 'Not sure yet', body: 'Book a short call and we will scope it with you.' },
];
const PLANS = {
  own: [['Describe the task', 'You are here'], ['Record your data and its rights', 'Where it came from and how it may be used'], ['Rights and quality review', 'We check permissions, labels and duplicates'], ['Approve dataset version 1', 'Locked, versioned, private to you'], ['Train and evaluate', 'Starts only after you approve a cost estimate'], ['Accept the model and deploy', 'Your cloud, your servers or a supported device']],
  need: [['Describe the task', 'You are here'], ['Shortlist or commission data', 'Compare samples, coverage and allowed uses'], ['Agree license terms', 'Nothing is bought until you approve'], ['Rights and quality review', 'We check permissions, labels and duplicates'], ['Train and evaluate', 'Starts only after you approve a cost estimate'], ['Accept the model and deploy', 'Your cloud, your servers or a supported device']],
  model: [['Describe the task', 'You are here'], ['Connect your model', 'An endpoint or a model file you are allowed to use'], ['Add a test set', 'Examples with the answers you expect'], ['Compare against a baseline', 'See where it passes and fails'], ['Deploy', 'Readiness checks before anything goes live']],
  unsure: [['Describe the task', 'You are here'], ['Scoping call', '30 minutes with our team'], ['Get a written plan', 'Data, approach, test method and a cost range']],
};

function Shell({ entry, current, children, title }) {
  return (
    <SetupShell context={`New project · ${entry.name}`} exit={{ to: `/w/${entry.slug}`, label: 'Exit setup' }} steps={STEPS} current={current}>
      <title>{`${title} — Valcairn`}</title>
      {children}
    </SetupShell>
  );
}

export async function workspaceHomeLoader({ params }) {
  const { entry } = await requireWorkspace(params.slug);
  const { projects } = await api.projects(entry.id);
  const latest = projects.at(-1);
  throw redirect(latest ? `/w/${entry.slug}/projects/${latest.id}` : `/w/${entry.slug}/projects/new`);
}

export async function goalLoader({ params }) {
  const { entry } = await requireWorkspace(params.slug);
  if (!['owner', 'admin', 'member'].includes(entry.role)) throw redirect(`/w/${entry.slug}`);
  return { entry };
}

export function ProjectGoal() {
  const { entry } = useLoaderData();
  const navigate = useNavigate();
  const [start, setStart] = useState('own');
  const [modalities, setModalities] = useState([]);
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState(false);
  const toggle = (m) => setModalities(modalities.includes(m) ? modalities.filter((x) => x !== m) : [...modalities, m]);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const task = new FormData(event.currentTarget).get('task');
    const res = await api.createProject(entry.id, { task, modalities, startingPoint: start }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate(`/w/${entry.slug}/projects/${res.data.project.id}/success`);
    setErrors(res?.data.errors ?? { form: res?.data.error ?? 'Could not save. Please try again.' });
  }

  return (
    <Shell entry={entry} current={0} title="Project goal">
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">What should your model do?</h1>
            <p className="ob-lede">Describe the job in your own words. We use it to suggest data, a starting model and a way to test it.</p>
          </div>
          {errors.form && <p className="ob-alert" role="alert">{errors.form}</p>}
          <div className="ob-field">
            <label htmlFor="task">The task</label>
            <textarea id="task" name="task" rows={3} maxLength={2000} placeholder="e.g. Flag damaged or mislabeled boxes from the overhead camera on packing line 2, before they ship." aria-invalid={errors.task ? true : undefined} aria-describedby="task-help" />
            <FieldError id="task-help">{errors.task ?? <span className="ob-muted">Mention who uses it and what a wrong answer costs, if you know.</span>}</FieldError>
          </div>
          <fieldset aria-describedby="modalities-error">
            <legend className="ob-legend">What goes into the model?</legend>
            <div className="ob-chips">
              {MODALITIES.map((m) => <button key={m} type="button" className="ob-chip" aria-pressed={modalities.includes(m)} onClick={() => toggle(m)}>{m}</button>)}
            </div>
            <FieldError id="modalities-error">{errors.modalities}</FieldError>
          </fieldset>
          <fieldset>
            <legend className="ob-legend">Where are you starting from?</legend>
            <div className="ob-grid">
              {STARTS.map((s) => (
                <button key={s.id} type="button" className="ob-option" aria-pressed={start === s.id} onClick={() => setStart(s.id)}>
                  <Tile icon={s.icon} tone={s.tone} /><strong>{s.title}</strong><span>{s.body}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="ob-actions">
            <Link className="btn-ghost" to={entry.kind === 'organization' ? `/w/${entry.slug}/setup/team` : '/start'}>Back</Link>
            <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Continue'} <Icon name="arrow" size={16} /></button>
          </div>
        </section>
        <aside className="ob-aside" aria-label="Your project plan">
          <div className="ob-card">
            <div className="ob-intro" style={{ gap: 4 }}><h2>Your project plan</h2><span className="ob-muted">Updates as you answer. Only the steps your path needs.</span></div>
            <ol className="ob-list">
              {PLANS[start].map(([label, note], i) => (
                <li key={label}><span className={`ob-num${i === 0 ? ' ob-num--now' : ''}`}>{i + 1}</span><div><strong>{label}</strong><span className="ob-muted">{note}</span></div></li>
              ))}
            </ol>
          </div>
          {entry.kind === 'organization' && <div className="ob-note tile--amber"><Tile icon="bank" tone="amber" size="sm" /><span><strong>Financing, if you need it.</strong> Start a private application for compute or equipment once the project exists.</span></div>}
        </aside>
      </form>
    </Shell>
  );
}

async function projectLoader({ params }) {
  const { entry } = await requireWorkspace(params.slug);
  const { project, role } = await api.project(entry.id, params.projectId);
  return { entry, project, role };
}
export const successLoader = projectLoader;
export const dataLoader = projectLoader;
export const projectHomeLoader = projectLoader;

const MEASURES = [['recall', 'Catches real problems (recall)'], ['precision', 'Few false alarms (precision)'], ['accuracy', 'Overall accuracy'], ['success_rate', 'Task success rate'], ['rubric', 'Scored by reviewers against a rubric']];
const BASELINES = [['current', 'How you do it today', 'people checking, rules, an older system'], ['off_the_shelf', 'An off-the-shelf model, unchanged', ''], ['none', 'No baseline yet', "we'll help you set one"]];
const WHERE = [['cloud', 'Our cloud account'], ['servers', 'Our own servers'], ['device', 'On a device'], ['later', 'Decide later']];

export function ProjectSuccess() {
  const { entry, project } = useLoaderData();
  const navigate = useNavigate();
  const s = project.success ?? {};
  const [measure, setMeasure] = useState(s.measure ?? 'recall');
  const [target, setTarget] = useState(s.target ?? '');
  const [baseline, setBaseline] = useState(s.baseline ?? 'current');
  const [runsOn, setRunsOn] = useState(s.runsOn ?? 'later');
  const [device, setDevice] = useState(s.device ?? '');
  const [message, setMessage] = useState(null);
  const measureLabel = MEASURES.find(([id]) => id === measure)[1].toLowerCase();
  const baselineLabel = BASELINES.find(([id]) => id === baseline)[1].toLowerCase();
  const next = `/w/${entry.slug}/projects/${project.id}/data`;

  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const res = await api.updateProject(entry.id, project.id, { success: { ...form, measure, target, baseline, runsOn, device } }).catch(() => null);
    if (res?.ok) return navigate(next);
    setMessage(res?.data.error ?? 'Could not save. Please try again.');
  }

  return (
    <Shell entry={entry} current={1} title="How you'll judge it">
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">How will you know it works?</h1>
            <p className="ob-lede">Set the bar before any training. Every model version is tested against it, and you decide whether to accept it.</p>
          </div>
          {message && <p className="ob-alert" role="alert">{message}</p>}
          <div className="ob-grid">
            <div className="ob-field"><label htmlFor="measure">What to measure</label>
              <select id="measure" value={measure} onChange={(e) => setMeasure(e.target.value)}>{MEASURES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
            </div>
            <div className="ob-field"><label htmlFor="target">Good enough means at least</label><input id="target" type="text" maxLength={40} placeholder="e.g. 95%" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          </div>
          <fieldset>
            <legend className="ob-legend">Compared with</legend>
            <div className="ob-intro" style={{ gap: 10 }}>
              {BASELINES.map(([id, label, hint]) => (
                <label key={id} className="ob-option ob-option--row"><input type="radio" name="baseline" checked={baseline === id} onChange={() => setBaseline(id)} />{label}{hint && <span>· {hint}</span>}</label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="ob-legend">Where it needs to run</legend>
            <div className="ob-grid ob-grid--tight">
              {WHERE.map(([id, label]) => <label key={id} className="ob-option ob-option--row"><input type="radio" name="runsOn" checked={runsOn === id} onChange={() => setRunsOn(id)} />{label}</label>)}
            </div>
            {runsOn === 'device' && (
              <div className="ob-field ob-card" style={{ marginTop: 10 }}>
                <label htmlFor="device">Which device?</label>
                <input id="device" type="text" maxLength={120} placeholder="Model of camera, gateway or edge computer" value={device} onChange={(e) => setDevice(e.target.value)} />
                <span className="ob-muted">We'll confirm the device is supported before you commit. Not every device is.</span>
              </div>
            )}
          </fieldset>
          <details>
            <summary>More limits (optional): speed, cost, approval</summary>
            <div className="ob-grid ob-grid--tight" style={{ paddingBottom: 16 }}>
              <div className="ob-field"><label htmlFor="latency">Slowest acceptable answer</label><input id="latency" name="latency" type="text" maxLength={40} placeholder="e.g. 200 ms" defaultValue={s.latency ?? ''} /></div>
              <div className="ob-field"><label htmlFor="spendLimit">Spend limit before approval</label><input id="spendLimit" name="spendLimit" type="text" maxLength={40} defaultValue={s.spendLimit ?? ''} /></div>
              <div className="ob-field"><label htmlFor="approver">Who approves spend</label><input id="approver" name="approver" type="text" maxLength={120} placeholder="Name or role" defaultValue={s.approver ?? ''} /></div>
            </div>
          </details>
          <div className="ob-actions">
            <Link className="btn-ghost" to={`/w/${entry.slug}/projects/${project.id}`}>Back</Link>
            <div>
              <Link className="btn-text" to={next}>Skip for now</Link>
              <button className="btn-app" type="submit">Continue <Icon name="arrow" size={16} /></button>
            </div>
          </div>
        </section>
        <aside className="ob-aside">
          <div className="ob-card">
            <h2>Your acceptance rule</h2>
            <p style={{ lineHeight: 1.6 }}>Accept a model when it scores <strong>{target || '[target]'}</strong> on <strong>{measureLabel}</strong> against held-out examples, does better than <strong>{baselineLabel}</strong>{runsOn === 'device' ? <>, and runs on <strong>{device || '[your device]'}</strong></> : ''}.</p>
            <span className="ob-muted">You can change this until the first training run is approved. After that, changes start a new version.</span>
          </div>
          <div className="ob-card">
            <h2>Nothing runs on its own</h2>
            <ul className="ob-list">
              <li><Tile icon="shield" tone="blue" size="sm" /><div><span className="ob-muted">We check your data, model and device fit together first.</span></div></li>
              <li><Tile icon="check" tone="green" size="sm" /><div><span className="ob-muted">You see a cost estimate and approve it before any training.</span></div></li>
              <li><Tile icon="layers" tone="violet" size="sm" /><div><span className="ob-muted">Results come from real tests on your held-out data.</span></div></li>
            </ul>
          </div>
        </aside>
      </form>
    </Shell>
  );
}

export function ProjectData() {
  const { entry, project } = useLoaderData();
  const navigate = useNavigate();
  const d = project.dataSource ?? {};
  const [mode, setMode] = useState(d.mode ?? (project.startingPoint === 'need' ? 'license' : 'upload'));
  const [errors, setErrors] = useState({});

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dataSource = { ...Object.fromEntries(form), mode, allowedUses: form.getAll('allowedUses') };
    const res = await api.updateProject(entry.id, project.id, { dataSource }).catch(() => null);
    if (res?.ok) return navigate(`/w/${entry.slug}/projects/${project.id}`);
    setErrors(res?.data.errors ?? { form: res?.data.error ?? 'Could not save. Please try again.' });
  }

  return (
    <Shell entry={entry} current={2} title="Data">
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">Where will the data come from?</h1>
            <p className="ob-lede">Start with what you know. We check the data fits the task before anything large moves.</p>
          </div>
          {errors.form && <p className="ob-alert" role="alert">{errors.form}</p>}
          <div className="ob-segment" role="group" aria-label="Data source">
            {[['upload', 'Our own data'], ['license', 'License existing data'], ['commission', 'Have it collected']].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={mode === id} onClick={() => { setMode(id); setErrors({}); }}>{label}</button>
            ))}
          </div>

          {mode === 'upload' && <>
            <div className="ob-drop">
              <Tile icon="upload" tone="teal" />
              <strong>Sample upload is coming next</strong>
              <span>For now, record where the data came from and how it may be used. You'll add a sample when uploads open.</span>
            </div>
            <fieldset aria-describedby="provenance-error">
              <legend className="ob-legend">Where did this data come from?</legend>
              <div className="ob-intro" style={{ gap: 10 }}>
                {[['ours', 'We collected it ourselves'], ['licensed', 'We licensed it from someone else'], ['users', 'Our customers or users provided it']].map(([id, label]) => (
                  <label key={id} className="ob-option ob-option--row"><input type="radio" name="provenance" value={id} defaultChecked={d.provenance === id} />{label}</label>
                ))}
              </div>
              <FieldError id="provenance-error">{errors.provenance}</FieldError>
            </fieldset>
            <div className="ob-grid">
              <fieldset aria-describedby="uses-error">
                <legend className="ob-legend">We may use it for</legend>
                <label className="ob-check"><input type="checkbox" name="allowedUses" value="training" defaultChecked={d.allowedUses?.includes('training') ?? true} />Training a model</label>
                <label className="ob-check" style={{ marginTop: 10 }}><input type="checkbox" name="allowedUses" value="testing" defaultChecked={d.allowedUses?.includes('testing') ?? true} />Testing a model</label>
                <FieldError id="uses-error">{errors.allowedUses}</FieldError>
              </fieldset>
              <fieldset>
                <legend className="ob-legend">Does it show people or personal details?</legend>
                <div className="ob-chips">
                  {[['no', 'No'], ['yes', 'Yes'], ['unsure', 'Not sure']].map(([id, label]) => (
                    <label key={id} className="ob-check"><input type="radio" name="personalData" value={id} defaultChecked={(d.personalData ?? 'unsure') === id} />{label}</label>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="ob-muted">These answers go into the project's rights record. A reviewer may ask for evidence before the dataset is approved.</p>
          </>}

          {mode === 'license' && <>
            <div className="ob-field">
              <label htmlFor="query">What are you looking for?</label>
              <input id="query" name="query" type="search" maxLength={200} placeholder="e.g. packaging damage, overhead camera" defaultValue={d.query ?? ''} />
            </div>
            <div className="ob-note tile--green"><Tile icon="store" tone="green" size="sm" /><span>The dataset catalog isn't open yet. We'll save what you're looking for and come back with options whose license allows your use. Nothing is bought until you approve terms.</span></div>
          </>}

          {mode === 'commission' && <>
            <div className="ob-field">
              <label htmlFor="brief">What should be collected or labeled?</label>
              <textarea id="brief" name="brief" rows={3} maxLength={2000} defaultValue={d.brief ?? ''} aria-invalid={errors.brief ? true : undefined} aria-describedby="brief-error" />
              <FieldError id="brief-error">{errors.brief}</FieldError>
            </div>
            <div className="ob-grid ob-grid--tight">
              <div className="ob-field"><label htmlFor="quantity">How many</label><input id="quantity" name="quantity" type="text" maxLength={80} placeholder="e.g. 5,000 images" defaultValue={d.quantity ?? ''} /></div>
              <div className="ob-field"><label htmlFor="budget">Budget</label><input id="budget" name="budget" type="text" maxLength={80} defaultValue={d.budget ?? ''} /></div>
              <div className="ob-field"><label htmlFor="neededBy">Needed by</label><input id="neededBy" name="neededBy" type="text" maxLength={80} placeholder="Month or date" defaultValue={d.neededBy ?? ''} /></div>
            </div>
            <p className="ob-muted">This saves a brief. We come back with a quote and acceptance criteria before any work starts.</p>
          </>}

          <div className="ob-actions">
            <Link className="btn-ghost" to={`/w/${entry.slug}/projects/${project.id}/success`}>Back</Link>
            <button className="btn-app" type="submit">Save and finish <Icon name="arrow" size={16} /></button>
          </div>
        </section>
        <aside className="ob-aside">
          <div className="ob-card">
            <h2>Who can see this data</h2>
            <ul className="ob-list">
              <li><Tile icon="people" tone="green" size="sm" /><div><strong>Your team</strong><span className="ob-muted">People in {entry.name} with access to this project</span></div></li>
              <li><Tile icon="shield" tone="amber" size="sm" /><div><strong>Valcairn reviewers</strong><span className="ob-muted">Only to check rights and quality</span></div></li>
              <li><Tile icon="minus" tone="plain" size="sm" /><div><strong>Nobody else</strong><span className="ob-muted">Never listed, sold or shown to other companies</span></div></li>
            </ul>
          </div>
        </aside>
      </form>
    </Shell>
  );
}

const STATUS = [
  { key: 'task', label: 'Task and acceptance rule' },
  { key: 'data', label: 'Data and rights record' },
  { key: 'review', label: 'Rights and quality review', note: 'Opens when sample upload is available.' },
  { key: 'version', label: 'Approve dataset version 1', note: 'You lock the exact files and rights record training will use.' },
  { key: 'train', label: 'Train and test', note: 'You approve a cost estimate first.' },
  { key: 'deploy', label: 'Accept and deploy', note: 'Only a model that meets your rule can be accepted.' },
];

export function ProjectHome() {
  const { entry, project, role } = useLoaderData();
  const navigate = useNavigate();
  const base = `/w/${entry.slug}/projects/${project.id}`;
  const taskDone = Boolean(project.success);
  const dataDone = Boolean(project.dataSource);
  const state = { task: taskDone ? 'done' : 'now', data: dataDone ? 'done' : taskDone ? 'now' : 'todo' };
  const nextStep = !taskDone ? { to: `${base}/success`, title: 'Set your acceptance rule', body: 'Decide what good enough means before any training.' }
    : !dataDone ? { to: `${base}/data`, title: 'Record your data and its rights', body: 'Where it came from and how it may be used.' }
    : entry.kind === 'organization' && ['owner', 'admin'].includes(role) ? { to: `/w/${entry.slug}/setup/team`, title: 'Invite whoever approves spend', body: 'Training needs their sign-off. Inviting them now avoids a wait later.' }
    : null;

  async function signOut() {
    await api.signout().catch(() => null);
    navigate('/signin');
  }

  return (
    <div className="ob ob-shell">
      <title>{`${project.name} — Valcairn`}</title>
      <aside className="ob-side">
        <div className="ob-brand"><span className="dash-mark" aria-hidden="true" /><strong>Valcairn</strong></div>
        <Link className="ob-org-switch" to="/start" aria-label="Switch or add a workspace">
          <span className="ob-monogram ob-monogram--sm" aria-hidden="true">{initials(entry.name)}</span>
          <span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', fontSize: 14 }}>{entry.name}</strong><span className="ob-muted" style={{ fontSize: 12 }}>{entry.kind === 'personal' ? 'Personal' : role[0].toUpperCase() + role.slice(1)}</span></span>
          <Icon name="updown" size={14} />
        </Link>
        <nav aria-label="Workspace">
          <Link to={base} aria-current="page"><Tile icon="grid" tone="orange" size="sm" />Projects</Link>
          <a aria-disabled="true"><Tile icon="data" tone="teal" size="sm" />Data</a>
          <a aria-disabled="true"><Tile icon="layers" tone="blue" size="sm" />Models</a>
          {entry.kind === 'organization' && <a aria-disabled="true"><Tile icon="bank" tone="amber" size="sm" />Financing</a>}
          {entry.kind === 'organization' && <Link to={`/w/${entry.slug}/setup/team`}><Tile icon="people" tone="violet" size="sm" />Team</Link>}
        </nav>
        <button type="button" className="btn-text" style={{ marginTop: 'auto', alignSelf: 'flex-start' }} onClick={signOut}>Sign out</button>
      </aside>
      <main className="ob-body">
        <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
          <div className="ob-intro" style={{ gap: 8 }}>
            {dataDone && <span className="ob-ok"><Icon name="check" size={16} stroke={2.4} />Project set up</span>}
            <h1 className="ob-h1">{project.name}</h1>
            <span className="ob-muted">{project.modalities.join(', ')} · draft</span>
          </div>
          <Link className="btn-ghost" to={`${base}/success`}>Edit setup</Link>
        </div>
        <div className="ob-main" style={{ padding: 0, maxWidth: 'none', gap: 20 }}>
          <section className="ob-card" style={{ flex: '999 1 420px' }} aria-labelledby="status-title">
            <h2 id="status-title">Where things stand</h2>
            <ol className="ob-list">
              {STATUS.map((s, i) => {
                const st = state[s.key] ?? 'todo';
                return (
                  <li key={s.key}>
                    <span className={`ob-num${st === 'done' ? ' ob-num--done' : st === 'now' ? ' ob-num--now' : ''}`}>{st === 'done' ? <Icon name="check" size={12} stroke={3} /> : i + 1}</span>
                    <div><strong>{s.label}</strong><span className="ob-muted">{st === 'done' ? 'Done' : s.note ?? 'Next'}</span></div>
                    {i >= 2 && <span className="ob-badge">Not open yet</span>}
                  </li>
                );
              })}
            </ol>
          </section>
          <div className="ob-aside" style={{ flex: '1 1 280px' }}>
            {nextStep && (
              <section className="ob-card ob-card--strong">
                <span className="ob-eyebrow" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 12 }}>Your next step</span>
                <h2>{nextStep.title}</h2>
                <p className="ob-muted">{nextStep.body}</p>
                <Link className="btn-app" to={nextStep.to}>Continue</Link>
              </section>
            )}
            <section className="ob-card">
              <h2>What happens next</h2>
              <p className="ob-muted">Review, dataset versions and training open in upcoming releases. Your answers are saved, so nothing needs re-entering when they do.</p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
