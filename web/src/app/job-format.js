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
