/**
 * Endpoint tests for the member-ETA endpoint (Req 8.5).
 *
 *  - GET /groups/:id/members/:userId/eta returns a synchronized ETA computed
 *    from the Redis-cached shared destination (written by the route push) and
 *    the member's live fix: remaining distance ÷ recent speed.
 *  - The no-destination, no-live-fix, and stationary-member cases all degrade
 *    to `etaSeconds: null` so clients omit the ETA row instead of fabricating
 *    a value.
 *  - Non-members are rejected with 403.
 *
 * Also unit-tests the pure computeEtaSeconds helper directly.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import routesRoutes, { computeEtaSeconds, MIN_ETA_SPEED_KPH } from './routes.routes';
import { haversineMeters } from '../utils/geo';

// ---------------------------------------------------------------------------
// Pure helper — computeEtaSeconds
// ---------------------------------------------------------------------------

describe('computeEtaSeconds (Req 8.5)', () => {
  it('is remaining distance divided by speed, rounded to whole seconds', () => {
    // 5 km at 60 km/h → 300 s
    expect(computeEtaSeconds(5000, 60)).toBe(300);
    // 1 km at 36 km/h (10 m/s) → 100 s
    expect(computeEtaSeconds(1000, 36)).toBe(100);
  });

  it('returns null below the stationary threshold — no fabricated ETA', () => {
    expect(computeEtaSeconds(5000, 0)).toBeNull();
    expect(computeEtaSeconds(5000, MIN_ETA_SPEED_KPH - 0.1)).toBeNull();
    // At exactly the threshold an estimate is allowed
    expect(computeEtaSeconds(5000, MIN_ETA_SPEED_KPH)).not.toBeNull();
  });

  it('returns null for non-finite or negative inputs', () => {
    expect(computeEtaSeconds(NaN, 60)).toBeNull();
    expect(computeEtaSeconds(5000, NaN)).toBeNull();
    expect(computeEtaSeconds(Infinity, 60)).toBeNull();
    expect(computeEtaSeconds(-1, 60)).toBeNull();
  });

  it('returns 0 for zero remaining distance (arrived)', () => {
    expect(computeEtaSeconds(0, 60)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

interface TestMocks {
  dbQuery: jest.Mock;
  redis: { hset: jest.Mock; expire: jest.Mock; del: jest.Mock; hgetall: jest.Mock };
  ioEmit: jest.Mock;
}

function buildTestApp(): { app: FastifyInstance; mocks: TestMocks } {
  const mocks: TestMocks = {
    dbQuery: jest.fn(),
    redis: { hset: jest.fn(), expire: jest.fn(), del: jest.fn(), hgetall: jest.fn() },
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
  token = app.jwt.sign({ sub: 'u-caller' });
});

afterAll(async () => {
  await app.close();
});

const groupId = '00000000-0000-0000-0000-000000000001';
const memberId = 'u-member';

// Sydney-ish coordinates: destination ~a few km from the member fix
const DEST = { lat: -33.8, lng: 151.2 };
const MEMBER_LOC = { lat: -33.83, lng: 151.23 };

function eta(target = memberId) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/groups/${groupId}/members/${target}/eta`,
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  mocks.dbQuery.mockReset();
  mocks.redis.hgetall.mockReset();
});

describe('GET /groups/:id/members/:userId/eta (Req 8.5)', () => {
  it('rejects non-members with 403', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [] }); // membership check fails
    const res = await eta();
    expect(res.statusCode).toBe(403);
    expect(mocks.redis.hgetall).not.toHaveBeenCalled();
  });

  it('returns etaSeconds: null when the group has no shared destination', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1' }] });
    mocks.redis.hgetall.mockResolvedValueOnce({}); // route:<gid>:dest missing
    const res = await eta();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ etaSeconds: null, distanceM: null });
  });

  it('returns etaSeconds: null when the member has no live fix', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1' }] });
    mocks.redis.hgetall
      .mockResolvedValueOnce({ lat: String(DEST.lat), lng: String(DEST.lng) }) // destination
      .mockResolvedValueOnce({}); // loc:<gid>:<uid> expired (offline > 35s)
    const res = await eta();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ etaSeconds: null, distanceM: null });
  });

  it('computes distance ÷ recent speed from the cached fix and destination', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1' }] });
    mocks.redis.hgetall
      .mockResolvedValueOnce({ lat: String(DEST.lat), lng: String(DEST.lng) })
      .mockResolvedValueOnce({
        lat: String(MEMBER_LOC.lat),
        lng: String(MEMBER_LOC.lng),
        heading: '90',
        speed_kph: '60',
        ts: String(Date.now()),
      });
    const res = await eta();
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { etaSeconds: number; distanceM: number };
    const expectedDistanceM = Math.round(haversineMeters(MEMBER_LOC, DEST));
    expect(body.distanceM).toBe(expectedDistanceM);
    expect(body.etaSeconds).toBe(Math.round(expectedDistanceM / (60 / 3.6)));

    // Reads the caller-independent caches — same keys for every viewer, so the
    // value is synchronized across all members (Req 8.5).
    expect(mocks.redis.hgetall).toHaveBeenNthCalledWith(1, `route:${groupId}:dest`);
    expect(mocks.redis.hgetall).toHaveBeenNthCalledWith(2, `loc:${groupId}:${memberId}`);
  });

  it('returns the distance but a null ETA for a stationary member', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1' }] });
    mocks.redis.hgetall
      .mockResolvedValueOnce({ lat: String(DEST.lat), lng: String(DEST.lng) })
      .mockResolvedValueOnce({
        lat: String(MEMBER_LOC.lat),
        lng: String(MEMBER_LOC.lng),
        heading: '0',
        speed_kph: '0',
        ts: String(Date.now()),
      });
    const res = await eta();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { etaSeconds: number | null; distanceM: number };
    expect(body.etaSeconds).toBeNull();
    expect(body.distanceM).toBeGreaterThan(0);
  });
});
