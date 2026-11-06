FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY web ./web
# Only the pure, browser-safe modules the web bundle imports: no config, secrets or runtime code.
COPY src/lib/onboarding.js src/lib/models.js src/lib/devices.js src/lib/capital.js src/lib/eval-shared.js ./src/lib/
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# One-off database jobs: `docker build --target migrate -t valcairn-migrate .`
# Default command applies pending migrations; `node scripts/reviewers.js …` manages reviewer accounts.
FROM node:24-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts/migrate.js scripts/reviewers.js ./scripts/
COPY migrations ./migrations
USER node
CMD ["node", "scripts/migrate.js"]

FROM node:24-alpine
RUN apk add --no-cache python3 \
    && if ! command -v python >/dev/null 2>&1; then ln -s /usr/bin/python3 /usr/local/bin/python; fi
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY --from=build /app/dist ./dist
COPY services/research/valcairn_research/__init__.py services/research/valcairn_research/__main__.py services/research/valcairn_research/fetch.py ./services/research/valcairn_research/
COPY data/frontier-ai-labs-seed.json ./data/frontier-ai-labs-seed.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
