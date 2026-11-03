import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseReviewers } from './lib/reviewers.js';

const truthy = (value, fallback) =>
  value == null || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

// Keywords understood by Fastify's proxy-addr based trustProxy.
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

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

  let reviewers = [];
  if (env.REVIEWERS_FILE) reviewers = parseReviewers(readFileSync(env.REVIEWERS_FILE, 'utf8'));
  else if (env.REVIEWERS_JSON) reviewers = parseReviewers(env.REVIEWERS_JSON);

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
    signinLogFile: env.SIGNIN_LOG_FILE || null,
    databaseUrl,
    databaseSsl,
    // Self-serve accounts and onboarding. Off in production unless explicitly enabled.
    accountSignup: truthy(env.ACCOUNT_SIGNUP, !isProd),
  };
}
