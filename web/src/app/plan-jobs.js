import { FINISHED, fix, hash, isNum, kindLabel, list, mb, obj, statusLabel, statusTone, txt, when } from './job-format.js';
import { explain } from './job-detail.js';

// The bridge from an approved enhance plan to what has actually run for it. A plan is a frozen record; its execution
// is whatever jobs the workspace holds with exactly its id. Nothing here infers progress: no job means not started.
// Plain JavaScript so Node tests can drive the selection, the formatting and the failed-read paths without a browser.

/** The server lists this many of a workspace's newest jobs (store.listJobs). Older jobs are reachable only by id. */
export const JOB_WINDOW = 50;
/** The Compute page's query key naming the open job detail. */
export const JOB_PARAM = 'job';
// Job ids are UUIDs; this only keeps a link's value from being anything but a path segment. The server decides what exists.
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The listed jobs queued for exactly this plan, in the server's order (newest first). A plan-less job never matches. */
export const planJobs = (jobs, runId) => (typeof runId === 'string' && runId ? list(jobs).filter((j) => obj(j).enhanceRunId === runId) : []);

/** Whether a job list is the workspace's whole history or only its newest window, so absence is never overstated. */
export const jobWindow = (jobs) => {
  const listed = list(jobs).length;
  return { listed, complete: listed < JOB_WINDOW };
};

/** What a plan's jobs say about it: the newest job, the newest training job, the newest successful training and export. */
export function execution(mine) {
  const jobs = list(mine).filter((j) => j && typeof j === 'object');
  const newest = (test) => jobs.find(test) ?? null;
  return {
    jobs,
    latest: jobs[0] ?? null,
    training: newest((j) => j.kind === 'train'),
    trained: newest((j) => j.kind === 'train' && j.status === 'succeeded'),
    exported: newest((j) => j.kind === 'export' && j.status === 'succeeded'),
    live: jobs.some((j) => !FINISHED.includes(j.status)),
  };
}

/** One job as text for a list row. Every field is a bounded string or null, whatever the record holds. */
export function jobRow(j) {
  const job = obj(j);
  const attempt = isNum(job.attempt) && job.attempt > 0 ? `attempt ${job.attempt}${isNum(job.maxAttempts) ? ` of ${job.maxAttempts}` : ''}` : null;
  return { id: typeof job.id === 'string' ? job.id : null, kind: kindLabel(job.kind), status: statusLabel(job.status), tone: statusTone(job.status), queued: when(job.createdAt), attempt };
}

const count = (v) => (isNum(v) ? v.toLocaleString('en-US') : '—');

/** What the runner reported for a successful training job, as label and value text; a dash wherever a value is missing or malformed. */
export function trainingSummary(result) {
  const r = obj(result);
  const adapter = obj(r.adapter);
  return [
    ['Held-out loss, base model', fix(r.baseHeldOutLoss, 4)],
    ['Held-out loss, tuned', fix(r.tunedHeldOutLoss, 4)],
    ['Examples', `${count(r.trainExamples)} trained · ${count(r.heldOutExamples)} held out`],
    ['Training', `${count(r.steps)} steps · ${fix(r.trainSeconds, 1)} s`],
    ['Adapter', `${hash(adapter.sha256)} · ${mb(adapter.sizeBytes)}, on the runner`],
  ];
}

/** What the runner reported for a successful export job, in the same shape. */
export function exportSummary(result) {
  const r = obj(result);
  const gguf = obj(r.gguf);
  const load = obj(r.loadTest);
  return [
    ['Exported to Ollama as', txt(r.ollamaModel, 120)],
    ['GGUF', `${hash(gguf.sha256)} · ${txt(gguf.quantization, 20)} · ${mb(gguf.sizeBytes)}`],
    ['Speed, tuned', `${fix(obj(load.tuned).tokensPerSec, 1)} tok/s`],
    ['Manifest', hash(r.manifestSha256)],
  ];
}

/**
 * The one-line state of a plan and of its fine-tuning step. A listed job speaks for itself. An absence is claimed only
 * as far as the list reaches: with fewer than JOB_WINDOW jobs in the workspace the list is its whole history, otherwise
 * older jobs may exist that are not listed, and nothing is said about them.
 */
