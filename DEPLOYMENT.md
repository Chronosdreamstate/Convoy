# Deploying CORTEGE

Everything here has been run end-to-end against the built image (Postgres 16 +
PostGIS, Redis 7): all migrations apply, the server boots, signup/login work,
the readiness probe flips on dependency loss, and SIGTERM shuts down cleanly.

## API

### Build

```sh
docker build -f apps/api/Dockerfile -t convoy-api .
```

Build from the **repository root** — the pnpm workspace files live there.

The image compiles TypeScript and copies `src/db/migrations/*.sql` into
`dist/db/migrations`. Without that copy the compiled migration runner finds
nothing to apply; it now fails loudly instead of reporting success.

### Run

The container applies pending migrations, then starts the server. Several
replicas may start at once — the runner takes a Postgres advisory lock, so they
queue instead of racing. Set `RUN_MIGRATIONS=false` if your platform applies
migrations as a separate release step.

A migration failure kills the container by design: an API must never serve
traffic against a schema it does not match.

### Required environment

The API **refuses to start in production** if any of these is missing or left
at a placeholder (`src/config/env.ts`), so a misconfigured deploy fails at boot
rather than serving broken maps, routing, PTT or sign-in.

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Append `?sslmode=require` for a managed database — `pg` reads SSL from the connection string |
| `REDIS_URL` | Use `rediss://` for TLS; `ioredis` enables it from the scheme |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Must not be the development defaults |
| `MAPBOX_API_TOKEN` | Server-side routing, geocoding and drive cards |
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | PTT token minting |
| `SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Phone OTP is the primary sign-in; without a sender it silently delivers nothing |
| `CORS_ORIGINS` | Comma-separated allowed origins |

Optional:

| Variable | Notes |
| --- | --- |
| `STORAGE_PROVIDER=s3` + `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | **Strongly recommended.** See uploads below |
| `S3_ENDPOINT` | Set for R2 / Spaces / Supabase / MinIO (switches to path-style addressing) |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | Comma-separated. Unset → that provider returns `503 PROVIDER_NOT_CONFIGURED` and the app hides the button; phone auth still works |
| `UPLOADS_DIR` | Only used when `STORAGE_PROVIDER` is local. Defaults to `/data/uploads` in the image |
| `RUN_MIGRATIONS` | `false` to skip the entrypoint migration step |

### Uploads

The default local backend writes to `/data/uploads` inside the container, which
is **ephemeral** — every redeploy loses previously uploaded avatars, vehicle and
group photos. Either mount a persistent volume at `/data/uploads` or (preferred)
set `STORAGE_PROVIDER=s3`. Stored URLs are unchanged either way: files are always
served back through `GET /uploads/:filename`, so no public bucket is needed and
switching backends does not break existing links.

### Health

`GET /health` returns **503** when Postgres or Redis is unreachable and 200
otherwise, so it can be wired directly to a readiness probe. The image also
declares a `HEALTHCHECK` using it.

### Shutdown

SIGTERM/SIGINT drain the Fastify server, the BullMQ/Redis connections and the
database pool, with a 10s force-exit fallback.

## Mobile

Builds come from EAS (`apps/mobile/eas.json`). The `EXPO_PUBLIC_*` values are
inlined at build time, so they must be present in the build environment — set
them as EAS environment variables per profile:

- `EXPO_PUBLIC_API_URL` — the deployed API base URL
- `EXPO_PUBLIC_MAPBOX_TOKEN`
- `EXPO_PUBLIC_AGORA_APP_ID`
- `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` / `_ANDROID_` / `_WEB_CLIENT_ID`
- `EXPO_PUBLIC_APP_STORE_ID`

`eas.json`'s `submit.production.ios` still contains `REPLACE_WITH_...`
placeholders for `ascAppId` and `appleTeamId`.

Push notifications go through Expo's push service and need the project's own
Expo credentials configured at build time.

## Local development

`docker-compose.yml` provides Postgres (with PostGIS) and Redis only — the API
runs on the host:

```sh
docker compose up -d
pnpm db:migrate
pnpm dev:api
```
