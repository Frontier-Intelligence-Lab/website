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

## Database

The optional Postgres store implements [the storage contract](docs/STORE_CONTRACT.md). With `DATABASE_URL` unset, development and tests use the existing in-memory store. Production without a database keeps the new account routes unavailable. Existing reviewer credentials and the sign-in JSONL log are separate and are not migrated by these scripts.

### Local Postgres 17

Start the local database from this repository root:

```sh
docker compose -f docker-compose.postgres.yml up -d --wait
docker compose -f docker-compose.postgres.yml exec postgres createdb -U valcairn valcairn_test
```

The second command creates the test-only database once. The service binds **only `127.0.0.1:5432`**, stores data in the named `valcairn_postgres_data` volume, and uses intentionally public local-only credentials. Never reuse these credentials or this initialization superuser in production. `docker compose ... down` retains the volume; adding `-v` deletes its contents.

For the application, put these values in an ignored local `.env`:

```dotenv
DATABASE_URL=postgresql://valcairn:valcairn_local_only@127.0.0.1:5432/valcairn
DATABASE_SSL=disable
```

Then run `npm run db:migrate` before starting the app. The npm script reads `.env`. Migrations are not run automatically by the web server.

`DATABASE_SSL` accepts `disable` (local plain TCP), `require` (encrypted connection without certificate verification) or `verify-full` (encrypted connection with certificate/hostname verification). Production defaults to `require` and refuses `disable`. Prefer `verify-full` in production with a certificate valid for the configured database hostname; provide a private CA through Node's trusted-CA configuration, such as an appropriately mounted `NODE_EXTRA_CA_CERTS` file. Keep TLS settings in `DATABASE_SSL` rather than contradictory SSL options in the connection URL.

### Store tests

The database tests use **only `TEST_DATABASE_URL`** for connections. They apply migrations to the dedicated test database and reset the store tables between tests. This intentionally deletes test records: use the separate local `valcairn_test` database, never a production database or one containing real data. The safety guard rejects an application-database target, requires a test-named database with an explicit host and port, and refuses query parameters that could override the destination. Unset `DATABASE_URL` for isolated tests; if it is present, it is only inspected for the safety comparison and must also be unambiguous. Its test role needs migration and table-reset privileges; the application role in production does not. Keep this test file serial; parallel CI jobs need separate test databases.

On macOS/Linux:

```sh
env -u DATABASE_URL TEST_DATABASE_URL='postgresql://valcairn:valcairn_local_only@127.0.0.1:5432/valcairn_test' node --test tests/store-postgres.test.js
```

On PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://valcairn:valcairn_local_only@127.0.0.1:5432/valcairn_test'
$env:DATABASE_URL = $null
node --test tests/store-postgres.test.js
Remove-Item Env:TEST_DATABASE_URL
```

With `TEST_DATABASE_URL` unset, the Postgres suite skips cleanly and `npm run check` still runs without a database.

### Migrations and schema

`scripts/migrate.js` applies numbered SQL files in order, records their SHA-256 checksums in `schema_migrations`, and commits each file and its ledger entry atomically. It serializes concurrent runners with a database/schema advisory lock. Applied files must remain unchanged; append a new numbered migration instead. The exported `applyMigrations({ pool })` also accepts an existing `pg.Pool`, which lets the tests select an isolated schema without modifying the SQL files.

- `001_init.sql`: users, email-verification codes, workspaces, memberships, invitations, join requests, projects and audit events.
- `002_sessions.sql`: expiring sessions, reserved for the separate Fastify session-store integration.

Relative to the starting schema, the migrations explicitly constrain lower-case email/domain/slug storage, nonnegative code attempts, object-shaped JSON, valid project statuses, and verified domains having a domain value. They add relationship/expiry indexes and foreign keys. `audit_events.target_id` is text because audit targets are generic identifiers. PostgreSQL 17 provides `gen_random_uuid()` directly, so no extension is needed. No provider, listing or financing tables are added.

The session adapter is not wired into `src/app.js` by this change. Its factory is `createPgSessionStore({ connectionString, ssl, logger, ttlMs, pruneIntervalMs })`; defaults are eight hours for the fallback TTL and 15 minutes for pruning. It supplies callback-compatible `get`, `set`, `destroy` and `compareAndSet` methods (the installed `@fastify/session` also requires compare-and-set), plus `pruneExpired()` and `close()`. Omitting callbacks returns promises.

For the later Fastify integration, construct it once, pass `store: sessionStore` to the existing `@fastify/session` options, and close it with the app:

```js
import { createPgSessionStore } from './store/pg-session-store.js';

