import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_WINDOW, MALFORMED, computeJobPath, createJobsLoader, execution, exportSummary, jobParam, jobRow, jobSearch, jobWindow, planJobs, planState, trainingSummary, weightsState } from '../web/src/app/plan-jobs.js';
import { kindLabel, runnerOnline, runnerState, statusLabel, statusTone, when } from '../web/src/app/job-format.js';

// The bridge from an approved enhance plan to the workspace's real job records: only exact matches count, the
// 50-job window is never read as all-time history, malformed stored values become dashes, and a failed or late
// read is reported rather than shown as "nothing ran". These drive the plain-JavaScript half of models.jsx and compute.jsx.

const PLAN = 'f0e1d2c3-0000-4000-8000-000000000001';
const OTHER = 'f0e1d2c3-0000-4000-8000-000000000002';
const HEX = 'a'.repeat(64);
const job = (id, extra) => ({ id, workspaceId: 'ws', runnerId: 'r1', enhanceRunId: PLAN, kind: 'train', status: 'queued', attempt: 0, maxAttempts: 3, result: null, createdAt: '2026-11-04T10:00:00.000Z', ...extra });

test('planJobs keeps exactly the jobs of one plan, in the server’s order, and never a plan-less or look-alike row', () => {
  const jobs = [
    job('e2', { kind: 'export', status: 'failed' }),
    job('x1', { enhanceRunId: `${PLAN}0` }),
    job('p1', { enhanceRunId: null, kind: 'probe', status: 'succeeded' }),
    job('o1', { enhanceRunId: OTHER, status: 'running' }),
    job('t1', { status: 'succeeded' }),
    'not a job', null, 7, { enhanceRunId: [PLAN] }, { enhanceRunId: { toString: () => PLAN } },
  ];
  assert.deepEqual(planJobs(jobs, PLAN).map((j) => j.id), ['e2', 't1'], 'exact id match only, newest first as listed');
  assert.deepEqual(planJobs(jobs, OTHER).map((j) => j.id), ['o1']);
  assert.deepEqual(planJobs(jobs, null), [], 'a probe with no plan never matches a missing plan id');
  assert.deepEqual(planJobs(jobs, undefined), []);
  assert.deepEqual(planJobs(jobs, ''), []);
  assert.deepEqual(planJobs({ jobs }, PLAN), [], 'anything but an array is an empty list');
  assert.deepEqual(planJobs(null, PLAN), []);
});

test('execution picks the newest job, the newest training job and the newest successful training and export; live while one is unfinished', () => {
  const ex = execution([
    job('e2', { kind: 'export', status: 'failed' }),
    job('t3', { status: 'running' }),
    job('e1', { kind: 'export', status: 'succeeded' }),
    job('t2', { status: 'succeeded' }),
    job('t1', { status: 'succeeded' }),
    job('p0', { kind: 'probe', status: 'succeeded' }),
  ]);
  assert.deepEqual([ex.latest.id, ex.training.id, ex.trained.id, ex.exported.id, ex.live, ex.jobs.length], ['e2', 't3', 't2', 'e1', true, 6]);
  const done = execution([job('t1', { status: 'failed' }), job('e1', { kind: 'export', status: 'cancelled' })]);
  assert.deepEqual([done.latest.id, done.training.id, done.trained, done.exported, done.live], ['t1', 't1', null, null, false], 'a failed training is the newest training but not a trained one');
  assert.deepEqual(execution([]), { jobs: [], latest: null, training: null, trained: null, exported: null, live: false });
  assert.deepEqual(execution(null).jobs, []);
  assert.equal(execution([null, 'x', job('t9', { status: 'leased' })]).live, true, 'non-objects are skipped, a leased job is live');
});

test('jobWindow says whether the list is the whole history or only the newest window', () => {
  const n = (count) => Array.from({ length: count }, (_, i) => job(`j${i}`));
  assert.deepEqual(jobWindow([]), { listed: 0, complete: true });
  assert.deepEqual(jobWindow(n(JOB_WINDOW - 1)), { listed: 49, complete: true });
  assert.deepEqual(jobWindow(n(JOB_WINDOW)), { listed: 50, complete: false }, 'a full page may hide older jobs');
  assert.deepEqual(jobWindow(n(JOB_WINDOW + 3)), { listed: 53, complete: false });
  assert.deepEqual(jobWindow(null), { listed: 0, complete: true });
});

