// State of the live overview on /demo/review: what is shown, and how honest the label on it has to be.
// Kept apart from the component so the refresh rules can be tested without a browser.

export const UNAVAILABLE_CODES = ['store_unavailable', 'demo_unconfigured', 'demo_workspace_missing', 'demo_workspace_not_synthetic'];

export const initialOverviewState = { status: 'loading', overview: null, fetchedAt: null, problem: null };

/**
 * One step of the overview's state. Events are `{ type: 'load' }` when a fetch starts, `{ type: 'result', result, at }`
 * with the api.demoOverview() response (`{ ok, status, data }`), or `{ type: 'failed', at }` when the request itself
 * failed. The last good overview is kept when a refresh fails and the state becomes `stale`, so records never
 * disappear silently and an error is never dressed up as data. A 503 naming an unavailable reason replaces any
 * earlier data: the server says there is nothing to show, and showing old records would contradict it.
 */
export function reduceOverview(state, event) {
  switch (event.type) {
    case 'load':
      return { ...state, status: state.overview ? 'refreshing' : 'loading' };
    case 'failed':
      return failed(state, { code: 'network', message: 'The overview could not be reached. Check your connection and refresh.', status: null });
    case 'result': {
      const { result, at } = event;
      if (result.ok) return { status: 'ready', overview: result.data, fetchedAt: at, problem: null };
      if (result.status === 401) return { status: 'signed_out', overview: null, fetchedAt: state.fetchedAt, problem: { code: 'signed_out', message: 'Your reviewer session has ended.', status: 401 } };
      const code = typeof result.data?.code === 'string' ? result.data.code : null;
      const problem = { code, message: result.data?.error ?? 'The overview could not be loaded.', status: result.status };
      if (result.status === 503 && UNAVAILABLE_CODES.includes(code)) return { status: 'unavailable', overview: null, fetchedAt: at, problem };
      return failed(state, problem);
    }
    default:
      return state;
  }
}

const failed = (state, problem) => (state.overview
  ? { ...state, status: 'stale', problem }
  : { status: 'error', overview: null, fetchedAt: state.fetchedAt, problem });

/**
 * The requests of one mounted dashboard. Only the newest request's completion is applied, so a slow older response,
 * an older 401 included, can never overwrite a newer one; nothing is applied after `stop()` (unmount, including the
 * rehearsal mount React StrictMode performs in development). `fetch` is api.demoOverview; `apply` receives the
 * reducer events above; `at` on each result is the time the response arrived, so "fetched at" stays truthful.
 */
export function createOverviewLoader({ fetch, apply, now = () => new Date().toISOString() }) {
  let latest = 0;
  let live = true;
  return {
    async load() {
      if (!live) return;
      const id = ++latest;
      apply({ type: 'load' });
      let event;
      try { event = { type: 'result', result: await fetch(), at: now() }; }
      catch { event = { type: 'failed', at: now() }; }
      if (live && id === latest) apply(event);
    },
    stop() { live = false; },
  };
}

// Capital planning totals as the API returns them: whole US cents grouped by basis (quoted, estimated, incurred) and
// period (one_time, monthly, annual), from totalsByBasis in src/lib/capital.js. Each line keeps its own basis and
// period. A one-time amount is never added to a monthly or an annual one: they are not the same kind of number.
const PERIOD_LABEL = { one_time: 'one-time', monthly: 'per month', annual: 'per year' };
export const formatCents = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function costTotalLines(totals) {
  const lines = [];
  for (const [basis, byPeriod] of Object.entries(totals ?? {})) {
    for (const [period, cents] of Object.entries(byPeriod ?? {})) {
      if (!Number.isSafeInteger(cents) || cents <= 0) continue;
      lines.push({ basis, period, cents, label: `${basis} ${formatCents(cents)} ${PERIOD_LABEL[period] ?? period.replaceAll('_', ' ')}` });
    }
  }
  return lines;
}
