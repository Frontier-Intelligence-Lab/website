// The open-weight model catalog, the enhancement methods and the compute options, plus validation for an
// enhance run plan. The catalog is curated by Valcairn: figures are approximate and are checked against each
// model's own card before a model is added or updated here.

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const MODEL_CATALOG = [
  {
    id: 'qwen3-8b', name: 'Qwen3-8B', maker: 'Qwen team', monogram: 'Qw', tone: 'violet', source: 'Qwen/Qwen3-8B',
    params: '8.2B', architecture: 'dense', active: null, contextK: 128, modalities: ['text'], tags: ['reasoning'],
    license: 'Apache 2.0', commercial: true, licenseNote: 'Keep the LICENSE and NOTICE files when you share the weights.',
    formats: [{ format: 'bf16', gb: 16.4 }, { format: 'FP8', gb: 8.2 }, { format: '4-bit', gb: 5.0 }], loraGpus: 1,
    summary: 'A dense 8B text model, strong at reasoning and following instructions. A good first base for a company assistant: one GPU fine-tunes it.',
  },
  {
    id: 'gpt-oss-20b', name: 'gpt-oss-20b', maker: 'OpenAI', monogram: 'os', tone: 'plain', source: 'openai/gpt-oss-20b',
    params: '21B', architecture: 'moe', active: '3.6B', contextK: 128, modalities: ['text'], tags: ['reasoning'],
    license: 'Apache 2.0', commercial: true, licenseNote: 'Keep the LICENSE file and follow the model’s usage policy.',
    formats: [{ format: 'MXFP4, as shipped', gb: 13 }], loraGpus: 1,
    summary: 'A mixture-of-experts reasoning model that runs only 3.6B parameters per token, so it is cheap to serve for its size.',
  },
  {
    id: 'llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', maker: 'Meta', monogram: 'Ll', tone: 'blue', source: 'meta-llama/Llama-3.1-8B-Instruct',
    params: '8B', architecture: 'dense', active: null, contextK: 128, modalities: ['text'], tags: [],
    license: 'Llama 3.1 Community License', commercial: true, licenseNote: 'Commercial use is allowed with attribution and the acceptable use policy; very large services need a separate license.',
    formats: [{ format: 'bf16', gb: 16 }, { format: 'FP8', gb: 8 }, { format: '4-bit', gb: 5 }], loraGpus: 1,
    summary: 'A widely used 8B instruction model with a large ecosystem of tools and adapters.',
  },
  {
    id: 'mistral-small-3.1', name: 'Mistral Small 3.1', maker: 'Mistral AI', monogram: 'Mi', tone: 'orange', source: 'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
    params: '24B', architecture: 'dense', active: null, contextK: 128, modalities: ['text', 'vision'], tags: [],
    license: 'Apache 2.0', commercial: true, licenseNote: 'Keep the LICENSE file when you share the weights.',
    formats: [{ format: 'bf16', gb: 48 }, { format: 'FP8', gb: 24 }, { format: '4-bit', gb: 14 }], loraGpus: 2,
    summary: 'A 24B model that reads text and images, for tasks that need more capacity than an 8B model.',
  },
  {
    id: 'gemma-3-12b', name: 'Gemma 3 12B', maker: 'Google', monogram: 'Ge', tone: 'teal', source: 'google/gemma-3-12b-it',
    params: '12B', architecture: 'dense', active: null, contextK: 128, modalities: ['text', 'vision'], tags: [],
    license: 'Gemma terms of use', commercial: true, licenseNote: 'Commercial use is allowed under the Gemma terms and prohibited use policy, which pass on to your model.',
    formats: [{ format: 'bf16', gb: 24 }, { format: 'FP8', gb: 12 }, { format: '4-bit', gb: 7 }], loraGpus: 1,
    summary: 'A 12B model that reads text and images, with good multilingual coverage.',
  },
  {
    id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', maker: 'Qwen team', monogram: 'Qw', tone: 'violet', source: 'Qwen/Qwen3-30B-A3B',
    params: '30.5B', architecture: 'moe', active: '3.3B', contextK: 128, modalities: ['text'], tags: ['reasoning'],
    license: 'Apache 2.0', commercial: true, licenseNote: 'Keep the LICENSE and NOTICE files when you share the weights.',
    formats: [{ format: 'bf16', gb: 61 }, { format: 'FP8', gb: 31 }, { format: '4-bit', gb: 17 }], loraGpus: 4,
    summary: 'A mixture-of-experts model: 8 of 128 experts run per token, so it knows like a 30B model and runs like a 3B one.',
  },
];

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
export const catalogModel = (id) => MODEL_CATALOG.find((m) => m.id === id) ?? null;

/**
 * Validates a draft enhance run. `pulled` is the set of catalog ids pulled into the workspace; `eligible` the
 * approved dataset versions whose rights allow training, as [{ projectId, version }].
 * Returns { values } or { errors }. A draft may be incomplete; `forRequest` checks what a request needs.
 */
export function validateEnhanceRun(raw, { pulled, eligible, forRequest = false }) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const baseModelId = typeof body.baseModelId === 'string' ? body.baseModelId : '';
  if (!catalogModel(baseModelId)) errors.baseModelId = 'Choose a model from the catalog.';
  else if (!pulled.has(baseModelId)) errors.baseModelId = 'Pull this model into the workspace first.';

  const datasets = [];
  for (const d of Array.isArray(body.datasets) ? body.datasets.slice(0, 20) : []) {
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
    const cap = Number(body.spendCapUsd);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_SPEND_CAP_USD) errors.spendCapUsd = `Set a whole-dollar cap between $1 and $${MAX_SPEND_CAP_USD.toLocaleString('en-US')}.`;
    else spendCapUsd = cap;
  }
  if (forRequest) {
    if (!datasets.length) errors.datasets ??= 'Choose at least one approved dataset version.';
    if (!steps.length) errors.steps ??= 'Turn on at least one step.';
    if (!compute) errors.compute ??= 'Choose where it runs.';
    if (spendCapUsd == null) errors.spendCapUsd ??= 'Set a spending cap before you request the run.';
  }
  const name = text(body.name, 80) || `${catalogModel(baseModelId)?.name ?? 'Model'} enhanced`;
  return Object.keys(errors).length ? { errors } : { values: { name, baseModelId, datasets, steps, compute, spendCapUsd } };
}
