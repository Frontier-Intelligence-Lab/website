import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate, useRevalidator } from 'react-router';
import { api, uploadFile } from '../api.js';
import { FieldError, Icon, SetupShell, Tile, initials, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural, roleName } from './shell.jsx';
import { nextStepKind } from './lifecycle.js';
import { ruleProblem } from '../../../src/lib/onboarding.js';

const STEPS = ['Goal', "How you'll judge it", 'Data'];
const MODALITIES = ['Text', 'Documents', 'Images', 'Video', 'Audio', 'Sensor or time series', 'Robot trajectories'];
const STARTS = [
  { id: 'own', icon: 'data', tone: 'teal', title: 'We have our own data', body: 'Describe it and record its rights. It stays private to your workspace.' },
  { id: 'need', icon: 'store', tone: 'green', title: 'We need data', body: 'License an existing dataset, or have one collected and labeled.' },
  { id: 'model', icon: 'layers', tone: 'blue', title: 'We already have a model', body: 'Record it and how you want it tested. Testing and deployment are planned, not running yet.' },
  { id: 'unsure', icon: 'question', tone: 'violet', title: 'Not sure yet', body: 'Book a short call and we will scope it with you.' },
];
const PLANS = {
  own: [['Describe the task', 'You are here'], ['Record your data and its rights', 'Where it came from and how it may be used'], ['Rights and quality review', 'We check permissions, labels and duplicates'], ['Approve dataset version 1', 'Locked, versioned, private to you'], ['Train and evaluate', 'Planned. Will start only after you approve a cost estimate', true], ['Accept the model and deploy', 'Planned. Your cloud, your servers or a supported device', true]],
  need: [['Describe the task', 'You are here'], ['Shortlist or commission data', 'Compare samples, coverage and allowed uses'], ['Agree license terms', 'Nothing is bought until you approve'], ['Rights and quality review', 'We check permissions, labels and duplicates'], ['Train and evaluate', 'Planned. Will start only after you approve a cost estimate', true], ['Accept the model and deploy', 'Planned. Your cloud, your servers or a supported device', true]],
  model: [['Describe the task', 'You are here'], ['Connect your model', 'An endpoint or a model file you are allowed to use'], ['Add a test set', 'Examples with the answers you expect'], ['Compare against a baseline', 'Planned. See where it passes and fails', true], ['Deploy', 'Planned. Readiness checks before anything goes live', true]],
  unsure: [['Describe the task', 'You are here'], ['Scoping call', '30 minutes with our team'], ['Get a written plan', 'Data, approach, test method and a cost range']],
};

function Shell({ entry, current, children, title, modelPath = false }) {
  const steps = modelPath ? [STEPS[0], STEPS[1], 'Model and tests'] : STEPS;
  return (
    <SetupShell context={`New project · ${entry.name}`} exit={{ to: `/w/${entry.slug}`, label: 'Exit setup' }} steps={steps} current={current}>
      <title>{`${title} — Valcairn`}</title>
      {children}
    </SetupShell>
  );
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
    if (res?.ok) return navigate(`/w/${entry.slug}/projects/${res.data.project.id}${start === 'unsure' ? '' : '/success'}`);
    setErrors(res?.data.errors ?? { form: res?.data.error ?? 'Could not save. Please try again.' });
  }

  return (
    <Shell entry={entry} current={0} title="Project goal" modelPath={start === 'model'}>
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
              {PLANS[start].map(([label, note, planned], i) => (
                <li key={label}><span className={`ob-num${i === 0 ? ' ob-num--now' : ''}`}>{i + 1}</span><div><strong>{label}</strong><span className="ob-muted">{note}</span></div>{planned && <span className="ob-badge">Planned</span>}</li>
              ))}
            </ol>
          </div>
          {entry.kind === 'organization' && <div className="ob-note tile--amber"><Tile icon="bank" tone="amber" size="sm" /><span><strong>Financing is planned.</strong> It will cover compute and equipment once it opens; it isn't available yet.</span></div>}
        </aside>
      </form>
    </Shell>
  );
}

async function projectLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [detail, { workspace }, config] = await Promise.all([api.project(entry.id, params.projectId), api.workspace(entry.id), api.config()]);
  return { account, entry, workspace, bookingUrl: config.bookingUrl, ...detail };
}
// Setup pages edit the project, so they are only for editors of an editable project with a chosen starting point.
async function editLoader(args) {
  const data = await projectLoader(args);
  const home = `/w/${data.entry.slug}/projects/${data.project.id}`;
  if (!data.editable || data.project.startingPoint === 'unsure' || !['owner', 'admin', 'member'].includes(data.role)) throw redirect(home);
  return data;
}
export const successLoader = editLoader;
export async function dataLoader(args) {
  const data = await editLoader(args);
  if (data.project.startingPoint === 'model') throw redirect(`/w/${data.entry.slug}/projects/${data.project.id}/model`);
  return data;
}
export async function modelLoader(args) {
  const data = await editLoader(args);
  if (data.project.startingPoint !== 'model') throw redirect(`/w/${data.entry.slug}/projects/${data.project.id}/data`);
  return data;
}
export const projectHomeLoader = projectLoader;

