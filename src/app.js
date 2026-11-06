import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyStatic from '@fastify/static';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { LIMITS, createDelivery, validateContact } from './lib/contact.js';
import { normalizeUsername } from './lib/reviewers.js';
import { createReviewerSource } from './lib/reviewer-source.js';
import { createPgSessionStore } from './store/pg-session-store.js';
import { createSigninLog } from './lib/signins.js';
import { isSameOriginRequest } from './lib/origin.js';
import { createStore } from './store/index.js';
import { registerAccountRoutes } from './accounts.js';
import { registerDatasetRoutes } from './datasets.js';
import { registerWorkspaceDataRoutes } from './workspace-data.js';
import { registerModelRoutes } from './models.js';
import { registerDeviceRoutes } from './devices.js';
import { registerCapitalRoutes } from './capital.js';
import { registerEvalRoutes } from './eval.js';
import { registerJobRoutes } from './jobs.js';
import { registerResearchRoutes } from './research.js';
import { UNAVAILABLE, buildDemoOverview } from './lib/demo-overview.js';
import { DEMO_ALLOWED_MUTATIONS, DEMO_ALLOWED_READS, demoDestination, demoEntryFor, demoMarker, resolveDemoAccess } from './lib/demo-access.js';

const DEFAULT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Files copied from web/public. Everything else the build emits lives under /assets/ or /private/.
export const ROOT_FILES = ['favicon.svg', 'fonts/LICENSE-Inter-OFL.txt'];
const BUILD_DIRS = /^\/(assets|private)\//;
const SAFE_SUBPATH = /^(?!.*\.\.)[\w./-]+$/;

// Onboarding pages; the React app renders them and the API enforces sign-in and membership.
const ACCOUNT_PAGES = ['/signup', '/signin', '/verify', '/start', '/setup/*', '/w/*', '/invite/*', '/staff', '/staff/*'];

