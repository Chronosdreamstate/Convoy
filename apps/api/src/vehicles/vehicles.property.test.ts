/**
 * Property 51: Only one vehicle is active per user at a time
 * Validates: Requirements 29.2
 *
 * For any sequence of activate calls on a user's vehicles,
 * the invariant that exactly one vehicle has is_active = true must hold
 * after every operation.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import vehiclesRoutes from './vehicles.routes';

// ---------------------------------------------------------------------------
// In-memory vehicle store for property testing
// ---------------------------------------------------------------------------
interface InMemoryVehicle {
  id: string;
  user_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photo_url: string | null;
  is_active: boolean;
  created_at: Date;
}

let vehicleStore: InMemoryVehicle[] = [];
let idCounter = 0;

function makeId(): string {
  return `vehicle-${++idCounter}`;
}

function buildMockPool(userId: string): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('SELECT') && sql.includes('FROM vehicles')) {
        const rows = vehicleStore.filter((v) => v.user_id === userId);
        return { rows, rowCount: rows.length };
      }

      if (s.startsWith('INSERT INTO VEHICLES')) {
        const [, , year, make, model, color, photoUrl] = params as [string, string, number | null, string | null, string | null, string | null, string | null];
        const v: InMemoryVehicle = {
          id: makeId(),
          user_id: userId,
          year, make, model, color,
          photo_url: photoUrl,
          is_active: false,
          created_at: new Date(),
        };
        vehicleStore.push(v);
        return { rows: [v], rowCount: 1 };
      }

      if (s.startsWith('DELETE FROM VEHICLES')) {
        const [id, uid] = params as [string, string];
        const before = vehicleStore.length;
        vehicleStore = vehicleStore.filter((v) => !(v.id === id && v.user_id === uid));
        return { rows: [{ id }], rowCount: before - vehicleStore.length };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async (): Promise<PoolClient> => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const s = sql.trim().toUpperCase();

          if (s.startsWith('BEGIN') || s.startsWith('COMMIT')) {
            return { rows: [], rowCount: 0 };
          }

          if (s.startsWith('ROLLBACK')) {
            return { rows: [], rowCount: 0 };
          }

          // ownership check
          if (s.startsWith('SELECT') && sql.includes('FROM vehicles')) {
            const [id, uid] = params as [string, string];
            const row = vehicleStore.find((v) => v.id === id && v.user_id === uid);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          // deactivate all
          if (s.startsWith('UPDATE VEHICLES SET IS_ACTIVE = FALSE')) {
            const [uid] = params as [string];
            vehicleStore.forEach((v) => { if (v.user_id === uid) v.is_active = false; });
            return { rows: [], rowCount: 0 };
          }

          // activate target
          if (s.startsWith('UPDATE VEHICLES SET IS_ACTIVE = TRUE')) {
            const [id] = params as [string];
            const v = vehicleStore.find((veh) => veh.id === id);
            if (v) v.is_active = true;
            return { rows: v ? [v] : [], rowCount: v ? 1 : 0 };
          }

          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      } as unknown as PoolClient;
      return client;
    },
  } as unknown as Pool;

  return pool;
}

function buildTestApp(userId: string): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  app.register(
    fp(async (instance) => {
      instance.decorate('db', buildMockPool(userId));
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
// Property 51
// ---------------------------------------------------------------------------
describe('Property 51: Only one vehicle is active per user at a time', () => {
  const USER_ID = 'user-prop51';
  const JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long!!';

  function makeJwt(app: FastifyInstance): string {
    return app.jwt.sign({ sub: USER_ID });
  }

  beforeEach(() => {
    vehicleStore = [];
    idCounter = 0;
  });

  it('after each activate call exactly one vehicle is active', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate between 2 and 5 vehicles to add
        fc.integer({ min: 2, max: 5 }),
        async (vehicleCount) => {
          vehicleStore = [];
          idCounter = 0;

          const app = buildTestApp(USER_ID);
          await app.ready();

          const token = makeJwt(app);
          const authHeader = { Authorization: `Bearer ${token}` };

          // Create N vehicles
          const createdIds: string[] = [];
          for (let i = 0; i < vehicleCount; i++) {
            const res = await app.inject({
              method: 'POST',
              url: '/api/v1/vehicles',
              headers: authHeader,
              payload: { make: `Make${i}`, model: `Model${i}`, year: 2020 + i, color: 'Black' },
            });
            expect(res.statusCode).toBe(201);
            const body = JSON.parse(res.body) as { id: string };
            createdIds.push(body.id);
          }

          // Activate each vehicle in turn and assert invariant after each call
          for (const vehicleId of createdIds) {
            const activateRes = await app.inject({
              method: 'POST',
              url: `/api/v1/vehicles/${vehicleId}/activate`,
              headers: authHeader,
            });
            expect(activateRes.statusCode).toBe(200);

            // Count active vehicles for this user
            const activeVehicles = vehicleStore.filter(
              (v) => v.user_id === USER_ID && v.is_active,
            );
            expect(activeVehicles).toHaveLength(1);
            expect(activeVehicles[0].id).toBe(vehicleId);
          }

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('activating a vehicle when none are active results in exactly one active', async () => {
    const app = buildTestApp(USER_ID);
    await app.ready();

    const token = makeJwt(app);
    const authHeader = { Authorization: `Bearer ${token}` };

    // Create two vehicles (both inactive by default)
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/vehicles', headers: authHeader, payload: { make: 'Ford' } });
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/vehicles', headers: authHeader, payload: { make: 'Jeep' } });

    const id1 = (JSON.parse(r1.body) as { id: string }).id;

    // Neither is active initially
    expect(vehicleStore.filter((v) => v.is_active)).toHaveLength(0);

    // Activate the first
    await app.inject({ method: 'POST', url: `/api/v1/vehicles/${id1}/activate`, headers: authHeader });

    const activeAfterFirst = vehicleStore.filter((v) => v.user_id === USER_ID && v.is_active);
    expect(activeAfterFirst).toHaveLength(1);
    expect(activeAfterFirst[0].id).toBe(id1);

    // Activate the second
    const id2 = (JSON.parse(r2.body) as { id: string }).id;
    await app.inject({ method: 'POST', url: `/api/v1/vehicles/${id2}/activate`, headers: authHeader });

    const activeAfterSecond = vehicleStore.filter((v) => v.user_id === USER_ID && v.is_active);
    expect(activeAfterSecond).toHaveLength(1);
    expect(activeAfterSecond[0].id).toBe(id2);

    await app.close();
  });
});
