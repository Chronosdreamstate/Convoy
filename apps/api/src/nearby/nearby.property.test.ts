/**
 * Property tests for the opt-in "nearby strangers" API (#71).
 *
 * Covers:
 *  - GET /nearby requires auth, valid coords, and requester opt-in.
 *  - GET /nearby returns approximate-only data (bucketed distance, snapped coords)
 *    and only for opted-in users.
 *  - POST /nearby/dm gates on both parties being opted-in and reuses / creates a
 *    convoy_groups.type='dm' group.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import nearbyRoutes from './nearby.routes';

// ---------------------------------------------------------------------------
// Configurable in-memory backing state
// ---------------------------------------------------------------------------
interface MockState {
  // userId -> visible_to_nearby
  optedIn: Set<string>;
  // rows returned by the main nearby SELECT
  nearbyRows: {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    approx_lat: number;
    approx_lng: number;
    distance_m: number;
  }[];
  // groupId returned when an existing DM group is found (null => none)
  existingDmGroupId: string | null;
  createdGroups: string[];
  memberInserts: unknown[][];
}

let state: MockState;

function resetState() {
  state = {
    optedIn: new Set(),
    nearbyRows: [],
    existingDmGroupId: null,
    createdGroups: [],
    memberInserts: [],
  };
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (norm.includes('INSERT INTO USER_SETTINGS') && norm.includes('ON CONFLICT DO NOTHING')) {
        return { rows: [], rowCount: 0 };
      }

      // SELECT visible_to_nearby FROM user_settings WHERE user_id = $1
      if (norm.includes('SELECT VISIBLE_TO_NEARBY FROM USER_SETTINGS')) {
        const uid = params![0] as string;
        return { rows: [{ visible_to_nearby: state.optedIn.has(uid) }], rowCount: 1 };
      }

      // Opt-in filter for DM: SELECT user_id ... WHERE user_id IN ($1,$2) AND visible_to_nearby = true
      if (norm.includes('SELECT USER_ID FROM USER_SETTINGS') && norm.includes('VISIBLE_TO_NEARBY = TRUE')) {
        const ids = (params as string[]).filter((id) => state.optedIn.has(id));
        return { rows: ids.map((id) => ({ user_id: id })), rowCount: ids.length };
      }

      // Presence upsert
      if (norm.includes('INSERT INTO NEARBY_PRESENCE')) {
        return { rows: [], rowCount: 0 };
      }

      // Main nearby query
      if (norm.includes('FROM NEARBY_PRESENCE NP') && norm.includes('ST_DWITHIN')) {
        return { rows: state.nearbyRows, rowCount: state.nearbyRows.length };
      }

      // Existing DM group lookup
      if (norm.includes('FROM CONVOY_GROUPS G') && norm.includes("G.TYPE = 'DM'")) {
        if (state.existingDmGroupId) {
          return { rows: [{ id: state.existingDmGroupId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Create DM group
      if (norm.includes('INSERT INTO CONVOY_GROUPS')) {
        const id = `grp-${state.createdGroups.length + 1}`;
        state.createdGroups.push(id);
        return { rows: [{ id }], rowCount: 1 };
      }

      // Insert members
      if (norm.includes('INSERT INTO CONVOY_MEMBERS')) {
        state.memberInserts.push(params ?? []);
        return { rows: [], rowCount: 2 };
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
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(nearbyRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// GET /nearby
// ---------------------------------------------------------------------------
describe('GET /nearby', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildTestApp();
    resetState();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/nearby?lat=1&lng=2' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when lat/lng are missing', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nearby',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 403 when the requester has not opted in', async () => {
    const app = buildTestApp();
    resetState();
    const token = await makeToken(app, 'u1'); // not in optedIn
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nearby?lat=40.0&lng=-70.0',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns approximate-only results with bucketed distance for opted-in users', async () => {
    const app = buildTestApp();
    resetState();
    state.optedIn.add('u1');
    state.nearbyRows = [
      {
        user_id: 'stranger-1',
        display_name: 'Alex',
        avatar_url: null,
        approx_lat: 40.123456,
        approx_lng: -70.654321,
        distance_m: 1234, // should bucket to 1200
      },
    ];
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nearby?lat=40.1&lng=-70.6&radiusM=5000',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      users: { userId: string; displayName: string; approxLat: number; approxLng: number; distanceM: number }[];
      radiusM: number;
    };
    expect(body.radiusM).toBe(5000);
    expect(body.users).toHaveLength(1);
    const u = body.users[0];
    expect(u.userId).toBe('stranger-1');
    expect(u.displayName).toBe('Alex');
    // Coordinates snapped to 3 decimals
    expect(u.approxLat).toBe(40.123);
    expect(u.approxLng).toBe(-70.654);
    // Distance bucketed to nearest 100 m
    expect(u.distanceM).toBe(1200);
    // No exact-coordinate fields leak into the payload
    expect(JSON.stringify(u)).not.toContain('40.123456');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /nearby/dm
// ---------------------------------------------------------------------------
describe('POST /nearby/dm', () => {
  it('rejects DMing yourself with 400', async () => {
    const app = buildTestApp();
    resetState();
    state.optedIn.add('u1');
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nearby/dm',
      headers: { Authorization: `Bearer ${token}` },
      payload: { userId: 'u1' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 403 when the target has not opted in', async () => {
    const app = buildTestApp();
    resetState();
    state.optedIn.add('u1'); // requester opted-in, target not
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nearby/dm',
      headers: { Authorization: `Bearer ${token}` },
      payload: { userId: '11111111-1111-1111-1111-111111111111' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('creates a new DM group between two opted-in strangers', async () => {
    const app = buildTestApp();
    resetState();
    const stranger = '11111111-1111-1111-1111-111111111111';
    state.optedIn.add('u1');
    state.optedIn.add(stranger);
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nearby/dm',
      headers: { Authorization: `Bearer ${token}` },
      payload: { userId: stranger },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { groupId: string };
    expect(body.groupId).toBe('grp-1');
    expect(state.memberInserts).toHaveLength(1);
    await app.close();
  });

  it('reuses an existing DM group instead of creating a duplicate', async () => {
    const app = buildTestApp();
    resetState();
    const stranger = '11111111-1111-1111-1111-111111111111';
    state.optedIn.add('u1');
    state.optedIn.add(stranger);
    state.existingDmGroupId = 'existing-grp';
    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nearby/dm',
      headers: { Authorization: `Bearer ${token}` },
      payload: { userId: stranger },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { groupId: string };
    expect(body.groupId).toBe('existing-grp');
    expect(state.createdGroups).toHaveLength(0);
    await app.close();
  });
});