export function planState({ checked, error, ex, listed }) {
  if (!checked) return { badge: error ? 'Requested · jobs not checked' : 'Requested · checking jobs…', tone: '', training: error ? 'Unknown' : 'Checking…' };
  const training = ex.training ? statusLabel(ex.training.status) : listed.complete ? 'Not started' : `None in the latest ${JOB_WINDOW}`;
  if (ex.latest) return { badge: `${kindLabel(ex.latest.kind)} · ${statusLabel(ex.latest.status)}`, tone: statusTone(ex.latest.status), training };
  return listed.complete
    ? { badge: 'Requested · no job yet', tone: 'tile--orange', training }
    : { badge: `Requested · none in the latest ${JOB_WINDOW} jobs`, tone: '', training };
}

/** What to say about weights when no successful export is listed; null before the list loads or when an export is shown. */
export function weightsState({ checked, ex, listed }) {
  if (!checked || ex.exported) return null;
  const scope = listed.complete ? '' : ` among the workspace’s latest ${JOB_WINDOW} jobs; older jobs are not listed here`;
  if (ex.trained) return `No successful export${scope || ' yet'}. Export to Ollama is started from the training job’s details on Compute.`;
  return `No weights are known: no training job of this plan has succeeded${scope}.`;
}

// api.jobs throws the failed answer as a Response; anything else is a request that got no answer.
const failure = (err) => explain(err instanceof Response ? { ok: false, status: err.status, data: {} } : null);
// A successful answer must be an object holding a jobs array. Anything else is reported as such, never read as "no
// jobs": a list that was not read cannot support a claim that nothing ran. The payload itself is not echoed.
const isJobList = (data) => data != null && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.jobs);
export const MALFORMED = 'Valcairn answered in an unexpected form, so the job list could not be read. Try again.';

/**
 * Loads a workspace's job list for a plan's page and polls while `live(jobs)` says a job can still change. The state
 * says whether a load is in flight (`pending`), what list is loaded (`jobs`, null until one has been read) and what
 * went wrong (`error`). A failed or malformed read is reported instead of stalling and keeps any list already loaded;
 * `load()` retries, or refreshes by hand. An answer that arrives after `stop()`, or to a call a newer load superseded,
 * is dropped, so a late list never lands on another plan or workspace.
 */
export function createJobsLoader({ fetchJobs, live = () => false, onState, pollMs = 3000, delay = setTimeout, cancel = clearTimeout }) {
  let state = { jobs: null, error: null, pending: false };
  let stopped = false;
  let timer;
  let call = 0;
  const emit = (patch) => { state = { ...state, ...patch }; onState(state); };
  const load = async () => {
    const mine = ++call;
    cancel(timer);
    emit({ pending: true, error: null });
    const outcome = await fetchJobs().then((data) => ({ ok: true, data }), (err) => ({ ok: false, err }));
    if (stopped || mine !== call) return;
    if (!outcome.ok) return emit({ pending: false, error: failure(outcome.err) });
    if (!isJobList(outcome.data)) return emit({ pending: false, error: MALFORMED });
    const { jobs } = outcome.data;
    emit({ pending: false, jobs, error: null });
    if (live(jobs)) timer = delay(load, pollMs);
    return undefined;
  };
  return { load, stop: () => { stopped = true; cancel(timer); } };
}

/** The job a Compute link names: its id when it can be a path segment, `invalid` otherwise. An invalid value is never looked up. */
export function jobParam(params) {
  const raw = params.get(JOB_PARAM);
  if (raw == null) return { id: null, invalid: false };
  return SAFE_ID.test(raw) ? { id: raw, invalid: false } : { id: null, invalid: true };
}
/** The query that opens this job's detail, or clears it. */
export const jobSearch = (id) => (id ? { [JOB_PARAM]: id } : {});
/** A plan page's link to one job's detail on Compute. */
export const computeJobPath = (slug, id) => `/w/${slug}/compute?${JOB_PARAM}=${encodeURIComponent(String(id))}`;
