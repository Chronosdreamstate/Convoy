/**
 * LIVE end-to-end smoke suite — boots the REAL Fastify app (buildApp) against
 * the REAL docker infrastructure (convoy_postgres + convoy_redis) and drives
 * it over actual HTTP and actual socket.io-client connections. Unlike
 * convoy-flow.integration.test.ts (in-memory doubles), nothing here is mocked.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   1. docker compose up -d          (from the repo root — starts convoy_postgres/convoy_redis)
 *   2. cd apps/api
 *   3. pnpm test src/integration/live.smoke.test.ts
 *      (or just `pnpm test` — this file runs as part of the normal suite when
 *       the containers are up, and SKIPS itself cleanly when they are not)
 *   Optional env overrides: LIVE_SMOKE=0 forces a skip; LIVE_SMOKE_PG_HOST /
 *   LIVE_SMOKE_PG_PORT / LIVE_SMOKE_REDIS_HOST / LIVE_SMOKE_REDIS_PORT retarget
 *   the probes and connections.
 *
 * ── ISOLATION & CLEANUP ─────────────────────────────────────────────────────
 *   Postgres: a dedicated scratch database `convoy_live_smoke` is DROPped and
 *     re-CREATEd at suite start, migrated from src/db/migrations, and DROPped
 *     again at the end. The dev `convoy` database is never written to.
 *   Redis: logical DB 15 (dev traffic lives in DB 0) — flushed before and
 *     after the run.
 *   Env: DATABASE_URL / REDIS_URL are only overridden inside beforeAll (the
 *     app's config/env is imported lazily AFTER the override) and restored in
 *     afterAll, so other test files in the same --runInBand process are
 *     unaffected.
 *
 * ── GATING ──────────────────────────────────────────────────────────────────
 *   A synchronous TCP probe of the Postgres and Redis ports runs at module
 *   load; if either is unreachable the whole suite is registered as
 *   describe.skip, so `pnpm test` never breaks on machines without docker.
 *
 * ── COVERAGE ────────────────────────────────────────────────────────────────
 *   health → signup/login JWT → create group / join by code → two live
 *   sockets → location:update fan-out → Redis-backed presence:get (online and
 *   offline transitions) → REST chat + group:message broadcast → DM channel
 *   between two convoy-less users incl. concurrent-create convergence →
 *   hazard report REST + hazard:new broadcast + GET /hazards readback.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';

// `jose` is ESM-only and jest's CJS pipeline cannot load it: the ts-jest
// preset only registers a transform for .ts files, so the jose .js files are
// executed untransformed and their `export` statements throw (the
// transformIgnorePatterns exception for jose in jest.config.ts doesn't apply —
// see BUGS FOUND in the live-smoke report). jose is used exclusively by
// POST /auth/social (Google/Apple ID-token JWKS verification), which this
// suite does not exercise — stub just that module so the REAL rest of the app
// (fastify, pg, ioredis, socket.io, bullmq) loads and runs unmocked.
jest.mock('jose', () => ({
  createRemoteJWKSet: () => {
    throw new Error('jose is stubbed in the live smoke suite (social auth not covered)');
  },
  jwtVerify: async () => {
    throw new Error('jose is stubbed in the live smoke suite (social auth not covered)');
  },
}));

// ---------------------------------------------------------------------------
// Connection targets (docker-compose.yml defaults)
// ---------------------------------------------------------------------------

const PG_HOST = process.env.LIVE_SMOKE_PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.LIVE_SMOKE_PG_PORT ?? 5432);
const PG_USER = 'convoy';
const PG_PASSWORD = 'convoy';
const REDIS_HOST = process.env.LIVE_SMOKE_REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.LIVE_SMOKE_REDIS_PORT ?? 6379);

/** Scratch database — dropped and recreated every run; dev data untouched. */
const SMOKE_DB = 'convoy_live_smoke';
/** Redis logical DB 15 — dev uses DB 0. Flushed before and after the run. */
const SMOKE_REDIS_DB = 15;

