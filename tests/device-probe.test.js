import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { browserHints, createRuntime } from '../web/src/app/runtime.js';
import { createConnectionProbe } from '../web/src/app/device-probe.js';

const later = (ms, value) => new Promise((resolve) => setTimeout(resolve, ms, value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function navigatorFor(t, gpu) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 8, deviceMemory: 8, gpu } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
}

test('an optional adapter request cannot stall a connection or turn unknown GPU support into unavailable', async (t) => {
  const adapter = deferred();
  navigatorFor(t, { requestAdapter: () => adapter.promise });
  const result = await Promise.race([browserHints({ timeoutMs: 10 }), later(200, 'still waiting')]);
  assert.notEqual(result, 'still waiting', 'browser hints settle even when requestAdapter never answers');
  assert.equal(result.webgpu, null);
  assert.equal(result.gpu, null);
  assert.equal(result.hardwareConcurrency, 8, 'ordinary CPU hint is still available');
  adapter.resolve({ info: { vendor: 'late GPU' } });
  await later(0);
  assert.equal(result.webgpu, null, 'a late adapter does not mutate the returned snapshot');
  assert.equal(result.gpu, null);
});

test('denied adapter information stays unknown; an actual absent adapter means unavailable', async (t) => {
  navigatorFor(t, { requestAdapter: async () => { throw new Error('denied'); } });
  assert.equal((await browserHints({ timeoutMs: 10 })).webgpu, null);
  navigator.gpu.requestAdapter = async () => null;
  assert.equal((await browserHints({ timeoutMs: 10 })).webgpu, false);
});

async function metadataServer(t, version, chat) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') return version(res);
    if (req.url === '/api/chat' && chat) return chat(res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return createRuntime(`http://127.0.0.1:${server.address().port}`);
}

test('a stalled optional GPU hint does not delay starting the mandatory runtime reads', async (t) => {
  navigatorFor(t, { requestAdapter: () => new Promise(() => {}) });
  const called = [];
  const probe = createConnectionProbe({
    version: async () => { called.push('version'); return 'test-version'; },
    models: async () => { called.push('models'); return []; },
    running: async () => { called.push('running'); return []; },
  }, () => {}, { hintTimeoutMs: 10 });
  const pending = probe.load();
  assert.deepEqual(called, ['version', 'models', 'running'], 'none waited for adapter discovery');
  const { snapshot } = await pending;
  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.checking, false);
  assert.equal(snapshot.hints.webgpu, null);
});

test('missing headers and stalled JSON bodies time out, clear checking and allow a healthy retry', async (t) => {
  for (const mode of ['headers', 'body']) {
    let healthy = false;
    const runtime = await metadataServer(t, (res) => {
      if (healthy) return res.end(JSON.stringify({ version: 'fixture-version' }));
      if (mode === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"version":'); }
      // Otherwise no headers, or an unfinished body, until the connection deadline aborts it.
    });
    const states = [];
    const probe = createConnectionProbe(runtime, (state) => states.push(state), { timeoutMs: 200, hintTimeoutMs: 10 });
    const failed = await probe.load();
    assert.equal(failed.snapshot.status, 'unreachable', mode);
    assert.equal(failed.snapshot.error.kind, 'timeout', 'a connection deadline is not a user Stop');
    assert.equal(states.at(-1).checking, false, 'Refresh can be used again');
    assert.ok(failed.snapshot.checkedAt);
    healthy = true;
    const retried = await probe.load();
    assert.equal(retried.snapshot.status, 'connected', mode);
    assert.equal(retried.snapshot.version, 'fixture-version');
    assert.deepEqual(retried.snapshot.models, []);
    assert.equal(states.at(-1).checking, false);
    probe.cancel();
  }
});

test('superseded or cancelled checks cannot publish late state, and cleanup does not poison the next setup', async () => {
  const first = deferred();
  let calls = 0;
  const states = [];
  const probe = createConnectionProbe({
    version: () => ++calls === 1 ? first.promise : Promise.resolve('current'),
    models: async () => [], running: async () => [],
  }, (state) => states.push(state));
  const old = probe.load();
  const latest = await probe.load();
  assert.equal(await old, null, 'a superseded check publishes no terminal state');
  assert.equal(latest.snapshot.version, 'current');
  assert.equal(latest.current(), true);
  const count = states.length;
  first.resolve('stale');
  await later(0);
  assert.equal(states.length, count, 'an abort-ignoring old source cannot overwrite the current result');
  probe.cancel();
  assert.equal(latest.current(), false, 'delayed persistence work also sees cancellation');
  const resumed = await probe.load();
  assert.equal(resumed.snapshot.status, 'connected', 'effect cleanup/setup can reuse the probe safely');

  const waiting = deferred();
  const cancelledStates = [];
  const stopped = createConnectionProbe({ version: () => waiting.promise, models: async () => [], running: async () => [] }, (state) => cancelledStates.push(state));
  const cancelled = stopped.load();
  stopped.cancel();
  assert.equal(await cancelled, null);
  waiting.resolve('late after unmount');
  await later(0);
  assert.equal(cancelledStates.length, 1, 'only initial checking, no updates after unmount/disconnect');
});

test('a probe timeout never stops a chat stream; its separate caller Stop still aborts it', async (t) => {
  const began = deferred();
  const controller = new AbortController();
  const pieces = [];
  const runtime = await metadataServer(t, () => {}, (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: 'a' } })}\n`);
    const timer = setTimeout(() => res.write(`${JSON.stringify({ message: { content: 'b' } })}\n`), 100);
    res.on('close', () => clearTimeout(timer));
  });
  const chat = runtime.chat({ messages: [], signal: controller.signal, onToken: (part) => {
    pieces.push(part);
    if (part === 'a') began.resolve();
    if (part === 'b') controller.abort();
  } });
  const stopped = assert.rejects(chat, (error) => error.kind === 'aborted');
  await began.promise;
  const probe = createConnectionProbe(runtime, () => {}, { timeoutMs: 10 });
  assert.equal((await probe.load()).snapshot.error.kind, 'timeout');
  assert.equal(controller.signal.aborted, false, 'the active chat owns its own controller');
  await stopped;
  assert.deepEqual(pieces, ['a', 'b'], 'the stream continued beyond the connection deadline until the caller stopped it');
});

test('an explicit caller abort of a metadata body remains an abort, not a connection timeout', async (t) => {
  const began = deferred();
  const runtime = await metadataServer(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"version":');
    began.resolve();
  });
  const controller = new AbortController();
  const read = runtime.version({ signal: controller.signal });
  const rejected = assert.rejects(read, (error) => error.kind === 'aborted');
  await began.promise;
  controller.abort();
  await rejected;
});
