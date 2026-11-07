import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createServer } from 'vite';

let vite, views;
const storage = new Map();
before(async () => {
  // These components use the existing browser theme/sidebar helpers; this is a local render fixture only.
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null };
  vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent' });
  views = await vite.ssrLoadModule('/src/app/org.jsx');
});
after(async () => {
  await vite?.close();
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.localStorage;
});

const data = (role, demoAccess = null) => {
  const entry = { id: 'qa-team-org', slug: 'qa-team', name: 'QA ONLY Team', kind: 'organization', role };
  return {
    account: { user: { id: 'qa-owner', name: 'QA ONLY', email: 'owner@qa.invalid', emailVerifiedAt: '2026-01-01T00:00:00.000Z' }, workspaces: [entry], demoAccess },
    entry,
    detail: { role, workspace: entry, members: [{ user: { id: 'qa-member', name: 'QA ONLY Member', email: 'member@qa.invalid' }, role }], invitations: [], joinRequests: [] },
  };
};
const render = (loaded) => {
  const router = createMemoryRouter([{ id: 'team', path: '/w/:slug/setup/team', element: createElement(views.OrgTeam) }], {
    initialEntries: ['/w/qa-team/setup/team'], hydrationData: { loaderData: { team: loaded } },
  });
  try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
  finally { router.dispose(); }
};

const checkShell = (html) => {
  assert.match(html, /<aside[^>]*aria-label="Sidebar"/);
  assert.match(html, /<nav aria-label="Workspace">/);
  const teamLink = html.match(/<a\b[^>]*title="Team"[^>]*>/)?.[0];
  assert.match(teamLink ?? '', /href="\/w\/qa-team\/setup\/team"/);
  assert.match(teamLink, /aria-current="page"/);
  assert.match(html, /<h1[^>]*>Team<\/h1>/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1, 'Team stays inside the shell main landmark');
  assert.doesNotMatch(html, /Setup steps|Organization created|Exit setup|Skip, I&#x27;ll invite later/);
  for (const label of ['Projects', 'Research', 'Models', 'Memory', 'Agents', 'Compute', 'Team', 'Sign out']) assert.match(html, new RegExp(`>${label}<`));
};

test('Owner and Admin Team keep the workspace sidebar, active Team, real role controls and explicit first-project continuation', () => {
  for (const role of ['owner', 'admin']) {
    const html = render(data(role));
    checkShell(html);
    assert.match(html, /Members · 1/);
    assert.match(html, /QA ONLY Member/);
    assert.match(html, /<input id="invite-0" type="email"/);
    assert.match(html, /<button[^>]*type="submit" disabled="">Send invites/);
    assert.match(html, /href="\/w\/qa-team\/projects\/new"[^>]*>Create a project/);
    assert.equal(html.includes('<option value="admin">Admin</option>'), role === 'owner');
  }
});

test('Member, Finance and Viewer Team keep navigation and members without exposing invitation or approval controls', () => {
  for (const role of ['member', 'finance', 'viewer']) {
    const html = render(data(role));
    checkShell(html);
    assert.match(html, /Only owners and admins can invite people/);
    assert.match(html, /Members · 1/);
    assert.doesNotMatch(html, /<form|Send invites|invite-0|Approve<|Withdraw/);
    assert.equal(html.includes('title="Capital"'), role === 'finance');
  }
});

test('Team honors the existing collapsed sidebar preference and reviewer-derived workspace/signout boundaries', () => {
  storage.set('valcairn-sidebar', 'collapsed');
  try {
    const html = render(data('owner', { reviewer: { role: 'member' } }));
    checkShell(html);
    assert.match(html, /ob-side ob-side--collapsed/);
    assert.match(html, /aria-label="Expand sidebar"/);
    assert.match(html.match(/<a\b[^>]*aria-label="Workspace"[^>]*>/)?.[0] ?? '', /href="\/w\/qa-team"/);
    assert.doesNotMatch(html, /Switch or add a workspace|Sign-in log \(admin reviewers\)/);
  } finally { storage.clear(); }
});

test('Team loader retains verified account context and the existing scoped organization/member lookup', async (t) => {
  const fixture = data('owner');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (path, options = {}) => {
    requests.push({ path, method: options.method ?? 'GET', credentials: options.credentials });
    assert.equal(options.method, 'GET');
    return { ok: true, status: 200, json: async () => path === '/api/account' ? fixture.account : fixture.detail };
  });
  const loaded = await views.teamLoader({ params: { slug: fixture.entry.slug } });
  assert.deepEqual(loaded, fixture);
  assert.deepEqual(requests.map((r) => r.path), ['/api/account', '/api/workspaces/qa-team-org']);
  assert.ok(requests.every((r) => r.credentials === 'same-origin'));
  await assert.rejects(views.teamLoader({ params: { slug: 'qa-other-org' } }), (error) => error.status === 302 && error.headers.get('Location') === '/start');
  assert.equal(requests.filter((r) => r.path === '/api/workspaces/qa-team-org').length, 1, 'missing membership does not fetch another workspace');
});
