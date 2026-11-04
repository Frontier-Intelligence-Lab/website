// Run on this device: the download catalog's format, the repeatable compatibility tasks, and validation for everything a browser reports about its own machine. All of it is client-reported:
// the server never contacts a runtime, so nothing here is trusted as underwriting evidence.

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value, max) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null);
const int = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);
const HEX64 = /^[0-9a-f]{64}$/;
const RUNTIME_REF = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64})?$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * The download catalog is operator configuration (LOCAL_MODEL_CATALOG_FILE), not code: model identities are data
 * the person chooses from. Sizes are published download sizes and approximate; the runtime reports the exact total
 * while downloading, and the installed digest is the identity Valcairn records.
 */
export function parseCatalog(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('The local model catalog must be a JSON array');
  const ids = new Set();
  return list.map((m, i) => {
    const where = `local model catalog entry ${i + 1}`;
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(m?.id ?? '') || ids.has(m.id)) throw new Error(`${where}: id must be unique, lowercase letters, digits, dots or dashes`);
    ids.add(m.id);
    if (!RUNTIME_REF.test(m.ref ?? '') || isRemoteModel({ ref: m.ref })) throw new Error(`${where}: ref must be a local runtime model reference`);
    if (!(typeof m.approxGb === 'number' && m.approxGb > 0 && m.approxGb < 10000)) throw new Error(`${where}: approxGb must be a positive number`);
    if (!/^https:\/\//.test(m.source ?? '')) throw new Error(`${where}: source must be an https URL`);
    for (const key of ['name', 'license', 'summary']) if (!text(m[key], 300)) throw new Error(`${where}: ${key} is required`);
    return { id: m.id, ref: m.ref, name: text(m.name, 80), maker: text(m.maker, 80) || null, params: text(m.params, 20) || null, approxGb: m.approxGb, license: text(m.license, 120), source: m.source, upstream: text(m.upstream, 200) || null, summary: text(m.summary, 300) };
  });
}

/**
 * Short tasks with one correct answer, run with fixed settings so results are comparable across devices and
 * models. Prompts are sent only to the person's local runtime; the server records pass or fail and timings.
 */
export const COMPAT_TASKS = [
  { id: 'arithmetic', prompt: 'What is 17 + 25? Reply with only the number.', answer: '42' },
  { id: 'extraction', prompt: 'Invoice INV-20419 is due on 12 May. Reply with only the invoice number.', answer: 'INV-20419' },
  { id: 'classification', prompt: 'Message: "I want my money back for order 5512." Is this a refund request? Reply with only yes or no.', answer: 'yes' },
];
export const COMPAT_SETTINGS = { temperature: 0, seed: 7, numPredict: 32, numCtx: 2048 };

