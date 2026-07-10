/**
 * Hardening/regression tests for the places API.
 *
 * Covers recently committed input caps not exercised by places.property.test.ts:
 *  - GET /places/search: query longer than 200 chars (after trim) is rejected
 *    with 400 and never forwarded to Nominatim; exactly 200 chars is accepted
 *  - GET /places/reverse: lat outside [-90, 90] or lng outside [-180, 180]
 *    is rejected with 400 and never forwarded to Nominatim; the boundary
 *    values themselves are accepted
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import placesRoutes from './places.routes';

type FetchMock = jest.MockedFunction<typeof fetch>;
let mockFetch: FetchMock;

beforeEach(() => {
  mockFetch = jest.fn();
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', {} as Pool); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(placesRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId = 'u-places'): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// Search query length cap (200 chars)
// ---------------------------------------------------------------------------

describe('GET /places/search query length cap', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = buildTestApp();
    token = await makeToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function search(q: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/places/search?q=${encodeURIComponent(q)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('accepts a query of exactly 200 characters and forwards it to Nominatim', async () => {
    const res = await search('a'.repeat(200));
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a 201-character query with 400 without calling Nominatim', async () => {
    const res = await search('a'.repeat(201));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/too long/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('length check applies to the trimmed query (200 chars padded with spaces is OK)', async () => {
    const res = await search(`   ${'a'.repeat(200)}   `);
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('property: any over-long query is rejected and never reaches Nominatim', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 201, max: 1000 }),
        fc.constantFrom('a', 'z', '0', '-', '%'),
        async (len, ch) => {
          mockFetch.mockClear();
          const res = await search(ch.repeat(len));
          expect(res.statusCode).toBe(400);
          expect(mockFetch).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Reverse geocode lat/lng range validation
// ---------------------------------------------------------------------------

describe('GET /places/reverse lat/lng range validation', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = buildTestApp();
    token = await makeToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function reverse(lat: string | number, lng: string | number) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/places/reverse?lat=${lat}&lng=${lng}`,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  beforeEach(() => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ display_name: 'Somewhere' }), { status: 200 }),
    );
  });

  it.each([
    ['lat just above 90', 90.0001, 0],
    ['lat far above 90', 9000, 0],
    ['lat below -90', -90.0001, 0],
    ['lng just above 180', 0, 180.0001],
    ['lng below -180', 0, -180.5],
    ['both out of range', 91, 181],
    ['Infinity lat', 'Infinity', 0],
    ['-Infinity lng', 0, '-Infinity'],
  ])('rejects %s with 400 and does not call Nominatim', async (_label, lat, lng) => {
    const res = await reverse(lat, lng);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/lat|lng/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['north pole boundary', 90, 0],
    ['south pole boundary', -90, 0],
    ['antimeridian east', 0, 180],
    ['antimeridian west', 0, -180],
    ['all-boundary corner', -90, 180],
  ])('accepts %s (boundary values are valid)', async (_label, lat, lng) => {
    const res = await reverse(lat, lng);
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('property: any out-of-range coordinate pair is rejected without an upstream call', async () => {
    const outOfRangeLat = fc.oneof(
      fc.double({ min: 90.000001, max: 1e9, noNaN: true }),
      fc.double({ min: -1e9, max: -90.000001, noNaN: true }),
    );
    const outOfRangeLng = fc.oneof(
      fc.double({ min: 180.000001, max: 1e9, noNaN: true }),
      fc.double({ min: -1e9, max: -180.000001, noNaN: true }),
    );
    const inRangeLat = fc.double({ min: -90, max: 90, noNaN: true });
    const inRangeLng = fc.double({ min: -180, max: 180, noNaN: true });

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.tuple(outOfRangeLat, inRangeLng),
          fc.tuple(inRangeLat, outOfRangeLng),
          fc.tuple(outOfRangeLat, outOfRangeLng),
        ),
        async ([lat, lng]) => {
          mockFetch.mockClear();
          const res = await reverse(lat, lng);
          expect(res.statusCode).toBe(400);
          expect(mockFetch).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});