const SMOKE_DATABASE_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${SMOKE_DB}`;
const SMOKE_REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}/${SMOKE_REDIS_DB}`;

// ---------------------------------------------------------------------------
// Infra gate — synchronous TCP probe so we can decide describe vs describe.skip
// at module-load time (jest offers no async way to skip a whole suite).
// ---------------------------------------------------------------------------

function tcpReachable(host: string, port: number): boolean {
  const script =
    'const s=require("net").connect({host:process.argv[1],port:Number(process.argv[2])});' +
    's.setTimeout(1500);' +
    's.on("connect",()=>{s.destroy();process.exit(0);});' +
    's.on("timeout",()=>process.exit(1));' +
    's.on("error",()=>process.exit(1));';
  const res = spawnSync(process.execPath, ['-e', script, host, String(port)], { timeout: 6000 });
  return res.status === 0;
}

const infraUp =
  process.env.LIVE_SMOKE !== '0' &&
  tcpReachable(PG_HOST, PG_PORT) &&
  tcpReachable(REDIS_HOST, REDIS_PORT);

const describeLive = infraUp ? describe : describe.skip;

if (!infraUp) {
  // eslint-disable-next-line no-console
  console.warn(
    `[live.smoke] Postgres (${PG_HOST}:${PG_PORT}) or Redis (${REDIS_HOST}:${REDIS_PORT}) ` +
      'not reachable — skipping live smoke suite. Start docker compose to enable it.',
  );
}

// ---------------------------------------------------------------------------
// socket.io-client loader — the api package doesn't declare socket.io-client
// (it's a server), but the monorepo has it (apps/mobile dependency / pnpm
// store). Resolve it at runtime so package.json stays untouched.
// ---------------------------------------------------------------------------

interface SmokeSocket {
  id: string;
  connected: boolean;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb?: (...args: unknown[]) => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}
type IoFactory = (url: string, opts: Record<string, unknown>) => SmokeSocket;

function loadSocketIoClient(): IoFactory {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const candidates: string[] = [
    path.join(repoRoot, 'apps', 'mobile', 'node_modules', 'socket.io-client'),
    path.join(repoRoot, 'node_modules', 'socket.io-client'),
  ];
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('socket.io-client@')) {
        candidates.push(path.join(pnpmDir, entry, 'node_modules', 'socket.io-client'));
      }
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(candidate) as { io?: IoFactory; default?: IoFactory };
      const factory = mod.io ?? mod.default ?? (mod as unknown as IoFactory);
      if (typeof factory === 'function') return factory;
    }
  }
  throw new Error(
    'socket.io-client could not be resolved from the monorepo — is apps/mobile installed?',
  );
}

// ---------------------------------------------------------------------------
// Postgres scratch-database + migration helpers
// ---------------------------------------------------------------------------

async function openAdminPool(): Promise<Pool> {
  // Prefer the maintenance DB; fall back to the dev DB (used only to issue
  // CREATE/DROP DATABASE — its tables are never touched).
  for (const db of ['postgres', 'convoy']) {
    const pool = new Pool({
      connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${db}`,
      max: 1,
    });
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch {
      await pool.end().catch(() => undefined);
    }
  }
  throw new Error('Could not open an admin connection to Postgres');
}

async function recreateScratchDatabase(): Promise<void> {
  const admin = await openAdminPool();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SMOKE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SMOKE_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropScratchDatabase(): Promise<void> {
  const admin = await openAdminPool();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SMOKE_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Applies src/db/migrations/*.sql in order — same algorithm as src/db/migrate.ts.
 * Re-implemented here because importing migrate.ts executes runMigrations() at
 * module load (fire-and-forget) which we can't await or point at our URL safely.
 */
async function migrateScratchDatabase(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const pool = new Pool({ connectionString: SMOKE_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const appliedResult = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(appliedResult.rows.map((r) => r.version));

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      const [, version, name] = match;
      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          version,
          name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Small async utilities
// ---------------------------------------------------------------------------

function waitForEvent<T>(
  socket: SmokeSocket,
  event: string,
  predicate?: (data: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handler = (...args: unknown[]): void => {
      const data = args[0] as T;
      if (predicate && !predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${event}'`));
    }, timeoutMs);
    socket.on(event, handler);
  });
}