test('training and export summaries are plain bounded text from a real result, and dashes from a malformed one', () => {
  const good = trainingSummary({ baseHeldOutLoss: 2.34567, tunedHeldOutLoss: 1.2, trainExamples: 1234, heldOutExamples: 137, steps: 400, trainSeconds: 95.25, adapter: { sha256: HEX, sizeBytes: 3 * 2 ** 20 } });
  assert.deepEqual(good, [
    ['Held-out loss, base model', '2.3457'], ['Held-out loss, tuned', '1.2000'], ['Examples', '1,234 trained · 137 held out'],
    ['Training', '400 steps · 95.3 s'], ['Adapter', `${'a'.repeat(16)}… · 3 MB, on the runner`],
  ]);
  const exported = exportSummary({ ollamaModel: 'acme/support:tuned', manifestSha256: HEX, gguf: { sha256: HEX, quantization: 'Q4_K_M', sizeBytes: 2 ** 30 }, loadTest: { tuned: { tokensPerSec: 41.26 }, base: { tokensPerSec: 50 } } });
  assert.deepEqual(exported, [['Exported to Ollama as', 'acme/support:tuned'], ['GGUF', `${'a'.repeat(16)}… · Q4_K_M · 1024 MB`], ['Speed, tuned', '41.3 tok/s'], ['Manifest', `${'a'.repeat(16)}…`]]);

  const malformed = {
    baseHeldOutLoss: '0.9', tunedHeldOutLoss: Number.NaN, trainExamples: { n: 1 }, heldOutExamples: [5], steps: Number.POSITIVE_INFINITY, trainSeconds: null,
    adapter: 'sha256:deadbeef', gpus: 'x', ollamaModel: { name: 'x' }, manifestSha256: 'Z'.repeat(64), gguf: [HEX], loadTest: { tuned: 'fast' },
  };
  const leaks = /\[object Object\]|NaN|Infinity|undefined|null|<|>/;
  for (const rows of [trainingSummary(malformed), exportSummary(malformed), trainingSummary(null), exportSummary('x'), trainingSummary([1]), exportSummary(undefined)]) {
    for (const [label, value] of rows) {
      assert.equal(typeof label, 'string');
      assert.equal(typeof value, 'string', `${label} is text`);
      assert.doesNotMatch(value, leaks, `${label}: ${value}`);
    }
  }
  assert.deepEqual(trainingSummary(malformed).map(([, v]) => v), ['—', '—', '— trained · — held out', '— steps · — s', '— · —, on the runner']);
  assert.deepEqual(exportSummary(malformed).map(([, v]) => v), ['—', '— · — · —', '— tok/s', '—']);
  assert.equal(exportSummary({ ollamaModel: `<b>${'m'.repeat(500)}</b>`, gguf: { quantization: 'q'.repeat(100) } })[0][1].length, 120, 'long text is cut, and stays text for React to escape');
  assert.equal(exportSummary({ gguf: { quantization: 'q'.repeat(100) } })[1][1], `— · ${'q'.repeat(20)} · —`);
});

test('planState and weightsState claim an absence only as far as the listed window reaches', () => {
  const whole = { listed: 7, complete: true };
  const full = { listed: JOB_WINDOW, complete: false };
  const none = execution([]);
  assert.deepEqual(planState({ checked: false, error: null, ex: none, listed: jobWindow(null) }), { badge: 'Requested · checking jobs…', tone: '', training: 'Checking…' });
  assert.deepEqual(planState({ checked: false, error: 'HTTP 500', ex: none, listed: jobWindow(null) }), { badge: 'Requested · jobs not checked', tone: '', training: 'Unknown' }, 'a failed read claims nothing either way');
  assert.deepEqual(planState({ checked: true, error: null, ex: none, listed: whole }), { badge: 'Requested · no job yet', tone: 'tile--orange', training: 'Not started' }, 'under 50 jobs the list is the whole history');
  assert.deepEqual(planState({ checked: true, error: null, ex: none, listed: full }), { badge: 'Requested · none in the latest 50 jobs', tone: '', training: 'None in the latest 50' }, 'a full window cannot prove the plan never ran');

  const exportOnly = execution([job('e1', { kind: 'export', status: 'succeeded' })]);
  assert.deepEqual(planState({ checked: true, error: null, ex: exportOnly, listed: full }), { badge: 'Export · Succeeded', tone: 'tile--green', training: 'None in the latest 50' }, 'a listed job speaks for itself; the missing training is only missing from the window');
  assert.equal(planState({ checked: true, error: null, ex: exportOnly, listed: whole }).training, 'Not started');
  const running = execution([job('t1', { status: 'running' })]);
  assert.deepEqual(planState({ checked: true, error: 'HTTP 502', ex: running, listed: whole }), { badge: 'Training · Running', tone: 'tile--blue', training: 'Running' }, 'the last loaded list stands while a refresh failed');

  assert.equal(weightsState({ checked: false, ex: none, listed: jobWindow(null) }), null, 'nothing is said before the list loads');
  assert.equal(weightsState({ checked: true, ex: exportOnly, listed: full }), null, 'the export record is shown instead');
  assert.equal(weightsState({ checked: true, ex: none, listed: whole }), 'No weights are known: no training job of this plan has succeeded.');
  assert.equal(weightsState({ checked: true, ex: none, listed: full }), 'No weights are known: no training job of this plan has succeeded among the workspace’s latest 50 jobs; older jobs are not listed here.');
  const trainedOnly = execution([job('t1', { status: 'succeeded' })]);
  assert.equal(weightsState({ checked: true, ex: trainedOnly, listed: whole }), 'No successful export yet. Export to Ollama is started from the training job’s details on Compute.');
  assert.equal(weightsState({ checked: true, ex: trainedOnly, listed: full }), 'No successful export among the workspace’s latest 50 jobs; older jobs are not listed here. Export to Ollama is started from the training job’s details on Compute.');
});

