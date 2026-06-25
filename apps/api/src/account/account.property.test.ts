/**
 * Property tests for account management and data privacy.
 *
 * Property 63: Unauthenticated access to account endpoints returns 401
 *   Validates: Requirements 1.6
 *
 * Property 64: GET /account/export returns a complete data package
 *   Validates: Requirements 42.4
 *
 * Property 65: DELETE /account hard-deletes the user record
 *   Validates: Requirements 36.3
 *
 * Property 66: Legal endpoints return stable URL references
 *   Validates: Requirements 36.2
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import accountRoutes from './account.routes';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
interface UserRow {
  id: string;
  display_name: string;
  phone_number: string | null;
  email: string | null;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: string;
  created_at: Date;
}

interface DriveRow {
  id: string;
  group_id: string | null;
  route_trace: unknown;
  distance_m: number;
  duration_s: number;
  started_at: Date;
  ended_at: Date;
  member_count: number;
}

interface FriendRow {
  friend_id: string;
  status: string;
  created_at: Date;
}

let usersDb: Map<string, UserRow>;
let drivesDb: Map<string, DriveRow[]>;
let friendsDb: Map<string, FriendRow[]>;
let redisStore: Map<string, string>;
let deletedUsers: Set<string>;

function resetStore(users: UserRow[] = [], drives: Record<string, DriveRow[]> = {}, friends: Record<string, FriendRow[]> = {}) {
  usersDb = new Map(users.map((u) => [u.id, u]));
  drivesDb = new Map(Object.entries(drives));
  friendsDb = new Map(Object.entries(friends));
  redisStore = new Map();
  deletedUsers = new Set();
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // GET /account/export — user profile
      if (norm.includes('SELECT ID, DISPLAY_NAME, PHONE_NUMBER, EMAIL, AVATAR_URL') && norm.includes('FROM USERS WHERE ID')) {
        const userId = params![0] as string;
        const u = usersDb.get(userId);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // GET /account/export — drive history
      if (norm.includes('FROM DRIVE_HISTORY WHERE USER_ID')) {
        const userId = params![0] as string;
        const rows = drivesDb.get(userId) ?? [];
        return { rows, rowCount: rows.length };
      }

      // GET /account/export — friends
      if (norm.includes('FROM FRIENDSHIPS WHERE')) {
        const userId = params![0] as string;
        const rows = friendsDb.get(userId) ?? [];
        return { rows, rowCount: rows.length };
      }

      // DELETE /account — hard-delete user
      if (norm.includes('DELETE FROM USERS WHERE ID')) {
        const userId = params![0] as string;
        deletedUsers.add(userId);
        usersDb.delete(userId);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as Pool;
}

function buildMockRedis(): Redis {
  return {
    del: async (key: string): Promise<number> => {
      const existed = redisStore.has(key);
      redisStore.delete(key);
      return existed ? 1 : 0;
    },
    get: async (key: string): Promise<string | null> => redisStore.get(key) ?? null,
    set: async (key: string, value: string): Promise<'OK'> => {
      redisStore.set(key, value); return 'OK';
    },
  } as unknown as Redis;
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
  app.register(fp(async (inst) => { inst.decorate('redis', buildMockRedis()); }, { name: 'redis' }));
  app.register(accountRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

function makeUser(id: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id,
    display_name: `User ${id}`,
    phone_number: null,
    email: `${id}@example.com`,
    avatar_url: null,
    ptt_callsign: null,
    privacy: 'open',
    created_at: new Date('2024-01-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 63: Unauthenticated access returns 401
// ---------------------------------------------------------------------------
describe('Property 63: Unauthenticated access to account endpoints returns 401', () => {
  it('GET /account/export without token returns 401', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/account/export' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('DELETE /account without token returns 401', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/account' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('any random Bearer token is rejected', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 50 }).filter((s) => !s.includes('.')),
        async (badToken) => {
          const res = await app.inject({
            method: 'GET',
            url: '/api/v1/account/export',
            headers: { Authorization: `Bearer ${badToken}` },
          });
          expect(res.statusCode).toBe(401);
        },
      ),
      { numRuns: 15 },
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 64: GET /account/export returns a complete data package
// ---------------------------------------------------------------------------
describe('Property 64: GET /account/export returns a complete data package', () => {
  it('response includes profile, driveHistory, and friends fields', async () => {
    const user = makeUser('u-export');
    const drives: DriveRow[] = [
      {
        id: 'drive-1',
        group_id: 'group-1',
        route_trace: { type: 'LineString', coordinates: [[0, 0]] },
        distance_m: 5000,
        duration_s: 1800,
        started_at: new Date('2024-06-01T10:00:00Z'),
        ended_at: new Date('2024-06-01T10:30:00Z'),
        member_count: 3,
      },
    ];
    const friends: FriendRow[] = [
      { friend_id: 'friend-1', status: 'accepted', created_at: new Date('2024-05-01') },
    ];

    const app = buildTestApp();
    resetStore([user], { [user.id]: drives }, { [user.id]: friends });
    const token = await makeToken(app, user.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/export',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      exportedAt: string;
      profile: { id: string } | null;
      driveHistory: Array<{ id: string; distanceM: number }>;
      friends: Array<{ friendId: string; since: string }>;
    };

    expect(typeof body.exportedAt).toBe('string');
    expect(body.profile?.id).toBe(user.id);
    expect(body.driveHistory).toHaveLength(1);
    expect(body.driveHistory[0].distanceM).toBe(5000);
    expect(body.friends).toHaveLength(1);
    expect(body.friends[0].friendId).toBe('friend-1');

    await app.close();
  });

  it('response has Content-Disposition attachment header', async () => {
    const user = makeUser('u-export-hdr');
    const app = buildTestApp();
    resetStore([user]);
    const token = await makeToken(app, user.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/export',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('convoy-data-export.json');
    await app.close();
  });

  it('user with no drives or friends exports empty arrays', async () => {
    const user = makeUser('u-empty');
    const app = buildTestApp();
    resetStore([user]);
    const token = await makeToken(app, user.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/export',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { driveHistory: unknown[]; friends: unknown[] };
    expect(body.driveHistory).toHaveLength(0);
    expect(body.friends).toHaveLength(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 65: DELETE /account hard-deletes the user record
// ---------------------------------------------------------------------------
describe('Property 65: DELETE /account hard-deletes the user record', () => {
  it('DELETE removes the user from the DB', async () => {
    const user = makeUser('u-delete');
    const app = buildTestApp();
    resetStore([user]);
    redisStore.set(`rtk:${user.id}`, 'some-jti');
    const token = await makeToken(app, user.id);

    expect(usersDb.has(user.id)).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { success: boolean };
    expect(body.success).toBe(true);

    // User is removed from the in-memory store
    expect(usersDb.has(user.id)).toBe(false);
    expect(deletedUsers.has(user.id)).toBe(true);

    await app.close();
  });

  it('DELETE clears the refresh token from Redis', async () => {
    const user = makeUser('u-rtk-clear');
    const app = buildTestApp();
    resetStore([user]);
    redisStore.set(`rtk:${user.id}`, 'old-jti-value');
    const token = await makeToken(app, user.id);

    expect(redisStore.has(`rtk:${user.id}`)).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(redisStore.has(`rtk:${user.id}`)).toBe(false);

    await app.close();
  });

  it('DELETE returns a success response', async () => {
    const user = makeUser('u-del-resp');
    const app = buildTestApp();
    resetStore([user]);
    const token = await makeToken(app, user.id);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(typeof body.message).toBe('string');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 66: Legal endpoints return stable URL references
// ---------------------------------------------------------------------------
describe('Property 66: Legal endpoints return stable URL references', () => {
  it('GET /legal/privacy-policy returns a URL string', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/privacy-policy' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { url: string };
    expect(typeof body.url).toBe('string');
    expect(() => new URL(body.url)).not.toThrow();

    await app.close();
  });

  it('GET /legal/terms returns a URL string', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/terms' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { url: string };
    expect(typeof body.url).toBe('string');
    expect(() => new URL(body.url)).not.toThrow();

    await app.close();
  });

  it('legal URLs are idempotent — same response on repeated calls', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const r1 = await app.inject({ method: 'GET', url: '/api/v1/legal/privacy-policy' });
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/legal/privacy-policy' });

    expect(JSON.parse(r1.body)).toEqual(JSON.parse(r2.body));

    await app.close();
  });
});
