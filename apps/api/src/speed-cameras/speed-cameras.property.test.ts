/**
 * Unit tests for the speed-camera API (community camera reports).
 *
 * Covers:
 *  - GET /speed-cameras query validation edge cases (missing/NaN lat-lng,
 *    radius clamped to 50 km) and the exact-haversine post-filter that trims
 *    bounding-box corner rows.
 *  - GET serialization (snake_case -> camelCase, confirmed_at Date -> epoch ms).
 *  - POST /speed-cameras zod schema bounds (lat/lng range, type enum,
 *    speedLimitKph 0..300 integer, direction 0..360) and defaults.
 *  - POST /speed-cameras/:id/vote — confirm increments upvotes column,
 *    deny increments downvotes, invalid vote 400, unknown camera 404.
 *  - All three endpoints require authentication.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import speedCamerasRoutes from './speed-cameras.routes';

// ---------------------------------------------------------------------------
// Configurable in-memory backing state
// ---------------------------------------------------------------------------

interface CameraRow {
  id: string;
  lat: number;
  lng: number;
  type: string;
  speed_limit_kph: number | null;
  direction: number | null;
  source: string;
  confirmed_at: Date | null;
  upvotes: number;
  downvotes: number;
}

interface MockState {
  cameras: CameraRow[];
  /** every (sql, params) pair the pool saw, for asserting bbox params etc. */
  queries: { sql: string; params: unknown[] }[];
  /** params captured for INSERT INTO speed_cameras */
  inserts: unknown[][];
  /** vote UPDATE returns no row when camera id is not in this set */
  activeCameraIds: Set<string>;
}

let state: MockState;

function resetState() {
  state = {
    cameras: [],
    queries: [],
    inserts: [],
    activeCameraIds: new Set(),
  };
}

function makeCamera(overrides: Partial<CameraRow> = {}): CameraRow {
  return {
    id: 'cam-1',
    lat: 37.7749,
    lng: -122.4194,
    type: 'fixed',
    speed_limit_kph: null,
    direction: null,
    source: 'community',
    confirmed_at: null,
    upvotes: 0,
    downvotes: 0,
    ...overrides,
  };
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      state.queries.push({ sql, params: params ?? [] });
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // bbox SELECT — apply the same lat/lng BETWEEN filter Postgres would
      if (norm.startsWith('SELECT') && norm.includes('FROM SPEED_CAMERAS')) {
        const [latLo, latHi, lngLo, lngHi] = params as number[];
        const rows = state.cameras.filter(
          (c) => c.lat >= latLo && c.lat <= latHi && c.lng >= lngLo && c.lng <= lngHi,
        );
        return { rows, rowCount: rows.length };
      }

      if (norm.startsWith('INSERT INTO SPEED_CAMERAS')) {
        state.inserts.push(params ?? []);
        return {
          rows: [{ id: 'new-cam-id', created_at: new Date('2026-01-01T00:00:00Z') }],
          rowCount: 1,
        };
      }

      if (norm.startsWith('UPDATE SPEED_CAMERAS')) {
        const [id, vote] = params as [string, string];
        if (!state.activeCameraIds.has(id)) return { rows: [], rowCount: 0 };
        const cam = state.cameras.find((c) => c.id === id) ?? makeCamera({ id });
        const upvotes = cam.upvotes + (vote === 'confirm' ? 1 : 0);
        const downvotes = cam.downvotes + (vote === 'deny' ? 1 : 0);
        return {
          rows: [{ id, upvotes, downvotes, is_active: !(vote === 'deny' && downvotes >= 5) }],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as Pool;
  return pool;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }, { name: 'db' }));
  // generalLimiter no-ops under NODE_ENV=test, so an empty redis stub suffices
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(speedCamerasRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// GET /speed-cameras
// ---------------------------------------------------------------------------

describe('GET /speed-cameras — query validation', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildTestApp();
    resetState();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/speed-cameras?lat=1&lng=2' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when lat is missing', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lng=2',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when lng is missing', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=1',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when lat/lng are not numeric', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=abc&lng=def',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('clamps radius to 50 km — bbox half-height is 50/111 degrees', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=0&lng=0&radius=500',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const select = state.queries.find((q) => q.sql.toUpperCase().includes('FROM SPEED_CAMERAS'));
    expect(select).toBeDefined();
    const [latLo, latHi] = select!.params as number[];
    const expectedDegLat = 50 / 111.0; // clamped, not 500/111
    expect(latHi).toBeCloseTo(expectedDegLat, 10);
    expect(latLo).toBeCloseTo(-expectedDegLat, 10);
    await app.close();
  });

  it('defaults radius to 10 km when omitted', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=0&lng=0',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const select = state.queries.find((q) => q.sql.toUpperCase().includes('FROM SPEED_CAMERAS'));
    const [, latHi] = select!.params as number[];
    expect(latHi).toBeCloseTo(10 / 111.0, 10);
    await app.close();
  });
});

