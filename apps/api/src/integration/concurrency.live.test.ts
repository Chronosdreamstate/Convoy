/**
 * LIVE concurrency suite — proves the state-machine transitions that two
 * riders (or two of one rider's devices) can hit at the same instant are
 * decided by the DATABASE, not by a guard the second request has already
 * walked past.
 *
 * These are the bugs no single-request test can see: every check in these
 * routes passes for both callers when they arrive together, so the invariant
 * has to be enforced by a conditional UPDATE, a row lock, a unique index or an
 * atomic Redis claim. Each case below fires two genuinely simultaneous
 * requests through the real routes against the REAL migrated PostGIS database
 * and the REAL Redis, and asserts exactly one of them won.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   1. docker compose up -d      (from the repo root — Postgres + Redis)
 *   2. cd apps/api
 *   3. pnpm test src/integration/concurrency.live.test.ts
 *   Skips itself cleanly when either service is unreachable (LIVE_SMOKE=0
 *   forces a skip), exactly like schema.contract.live.test.ts, whose scratch
 *   database helpers this mirrors. A dedicated `convoy_concurrency` database
 *   is created, migrated and dropped around the suite; Redis work is confined
 *   to db 15 and the keys are deleted afterwards.
 *
 * ── WHAT IT GUARDS ──────────────────────────────────────────────────────────
 *   POST /groups/:id/end      only one end may win (conditional UPDATE)
 *   POST /groups/:id/leave    two simultaneous departures can't strand an
 *                             active group with zero members (row lock)
 *   POST /groups/:id/rally    one active rally per group (advisory lock +
 *                             uq_rally_points_one_active, migration 036)
 *   POST /groups/:id/sos      one SOS per cooldown window (SET NX)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import IORedis, { Redis } from 'ioredis';
import groupsRoutes from '../groups/groups.routes';
import rallyRoutes from '../rally/rally.routes';

// ---------------------------------------------------------------------------
// Infra gate (same TCP-probe approach as schema.contract.live.test.ts)
// ---------------------------------------------------------------------------

const PG_HOST = process.env.LIVE_SMOKE_PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.LIVE_SMOKE_PG_PORT ?? 5432);
const REDIS_HOST = process.env.LIVE_SMOKE_REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.LIVE_SMOKE_REDIS_PORT ?? 6379);
const REDIS_DB = 15; // scratch db — never the app's default 0
const PG_USER = 'convoy';
const PG_PASSWORD = 'convoy';
const SCRATCH_DB = 'convoy_concurrency';
const SCRATCH_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;

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
    `[concurrency.live] Postgres (${PG_HOST}:${PG_PORT}) or Redis (${REDIS_HOST}:${REDIS_PORT}) ` +
      'not reachable — skipping. Start docker compose to enable it.',
  );
}

// ---------------------------------------------------------------------------
// Scratch database helpers
// ---------------------------------------------------------------------------

async function openAdminPool(): Promise<Pool> {
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
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropScratchDatabase(): Promise<void> {
  const admin = await openAdminPool();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Applies src/db/migrations/*.sql in order — same algorithm as src/db/migrate.ts. */
