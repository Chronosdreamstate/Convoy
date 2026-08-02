/**
 * Route tests for the fuel API (Req 21.1–21.5).
 *
 * The two pure helpers had property tests; the routes themselves — the log
 * CRUD, the nearby-station lookup and the group fuel-status threshold — had
 * none, which is most of the module.
 *
 * The behaviours worth pinning are the ones a client could otherwise get
 * silently wrong: mpg is computed server-side and a client-supplied value is
 * ignored, a delete is scoped to the caller, and the status endpoint falls
 * back to the group's created_at when the Redis key has expired.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import fuelRoutes, { FUEL_DISTANCE_THRESHOLD_M, FUEL_TIME_THRESHOLD_S } from './fuel.routes';

const USER = '00000000-0000-0000-0000-0000000000a1';
const GROUP = '00000000-0000-0000-0000-0000000000b1';

interface State {
  logs: Array<Record<string, unknown>>;
  prevOdometerKm: string | null;
  isMember: boolean;
  deleteRowCount: number;
  inserted: unknown[][];
  groupCreatedAt: Date | null;
  redis: Map<string, string>;
}
let state: State;

function reset(): void {
  state = {
    logs: [],
    prevOdometerKm: null,
    isMember: true,
    deleteRowCount: 1,
    inserted: [],
    groupCreatedAt: null,
    redis: new Map(),
  };
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('SELECT id, date, gallons')) {
        return { rows: state.logs, rowCount: state.logs.length };
      }
      if (s.startsWith('SELECT odometer_km FROM fuel_logs')) {
        return state.prevOdometerKm === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ odometer_km: state.prevOdometerKm }], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO fuel_logs')) {
        state.inserted.push(params);
        // Echo the row back the way Postgres would: NUMERIC columns as strings.
        const [, date, gallons, ppg, notes, location, mpg, odometerKm] = params as [
          string, Date, number, number, string | null, string | null, number | null, number | null,
        ];
        return {
          rows: [{
            id: 'log-1',
            date,
            gallons: String(gallons),
            price_per_gallon: String(ppg),
            notes,
            location,
            mpg: mpg === null ? null : String(mpg),
            odometer_km: odometerKm === null ? null : String(odometerKm),
          }],
          rowCount: 1,
        };
      }
      if (s.startsWith('DELETE FROM fuel_logs')) {
        return { rows: [], rowCount: state.deleteRowCount };
      }
      if (s.includes('FROM convoy_members')) {
        return state.isMember ? { rows: [{ id: 'm-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM convoy_groups')) {
        return state.groupCreatedAt
          ? { rows: [{ created_at: state.groupCreatedAt }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function buildMockRedis(): Redis {
  return {
    get: async (k: string) => state.redis.get(k) ?? null,
    set: async (k: string, v: string) => { state.redis.set(k, v); },
    incr: async (k: string) => {
      const n = parseInt(state.redis.get(k) ?? '0', 10) + 1;
      state.redis.set(k, String(n));
      return n;
    },
    expire: async () => {},
    ttl: async () => 3600,
  } as unknown as Redis;
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', buildMockRedis()); }, { name: 'redis' }));
  app.register(fuelRoutes, { prefix: '/api/v1' });
  await app.ready();
  token = app.jwt.sign({ sub: USER });
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { Authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

// ---------------------------------------------------------------------------

describe('GET /fuel/logs', () => {
  it('converts NUMERIC columns to numbers and nulls to omitted fields', async () => {
    state.logs = [{
      id: 'l1', date: new Date('2026-01-02T00:00:00Z'),
      gallons: '12.500', price_per_gallon: '4.250',
      notes: null, location: null, mpg: '31.20', odometer_km: '1000.5',
    }];

    const res = await inject('GET', '/fuel/logs');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).logs[0]).toEqual({
      id: 'l1',
      date: '2026-01-02T00:00:00.000Z',
      gallons: 12.5,
      pricePerGallon: 4.25,
      mpg: 31.2,
      odometerKm: 1000.5,
    });
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/fuel/logs' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /fuel/logs', () => {
  const base = { gallons: 10, pricePerGallon: 4 };

  it('creates a log and returns it', async () => {
    const res = await inject('POST', '/fuel/logs', base);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.gallons).toBe(10);
    expect(body.pricePerGallon).toBe(4);
  });

  it('computes mpg from the previous odometer reading', async () => {
    state.prevOdometerKm = '1000';
    // +160.9344 km == 100 miles, over 10 gallons => 10 mpg
    const res = await inject('POST', '/fuel/logs', { ...base, odometerKm: 1160.9344 });

    expect(JSON.parse(res.body).mpg).toBe(10);
  });

  it('ignores a client-supplied mpg — the server is the only source', async () => {
    state.prevOdometerKm = '1000';
    const res = await inject('POST', '/fuel/logs', { ...base, odometerKm: 1160.9344, mpg: 999 });

    expect(JSON.parse(res.body).mpg).toBe(10);
  });

  it('leaves mpg unset on the first entry, with nothing to diff against', async () => {
    const res = await inject('POST', '/fuel/logs', { ...base, odometerKm: 5000 });
    expect(JSON.parse(res.body).mpg).toBeUndefined();
  });

  it('leaves mpg unset when the odometer went backwards (out-of-order entry)', async () => {
    state.prevOdometerKm = '9000';
    const res = await inject('POST', '/fuel/logs', { ...base, odometerKm: 1000 });
    expect(JSON.parse(res.body).mpg).toBeUndefined();
  });

  it('accepts a plain date string, not just full ISO-8601', async () => {
    const res = await inject('POST', '/fuel/logs', { ...base, date: '2026-01-01' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).date).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects an unparseable date rather than storing Invalid Date', async () => {
    const res = await inject('POST', '/fuel/logs', { ...base, date: 'not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('invalid date');
  });

  it.each([
    ['zero gallons', { gallons: 0, pricePerGallon: 4 }],
    ['negative gallons', { gallons: -1, pricePerGallon: 4 }],
    ['zero price', { gallons: 1, pricePerGallon: 0 }],
    ['absurd gallons', { gallons: 100_000, pricePerGallon: 4 }],
    ['missing price', { gallons: 1 }],
    ['string gallons', { gallons: '10', pricePerGallon: 4 }],
  ])('rejects %s', async (_label, payload) => {
    expect((await inject('POST', '/fuel/logs', payload)).statusCode).toBe(400);
  });

  it('stores the log against the authenticated user, not a client-supplied id', async () => {
    await inject('POST', '/fuel/logs', base);
    expect(state.inserted[0][0]).toBe(USER);
  });
});

describe('DELETE /fuel/logs/:id', () => {
  it('deletes and returns 204', async () => {
    const res = await inject('DELETE', '/fuel/logs/log-1');
    expect(res.statusCode).toBe(204);
  });

  it("404s when the row is not the caller's — the query is scoped by user id", async () => {
    state.deleteRowCount = 0;
    const res = await inject('DELETE', '/fuel/logs/someone-elses');
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /places/fuel', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function mockNominatim(results: unknown, ok = true) {
    global.fetch = jest.fn().mockResolvedValue({
      ok, json: async () => results,
    }) as unknown as typeof fetch;
  }

  it('returns stations sorted by distance', async () => {
    mockNominatim([
      { place_id: 2, display_name: 'Far Station, Some Road', lat: '51.55', lon: '-0.12' },
      { place_id: 1, display_name: 'Near Station, Main St', lat: '51.501', lon: '-0.12' },
    ]);

    const res = await inject('GET', '/places/fuel?lat=51.5&lng=-0.12');
    expect(res.statusCode).toBe(200);
    const { stations } = JSON.parse(res.body);
    expect(stations.map((s: { id: string }) => s.id)).toEqual(['1', '2']);
    expect(stations[0].distanceM).toBeLessThan(stations[1].distanceM);
  });

  it('reports an explicit message when nothing is nearby', async () => {
    mockNominatim([]);
    const res = await inject('GET', '/places/fuel?lat=51.5&lng=-0.12');
    expect(JSON.parse(res.body)).toEqual({ stations: [], message: 'No fuel stations found nearby' });
  });

  it('degrades to no results when the upstream lookup fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    const res = await inject('GET', '/places/fuel?lat=51.5&lng=-0.12');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).stations).toEqual([]);
  });

  it('degrades to no results on a non-OK upstream response', async () => {
    mockNominatim([], false);
    const res = await inject('GET', '/places/fuel?lat=51.5&lng=-0.12');
    expect(JSON.parse(res.body).stations).toEqual([]);
  });

  it('skips entries with unparseable coordinates', async () => {
    mockNominatim([
      { place_id: 1, display_name: 'Broken', lat: 'nope', lon: 'nope' },
      { place_id: 2, display_name: 'Fine, Main St', lat: '51.501', lon: '-0.12' },
    ]);
    const { stations } = JSON.parse((await inject('GET', '/places/fuel?lat=51.5&lng=-0.12')).body);
    expect(stations.map((s: { id: string }) => s.id)).toEqual(['2']);
  });

  it.each([
    ['missing coordinates', ''],
    ['non-numeric', '?lat=abc&lng=def'],
    ['latitude out of range', '?lat=91&lng=0'],
    ['longitude out of range', '?lat=0&lng=181'],
  ])('400s on %s', async (_label, qs) => {
    expect((await inject('GET', `/places/fuel${qs}`)).statusCode).toBe(400);
  });
});

describe('GET /groups/:id/fuel/status', () => {
  it('403s a non-member', async () => {
    state.isMember = false;
    const res = await inject('GET', `/groups/${GROUP}/fuel/status`);
    expect(res.statusCode).toBe(403);
  });

  it('suggests a stop once the distance threshold is passed', async () => {
    state.redis.set(`group:${GROUP}:distance_m`, String(FUEL_DISTANCE_THRESHOLD_M + 1));
    state.redis.set(`group:${GROUP}:started_at`, String(Date.now()));

    const body = JSON.parse((await inject('GET', `/groups/${GROUP}/fuel/status`)).body);
    expect(body.suggest).toBe(true);
  });

  it('suggests a stop once the time threshold is passed, with no distance logged', async () => {
    state.redis.set(`group:${GROUP}:started_at`, String(Date.now() - (FUEL_TIME_THRESHOLD_S + 60) * 1000));

    const body = JSON.parse((await inject('GET', `/groups/${GROUP}/fuel/status`)).body);
    expect(body.suggest).toBe(true);
    expect(body.durationS).toBeGreaterThanOrEqual(FUEL_TIME_THRESHOLD_S);
  });

  it('does not suggest a stop early in a drive', async () => {
    state.redis.set(`group:${GROUP}:distance_m`, '1000');
    state.redis.set(`group:${GROUP}:started_at`, String(Date.now() - 60_000));

    const body = JSON.parse((await inject('GET', `/groups/${GROUP}/fuel/status`)).body);
    expect(body.suggest).toBe(false);
  });

  it("falls back to the group's created_at when the Redis start key has expired", async () => {
    // Only the DB knows when a long drive began once the key ages out; without
    // this fallback durationS resets to 0 and the suggestion never fires.
    state.groupCreatedAt = new Date(Date.now() - (FUEL_TIME_THRESHOLD_S + 600) * 1000);

    const body = JSON.parse((await inject('GET', `/groups/${GROUP}/fuel/status`)).body);
    expect(body.suggest).toBe(true);
    expect(body.durationS).toBeGreaterThanOrEqual(FUEL_TIME_THRESHOLD_S);
  });

  it('reports a zero duration when neither Redis nor an active group row knows', async () => {
    const body = JSON.parse((await inject('GET', `/groups/${GROUP}/fuel/status`)).body);
    expect(body).toMatchObject({ suggest: false, distanceM: 0, durationS: 0 });
  });
});
