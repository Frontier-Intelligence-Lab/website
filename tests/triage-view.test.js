import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// The actual JSX components, transformed by the existing Vite setup and rendered by React. Effects do not run
// during this server render; deferred request/lifecycle tests below cover the client state seam separately.
let server;
let views;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent' });
  views = await server.ssrLoadModule('/src/app/triage.jsx');
});
after(async () => { await server?.close(); });
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const version = { id: randomUUID(), number: 1, contentHash: 'a'.repeat(64), cases: [] };
const review = { hidden: false, leftRole: 'baseline', cases: [] };

test('imported cards label the actual human-only rule rather than exact match', () => {
  const html = render(views.ImportTriage, { review, version, acceptance: { scoreBasis: 'human_only' } });
  assert.match(html, /Scoring rule<\/dt><dd>Human review only/);
  assert.doesNotMatch(html, /Scorer<\/dt><dd>Normalized exact match/);
});

test('imported cards distinguish the hybrid rule from normalized exact match', () => {
  const html = render(views.ImportTriage, { review, version, acceptance: { scoreBasis: 'human_else_auto' } });
  assert.match(html, /Scoring rule<\/dt><dd>Human review, exact match fallback/);
});

test('exact-match rule is labeled only when recorded, and missing rules stay unknown', () => {
  const exact = render(views.ImportTriage, { review, version, acceptance: { scoreBasis: 'auto_exact' } });
  assert.equal((exact.match(/Scoring rule<\/dt><dd>Normalized exact match/g) ?? []).length, 2);
  const absent = render(views.ImportTriage, { review, version });
  assert.equal((absent.match(/Scoring rule<\/dt><dd>Not recorded/g) ?? []).length, 2);
  const unknown = render(views.ImportTriage, { review, version, acceptance: { scoreBasis: '__proto__' } });
  assert.equal((unknown.match(/Scoring rule<\/dt><dd>Not recorded/g) ?? []).length, 2);
});

test('blind imported comparisons do not render system claims or the matrix', () => {
  const html = render(views.ImportTriage, {
    review: { hidden: true }, version, acceptance: { scoreBasis: 'human_only' },
    baseline: { claimedSystem: { identity: 'Fixture hidden baseline' } }, candidate: { claimedSystem: { identity: 'Fixture hidden candidate' } },
  });
  assert.match(html, /hidden while system names are hidden/);
  assert.doesNotMatch(html, /Fixture hidden|eval-matrix|Scoring rule/);
});

test('extractive runner cards expose selected model and prompt as unused configuration', () => {
  const modelId = randomUUID(); // Synthetic catalog identity; no model is named or called.
  const run = (role) => ({
    id: randomUUID(), role, status: 'complete', scored: true, passCount: 1, caseCount: 1,
    recipeId: 'support-qa', recipeVersion: 'fixture-version',
    settings: { retrievalK: 1, prompt: 'Fixture prompt', promptUsed: false, modelId }, runtime: { modelId },
  });
  const html = render(views.RunPair, {
    entry: { id: randomUUID() }, project: { id: randomUUID() }, set: { id: randomUUID() }, version,
    runs: [run('baseline'), run('candidate')],
  });
  assert.match(html, /Extractive · no model call/);
  assert.ok(html.includes(`${modelId} · selected, not used`));
  assert.match(html, /Recorded, not used/);
});
