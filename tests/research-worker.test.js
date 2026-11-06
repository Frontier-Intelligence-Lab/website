import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createResearchWorker, researchWorkerEnv, researchWorkerMessage } from '../src/lib/research-worker.js';

function childProcess() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = (body) => { child.input = JSON.parse(body); };
  child.kills = 0;
  child.kill = () => { child.kills += 1; return true; };
  return child;
}

test('research worker pre-abort never launches a process', async () => {
  const controller = new AbortController();
  controller.abort();
  let launches = 0;
  const worker = createResearchWorker({ spawnProcess: () => { launches += 1; } });
  await assert.rejects(worker({}, { signal: controller.signal }), { code: 'worker_cancelled' });
  assert.equal(launches, 0);
});

test('research worker cancellation kills the child, removes its abort listener and observes late errors', async () => {
  const child = childProcess();
  const controller = new AbortController();
  const worker = createResearchWorker({ spawnProcess: () => child });
  const pending = worker({ question: 'Synthetic task', urls: [], privateValue: 'not passed' }, { signal: controller.signal });
  assert.equal(child.input.privateValue, undefined);
  controller.abort();
  await assert.rejects(pending, { code: 'worker_cancelled' });
  assert.equal(child.kills, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.stdout.emit('data', '{"pages":[]}');
  child.stdin.emit('error', new Error('late synthetic private pipe detail'));
  child.emit('error', new Error('late synthetic process detail'));
  child.emit('close', 0);
  assert.equal(child.kills, 1);
});

test('research worker stdin failure settles safely and terminates the process', async () => {
  const child = childProcess();
  const worker = createResearchWorker({ spawnProcess: () => child });
  const pending = worker({});
  child.stdin.emit('error', Object.assign(new Error('synthetic private path'), { code: 'EPIPE' }));
  await assert.rejects(pending, { code: 'worker_stopped' });
  assert.equal(child.kills, 1);
  assert.doesNotMatch(researchWorkerMessage(new Error('synthetic private path')), /private path/);
  child.emit('close', 1);
});

test('research worker timeout terminates a child that returns no result', async () => {
  const child = childProcess();
  const worker = createResearchWorker({ spawnProcess: () => child, timeoutMs: 10 });
  await assert.rejects(worker({}), { code: 'worker_timeout' });
  assert.equal(child.kills, 1);
  child.emit('close', null);
});

test('research worker success removes abort ownership and malformed output is rejected', async () => {
  const controller = new AbortController();
  const child = childProcess();
  const pending = createResearchWorker({ spawnProcess: () => child })({}, { signal: controller.signal });
  child.stdout.emit('data', '{"pages":[]}');
  child.emit('close', 0);
  assert.deepEqual(await pending, { pages: [] });
  controller.abort();
  assert.equal(child.kills, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const bad = childProcess();
  const malformed = createResearchWorker({ spawnProcess: () => bad })({});
  bad.stdout.emit('data', '{broken');
  bad.emit('close', 0);
  await assert.rejects(malformed, { code: 'worker_report' });
});

test('research worker preserves UTF-8 characters split across stdout chunks and counts bytes', async () => {
  const child = childProcess();
  const pending = createResearchWorker({ spawnProcess: () => child })({});
  const expected = { pages: [{ text: 'café — 東京 🧭' }] };
  const bytes = Buffer.from(JSON.stringify(expected));
  // Every byte gets its own chunk: two-, three- and four-byte code points must survive.
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
  child.emit('close', 0);
  assert.deepEqual(await pending, expected);

  const large = childProcess();
  const capped = createResearchWorker({ spawnProcess: () => large })({});
  large.stdout.emit('data', Buffer.from('é'.repeat(1024 * 1024 + 1)));
  await assert.rejects(capped, { code: 'worker_large' });
  assert.equal(large.kills, 1, 'The cap applies to bytes, not the number of decoded characters');
  large.emit('close', 1);
});

test('research worker AbortSignal terminates an actual Python child with no network', { timeout: 10000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'valcairn-research-abort-test-'));
  const marker = path.join(temp, 'started.txt');
  const controller = new AbortController();
  let pid;
  try {
    await writeFile(path.join(temp, 'valcairn_research.py'), 'import json, os, pathlib, sys, time\njson.load(sys.stdin)\npathlib.Path("started.txt").write_text(str(os.getpid()))\ntime.sleep(60)\n');
    const pending = createResearchWorker({ python: process.env.RESEARCH_TEST_PYTHON || process.env.RESEARCH_PYTHON || 'python', cwd: temp })({}, { signal: controller.signal });
    const observed = pending.then(() => { throw new Error('The held worker unexpectedly completed'); }, (error) => error);
    for (let n = 0; n < 250 && !pid; n += 1) {
      try { pid = Number(await readFile(marker, 'utf8')); } catch { await pause(20); }
    }
    assert.ok(pid, 'The Python fixture must start before cancellation is tested');
    controller.abort();
    assert.equal((await observed).code, 'worker_cancelled');
    let alive = true;
    for (let n = 0; n < 100 && alive; n += 1) {
      try { process.kill(pid, 0); await pause(20); } catch { alive = false; }
    }
    assert.equal(alive, false, 'Cancellation must terminate the process, not only reject a promise');
  } finally {
    controller.abort();
    if (pid) { try { process.kill(pid); } catch { /* already terminated */ } }
    // mkdtemp returns a unique child of the explicitly named OS temp directory.
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the research worker environment keeps the path and drops database credentials', () => {
  const env = researchWorkerEnv({ PATH: 'C:\\Python', DATABASE_URL: 'postgres://secret', SESSION_SECRET: 'nope', RESEARCH_MODEL: 'hidden' });
  assert.equal(env.PATH, 'C:\\Python');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.RESEARCH_MODEL, undefined);
  assert.equal(env.PYTHONUTF8, '1');
});
