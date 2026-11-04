import { createHash, randomBytes } from 'node:crypto';

/**
 * Valcairn Runners and jobs: key handling and validation of everything a runner sends. A runner is untrusted
 * input like any client, so every field is bounded and typed here before it reaches the store.
 */
export const JOB_KINDS = ['probe', 'train', 'evaluate', 'export'];
export const EVENT_KINDS = ['log', 'metric', 'stage', 'artifact'];
// Failure categories a runner may report. Free text from a sandbox can echo data, so only the category is stored.
export const FAILURES = ['cancelled', 'sandbox_unavailable', 'sandbox_error', 'out_of_memory', 'disk_full', 'dataset_error',
  'model_unavailable', 'runtime_error', 'timeout', 'unsupported'];
// Failures the server itself records.
export const SERVER_FAILURES = ['lease_expired', 'runner_revoked'];
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const MAX_EVENTS_PER_CALL = 50;
const KEY_PREFIX = 'vrk_';

/** A new runner key: shown to the person once; only its SHA-256 is stored. 256 bits, so no pepper is needed. */
export const newRunnerKey = () => `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
export const newLeaseToken = () => randomBytes(24).toString('base64url');
export const hashSecret = (secret) => createHash('sha256').update(String(secret)).digest('hex');
export const keyPrefix = (key) => key.slice(0, KEY_PREFIX.length + 6);

/** The bearer key from an Authorization header, or null. */
export function bearerKey(header) {
  const match = /^Bearer (vrk_[A-Za-z0-9_-]{43})$/.exec(typeof header === 'string' ? header : '');
  return match ? match[1] : null;
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const optStr = (v, max) => (v == null ? null : str(v, max));
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const jsonSize = (v) => Buffer.byteLength(JSON.stringify(v ?? null));

export function validateRunnerLabel(raw) {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (!label) return { errors: { label: 'Name this runner, for example "Lab workstation".' } };
  if (label.length > 80) return { errors: { label: 'Keep the name under 80 characters.' } };
  return { values: { label } };
}

/** What a runner reports about its machine. Unknown fields are dropped; wrong types make the report invalid. */
export function validateCapabilities(raw) {
  if (!isObject(raw)) return { errors: { capabilities: 'Send the runner capabilities as an object.' } };
  const errors = {};
  const out = { platform: optStr(raw.platform, 80), runnerVersion: optStr(raw.runnerVersion, 40) };
  if (raw.platform != null && out.platform == null) errors.platform = 'Too long.';
  if (raw.runnerVersion != null && out.runnerVersion == null) errors.runnerVersion = 'Too long.';

  const gpus = raw.gpus ?? [];
  if (!Array.isArray(gpus) || gpus.length > 16) errors.gpus = 'Up to 16 GPUs.';
  else {
    out.gpus = gpus.map((g) => (isObject(g) ? { name: str(g.name, 120), memoryMb: int(g.memoryMb, 0, 4_000_000), driver: optStr(g.driver, 40) } : null));
    if (out.gpus.some((g) => !g || g.name == null || g.memoryMb == null)) errors.gpus = 'Each GPU needs a name and memory in MB.';
  }

  const ollama = raw.ollama ?? { reachable: false };
  if (!isObject(ollama) || typeof ollama.reachable !== 'boolean') errors.ollama = 'Report whether Ollama is reachable.';
  else {
    const models = ollama.models ?? [];
    out.ollama = { reachable: ollama.reachable, version: optStr(ollama.version, 40), models: [] };
    if (!Array.isArray(models) || models.length > 200) errors.ollama = 'Up to 200 models.';
    else {
      out.ollama.models = models.map((m) => (isObject(m) ? { name: str(m.name, 200), digest: optStr(m.digest, 100), sizeBytes: m.sizeBytes == null ? null : int(m.sizeBytes, 0, Number.MAX_SAFE_INTEGER) } : null));
      if (out.ollama.models.some((m) => !m || m.name == null)) errors.ollama = 'Each model needs a name.';
    }
  }

  const sandbox = raw.sandbox ?? { available: false };
  if (!isObject(sandbox) || typeof sandbox.available !== 'boolean') errors.sandbox = 'Report whether the sandbox is available.';
  else out.sandbox = { available: sandbox.available, engine: optStr(sandbox.engine, 40), version: optStr(sandbox.version, 40), gpu: sandbox.gpu === true };

  return Object.keys(errors).length ? { errors } : { values: out };
}

const EVENT_CHECKS = {
  log: (d) => ['info', 'warn', 'error'].includes(d.level) && str(d.message, 2000) != null,
  metric: (d) => str(d.name, 60) != null && Number.isFinite(d.value) && (d.step == null || int(d.step, 0, 10_000_000) != null),
  stage: (d) => str(d.name, 60) != null && ['started', 'finished', 'skipped', 'failed'].includes(d.status),
  artifact: (d) => str(d.name, 200) != null && /^[0-9a-f]{64}$/.test(d.sha256 ?? '') && int(d.sizeBytes, 0, Number.MAX_SAFE_INTEGER) != null,
};

/** A batch of job events. Each needs a sequence number unique within the attempt, so a retried batch is stored once. */
export function validateEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS_PER_CALL) return { errors: { events: `Send 1 to ${MAX_EVENTS_PER_CALL} events.` } };
  const events = [];
  for (const [i, e] of raw.entries()) {
    if (!isObject(e) || int(e.seq, 0, 10_000_000) == null || !EVENT_KINDS.includes(e.kind) || !isObject(e.data)
      || jsonSize(e.data) > 4096 || !EVENT_CHECKS[e.kind](e.data)) return { errors: { events: `Event ${i + 1} is not valid.` } };
    events.push({ seq: e.seq, kind: e.kind, data: e.data });
  }
  if (new Set(events.map((e) => e.seq)).size !== events.length) return { errors: { events: 'Each event needs its own sequence number.' } };
  return { values: events };
}

/** How a runner ends an attempt. */
export function validateFinish(raw, kind) {
  if (!isObject(raw)) return { errors: { outcome: 'Say how the job ended.' } };
  if (raw.outcome === 'succeeded') {
    const result = projectResult(kind, raw.result);
    if (!result) return { errors: { result: `Send a ${kind ?? 'job'} result with the documented fields and types, under 32 KB.` } };
    return { values: { outcome: 'succeeded', result } };
  }
  if (raw.outcome === 'failed') {
    if (!FAILURES.includes(raw.failure)) return { errors: { failure: 'Use one of the listed failure categories.' } };
    return { values: { outcome: 'failed', failure: raw.failure, retryable: raw.retryable === true } };
  }
  return { errors: { outcome: 'Use succeeded or failed.' } };
}

/**
 * The frozen inputs of a new job. Training, evaluation and export come from an approved (requested) enhance plan
 * whose compute is the workspace's own runner; the plan, its model entry and its dataset list are copied, so later
 * catalog edits never change what the job runs.
 */
export function buildJobSpec({ kind, run, catalog, trainJob = null }) {
  if (!JOB_KINDS.includes(kind)) return { errors: { kind: 'Choose a job type.' } };
  if (kind === 'probe') {
    if (run) return { errors: { enhanceRunId: 'A sandbox check does not use a plan.' } };
    return { values: { checks: ['gpu', 'sandbox', 'ollama'] } };
  }
  if (!run) return { errors: { enhanceRunId: 'Choose an approved enhance plan.' } };
  if (run.status !== 'requested') return { errors: { enhanceRunId: 'Approve this plan before you run it.' } };
  if (run.compute !== 'runner') return { errors: { enhanceRunId: 'This plan is set to run on a GPU provider, not on your runner.' } };
  const baseModel = catalog.find((m) => m.id === run.baseModelId);
  if (!baseModel) return { errors: { enhanceRunId: 'This plan\'s model is no longer in the catalog.' } };
  // Evaluation and export work on one finished training run of this plan, on the same runner that holds its adapter.
  let source = null;
  if (kind !== 'train') {
    const adapter = trainJob?.result?.adapter;
    if (!trainJob || trainJob.status !== 'succeeded' || !/^[0-9a-f]{64}$/.test(adapter?.sha256 ?? '')) return { errors: { trainJobId: 'Choose a finished training run of this plan.' } };
    source = { trainJobId: trainJob.id, adapterSha256: adapter.sha256, adapterLocation: adapter.location ?? null };
  }
  return {
    values: {
      ...(source && { source }),
      enhanceRunId: run.id,
      planVersion: run.updatedAt,
      plan: { name: run.name, steps: [...run.steps], datasets: structuredClone(run.datasets), spendCapUsd: run.spendCapUsd },
      baseModel: structuredClone(baseModel),
    },
  };
}

// --- Successful results, by job kind. A runner is untrusted input: every result is projected onto a bounded,
// typed shape (unknown fields are dropped) and refused if a known field has the wrong type or size.
const HEX = /^[0-9a-f]{64}$/;
const T = {
  num: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  int: (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined),
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  str: (max) => (v) => (typeof v === 'string' && v.length <= max ? v : undefined),
  hex: (v) => (typeof v === 'string' && HEX.test(v) ? v : undefined),
  arr: (item, max) => (v) => {
    if (!Array.isArray(v) || v.length > max) return undefined;
    const out = v.map(item);
    return out.every((x) => x !== undefined) ? out : undefined;
  },
  map: (item, max) => (v) => {
    if (!isObject(v) || Object.keys(v).length > max) return undefined;
    const out = Object.entries(v).map(([k, x]) => [k.slice(0, 200), item(x)]);
    return out.every(([, x]) => x !== undefined) ? Object.fromEntries(out) : undefined;
  },
  // An object: `required` fields must be present and valid; the rest may be absent but, if present, must be valid.
  obj: (fields, required = []) => (v) => {
    if (!isObject(v)) return undefined;
    const out = {};
    for (const [k, check] of Object.entries(fields)) {
      if (v[k] === undefined || v[k] === null) {
        if (required.includes(k)) return undefined;
        continue;
      }
      const x = check(v[k]);
      if (x === undefined) return undefined;
      out[k] = x;
    }
    return out;
  },
};
const scores = T.obj({ f1: T.num, exact: T.num, n: T.int });
const sample = T.obj({ prompt: T.str(600), base: T.str(1000), tuned: T.str(1000) }, ['prompt', 'base', 'tuned']);
const RESULT_SCHEMAS = {
  probe: T.obj({
    hostGpus: T.int, ollamaReachable: T.bool, sandbox: T.bool, network: T.str(40),
    sandboxGpus: T.arr(T.obj({ name: T.str(120), memoryMb: T.int, driver: T.str(40) }, ['name', 'memoryMb']), 16),
  }),
  train: T.obj({
    method: T.str(40), rank: T.int, alpha: T.int, epochs: T.num, steps: T.int,
    trainExamples: T.int, heldOutExamples: T.int, skippedLines: T.int,
    baseHeldOutLoss: T.num, tunedHeldOutLoss: T.num, trainSeconds: T.num, peakGpuMemoryMb: T.int,
    gpus: T.arr(T.str(120), 16),
    evaluation: T.obj({ metric: T.str(200), base: scores, tuned: scores }),
    samples: T.arr(sample, 5),
    baseModel: T.obj({ id: T.str(80), source: T.str(200), revision: T.str(80), weightsSha256: T.map(T.hex, 64), configSha256: T.hex, tokenizerSha256: T.hex }),
    adapter: T.obj({ sha256: T.hex, configSha256: T.hex, sizeBytes: T.int, location: T.str(300) }, ['sha256']),
    splitSha256: T.hex, trainingManifestSha256: T.hex, datasetFiles: T.int,
  }, ['adapter']),
  export: T.obj({
    ollamaModel: T.str(120), manifestSha256: T.hex, trainingManifestSha256: T.hex, baseGgufSha256: T.hex, location: T.str(300),
    gguf: T.obj({ file: T.str(200), sha256: T.hex, sizeBytes: T.int, quantization: T.str(20) }, ['sha256']),
    loadTest: T.obj({
      conversations: T.int, seconds: T.num,
      tuned: T.obj({ model: T.str(120), tokensPerSec: T.num }), base: T.obj({ model: T.str(120), tokensPerSec: T.num }),
    }),
    samples: T.arr(sample, 5),
  }, ['gguf']),
  evaluate: T.obj({ evaluation: T.obj({ metric: T.str(200), base: scores, tuned: scores }), samples: T.arr(sample, 5) }),
};

/** The result to store for a successful job of this kind, or null if it is malformed. */
export function projectResult(kind, raw) {
  const schema = RESULT_SCHEMAS[kind];
  if (!schema || !isObject(raw) || jsonSize(raw) > 32_768) return null;
  return schema(raw) ?? null;
}

/** Canonical JSON (sorted keys) for comparing two requests' immutable inputs. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
