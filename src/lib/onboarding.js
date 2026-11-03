// Validation for onboarding input. The store saves only what these functions return.

// Webmail domains never identify a company, so they never verify or match an organization.
export const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'yandex.com', 'mail.com',
]);

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
export const isEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
export const emailDomain = (email) => String(email ?? '').split('@')[1]?.toLowerCase() || null;

// .edu, .edu.xx and .ac.xx domains (e.g. mit.edu, unimelb.edu.au, ox.ac.uk).
export const isAcademicDomain = (domain) => /(^|\.)(edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/.test(String(domain ?? ''));

export const slugify = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** "https://www.Acme-Robotics.com/about" -> "acme-robotics.com"; anything that is not a hostname -> null. */
export function normalizeDomain(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  let host;
  try { host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname; } catch { return null; }
  host = host.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

const MODALITIES = ['Text', 'Documents', 'Images', 'Video', 'Audio', 'Sensor or time series', 'Robot trajectories'];
const STARTS = ['own', 'need', 'model', 'unsure'];
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);

export function validateProjectStart(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const task = text(body.task, 2000);
  const values = {
    name: text(body.name, 120) || task.split(/[.\n]/)[0].slice(0, 80) || 'Untitled project',
    task,
    modalities: Array.isArray(body.modalities) ? MODALITIES.filter((m) => body.modalities.includes(m)) : [],
    startingPoint: oneOf(body.startingPoint, STARTS),
  };
  const errors = {};
  if (task.length < 10) errors.task = 'Describe the task in a sentence or two.';
  if (!values.modalities.length) errors.modalities = 'Pick at least one kind of input.';
  if (!values.startingPoint) errors.startingPoint = 'Choose where you are starting from.';
  return Object.keys(errors).length ? { errors } : { values };
}

function validateSuccess(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    measure: oneOf(s.measure, ['recall', 'precision', 'accuracy', 'success_rate', 'rubric']) ?? 'recall',
    target: text(s.target, 40) || null,
    baseline: oneOf(s.baseline, ['current', 'off_the_shelf', 'none']) ?? 'none',
    runsOn: oneOf(s.runsOn, ['cloud', 'servers', 'device', 'later']) ?? 'later',
    device: text(s.device, 120) || null,
    latency: text(s.latency, 40) || null,
    spendLimit: text(s.spendLimit, 40) || null,
    approver: text(s.approver, 120) || null,
  };
}

function validateDataSource(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const mode = oneOf(d.mode, ['upload', 'license', 'commission']) ?? 'upload';
  const uses = Array.isArray(d.allowedUses) ? ['training', 'testing'].filter((u) => d.allowedUses.includes(u)) : [];
  return {
    mode,
    provenance: mode === 'upload' ? oneOf(d.provenance, ['ours', 'licensed', 'users']) : null,
    allowedUses: mode === 'upload' ? uses : [],
    personalData: mode === 'upload' ? oneOf(d.personalData, ['no', 'yes', 'unsure']) ?? 'unsure' : null,
    query: mode === 'license' ? text(d.query, 200) || null : null,
    brief: mode === 'commission' ? text(d.brief, 2000) || null : null,
    quantity: mode === 'commission' ? text(d.quantity, 80) || null : null,
    budget: mode === 'commission' ? text(d.budget, 80) || null : null,
    neededBy: mode === 'commission' ? text(d.neededBy, 80) || null : null,
  };
}

// The endpoint is stored for a later evaluation run, never called from here.
function httpsUrl(value) {
  const raw = text(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function validateModel(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const source = oneOf(m.source, ['endpoint', 'files', 'hub']);
  const endpointUrl = source === 'endpoint' ? httpsUrl(m.endpointUrl) : null;
  const model = {
    source,
    endpointUrl: endpointUrl ?? null,
    location: source === 'files' ? text(m.location, 300) || null : null,
    hubId: source === 'hub' ? text(m.hubId, 200) || null : null,
    format: oneOf(m.format, ['pytorch', 'safetensors', 'onnx', 'gguf', 'tensorflow', 'other', 'unknown']) ?? 'unknown',
    license: text(m.license, 200) || null,
    rightsConfirmed: m.rightsConfirmed === true,
    testSet: oneOf(m.testSet, ['yes', 'partial', 'no']) ?? 'no',
    testSetSize: text(m.testSetSize, 80) || null,
    rubric: text(m.rubric, 2000) || null,
  };
  const errors = {};
  if (!source) errors.source = 'Choose where the model is.';
  if (source === 'endpoint' && !endpointUrl) errors.endpointUrl = endpointUrl === undefined ? 'Use an https:// address without a username or password in it.' : 'Add the endpoint address.';
  if (source === 'files' && !model.location) errors.location = 'Say where the model files are kept.';
  if (source === 'hub' && !model.hubId) errors.hubId = 'Add the model name, e.g. organization/model-name.';
  if (!model.rightsConfirmed) errors.rightsConfirmed = 'Confirm you may test and deploy this model.';
  return Object.keys(errors).length ? { errors } : { model };
}

/** Accepts { success }, { dataSource } or { model } (one setup step at a time) and advances setupStep. */
export function validateProjectPatch(raw, project) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const modelPath = project?.startingPoint === 'model';
  // After a scoping call, an "unsure" project picks its real starting point; nothing else may change it.
  if (body.startingPoint) {
    if (project?.startingPoint !== 'unsure') return { errors: { form: 'The starting point is set when the project is created.' } };
    const next = oneOf(body.startingPoint, ['own', 'need', 'model']);
    return next ? { patch: { startingPoint: next, setupStep: 'success' } } : { errors: { startingPoint: 'Choose where you are starting from.' } };
  }
  if (project?.startingPoint === 'unsure') return { errors: { form: 'Choose a starting point after your scoping call first.' } };
  if (body.success) return { patch: { success: validateSuccess(body.success), setupStep: modelPath ? 'model' : 'data' } };
  if (body.model) {
    if (!modelPath) return { errors: { form: 'This project does not start from an existing model.' } };
    const { model, errors } = validateModel(body.model);
    return errors ? { errors } : { patch: { model, setupStep: 'done' } };
  }
  if (body.dataSource) {
    if (modelPath) return { errors: { form: 'This project starts from an existing model; describe the model instead.' } };
    const dataSource = validateDataSource(body.dataSource);
    const errors = {};
    if (dataSource.mode === 'upload' && !dataSource.provenance) errors.provenance = 'Tell us where the data came from.';
    if (dataSource.mode === 'upload' && !dataSource.allowedUses.length) errors.allowedUses = 'Choose at least one allowed use.';
    if (dataSource.mode === 'commission' && !dataSource.brief) errors.brief = 'Describe what should be collected or labeled.';
    if (Object.keys(errors).length) return { errors };
    return { patch: { dataSource, setupStep: 'done' } };
  }
  return { errors: { form: 'Nothing to update.' } };
}
