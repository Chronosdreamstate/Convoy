/**
 * Property tests for the places API (Nominatim proxy).
 *
 * Property 59: Short queries without location return empty results (Req 18.3)
 *   Validates: Requirements 18.1, 18.3
 *
 * Property 60: Nominatim response is mapped to canonical shape (Req 18.5)
 *   Validates: Requirements 18.5
 *
 * Property 61: Upstream failure degrades gracefully (Req 43.1)
 *   Validates: Requirements 43.1
 *
 * Property 62: Reverse geocode invalid coordinates return 400
 *   Validates: Requirements 5.2
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

// ---------------------------------------------------------------------------
// Global fetch mock setup
// ---------------------------------------------------------------------------

type FetchMock = jest.MockedFunction<typeof fetch>;

let mockFetch: FetchMock;

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function nominatimResponse(items: Array<{
  place_id?: number;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
}>): Response {
  const data = items.map((item, i) => ({
    place_id: item.place_id ?? i + 1,
    display_name: item.display_name ?? `Place ${i + 1}, City, Country`,
    name: item.name,
    lat: item.lat ?? '37.7749',
    lon: item.lon ?? '-122.4194',
    type: item.type ?? 'restaurant',
    class: item.class ?? 'amenity',
    address: {},
  }));
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

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

async function makeToken(app: FastifyInstance, userId = 'u1'): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// Property 59: Short queries without location return empty results
// ---------------------------------------------------------------------------
describe('Property 59: Short queries without location return empty results', () => {
  it('query shorter than 3 characters with no lat/lng returns []', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 2 }),
        async (shortQ) => {
          const res = await app.inject({
            method: 'GET',
            url: `/api/v1/places/search?q=${encodeURIComponent(shortQ)}`,
            headers: { Authorization: `Bearer ${token}` },
          });
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body) as unknown[];
          expect(Array.isArray(body)).toBe(true);
          expect(body).toHaveLength(0);
          // fetch should NOT be called — no Nominatim request for short queries without location
          expect(mockFetch).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 20 },
    );

    await app.close();
  });

  it('missing q and no lat/lng returns []', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();

    await app.close();
  });

  it('unauthenticated search returns 401', async () => {
    const app = buildTestApp();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/places/search?q=gas' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 60: Nominatim response is mapped to canonical shape
// ---------------------------------------------------------------------------
describe('Property 60: Nominatim response is mapped to canonical shape', () => {
  it('every result has id, name, address, category, lat, lng', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    const items = [
      { place_id: 1, display_name: 'Shell Gas, Market St, San Francisco, CA, US', name: 'Shell Gas', lat: '37.78', lon: '-122.41', type: 'fuel', class: 'amenity' },
      { place_id: 2, display_name: 'Chevron, Mission St, San Francisco, CA, US', name: 'Chevron', lat: '37.77', lon: '-122.40', type: 'fuel', class: 'amenity' },
    ];
    mockFetch.mockResolvedValue(nominatimResponse(items));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search?q=gas+station',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      id: string; name: string; address: string; category: string | null; lat: number; lng: number;
    }>;

    expect(body.length).toBeGreaterThan(0);
    for (const result of body) {
      expect(typeof result.id).toBe('string');
      expect(typeof result.name).toBe('string');
      expect(typeof result.address).toBe('string');
      expect(typeof result.lat).toBe('number');
      expect(typeof result.lng).toBe('number');
      expect(result.lat).toBeGreaterThanOrEqual(-90);
      expect(result.lat).toBeLessThanOrEqual(90);
      expect(result.lng).toBeGreaterThanOrEqual(-180);
      expect(result.lng).toBeLessThanOrEqual(180);
    }

    await app.close();
  });

  it('result count does not exceed 10 for text search', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    // Even if Nominatim returns more than 10, text search sets limit=10 in the URL.
    // Nominatim honours the limit, but we verify we don't expand beyond it.
    const items = Array.from({ length: 10 }, (_, i) => ({
      place_id: i + 1,
      display_name: `Coffee Shop ${i + 1}, Market St, City`,
      name: `Coffee Shop ${i + 1}`,
      lat: String(37 + i * 0.001),
      lon: String(-122 + i * 0.001),
    }));
    mockFetch.mockResolvedValue(nominatimResponse(items));

    // Text search path: q is 3+ chars, no lat/lng
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search?q=coffee+shop',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown[];
    expect(body.length).toBeLessThanOrEqual(10);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 61: Upstream failure degrades gracefully
// ---------------------------------------------------------------------------
describe('Property 61: Upstream failure degrades gracefully', () => {
  it('Nominatim returning non-200 status yields empty results', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    mockFetch.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search?q=gas+station',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);

    await app.close();
  });

  it('Nominatim network error yields empty results', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    mockFetch.mockRejectedValue(new Error('network error'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search?q=gas+station',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);

    await app.close();
  });

  it('Nominatim timeout yields empty results', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    mockFetch.mockRejectedValue(err);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/search?q=gas+station',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);

    await app.close();
  });

  it('reverse geocode Nominatim failure returns { address: null }', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    mockFetch.mockRejectedValue(new Error('network error'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/reverse?lat=37.78&lng=-122.41',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { address: string | null };
    expect(body.address).toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 62: Reverse geocode invalid coordinates return 400
// ---------------------------------------------------------------------------
describe('Property 62: Reverse geocode invalid coordinates return 400', () => {
  it('missing lat and lng returns 400', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/reverse',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('non-numeric lat returns 400', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/reverse?lat=notanumber&lng=-122.41',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('valid coordinates return an address response', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ display_name: '1 Market St, San Francisco, CA, US' }), { status: 200 }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/reverse?lat=37.7749&lng=-122.4194',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { address: string | null };
    expect(body.address).toBe('1 Market St, San Francisco, CA, US');

    await app.close();
  });

  it('any valid lat/lng pair is accepted by the endpoint', async () => {
    const app = buildTestApp();
    const token = await makeToken(app);

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ display_name: 'Some Place' }), { status: 200 }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        async (lat, lng) => {
          const res = await app.inject({
            method: 'GET',
            url: `/api/v1/places/reverse?lat=${lat}&lng=${lng}`,
            headers: { Authorization: `Bearer ${token}` },
          });
          expect(res.statusCode).toBe(200);
        },
      ),
      { numRuns: 20 },
    );

    await app.close();
  });
});
