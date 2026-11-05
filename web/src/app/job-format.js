// Reading stored results defensively: the server now validates new results by kind, but older records (and any
// malformed history) must never break the page. Each helper returns a display value or a dash.
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const fix = (v, digits) => (isNum(v) ? v.toFixed(digits) : '—');
export const pct = (v, digits) => (isNum(v) ? `${(v * 100).toFixed(digits)}%` : '—');
export const txt = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '—');
export const list = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export const mb = (v) => (isNum(v) ? `${Math.round(v / 2 ** 20)} MB` : '—');
export const hash = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 16)}…` : '—');
export const when = (iso) => {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// How a job reads, the same on the Compute screen and on a plan's page. Lookups are own-property only, so an odd
// stored value ("constructor") is shown as text rather than resolving to something on Object.prototype.
export const KIND = { probe: 'Sandbox check', train: 'Training', evaluate: 'Evaluation', export: 'Export' };
export const STATUS = { queued: 'Waiting for the runner', leased: 'Starting', running: 'Running', cancel_requested: 'Stopping', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' };
export const TONE = { succeeded: 'tile--green', failed: 'tile--orange', running: 'tile--blue', leased: 'tile--blue', cancel_requested: 'tile--violet' };
export const FINISHED = ['succeeded', 'failed', 'cancelled'];
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
export const kindLabel = (kind) => own(KIND, kind) ?? txt(kind, 40);
export const statusLabel = (status) => own(STATUS, status) ?? txt(status, 40);
export const statusTone = (status) => own(TONE, status) ?? '';

// A runner reports its machine (heartbeat) only between jobs. While it runs one it sends that job's events and lease
// touches, which do not count as a machine report, so a stale report does not show the machine is off: it is "no
// recent report", and the running job's own events are the evidence that it is alive. Disconnected is a decision
// recorded by the server; Online is a report within ONLINE_MS.
export const ONLINE_MS = 90_000;
export const runnerOnline = (r, now = Date.now()) => r.status === 'active' && typeof r.lastSeenAt === 'string' && now - new Date(r.lastSeenAt).getTime() < ONLINE_MS;
export const runnerState = (r, now = Date.now()) => {
  if (r.status === 'revoked') return 'Disconnected';
  if (runnerOnline(r, now)) return 'Online';
  return r.lastSeenAt ? `No recent machine report · last ${when(r.lastSeenAt)}` : 'Waiting for the runner to start';
};
