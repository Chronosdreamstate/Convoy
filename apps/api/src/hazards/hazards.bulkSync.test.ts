/**
 * POST /hazards/bulk — offline backlog sync (Req 11.10).
 *
 * Two behaviours this endpoint has to get right, because the device replays it
 * at least once by design and can arrive with more reports than the hourly cap:
 *
 *  1. PARTIAL acceptance. A driver who logged 12 hazards across a long dead
 *     zone used to get a flat 429 for the whole batch; the client re-sent all
 *     12 on the next reconnect, blew the cap again, and the backlog could never
 *     drain. The batch is now trimmed to the remaining quota and the response
 *     reports how many were settled so the client clears exactly those.
 *
 *  2. Replay idempotence. If the response is lost after the transaction
 *     commits, the device still holds the batch and re-sends it. A second copy
 *     of every hazard must not be inserted, and must not be re-broadcast to
 *     the convoy.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import hazardsRoutes from './hazards.routes';
import { hazardReportLimit } from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Mock store — models the WHERE NOT EXISTS guard on
// (reporter_id, hazard_type, created_at, location)
// ---------------------------------------------------------------------------

let counters: Map<string, number>;
let rows: Array<{ id: string; key: string }>;
let emitted: unknown[];
let idSeq: number;

function reset(): void {
  counters = new Map();
  rows = [];
  emitted = [];
  idSeq = 0;
}

function buildMockPool(): Pool {
  const runInsert = (params: unknown[]) => {
    // [userId, type, lng, lat, expires, created]
    const key = [params[0], params[1], params[2], params[3], (params[5] as Date).getTime()].join('|');
    if (rows.some((r) => r.key === key)) return { rows: [], rowCount: 0 };
    const id = `00000000-0000-0000-0000-${String(++idSeq).padStart(12, '0')}`;
    rows.push({ id, key });
    return { rows: [{ id, created_at: new Date() }], rowCount: 1 };
  };

  const handle = (sql: string, params: unknown[] = []) => {
    if (sql.replace(/\s+/g, ' ').trim().toUpperCase().startsWith('INSERT INTO HAZARD_REPORTS')) {
      return runInsert(params);
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query: async (sql: string, params?: unknown[]) => handle(sql, params),
    connect: async (): Promise<PoolClient> => ({
      query: async (sql: string, params?: unknown[]) => handle(sql, params),
      release: () => {},
    }) as unknown as PoolClient,
  } as unknown as Pool;
}

function buildMockRedis(): Redis {
  return {
    incr: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
    incrby: async (k: string, by: number) => { const n = (counters.get(k) ?? 0) + by; counters.set(k, n); return n; },
    decrby: async (k: string, by: number) => { const n = (counters.get(k) ?? 0) - by; counters.set(k, n); return n; },
    expire: async () => {},
    ttl: async () => 3600,
  } as unknown as Redis;
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', buildMockRedis()); }, { name: 'redis' }));
  app.register(fp(async (i) => {
    i.decorate('io', {
      emit: (_event: string, payload: unknown) => { emitted.push(payload); return true; },
      to: () => ({ emit: () => true }),
    } as never);
  }, { name: 'io' }));
  app.register(hazardsRoutes, { prefix: '/api/v1' });
  return app;
}

const USER = '00000000-0000-0000-0000-0000000000a1';
const CAP = hazardReportLimit.max;

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(reset);

/**
 * A batch of distinct hazards, each with its own createdAt and location.
 * Timestamps sit a few minutes in the past so the reports are still inside the
 * 30-minute hazard TTL — an already-expired report is inserted but knowingly
 * not broadcast, which would mask the idempotence assertions below.
 * `group` shifts a batch clear of any other so the batches never collide.
 */
const NOW = Date.now();
function batch(n: number, group = 0) {
  return Array.from({ length: n }, (_, i) => {
    const seq = group * 100 + i;
    return {
      type: 'pothole',
      lat: 51.5 + seq / 10_000,
      lng: -0.12 - seq / 10_000,
      createdAt: NOW - 300_000 + seq * 1_000,
    };
  });
}

function sync(hazards: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/hazards/bulk',
    headers: { Authorization: `Bearer ${app.jwt.sign({ sub: USER })}` },
    payload: { hazards },
  });
}

// ---------------------------------------------------------------------------

describe('partial acceptance under the hourly cap', () => {
  it(`takes the first ${CAP} of an oversized backlog and defers the rest`, async () => {
    const res = await sync(batch(CAP + 4));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(CAP);
    expect(body.deferred).toBe(4);
    expect(body.count).toBe(CAP);
    expect(rows).toHaveLength(CAP);
  });

  it('the deferred remainder syncs once the window resets — the backlog is never stuck', async () => {
    const all = batch(CAP + 4);
    const first = JSON.parse((await sync(all)).body);

    // Client clears what was accepted and keeps the rest.
    const leftover = all.slice(first.accepted);
    expect(leftover).toHaveLength(4);

    counters.clear(); // hourly window expires
    const second = await sync(leftover);

    expect(second.statusCode).toBe(201);
    expect(JSON.parse(second.body).accepted).toBe(4);
    expect(rows).toHaveLength(CAP + 4);
  });

  it('does not charge the quota for what it deferred', async () => {
    await sync(batch(CAP + 4));
    expect([...counters.values()][0]).toBe(CAP);
  });

  it('still 429s when no quota is left at all', async () => {
    await sync(batch(CAP));
    const res = await sync(batch(1, 1));

    expect(res.statusCode).toBe(429);
    expect(rows).toHaveLength(CAP);
  });

  it('trims to the quota a partly-used window leaves', async () => {
    await sync(batch(4));
    const res = await sync(batch(6, 1));

    expect(JSON.parse(res.body).accepted).toBe(CAP - 4);
    expect(JSON.parse(res.body).deferred).toBe(6 - (CAP - 4));
  });
});

describe('replay idempotence', () => {
  it('a re-sent batch inserts nothing new and re-broadcasts nothing', async () => {
    const items = batch(3);

    const first = await sync(items);
    expect(JSON.parse(first.body).count).toBe(3);
    expect(rows).toHaveLength(3);
    expect(emitted).toHaveLength(3);

    emitted = [];
    const replay = await sync(items);

    expect(replay.statusCode).toBe(201);
    expect(rows).toHaveLength(3);          // no duplicate pins
    expect(emitted).toHaveLength(0);       // convoy not spammed again
    // Still reported as settled, so the client clears them instead of
    // retrying forever.
    expect(JSON.parse(replay.body).accepted).toBe(3);
    expect(JSON.parse(replay.body).count).toBe(0);
  });

  it('refunds the quota for reports recognised as replays', async () => {
    const items = batch(3);
    await sync(items);
    await sync(items);

    // Three reports were filed, so three is all the reporter should be charged.
    expect([...counters.values()][0]).toBe(3);
  });

  it('a genuinely new report alongside a replayed one is still inserted', async () => {
    const items = batch(2);
    await sync(items);

    const mixed = [...items, ...batch(1, 2)];
    const res = await sync(mixed);

    expect(JSON.parse(res.body).count).toBe(1);
    expect(JSON.parse(res.body).accepted).toBe(3);
    expect(rows).toHaveLength(3);
  });
});
