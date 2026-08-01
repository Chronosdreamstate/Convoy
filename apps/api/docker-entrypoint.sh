#!/bin/sh
# Apply pending migrations, then hand off to the server.
#
# `set -e` matters: if the migration step fails the container must die rather
# than start an API against a schema it does not match. The runner takes a
# Postgres advisory lock, so several replicas starting at once queue up instead
# of racing, and the ones that lose the race simply find nothing pending.
#
# Set RUN_MIGRATIONS=false if your platform applies migrations as a separate
# release step and you do not want each replica to attempt them.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Applying database migrations..."
  node dist/db/migrate.js
else
  echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations."
fi

echo "[entrypoint] Starting API..."
exec "$@"
