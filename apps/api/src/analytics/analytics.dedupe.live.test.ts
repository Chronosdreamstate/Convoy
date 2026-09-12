/**
 * LIVE test — proves that re-delivering an analytics batch stores it ONCE,
 * against the REAL migrated database.
 *
 * This has to be a live test. The bug being guarded is that the route's
 * `ON CONFLICT DO NOTHING` had no conflict target and no unique index behind
 * it, which made it a guaranteed no-op — and a mock pool "dedupes" nothing
 * either way, so a unit test cannot tell a working conflict clause from a
 * decorative one. Only a real index can.
 *
 * Why it matters: the mobile client delivers this batch at-least-once.
 * AnalyticsService.flush() puts the batch back on its queue whenever a
 * response is lost, so a request that committed but whose reply never arrived
 * (dead zone, timeout — routine for a driving app) is sent again, inflating
 * exactly the counts the table exists to report. See migration 039.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   1. docker compose up -d      (from the repo root — starts convoy_postgres)
 *   2. cd apps/api
 *   3. pnpm test src/analytics/analytics.dedupe.live.test.ts
 *   Skips itself cleanly when Postgres is unreachable (LIVE_SMOKE=0 forces a
 *   skip; LIVE_SMOKE_PG_HOST / LIVE_SMOKE_PG_PORT retarget it), so
 *   `pnpm test` never breaks without docker.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *   Its own scratch database `convoy_analytics_dedupe`, dropped, recreated and
 *   migrated at suite start and dropped at the end. The dev `convoy` database
 *   is never written to.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import analyticsRoutes from './analytics.routes';

const PG_HOST = process.env.LIVE_SMOKE_PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.LIVE_SMOKE_PG_PORT ?? 5432);
const PG_USER = 'convoy';
const PG_PASSWORD = 'convoy';
const SCRATCH_DB = 'convoy_analytics_dedupe';
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
    `[analytics.dedupe.live] Postgres (${PG_HOST}:${PG_PORT}) not reachable — skipping. ` +
      'Start docker compose to enable it.',
  );
}

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

let pool: Pool;
let app: FastifyInstance;

function buildApp(): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  instance.register(fastifySensible);
  instance.register(fp(async (i) => { i.decorate('db', pool); }, { name: 'db' }));
  // The ingest limiter no-ops under NODE_ENV=test, so no Redis calls are made.
  instance.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
  instance.register(analyticsRoutes, { prefix: '/api/v1' });
  return instance;
}

async function countEvents(anonymousId: string): Promise<number> {
  const res = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM analytics_events WHERE anonymous_id = $1',
    [anonymousId],
  );
  return Number(res.rows[0].count);
}

function post(anonymousId: string, events: unknown[]): Promise<{ statusCode: number; json: () => { stored?: number } }> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/analytics/events',
    payload: { anonymousId, platform: 'ios', events },
  }) as unknown as Promise<{ statusCode: number; json: () => { stored?: number } }>;
}

describeLive('POST /analytics/events — idempotent ingest (live)', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    await recreateScratchDatabase();
    await migrateScratchDatabase();
    pool = new Pool({ connectionString: SCRATCH_URL, max: 4 });
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await dropScratchDatabase();
  });

  it('stores a re-delivered batch exactly once', async () => {
    const anon = 'anon-replay';
    const batch = [
      { id: 'evt-1', event: 'convoy_started', props: { groupSize: 4 }, ts: Date.UTC(2026, 0, 2) },
      { id: 'evt-2', event: 'group_created', props: {}, ts: Date.UTC(2026, 0, 2) },
    ];

    // First delivery: the API commits, but the response is lost on the way
    // back to the phone, so the client puts the batch back on its queue.
    const first = await post(anon, batch);
    expect(first.statusCode).toBe(200);
    expect(first.json().stored).toBe(2);
    expect(await countEvents(anon)).toBe(2);

    // Second delivery of the very same events.
    const second = await post(anon, batch);
    expect(second.statusCode).toBe(200);
    expect(second.json().stored).toBe(0);

    // Before migration 039 this read 4, double-counting the convoy.
    expect(await countEvents(anon)).toBe(2);
  });

  it('still stores the events of a partially-overlapping batch', async () => {
    const anon = 'anon-partial';
    await post(anon, [
      { id: 'p-1', event: 'ptt_used', props: { durationSec: 3 }, ts: Date.UTC(2026, 0, 3) },
    ]);

    // The retry carries the un-acknowledged event plus whatever was recorded
    // since. Dedupe must not swallow the new one.
    const res = await post(anon, [
      { id: 'p-1', event: 'ptt_used', props: { durationSec: 3 }, ts: Date.UTC(2026, 0, 3) },
      { id: 'p-2', event: 'hazard_reported', props: { type: 'police' }, ts: Date.UTC(2026, 0, 3) },
    ]);

    expect(res.json().stored).toBe(1);
    expect(await countEvents(anon)).toBe(2);
  });

  it('collapses an id repeated within a single batch', async () => {
    const anon = 'anon-intrabatch';
    // Postgres cannot apply ON CONFLICT to two rows of the same statement, so
    // without the in-handler dedupe this INSERT stores both copies.
    const res = await post(anon, [
      { id: 'dup', event: 'friend_added', props: {}, ts: Date.UTC(2026, 0, 4) },
      { id: 'dup', event: 'friend_added', props: {}, ts: Date.UTC(2026, 0, 4) },
    ]);

    expect(res.statusCode).toBe(200);
    expect(await countEvents(anon)).toBe(1);
  });

  it('scopes dedupe per install, so one device cannot suppress another', async () => {
    // anonymousId is client-supplied on an unauthenticated endpoint. If the
    // unique index were on event_id alone, replaying another install's ids
    // would silently discard their events.
    await post('anon-device-a', [
      { id: 'shared-id', event: 'group_joined', props: {}, ts: Date.UTC(2026, 0, 5) },
    ]);
    const res = await post('anon-device-b', [
      { id: 'shared-id', event: 'group_joined', props: {}, ts: Date.UTC(2026, 0, 5) },
    ]);

    expect(res.json().stored).toBe(1);
    expect(await countEvents('anon-device-a')).toBe(1);
    expect(await countEvents('anon-device-b')).toBe(1);
  });

  it('accepts events from a client too old to send an id', async () => {
    const anon = 'anon-legacy';
    const legacy = [{ event: 'screen_viewed', props: { screen: 'Map' }, ts: Date.UTC(2026, 0, 6) }];

    await post(anon, legacy);
    await post(anon, legacy);

    // No id means no dedupe key — these stay exactly as double-countable as
    // they were before, which is the deliberate trade against rejecting them.
    expect(await countEvents(anon)).toBe(2);
  });
});
