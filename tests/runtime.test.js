import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RuntimeError, createRuntime, isRemote } from '../web/src/app/runtime.js';

// A stand-in for Ollama's HTTP API, scripted per test. The browser client under test is the real one.
async function fakeOllama(t, routes) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const handler = routes[`${req.method} ${req.url}`];
    if (!handler) { res.writeHead(404).end(JSON.stringify({ error: 'not found' })); return; }
    await handler(JSON.parse(body || '{}'), res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  t.after(close);
  return { origin: `http://127.0.0.1:${server.address().port}`, close };
}
const ndjson = (res, lines) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); for (const l of lines) res.write(`${JSON.stringify(l)}\n`); res.end(); };

test('cloud models are marked remote and never inspected', async (t) => {
  const ollama = await fakeOllama(t, {
    'GET /api/tags': (_b, res) => res.end(JSON.stringify({ models: [
      { name: 'demo-chat:0.6b', digest: 'a'.repeat(64), size: 5, details: { family: 'demo' } },
      { name: 'glm-5:cloud', remote_host: 'https://ollama.com:443', digest: 'c'.repeat(64), size: 323, details: {} },
    ] })),
    'POST /api/show': () => assert.fail('a cloud model must not be inspected'),
  });
  const rt = createRuntime(ollama.origin);
  const models = await rt.models();
  assert.deepEqual(models.map((m) => [m.name, m.remote]), [['demo-chat:0.6b', false], ['glm-5:cloud', true]]);
  assert.ok(isRemote({ name: 'gemma4:31b-cloud' }));
  await assert.rejects(rt.show('glm-5:cloud'), (e) => e instanceof RuntimeError && e.kind === 'remote');
  await ollama.close();
});

test('a chat streams tokens and returns the runtime counters in milliseconds', async (t) => {
  const ollama = await fakeOllama(t, {
    'POST /api/chat': (body, res) => {
      assert.equal(body.options.num_ctx, 2048);
      assert.equal(body.think, false);
      ndjson(res, [
        { message: { content: '4' }, done: false },
        { message: { content: '2' }, done: false },
        { message: { content: '' }, done: true, done_reason: 'stop', load_duration: 5e6, prompt_eval_count: 20, prompt_eval_duration: 4e7, eval_count: 2, eval_duration: 2e7 },
      ]);
    },
  });
  const pieces = [];
  const out = await createRuntime(ollama.origin).chat({ model: 'demo-chat:0.6b', messages: [], options: { num_ctx: 2048 }, think: false, onToken: (p) => pieces.push(p) });
  assert.deepEqual(pieces, ['4', '2']);
  assert.equal(out.content, '42');
  assert.deepEqual(out.counters, { loadMs: 5, promptTokens: 20, promptEvalMs: 40, outputTokens: 2, evalMs: 20 });
  await ollama.close();
});

test('out-of-memory, a dropped stream and an absent runtime are told apart', async (t) => {
  const ollama = await fakeOllama(t, {
    'POST /api/chat': (body, res) => {
      if (body.model === 'big:70b') { res.writeHead(500).end(JSON.stringify({ error: 'model requires more system memory (41.2 GiB) than is available (12.0 GiB)' })); return; }
      res.writeHead(200);
      res.flushHeaders();
      res.write(`${JSON.stringify({ message: { content: 'par' }, done: false })}\n`);
      setTimeout(() => res.destroy(), 20); // the runtime dies mid-reply, after it started answering
    },
  });
  const rt = createRuntime(ollama.origin);
  await assert.rejects(rt.chat({ model: 'big:70b', messages: [] }), (e) => e.kind === 'out_of_memory' && /system memory/.test(e.message));
  await assert.rejects(rt.chat({ model: 'small:1b', messages: [] }), (e) => e.kind === 'disconnected');
  await ollama.close();
  await assert.rejects(createRuntime(ollama.origin).version(), (e) => e.kind === 'unreachable');
});

test('stopping a reply aborts the request and is reported as stopped, not failed', async (t) => {
  const ollama = await fakeOllama(t, {
    'POST /api/chat': (_b, res) => { res.writeHead(200); res.write(`${JSON.stringify({ message: { content: 'a' }, done: false })}\n`); /* keeps streaming forever */ },
  });
  const controller = new AbortController();
  const pending = createRuntime(ollama.origin).chat({ model: 'm:1b', messages: [], signal: controller.signal, onToken: () => controller.abort() });
  await assert.rejects(pending, (e) => e.kind === 'aborted');
  await ollama.close();
});

test('a structured completion returns only the tool calls the runtime parsed, never one read from prose, and tells an unsupported model apart', async (t) => {
  const ollama = await fakeOllama(t, {
    'POST /api/chat': (body, res) => {
      assert.equal(body.tools[0].function.name, 'search_notes');
      if (body.model === 'plain:1b') { res.writeHead(400).end(JSON.stringify({ error: 'registry.ollama.ai/library/plain:1b does not support tools' })); return; }
      ndjson(res, [
        { message: { role: 'assistant', content: 'Searching: search_notes({"query":"fake"})' }, done: false },
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_notes', arguments: { query: 'deploy', limit: 2 } } }] }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 9, eval_duration: 9e6 },
      ]);
    },
  });
  const rt = createRuntime(ollama.origin);
  const tools = [{ type: 'function', function: { name: 'search_notes', parameters: { type: 'object' } } }];
  const out = await rt.complete({ model: 'demo-tools:1b', messages: [{ role: 'user', content: 'q' }], tools });
  assert.deepEqual(out.toolCalls, [{ name: 'search_notes', arguments: { query: 'deploy', limit: 2 } }], 'exactly the runtime’s parsed call; the prose mention is text');
  assert.equal(out.content, 'Searching: search_notes({"query":"fake"})');
  assert.equal(out.counters.outputTokens, 9);
  await assert.rejects(rt.complete({ model: 'plain:1b', messages: [], tools }), (e) => e instanceof RuntimeError && e.kind === 'no_tools');
  await ollama.close();
});

test('download progress sums real bytes across layers and needs the runtime’s success line', async (t) => {
  const ollama = await fakeOllama(t, {
    'POST /api/pull': (body, res) => ndjson(res, body.model === 'cut:1b'
      ? [{ status: 'pulling a', digest: 'sha256:a', total: 100, completed: 10 }]
      : [
          { status: 'pulling manifest' },
          { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 50 },
          { status: 'pulling b', digest: 'sha256:b', total: 20, completed: 20 },
          { status: 'pulling a', digest: 'sha256:a', total: 100, completed: 100 },
          { status: 'verifying sha256 digest' },
          { status: 'success' },
        ]),
  });
  const seen = [];
  await createRuntime(ollama.origin).pull('demo-chat:0.6b', { onProgress: (p) => seen.push([p.completed, p.total]) });
  assert.deepEqual(seen.filter(([, t]) => t).map(([c, t]) => `${c}/${t}`), ['50/100', '70/120', '120/120', '120/120', '120/120']);
  await assert.rejects(createRuntime(ollama.origin).pull('cut:1b'), (e) => e.kind === 'disconnected', 'no success line means not installed');
  await ollama.close();
});
