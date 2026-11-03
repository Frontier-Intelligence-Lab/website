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
import { authenticateReviewer } from './lib/reviewers.js';
import { isSameOriginRequest } from './lib/origin.js';

const DEFAULT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Files copied from web/public. Everything else the build emits lives under /assets/ or /private/.
export const ROOT_FILES = ['favicon.svg', 'fonts/LICENSE-Inter-OFL.txt'];
const BUILD_DIRS = /^\/(assets|private)\//;
const SAFE_SUBPATH = /^(?!.*\.\.)[\w./-]+$/;

export async function buildApp({ config, logger = false, contactTransport, rateLimits = {}, distDir = DEFAULT_DIST }) {
  let indexHtml;
  try {
    indexHtml = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    throw new Error(`No client build at ${distDir}; run "npm run build" first`);
  }

  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 32 * 1024 });
  const delivery = createDelivery(config.smtp, contactTransport);
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
        'img-src': ["'self'"],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
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
  });

  // CSRF guard for every state-changing route.
  const sameOrigin = async (request, reply) => {
    if (!isSameOriginRequest(request, config.publicOrigin)) return problem(reply, 403, 'This request did not come from this site.');
  };
  const reviewerOf = (request) => request.session.get('reviewer') ?? null;
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
      if (!reviewerOf(request)) return problem(reply, 401, 'Sign in to load this file.');
    },
  }, sendBuildFile('private', { cacheControl: false }));
  for (const file of ROOT_FILES) app.get(`/${file}`, async (_request, reply) => reply.sendFile(file, { maxAge: '1d' }));

  // Pages rendered by the React app.
  app.get('/', async (_request, reply) => page(reply));
  app.get('/contact', async (_request, reply) => page(reply));
  app.get('/demo', async (request, reply) => {
    privateHeaders(reply);
    return reviewerOf(request) ? reply.redirect('/demo/review', 303) : page(reply);
  });
  app.get('/demo/review', async (request, reply) => {
    privateHeaders(reply);
    return reviewerOf(request) ? page(reply) : reply.redirect('/demo', 303);
  });

  const signInConfigured = config.reviewers.length > 0;
  app.get('/api/config', async () => ({
    bookingUrl: config.bookingUrl,
    contactEmail: config.contactPublicEmail,
    contactConfigured: delivery.configured,
    signInConfigured,
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
    return { reviewer: reviewerOf(request) };
  });
  app.post('/api/login', {
    preHandler: sameOrigin,
    config: { rateLimit: { max: rateLimits.login ?? 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    privateHeaders(reply);
    const email = typeof request.body?.email === 'string' ? request.body.email.slice(0, 254) : '';
    const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, 256) : '';
    if (!signInConfigured) return problem(reply, 503, 'Reviewer access is not configured, so sign-in is unavailable.');
    const reviewer = await authenticateReviewer(config.reviewers, email, password);
    if (!reviewer) return problem(reply, 401, 'That email and password did not match an invited reviewer.');
    await request.session.regenerate();
    request.session.set('reviewer', { ...reviewer, signedInAt: new Date().toISOString() });
    return { reviewer: request.session.get('reviewer') };
  });
  app.post('/api/logout', { preHandler: sameOrigin }, async (request) => {
    await request.session.destroy();
    return { ok: true };
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
