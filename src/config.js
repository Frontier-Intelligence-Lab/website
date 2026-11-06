import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseReviewers } from './lib/reviewers.js';
import { parseModelCatalog } from './lib/models.js';
import { parseCatalog } from './lib/devices.js';
import { isEmail } from './lib/onboarding.js';
import { parseDemoReviewerUsers } from './lib/demo-access.js';

const truthy = (value, fallback) =>
  value == null || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

// Keywords understood by Fastify's proxy-addr based trustProxy.
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
// Store ids (src/store/postgres.js uses the same form).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TRUST_PROXY: unset/false -> no forwarded headers are trusted.
 * Otherwise a comma-separated list of proxy IPs, CIDRs or keywords
 * (e.g. "10.0.1.5,172.18.0.0/16"). A blanket "true" is only accepted outside production.
 */
export function parseTrustProxy(value, isProd) {
  if (value == null || value === '' || ['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) {
    if (isProd) throw new Error('TRUST_PROXY=true is not allowed in production; list the proxy IPs or CIDRs instead');
    return true;
  }
  const entries = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (PROXY_KEYWORDS.has(entry)) continue;
    const [ip, prefix, ...rest] = entry.split('/');
    const family = isIP(ip);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (!family || !prefixOk || rest.length) throw new Error(`TRUST_PROXY entry "${entry}" is not an IP, CIDR or keyword`);
  }
  return entries;
}