async function migrateScratchDatabase(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const pool = new Pool({ connectionString: SCRATCH_URL, max: 1 });
  const client = await pool.connect();
  try {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
      await client.query(sql);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// App under test — REAL routes, REAL pool, REAL redis
// ---------------------------------------------------------------------------

interface Emitted { room: string; event: string; data: unknown }

let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let emitted: Emitted[] = [];

function buildApp(): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(fastifyCookie);
  instance.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  instance.register(fastifySensible);
  instance.register(fp(async (i) => { i.decorate('db', pool); }, { name: 'db' }));
  instance.register(fp(async (i) => { i.decorate('redis', redis); }, { name: 'redis' }));
  instance.register(fp(async (i) => {
    i.decorate('io', {
      to: (room: string) => ({
        emit: (event: string, data: unknown) => { emitted.push({ room, event, data }); },
      }),
      in: () => ({ disconnectSockets: () => undefined }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    i.decorate('enqueueNotification', async () => undefined);
  }, { name: 'io' }));
  instance.register(groupsRoutes, { prefix: '/api/v1' });
  instance.register(rallyRoutes, { prefix: '/api/v1' });
  return instance;
}

let userSeq = 0;
async function createUser(name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
    [`${name}-${++userSeq}`],
  );
  return res.rows[0].id;
}

let codeSeq = 0;
/** Creates an active group with `memberIds[0]` as Admin and everyone joined. */
async function createGroup(memberIds: string[]): Promise<string> {
  const code = String(100000 + (++codeSeq)).slice(0, 6);
  const g = await pool.query<{ id: string }>(
    `INSERT INTO convoy_groups (name, join_code, admin_id, access_type)
     VALUES ('Race Test', $1, $2, 'open') RETURNING id`,
    [code, memberIds[0]],
  );
  const groupId = g.rows[0].id;
  for (const userId of memberIds) {
    await pool.query(
      `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2)`,
      [groupId, userId],
    );
  }
  return groupId;
}

function authHeaders(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

describeLive('live concurrency: simultaneous requests on one row', () => {
  beforeAll(async () => {
    await recreateScratchDatabase();
    await migrateScratchDatabase();
    // Room for every in-flight request to hold its own transaction client.
    pool = new Pool({ connectionString: SCRATCH_URL, max: 16 });
    redis = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, db: REDIS_DB, maxRetriesPerRequest: 2 });
    await redis.flushdb();
    // Rally creation reverse-geocodes through Mapbox; keep the suite offline
    // (reverseGeocode fails soft to a null address).
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
    app = buildApp();
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.flushdb().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    await pool?.end();
    await dropScratchDatabase();
  }, 60_000);

  beforeEach(() => { emitted = []; });

  // -------------------------------------------------------------------------
  // POST /groups/:id/end — the status guard runs outside the transaction
  // -------------------------------------------------------------------------
  describe('POST /groups/:id/end fired twice at once', () => {
    it('ends the convoy once and reports 410 to the loser', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);
      // Stats the end summary is built from (phone and tablet both read these).
      await redis.set(`group:${groupId}:started_at`, String(Date.now() - 3_600_000));
      await redis.set(`group:${groupId}:distance_m`, '42000');

      const headers = authHeaders(admin);
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/end`, headers }),
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/end`, headers }),
      ]);

      // Pre-fix both requests passed the `status !== 'active'` check before
      // either transaction ran, so BOTH ended the group and BOTH broadcast
      // group:ended — the second one carrying durationS/distanceM 0 once the
      // Redis keys were gone, which is the summary every member was left with.
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);

      const ends = emitted.filter((e) => e.event === 'group:ended');
      expect(ends).toHaveLength(1);
      expect((ends[0].data as { distanceM: number }).distanceM).toBe(42000);

      const row = await pool.query<{ status: string }>(
        'SELECT status FROM convoy_groups WHERE id = $1', [groupId],
      );
      expect(row.rows[0].status).toBe('ended');
    });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/leave — succession read must not see a stale roster
  // -------------------------------------------------------------------------
  describe('the last two members leaving at the same moment', () => {
    it('never leaves an active group with nobody in it', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);

      // The interleaving that produced the ghost convoy is the one where the
      // Admin's departure is a step AHEAD: its succession read runs before the
      // other member's left_at has committed. Whether the network delivers it
      // that way is a coin flip, so a lock held by an outside transaction is
      // used purely as a scheduler — it parks the Admin's request mid-flight
      // until the other member's is under way too, and then releases both.
      // Both departures still go through the real route from end to end.
      const gate = await pool.connect();
      try {
        await gate.query('BEGIN');
        await gate.query('SELECT id FROM convoy_groups WHERE id = $1 FOR UPDATE', [groupId]);

        const adminLeave = app.inject({
          method: 'POST', url: `/api/v1/groups/${groupId}/leave`, headers: authHeaders(admin),
        });
        await new Promise((r) => setTimeout(r, 200));
        const riderLeave = app.inject({
          method: 'POST', url: `/api/v1/groups/${groupId}/leave`, headers: authHeaders(rider),
        });
        await new Promise((r) => setTimeout(r, 200));

        await gate.query('COMMIT');
        const [a, b] = await Promise.all([adminLeave, riderLeave]);
        expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      } finally {
        gate.release();
      }

      // Pre-fix the Admin's transaction could not see the other member's
      // uncommitted left_at, so it handed the admin role to someone who was
      // leaving in that instant: status stayed 'active' with zero active
      // members — a convoy still listed in browse, still joinable by code, and
      // impossible for anyone left to end.
      const row = await pool.query<{ status: string; active: string }>(
        `SELECT g.status,
                (SELECT COUNT(*) FROM convoy_members m
                  WHERE m.group_id = g.id AND m.left_at IS NULL) AS active
         FROM convoy_groups g WHERE g.id = $1`,
        [groupId],
      );
      expect(row.rows[0].active).toBe('0');
      expect(row.rows[0].status).toBe('ended');
    });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/rally — "the active Rally_Point" is singular (Req 20.3)
  // -------------------------------------------------------------------------
  describe('two members setting a rally point at the same moment', () => {
    it('leaves exactly one active rally point', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);

      const [a, b] = await Promise.all([
        app.inject({
          method: 'POST', url: `/api/v1/groups/${groupId}/rally`,
          headers: authHeaders(admin), payload: { lat: 51.5, lng: -0.12, type: 'meetup' },
        }),
        app.inject({
          method: 'POST', url: `/api/v1/groups/${groupId}/rally`,
          headers: authHeaders(rider), payload: { lat: 51.6, lng: -0.13, type: 'fuel' },
        }),
      ]);

      // Both riders' broadcasts must succeed (the loser's simply supersedes the
      // winner's) — a 500 here would mean the serialisation is missing and the
      // unique index is doing the rejecting.
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);

      // Pre-fix: each request deactivated what it could see (nothing) and then
      // inserted is_active = true, so the group carried TWO active rally pins,
      // both broadcast with rally:set and neither ever cancelled.
      const active = await pool.query<{ id: string }>(
        'SELECT id FROM rally_points WHERE group_id = $1 AND is_active = true', [groupId],
      );
      expect(active.rows).toHaveLength(1);

      // The retired one is announced so no stale pin survives on any map.
      const sets = emitted.filter((e) => e.event === 'rally:set');
      const cancels = emitted.filter((e) => e.event === 'rally:cancelled');
      expect(sets).toHaveLength(2);
      expect(cancels).toHaveLength(1);
    });

    it('rejects a second active rally at the schema level (migration 036)', async () => {
      const admin = await createUser('admin');
      const groupId = await createGroup([admin]);
      const insert = `INSERT INTO rally_points (group_id, broadcaster_id, location)
                      VALUES ($1, $2, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography)`;
      await pool.query(insert, [groupId, admin]);
      await expect(pool.query(insert, [groupId, admin])).rejects.toMatchObject({ code: '23505' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/sos — the cooldown is the only thing stopping a duplicate
  // -------------------------------------------------------------------------
  describe('two SOS taps landing together', () => {
    it('broadcasts one emergency, not two', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);
      await redis.del(`sos:cooldown:${rider}`);

      const headers = authHeaders(rider);
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/sos`, headers, payload: { lat: 51.5, lng: -0.12, type: 'breakdown' } }),
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/sos`, headers, payload: { lat: 51.5, lng: -0.12, type: 'breakdown' } }),
      ]);

      // Pre-fix both taps passed the EXISTS check before either wrote the
      // cooldown key, so two SOS ids existed for one emergency while
      // sos:user:<group>:<user> pointed at only one of them: cancelling cleared
      // one pin and left the other on every member's map for two hours.
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 429]);
      expect(emitted.filter((e) => e.event === 'sos:alert')).toHaveLength(1);

      const winner = JSON.parse((a.statusCode === 201 ? a : b).body) as { id: string };
      const handle = await redis.get(`sos:user:${groupId}:${rider}`);
      expect(handle).toBe(winner.id);
    });

    it('stands the emergency down once when the rider and the Admin both clear it', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);
      await redis.del(`sos:cooldown:${rider}`);

      const created = await app.inject({
        method: 'POST', url: `/api/v1/groups/${groupId}/sos`,
        headers: authHeaders(rider), payload: { lat: 51.5, lng: -0.12, type: 'medical' },
      });
      const { id: sosId } = JSON.parse(created.body) as { id: string };
      emitted = [];

      // The rider stands their own SOS down at the same moment the Admin clears
      // it for them — both are allowed to cancel (Req 25.6).
      const [a, b] = await Promise.all([
        app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}/sos/${sosId}`, headers: authHeaders(rider) }),
        app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}/sos/${sosId}`, headers: authHeaders(admin) }),
      ]);

      // Pre-fix both read the pin from Redis before either deleted it, so both
      // announced the stand-down.
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
      expect(emitted.filter((e) => e.event === 'sos:cancelled')).toHaveLength(1);
      expect(await redis.get(`sos:${sosId}`)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /groups/:id/rally/:rallyId — the is_active check is a read
  // -------------------------------------------------------------------------
  describe('the broadcaster and the Admin cancelling one rally together', () => {
    it('announces the cancellation once', async () => {
      const admin = await createUser('admin');
      const rider = await createUser('rider');
      const groupId = await createGroup([admin, rider]);

      const created = await app.inject({
        method: 'POST', url: `/api/v1/groups/${groupId}/rally`,
        headers: authHeaders(rider), payload: { lat: 51.5, lng: -0.12, type: 'rest' },
      });
      const { id: rallyId } = JSON.parse(created.body) as { id: string };
      emitted = [];

      const [a, b] = await Promise.all([
        app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}/rally/${rallyId}`, headers: authHeaders(rider) }),
        app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}/rally/${rallyId}`, headers: authHeaders(admin) }),
      ]);

      // Pre-fix both passed the is_active read and both emitted rally:cancelled.
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(emitted.filter((e) => e.event === 'rally:cancelled')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/waypoints — read-then-replace decides the achievement
  // -------------------------------------------------------------------------
  describe('the Admin saving the route from two devices at once', () => {
    it('credits the waypoints added once, not once per device', async () => {
      const admin = await createUser('admin');
      const groupId = await createGroup([admin]);

      const wp = (n: number) => Array.from({ length: n }, (_, i) => ({
        id: `w${i}`, name: `Stop ${i}`, address: `${i} Test Road`, type: 'waypoint' as const,
      }));
      // Existing route: 3 stops.
      await pool.query('UPDATE convoy_groups SET waypoints = $1::jsonb WHERE id = $2', [JSON.stringify(wp(3)), groupId]);

      const headers = authHeaders(admin);
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/waypoints`, headers, payload: { waypoints: wp(5) } }),
        app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/waypoints`, headers, payload: { waypoints: wp(5) } }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

      // The counter write is fire-and-forget, so let both land before reading.
      await new Promise((r) => setTimeout(r, 300));

      // Pre-fix both requests read the same 3-stop "before" list and each
      // credited 2 added, so a route that grew 3 -> 5 once moved the
      // waypoint_setter achievement (target 10) forward by 4.
      const counter = await pool.query<{ count: number }>(
        `SELECT count FROM user_stat_counters WHERE user_id = $1 AND stat_key = 'waypoint_setter'`,
        [admin],
      );
      expect(counter.rows[0]?.count ?? 0).toBe(2);

      const stored = await pool.query<{ waypoints: unknown[] }>(
        'SELECT waypoints FROM convoy_groups WHERE id = $1', [groupId],
      );
      expect(stored.rows[0].waypoints).toHaveLength(5);
    });
  });
});
