import { browserHints, RuntimeError } from './runtime.js';

/** One connection check at a time. Only metadata reads have a deadline; chat, tests and downloads keep their own
 * signals. Cancel on unmount/disconnect. A later load or cancellation makes every earlier result stale, including
 * any persistence work the caller is waiting on. Cancellation is reusable for React's effect setup/cleanup replay. */
export function createConnectionProbe(runtime, onSnapshot, { timeoutMs = 10000, hintTimeoutMs = 1500 } = {}) {
  let active = null;
  const cancel = () => { const previous = active; active = null; previous?.abort(); };
  async function load() {
    cancel();
    const controller = new AbortController();
    active = controller;
    const current = () => active === controller;
    onSnapshot({ checking: true });
    // Start runtime reads now; optional GPU discovery must not delay asking the local runtime.
    const hints = browserHints({ timeoutMs: hintTimeoutMs });
    let timer;
    let abort;
    let timedOut = false;
    let snapshot;
    try {
      const deadline = new Promise((_, reject) => {
        abort = () => reject(new RuntimeError(timedOut ? 'timeout' : 'aborted', timedOut ? 'The connection check timed out.' : 'Stopped.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      });
      const signal = controller.signal;
      const [version, models, running] = await Promise.race([
        Promise.all([runtime.version({ signal }), runtime.models({ signal }), runtime.running({ signal })]),
        deadline,
      ]);
      snapshot = { status: 'connected', version, models, running };
    } catch (error) {
      snapshot = { status: 'unreachable', error };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      controller.abort(); // close any remaining metadata read after one failed, including its response body
    }
    snapshot = { ...snapshot, checking: false, hints: await hints, checkedAt: new Date().toISOString() };
    if (!current()) return null;
    onSnapshot(snapshot);
    return { snapshot, current };
  }
  return { load, cancel };
}
