// The model catalog's shape and checks, the enhancement methods and the compute options, plus validation for an
// enhance run plan. The open-weight models themselves are deployment data, not source: the server reads them
// once from MODEL_CATALOG_FILE (see docs/model-catalog.example.json) and hands the list to the routes and the
// browser. Figures in a catalog are approximate and should be checked against each model's own card.
// This module is also bundled into the browser build, so it must stay free of Node imports.

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Same id rule as model_pulls.model_id and enhance_runs.base_model_id in migrations/011_models.sql.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const TONES = ['blue', 'violet', 'teal', 'orange', 'plain'];
const ARCHITECTURES = ['dense', 'moe'];
const MODALITIES = ['text', 'vision'];
const TAGS = ['reasoning'];
const LORA_GPUS = [1, 2, 4];
const MAX_CATALOG_MODELS = 200;
const MAX_FORMATS = 8;
const MODEL_KEYS = ['id', 'name', 'maker', 'monogram', 'tone', 'source', 'params', 'architecture', 'active', 'contextK', 'contextNote',
  'modalities', 'tags', 'license', 'commercial', 'licenseNote', 'formats', 'loraGpus', 'summary'];

/**
 * Parses and checks a model catalog file: a JSON array of models, each with the fields the Models pages show.
 * Every field is bounded and every id is unique; an unknown field, a repeated id or a value out of range is an
 * error, so a mistyped file is refused at startup instead of rendering half a catalog.
 */
export function parseModelCatalog(json) {
  let list;
  try { list = JSON.parse(json); } catch (err) { throw new Error(`Model catalog is not valid JSON: ${err.message}`); }
  if (!Array.isArray(list)) throw new Error('Model catalog must be a JSON array of models');
  if (list.length > MAX_CATALOG_MODELS) throw new Error(`Model catalog lists more than ${MAX_CATALOG_MODELS} models`);
  const seen = new Set();
  return list.map((entry, i) => {
    const where = `Model catalog entry ${i}${typeof entry?.id === 'string' ? ` (${entry.id.slice(0, 64)})` : ''}`;
    const fail = (what) => { throw new Error(`${where}: ${what}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('must be an object');
    const unknown = Object.keys(entry).find((k) => !MODEL_KEYS.includes(k));
    if (unknown) fail(`unknown field "${unknown.slice(0, 40)}"`);
    const str = (key, max, optional = false) => {
      const v = entry[key];
      if (v == null) return optional ? null : fail(`${key} is required`);
      if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${key} must be text of 1 to ${max} characters`);
      return v.trim();
    };
    const oneOf = (key, allowed) => (allowed.includes(entry[key]) ? entry[key] : fail(`${key} must be one of ${allowed.join(', ')}`));
    const listOf = (key, allowed, min) => {
      const v = entry[key];
      if (!Array.isArray(v) || v.length < min || v.some((x) => !allowed.includes(x)) || new Set(v).size !== v.length) {
        fail(`${key} must be a list of ${allowed.join(', ')} without repeats${min ? ', with at least one' : ''}`);
      }
      return [...v];
    };
    const id = str('id', 64);
    if (!MODEL_ID_RE.test(id)) fail('id must be lower-case letters, digits, dots or dashes, starting with a letter or digit');
    if (seen.has(id)) fail('repeats an id');
    seen.add(id);
    const architecture = oneOf('architecture', ARCHITECTURES);
    const active = str('active', 20, true);
    if (architecture === 'moe' && !active) fail('a moe model needs active, the parameters used per token');
    const { contextK, commercial, formats } = entry;
    if (!Number.isInteger(contextK) || contextK < 1 || contextK > 100000) fail('contextK must be a whole number of thousands of tokens, 1 to 100000');
    if (typeof commercial !== 'boolean') fail('commercial must be true or false');
    if (!Array.isArray(formats) || !formats.length || formats.length > MAX_FORMATS) fail(`formats must list 1 to ${MAX_FORMATS} entries`);
    const checkedFormats = formats.map((f) => {
      if (!f || typeof f !== 'object' || typeof f.format !== 'string' || !f.format.trim() || f.format.length > 40) fail('each format needs a name of 1 to 40 characters');
      if (typeof f.gb !== 'number' || !Number.isFinite(f.gb) || f.gb <= 0 || f.gb > 100000) fail('each format needs gb, a number above 0');
      return { format: f.format.trim(), gb: f.gb };
    });
    return {
      id, name: str('name', 80), maker: str('maker', 80), monogram: str('monogram', 3), tone: oneOf('tone', TONES), source: str('source', 200),
      params: str('params', 20), architecture, active, contextK, contextNote: str('contextNote', 120, true),
      modalities: listOf('modalities', MODALITIES, 1), tags: listOf('tags', TAGS, 0),
      license: str('license', 80), commercial, licenseNote: str('licenseNote', 300),
      formats: checkedFormats, loraGpus: oneOf('loraGpus', LORA_GPUS), summary: str('summary', 300),
    };
  });
}