test('runnerState: Disconnected and a recent Online report keep their meaning; a stale report is "no recent machine report", not Offline', () => {
  // What root saw: an export still writing events at 22:25:04 while the machine last reported at 22:23:44; once that
  // report is over 90 s old the card used to say Offline, although the job's own events showed the runner alive.
  const now = Date.parse('2026-11-04T22:25:30.000Z');
  const seen = (ms) => new Date(now - ms).toISOString();
  assert.equal(runnerState({ status: 'revoked', lastSeenAt: seen(1000) }, now), 'Disconnected', 'a recorded disconnect wins over a fresh report');
  assert.equal(runnerState({ status: 'active', lastSeenAt: seen(89_000) }, now), 'Online');
  assert.equal(runnerOnline({ status: 'active', lastSeenAt: seen(90_000) }, now), false, 'the 90 s window is exclusive');
  assert.equal(runnerState({ status: 'active', lastSeenAt: '2026-11-04T22:23:44.000Z' }, Date.parse('2026-11-04T22:25:04.000Z')), 'Online', 'at 22:25:04 the report was 80 s old, still within the window');
  const stale = runnerState({ status: 'active', lastSeenAt: '2026-11-04T22:23:44.000Z' }, now);
  assert.match(stale, /^No recent machine report · last /);
  assert.doesNotMatch(stale, /Offline|Online|busy|running/i, 'neither off nor busy is claimed from an old report');
  assert.equal(runnerState({ status: 'active', lastSeenAt: null }, now), 'Waiting for the runner to start');
  assert.equal(runnerState({ status: 'active', lastSeenAt: 'garbage' }, now), 'No recent machine report · last —');
  assert.equal(runnerOnline({ status: 'revoked', lastSeenAt: seen(0) }, now), false);
  assert.equal(runnerOnline({ status: 'active', lastSeenAt: 12345 }, now), false, 'only a timestamp string counts as a report');
});

test('jobRow and the shared labels turn any stored job into bounded text, with own-property lookups only', () => {
  const row = jobRow(job('j1', { status: 'running', attempt: 1 }));
  assert.deepEqual([row.id, row.kind, row.status, row.tone, row.attempt], ['j1', 'Training', 'Running', 'tile--blue', 'attempt 1 of 3']);
  assert.notEqual(row.queued, '—', 'a real timestamp is shown');
  assert.deepEqual(jobRow(job('j2', { kind: 'export', status: 'succeeded', attempt: 0 })).attempt, null, 'no attempt before a runner took it');
  assert.deepEqual(jobRow(job('j3', { attempt: 2, maxAttempts: 'three' })).attempt, 'attempt 2');

  const odd = jobRow({ id: 5, kind: { x: 1 }, status: 'constructor', createdAt: 'yesterday', attempt: '2', maxAttempts: 3 });
  assert.deepEqual(odd, { id: null, kind: '—', status: 'constructor', tone: '', queued: '—', attempt: null });
  assert.deepEqual(jobRow(null), { id: null, kind: '—', status: '—', tone: '', queued: '—', attempt: null });
  assert.equal(typeof kindLabel('constructor'), 'string');
  assert.equal(kindLabel('__proto__'), '__proto__');
  assert.equal(statusLabel('hasOwnProperty'), 'hasOwnProperty');
  assert.equal(statusTone('toString'), '');
  assert.equal(kindLabel('k'.repeat(100)).length, 40, 'an unknown kind is shown as bounded text');
  assert.deepEqual([when(undefined), when(null), when(1_700_000_000_000), when('not a date')], ['—', '—', '—', '—']);
  assert.notEqual(when('2026-11-04T10:00:00.000Z'), '—');
});

