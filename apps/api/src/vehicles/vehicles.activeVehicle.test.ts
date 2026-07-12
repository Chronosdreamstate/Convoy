/**
 * GET /vehicles/active/:userId — a group member's active vehicle
 * Validates: Requirements 29.4, 29.5, 29.6
 *
 *  - A member sharing an active group with the target gets the target's
 *    active vehicle (year/make/model/color/photoUrl).
 *  - A target with no active vehicle yields { vehicle: null } ("No vehicle
 *    set" is a valid state — Req 29.6).
 *  - A requester sharing NO group with the target is rejected with 403.
 *  - A membership that has ended (left_at set) does not grant access.
 *  - Fetching your own active vehicle needs no shared group.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import vehiclesRoutes from './vehicles.routes';

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------
interface StoredVehicle {
  id: string;
  user_id: string;
  name: string | null;
  vehicle_type: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photo_url: string | null;
  is_active: boolean;
  created_at: Date;
}

interface Membership {
  user_id: string;
  group_id: string;
  left_at: Date | null;
}

let vehicles: StoredVehicle[] = [];
let memberships: Membership[] = [];

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      // Shared-group authorization check
      if (sql.includes('FROM convoy_members m1')) {
        const [requesterId, targetId] = params as [string, string];
        const requesterGroups = new Set(
          memberships
            .filter((m) => m.user_id === requesterId && m.left_at === null)
            .map((m) => m.group_id),
        );
        const shares = memberships.some(
          (m) => m.user_id === targetId && m.left_at === null && requesterGroups.has(m.group_id),
        );
        return shares ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      // Active-vehicle lookup
      if (sql.includes('FROM vehicles') && sql.includes('is_active = true')) {
        const [userId] = params as [string];
        const row = vehicles.find((v) => v.user_id === userId && v.is_active);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  app.register(
    fp(async (instance) => {
      instance.decorate('db', buildMockPool());
    }),
    { name: 'db' },
  );

  app.register(
    fp(async (instance) => {
      instance.decorate('redis', { ping: async () => 'PONG' } as unknown as Redis);
    }),
    { name: 'redis' },
  );

  app.register(vehiclesRoutes, { prefix: '/api/v1' });

  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REQUESTER = 'user-requester';
const TARGET = 'user-target';
const STRANGER_TARGET = 'user-stranger';
const GROUP = 'group-1';

const TARGET_VEHICLE: StoredVehicle = {
  id: 'veh-1',
  user_id: TARGET,
  name: 'Daily',
  vehicle_type: 'car',
  year: 2021,
  make: 'Subaru',
  model: 'WRX',
  color: 'Blue',
  photo_url: 'http://localhost:3000/api/v1/uploads/abc.jpg',
  is_active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
};

describe('GET /vehicles/active/:userId (Req 29.4/29.5/29.6)', () => {
  let app: FastifyInstance;
  let authHeader: { Authorization: string };

  beforeEach(async () => {
    vehicles = [];
    memberships = [];
    app = buildTestApp();
    await app.ready();
    authHeader = { Authorization: `Bearer ${app.jwt.sign({ sub: REQUESTER })}` };
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a fellow group member's active vehicle", async () => {
    memberships = [
      { user_id: REQUESTER, group_id: GROUP, left_at: null },
      { user_id: TARGET, group_id: GROUP, left_at: null },
    ];
    vehicles = [
      TARGET_VEHICLE,
      // Inactive second vehicle must never be returned
      { ...TARGET_VEHICLE, id: 'veh-2', make: 'Ford', model: 'F-150', is_active: false },
    ];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${TARGET}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { vehicle: Record<string, unknown> | null };
    expect(body.vehicle).toMatchObject({
      id: 'veh-1',
      year: 2021,
      make: 'Subaru',
      model: 'WRX',
      color: 'Blue',
      photoUrl: 'http://localhost:3000/api/v1/uploads/abc.jpg',
      isActive: true,
    });
  });

  it('returns { vehicle: null } when the member has no active vehicle (Req 29.6)', async () => {
    memberships = [
      { user_id: REQUESTER, group_id: GROUP, left_at: null },
      { user_id: TARGET, group_id: GROUP, left_at: null },
    ];
    vehicles = [{ ...TARGET_VEHICLE, is_active: false }];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${TARGET}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ vehicle: null });
  });

  it('rejects a requester who shares no group with the target (403)', async () => {
    memberships = [
      { user_id: REQUESTER, group_id: GROUP, left_at: null },
      { user_id: STRANGER_TARGET, group_id: 'group-other', left_at: null },
    ];
    vehicles = [{ ...TARGET_VEHICLE, user_id: STRANGER_TARGET }];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${STRANGER_TARGET}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not count an ended membership (left_at set) as shared', async () => {
    memberships = [
      { user_id: REQUESTER, group_id: GROUP, left_at: null },
      { user_id: TARGET, group_id: GROUP, left_at: new Date() }, // target left
    ];
    vehicles = [TARGET_VEHICLE];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${TARGET}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(403);
  });

  it('allows fetching your own active vehicle with no shared group', async () => {
    vehicles = [{ ...TARGET_VEHICLE, user_id: REQUESTER }];

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${REQUESTER}`,
      headers: authHeader,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { vehicle: { make: string } | null };
    expect(body.vehicle?.make).toBe('Subaru');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/active/${TARGET}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
