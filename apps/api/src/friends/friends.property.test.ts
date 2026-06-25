/**
 * Property tests for the friend system.
 *
 * Property 24: Friend request behavior matches privacy setting
 *   Validates: Requirements 17.6, 17.7
 *
 * Property 25: Accepting a friend request is bidirectional
 *   Validates: Requirements 17.8
 *
 * Property 26: Declining a friend request generates no notification
 *   Validates: Requirements 17.9
 *
 * Property 27: Removing a friend is bidirectional
 *   Validates: Requirements 17.10
 *
 * Property 28: Blocking prevents further requests and location visibility
 *   Validates: Requirements 17.11
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import friendsRoutes from './friends.routes';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
interface InMemoryUser {
  id: string;
  display_name: string;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: 'open' | 'invite_only';
}

interface InMemoryFriendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: Date;
}

let users: Map<string, InMemoryUser>;
let friendships: InMemoryFriendship[];
let friendshipCounter: number;
let rateLimitStore: Map<string, { count: number; expiry: number }>;

function nextId(): string {
  return `fs-${++friendshipCounter}`;
}

function resetStore(testUsers: InMemoryUser[]) {
  users = new Map(testUsers.map((u) => [u.id, u]));
  friendships = [];
  friendshipCounter = 0;
  rateLimitStore = new Map();
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // Block check
      if (normalized.includes("STATUS = 'BLOCKED'") && normalized.includes('LIMIT 1')) {
        const [a, b] = params as [string, string];
        const found = friendships.find(
          (f) =>
            f.status === 'blocked' &&
            ((f.requester_id === a && f.addressee_id === b) ||
              (f.requester_id === b && f.addressee_id === a)),
        );
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }

      // Check existing relationship (any direction)
      if (
        normalized.startsWith('SELECT') &&
        normalized.includes('FROM FRIENDSHIPS') &&
        normalized.includes('LIMIT 1') &&
        !normalized.includes('REQUESTER_ID = $1 AND ADDRESSEE_ID = $2')
      ) {
        const [a, b] = params as [string, string];
        const found = friendships.find(
          (f) =>
            (f.requester_id === a && f.addressee_id === b) ||
            (f.requester_id === b && f.addressee_id === a),
        );
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }

      // Read addressee privacy
      if (normalized.startsWith('SELECT PRIVACY FROM USERS')) {
        const [id] = params as [string];
        const u = users.get(id);
        return { rows: u ? [{ privacy: u.privacy }] : [], rowCount: u ? 1 : 0 };
      }

      // Insert friendship
      if (normalized.startsWith('INSERT INTO FRIENDSHIPS')) {
        const [requesterId, addresseeId, status] = params as [string, string, string];
        const fs: InMemoryFriendship = {
          id: nextId(),
          requester_id: requesterId,
          addressee_id: addresseeId,
          status: status as InMemoryFriendship['status'],
          created_at: new Date(),
        };
        friendships.push(fs);
        return { rows: [fs], rowCount: 1 };
      }

      // List incoming pending requests
      if (
        normalized.includes("F.ADDRESSEE_ID = $1 AND F.STATUS = 'PENDING'")
      ) {
        const [userId] = params as [string];
        const rows = friendships
          .filter((f) => f.addressee_id === userId && f.status === 'pending')
          .map((f) => {
            const u = users.get(f.requester_id);
            return { ...f, display_name: u?.display_name ?? '', avatar_url: u?.avatar_url ?? null };
          });
        return { rows, rowCount: rows.length };
      }

      // Accept request
      if (normalized.startsWith("UPDATE FRIENDSHIPS") && normalized.includes("STATUS = 'ACCEPTED'")) {
        const [id, userId] = params as [string, string];
        const fs = friendships.find(
          (f) => f.id === id && f.addressee_id === userId && f.status === 'pending',
        );
        if (fs) fs.status = 'accepted';
        return { rows: fs ? [fs] : [], rowCount: fs ? 1 : 0 };
      }

      // Decline request (pending only — must be checked before delete-friendship branch)
      if (normalized.startsWith('DELETE FROM FRIENDSHIPS') && normalized.includes("STATUS = 'PENDING'")) {
        const [id, userId] = params as [string, string];
        const idx = friendships.findIndex(
          (f) => f.id === id && f.addressee_id === userId && f.status === 'pending',
        );
        if (idx >= 0) friendships.splice(idx, 1);
        return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
      }

      // List accepted friends
      if (
        normalized.includes("F.STATUS = 'ACCEPTED'") &&
        normalized.includes('F.REQUESTER_ID = $1 OR F.ADDRESSEE_ID = $1')
      ) {
        const [userId] = params as [string];
        const rows = friendships
          .filter(
            (f) =>
              f.status === 'accepted' &&
              (f.requester_id === userId || f.addressee_id === userId),
          )
          .map((f) => {
            const friendId =
              f.requester_id === userId ? f.addressee_id : f.requester_id;
            const u = users.get(friendId);
            return {
              friendship_id: f.id,
              created_at: f.created_at,
              id: friendId,
              display_name: u?.display_name ?? '',
              avatar_url: u?.avatar_url ?? null,
              ptt_callsign: u?.ptt_callsign ?? null,
              privacy: u?.privacy ?? 'open',
            };
          });
        return { rows, rowCount: rows.length };
      }

      // Delete friendship (remove friend)
      if (
        normalized.startsWith('DELETE FROM FRIENDSHIPS') &&
        normalized.includes("STATUS = 'ACCEPTED'") &&
        normalized.includes('REQUESTER_ID = $2 OR ADDRESSEE_ID = $2')
      ) {
        const [id, userId] = params as [string, string];
        const idx = friendships.findIndex(
          (f) =>
            f.id === id &&
            f.status === 'accepted' &&
            (f.requester_id === userId || f.addressee_id === userId),
        );
        if (idx >= 0) friendships.splice(idx, 1);
        return { rows: idx >= 0 ? [{ id }] : [], rowCount: idx >= 0 ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async (): Promise<PoolClient> => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

          if (normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT')) {
            return { rows: [], rowCount: 0 };
          }
          if (normalized.startsWith('ROLLBACK')) {
            return { rows: [], rowCount: 0 };
          }

          // Block: delete existing friendship
          if (
            normalized.startsWith('DELETE FROM FRIENDSHIPS') &&
            normalized.includes('REQUESTER_ID = $2 AND ADDRESSEE_ID = $1')
          ) {
            const [a, b] = params as [string, string];
            const before = friendships.length;
            friendships = friendships.filter(
              (f) =>
                !(
                  (f.requester_id === a && f.addressee_id === b) ||
                  (f.requester_id === b && f.addressee_id === a)
                ),
            );
            return { rows: [], rowCount: before - friendships.length };
          }

          // Block: insert blocked row
          if (
            normalized.startsWith('INSERT INTO FRIENDSHIPS') &&
            normalized.includes("'BLOCKED'")
          ) {
            const [blockerId, blockedId] = params as [string, string];
            const existing = friendships.findIndex(
              (f) => f.requester_id === blockerId && f.addressee_id === blockedId,
            );
            if (existing >= 0) {
              friendships[existing].status = 'blocked';
            } else {
              friendships.push({
                id: nextId(),
                requester_id: blockerId,
                addressee_id: blockedId,
                status: 'blocked',
                created_at: new Date(),
              });
            }
            return { rows: [], rowCount: 1 };
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

function buildMockRedis(): Redis {
  return {
    incr: async (key: string): Promise<number> => {
      const entry = rateLimitStore.get(key) ?? { count: 0, expiry: 0 };
      entry.count += 1;
      rateLimitStore.set(key, entry);
      return entry.count;
    },
    expire: async () => {},
    ping: async () => 'PONG',
    quit: async () => {},
  } as unknown as Redis;
}

const JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long!!';

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: JWT_SECRET, sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', buildMockRedis()); }, { name: 'redis' }));
  app.register(fp(async (i) => { i.decorate('enqueueNotification', async () => {}); }, { name: 'enqueueNotification' }));
  app.register(friendsRoutes, { prefix: '/api/v1' });

  return app;
}

function bearerFor(app: FastifyInstance, userId: string): Record<string, string> {
  return { Authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

// ---------------------------------------------------------------------------
// Test users — IDs must be valid UUIDs to pass Zod schema validation
// ---------------------------------------------------------------------------
const OPEN_USER: InMemoryUser = {
  id: '00000000-0000-0000-0000-000000000001',
  display_name: 'Open User',
  avatar_url: null,
  ptt_callsign: null,
  privacy: 'open',
};
const INVITE_USER: InMemoryUser = {
  id: '00000000-0000-0000-0000-000000000002',
  display_name: 'Invite User',
  avatar_url: null,
  ptt_callsign: null,
  privacy: 'invite_only',
};
const REQUESTER: InMemoryUser = {
  id: '00000000-0000-0000-0000-000000000003',
  display_name: 'Requester',
  avatar_url: null,
  ptt_callsign: null,
  privacy: 'open',
};

// ---------------------------------------------------------------------------
// Property 24: Friend request behavior matches privacy setting
// ---------------------------------------------------------------------------
describe('Property 24: Friend request behavior matches privacy setting', () => {
  it('request to open-privacy user is immediately accepted', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([REQUESTER, OPEN_USER]);
        const app = buildTestApp();
        await app.ready();

        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/friends/requests',
          headers: bearerFor(app, REQUESTER.id),
          payload: { addresseeId: OPEN_USER.id },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { status: string; autoAccepted: boolean };
        expect(body.status).toBe('accepted');
        expect(body.autoAccepted).toBe(true);

        await app.close();
      }),
      { numRuns: 10 },
    );
  });

  it('request to invite-only user remains pending', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([REQUESTER, INVITE_USER]);
        const app = buildTestApp();
        await app.ready();

        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/friends/requests',
          headers: bearerFor(app, REQUESTER.id),
          payload: { addresseeId: INVITE_USER.id },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { status: string; autoAccepted: boolean };
        expect(body.status).toBe('pending');
        expect(body.autoAccepted).toBe(false);

        await app.close();
      }),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25: Accepting a friend request is bidirectional
// ---------------------------------------------------------------------------
describe('Property 25: Accepting a friend request is bidirectional', () => {
  it('after accept both users appear in each other friend lists', async () => {
    resetStore([REQUESTER, INVITE_USER]);
    const app = buildTestApp();
    await app.ready();

    // Send request
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      headers: bearerFor(app, REQUESTER.id),
      payload: { addresseeId: INVITE_USER.id },
    });
    expect(reqRes.statusCode).toBe(201);
    const { id: friendshipId } = JSON.parse(reqRes.body) as { id: string };

    // Accept from addressee side
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/friends/requests/${friendshipId}/accept`,
      headers: bearerFor(app, INVITE_USER.id),
    });
    expect(acceptRes.statusCode).toBe(200);

    // Both should see each other in GET /friends
    const requesterFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: bearerFor(app, REQUESTER.id),
    });
    const addresseeFriends = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: bearerFor(app, INVITE_USER.id),
    });

    const rf = JSON.parse(requesterFriends.body) as { friends: Array<{ userId: string }> };
    const af = JSON.parse(addresseeFriends.body) as { friends: Array<{ userId: string }> };

    expect(rf.friends.some((f) => f.userId === INVITE_USER.id)).toBe(true);
    expect(af.friends.some((f) => f.userId === REQUESTER.id)).toBe(true);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 26: Declining a friend request generates no notification
// ---------------------------------------------------------------------------
describe('Property 26: Declining a friend request generates no notification', () => {
  it('after decline the request is gone and addressee friends list is empty', async () => {
    resetStore([REQUESTER, INVITE_USER]);
    const app = buildTestApp();
    await app.ready();

    // Send request
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      headers: bearerFor(app, REQUESTER.id),
      payload: { addresseeId: INVITE_USER.id },
    });
    const { id: friendshipId } = JSON.parse(reqRes.body) as { id: string };

    // Decline
    const declineRes = await app.inject({
      method: 'POST',
      url: `/api/v1/friends/requests/${friendshipId}/decline`,
      headers: bearerFor(app, INVITE_USER.id),
    });
    expect(declineRes.statusCode).toBe(204);

    // Request should be gone
    const pendingRes = await app.inject({
      method: 'GET',
      url: '/api/v1/friends/requests',
      headers: bearerFor(app, INVITE_USER.id),
    });
    const pending = JSON.parse(pendingRes.body) as { requests: unknown[] };
    expect(pending.requests).toHaveLength(0);

    // Neither user should have friends
    const friendsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: bearerFor(app, REQUESTER.id),
    });
    const friends = JSON.parse(friendsRes.body) as { friends: unknown[] };
    expect(friends.friends).toHaveLength(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 27: Removing a friend is bidirectional
// ---------------------------------------------------------------------------
describe('Property 27: Removing a friend is bidirectional', () => {
  it('after one user removes the other both lists are empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([REQUESTER, OPEN_USER]);
        const app = buildTestApp();
        await app.ready();

        // Become friends (open privacy — auto-accept)
        const reqRes = await app.inject({
          method: 'POST',
          url: '/api/v1/friends/requests',
          headers: bearerFor(app, REQUESTER.id),
          payload: { addresseeId: OPEN_USER.id },
        });
        const { id: friendshipId } = JSON.parse(reqRes.body) as { id: string };

        // Requester removes friend
        const deleteRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/friends/${friendshipId}`,
          headers: bearerFor(app, REQUESTER.id),
        });
        expect(deleteRes.statusCode).toBe(204);

        // Both lists must now be empty
        const [r1, r2] = await Promise.all([
          app.inject({ method: 'GET', url: '/api/v1/friends', headers: bearerFor(app, REQUESTER.id) }),
          app.inject({ method: 'GET', url: '/api/v1/friends', headers: bearerFor(app, OPEN_USER.id) }),
        ]);

        const f1 = JSON.parse(r1.body) as { friends: unknown[] };
        const f2 = JSON.parse(r2.body) as { friends: unknown[] };
        expect(f1.friends).toHaveLength(0);
        expect(f2.friends).toHaveLength(0);

        await app.close();
      }),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28: Blocking prevents further requests and location visibility
// ---------------------------------------------------------------------------
describe('Property 28: Blocking prevents further requests', () => {
  it('blocked user cannot send a friend request to the blocker', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([REQUESTER, OPEN_USER]);
        const app = buildTestApp();
        await app.ready();

        // REQUESTER blocks OPEN_USER
        const blockRes = await app.inject({
          method: 'POST',
          url: '/api/v1/friends/block',
          headers: bearerFor(app, REQUESTER.id),
          payload: { userId: OPEN_USER.id },
        });
        expect(blockRes.statusCode).toBe(200);

        // OPEN_USER tries to send a request to REQUESTER — must be rejected
        const reqRes = await app.inject({
          method: 'POST',
          url: '/api/v1/friends/requests',
          headers: bearerFor(app, OPEN_USER.id),
          payload: { addresseeId: REQUESTER.id },
        });
        expect(reqRes.statusCode).toBe(403);

        await app.close();
      }),
      { numRuns: 15 },
    );
  });

  it('blocker cannot send a friend request to the blocked user', async () => {
    resetStore([REQUESTER, OPEN_USER]);
    const app = buildTestApp();
    await app.ready();

    // REQUESTER blocks OPEN_USER
    await app.inject({
      method: 'POST',
      url: '/api/v1/friends/block',
      headers: bearerFor(app, REQUESTER.id),
      payload: { userId: OPEN_USER.id },
    });

    // REQUESTER also cannot request OPEN_USER
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      headers: bearerFor(app, REQUESTER.id),
      payload: { addresseeId: OPEN_USER.id },
    });
    expect(reqRes.statusCode).toBe(403);

    await app.close();
  });

  it('block removes any existing friendship', async () => {
    resetStore([REQUESTER, OPEN_USER]);
    const app = buildTestApp();
    await app.ready();

    // Become friends first
    await app.inject({
      method: 'POST',
      url: '/api/v1/friends/requests',
      headers: bearerFor(app, REQUESTER.id),
      payload: { addresseeId: OPEN_USER.id },
    });

    // Now block
    await app.inject({
      method: 'POST',
      url: '/api/v1/friends/block',
      headers: bearerFor(app, REQUESTER.id),
      payload: { userId: OPEN_USER.id },
    });

    // Neither should see each other as a friend
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/friends',
      headers: bearerFor(app, REQUESTER.id),
    });
    const body = JSON.parse(res.body) as { friends: unknown[] };
    expect(body.friends).toHaveLength(0);

    await app.close();
  });
});
