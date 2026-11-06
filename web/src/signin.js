import { api } from './api.js';

// A parser base only, never a request destination. Return a canonical local path, never a supplied origin.
const REDIRECT_BASE = new URL('https://signin.invalid/');

export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const target = new URL(value, REDIRECT_BASE);
    if (target.origin !== REDIRECT_BASE.origin || target.pathname.startsWith('//')) return null;
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}

export function nextPath(account) {
  if (!account?.user) return '/signup';
  if (!account.user.emailVerifiedAt) return '/verify';
  if (account.match) return '/setup/match';
  const first = account.workspaces[0];
  return first ? `/w/${first.slug}` : '/start';
}

// Both forms use the existing reviewer login service for usernames. Only its server-derived destination can
// choose a reviewer's workspace; a normal account keeps the existing verified-email/next-path behavior.
export async function signInResult(fields, next) {
  const res = await api.signin(fields).catch(() => null);
  if (!res?.ok) return { error: res?.data?.error ?? 'Sign-in failed. Please try again.' };
  if (res.data?.reviewer) {
    const to = safeNext(res.data.to);
    return { to: to?.startsWith('/w/') ? to : '/demo/review' };
  }
  const account = await api.account().catch(() => null);
  if (!account?.user) return { error: 'Your workspace could not be loaded. Please try signing in again.' };
  const to = safeNext(next);
  return { to: to && account.user.emailVerifiedAt ? to : nextPath(account) };
}
