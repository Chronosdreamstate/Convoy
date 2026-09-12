/**
 * GET/POST /groups/:id/waypoints — the shared route the Admin builds a convoy's
 * stops with (WaypointManagementScreen) and every Member's map reads back.
 *
 * The endpoint had no API tests at all, and until recently no working client
 * either: the mobile screen never sent the per-item `id` the schema requires,
 * so every save 400'd. Now that it is live these pin down the contract it has
 * to keep — who may write, what a valid list is, what lands in the column, what
 * goes out over group:waypoints_updated — plus the read-modify-write behaviour
 * behind the waypoint_setter achievement (only net GROWTH counts as waypoints
 * added, and it is measured against the list as read under the row lock, not a
 * stale copy; see the live concurrency suite for the two-devices-at-once case).
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import groupsRoutes from './groups.routes';

const ADMIN = '00000000-0000-0000-0000-00000000aaa1';
const MEMBER = '00000000-0000-0000-0000-00000000bbb1';
const OUTSIDER = '00000000-0000-0000-0000-00000000ccc1';
const GROUP = '00000000-0000-0000-0000-0000000000f1';

interface Waypoint { id: string; name: string; address: string; type?: string; lat?: number; lng?: number }

interface State {
  group: { admin_id: string; waypoints: Waypoint[] | null } | null;
  activeMembers: Set<string>;
  statCounters: Record<string, number>;
  emitted: Array<{ room: string; event: string; data: unknown }>;
}
let state: State;

function reset(): void {
  state = {
    group: { admin_id: ADMIN, waypoints: null },
    activeMembers: new Set([ADMIN, MEMBER]),
    statCounters: {},
    emitted: [],
  };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim().toUpperCase();

function buildMockPool(): Pool {
  const run = async (sql: string, params?: unknown[]) => {
    const up = norm(sql);

    if (up === 'BEGIN' || up === 'COMMIT' || up === 'ROLLBACK') return { rows: [], rowCount: 0 };

    // Membership check (GET)
    if (up.startsWith('SELECT ID FROM CONVOY_MEMBERS')) {
      const userId = (params as [string, string])[1];
      return state.activeMembers.has(userId)
        ? { rows: [{ id: 'm-1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // GET waypoints
    if (up.startsWith('SELECT WAYPOINTS FROM CONVOY_GROUPS')) {
      return state.group ? { rows: [{ waypoints: state.group.waypoints }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // POST: read of admin + current list (locked — see the route)
    if (up.startsWith('SELECT ADMIN_ID, WAYPOINTS FROM CONVOY_GROUPS')) {
      return state.group
        ? { rows: [{ admin_id: state.group.admin_id, waypoints: state.group.waypoints }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // POST: replace the list
    if (up.startsWith('UPDATE CONVOY_GROUPS SET WAYPOINTS')) {
      const [json] = params as [string, string];
      if (state.group) state.group.waypoints = JSON.parse(json) as Waypoint[];
      return { rows: [], rowCount: 1 };
    }
    // waypoint_setter achievement counter (incrementStatCounter)
    if (up.startsWith('INSERT INTO USER_STAT_COUNTERS')) {
      const [userId, statKey, by] = params as [string, string, number];
      const key = `${userId}:${statKey}`;
      state.statCounters[key] = (state.statCounters[key] ?? 0) + by;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  } as unknown as Pool;
}

let app: FastifyInstance;
const tokenFor = (sub: string) => app.jwt.sign({ sub });

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => {
    i.decorate('redis', {
      incr: async () => 1, expire: async () => {}, ttl: async () => 3600,
      get: async () => null, set: async () => {}, del: async () => 1,
    } as unknown as Redis);
  }, { name: 'redis' }));
  app.register(fp(async (i) => {
    i.decorate('io', {
      to: (room: string) => ({
        emit: (event: string, data: unknown) => { state.emitted.push({ room, event, data }); },
      }),
      in: () => ({ disconnectSockets: () => undefined }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    i.decorate('enqueueNotification', async () => undefined);
  }, { name: 'io' }));
  app.register(groupsRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

const stop = (n: number): Waypoint => ({
  id: `w${n}`, name: `Stop ${n}`, address: `${n} Test Road`, type: 'waypoint',
});
const stops = (n: number): Waypoint[] => Array.from({ length: n }, (_, i) => stop(i));

const getWaypoints = (sub: string) =>
  app.inject({
    method: 'GET', url: `/api/v1/groups/${GROUP}/waypoints`,
    headers: { Authorization: `Bearer ${tokenFor(sub)}` },
  });

const setWaypoints = (sub: string, payload: unknown) =>
  app.inject({
    method: 'POST', url: `/api/v1/groups/${GROUP}/waypoints`,
    headers: { Authorization: `Bearer ${tokenFor(sub)}` },
    payload: payload as Record<string, unknown>,
  });

const counter = () => state.statCounters[`${ADMIN}:waypoint_setter`] ?? 0;

describe('GET /groups/:id/waypoints', () => {
  it('returns an empty list when the group has no route yet', async () => {
    const res = await getWaypoints(MEMBER);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ waypoints: [] });
  });

  it('returns the stored route to any active member', async () => {
    state.group!.waypoints = stops(2);
    const res = await getWaypoints(MEMBER);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).waypoints).toHaveLength(2);
  });

  it('refuses a non-member', async () => {
    expect((await getWaypoints(OUTSIDER)).statusCode).toBe(403);
  });

  it('404s an unknown group', async () => {
    state.group = null;
    expect((await getWaypoints(MEMBER)).statusCode).toBe(404);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${GROUP}/waypoints` });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /groups/:id/waypoints', () => {
  it('replaces the route, returns it and broadcasts it to the group', async () => {
    state.group!.waypoints = stops(1);
    const res = await setWaypoints(ADMIN, { waypoints: stops(3) });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).waypoints).toHaveLength(3);
    expect(state.group!.waypoints).toHaveLength(3);
    expect(state.emitted).toEqual([
      { room: `group:${GROUP}`, event: 'group:waypoints_updated', data: { groupId: GROUP, waypoints: stops(3) } },
    ]);
  });

  it('clears the route when sent an empty body', async () => {
    state.group!.waypoints = stops(3);
    const res = await setWaypoints(ADMIN, {});
    expect(res.statusCode).toBe(200);
    expect(state.group!.waypoints).toEqual([]);
  });

  it('refuses a member who is not the Admin, leaving the route untouched', async () => {
    state.group!.waypoints = stops(2);
    const res = await setWaypoints(MEMBER, { waypoints: stops(4) });
    expect(res.statusCode).toBe(403);
    expect(state.group!.waypoints).toHaveLength(2);
    expect(state.emitted).toEqual([]);
  });

  it('404s an unknown group', async () => {
    state.group = null;
    expect((await setWaypoints(ADMIN, { waypoints: stops(1) })).statusCode).toBe(404);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/groups/${GROUP}/waypoints`, payload: { waypoints: stops(1) },
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['an item with no id', [{ name: 'Nameless', address: 'somewhere' }]],
    ['an unknown stop type', [{ ...stop(0), type: 'helipad' }]],
    ['an out-of-range latitude', [{ ...stop(0), lat: 91, lng: 0 }]],
    ['a name past the length cap', [{ ...stop(0), name: 'x'.repeat(101) }]],
    ['more than 20 stops', Array.from({ length: 21 }, (_, i) => stop(i))],
  ])('rejects %s without touching the stored route', async (_label, waypoints) => {
    state.group!.waypoints = stops(2);
    const res = await setWaypoints(ADMIN, { waypoints });
    expect(res.statusCode).toBe(400);
    expect(state.group!.waypoints).toHaveLength(2);
    expect(state.emitted).toEqual([]);
  });

  it('stores exactly 20 stops (the cap is inclusive)', async () => {
    const res = await setWaypoints(ADMIN, { waypoints: stops(20) });
    expect(res.statusCode).toBe(200);
    expect(state.group!.waypoints).toHaveLength(20);
  });

  it('strips unknown keys rather than persisting arbitrary JSON', async () => {
    // The column is re-broadcast to every member, so a client cannot use it as
    // free storage for multi-MB blobs.
    await setWaypoints(ADMIN, { waypoints: [{ ...stop(0), junk: 'x'.repeat(50), nested: { a: 1 } }] });
    expect(state.group!.waypoints![0]).toEqual(stop(0));
  });

  describe('waypoint_setter achievement', () => {
    it('credits the net growth of the route', async () => {
      state.group!.waypoints = stops(3);
      await setWaypoints(ADMIN, { waypoints: stops(5) });
      expect(counter()).toBe(2);
    });

    it('credits the whole list the first time a route is set', async () => {
      await setWaypoints(ADMIN, { waypoints: stops(4) });
      expect(counter()).toBe(4);
    });

    it('credits nothing for a reorder or a removal', async () => {
      state.group!.waypoints = stops(5);
      await setWaypoints(ADMIN, { waypoints: stops(5).reverse() });
      await setWaypoints(ADMIN, { waypoints: stops(2) });
      expect(counter()).toBe(0);
    });

    it('measures growth against the route as stored, not as last sent', async () => {
      // Re-saving the same 5 stops must not credit 5 more — the "before" count
      // comes from the row, which the previous save already advanced.
      await setWaypoints(ADMIN, { waypoints: stops(5) });
      await setWaypoints(ADMIN, { waypoints: stops(5) });
      expect(counter()).toBe(5);
    });
  });
});