// Steps run in this order. Each uses a different kind of data from an approved dataset version.
export const ENHANCE_METHODS = [
  { id: 'sft', name: 'Fine-tune', tone: 'blue', icon: 'pen', detail: 'Learns your tone, products and reply format from real examples.', settings: 'LoRA rank 32 · 2 epochs' },
  { id: 'dpo', name: 'Preferences', tone: 'violet', icon: 'check', detail: 'Leans toward the answers your team chose over the ones they rejected.', settings: 'DPO · β 0.1' },
  { id: 'grpo', name: 'Reinforcement learning', tone: 'orange', icon: 'target', detail: 'Rewarded when it reaches the same outcome your team did.', settings: 'GRPO · 8 samples per prompt' },
];

// Rented GPUs, billed through Valcairn. Names are options to evaluate, not partnerships.
export const COMPUTE_OPTIONS = [
  { id: 'nebius', name: 'Nebius', gpus: '8 × H100', region: 'EU' },
  { id: 'coreweave', name: 'CoreWeave', gpus: '8 × H100', region: 'US' },
  { id: 'lambda', name: 'Lambda', gpus: '8 × H200', region: 'US' },
];

export const MAX_SPEND_CAP_USD = 100000;
export const MAX_RUN_DATASETS = 20;

/** A frozen version manifest is training data only if files were delivered under an uploaded rights record that allows training. */
export const allowsTraining = (manifest) => manifest?.dataSource?.mode === 'upload'
  && Array.isArray(manifest.dataSource.allowedUses) && manifest.dataSource.allowedUses.includes('training')
  && Array.isArray(manifest.files) && manifest.files.length > 0;
/**
 * Validates a draft enhance run. `catalog` is the current model catalog (an empty one refuses every base model);
 * `pulled` the set of catalog ids pulled into the workspace; `eligible` the approved dataset versions whose
 * rights allow training, as [{ projectId, version }].
 * Returns { values } or { errors }. A draft may be incomplete; `forRequest` checks what a request needs.
 */
export function validateEnhanceRun(raw, { catalog, pulled, eligible, forRequest = false }) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const baseModelId = typeof body.baseModelId === 'string' ? body.baseModelId : '';
  const model = catalog.find((m) => m.id === baseModelId) ?? null;
  if (!model) errors.baseModelId = 'Choose a model from the catalog.';
  else if (!pulled.has(baseModelId)) errors.baseModelId = 'Pull this model into the workspace first.';

  const datasets = [];
  const asked = Array.isArray(body.datasets) ? body.datasets : [];
  // An approval plan is never silently changed: too many versions is an error, not a truncation.
  if (asked.length > MAX_RUN_DATASETS) errors.datasets = `Choose at most ${MAX_RUN_DATASETS} dataset versions for one run.`;
  for (const d of asked.length > MAX_RUN_DATASETS ? [] : asked) {
    const version = Number(d?.version);
    const match = eligible.find((e) => e.projectId === d?.projectId && e.version === version);
    if (!match) { errors.datasets = 'Only approved dataset versions that allow training can be used.'; break; }
    if (!datasets.some((x) => x.projectId === match.projectId && x.version === match.version)) datasets.push({ projectId: match.projectId, version: match.version });
  }
  const wanted = Array.isArray(body.steps) ? body.steps : [];
  const steps = ENHANCE_METHODS.filter((m) => wanted.includes(m.id)).map((m) => m.id);
  if (wanted.some((s) => !ENHANCE_METHODS.some((m) => m.id === s))) errors.steps = 'Unknown step.';
  const compute = COMPUTE_OPTIONS.some((c) => c.id === body.compute) ? body.compute : null;
  if (body.compute != null && !compute) errors.compute = 'Choose one of the listed GPU options.';

  let spendCapUsd = null;
  if (body.spendCapUsd != null && body.spendCapUsd !== '') {
    // Whole dollars only, written plainly: "12.5", "-5", "1e3" or "0x10" are refused, never rewritten.
    const raw = body.spendCapUsd;
    // Only a number or a plain string: an array such as [250] would otherwise stringify to "250".
    const cap = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_SPEND_CAP_USD) errors.spendCapUsd = `Set a whole-dollar cap between $1 and $${MAX_SPEND_CAP_USD.toLocaleString('en-US')}.`;
    else spendCapUsd = cap;
  }
  if (forRequest) {
    if (!datasets.length) errors.datasets ??= 'Choose at least one approved dataset version.';
    if (!steps.length) errors.steps ??= 'Turn on at least one step.';
    if (!compute) errors.compute ??= 'Choose where it runs.';
    if (spendCapUsd == null) errors.spendCapUsd ??= 'Set a spending cap before you request the run.';
  }
  const name = text(body.name, 80) || `${model?.name ?? 'Model'} enhanced`;
  return Object.keys(errors).length ? { errors } : { values: { name, baseModelId, datasets, steps, compute, spendCapUsd } };
}