export async function buildApp({ config, logger = false, contactTransport, mailTransport, ingestClient, store, sessionStore, rateLimits = {}, distDir = DEFAULT_DIST }) {
  let indexHtml;
  try {
    indexHtml = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    throw new Error(`No client build at ${distDir}; run "npm run build" first`);
  }

  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 32 * 1024 });
  // Tests replace this with a stub. The real worker is used only when it stays null.
  app.decorate('researchExecutor', null);
  const delivery = createDelivery(config.smtp, contactTransport);
  const signins = await createSigninLog(config.signinLogFile, app.log);
  const accountStore = store === undefined ? await createStore(config, app.log) : store;
  if (accountStore) app.addHook('onClose', () => accountStore.close());
  // With a database, sessions survive restarts and can be shared by several instances.
  const sessions = sessionStore ?? (config.databaseUrl
    ? createPgSessionStore({ connectionString: config.databaseUrl, ssl: config.databaseSsl, logger: app.log, ttlMs: config.sessionTtlMs })
    : undefined);
  if (sessions?.close) app.addHook('onClose', () => sessions.close());
  const reviewers = createReviewerSource({ store: accountStore, fileReviewers: config.reviewers });
  if (reviewers.source === 'postgres' && config.reviewers.length) app.log.warn('REVIEWERS_FILE/REVIEWERS_JSON is ignored: reviewer accounts are read from Postgres');
  if (!config.modelCatalog.length) app.log.warn('MODEL_CATALOG_FILE is unset or lists no models: the model catalog is empty, so pulls and new enhance plans are unavailable');
  // Keeps a private, no-store header set by the route; public pages revalidate so new builds are picked up.
  const page = (reply, status = 200) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-cache');
    return reply.code(status).type('text/html; charset=utf-8').send(indexHtml);
  };
  const problem = (reply, status, error, extra = {}) => reply.code(status).send({ error, ...extra });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        // Dataset previews (images, audio, video) load from the ingest service with short-lived signed links.
        // blob: is only for previewing a file the person just picked, before it is uploaded. Scripts stay 'self'.
        'img-src': ["'self'", 'blob:', ...(config.ingest ? [config.ingest.publicUrl] : [])],
        'media-src': ["'self'", 'blob:', ...(config.ingest ? [config.ingest.publicUrl] : [])],
        'font-src': ["'self'"],
        // Sample uploads go straight to the ingest service, so the browser may also connect to it. Run on this device
        // and Memory talk to a runtime and a memory gateway on the visitor's own loopback address; the server never
        // proxies either.
        'connect-src': ["'self'", ...(config.ingest ? [config.ingest.publicUrl] : []), ...config.localRuntimeOrigins, ...config.localMemoryOrigins],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        ...(config.isProd ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(fastifyRateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(fastifyStatic, { root: distDir, serve: false });
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookieName: 'valcairn.sid',
    saveUninitialized: false,
    cookie: { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: config.sessionTtlMs },
    ...(sessions ? { store: sessions } : {}),
  });

  // CSRF guard for every state-changing route.
  const sameOrigin = async (request, reply) => {
    if (!isSameOriginRequest(request, config.publicOrigin)) return problem(reply, 403, 'This request did not come from this site.');
  };
  // The signed-in reviewer, re-checked against the account on every request: a disabled account is signed out
  // and a changed role applies immediately. Memoized per request.
  const reviewerOf = async (request) => {
    if (request.reviewerChecked) return request.reviewer;
    request.reviewerChecked = true;
    const stored = request.session.get('reviewer') ?? null;
    if (!stored) return (request.reviewer = null);
    const current = await reviewers.current(stored);
    if (!current) {
      request.session.set('reviewer', undefined);
      return (request.reviewer = null);
    }
    if (current.role !== stored.role || current.name !== stored.name) request.session.set('reviewer', current);
    return (request.reviewer = current);
  };
  const privateHeaders = (reply) => reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex');
  const sendBuildFile = (dir, cache) => async (request, reply) => {
    const subpath = request.params['*'];
    if (!SAFE_SUBPATH.test(subpath)) return reply.callNotFound();
    return reply.sendFile(`${dir}/${subpath}`, cache);
  };

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /demo\n'));

  // Client build: hashed public bundles, reviewer-only bundles, and a few root files.
  app.get('/assets/*', sendBuildFile('assets', { maxAge: '365d', immutable: true }));
  app.get('/private/*', {
    preHandler: async (request, reply) => {
      privateHeaders(reply);
      if (!(await reviewerOf(request))) return problem(reply, 401, 'Sign in to load this file.');
    },
  }, sendBuildFile('private', { cacheControl: false }));
  for (const file of ROOT_FILES) app.get(`/${file}`, async (_request, reply) => reply.sendFile(file, { maxAge: '1d' }));

  // Pages rendered by the React app.
  app.get('/', async (_request, reply) => page(reply));
  app.get('/contact', async (_request, reply) => page(reply));
  app.get('/demo', async (request, reply) => {
    privateHeaders(reply);
    return (await reviewerOf(request)) ? reply.redirect('/demo/review', 303) : page(reply);
  });
  app.get('/demo/review', async (request, reply) => {
    privateHeaders(reply);
    return (await reviewerOf(request)) ? page(reply) : reply.redirect('/demo', 303);
  });

  for (const url of ACCOUNT_PAGES) {
    app.get(url, async (_request, reply) => {
      privateHeaders(reply);
      return page(reply);
    });
  }
  // Every registered API route, as "METHOD pattern". The reviewer-demo allowlist is checked against it below, so an
  // entry that names no real route stops startup instead of silently permitting or masking anything.
  const registeredRoutes = new Set();
  app.addHook('onRoute', (route) => { for (const method of [].concat(route.method)) registeredRoutes.add(`${method} ${route.url}`); });
  app.decorate('registeredRoutes', registeredRoutes);

  const helpers = { sameOrigin, privateHeaders, problem, reviewerOf };
  const { guards } = await registerAccountRoutes(app, { config, store: accountStore, mailTransport, rateLimits, helpers });
  registerDatasetRoutes(app, { config, store: accountStore, helpers, guards, ingestClient });
  registerWorkspaceDataRoutes(app, { config, store: accountStore, helpers, guards });
  registerModelRoutes(app, { config, store: accountStore, helpers, guards });
  registerDeviceRoutes(app, { config, store: accountStore, helpers, guards });
  registerCapitalRoutes(app, { config, store: accountStore, helpers, guards });
  registerEvalRoutes(app, { store: accountStore, helpers, guards });
  registerJobRoutes(app, { config, store: accountStore, helpers, guards });
  registerResearchRoutes(app, { config, store: accountStore, helpers, guards });
  for (const url of DEMO_ALLOWED_MUTATIONS) if (!registeredRoutes.has(`POST ${url}`)) throw new Error(`reviewer demo allowlist names an unregistered route: POST ${url}`);
  for (const url of DEMO_ALLOWED_READS) if (!registeredRoutes.has(`GET ${url}`)) throw new Error(`reviewer demo allowlist names an unregistered route: GET ${url}`);

  // Reviewer entry into the real workspace (src/lib/demo-access.js): derives the configured dedicated identity for
  // the current reviewer and records it in this session. Never on a session that holds a normal account, and never
  // from anything the client names: the mapping, workspace and user all come from server configuration.
  const demoEntry = async (request) => {
    const reviewer = await reviewerOf(request);
    if (!reviewer) return { code: 'reviewer' };
    if (request.session.get('account')?.userId) return { code: 'account_session' };
    const access = await resolveDemoAccess({ config, store: accountStore, reviewer });
    if (!access) return { code: 'unavailable' };
    request.session.set('demoAccess', { ...demoMarker(access), enteredAt: new Date().toISOString() });
    return { to: demoDestination(access), workspace: access.workspace };
  };

  app.get('/api/config', async () => ({
    bookingUrl: config.bookingUrl,
    contactEmail: config.contactPublicEmail,
    contactConfigured: delivery.configured,
    signInConfigured: await reviewers.configured(),
    accountsAvailable: Boolean(accountStore),
    signupOpen: Boolean(accountStore) && config.accountSignup,
    limits: LIMITS,
  }));

  app.post('/api/contact', {
    preHandler: sameOrigin,
    config: { rateLimit: { max: rateLimits.contact ?? 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { values, errors, ok } = validateContact(request.body);
    if (!ok) return problem(reply, 400, errors.form ?? 'Please check the highlighted fields.', { errors });
    if (!delivery.configured) return problem(reply, 503, 'Message delivery is not configured, so your message was not sent.');
    try {
      await delivery.send(values, { receivedAt: new Date().toISOString() });
    } catch (err) {
      request.log.error({ err }, 'contact delivery failed');
      return problem(reply, 502, 'We could not send your message right now. Please try again later, book a call, or email us directly.');
    }
    return { ok: true };
  });

  app.get('/api/session', async (request, reply) => {
    privateHeaders(reply);
    return { reviewer: await reviewerOf(request) };
  });
  app.post('/api/login', {
    preHandler: sameOrigin,
    config: { rateLimit: { max: rateLimits.login ?? 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    privateHeaders(reply);
    const username = typeof request.body?.username === 'string' ? request.body.username.slice(0, 64) : '';
    const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, 256) : '';
    if (!(await reviewers.configured())) return problem(reply, 503, 'Reviewer access is not configured, so sign-in is unavailable.');
    const { reviewer, known } = await reviewers.authenticate(username, password);
    if (!reviewer) {
      await signins.record({ event: 'failed', username: known ? normalizeUsername(username) : null });
      return problem(reply, 401, 'That username and password did not match an authorized account.');
    }
    await request.session.regenerate();
    request.session.set('reviewer', { ...reviewer, signedInAt: new Date().toISOString() });
    await signins.record({ event: 'signin', username: reviewer.username });
    request.log.info({ username: reviewer.username }, 'reviewer signed in');
    // On a fresh session the configured workspace entry, if any, is derived now and the real destination returned.
    const entry = await demoEntry(request);
    return { reviewer: request.session.get('reviewer'), ...(entry.to ? { to: entry.to, workspace: entry.workspace } : {}) };
  });
  // An existing reviewer session enters the workspace with a same-origin POST; no authority ever comes from a GET.
  app.post('/api/demo/enter', { preHandler: sameOrigin }, async (request, reply) => {
    privateHeaders(reply);
    const entry = await demoEntry(request);
    if (entry.code === 'reviewer') return problem(reply, 401, 'Sign in first.');
    if (entry.code === 'account_session') return problem(reply, 409, 'This browser is signed in to a workspace account. Sign out of it before opening the reviewer demo.', { code: 'account_session' });
    if (entry.code) return problem(reply, 403, 'The workspace entry for this reviewer account is not configured on this server.', { code: 'demo_entry_unavailable' });
    return entry;
  });
  // Ends the reviewer session and with it any workspace entry derived from it.
  app.post('/api/logout', { preHandler: sameOrigin }, async (request) => {
    const reviewer = request.session.get('reviewer') ?? null;
    await request.session.destroy();
    if (reviewer) await signins.record({ event: 'signout', username: reviewer.username });
    return { ok: true };
  });

  // The reviewer overview, read-only. A reviewer with a configured entry sees its OWN organization, resolved from its
  // username through the same checks as workspace entry (no marker needed yet), or a plain unavailable answer when
  // any check fails. Only an ADMIN reviewer without an entry sees the operator overview of DEMO_WORKSPACE_ID; a
  // viewer without an entry (unset, empty or removed mapping) gets nothing, never the operator's records. Nothing in
  // the request selects a workspace; session.account is never read or written here.
  app.get('/api/demo/overview', async (request, reply) => {
    privateHeaders(reply);
    const reviewer = await reviewerOf(request);
    if (!reviewer) return problem(reply, 401, 'Sign in first.');
    let workspaceId;
    if (demoEntryFor(config, reviewer)) {
      const access = await resolveDemoAccess({ config, store: accountStore, reviewer });
      if (!access) return problem(reply, 503, 'The demo organization configured for this reviewer account is not available right now.', { code: 'demo_entry_unavailable' });
      workspaceId = access.workspace.id;
    } else if (reviewer.role === 'admin') {
      workspaceId = config.demoWorkspaceId;
    } else {
      return problem(reply, 403, 'No demo organization is configured for this reviewer account.', { code: 'demo_overview_unavailable' });
    }
    const result = await buildDemoOverview({ store: accountStore, workspaceId });
    return result.code ? problem(reply, 503, UNAVAILABLE[result.code], { code: result.code }) : result.overview;
  });

  // Sign-in history for admin accounts only.
  app.get('/api/admin/signins', async (request, reply) => {
    privateHeaders(reply);
    const reviewer = await reviewerOf(request);
    if (!reviewer) return problem(reply, 401, 'Sign in first.');
    if (reviewer.role !== 'admin') return problem(reply, 403, 'Only admin accounts can view the sign-in log.');
    return { events: signins.recent() };
  });

  app.setNotFoundHandler(async (request, reply) => {
    const isPage = request.method === 'GET' && !request.url.startsWith('/api/') && !BUILD_DIRS.test(request.url);
    return isPage ? page(reply, 404) : problem(reply, 404, 'Not found.');
  });
  app.setErrorHandler(async (err, request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err }, 'request failed');
    const message = status === 429 ? 'Too many requests. Please try again in a few minutes.'
      : status === 413 ? 'The request was too large.'
      : status >= 500 ? 'Something went wrong on our side.' : 'The request could not be processed.';
    return request.url.startsWith('/api/') ? problem(reply, status, message) : reply.code(status).type('text/plain; charset=utf-8').send(message);
  });

  app.decorate('delivery', delivery);
  return app;
}