const sessionStore = createPgSessionStore({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  logger: app.log,
  ttlMs: config.sessionTtlMs,
});
// Keep the existing secret/cookie options; add store: sessionStore there.
app.addHook('onClose', async () => sessionStore.close());
```

Keep this integration separate from the application-data store and retain the existing production session secret.

### Production deployment proposal — not executed

Proposed production layout (requires approval before any server changes; never reuse the local Compose credentials or superuser):

- Prefer a **Coolify-managed Postgres 17 service**, with a dedicated internal database network shared only with `frontier-landing`. The app also keeps its existing `coolify` proxy network. Publish no database ports and create no Traefik route for it. If Coolify cannot provide the required TLS/role/backup controls, use an explicitly managed Postgres container with the same private-network boundary.
- Proposed persistent bind location: `/home/ayush/valcairn/postgres-data` to `/var/lib/postgresql/data`, owned by the database container's runtime UID. This is a proposed new path, not an existing provisioned volume. Keep it separate from the current reviewer files and sign-in log.
- A bootstrap administrator creates the database and two non-superuser logins. `valcairn_migrator` owns the application schema/objects and can run DDL there, but cannot create databases or roles. `valcairn_app` is not an owner and has only schema usage, data-table read/write privileges and required sequence usage. Do not grant the application write access to `schema_migrations`. Set matching default privileges for future migrations. Use a separate read-only backup identity.
- Configure PostgreSQL TLS with a certificate valid for its internal hostname, mount the CA into the application, and use `DATABASE_SSL=verify-full`. Supply the application URL through the existing protected runtime secret file or scoped Coolify secret; supply the migration URL only to a one-off migration job. Never put either production URL in command history, source, screenshots or logs.
- Proposed backup job: daily at **02:00 UTC**, create a consistent custom-format dump, encrypt it, retain 7 daily/4 weekly/3 monthly copies, and send a verified copy to a private off-host object-storage bucket. A proposed local staging directory is `/home/ayush/valcairn/backups/postgres`; local-only backups are insufficient. Alert on failed jobs, missing uploads and stale backup age. Run a monthly restore drill into a separate database and verify migrations, representative records, workspace isolation and login. Agree on the recovery-point/recovery-time targets before relying on this policy.
- Roll out only after an approved backup and migration rehearsal. Keep the existing reviewer allowlist, session secret and `SIGNIN_LOG_FILE` mounts unchanged. Session-store wiring is a separate reviewed step; this branch does not change it.

#### Restore rehearsal actually performed locally

Postgres **17.8** was tested locally using the commands below. A synthetic record and both migration-ledger entries were recovered into an isolated database (record count 1; migration count 2). This is evidence for the restore procedure, not a production backup claim. Choose a fresh restore database name on subsequent runs.

```sh
docker compose -f docker-compose.postgres.yml exec -T postgres pg_dump -U valcairn -d valcairn_test --format=custom --file=/tmp/valcairn-restore-check.dump
docker compose -f docker-compose.postgres.yml exec -T postgres createdb -U valcairn valcairn_restore_test_20261103
docker compose -f docker-compose.postgres.yml exec -T postgres pg_restore -U valcairn --exit-on-error --no-owner --dbname=valcairn_restore_test_20261103 /tmp/valcairn-restore-check.dump
```

Pending production decisions: private backup destination/region and retention obligations; recovery targets; TLS certificate/CA ownership; and approval of the database service, private network, roles and persistent path. No production database, container, Coolify setting or secret was changed by this work.