const MEASURES = [['recall', 'Catches real problems (recall)'], ['precision', 'Few false alarms (precision)'], ['accuracy', 'Overall accuracy'], ['success_rate', 'Task success rate'], ['rubric', 'Scored by reviewers against a rubric'], ['data_quality', 'The data meets a written quality bar']];
// Mirrors WRITTEN_MEASURES in src/lib/onboarding.js: these are judged against criteria, not a number.
const WRITTEN = ['rubric', 'data_quality'];
const BASELINES = [['current', 'How you do it today', 'people checking, rules, an older system'], ['off_the_shelf', 'An off-the-shelf model, unchanged', ''], ['none', 'No baseline yet', "we'll help you set one"]];
const WHERE = [['cloud', 'Our cloud account'], ['servers', 'Our own servers'], ['device', 'On a device'], ['later', 'Decide later']];

export function ProjectSuccess() {
  const { entry, project } = useLoaderData();
  const navigate = useNavigate();
  const s = project.success ?? {};
  const [measure, setMeasure] = useState(s.measure ?? 'recall');
  const [target, setTarget] = useState(s.target ?? '');
  const [criteria, setCriteria] = useState(s.criteria ?? '');
  const [fieldErrors, setFieldErrors] = useState({});
  const written = WRITTEN.includes(measure);
  const [baseline, setBaseline] = useState(s.baseline ?? 'current');
  const [runsOn, setRunsOn] = useState(s.runsOn ?? 'later');
  const [device, setDevice] = useState(s.device ?? '');
  const [message, setMessage] = useState(null);
  const measureLabel = MEASURES.find(([id]) => id === measure)[1].toLowerCase();
  const baselineLabel = BASELINES.find(([id]) => id === baseline)[1].toLowerCase();
  const modelPath = project.startingPoint === 'model';
  const next = `/w/${entry.slug}/projects/${project.id}/${modelPath ? 'model' : 'data'}`;

  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const res = await api.updateProject(entry.id, project.id, { success: { ...form, measure, target, criteria, baseline, runsOn, device } }).catch(() => null);
    if (res?.ok) return navigate(next);
    setFieldErrors(res?.data.errors ?? {});
    setMessage(res?.data.error ?? 'Could not save. Please try again.');
  }

  return (
    <Shell entry={entry} current={1} title="How you'll judge it" modelPath={modelPath}>
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">How will you know it works?</h1>
            <p className="ob-lede">Set the bar before any training. Training and testing are planned, not running yet: when they open, every model version will be tested against this bar and you decide whether to accept it.</p>
          </div>
          {message && <p className="ob-alert" role="alert">{message}</p>}
          <div className="ob-grid">
            <div className="ob-field"><label htmlFor="measure">What to measure</label>
              <select id="measure" value={measure} onChange={(e) => setMeasure(e.target.value)}>{MEASURES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
            </div>
            {written ? (
              <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="criteria">{measure === 'data_quality' ? 'The data is good enough when' : 'Reviewers accept it when'}</label>
                <textarea id="criteria" rows={3} maxLength={1000} placeholder={measure === 'data_quality' ? 'e.g. every image has a box for each visible tear, and no two files are copies' : 'e.g. two reviewers rate at least 9 of 10 answers as correct and complete'} value={criteria} aria-invalid={fieldErrors.criteria ? 'true' : undefined} aria-describedby={fieldErrors.criteria ? 'criteria-error' : undefined} onChange={(e) => setCriteria(e.target.value)} />
                <FieldError id="criteria-error">{fieldErrors.criteria}</FieldError></div>
            ) : (
              <div className="ob-field"><label htmlFor="target">Good enough means at least</label><input id="target" type="text" maxLength={40} placeholder="e.g. 95%" value={target} aria-invalid={fieldErrors.target ? 'true' : undefined} aria-describedby={fieldErrors.target ? 'target-error' : undefined} onChange={(e) => setTarget(e.target.value)} />
                <FieldError id="target-error">{fieldErrors.target}</FieldError></div>
            )}
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
            {measure === 'data_quality'
              ? <p style={{ lineHeight: 1.6 }}>Accept the dataset when <strong>{criteria || '[your quality bar]'}</strong>.</p>
              : measure === 'rubric'
                ? <p style={{ lineHeight: 1.6 }}>Accept a model when reviewers find that <strong>{criteria || '[your criteria]'}</strong>, and it does better than <strong>{baselineLabel}</strong>.</p>
                : <p style={{ lineHeight: 1.6 }}>Accept a model when it scores <strong>{target || '[target]'}</strong> on <strong>{measureLabel}</strong> against held-out examples, does better than <strong>{baselineLabel}</strong>{runsOn === 'device' ? <>, and runs on <strong>{device || '[your device]'}</strong></> : ''}.</p>}
            <span className="ob-muted">You can change this until you send the project for review. Reopening the project lets you change it again.</span>
          </div>
          <div className="ob-card">
            <h2>Nothing runs on its own</h2>
            <ul className="ob-list">
              <li><Tile icon="shield" tone="blue" size="sm" /><div><span className="ob-muted">We check your data, model and device fit together first.</span></div></li>
              <li><Tile icon="check" tone="green" size="sm" /><div><span className="ob-muted">You see a cost estimate and approve it before any training.</span></div></li>
              <li><Tile icon="layers" tone="violet" size="sm" /><div><span className="ob-muted">Planned: results will come from tests on your held-out data. Nothing has been trained or tested yet.</span></div></li>
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
              <strong>Rights first, then files</strong>
              <span>Record where the data came from and how it may be used. You upload sample files on the next screen.</span>
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
              {entry.kind === 'personal'
                ? <li><Tile icon="people" tone="green" size="sm" /><div><strong>You</strong><span className="ob-muted">This is your personal workspace. No one else has access.</span></div></li>
                : <li><Tile icon="people" tone="green" size="sm" /><div><strong>Your team</strong><span className="ob-muted">People in {entry.name} with access to this project</span></div></li>}
              <li><Tile icon="shield" tone="amber" size="sm" /><div><strong>Valcairn reviewers</strong><span className="ob-muted">Only to check rights and quality</span></div></li>
              <li><Tile icon="minus" tone="plain" size="sm" /><div><strong>Nobody else</strong><span className="ob-muted">Never listed, sold or shown to other companies</span></div></li>
            </ul>
          </div>
        </aside>
      </form>
    </Shell>
  );
}

