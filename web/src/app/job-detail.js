import { list, obj } from './job-format.js';

// Recovery for the Compute screen: what to say when a request fails, and a job-detail loader that reports a failure
// instead of stalling. Plain JavaScript so Node tests can drive the failed-request paths without a browser.

/**
 * What to tell a person when a request did not go through: the server's own message when it sent one, otherwise
 * what the status says. `null` is a request that never got an answer (network, timeout), whose outcome is unknown.
 */
export function explain(res, unknown = 'Valcairn could not be reached.') {
  if (!res) return unknown;
  const data = obj(res.data);
  const text = Object.values(obj(data.errors))[0] ?? data.error;
  if (typeof text === 'string' && text) return text;
  if (res.status === 401) return 'Your session has ended. Sign in again.';
  if (res.status === 403) return 'You no longer have permission to do this.';
  return `Valcairn answered with an error (HTTP ${res.status}). Try again.`;
}

/**
 * One attempt at an action. A rejected call got no answer, so its outcome is unknown and `unknown` must say so; an
 * error answer is explained. Nothing is retried here: the person decides, with the current state in front of them.
 */
export async function attempt(call, unknown) {
  const res = await call().catch(() => null);
  return res?.ok ? { ok: true, res } : { ok: false, res, error: explain(res, unknown) };
}

/**
 * Loads a job and every page of its events, polls while it runs, and reports a failure instead of stalling. The
 * state always says what is loaded (`job`, `events`), whether pages remain (`more`) and what went wrong (`error`).
 * `load()` starts or retries: it resumes after the last event already loaded, so nothing is repeated or lost, and an
 * answer to an earlier call, or one that arrives after `stop()`, is ignored, so a late page never lands elsewhere.
 */
export function createDetailLoader({ fetchPage, finished, onState, pollMs = 2000, delay = setTimeout, cancel = clearTimeout }) {
  let state = { job: null, events: [], more: true, error: null };
  let after = 0;
  let stopped = false;
  let timer;
  let call = 0;
  const emit = (patch) => { state = { ...state, ...patch }; onState(state); };
  const load = async () => {
    const mine = ++call;
    cancel(timer);
    if (state.error) emit({ error: null });
    const res = await fetchPage(after).catch(() => null);
    if (stopped || mine !== call) return;
    if (!res?.ok) return emit({ error: explain(res) });
    const page = list(res.data.events);
    const events = page.length ? [...state.events, ...page.filter((e) => !state.events.some((p) => p.id === e.id))] : state.events;
    if (page.length) after = page.at(-1).id;
    const more = Boolean(res.data.more);
    emit({ job: res.data.job, events, more });
    if (more) timer = delay(load, 0);
    else if (!finished(res.data.job)) timer = delay(load, pollMs);
    return undefined;
  };
  return { load, stop: () => { stopped = true; cancel(timer); } };
}
