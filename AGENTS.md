# Agent notes

This site is a React 19 single-page app (React Router 8, built with Vite 8) served by a Fastify 5 server. It replaced the earlier Next.js scaffold; there is no Next.js, App Router or `next/*` API here.

- UI lives in `web/` (`web/src/site/` public pages, `web/src/private/` reviewer-only dashboard). Server and JSON API live in `src/`.
- Keep reviewer-only UI and data under `web/src/private/`: the build emits it to `/private/`, which the server only serves to signed-in reviewers.
- Keep the Content Security Policy free of `unsafe-inline`/`unsafe-eval`; no third-party scripts, fonts or analytics.
- Contact delivery and reviewer sign-in must fail closed. Never commit `.env` files or `reviewers*.json`.
- The research agent (`web/src/app/agent.js`) acts only on tool calls the runtime parsed, only after an explicit per-run grant, only through its allowlist; note text is data that can never make a tool run (it can still sway permitted searches, reads and wording), model identity is verified against the runtime at each execution, every execution write is ownership-checked, and no key enters model context or the local ledger.
- Before pushing: `npm ci` then `npm run check` (Vite build, syntax check, `node --test`).
