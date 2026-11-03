# Agent notes

This site is a React 19 single-page app (React Router 8, built with Vite 8) served by a Fastify 5 server. It replaced the earlier Next.js scaffold; there is no Next.js, App Router or `next/*` API here.

- UI lives in `web/` (`web/src/site/` public pages, `web/src/private/` reviewer-only dashboard). Server and JSON API live in `src/`.
- Keep reviewer-only UI and data under `web/src/private/`: the build emits it to `/private/`, which the server only serves to signed-in reviewers.
- Keep the Content Security Policy free of `unsafe-inline`/`unsafe-eval`; no third-party scripts, fonts or analytics.
- Contact delivery and reviewer sign-in must fail closed. Never commit `.env` files or `reviewers*.json`.
- Before pushing: `npm ci` then `npm run check` (Vite build, syntax check, `node --test`).
