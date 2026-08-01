# Production image for the CORTEGE API.
#
# Build from the REPOSITORY ROOT, not from apps/api — the pnpm workspace files
# live there and the lockfile has to be resolvable:
#
#   docker build -f apps/api/Dockerfile -t convoy-api .
#
# The container runs pending migrations before starting the server (see
# docker-entrypoint.sh). Concurrent replicas are safe: the migration runner
# takes a Postgres advisory lock, so a rolling deploy serializes rather than
# racing.

# ---------------------------------------------------------------------------
# Stage 1 — install every dependency and compile TypeScript
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

RUN corepack enable
WORKDIR /repo

# Manifests first so a source-only change reuses the cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/

RUN pnpm install --frozen-lockfile --filter @convoy/api...

COPY apps/api apps/api
RUN pnpm --filter @convoy/api build

# ---------------------------------------------------------------------------
# Stage 2 — runtime with production dependencies only
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

RUN corepack enable
WORKDIR /repo

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/

# --prod drops tsx/jest/typescript. This is why the migration runner is invoked
# as `node dist/db/migrate.js` rather than the tsx-based `db:migrate` script:
# tsx is a devDependency and simply is not here.
RUN pnpm install --frozen-lockfile --prod --filter @convoy/api... \
  && pnpm store prune

# dist/db/migrations/*.sql is produced by the build script — without it the
# runner has nothing to apply and now fails loudly instead of exiting 0.
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The default STORAGE_PROVIDER=local writes to UPLOADS_DIR, which defaults to a
# path inside the (root-owned) app directory — as an unprivileged user that
# mkdir fails and takes the API down at boot. Give it a writable home of its
# own. NOTE: this is container-local and therefore EPHEMERAL; mount a volume
# here or set STORAGE_PROVIDER=s3 before going live, or uploads vanish on every
# redeploy.
ENV UPLOADS_DIR=/data/uploads
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data/uploads"]

# Drop privileges — the node image ships an unprivileged `node` user.
USER node

WORKDIR /repo/apps/api
EXPOSE 3000

# /health returns 503 (not 200-with-a-body) when Postgres or Redis is down, so
# an orchestrator can use it directly as a readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
