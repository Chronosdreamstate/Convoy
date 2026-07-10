/**
 * Regression tests for the analytics ingest endpoint.
 *
 * Covers:
 *  - Out-of-range `ts` values are rejected with 400 instead of crashing
 *    (previously `new Date(1e18).toISOString()` threw a RangeError → 500).
 *  - A batch of events is written with a single multi-row INSERT (was one
 *    query per event — up to 50 round-trips per unauthenticated request).
 *  - Basic schema enforcement (platform enum, maxItems).
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import analyticsRoutes from './analytics.routes';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

let queries: CapturedQuery[];

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifySensible);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });

  app.register(
    fp(async (instance) => {
      const mockPool = {
        query: async (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          return { rows: [], rowCount: 0 };
        },
      } as unknown as Pool;
      instance.decorate('db', mockPool);
    }),
    { name: 'db' },
  );

  app.register(analyticsRoutes, { prefix: '/api/v1' });
  return app;
}

beforeEach(() => {
  queries = [];
});

describe('POST /analytics/events', () => {
  const basePayload = {
    anonymousId: 'anon-123',
    platform: 'ios',
  };

  it('rejects an out-of-range ts with 400 instead of a 500 RangeError crash', async () => {
    const app = buildTestApp();
    await app.ready();

    for (const badTs of [1e18, -5, 8.64e15 + 1]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          ...basePayload,
          events: [{ event: 'app_open', ts: badTs }],
        },
      });
      expect(res.statusCode).toBe(400);
    }

    // Nothing was written to the DB
    expect(queries).toHaveLength(0);

    await app.close();
  });

  it('accepts a valid batch and writes it with a single multi-row INSERT', async () => {
    const app = buildTestApp();
    await app.ready();

    const now = Date.now();
    const events = Array.from({ length: 10 }, (_, i) => ({
      event: `event_${i}`,
      props: { index: i },
      ts: now - i * 1000,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { ...basePayload, events },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, accepted: 10 });

    // One INSERT covering all 10 events — not one query per event.
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('INSERT INTO analytics_events');
    expect(queries[0].params).toHaveLength(10 * 6);

    await app.close();
  });

  it('accepts an empty batch without touching the DB', async () => {
    const app = buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { ...basePayload, events: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, accepted: 0 });
    expect(queries).toHaveLength(0);

    await app.close();
  });

  it('rejects an unknown platform and oversize batches', async () => {
    const app = buildTestApp();
    await app.ready();

    const badPlatform = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: {
        ...basePayload,
        platform: 'windows-phone',
        events: [{ event: 'x', ts: Date.now() }],
      },
    });
    expect(badPlatform.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: {
        ...basePayload,
        events: Array.from({ length: 51 }, () => ({ event: 'x', ts: Date.now() })),
      },
    });
    expect(tooMany.statusCode).toBe(400);

    await app.close();
  });
});