/**
 * emit-with-ack, single attempt — deliberately NO retries. The server
 * registers all socket event listeners synchronously at the top of its
 * connection handler (async DB/Redis setup is gated behind an internal
 * `ready` promise instead), so the very first emit after 'connect' must be
 * delivered and acked. If this ever times out, first-emit delivery has
 * regressed on the server.
 */
function emitWithAck<T>(
  socket: SmokeSocket,
  event: string,
  payload: unknown,
  { ackTimeoutMs = 8000 } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ack timeout for '${event}'`)),
      ackTimeoutMs,
    );
    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/**
 * Minimal HTTP client on node:http with `agent: false` — every request uses a
 * fresh, immediately-closed socket, so no keep-alive handles outlive the
 * suite (global fetch/undici pools sockets for ~4s and makes jest whine about
 * open handles after the run).
 */
function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let json: any = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 8000, intervalMs = 250 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `pollUntil timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

interface PresenceEntry {
  id: string;
  isOnline: boolean;
  lastSeen: string | null;
}

interface SmokeUser {
  email: string;
  password: string;
  id: string;
  token: string;
}

describeLive('LIVE smoke: real app against docker Postgres + Redis', () => {
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = 'live-smoke-pass-1!';

  let savedDatabaseUrl: string | undefined;
  let savedRedisUrl: string | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl = '';
  let adminRedis: Redis | undefined;
  let ioFactory: IoFactory;

  const openSockets: SmokeSocket[] = [];

  // Populated as the flows run (tests are ordered and build on each other).
  const users: Record<'a' | 'b' | 'c' | 'd', SmokeUser> = {
    a: { email: `smoke-a-${runId}@convoy.test`, password, id: '', token: '' },
    b: { email: `smoke-b-${runId}@convoy.test`, password, id: '', token: '' },
    c: { email: `smoke-c-${runId}@convoy.test`, password, id: '', token: '' },
    d: { email: `smoke-d-${runId}@convoy.test`, password, id: '', token: '' },
  };
  let groupId = '';
  let joinCode = '';
  let socketA: SmokeSocket;
  let socketB: SmokeSocket;
  let socketC: SmokeSocket;
  let socketD: SmokeSocket;
  let dmGroupIdCD = '';

  // ------------------------------------------------------------------ helpers

  function api(
    method: string,
    pathname: string,
    opts: { token?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> {
    return httpRequest(
      method,
      `${baseUrl}/api/v1${pathname}`,
      {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      opts.body === undefined ? undefined : JSON.stringify(opts.body),
    );
  }

  async function connectSocket(token: string, socketGroupId?: string): Promise<SmokeSocket> {
    const socket = ioFactory(baseUrl, {
      transports: ['websocket'],
      auth: { token, ...(socketGroupId ? { groupId: socketGroupId } : {}) },
      reconnection: false,
      timeout: 8000,
    });
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('socket connect timed out'));
      }, 10_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err: unknown) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(err instanceof Error ? err : new Error(`connect_error: ${JSON.stringify(err)}`));
      });
    });
    // First-emit proof: this presence:get is fired immediately after
    // 'connect' with NO retry — the server registers listeners synchronously,
    // so the emit must be received and acked (the ack itself waits on the
    // server's internal connect-time setup, so it doubles as a readiness
    // barrier for the joined-rooms state later tests rely on).
    await emitWithAck<PresenceEntry[]>(socket, 'presence:get', { userIds: [] });
    return socket;
  }

  function presenceVia(socket: SmokeSocket, userIds: string[]): Promise<PresenceEntry[]> {
    return emitWithAck<PresenceEntry[]>(socket, 'presence:get', { userIds });
  }

  // ------------------------------------------------------------------ set up

  beforeAll(async () => {
    ioFactory = loadSocketIoClient();

    savedDatabaseUrl = process.env.DATABASE_URL;
    savedRedisUrl = process.env.REDIS_URL;
    process.env.DATABASE_URL = SMOKE_DATABASE_URL;
    process.env.REDIS_URL = SMOKE_REDIS_URL;

    await recreateScratchDatabase();
    await migrateScratchDatabase();

    adminRedis = new Redis(SMOKE_REDIS_URL, { maxRetriesPerRequest: 3 });
    await adminRedis.flushdb();

    // Import the app only AFTER the env override so config/env picks it up.
    const { buildApp } = await import('../app');
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    for (const socket of openSockets) {
      try {
        socket.disconnect();
      } catch {
        /* already closed */
      }
    }
    if (app) {
      await app.close();
    }
    if (adminRedis) {
      await adminRedis.flushdb().catch(() => undefined);
      await adminRedis.quit().catch(() => undefined);
    }
    await dropScratchDatabase().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[live.smoke] failed to drop ${SMOKE_DB}: ${(err as Error).message}`);
    });

    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    // No post-close drain needed: the notifications/group-expiry plugins now
    // await BullMQ worker/queue close and connection.quit() to completion in
    // their onClose hooks, so app.close() resolves with no ref'd timers left.
  }, 90_000);

  // ------------------------------------------------------------------- tests

  it('health endpoint reports db and redis ok', async () => {
    const res = await httpRequest('GET', `${baseUrl}/health`, {});
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
    expect(res.json.db).toBe('ok');
    expect(res.json.redis).toBe('ok');
  }, 15_000);

  it('signup issues a JWT and login re-authenticates (bad password rejected)', async () => {
    // 4 signups — stays under the per-IP signup rate limit of 5 per 15 min
    // (Redis DB 15 is flushed at suite start, so re-runs get a fresh budget).
    for (const key of ['a', 'b', 'c', 'd'] as const) {
      const u = users[key];
      const res = await api('POST', '/auth/email/signup', {
        body: { email: u.email, password: u.password },
      });
      expect(res.status).toBe(201);
      expect(typeof res.json.accessToken).toBe('string');
      expect(typeof res.json.user.id).toBe('string');
      u.id = res.json.user.id;
      u.token = res.json.accessToken;
    }

    // Real login round-trip for user A — replaces the signup token to prove
    // the login-issued JWT is what the rest of the suite runs on.
    const login = await api('POST', '/auth/email/login', {
      body: { email: users.a.email, password: users.a.password },
    });
    expect(login.status).toBe(200);
    expect(typeof login.json.accessToken).toBe('string');
    expect(login.json.user.id).toBe(users.a.id);
    users.a.token = login.json.accessToken;

    const badLogin = await api('POST', '/auth/email/login', {
      body: { email: users.a.email, password: 'wrong-password-123' },
    });
    expect(badLogin.status).toBe(401);

    // The JWT actually authenticates against a protected endpoint.
    const me = await api('GET', '/groups/active', { token: users.a.token });
    expect(me.status).toBe(200);
    expect(me.json.group).toBeNull();
  }, 30_000);

  it('user A creates a group and user B joins by code', async () => {
    const created = await api('POST', '/groups', {
      token: users.a.token,
      body: { name: `Live Smoke Convoy ${runId}`, accessType: 'open' },
    });
    expect(created.status).toBe(201);
    expect(typeof created.json.id).toBe('string');
    expect(created.json.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.json.memberCount).toBe(1);
    expect(created.json.adminId).toBe(users.a.id);
    groupId = created.json.id;
    joinCode = created.json.joinCode;

    const joined = await api('POST', '/groups/join', {
      token: users.b.token,
      body: { code: joinCode },
    });
    expect(joined.status).toBe(200);
    expect(joined.json.id).toBe(groupId);
    expect(joined.json.memberCount).toBe(2);
  }, 30_000);

  it('both members connect sockets and location:update fans out to the other member', async () => {
    socketA = await connectSocket(users.a.token, groupId);
    socketB = await connectSocket(users.b.token, groupId);

    const location = {
      lat: 37.7749,
      lng: -122.4194,
      heading: 90,
      speed_kph: 60,
      ts: Date.now(),
    };
    const received = waitForEvent<{ userId: string; lat: number; lng: number }>(
      socketB,
      'location:update',
      (d) => d.userId === users.a.id,
    );
    socketA.emit('location:update', location);

    const update = await received;
    expect(update.userId).toBe(users.a.id);
    expect(update.lat).toBeCloseTo(location.lat, 6);
    expect(update.lng).toBeCloseTo(location.lng, 6);
  }, 30_000);

  it('presence:get reflects online state from Redis', async () => {
    const unknownUserId = '00000000-0000-4000-8000-000000000000';
    const presence = await presenceVia(socketB, [users.a.id, users.b.id, unknownUserId]);

    const byId = new Map(presence.map((p) => [p.id, p]));
    expect(byId.get(users.a.id)?.isOnline).toBe(true);
    expect(byId.get(users.b.id)?.isOnline).toBe(true);
    expect(byId.get(users.a.id)?.lastSeen).toBeTruthy();
    expect(byId.get(unknownUserId)?.isOnline).toBe(false);
    expect(byId.get(unknownUserId)?.lastSeen).toBeNull();

    // Verify against Redis directly — this is the Redis-backed store, not an
    // in-process map.
    const key = await adminRedis!.exists(`presence:online:${users.a.id}`);
    expect(key).toBe(1);
  }, 30_000);

  it('REST chat message is persisted and broadcast as group:message to both sockets', async () => {
    const text = `hello convoy ${runId}`;
    const onA = waitForEvent<{ id: string; text: string; userId: string }>(
      socketA,
      'group:message',
      (m) => m.text === text,
    );
    const onB = waitForEvent<{ id: string; text: string; userId: string }>(
      socketB,
      'group:message',
      (m) => m.text === text,
    );

    const posted = await api('POST', `/groups/${groupId}/messages`, {
      token: users.a.token,
      body: { type: 'text', text },
    });
    expect(posted.status).toBe(201);
    expect(posted.json.text).toBe(text);

    const [msgA, msgB] = await Promise.all([onA, onB]);
    expect(msgA.id).toBe(posted.json.id);
    expect(msgB.id).toBe(posted.json.id);
    expect(msgB.userId).toBe(users.a.id);

    // Round-trip persistence: the message is readable via GET.
    const fetched = await api('GET', `/groups/${groupId}/messages`, { token: users.b.token });
    expect(fetched.status).toBe(200);
    expect(fetched.json.messages.some((m: { id: string }) => m.id === posted.json.id)).toBe(true);
  }, 30_000);

  it('DM between two convoy-less users: create via POST /dm, message reaches both sockets', async () => {
    // C and D never join any convoy. Their default privacy is 'open', so the
    // friend request auto-accepts.
    const friendReq = await api('POST', '/friends/requests', {
      token: users.c.token,
      body: { addresseeId: users.d.id },
    });
    expect(friendReq.status).toBe(201);
    expect(friendReq.json.autoAccepted).toBe(true);

    // Sockets authenticated with JWT only — no groupId, no convoy membership.
    socketC = await connectSocket(users.c.token);
    socketD = await connectSocket(users.d.token);

    const dm = await api('POST', '/dm', {
      token: users.c.token,
      body: { friendId: users.d.id },
    });
    expect([200, 201]).toContain(dm.status);
    expect(typeof dm.json.groupId).toBe('string');
    dmGroupIdCD = dm.json.groupId;

    const text = `dm hello ${runId}`;
    const onC = waitForEvent<{ id: string; text: string }>(
      socketC,
      'group:message',
      (m) => m.text === text,
    );
    const onD = waitForEvent<{ id: string; text: string }>(
      socketD,
      'group:message',
      (m) => m.text === text,
    );

    const posted = await api('POST', `/groups/${dmGroupIdCD}/messages`, {
      token: users.c.token,
      body: { type: 'text', text },
    });
    expect(posted.status).toBe(201);

    const [dmC, dmD] = await Promise.all([onC, onD]);
    expect(dmC.id).toBe(posted.json.id);
    expect(dmD.id).toBe(posted.json.id);
  }, 30_000);

  it('concurrent duplicate POST /dm converges to a single channel', async () => {
    // Fresh pair with no existing DM channel: A ↔ C.
    const friendReq = await api('POST', '/friends/requests', {
      token: users.a.token,
      body: { addresseeId: users.c.id },
    });
    expect(friendReq.status).toBe(201);
    expect(friendReq.json.autoAccepted).toBe(true);

    // Both sides open the DM at the same instant — the unique dm-pair index +
    // ON CONFLICT path must converge on one channel, no 500s.
    const [fromA, fromC] = await Promise.all([
      api('POST', '/dm', { token: users.a.token, body: { friendId: users.c.id } }),
      api('POST', '/dm', { token: users.c.token, body: { friendId: users.a.id } }),
    ]);
    expect([200, 201]).toContain(fromA.status);
    expect([200, 201]).toContain(fromC.status);
    expect(typeof fromA.json.groupId).toBe('string');
    expect(fromA.json.groupId).toBe(fromC.json.groupId);
    expect(fromA.json.groupId).not.toBe(dmGroupIdCD);

    // A later duplicate open returns the same channel.
    const again = await api('POST', '/dm', {
      token: users.a.token,
      body: { friendId: users.c.id },
    });
    expect(again.status).toBe(200);
    expect(again.json.groupId).toBe(fromA.json.groupId);
  }, 30_000);

  it('hazard report is created, broadcast as hazard:new, and returned by GET /hazards', async () => {
    // Coordinates deliberately far from the location:update test area so the
    // hazard-proximity path never crosses flows.
    const lat = 51.5074;
    const lng = -0.1278;

    const onHazard = waitForEvent<{ id: string; type: string }>(socketB, 'hazard:new');

    const created = await api('POST', '/hazards', {
      token: users.a.token,
      body: { type: 'pothole', lat, lng, severity: 'medium', note: `smoke ${runId}` },
    });
    expect(created.status).toBe(201);
    expect(created.json.status).toBe('active');
    expect(created.json.type).toBe('pothole');

    const broadcast = await onHazard;
    expect(broadcast.id).toBe(created.json.id);

    const listed = await api('GET', `/hazards?lat=${lat}&lng=${lng}&radius=1000`, {
      token: users.b.token,
    });
    expect(listed.status).toBe(200);
    const hazard = listed.json.hazards.find((h: { id: string }) => h.id === created.json.id);
    expect(hazard).toBeDefined();
    expect(hazard.status).toBe('active');
    expect(hazard.lat).toBeCloseTo(lat, 5);
    expect(hazard.lng).toBeCloseTo(lng, 5);
  }, 30_000);

  it('presence flips offline (with lastSeen) after a socket disconnects', async () => {
    socketB.disconnect();

    const entry = await pollUntil(
      async () => {
        const presence = await presenceVia(socketA, [users.b.id]);
        return presence[0];
      },
      (p) => p !== undefined && !p.isOnline,
    );
    expect(entry.isOnline).toBe(false);
    expect(entry.lastSeen).toBeTruthy();

    // A is still online — only B's presence transitioned.
    const presenceA = await presenceVia(socketA, [users.a.id]);
    expect(presenceA[0].isOnline).toBe(true);
  }, 30_000);
});
