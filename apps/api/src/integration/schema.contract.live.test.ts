/**
 * LIVE schema-contract suite — proves that every value the route zod schemas
 * ACCEPT can actually be stored by the column it lands in, against the REAL
 * migrated PostGIS database (no in-memory pool doubles).
 *
 * This is the one class of bug an in-memory mock pool can never catch: a mock
 * happily "stores" 1000.0 in a NUMERIC(5,2) or 360 in a column with
 * CHECK (direction < 360), so a zod bound that is one step wider than the
 * column looks fine in unit tests and 500s in production.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   1. docker compose up -d      (from the repo root — starts convoy_postgres)
 *   2. cd apps/api
 *   3. pnpm test src/integration/schema.contract.live.test.ts
 *   The suite SKIPS itself cleanly when Postgres is unreachable
 *   (LIVE_SMOKE=0 forces a skip; LIVE_SMOKE_PG_HOST / LIVE_SMOKE_PG_PORT
 *   retarget it), so `pnpm test` never breaks without docker.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *   A dedicated scratch database `convoy_schema_contract` is dropped,
 *   recreated and migrated from src/db/migrations at suite start and dropped
 *   again at the end. The dev `convoy` database is never written to. Redis is
 *   not needed: generalLimiter no-ops under NODE_ENV=test and these routes use
 *   no other Redis path.
 *
 * ── WHAT IT GUARDS ──────────────────────────────────────────────────────────
 *   drives         avg_speed_kph / top_speed_kph  NUMERIC(5,2)
 *                  distance_m / duration_s        INTEGER
 *                  member_count                   SMALLINT
 *                  GET /drives page ordering is total (ended_at ties)
 *   speed-cameras  direction        INTEGER, CHECK (>= 0 AND < 360)
 *                  speed_limit_kph  CHECK (> 0)
 *   fuel           gallons / price_per_gallon  NUMERIC(8,3), CHECK (> 0)
 *                  odometer_km                 NUMERIC(10,2), CHECK (> 0)
 *                  mpg                         NUMERIC(8,2)
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
import type { Redis } from 'ioredis';
import drivesRoutes from '../drives/drives.routes';
import fuelRoutes from '../fuel/fuel.routes';
import speedCamerasRoutes from '../speed-cameras/speed-cameras.routes';

// ---------------------------------------------------------------------------
// Infra gate (same TCP-probe approach as live.smoke.test.ts)
// ---------------------------------------------------------------------------

const PG_HOST = process.env.LIVE_SMOKE_PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.LIVE_SMOKE_PG_PORT ?? 5432);
const PG_USER = 'convoy';
const PG_PASSWORD = 'convoy';
const SCRATCH_DB = 'convoy_schema_contract';
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

const infraUp = process.env.LIVE_SMOKE !== '0' && tcpReachable(PG_HOST, PG_PORT);
const describeLive = infraUp ? describe : describe.skip;

if (!infraUp) {
  // eslint-disable-next-line no-console
  console.warn(
    `[schema.contract.live] Postgres (${PG_HOST}:${PG_PORT}) not reachable — skipping. ` +
      'Start docker compose to enable it.',
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
// App under test — REAL routes, REAL pool
// ---------------------------------------------------------------------------

let pool: Pool;
let app: FastifyInstance;
let userId: string;
let token: string;

function buildApp(): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(fastifyCookie);
  instance.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  instance.register(fastifySensible);
  instance.register(fp(async (i) => { i.decorate('db', pool); }, { name: 'db' }));
  // generalLimiter no-ops under NODE_ENV=test, so no Redis calls are made.
  instance.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
  instance.register(drivesRoutes, { prefix: '/api/v1' });
  instance.register(fuelRoutes, { prefix: '/api/v1' });
  instance.register(speedCamerasRoutes, { prefix: '/api/v1' });
  return instance;
}

function driveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routeTrace: { type: 'LineString', coordinates: [[-0.12, 51.5], [-0.13, 51.51]] },
    distanceM: 1000,
    durationS: 60,
    memberCount: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

describeLive('live schema contract: zod bounds vs real column constraints', () => {
  beforeAll(async () => {
    await recreateScratchDatabase();
    await migrateScratchDatabase();
    pool = new Pool({ connectionString: SCRATCH_URL, max: 4 });
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ('Contract Tester') RETURNING id`,
    );
    userId = u.rows[0].id;
    app = buildApp();
    await app.ready();
    token = app.jwt.sign({ sub: userId });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await dropScratchDatabase();
  }, 60_000);

  beforeEach(async () => {
    await pool.query('DELETE FROM drive_history');
    await pool.query('DELETE FROM fuel_logs');
    await pool.query('DELETE FROM speed_camera_votes');
    await pool.query('DELETE FROM speed_cameras');
  });

  const auth = { get headers() { return { Authorization: `Bearer ${token}` }; } };

  // -------------------------------------------------------------------------
  // drives: avg_speed_kph / top_speed_kph are NUMERIC(5,2)
  // -------------------------------------------------------------------------
  describe('POST /drives speed columns (NUMERIC(5,2))', () => {
    it('stores a speed the column can hold', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/drives', headers: auth.headers,
        payload: driveBody({ avgSpeedKph: 999.99, topSpeedKph: 999.99 }),
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).topSpeedKph).toBe(999.99);
    });

    it('still saves the drive when a glitched GPS fix makes the speed unstorable', async () => {
      // Regression: avg/top speed were passed straight through to a
      // NUMERIC(5,2) column, so a single bad fix (topSpeedKph 1080 = 300 m/s)
      // raised "numeric field overflow" -> 500. DriveService.finishSession
      // catches that, keeps the drive in SQLite and SyncService re-POSTs it on
      // every reconnect forever, so the drive NEVER reached Drive History.
      const res = await app.inject({
        method: 'POST', url: '/api/v1/drives', headers: auth.headers,
        payload: driveBody({ avgSpeedKph: 3600, topSpeedKph: 1080 }),
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { avgSpeedKph: number | null; topSpeedKph: number | null };
      // The impossible reading is dropped ("—" in the UI); the drive is kept.
      expect(body.avgSpeedKph).toBeNull();
      expect(body.topSpeedKph).toBeNull();

      const stored = await pool.query<{ distance_m: number; avg_speed_kph: string | null }>(
        'SELECT distance_m, avg_speed_kph FROM drive_history WHERE user_id = $1', [userId],
      );
      expect(stored.rows).toHaveLength(1);
      expect(Number(stored.rows[0].distance_m)).toBe(1000);
      expect(stored.rows[0].avg_speed_kph).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // drives: distance_m / duration_s INTEGER, member_count SMALLINT
  // -------------------------------------------------------------------------
  describe('POST /drives integer columns', () => {
    it.each([
      ['distanceM', { distanceM: 3_000_000_000 }],
      ['durationS', { durationS: 3_000_000_000 }],
      ['memberCount', { memberCount: 40_000 }],
    ])('rejects an out-of-range %s with 400 instead of 500', async (_label, override) => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/drives', headers: auth.headers,
        payload: driveBody(override),
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts the largest value each column can hold', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/drives', headers: auth.headers,
        payload: driveBody({ distanceM: 2_147_483_647, durationS: 2_147_483_647, memberCount: 32_767 }),
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // drives: GET /drives paging must be a total order
  // -------------------------------------------------------------------------
  describe('GET /drives paging over tied ended_at values', () => {
    // ended_at is client-supplied and NOT unique, so `ORDER BY ended_at DESC`
    // alone is not a total order: the order among tied rows is whatever the
    // chosen plan happens to produce, and it is free to change between the
    // requests that fetch page 1 and page 3. Generating a share card
    // (POST /drives/:id/summary-card) UPDATEs a row, which relocates it in the
    // heap -- so under a sequential-scan plan a drive already returned on page
    // 1 comes back on a later page while another is never returned at all.
    // That is the exact sequence a user performs: open Drive History, share a
    // drive, keep scrolling; DriveHistoryScreen's CSV export sweeps every page
    // the same way, so an export both duplicates and drops drives.
    //
    // The plan is pinned to a sequential scan for this test (the planner picks
    // it freely on small or freshly-vacuumed tables) so the reproduction is
    // deterministic rather than dependent on which plan today's statistics
    // happen to favour.
    let seqPool: Pool;
    let seqApp: FastifyInstance;

    beforeAll(async () => {
      seqPool = new Pool({
        connectionString: SCRATCH_URL,
        max: 1,
        options: '-c enable_indexscan=off -c enable_bitmapscan=off',
      });
      const inner = Fastify({ logger: false });
      inner.register(fastifyCookie);
      inner.register(fastifyJwt, {
        secret: 'test-secret-that-is-at-least-32-chars-long!!',
        sign: { expiresIn: '15m' },
      });
      inner.register(fastifySensible);
      inner.register(fp(async (i) => { i.decorate('db', seqPool); }, { name: 'db' }));
      inner.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
      inner.register(drivesRoutes, { prefix: '/api/v1' });
      await inner.ready();
      seqApp = inner;
    });

    afterAll(async () => {
      await seqApp?.close();
      await seqPool?.end();
    });

    it('returns every drive exactly once when a row is rewritten mid-paging', async () => {
      const tied = '2026-02-01T12:00:00.000Z';
      for (let i = 0; i < 6; i++) {
        await pool.query(
          `INSERT INTO drive_history
             (user_id, route_trace, distance_m, duration_s, member_count, started_at, ended_at)
           VALUES ($1, '{"type":"LineString","coordinates":[[0,0],[1,1]]}'::jsonb, $2, 60, 1, $3, $4)`,
          [userId, 100 + i, `2026-02-01T1${i}:00:00.000Z`, tied],
        );
      }

      const readPage = async (page: number): Promise<string[]> => {
        const res = await seqApp.inject({
          method: 'GET', url: `/api/v1/drives?page=${page}&limit=2`, headers: auth.headers,
        });
        expect(res.statusCode).toBe(200);
        return (JSON.parse(res.body) as { drives: Array<{ id: string }> }).drives.map((d) => d.id);
      };

      const seen = await readPage(1);

      // Rewrite the first drive on page 1 through the real endpoint.
      const card = await seqApp.inject({
        method: 'POST', url: `/api/v1/drives/${seen[0]}/summary-card`, headers: auth.headers,
      });
      expect(card.statusCode).toBe(200);

      seen.push(...(await readPage(2)));
      seen.push(...(await readPage(3)));

      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // speed cameras: direction / speed_limit_kph
  // -------------------------------------------------------------------------
  describe('POST /speed-cameras numeric bounds', () => {
    it('accepts the largest direction the CHECK allows', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/speed-cameras', headers: auth.headers,
        payload: { lat: 51.5, lng: -0.12, type: 'fixed', direction: 359, speedLimitKph: 50 },
      });
      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['direction 360 (CHECK direction < 360)', { direction: 360 }],
      ['a fractional direction (column is INTEGER)', { direction: 45.5 }],
      ['speedLimitKph 0 (CHECK speed_limit_kph > 0)', { speedLimitKph: 0 }],
    ])('rejects %s with 400 instead of 500', async (_label, override) => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/speed-cameras', headers: auth.headers,
        payload: { lat: 51.5, lng: -0.12, type: 'fixed', ...override },
      });
      expect(res.statusCode).toBe(400);
      const stored = await pool.query('SELECT 1 FROM speed_cameras');
      expect(stored.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // fuel logs: NUMERIC scale rounds sub-precision values to 0, tripping CHECK (> 0)
  // -------------------------------------------------------------------------
  describe('POST /fuel/logs numeric precision', () => {
    it('accepts the smallest storable gallons / price / odometer', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/fuel/logs', headers: auth.headers,
        payload: { gallons: 0.001, pricePerGallon: 0.001, odometerKm: 0.01 },
      });
      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['gallons below NUMERIC(8,3) precision', { gallons: 0.0001, pricePerGallon: 3 }],
      ['pricePerGallon below NUMERIC(8,3) precision', { gallons: 10, pricePerGallon: 0.0004 }],
      ['odometerKm below NUMERIC(10,2) precision', { gallons: 10, pricePerGallon: 3, odometerKm: 0.001 }],
    ])('rejects %s with 400 instead of 500', async (_label, payload) => {
      // These round to 0.000 / 0.00 on the way in and then violate the
      // column's CHECK (> 0) — an unexplained 500 before the schema was
      // tightened to the column's real precision.
      const res = await app.inject({
        method: 'POST', url: '/api/v1/fuel/logs', headers: auth.headers, payload,
      });
      expect(res.statusCode).toBe(400);
    });

    it('stores the fill-up when a mistyped odometer computes an unstorable mpg', async () => {
      // mpg is NUMERIC(8,2): a fat-fingered odometer produces > 1e6 mpg, which
      // used to overflow and 500 the whole entry instead of just dropping the
      // derived figure.
      const first = await app.inject({
        method: 'POST', url: '/api/v1/fuel/logs', headers: auth.headers,
        payload: { gallons: 10, pricePerGallon: 3, odometerKm: 50_000, date: '2026-03-01T00:00:00.000Z' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST', url: '/api/v1/fuel/logs', headers: auth.headers,
        payload: { gallons: 5, pricePerGallon: 3, odometerKm: 9_999_999, date: '2026-03-02T00:00:00.000Z' },
      });
      expect(second.statusCode).toBe(201);
      expect(JSON.parse(second.body).mpg).toBeUndefined();

      const stored = await pool.query('SELECT 1 FROM fuel_logs WHERE user_id = $1', [userId]);
      expect(stored.rowCount).toBe(2);
    });
  });
});