// A loader with a fake clock: the one timer it may hold is run by hand, so polls happen when the test says.
function harness(answers, live = (jobs) => jobs.some((j) => j.status === 'running')) {
  const states = [];
  let calls = 0;
  let timer = null;
  const loader = createJobsLoader({
    fetchJobs: async () => {
      calls += 1;
      const next = answers.shift();
      if (next instanceof Error || next instanceof Response) throw next;
      return typeof next === 'function' ? next() : next;
    },
    live,
    onState: (s) => states.push(s),
    delay: (fn, ms) => { timer = { fn, ms }; return 1; },
    cancel: () => { timer = null; },
  });
  return { loader, states, calls: () => calls, last: () => states.at(-1), scheduled: () => timer?.ms ?? null, fire: () => { const t = timer; timer = null; return t.fn(); } };
}
const refused = (status) => new Response('refused', { status });

test('a refused or unanswered job read is reported with no list, nothing is scheduled on its own, and Retry loads it', async () => {
  const h = harness([refused(500), { jobs: [job('t1', { status: 'succeeded' })] }]);
  await h.loader.load();
  assert.deepEqual([h.last().jobs, h.last().error, h.scheduled()], [null, 'Valcairn answered with an error (HTTP 500). Try again.', null], 'no list means nothing is claimed about the plan');
  await h.loader.load();
  assert.deepEqual([h.calls(), h.last().jobs.map((j) => j.id), h.last().error, h.scheduled()], [2, ['t1'], null, null], 'loaded, error cleared, finished list not polled');

  const offline = harness([new Error('offline')]);
  await offline.loader.load();
  assert.equal(offline.last().error, 'Valcairn could not be reached.');
  const ended = harness([refused(401)]);
  await ended.loader.load();
  assert.equal(ended.last().error, 'Your session has ended. Sign in again.');
  const denied = harness([refused(403)]);
  await denied.loader.load();
  assert.equal(denied.last().error, 'You no longer have permission to do this.');
});