describe('GET /speed-cameras — haversine post-filter and serialization', () => {
  it('excludes a bbox-corner camera that is outside the exact radius', async () => {
    const app = buildTestApp();
    resetState();
    // 10 km default radius at (0,0): bbox extends ~0.0900 deg on each side.
    // A camera at the bbox corner is ~12.7 km away -> inside bbox, outside circle.
    const deg = 10 / 111.0;
    state.cameras = [
      makeCamera({ id: 'inside', lat: 0.01, lng: 0.01 }), // ~1.6 km
      makeCamera({ id: 'corner', lat: deg * 0.999, lng: deg * 0.999 }), // ~12.7 km
    ];
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=0&lng=0',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { cameras: { id: string }[] };
    const ids = body.cameras.map((c) => c.id);
    expect(ids).toContain('inside');
    expect(ids).not.toContain('corner');
    await app.close();
  });

  it('serializes rows to camelCase with confirmedAt as epoch ms (null when unconfirmed)', async () => {
    const app = buildTestApp();
    resetState();
    const confirmedAt = new Date('2026-06-15T12:00:00Z');
    state.cameras = [
      makeCamera({
        id: 'cam-a', lat: 0.001, lng: 0.001, type: 'red_light',
        speed_limit_kph: 80, direction: 270, source: 'opendata',
        confirmed_at: confirmedAt, upvotes: 4, downvotes: 1,
      }),
      makeCamera({ id: 'cam-b', lat: 0.002, lng: 0.002, confirmed_at: null }),
    ];
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/speed-cameras?lat=0&lng=0',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { cameras: Record<string, unknown>[] };
    const camA = body.cameras.find((c) => c.id === 'cam-a')!;
    expect(camA).toMatchObject({
      lat: 0.001,
      lng: 0.001,
      type: 'red_light',
      speedLimitKph: 80,
      direction: 270,
      source: 'opendata',
      confirmedAt: confirmedAt.getTime(),
      upvotes: 4,
      downvotes: 1,
    });
    const camB = body.cameras.find((c) => c.id === 'cam-b')!;
    expect(camB.confirmedAt).toBeNull();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /speed-cameras
// ---------------------------------------------------------------------------

describe('POST /speed-cameras — schema validation', () => {
  async function post(app: FastifyInstance, token: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/speed-cameras',
      headers: { Authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const app = buildTestApp();
    resetState();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/speed-cameras',
      payload: { lat: 0, lng: 0 },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each([
    ['lat above 90', { lat: 90.1, lng: 0 }],
    ['lat below -90', { lat: -90.1, lng: 0 }],
    ['lng above 180', { lat: 0, lng: 180.1 }],
    ['lng below -180', { lat: 0, lng: -180.1 }],
    ['invalid type', { lat: 0, lng: 0, type: 'laser' }],
    ['negative speed limit', { lat: 0, lng: 0, speedLimitKph: -1 }],
    ['speed limit above 300', { lat: 0, lng: 0, speedLimitKph: 301 }],
    ['non-integer speed limit', { lat: 0, lng: 0, speedLimitKph: 50.5 }],
    ['direction above 360', { lat: 0, lng: 0, direction: 361 }],
    ['direction below 0', { lat: 0, lng: 0, direction: -1 }],
    ['invalid source', { lat: 0, lng: 0, source: 'hearsay' }],
    ['missing lat', { lng: 0 }],
  ])('rejects %s with 400 and does not insert', async (_name, body) => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await post(app, token, body);
    expect(res.statusCode).toBe(400);
    expect(state.inserts).toHaveLength(0);
    await app.close();
  });

  it('accepts boundary values lat=±90, lng=±180, speedLimitKph=0/300, direction=0/360', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');

    const cases = [
      { lat: 90, lng: 180, speedLimitKph: 300, direction: 360 },
      { lat: -90, lng: -180, speedLimitKph: 0, direction: 0 },
    ];
    for (const body of cases) {
      const res = await post(app, token, body);
      expect(res.statusCode).toBe(201);
    }
    expect(state.inserts).toHaveLength(2);
    await app.close();
  });

  it('applies defaults type=fixed, source=community and stores the reporter id', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'user-42');
    const res = await post(app, token, { lat: 12.5, lng: -33.25 });
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'new-cam-id',
      lat: 12.5,
      lng: -33.25,
      type: 'fixed',
      source: 'community',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(state.inserts).toHaveLength(1);
    const [lat, lng, type, speedLimit, direction, source, reporterId] = state.inserts[0];
    expect(lat).toBe(12.5);
    expect(lng).toBe(-33.25);
    expect(type).toBe('fixed');
    expect(speedLimit).toBeNull();
    expect(direction).toBeNull();
    expect(source).toBe('community');
    expect(reporterId).toBe('user-42');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /speed-cameras/:id/vote
// ---------------------------------------------------------------------------

describe('POST /speed-cameras/:id/vote', () => {
  async function vote(app: FastifyInstance, token: string, id: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/speed-cameras/${id}/vote`,
      headers: { Authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const app = buildTestApp();
    resetState();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/speed-cameras/cam-1/vote',
      payload: { vote: 'confirm' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each([
    ['unknown vote value', { vote: 'maybe' }],
    ['missing vote', {}],
  ])('rejects %s with 400', async (_name, body) => {
    const app = buildTestApp();
    resetState();
    state.activeCameraIds.add('cam-1');
    const token = await makeToken(app, 'u1');
    const res = await vote(app, token, 'cam-1', body);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for a camera that does not exist or is inactive', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await vote(app, token, 'ghost-cam', { vote: 'confirm' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('confirm increments the upvotes column (not downvotes)', async () => {
    const app = buildTestApp();
    resetState();
    state.cameras = [makeCamera({ id: 'cam-1', upvotes: 2, downvotes: 1 })];
    state.activeCameraIds.add('cam-1');
    const token = await makeToken(app, 'u1');
    const res = await vote(app, token, 'cam-1', { vote: 'confirm' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { upvotes: number; downvotes: number };
    expect(body.upvotes).toBe(3);
    expect(body.downvotes).toBe(1);

    // The UPDATE must target the upvotes column
    const update = state.queries.find((q) => q.sql.toUpperCase().includes('UPDATE SPEED_CAMERAS'));
    expect(update!.sql).toMatch(/SET\s+upvotes\s*=\s*upvotes\s*\+\s*1/i);
    await app.close();
  });

  it('deny increments the downvotes column (not upvotes)', async () => {
    const app = buildTestApp();
    resetState();
    state.cameras = [makeCamera({ id: 'cam-1', upvotes: 2, downvotes: 1 })];
    state.activeCameraIds.add('cam-1');
    const token = await makeToken(app, 'u1');
    const res = await vote(app, token, 'cam-1', { vote: 'deny' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { upvotes: number; downvotes: number };
    expect(body.upvotes).toBe(2);
    expect(body.downvotes).toBe(2);

    const update = state.queries.find((q) => q.sql.toUpperCase().includes('UPDATE SPEED_CAMERAS'));
    expect(update!.sql).toMatch(/SET\s+downvotes\s*=\s*downvotes\s*\+\s*1/i);
    await app.close();
  });
});
