# Valcairn website

Site for Valcairn by Frontier Intelligence Labs: homepage, contact page, reviewer sign-in and a protected workspace dashboard. The UI is a React 19 single-page app (React Router 8, built with Vite 8). A Fastify 5 server serves the build and a small JSON API for contact delivery and reviewer sessions. Every page has light and dark themes.

![Node](https://img.shields.io/badge/node-%3E%3D22.22-informational) ![React](https://img.shields.io/badge/react-19.3-informational) ![Tests](https://img.shields.io/badge/tests-node%20--test-informational) ![License](https://img.shields.io/badge/license-none%20checked%20in-lightgrey)

## Status

| Area | State |
| --- | --- |
| `/` homepage (Obsidian design in dark, ivory variant in light) | Implemented in React; not yet deployed. |
| `/contact` form with server validation, booking link, SMTP delivery | Implemented in React against `POST /api/contact`. The previous server-rendered version is live and delivered a test message on November 2, 2026 UTC; the React version has not been deployed. |
| `/demo` reviewer sign-in (server-side sessions, scrypt hashes) | Implemented. Sign-in stays disabled until reviewer accounts are configured; none exist yet. |
| `/demo/review` workspace dashboard | Implemented with clearly labelled **sample data** for invited reviewers. Data, labeling, training, licensing and financing panels are a design demonstration, not a working platform. |
| Light / dark mode | Follows the system setting; a toggle stores the visitor's choice in `localStorage`. |
| Deployment | Nothing deploys from this repository yet. frontierintelligencelab.com still runs an earlier server-rendered build as a Docker container; this React version needs a new release (see [Deployment](#deployment)). |

> **History:** this repository previously held a Next.js 16 homepage for Frontier Intelligence Labs (commits `7c1e63b`–`1af003d`). It was never deployed and was replaced by this React + Fastify site; the earlier design remains in Git history.

## Architecture

```mermaid
flowchart LR
    B[Browser: React app] -- "GET /, /contact, /demo, /demo/review" --> F[Fastify]
    B -- "GET /assets/* (public bundle)" --> F
    B -- "GET /private/* (dashboard chunk, session required)" --> F
    B -- "JSON /api/config, /api/contact, /api/login, /api/logout, /api/session" --> F
    F -- SMTP --> M[(Contact mailbox)]
```

- Every page URL returns the same `dist/index.html`; React Router renders the page in the browser.
- Reviewer-only code (the dashboard and its sample data) is built into `dist/private/`. The server returns those files only to signed-in reviewers, so dashboard content is never in the public bundle.
- Signed-out requests to `/demo/review` are redirected to `/demo` by the server before any page loads.

## Run locally

Two terminals, both in `site/`:

```powershell
npm install
npm run dev        # API on http://localhost:3000 (reads .env if present)
```

```powershell
npm run dev:web    # React dev server on http://localhost:5173, proxies /api to :3000
```

Production-style run from one process:

```powershell
npm run build      # writes dist/
npm start          # http://localhost:3000
```

## Verification

```powershell
npm run check      # vite build, syntax check, then node --test (25 tests)
```

Server tests use a tiny fixture build in `tests/fixtures/dist`, so `npm test` alone does not need `vite build`.

## Configuration

See `.env.example`. Key values:

| Variable | Effect |
| --- | --- |
| `SESSION_SECRET` | Required in production, at least 32 characters. |
| `TRUST_PROXY` | Default `false` (no forwarded headers trusted). In production set it to the reverse proxy's IP or CIDR list, e.g. `172.18.0.2` or `172.18.0.0/16,10.0.0.0/8`; `true` is rejected in production. |
| `COOKIE_SECURE` | Default `false` in development, `true` in production. Production refuses to start with `false`. |
| `CONTACT_DELIVERY` | `disabled` (default) or `smtp`. With `smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `CONTACT_TO`, `CONTACT_FROM` apply. |
| `CONTACT_PUBLIC_EMAIL`, `BOOKING_URL` | Returned by `/api/config` and shown on the contact page. |
| `REVIEWERS_FILE` or `REVIEWERS_JSON` | Reviewer accounts. Unset means sign-in is disabled. |
| `SIGNIN_LOG_FILE` | Where the sign-in log is appended (JSON Lines). Unset keeps only the latest 200 events in memory, lost on restart. |

### Sign-in accounts

Only the accounts listed in `REVIEWERS_FILE` (or `REVIEWERS_JSON`) can sign in to `/demo` and reach the dashboard; anything else gets `401`. Accounts use a username, matched case-insensitively, and store only a scrypt hash, never the password. Credentials and hashes are never committed: keep the file outside Git and mount it read-only in production.

Create an entry for a chosen password (read from stdin, at least 8 characters; a warning is printed under 15):

```powershell
"chosen-password" | node scripts/hash-password.js <username> "Display Name"
```

Or let the script generate a strong password with `--generate`. Add `--admin` for accounts that may read the sign-in log; everyone else is a `viewer`. Put each entry in the JSON array referenced by `REVIEWERS_FILE` and restart the server to load changes. Duplicate usernames are rejected at startup.

### Who viewed the demo

Give each invited person their own account: a shared login only shows that *someone* signed in. Every sign-in, sign-out and failed attempt against a real account is recorded with its time and username; failed attempts with unknown usernames are stored as "unknown" because people sometimes type a password into the username field. No email addresses, IP addresses or other personal details are collected, and the sign-in page tells people that sign-ins are recorded. Admin accounts see the log at the bottom of the dashboard.

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/config` | none | Booking link, public email, whether contact delivery and sign-in are configured, field limits. |
| `POST /api/contact` | same origin, 5 per 15 min | `{name, email, organization?, message}` → `200 {ok}`, `400 {errors}`, `503`/`502 {error}`. Never reports success unless the mail server accepted the message. |
| `GET /api/session` | none | `{reviewer}` or `{reviewer: null}`. |
| `POST /api/login` | same origin, 10 per 15 min | `{username, password}` → `200 {reviewer}`, `401`, `503`. |
| `POST /api/logout` | same origin | Ends the session. |
| `GET /api/admin/signins` | admin account | Latest 200 sign-in events, newest first: `{at, event, username}` where `event` is `signin`, `signout` or `failed`. |

## Docker

```powershell
docker build -t valcairn-site .
docker run --rm -p 3000:3000 --env-file .env -e NODE_ENV=production valcairn-site
```

The image builds the React app in a first stage and ships only `src/`, `dist/` and production dependencies (React is build-time only). It listens on `PORT` (default 3000) as the `node` user. Mount the reviewer file read-only and point `REVIEWERS_FILE` at it.

## Deployment

This is a long-running Node server (sessions, SMTP, rate limits), not a static or serverless site, so it needs a container or Node host rather than static hosting:

1. Build the image from this repository (`docker build`); the first stage runs `vite build`, the second ships `src/`, `dist/` and production dependencies.
2. Provide runtime configuration outside Git: `NODE_ENV=production`, `SESSION_SECRET` (32+ chars), `COOKIE_SECURE=true`, `TRUST_PROXY` set to the reverse proxy's IP/CIDR, and, for contact delivery, `CONTACT_DELIVERY=smtp` with the `SMTP_*` and `CONTACT_*` values.
3. Mount a reviewer file read-only and set `REVIEWERS_FILE` to enable `/demo` sign-in. Mount a writable volume (the container runs as the `node` user) and set `SIGNIN_LOG_FILE`, for example `/data/signins.jsonl`, so the sign-in log survives restarts.
4. Health check: `GET /healthz`. Run one instance (sessions are in memory).

## Development versus production

| Setting | Local | Production container |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` |
| `SESSION_SECRET` | auto-generated per start | required, 32+ random characters |
| `COOKIE_SECURE` | `false` (plain HTTP) | `true` (enforced) |
| `TRUST_PROXY` | `false` | the Traefik/Coolify proxy IP or CIDR, verified against the real network |
| `CONTACT_DELIVERY` | `disabled` | `smtp` once the mailbox credentials are mounted |

## Security notes

- Content Security Policy: scripts, styles, fonts, images and API calls from this origin only; no inline scripts, `eval` or third-party requests. No analytics.
- Every `POST` requires a same-origin `Origin`/`Referer` header; session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Login and contact posts are rate limited per client IP; bodies are capped at 32 KB.
- Only `dist/assets/*`, `dist/private/*` (signed-in) and the files in `ROOT_FILES` (`src/app.js`) are served; nothing else on disk is reachable.
- Signed-in pages and API responses are `private, no-store` and `noindex`.
- Sessions live in process memory; a restart signs reviewers out.

## Repository map

- `web/` React app: `src/router.jsx` routes and loaders, `src/site/` public pages, `src/private/` reviewer-only dashboard and sample data, `src/theme.jsx` light/dark toggle, `src/styles.css` theme tokens and styles, `src/assets/` self-hosted Inter and hero artwork.
- `src/` Fastify server: `app.js` routes, API and static serving; `config.js` environment parsing; `lib/` contact validation and delivery, password hashing, reviewer lookup, origin check.
- `tests/` server tests (`node --test`) and the fixture build.
- `vite.config.js` build config, including the `/private/` chunk rule.

## Contributing invariants

- Keep reviewer-only UI and data under `web/src/private/` so it stays out of the public bundle.
- Keep the CSP free of `unsafe-inline`; style dynamic values through React's `style` prop (applied by script) or classes, never inline `<script>`.
- Contact and sign-in must fail closed: no success message unless the server confirmed it.
- Use the colour tokens in `styles.css` for both themes; check contrast in light and dark.

## License

No application license file is currently checked in. The bundled Inter font includes its OFL license (`web/public/fonts/LICENSE-Inter-OFL.txt`). This is a private project workspace.
