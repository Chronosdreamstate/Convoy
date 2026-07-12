/**
 * Endpoint tests for per-segment traffic congestion plumbing (Req 6.2).
 *
 *  - POST /routes/calculate requests the Mapbox `congestion` annotation
 *    (alongside the existing `maxspeed`) and surfaces it in the response as
 *    `congestionSegments`, aligned with the route geometry.
 *  - Absent / unrecognised annotations degrade gracefully (empty array /
 *    'unknown') so the response stays backward compatible.
 *  - POST /groups/:id/route (route push) carries congestionSegments through
 *    to the route:pushed broadcast instead of zod stripping it.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import routesRoutes from './routes.routes';

type FetchMock = jest.MockedFunction<typeof fetch>;
let mockFetch: FetchMock;

const COORDS: [number, number][] = [[151.2, -33.8], [151.21, -33.81], [151.22, -33.82], [151.23, -33.83]];

function mapboxResponse(legs?: unknown): Response {
  return new Response(JSON.stringify({
    code: 'Ok',
    routes: [{
      distance: 5000,
      duration: 600,
      geometry: { type: 'LineString', coordinates: COORDS },
      ...(legs !== undefined ? { legs } : {}),
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

interface TestMocks {
  dbQuery: jest.Mock;
  redis: { hset: jest.Mock; expire: jest.Mock; del: jest.Mock };
  ioEmit: jest.Mock;
}

function buildTestApp(): { app: FastifyInstance; mocks: TestMocks } {
  const mocks: TestMocks = {
    dbQuery: jest.fn(),
    redis: { hset: jest.fn(), expire: jest.fn(), del: jest.fn() },
    ioEmit: jest.fn(),
  };
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', { query: mocks.dbQuery } as unknown as Pool); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', mocks.redis as unknown as Redis); }, { name: 'redis' }));
  app.register(fp(async (inst) => {
    inst.decorate('io', { to: () => ({ emit: mocks.ioEmit }) } as never);
  }, { name: 'io' }));
  app.register(routesRoutes, { prefix: '/api/v1' });
  return { app, mocks };
}

let app: FastifyInstance;
let mocks: TestMocks;
let token: string;

beforeAll(async () => {
  ({ app, mocks } = buildTestApp());
  await app.ready();
  token = app.jwt.sign({ sub: 'u-congestion' });
});

afterAll(async () => {
  await app.close();
});

async function calculate() {
  return app.inject({
    method: 'POST',
    url: '/api/v1/routes/calculate',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      origin: { lat: -33.8, lng: 151.2 },
      destination: { lat: -33.83, lng: 151.23 },
    },
  });
}

// ---------------------------------------------------------------------------
// POST /routes/calculate
// ---------------------------------------------------------------------------

describe('POST /routes/calculate congestion plumbing (Req 6.2)', () => {
  it('requests Mapbox with annotations including both maxspeed and congestion', async () => {
    mockFetch.mockResolvedValue(mapboxResponse());
    const res = await calculate();
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    const annotations = (url.searchParams.get('annotations') ?? '').split(',');
    expect(annotations).toContain('congestion');
    expect(annotations).toContain('maxspeed');
    // Mapbox rejects annotations unless overview=full — keep the guard.
    expect(url.searchParams.get('overview')).toBe('full');
  });

  it('surfaces per-segment congestion aligned with geometry (N coords → N-1 entries)', async () => {
    mockFetch.mockResolvedValue(mapboxResponse([
      { annotation: { congestion: ['low', 'heavy', 'severe'], maxspeed: [{ speed: 60, unit: 'km/h' }, { speed: 60, unit: 'km/h' }, { speed: 40, unit: 'km/h' }] } },
    ]));
    const res = await calculate();
    expect(res.statusCode).toBe(200);
    const { routes } = JSON.parse(res.body);
    expect(routes[0].congestionSegments).toEqual(['low', 'heavy', 'severe']);
    expect(routes[0].congestionSegments).toHaveLength(routes[0].geometry.coordinates.length - 1);
    // Existing fields are untouched (additive change only).
    expect(routes[0].speedLimitSegmentsKph).toEqual([60, 60, 40]);
    expect(routes[0].speedLimitKph).toBe(60);
  });

  it('returns an empty congestionSegments when Mapbox omits the annotation', async () => {
    mockFetch.mockResolvedValue(mapboxResponse([{ annotation: { maxspeed: [{ unknown: true }] } }]));
    const res = await calculate();
    expect(res.statusCode).toBe(200);
    const { routes } = JSON.parse(res.body);
    expect(routes[0].congestionSegments).toEqual([]);
  });

  it('normalises unrecognised congestion values to "unknown"', async () => {
    mockFetch.mockResolvedValue(mapboxResponse([{ annotation: { congestion: ['low', 'not-a-level', 'severe'] } }]));
    const res = await calculate();
    expect(res.statusCode).toBe(200);
    const { routes } = JSON.parse(res.body);
    expect(routes[0].congestionSegments).toEqual(['low', 'unknown', 'severe']);
  });
});

// ---------------------------------------------------------------------------
// POST /groups/:id/route — congestion survives the push broadcast
// ---------------------------------------------------------------------------

describe('POST /groups/:id/route keeps congestionSegments in route:pushed (Req 6.2)', () => {
  const groupId = '00000000-0000-0000-0000-000000000001';

  function pushBody(extra: Record<string, unknown> = {}) {
    return {
      route: {
        distance: 5000,
        duration: 600,
        distanceText: '5.0 km',
        durationText: '10 min',
        geometry: { type: 'LineString', coordinates: COORDS },
        speedLimitKph: 60,
        speedLimitSegmentsKph: [60, 60, 40],
        ...extra,
      },
    };
  }

  beforeEach(() => {
    mocks.dbQuery.mockReset();
    mocks.ioEmit.mockReset();
    // 1) membership check  2) group admin check  3) member list for arrival flags
    mocks.dbQuery
      .mockResolvedValueOnce({ rows: [{ id: 'm-1' }] })
      .mockResolvedValueOnce({ rows: [{ admin_id: 'u-congestion', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'u-congestion' }] });
    mocks.redis.hset.mockResolvedValue(1);
    mocks.redis.expire.mockResolvedValue(1);
    mocks.redis.del.mockResolvedValue(1);
  });

  async function push(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/groups/${groupId}/route`,
      headers: { Authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('broadcasts congestionSegments to the group unchanged', async () => {
    const res = await push(pushBody({ congestionSegments: ['low', 'moderate', 'severe'] }));
    expect(res.statusCode).toBe(200);
    expect(mocks.ioEmit).toHaveBeenCalledWith('route:pushed', expect.objectContaining({
      route: expect.objectContaining({
        congestionSegments: ['low', 'moderate', 'severe'],
        speedLimitSegmentsKph: [60, 60, 40],
      }),
    }));
  });

  it('accepts a push without congestionSegments (older client) — field simply absent', async () => {
    const res = await push(pushBody());
    expect(res.statusCode).toBe(200);
    const emitted = mocks.ioEmit.mock.calls[0][1] as { route: Record<string, unknown> };
    expect('congestionSegments' in emitted.route).toBe(false);
  });

  it('rejects invalid congestion levels with 400', async () => {
    const res = await push(pushBody({ congestionSegments: ['low', 'gridlock'] }));
    expect(res.statusCode).toBe(400);
    expect(mocks.ioEmit).not.toHaveBeenCalled();
  });
});