const SOURCES = [
  { id: 'endpoint', icon: 'link', tone: 'blue', title: 'A running endpoint', body: 'An HTTPS API that answers requests today.' },
  { id: 'files', icon: 'data', tone: 'teal', title: 'Model files', body: 'Weights or an exported model in your own storage.' },
  { id: 'hub', icon: 'store', tone: 'violet', title: 'A public model', body: 'An open-weight model published under a license.' },
];

export function ProjectModel() {
  const { entry, project } = useLoaderData();
  const navigate = useNavigate();
  const m = project.model ?? {};
  const [source, setSource] = useState(m.source ?? null);
  const [testSet, setTestSet] = useState(m.testSet ?? 'yes');
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState(false);
  const runsOn = project.success?.runsOn ?? 'later';
  const target = { cloud: 'your cloud account', servers: 'your own servers', device: project.success?.device || 'a device', later: null }[runsOn];

  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setPending(true);
    const res = await api.updateProject(entry.id, project.id, { model: { ...form, source, testSet, rightsConfirmed: form.rightsConfirmed === 'on' } }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate(`/w/${entry.slug}/projects/${project.id}`);
    setErrors(res?.data.errors ?? { form: res?.data.error ?? 'Could not save. Check your connection and try again.' });
  }

  const field = (name, label, props = {}) => (
    <div className="ob-field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type="text" defaultValue={m[name] ?? ''} aria-invalid={errors[name] ? true : undefined} aria-describedby={`${name}-error`} {...props} />
      <FieldError id={`${name}-error`}>{errors[name]}</FieldError>
    </div>
  );

  return (
    <Shell entry={entry} current={2} title="Model and tests" modelPath>
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">Tell us about your model</h1>
            <p className="ob-lede">Record it now. When evaluation opens (planned), it will be tested against your acceptance rule before anything is deployed, and nothing is retrained unless you ask.</p>
          </div>
          {errors.form && <p className="ob-alert" role="alert">{errors.form}</p>}
          <fieldset aria-describedby="source-error">
            <legend className="ob-legend">Where is the model?</legend>
            <div className="ob-grid ob-grid--tight">
              {SOURCES.map((s) => (
                <button key={s.id} type="button" className="ob-option" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
                  <Tile icon={s.icon} tone={s.tone} /><strong>{s.title}</strong><span>{s.body}</span>
                </button>
              ))}
            </div>
            <FieldError id="source-error">{errors.source}</FieldError>
          </fieldset>
          {source === 'endpoint' && <>
            {field('endpointUrl', 'Endpoint address', { type: 'url', maxLength: 500, placeholder: 'https://models.example.com/v1/predict' })}
            <p className="ob-muted">Don't paste keys or passwords here. We'll ask for credentials separately, through a secure connection, when evaluation runs open.</p>
          </>}
          {source === 'files' && field('location', 'Where the files are kept', { maxLength: 300, placeholder: 'e.g. our S3 bucket, internal model registry' })}
          {source === 'hub' && field('hubId', 'Model name', { maxLength: 200, placeholder: 'organization/model-name' })}
          <div className="ob-grid">
            <div className="ob-field">
              <label htmlFor="format">Format</label>
              <select id="format" name="format" defaultValue={m.format ?? 'unknown'}>
                <option value="unknown">Not sure</option><option value="pytorch">PyTorch</option><option value="safetensors">safetensors</option>
                <option value="onnx">ONNX</option><option value="gguf">GGUF</option><option value="tensorflow">TensorFlow</option><option value="other">Other</option>
              </select>
            </div>
            {field('license', 'License', { maxLength: 200, placeholder: 'e.g. Apache-2.0, internal, commercial' })}
          </div>
          <label className="ob-check"><input type="checkbox" name="rightsConfirmed" defaultChecked={m.rightsConfirmed} aria-describedby="rights-error" />We're allowed to test this model and deploy it for this task under its license.</label>
          <FieldError id="rights-error">{errors.rightsConfirmed}</FieldError>
          <fieldset>
            <legend className="ob-legend">Do you have examples with the right answers?</legend>
            <div className="ob-grid ob-grid--tight">
              {[['yes', 'Yes, a test set'], ['partial', 'Some examples'], ['no', 'Not yet']].map(([id, label]) => (
                <label key={id} className="ob-option ob-option--row"><input type="radio" name="testSetChoice" checked={testSet === id} onChange={() => setTestSet(id)} />{label}</label>
              ))}
            </div>
          </fieldset>
          {testSet !== 'no'
            ? field('testSetSize', 'About how many examples?', { maxLength: 80, placeholder: 'e.g. 500 labelled images' })
            : <p className="ob-note tile--violet">We'll help you build one. Without examples with known answers, we can't tell whether the model meets your rule.</p>}
          <div className="ob-field">
            <label htmlFor="rubric">Anything a reviewer should check by hand? <span className="ob-optional">(optional)</span></label>
            <textarea id="rubric" name="rubric" rows={2} maxLength={2000} defaultValue={m.rubric ?? ''} />
          </div>
          <div className="ob-actions">
            <Link className="btn-ghost" to={`/w/${entry.slug}/projects/${project.id}/success`}>Back</Link>
            <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save and finish'} <Icon name="arrow" size={16} /></button>
          </div>
        </section>
        <aside className="ob-aside">
          <div className="ob-card">
            <h2>Deployment target</h2>
            <p className="ob-muted">{target ? <>From your acceptance rule: <strong style={{ color: 'var(--text)' }}>{target}</strong>.</> : 'Not decided yet. You can set it in your acceptance rule.'}</p>
            <Link to={`/w/${entry.slug}/projects/${project.id}/success`}>Change it</Link>
          </div>
          <div className="ob-note tile--amber"><Tile icon="info" tone="amber" size="sm" /><span>Evaluation runs and deployment aren't open yet. We save this now so your project is ready when they are. We never call your endpoint from this form.</span></div>
        </aside>
      </form>
    </Shell>
  );
}