test('a malformed successful answer is a visible error, never an empty list: no claim on first load, a loaded list is kept, Retry recovers', async () => {
  const good = () => ({ jobs: [job('t1', { status: 'running' })] });
  const shapes = [['a string where the list should be', { jobs: 'not a list' }], ['a null body', null], ['an array body', []], ['a body without jobs', {}], ['a text body', 'not an object'], ['a null list', { jobs: null }]];
  const h = harness([...shapes.map(([, body]) => body), good(), { jobs: { length: 1 } }, good()]);
  for (const [shape] of shapes) {
    await h.loader.load();
    assert.deepEqual([h.last().jobs, h.last().error, h.last().pending, h.scheduled()], [null, MALFORMED, false, null], `${shape}: no list, one bounded message, nothing scheduled`);
    const claim = planState({ checked: h.last().jobs !== null, error: h.last().error, ex: execution(planJobs(h.last().jobs, PLAN)), listed: jobWindow(h.last().jobs) });
    assert.deepEqual([claim.badge, claim.training], ['Requested · jobs not checked', 'Unknown'], `${shape}: no absence claim can follow`);
    assert.equal(weightsState({ checked: h.last().jobs !== null, ex: execution([]), listed: jobWindow(h.last().jobs) }), null);
  }
  assert.doesNotMatch(h.last().error, /not a list|not an object|undefined|null|\{|\[/, 'the payload is not echoed');
  await h.loader.load();
  assert.deepEqual([h.last().jobs.map((j) => j.id), h.last().error, h.scheduled()], [['t1'], null, 3000], 'Retry reads a proper list and polls the live job');
  await h.fire();
  assert.deepEqual([h.last().jobs.map((j) => j.id), h.last().error, h.last().pending, h.scheduled()], [['t1'], MALFORMED, false, null], 'a malformed refresh keeps the loaded list with the reason and does not poll blindly');
  await h.loader.load();
  assert.deepEqual([h.last().jobs.map((j) => j.id), h.last().error, h.scheduled()], [['t1'], null, 3000], 'Retry recovers again');
  assert.equal(h.calls(), shapes.length + 3);
});

test('pending marks a load in flight, so a Refresh control can wait for it, and clears either way', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness([() => slow, refused(500)]);
  const first = h.loader.load();
  assert.deepEqual([h.last().pending, h.last().jobs, h.last().error], [true, null, null], 'marked before the answer');
  release({ jobs: [job('t1', { status: 'succeeded' })] });
  await first;
  assert.deepEqual([h.last().pending, h.last().jobs.length], [false, 1]);
  const second = h.loader.load();
  assert.deepEqual([h.last().pending, h.last().jobs.length, h.last().error], [true, 1, null], 'the loaded list stays while a refresh is in flight');
  await second;
  assert.deepEqual([h.last().pending, h.last().jobs.length, h.last().error], [false, 1, 'Valcairn answered with an error (HTTP 500). Try again.'], 'a failed refresh clears pending and keeps the list');
});

test('a live list is polled; a failed refresh keeps the last list with the reason; Retry resumes; a finished list stops', async () => {
  const h = harness([{ jobs: [job('t1', { status: 'running' })] }, refused(502), { jobs: [job('t1', { status: 'running' })] }, { jobs: [job('t1', { status: 'succeeded' })] }]);
  await h.loader.load();
  assert.deepEqual([h.last().jobs[0].status, h.scheduled()], ['running', 3000], 'polls while a job of the plan runs');
  await h.fire();
  assert.deepEqual([h.last().jobs[0].status, h.last().error, h.scheduled()], ['running', 'Valcairn answered with an error (HTTP 502). Try again.', null], 'the last good list stays, polling does not continue blindly');
  await h.loader.load();
  assert.deepEqual([h.last().error, h.scheduled()], [null, 3000], 'polling resumed');
  await h.fire();
  assert.deepEqual([h.last().jobs[0].status, h.scheduled(), h.calls()], ['succeeded', null, 4], 'a finished plan stops polling');
});

test('a late list never lands, good or malformed: not after stop, and not from a call that a newer load superseded', async () => {
  for (const late of [{ jobs: [job('old')] }, { jobs: 'late and malformed' }]) {
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const stopped = harness([() => slow]);
    const pending = stopped.loader.load();
    const marked = stopped.states.length;
    stopped.loader.stop();
    release(late);
    await pending;
    assert.deepEqual([stopped.states.length, stopped.scheduled()], [marked, null], 'nothing reported for a plan or workspace no longer shown');
  }

  for (const late of [{ jobs: [job('stale', { status: 'running' })] }, 'not an object']) {
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const h = harness([() => first, { jobs: [job('new', { status: 'succeeded' })] }]);
    const earlier = h.loader.load();
    await h.loader.load();
    const reported = h.states.length;
    releaseFirst(late);
    await earlier;
    assert.deepEqual([h.states.length, h.last().jobs.map((j) => j.id), h.last().error, h.scheduled()], [reported, ['new'], null, null], 'the superseded answer changes nothing and schedules no poll');
  }
});

test('a Compute link names one job in ?job=; only a path-safe id is looked up, and the link round-trips', () => {
  const id = 'f0e1d2c3-0000-4000-8000-000000000009';
  assert.deepEqual(jobParam(new URLSearchParams('')), { id: null, invalid: false });
  assert.deepEqual(jobParam(new URLSearchParams({ job: id })), { id, invalid: false });
  assert.deepEqual(jobParam(new URLSearchParams('job=')), { id: null, invalid: true });
  assert.deepEqual(jobParam(new URLSearchParams('job=..%2Frunners')), { id: null, invalid: true }, 'a value that is not a path segment is refused before any request');
  assert.deepEqual(jobParam(new URLSearchParams('job=x%3Fafter%3D0')), { id: null, invalid: true });
  assert.deepEqual(jobParam(new URLSearchParams(`job=${'a'.repeat(101)}`)), { id: null, invalid: true });
  assert.deepEqual(jobParam(new URLSearchParams('job=abc&job=def')), { id: 'abc', invalid: false }, 'the first value, as the browser would use it');
  assert.deepEqual(jobSearch(id), { job: id });
  assert.deepEqual(jobSearch(null), {}, 'closing clears the query');
  assert.equal(computeJobPath('acme', id), `/w/acme/compute?job=${id}`);
  assert.equal(computeJobPath('acme', 'a/b?c'), '/w/acme/compute?job=a%2Fb%3Fc', 'an odd id cannot change the path');
  const back = jobParam(new URL(computeJobPath('acme', id), 'https://valcairn.test').searchParams);
  assert.deepEqual(back, { id, invalid: false });
  assert.deepEqual(jobParam(new URL(computeJobPath('acme', 'a/b?c'), 'https://valcairn.test').searchParams), { id: null, invalid: true });
});
