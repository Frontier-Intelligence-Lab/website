import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attempt, createDetailLoader, explain } from '../web/src/app/job-detail.js';

// Regressions for the PR29 independent review: a failed action or read on the Compute screen must be reported
// and recoverable, never swallowed. These drive the screen's recovery logic with controlled failed answers.

const FINISHED = ['succeeded', 'failed', 'cancelled'];
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const page = (eventIds, { status = 'running', more = false } = {}) => ({ ok: true, status: 200, data: { job: { id: 'j1', status }, events: eventIds.map((id) => ({ id, kind: 'log', data: { level: 'info', message: `e${id}` } })), more } });
const refused = (status, data = {}) => ({ ok: false, status, data });

// A loader with a fake clock: the one timer it may hold is run by hand, so pages and polls happen when the test says.
function harness(answers) {
  const calls = [];
  const states = [];
  let timer = null;
  const loader = createDetailLoader({
    fetchPage: async (after) => {
      calls.push(after);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(after) : next;
    },
    finished: (j) => FINISHED.includes(j?.status),
    onState: (s) => states.push(s),
    delay: (fn, ms) => { timer = { fn, ms }; return 1; },
    cancel: () => { timer = null; },
  });
  return { loader, calls, states, last: () => states.at(-1), scheduled: () => timer?.ms ?? null, fire: () => { const t = timer; timer = null; return t.fn(); } };
}

test('a failed first request shows an error with Retry instead of loading forever, and Retry loads the job', async () => {
  const h = harness([refused(500), page([1, 2], { status: 'succeeded' })]);
  await h.loader.load();
  assert.deepEqual([h.last().job, h.last().error, h.last().more, h.scheduled()], [null, 'Valcairn answered with an error (HTTP 500). Try again.', true, null], 'reported, nothing scheduled on its own');
  await h.loader.load();
  assert.deepEqual([h.calls, h.last().job.status, h.last().events.map((e) => e.id), h.last().error, h.last().more, h.scheduled()], [[0, 0], 'succeeded', [1, 2], null, false, null], 'retry starts from the beginning and the error is cleared');
});

test('a failure between pages keeps what was loaded, says it is incomplete, and Retry resumes after the last event', async () => {
  const h = harness([page(ids(1, 500), { status: 'succeeded', more: true }), new Error('offline'), page(ids(501, 550), { status: 'succeeded' })]);
  await h.loader.load();
  assert.deepEqual([h.last().events.length, h.last().more, h.scheduled()], [500, true, 0], 'the next page is due at once');
  await h.fire();
  assert.deepEqual([h.last().job.status, h.last().events.length, h.last().more, h.last().error, h.scheduled()], ['succeeded', 500, true, 'Valcairn could not be reached.', null], 'loaded events stay, marked incomplete');
  await h.loader.load();
  assert.deepEqual([h.calls, h.last().events.length, h.last().more, h.last().error], [[0, 500, 500], 550, false, null], 'resumed after event 500; nothing repeated or lost');
  assert.equal(new Set(h.last().events.map((e) => e.id)).size, 550);
});

test('a live job keeps polling; a failed poll is reported, Retry resumes polling, and an overlapping page adds no duplicate rows', async () => {
  const h = harness([page([1], { status: 'running' }), refused(401), page([1, 2], { status: 'running' }), page([2, 3], { status: 'succeeded' })]);
  await h.loader.load();
  assert.equal(h.scheduled(), 2000, 'polls while the job runs');
  await h.fire();
  assert.deepEqual([h.last().job.status, h.last().events.length, h.last().error, h.scheduled()], ['running', 1, 'Your session has ended. Sign in again.', null], 'the last good state stays with the reason; polling does not continue blindly');
  await h.loader.load();
  assert.deepEqual([h.last().events.map((e) => e.id), h.last().error, h.scheduled()], [[1, 2], null, 2000], 'overlap deduplicated, polling resumed');
  await h.fire();
  assert.deepEqual([h.last().events.map((e) => e.id), h.last().job.status, h.last().more, h.scheduled()], [[1, 2, 3], 'succeeded', false, null], 'a finished job stops polling');
  assert.deepEqual(h.calls, [0, 1, 1, 2], 'each call asks for events after the last one loaded');
});

test('a late answer never lands: not after stop, and not from a call that a newer load superseded', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const stopped = harness([() => slow]);
  const pending = stopped.loader.load();
  stopped.loader.stop();
  release(page([9], { status: 'running' }));
  await pending;
  assert.deepEqual([stopped.states.length, stopped.scheduled()], [0, null], 'nothing reported, nothing scheduled after stop');

  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const h = harness([() => first, page([1], { status: 'succeeded' })]);
  const earlier = h.loader.load();
  await h.loader.load();
  const reported = h.states.length;
  releaseFirst(page([7, 8], { status: 'running' }));
  await earlier;
  assert.deepEqual([h.states.length, h.last().events.map((e) => e.id), h.last().job.status, h.scheduled()], [reported, [1], 'succeeded', null], 'the superseded answer changes nothing');
  assert.deepEqual(h.calls, [0, 0], 'the newer load re-asked from the same point, so no page was lost');
});

test('explain and attempt: the server’s message when there is one, otherwise a truthful status; no answer means an unknown outcome', async () => {
  assert.equal(explain(null), 'Valcairn could not be reached.');
  assert.equal(explain(null, 'It is not known whether it went through.'), 'It is not known whether it went through.');
  assert.equal(explain(refused(409, { error: 'This is not possible in the current state.' })), 'This is not possible in the current state.');
  assert.equal(explain(refused(400, { errors: { runnerId: 'Choose a runner linked to this workspace.' } })), 'Choose a runner linked to this workspace.');
  assert.equal(explain(refused(401)), 'Your session has ended. Sign in again.');
  assert.equal(explain(refused(403)), 'You no longer have permission to do this.');
  assert.equal(explain({ ok: false, status: 502, data: 'not json' }), 'Valcairn answered with an error (HTTP 502). Try again.');

  const unknown = 'It is not known whether the runner was disconnected.';
  assert.deepEqual(await attempt(() => Promise.reject(new Error('offline')), unknown), { ok: false, res: null, error: unknown }, 'a rejected call is reported as unknown, not as failed');
  const denied = await attempt(async () => refused(403), unknown);
  assert.deepEqual([denied.ok, denied.res.status, denied.error], [false, 403, 'You no longer have permission to do this.']);
  const conflict = await attempt(async () => refused(409, { error: 'This is not possible in the current state.' }), unknown);
  assert.deepEqual([conflict.ok, conflict.error], [false, 'This is not possible in the current state.'], 'a definite refusal keeps the server’s reason');
  const fine = await attempt(async () => ({ ok: true, status: 200, data: { runner: { id: 'r1', status: 'revoked' } } }), unknown);
  assert.deepEqual([fine.ok, fine.res.data.runner.status, fine.error], [true, 'revoked', undefined]);
});