const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Picks files and sends each one to the ingest service, then records its signed receipt. */
function Uploader({ entry, project, onUploaded }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (i, patch) => setItems((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function upload(files) {
    const list = [...files];
    if (!list.length) return;
    const start = items.length;
    setItems((all) => [...all, ...list.map((f) => ({ name: f.name, size: f.size, state: 'waiting', progress: 0 }))]);
    setBusy(true);
    for (const [k, file] of list.entries()) {
      const i = start + k;
      // Each file gets its own single-use grant from the web server.
      const grantRes = await api.uploadGrant(entry.id, project.id).catch(() => null);
      if (!grantRes?.ok) { set(i, { state: 'failed', error: grantRes?.data.error ?? 'Could not start the upload.' }); continue; }
      if (file.size > grantRes.data.maxBytes) { set(i, { state: 'failed', error: `Larger than the ${fmtBytes(grantRes.data.maxBytes)} limit.` }); continue; }
      set(i, { state: 'uploading' });
      try {
        const sent = await uploadFile(grantRes.data, file, (p) => set(i, { progress: p }));
        const saved = await api.recordUpload(entry.id, project.id, sent.receipt);
        if (!saved.ok) throw new Error(saved.data.error ?? 'The upload could not be recorded.');
        set(i, { state: saved.data.upload.duplicateOf ? 'duplicate' : 'done', sha256: sent.sha256, contentType: sent.contentType });
      } catch (err) {
        set(i, { state: 'failed', error: err.message });
      }
    }
    setBusy(false);
    onUploaded();
  }

  return (
    <div className="ob-intro" style={{ gap: 12 }}>
      <label className="ob-drop" htmlFor="sample-files" style={{ cursor: 'pointer' }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy) upload(e.dataTransfer.files); }}>
        <Tile icon="upload" tone="teal" />
        <strong>{busy ? 'Uploading…' : 'Drop sample files here, or choose files'}</strong>
        <span>Images, audio, video, PDFs, archives, CSV, JSON or Parquet. Each file is checked, hashed and stored privately.</span>
        <input id="sample-files" type="file" multiple className="visually-hidden" disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {items.length > 0 && (
        <ul className="ob-list" aria-live="polite">
          {items.map((it, i) => (
            <li key={i}>
              <Tile icon={it.state === 'failed' ? 'info' : it.state === 'done' || it.state === 'duplicate' ? 'check' : 'clock'} tone={it.state === 'failed' ? 'orange' : it.state === 'done' ? 'green' : 'plain'} size="sm" />
              <div>
                <strong>{it.name}</strong>
                <span className="ob-muted">
                  {fmtBytes(it.size)} · {it.state === 'uploading' ? `${Math.round(it.progress * 100)}%` : it.state === 'done' ? `stored · ${it.contentType}` : it.state === 'duplicate' ? 'same content as an earlier file; it won’t be counted twice' : it.state === 'failed' ? it.error : 'waiting'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AcademicCard({ entry, profile, onDone }) {
  const [stage, setStage] = useState('email');
  const [devCode, setDevCode] = useState(null);
  const [error, setError] = useState(null);
  if (profile.academicVerifiedAt) {
    return <section className="ob-card"><h2>Academic email verified</h2><p className="ob-muted">{profile.academicEmail}. Your academic status is recorded. Access to datasets licensed only for non-commercial research is planned, not available yet.</p></section>;
  }
  async function send(event) {
    event.preventDefault();
    const res = await api.academicSend(entry.id, new FormData(event.currentTarget).get('email')).catch(() => null);
    if (!res?.ok) return setError(res?.data.error ?? 'Could not send the code.');
    setError(null); setDevCode(res.data.devCode ?? null); setStage('code');
  }
  async function verify(event) {
    event.preventDefault();
    const res = await api.academicVerify(entry.id, new FormData(event.currentTarget).get('code')).catch(() => null);
    if (!res?.ok) return setError(res?.data.error ?? 'Could not check the code.');
    onDone();
  }
  return (
    <section className="ob-card">
      <h2>Verify your academic email</h2>
      <p className="ob-muted">Records that you are at a university. Access to datasets licensed only for non-commercial research is planned, not available yet. Your sign-in email stays the same.</p>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      {stage === 'email' ? (
        <form className="ob-intro" style={{ gap: 10 }} onSubmit={send}>
          <div className="ob-field"><label htmlFor="academic-email">University email</label><input id="academic-email" name="email" type="email" placeholder="you@university.edu" /></div>
          <button className="btn-ghost" type="submit">Send code</button>
        </form>
      ) : (
        <form className="ob-intro" style={{ gap: 10 }} onSubmit={verify}>
          {devCode && <p className="ob-alert ob-alert--info">Local development: your code is <strong>{devCode}</strong>.</p>}
          <div className="ob-field"><label htmlFor="academic-code">6-digit code</label><input id="academic-code" name="code" type="text" inputMode="numeric" maxLength={6} className="ob-code" /></div>
          <button className="btn-app" type="submit">Verify</button>
        </form>
      )}
    </section>
  );
}

const STATUS_LABEL = { draft: 'draft', in_review: 'in review', changes_requested: 'changes requested', approved: 'approved', versioned: 'dataset version approved' };

/** Sidebar and frame shared by the workspace home and project pages. */
export async function workspaceHomeLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const { projects } = await api.projects(entry.id);
  return { account, entry, projects };
}

/** Lists the workspace's projects. Never redirects, so read-only roles get a stable page even when it is empty. */
export function WorkspaceHome() {
  const { account, entry, projects } = useLoaderData();
  const writer = ['owner', 'admin', 'member'].includes(entry.role);
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title={entry.name}>
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <h1 className="ob-h1">Projects</h1>
          <span className="ob-muted">{plural(projects.length, 'project')} in {entry.name}</span>
        </div>
        {writer && <Link className="btn-app" to={`/w/${entry.slug}/projects/new`}>New project</Link>}
      </div>
      {projects.length === 0 ? (
        <section className="ob-card" style={{ alignItems: 'flex-start' }}>
          <Tile icon="grid" tone="orange" size="lg" />
          <h2>No projects yet</h2>
          {writer
            ? <><p className="ob-muted">Start with the task you want a model to do. Setup takes a few minutes and saves as you go.</p><Link className="btn-app" to={`/w/${entry.slug}/projects/new`}>Start your first project</Link></>
            : <p className="ob-muted">You have {roleName(entry.role)} access, so you can view projects here once someone on the team starts one. Owners, admins and members can create them.</p>}
        </section>
      ) : (
        <ul className="ob-list ob-card">
          {[...projects].reverse().map((p) => (
            <li key={p.id}>
              <Tile icon={p.startingPoint === 'model' ? 'layers' : 'data'} tone={p.startingPoint === 'model' ? 'blue' : 'teal'} size="sm" />
              <div><strong>{p.name}</strong><span className="ob-muted">{p.modalities.join(', ') || 'No inputs chosen'} · {STATUS_LABEL[p.status] ?? p.status}</span></div>
              <Link className="btn-ghost" to={`/w/${entry.slug}/projects/${p.id}`}>Open</Link>
            </li>
          ))}
        </ul>
      )}
    </WorkspaceShell>
  );
}

const START_CHOICES = [['own', 'We have our own data'], ['need', 'We need data'], ['model', 'We already have a model']];

export function ProjectHome() {
  const { account, entry, project, role, uploads, latestReview, versions, uploadsEnabled, workspace, bookingUrl } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const base = `/w/${entry.slug}/projects/${project.id}`;
  const modelPath = project.startingPoint === 'model';
  const unsure = project.startingPoint === 'unsure';
  const manager = ['owner', 'admin'].includes(role);
  const writer = ['owner', 'admin', 'member'].includes(role);
  const mode = project.dataSource?.mode;
  const [actionError, setActionError] = useState(null);
  const [pending, setPending] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);

  // Complete, not merely present: the same check Resolve and the submit gate apply to the stored rule.
  const ruleGap = ruleProblem(project.success);
  const taskDone = !ruleGap;
  const dataDone = Boolean(modelPath ? project.model : project.dataSource);
  const s = project.status;
  const editable = ['draft', 'changes_requested'].includes(s);
  const reviewed = ['approved', 'versioned'].includes(s);
  const latest = versions.at(-1);
  const steps = unsure ? [
    { label: 'Describe the task', st: 'done' },
    { label: 'Scoping call with Valcairn', st: 'now', note: '30 minutes to agree the data, approach and how to test it.' },
    { label: 'Choose how to start', st: 'todo', note: 'Own data, licensed or collected data, or an existing model.' },
  ] : modelPath ? [
    { label: 'Task and acceptance rule', st: taskDone ? 'done' : 'now' },
    { label: 'Model and test plan', st: dataDone ? 'done' : taskDone ? 'now' : 'todo' },
    { label: 'Evaluate against your rule', st: 'todo', soon: true, note: 'Compare with your baseline on held-out examples.' },
    { label: 'Readiness check and deploy', st: 'todo', soon: true, note: 'Only a model that meets your rule can be deployed.' },
  ] : [
    { label: 'Task and acceptance rule', st: taskDone ? 'done' : 'now' },
    { label: 'Data and rights record', st: dataDone ? 'done' : taskDone ? 'now' : 'todo' },
    ...(mode === 'upload' ? [{ label: 'Upload a sample', st: uploads.length ? 'done' : dataDone ? 'now' : 'todo', note: uploads.length ? plural(uploads.length, 'file') : undefined }] : []),
    { label: 'Rights and quality review', st: reviewed ? 'done' : ['in_review', 'changes_requested'].includes(s) ? 'now' : 'todo', note: s === 'in_review' ? 'With Valcairn' : s === 'changes_requested' ? 'Changes requested' : 'Valcairn checks rights, consent, labels and duplicates.' },
    { label: `Approve dataset version ${s === 'versioned' ? latest.number : (latest?.number ?? 0) + 1}`, st: s === 'versioned' ? 'done' : s === 'approved' ? 'now' : 'todo', note: s === 'versioned' ? `Version ${latest.number} · ${plural(latest.files, 'file')}` : 'Locks exactly the files and rights record that were reviewed.' },
    { label: 'Train and test', st: 'todo', soon: true, note: 'Planned. You will approve a cost estimate first.' },
    { label: 'Accept and deploy', st: 'todo', soon: true, note: 'Planned. Only a model that meets your rule can be accepted.' },
  ];

  async function act(fn, ok) {
    setPending(true); setActionError(null);
    const res = await fn().catch(() => null);
    setPending(false);
    if (!res?.ok) return setActionError(res?.data.error ?? 'That did not work. Check your connection and try again.');
    ok?.(res.data);
    revalidator.revalidate();
  }
  const reopen = () => act(() => api.reopenProject(entry.id, project.id), () => setConfirmReopen(false));
  const chooseStart = (start) => act(() => api.updateProject(entry.id, project.id, { startingPoint: start }), () => navigate(`${base}/success`));
  const removeFile = (u) => act(() => api.deleteUpload(entry.id, project.id, u.id));

  const reopenBlock = (
    confirmReopen ? (
      <div className="ob-intro" style={{ gap: 10 }}>
        <p className="ob-alert">Reopening unlocks the project for changes and voids the current approval. You'll need a new Valcairn review before the next dataset version. Existing versions stay as they are.</p>
        <div className="ob-row-actions"><button className="btn-app" type="button" disabled={pending} onClick={reopen}>Reopen for changes</button><button className="btn-text" type="button" onClick={() => setConfirmReopen(false)}>Cancel</button></div>
      </div>
    ) : <button className="btn-text" type="button" onClick={() => setConfirmReopen(true)}>Need changes? Reopen the project</button>
  );

  // Lifecycle first (see lifecycle.js): frozen projects always keep their reopen, withdraw and version actions.
  const kind = nextStepKind({ status: s, startingPoint: project.startingPoint, role, hasSuccess: taskDone, hasData: dataDone });
  const fixRule = project.success ? 'complete it' : 'set one';
  const noRule = !taskDone && !unsure && <p className="ob-alert">{project.success ? 'This project’s acceptance rule is incomplete.' : 'This project has no acceptance rule.'} {s === 'in_review' ? `Withdraw it from review to ${fixRule}.` : manager ? `Reopen it to ${fixRule} before the next review.` : `An owner or admin can reopen it to ${fixRule}.`}</p>;
  const needsFiles = mode === 'upload' && uploads.length === 0;
  const steps_ = {
    'book-call': {
      title: 'Book your scoping call',
      body: 'Thirty minutes with our team to pin down the data, the approach and how to test it. You get a written plan afterwards.',
      custom: <>
        {bookingUrl ? <a className="btn-app" href={bookingUrl} target="_blank" rel="noreferrer">Book a 30-minute call</a> : <Link className="btn-app" to="/contact">Contact us to book</Link>}
        <p className="ob-muted">Already know how you want to start?</p>
        <div className="ob-chips">{START_CHOICES.map(([id, label]) => <button key={id} type="button" className="ob-chip" disabled={pending} onClick={() => chooseStart(id)}>{label}</button>)}</div>
      </>,
    },
    'wait-call': { title: 'Waiting for a scoping call', body: 'Someone on the team is arranging a call with Valcairn.' },
    'set-rule': project.success
      ? { title: 'Finish your acceptance rule', body: `${ruleGap} Review needs a complete rule.`, to: `${base}/success` }
      : { title: 'Set your acceptance rule', body: 'Decide what good enough means before any training.', to: `${base}/success` },
    'describe-model': { title: 'Describe your model and tests', body: 'Where the model is, its license and the examples to test it on.', to: `${base}/model` },
    'record-data': { title: 'Record your data and its rights', body: 'Where it came from and how it may be used.', to: `${base}/data` },
    submit: {
      title: needsFiles ? 'Upload a sample' : s === 'changes_requested' ? 'Fix and resubmit' : 'Submit for review',
      body: needsFiles ? 'A few hundred representative files is enough to check fit and rights.' : mode === 'upload' ? 'Submitting locks the files, rights record and acceptance rule for Valcairn’s review.' : 'Valcairn reviews your request and comes back with options and terms.',
      custom: (
        <>
          {s === 'changes_requested' && latestReview?.notes && <p className="ob-alert"><strong>Reviewer notes:</strong> {latestReview.notes}</p>}
          {mode === 'upload' && (uploadsEnabled ? <Uploader entry={entry} project={project} onUploaded={() => revalidator.revalidate()} /> : <p className="ob-alert">Uploads are not configured on this server.</p>)}
          {mode === 'upload'
            ? <Link className="btn-app" to={`${base}/dataset/resolve`} aria-disabled={needsFiles || undefined} onClick={(e) => needsFiles && e.preventDefault()}>Resolve and submit for review</Link>
            : <button className="btn-app" type="button" disabled={pending || needsFiles} onClick={() => act(() => api.submitReview(entry.id, project.id))}>{pending ? 'Submitting…' : 'Submit for review'}</button>}
        </>
      ),
    },
    'in-review-withdraw': {
      title: 'In review with Valcairn',
      body: 'The files, rights record and acceptance rule are locked while the review is open. You’ll see the decision here.',
      custom: <>{noRule}<button className="btn-text" type="button" disabled={pending} onClick={() => act(() => api.reopenProject(entry.id, project.id))}>Withdraw from review to make changes</button></>,
    },
    'in-review': { title: 'In review with Valcairn', body: 'The files, rights record and acceptance rule are locked while the review is open.' },
    'approve-version': { title: `Approve dataset version ${(latest?.number ?? 0) + 1}`, body: 'This freezes exactly the reviewed files, rights record and acceptance rule. Training will only use an approved version.', custom: <>{noRule}<button className="btn-app" type="button" disabled={pending} onClick={() => act(() => api.createVersion(entry.id, project.id))}>{pending ? 'Approving…' : `Approve version ${(latest?.number ?? 0) + 1}`}</button>{reopenBlock}</> },
    'wait-admin': { title: 'Waiting for an admin', body: 'An owner or admin approves the dataset version.', custom: noRule },
    'versioned-manage': { title: `Dataset version ${latest?.number} approved`, body: `${plural(latest?.files ?? 0, 'file')} and their rights record are frozen in this version. Training and evaluation are planned; nothing runs yet.`, custom: <>{noRule}{entry.kind === 'organization' && <Link className="btn-ghost" to={`/w/${entry.slug}/setup/team`}>Invite your team</Link>}{reopenBlock}</> },
    versioned: { title: `Dataset version ${latest?.number} approved`, body: 'Training and evaluation are planned; nothing runs yet.', custom: noRule },
  };
  const next = kind ? steps_[kind] : null;

  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={project.name} project={project} current="project">
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <Link className="ob-muted" to={`/w/${entry.slug}`}>← All projects</Link>
          <h1 className="ob-h1">{project.name}</h1>
          <span className="ob-muted">{project.modalities.join(', ')} · {STATUS_LABEL[s] ?? s}{!editable && !unsure ? ' · locked' : ''}</span>
        </div>
        <div className="ob-row-actions">
          {!modelPath && !unsure && <Link className="btn-ghost" to={`${base}/dataset`}><Icon name="data" size={16} />Open dataset</Link>}
          {writer && editable && !unsure && <Link className="btn-ghost" to={`${base}/success`}>Edit setup</Link>}
        </div>
      </div>
      {actionError && <p className="ob-alert" role="alert">{actionError}</p>}
      {!writer && <p className="ob-alert ob-alert--info">You have {roleName(role)} access: you can see this project but not change it.</p>}
      <div className="ob-main" style={{ padding: 0, maxWidth: 'none', gap: 20 }}>
        <section className="ob-card" style={{ flex: '999 1 420px' }} aria-labelledby="status-title">
          <h2 id="status-title">Where things stand</h2>
          <ol className="ob-list">
            {steps.map((step, i) => (
              <li key={step.label}>
                <span className={`ob-num${step.st === 'done' ? ' ob-num--done' : step.st === 'now' ? ' ob-num--now' : ''}`}>{step.st === 'done' ? <Icon name="check" size={12} stroke={3} /> : i + 1}</span>
                <div><strong>{step.label}</strong><span className="ob-muted">{step.note ?? (step.st === 'done' ? 'Done' : step.st === 'now' ? 'Next' : 'After the step above')}</span></div>
                {step.soon && <span className="ob-badge">Planned</span>}
              </li>
            ))}
          </ol>
        </section>
        <div className="ob-aside" style={{ flex: '1 1 320px' }}>
          {next && (
            <section className="ob-card ob-card--strong">
              <span className="ob-eyebrow" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 12 }}>Your next step</span>
              <h2>{next.title}</h2>
              <p className="ob-muted">{next.body}</p>
              {next.custom}
              {next.to && <Link className="btn-app" to={next.to}>Continue</Link>}
            </section>
          )}
          {entry.kind === 'personal' && workspace.profile.kind !== 'independent' && <AcademicCard entry={entry} profile={workspace.profile} onDone={() => revalidator.revalidate()} />}
          {uploads.length > 0 && (
            <section className="ob-card">
              <h2>Sample files · {uploads.length}</h2>
              <ul className="ob-list">
                {uploads.slice(-12).map((u) => (
                  <li key={u.id}>
                    <div><strong>{u.filename}</strong><span className="ob-muted">{fmtBytes(u.sizeBytes)} · {u.contentType}{u.duplicateOf ? ' · duplicate, not reviewed twice' : ''} · sha256 {u.sha256.slice(0, 12)}…</span></div>
                    {writer && editable && <button type="button" className="btn-text" disabled={pending} onClick={() => removeFile(u)} aria-label={`Remove ${u.filename}`}>Remove</button>}
                  </li>
                ))}
              </ul>
              {uploads.length > 12 && <p className="ob-muted">Showing the latest 12.</p>}
            </section>
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}