/** A reply passes when, ignoring case, surrounding punctuation and whitespace, it is exactly the answer. */
export const passesTask = (task, reply) => String(reply ?? '').trim().replace(/^[\s"'`*.]+|[\s"'`*.]+$/g, '').toLowerCase() === task.answer.toLowerCase();
/** Ready is for the exact bytes that were tested: the install must still be verified for that digest, and every task must have run. */
export const readyAfterTest = (install, digest, results, taskCount) => Boolean(install && digest && install.digest === digest && ['verified', 'ready'].includes(install.state) && results.length === taskCount && results.every((r) => r.ok));

/** Ollama marks models that run on its cloud; Valcairn's local mode must never call them, not even to inspect them. */
export const isRemoteModel = (m) => Boolean(m?.remote || m?.remote_host || m?.remote_model || /(^|[:-])cloud$/.test(String(m?.name ?? m?.ref ?? m?.runtimeRef ?? '')));

export function validateLabel(raw) {
  const label = text(raw, 80);
  return label ? { values: { label } } : { errors: { label: 'Name this device, for example "Work laptop".' } };
}

function modelSummary(m) {
  if (!m || typeof m !== 'object') return null;
  const name = text(m.name, 200);
  if (!name) return null;
  return {
    name,
    digest: HEX64.test(m.digest ?? '') ? m.digest : null,
    sizeBytes: int(m.sizeBytes, 2 ** 52),
    family: text(m.family, 60) || null,
    parameterSize: text(m.parameterSize, 20) || null,
    quantization: text(m.quantization, 20) || null,
    remote: Boolean(m.remote),
  };
}

/** A runtime report from the person's browser. Bounded and shape-checked; every value is client-reported. */
export function validateReport(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const reachable = r.reachable === true;
  const runtimeVersion = VERSION.test(r.runtimeVersion ?? '') ? r.runtimeVersion : null;
  const models = (Array.isArray(r.models) ? r.models.slice(0, 200) : []).map(modelSummary).filter(Boolean);
  const running = (Array.isArray(r.running) ? r.running.slice(0, 50) : []).map((m) => {
    const base = modelSummary(m);
    return base && { ...base, sizeVramBytes: int(m.sizeVramBytes, 2 ** 52), expiresAt: text(m.expiresAt, 40) || null };
  }).filter(Boolean);
  const b = r.browser && typeof r.browser === 'object' ? r.browser : {};
  const gpu = b.gpu && typeof b.gpu === 'object' ? { vendor: text(b.gpu.vendor, 80) || null, architecture: text(b.gpu.architecture, 80) || null, description: text(b.gpu.description, 120) || null } : null;
  const browser = {
    platform: text(b.platform, 60) || null,
    hardwareConcurrency: int(b.hardwareConcurrency, 4096),
    // navigator.deviceMemory is rounded and capped by the browser (8 in Chromium); it is a hint, not an inventory.
    deviceMemoryGb: num(b.deviceMemoryGb, 1024),
    webgpu: b.webgpu === true ? true : b.webgpu === false ? false : null,
    gpu,
  };
  if (!reachable && (runtimeVersion || models.length || running.length)) return { errors: { reachable: 'An unreachable runtime cannot report models.' } };
  return { values: { reachable, runtimeVersion, models, running, browser } };
}

const STATES = ['downloading', 'installed', 'verified', 'ready', 'failed', 'removed'];

/** One model on a device. Remote (cloud) models are refused: they do not run on this device. */
export function validateInstall(raw, catalog = []) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const runtimeRef = typeof r.runtimeRef === 'string' ? r.runtimeRef.trim() : '';
  if (!RUNTIME_REF.test(runtimeRef)) errors.runtimeRef = 'That is not a model reference this runtime uses.';
  else if (isRemoteModel({ runtimeRef, remote: r.remote })) errors.runtimeRef = 'Cloud models run on another provider’s servers, not this device.';
  const state = STATES.includes(r.state) ? r.state : null;
  if (!state) errors.state = 'Unknown state.';
  const digest = r.digest == null ? null : HEX64.test(r.digest) ? r.digest : undefined;
  if (digest === undefined) errors.digest = 'A digest is 64 lowercase hex characters.';
  if ((state === 'verified' || state === 'ready') && !digest) errors.digest = 'A verified model needs the digest read back from the runtime.';
  const failure = state === 'failed' ? text(r.failure, 300) || 'The runtime reported an error.' : null;
  const catalogId = typeof r.catalogId === 'string' && catalog.some((m) => m.id === r.catalogId) ? r.catalogId : null;
  const d = r.details && typeof r.details === 'object' ? r.details : {};
  const details = {
    format: text(d.format, 20) || null,
    family: text(d.family, 60) || null,
    parameterSize: text(d.parameterSize, 20) || null,
    quantization: text(d.quantization, 20) || null,
    license: text(d.license, 120) || null,
    capabilities: Array.isArray(d.capabilities) ? d.capabilities.filter((c) => typeof c === 'string').slice(0, 12).map((c) => c.slice(0, 20)) : [],
  };
  if (Object.keys(errors).length) return { errors };
  return { values: { runtimeRef, catalogId, digest, sizeBytes: int(r.sizeBytes, 2 ** 52), details, state, failure } };
}

const RUN_STATUS = ['completed', 'stopped', 'failed'];
const KINDS = ['chat', 'compat_test'];
const METRIC_KEYS = ['wallMs', 'ttftMs', 'loadMs', 'promptTokens', 'promptEvalMs', 'outputTokens', 'evalMs'];

/**
 * A measured run. Timings come from two sources and are kept apart: wallMs and ttftMs are measured by Valcairn
 * in the browser; the rest are the runtime's own counters. Throughput is derived here from the runtime counters.
 */
export function validateRun(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  if (r.location !== 'local_runtime') errors.location = 'Only runs on this device’s local runtime are recorded.';
  const kind = KINDS.includes(r.kind) ? r.kind : null;
  if (!kind) errors.kind = 'Unknown run kind.';
  const status = RUN_STATUS.includes(r.status) ? r.status : null;
  if (!status) errors.status = 'Unknown status.';
  const modelRef = typeof r.modelRef === 'string' ? r.modelRef.trim().slice(0, 200) : '';
  if (!modelRef) errors.modelRef = 'Which model ran?';
  else if (isRemoteModel({ name: modelRef, remote: r.remote })) errors.modelRef = 'Cloud models are not local runs.';
  const modelDigest = r.modelDigest == null ? null : HEX64.test(r.modelDigest) ? r.modelDigest : undefined;
  if (modelDigest === undefined) errors.modelDigest = 'A digest is 64 lowercase hex characters.';
  const promptSha256 = r.promptSha256 == null ? null : HEX64.test(r.promptSha256) ? r.promptSha256 : undefined;
  if (promptSha256 === undefined) errors.promptSha256 = 'A SHA-256 is 64 lowercase hex characters.';
  const m = r.metrics && typeof r.metrics === 'object' ? r.metrics : {};
  const metrics = {};
  for (const key of METRIC_KEYS) {
    if (m[key] == null) continue;
    const value = num(m[key], 1e9);
    if (value == null) { errors.metrics = `${key} must be a non-negative number.`; break; }
    metrics[key] = Math.round(value * 1000) / 1000;
  }
  if (metrics.outputTokens > 0 && metrics.evalMs > 0) metrics.tokensPerSec = Math.round((metrics.outputTokens / (metrics.evalMs / 1000)) * 100) / 100;
  if (metrics.promptTokens > 0 && metrics.promptEvalMs > 0) metrics.promptTokensPerSec = Math.round((metrics.promptTokens / (metrics.promptEvalMs / 1000)) * 100) / 100;
  const s = r.settings && typeof r.settings === 'object' ? r.settings : {};
  const settings = {
    numCtx: int(s.numCtx, 1_048_576),
    numPredict: int(s.numPredict, 131_072),
    temperature: num(s.temperature, 2),
    seed: int(s.seed, 2 ** 31),
    think: typeof s.think === 'boolean' ? s.think : null,
  };
  let task = null;
  if (kind === 'compat_test') {
    const t = r.task && typeof r.task === 'object' ? r.task : {};
    if (!COMPAT_TASKS.some((c) => c.id === t.id) || typeof t.passed !== 'boolean') errors.task = 'A compatibility run names its task and whether it passed.';
    else task = { id: t.id, passed: t.passed };
  }
  const failure = status === 'failed' ? text(r.failure, 300) || 'The runtime reported an error.' : null;
  if (Object.keys(errors).length) return { errors };
  return { values: { installId: typeof r.installId === 'string' ? r.installId : null, modelRef, modelDigest, location: 'local_runtime', kind, warm: r.warm === true, status, failure, settings, metrics, task, promptSha256 } };
}
