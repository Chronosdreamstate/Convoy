/**
 * Route-level tests for hazard report rate limiting (Req 37.1).
 *
 * POST /hazards is capped at 10 reports per user per hour by the shared
 * hazardReportLimiter preHandler (composed after authenticate), and
 * POST /hazards/bulk counts every item in a batch against the SAME Redis
 * bucket, so offline sync cannot bypass the per-user cap.
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
// In-memory store
// ---------------------------------------------------------------------------

let counters: Map<string, number>;
let hazardIdCounter: number;

function resetStore(): void {
  counters = new Map();
  hazardIdCounter = 0;
}

function buildMockPool(): Pool {
  const insertRow = () => ({
    rows: [{ id: `00000000-0000-0000-0000-${String(++hazardIdCounter).padStart(12, '0')}`, created_at: new Date() }],
    rowCount: 1,
  });

  return {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (normalized.startsWith('INSERT INTO HAZARD_REPORTS')) return insertRow();
      return { rows: [], rowCount: 0 };
    },
    connect: async (): Promise<PoolClient> =>
      ({
        query: async (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
          if (normalized.startsWith('INSERT INTO HAZARD_REPORTS')) return insertRow();
          return { rows: [], rowCount: 0 }; // BEGIN/COMMIT/ROLLBACK
        },
        release: () => {},
      }) as unknown as PoolClient,
  } as unknown as Pool;
}

function buildMockRedis(): Redis {
  return {
    incr: async (key: string): Promise<number> => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    incrby: async (key: string, by: number): Promise<number> => {
      const next = (counters.get(key) ?? 0) + by;
      counters.set(key, next);
      return next;
    },
    decrby: async (key: string, by: number): Promise<number> => {
      const next = (counters.get(key) ?? 0) - by;
      counters.set(key, next);
      return next;
    },
    expire: async () => {},
    ttl: async () => 3600,
    ping: async () => 'PONG',
    quit: async () => {},
  } as unknown as Redis;
}

const JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long!!';

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyJwt, { secret: JWT_SECRET, sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', buildMockRedis()); }, { name: 'redis' }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.register(fp(async (i) => { i.decorate('io', { emit: () => true, to: () => ({ emit: () => true }) } as any); }, { name: 'io' }));
  app.register(hazardsRoutes, { prefix: '/api/v1' });

  return app;
}

function bearerFor(app: FastifyInstance, userId: string): Record<string, string> {
  return { Authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

const USER_A = '00000000-0000-0000-0000-0000000000a1';
const USER_B = '00000000-0000-0000-0000-0000000000b1';

const validHazard = { type: 'pothole', lat: 51.5, lng: -0.12 };

function postHazard(app: FastifyInstance, userId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/hazards',
    headers: bearerFor(app, userId),
    payload: validHazard,
  });
}

// ---------------------------------------------------------------------------
// Req 37.1: max 10 hazard reports per user per hour
// ---------------------------------------------------------------------------

describe('Req 37.1: POST /hazards rate limiting', () => {
  beforeEach(resetStore);

  it(`allows ${hazardReportLimit.max} reports then returns 429 with Retry-After`, async () => {
    const app = buildTestApp();
    await app.ready();

    for (let i = 0; i < hazardReportLimit.max; i++) {
      const res = await postHazard(app, USER_A);
      expect(res.statusCode).toBe(201);
    }

    const throttled = await postHazard(app, USER_A);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    const body = JSON.parse(throttled.body) as { error: string };
    expect(body.error).toContain('Rate limit exceeded');

    await app.close();
  });

  it('keys the limit per user: another user still gets 201 after the first is throttled', async () => {
    const app = buildTestApp();
    await app.ready();

    for (let i = 0; i < hazardReportLimit.max + 1; i++) {
      await postHazard(app, USER_A);
    }

    const other = await postHazard(app, USER_B);
    expect(other.statusCode).toBe(201);

    await app.close();
  });

  it('requires authentication: an unauthenticated request is 401, not counted', async () => {
    const app = buildTestApp();
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/v1/hazards', payload: validHazard });
    expect(res.statusCode).toBe(401);
    expect(counters.size).toBe(0);

    await app.close();
  });

  it('shares one bucket with POST /hazards/bulk: 10 singles exhaust the bulk quota too', async () => {
    const app = buildTestApp();
    await app.ready();

    for (let i = 0; i < hazardReportLimit.max; i++) {
      const res = await postHazard(app, USER_A);
      expect(res.statusCode).toBe(201);
    }

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/hazards/bulk',
      headers: bearerFor(app, USER_A),
      payload: { hazards: [validHazard] },
    });
    expect(bulk.statusCode).toBe(429);

    await app.close();
  });

  it('shares one bucket with POST /hazards/bulk: a full bulk batch exhausts the single-report quota', async () => {
    const app = buildTestApp();
    await app.ready();

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/hazards/bulk',
      headers: bearerFor(app, USER_A),
      payload: { hazards: Array.from({ length: hazardReportLimit.max }, () => validHazard) },
    });
    expect(bulk.statusCode).toBe(201);

    const single = await postHazard(app, USER_A);
    expect(single.statusCode).toBe(429);

    await app.close();
  });
});