export function loadConfig(env = process.env) {
  const isProd = (env.NODE_ENV ?? 'development') === 'production';

  const sessionSecret = env.SESSION_SECRET || (isProd ? '' : randomBytes(32).toString('hex'));
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }

  const cookieSecure = truthy(env.COOKIE_SECURE, isProd);
  if (isProd && !cookieSecure) {
    throw new Error('COOKIE_SECURE=false is not allowed in production; serve over HTTPS and set COOKIE_SECURE=true');
  }

  const contactDelivery = env.CONTACT_DELIVERY ?? 'disabled';
  if (!['disabled', 'smtp'].includes(contactDelivery)) {
    throw new Error('CONTACT_DELIVERY must be "smtp" or "disabled"');
  }
  const smtp = contactDelivery === 'smtp'
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 465),
        secure: truthy(env.SMTP_SECURE, true),
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        to: env.CONTACT_TO ?? 'contact@frontierintelligencelab.com',
        from: env.CONTACT_FROM ?? env.SMTP_USER,
      }
    : null;
  if (smtp && !(smtp.host && smtp.from && Number.isInteger(smtp.port))) {
    throw new Error('CONTACT_DELIVERY=smtp requires SMTP_HOST, SMTP_PORT and CONTACT_FROM (or SMTP_USER)');
  }

  const databaseUrl = env.DATABASE_URL || null;
  const databaseSsl = env.DATABASE_SSL || (isProd ? 'require' : 'disable');
  if (!['disable', 'require', 'verify-full'].includes(databaseSsl)) {
    throw new Error('DATABASE_SSL must be "disable", "require" or "verify-full"');
  }
  if (isProd && databaseUrl && databaseSsl === 'disable') {
    throw new Error('DATABASE_SSL=disable is not allowed in production');
  }

  // Sample uploads go to services/ingest. Both values are needed; otherwise uploads stay off.
  const ingestPublicUrl = env.INGEST_PUBLIC_URL ? String(env.INGEST_PUBLIC_URL).replace(/\/+$/, '') : null;
  const ingestSharedSecret = env.INGEST_SHARED_SECRET || null;
  if (ingestPublicUrl && !/^https?:\/\/[^/]+$/.test(ingestPublicUrl)) throw new Error('INGEST_PUBLIC_URL must be an origin such as https://ingest.example.com');
  if (isProd && ingestPublicUrl && !ingestPublicUrl.startsWith('https://')) throw new Error('INGEST_PUBLIC_URL must use https in production');
  if (ingestSharedSecret && ingestSharedSecret.length < 32) throw new Error('INGEST_SHARED_SECRET must be at least 32 characters');
  // Valcairn staff who may use the internal review queue; each must also confirm their email.
  const staffEmails = String(env.STAFF_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Origins of services on the visitor's own machine that the browser connects to directly; the server never does.
  // Only loopback http origins are accepted, so neither can ever point at another host. Empty turns the feature off.
  const loopbackOrigins = (name, value, fallback) => {
    const origins = String(value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
    for (const origin of origins) {
      if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(origin)) throw new Error(`${name} entry "${origin}" must be a loopback origin such as http://127.0.0.1:${fallback.match(/:(\d+)/)[1]}`);
    }
    return origins;
  };
  // A local model runtime (Ollama by default) for Run on this device.
  const localRuntimeOrigins = loopbackOrigins('LOCAL_RUNTIME_ORIGINS', env.LOCAL_RUNTIME_ORIGINS, 'http://127.0.0.1:11434,http://localhost:11434');
  // A Provena memory gateway in local-store mode for Memory. 8787 keeps clear of a Provena Compose stack on 8080.
  const localMemoryOrigins = loopbackOrigins('LOCAL_MEMORY_ORIGINS', env.LOCAL_MEMORY_ORIGINS, 'http://127.0.0.1:8787,http://localhost:8787');

  // Models a person may download on Run on this device. Unset: no catalog; installed models still work.
  const localModelCatalog = env.LOCAL_MODEL_CATALOG_FILE ? parseCatalog(readFileSync(env.LOCAL_MODEL_CATALOG_FILE, 'utf8')) : [];

  let reviewers = [];
  if (env.REVIEWERS_FILE) reviewers = parseReviewers(readFileSync(env.REVIEWERS_FILE, 'utf8'));
  else if (env.REVIEWERS_JSON) reviewers = parseReviewers(env.REVIEWERS_JSON);

  // The one workspace the /demo reviewer overview reads: the id of the seeded synthetic workspace (a UUID, the same
  // form as every store id). Unset leaves the overview unconfigured; the server never substitutes sample data. The
  // workspace must also carry profile.synthetic === true at request time, checked in src/lib/demo-overview.js.
  const demoWorkspaceId = String(env.DEMO_WORKSPACE_ID ?? '').trim() || null;
  if (demoWorkspaceId && !UUID.test(demoWorkspaceId)) {
    throw new Error('DEMO_WORKSPACE_ID must be the UUID of the synthetic demo workspace (printed by scripts/seed-demo.js), or unset');
  }
  // Demo-scoped staff (src/lib/staff-scope.js): confirmed accounts that may review only the workspace DEMO_WORKSPACE_ID
  // names, and only while it is synthetic. Each entry must be an email address, a non-empty list needs the pinned
  // workspace, and an address is never on both lists, so it cannot carry global staff authority by accident. No default.
  const demoStaffEmails = String(env.DEMO_STAFF_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!demoStaffEmails.every(isEmail)) throw new Error('DEMO_STAFF_EMAILS must be a comma-separated list of email addresses');
  if (demoStaffEmails.length && !demoWorkspaceId) throw new Error('DEMO_STAFF_EMAILS requires DEMO_WORKSPACE_ID: demo staff are scoped to that one synthetic workspace');
  if (demoStaffEmails.some((e) => staffEmails.includes(e))) throw new Error('DEMO_STAFF_EMAILS must not repeat a STAFF_EMAILS entry: an address is either global staff or demo-scoped staff');
  // Reviewer workspace entry (src/lib/demo-access.js): which dedicated demo owner and which synthetic organization
  // each reviewer username opens. A read-only JSON file of ids, never passwords; unset means reviewers keep the
  // read-only overview only. These organizations are the reviewers' own; the operator pin above is never one of them.
  let demoReviewerUsers = [];
  if (env.DEMO_REVIEWER_USERS_FILE) {
    try { demoReviewerUsers = parseDemoReviewerUsers(readFileSync(env.DEMO_REVIEWER_USERS_FILE, 'utf8')); }
    catch (err) { throw new Error(`DEMO_REVIEWER_USERS_FILE: ${err.message}`, { cause: err }); }
  }
  if (demoWorkspaceId && demoReviewerUsers.some((m) => m.workspaceId === demoWorkspaceId.toLowerCase())) {
    throw new Error('DEMO_REVIEWER_USERS_FILE must not map a reviewer to the DEMO_WORKSPACE_ID operator workspace: each reviewer gets its own synthetic organization');
  }

  // The open-weight model catalog is deployment data (docs/model-catalog.example.json), checked once here.
  // Unset leaves it empty: Models pages have nothing to pull and new enhance plans are refused, while pulls and
  // runs already recorded stay readable. An unreadable or invalid file stops startup with the reason.
  let modelCatalog = [];
  if (env.MODEL_CATALOG_FILE) {
    try { modelCatalog = parseModelCatalog(readFileSync(env.MODEL_CATALOG_FILE, 'utf8')); }
    catch (err) { throw new Error(`MODEL_CATALOG_FILE (${env.MODEL_CATALOG_FILE}): ${err.message}`, { cause: err }); }
  }

  return {
    isProd,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? 'info',
    publicOrigin: env.PUBLIC_ORIGIN || null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProd),
    cookieSecure,
    sessionSecret,
    sessionTtlMs: Number(env.SESSION_TTL_HOURS ?? 8) * 3600 * 1000,
    contactDelivery,
    smtp,
    contactPublicEmail: env.CONTACT_PUBLIC_EMAIL ?? 'contact@frontierintelligencelab.com',
    bookingUrl: env.BOOKING_URL ?? 'https://cal.com/ayushozha/15-min-getting-to-know',
    reviewers,
    demoWorkspaceId,
    modelCatalog,
    signinLogFile: env.SIGNIN_LOG_FILE || null,
    databaseUrl,
    databaseSsl,
    // Self-serve accounts and onboarding. Off in production unless explicitly enabled.
    accountSignup: truthy(env.ACCOUNT_SIGNUP, !isProd),
    ingest: ingestPublicUrl && ingestSharedSecret ? {
      publicUrl: ingestPublicUrl,
      // Server-to-server address for commit/delete; defaults to the public one.
      internalUrl: (env.INGEST_INTERNAL_URL || ingestPublicUrl).replace(/\/+$/, ''),
      secret: ingestSharedSecret,
      maxBytes: Number(env.INGEST_MAX_BYTES ?? 200 * 1024 * 1024),
      projectMaxFiles: Number(env.PROJECT_MAX_FILES ?? 2000),
      projectMaxBytes: Number(env.PROJECT_MAX_BYTES ?? 20 * 1024 ** 3),
    } : null,
    staffEmails,
    demoStaffEmails,
    demoReviewerUsers,
    localRuntimeOrigins,
    localMemoryOrigins,
    localModelCatalog,
    // Web research. The model id is read from the environment and is not called by this server.
    // RESEARCH_SEARCH_BASE is intentionally unread: paid search is not called.
    research: {
      python: env.RESEARCH_PYTHON || 'python',
      model: env.RESEARCH_MODEL || null,
      modelBaseUrl: env.RESEARCH_MODEL_BASE_URL || null,
    },
  };
}
