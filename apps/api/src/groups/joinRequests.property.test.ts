/**
 * Property tests for the invite-only group join-request flow.
 *
 * Invite-only groups (convoy_groups.access_type = 'invite_only') have no
 * direct join path — POST /groups/join (by code) and POST /groups/:id/members
 * both 403 for them. These routes add an admin-approval request flow:
 *   POST /groups/:id/join-request
 *   GET  /groups/:id/join-requests            (admin only)
 *   POST /groups/:id/join-requests/:id/approve (admin only)
 *   POST /groups/:id/join-requests/:id/reject  (admin only)
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import joinRequestsRoutes from './joinRequests.routes';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
interface InMemoryGroup {
  id: string;
  admin_id: string;
  access_type: 'open' | 'invite_only';
  status: 'active' | 'ended';
}

interface InMemoryMember {
  group_id: string;
  user_id: string;
  left_at: Date | null;
}

interface InMemoryJoinRequest {
  id: string;
  group_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

interface InMemoryUser {
  id: string;
  display_name: string;
  avatar_url: string | null;
  ptt_callsign: string | null;
}

let groups: Map<string, InMemoryGroup>;
let members: InMemoryMember[];
let joinRequests: InMemoryJoinRequest[];
let users: Map<string, InMemoryUser>;
let pttChannelMembers: Array<{ group_id: string; user_id: string }>;
let requestCounter: number;
let rateLimitStore: Map<string, { count: number; expiry: number }>;
let notifications: Array<{ userId: string; type: string; data?: Record<string, string> }>;

function nextId(): string {
  return `jr-${++requestCounter}`;
}

function resetStore(testGroups: InMemoryGroup[], testUsers: InMemoryUser[]) {
  groups = new Map(testGroups.map((g) => [g.id, g]));
  members = testGroups.map((g) => ({ group_id: g.id, user_id: g.admin_id, left_at: null }));
  joinRequests = [];
  users = new Map(testUsers.map((u) => [u.id, u]));
  pttChannelMembers = [];
  requestCounter = 0;
  rateLimitStore = new Map();
  notifications = [];
}

async function dispatchQuery(sql: string, params?: unknown[]) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

  // Fetch group
  if (normalized.startsWith('SELECT ID, ADMIN_ID, ACCESS_TYPE, STATUS FROM CONVOY_GROUPS WHERE ID = $1')) {
    const [id] = params as [string];
    const g = groups.get(id);
    return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
  }

  // Fetch group (reject handler's narrower select)
  if (normalized.startsWith('SELECT ID, ADMIN_ID FROM CONVOY_GROUPS WHERE ID = $1')) {
    const [id] = params as [string];
    const g = groups.get(id);
    return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
  }

  // Active membership check
  if (normalized.startsWith('SELECT 1 FROM CONVOY_MEMBERS WHERE GROUP_ID = $1 AND USER_ID = $2 AND LEFT_AT IS NULL')) {
    const [groupId, userId] = params as [string, string];
    const found = members.find((m) => m.group_id === groupId && m.user_id === userId && m.left_at === null);
    return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
  }

  // Pending request check
  if (normalized.startsWith("SELECT 1 FROM GROUP_JOIN_REQUESTS WHERE GROUP_ID = $1 AND USER_ID = $2 AND STATUS = 'PENDING'")) {
    const [groupId, userId] = params as [string, string];
    const found = joinRequests.find((r) => r.group_id === groupId && r.user_id === userId && r.status === 'pending');
    return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
  }

  // Insert join request
  if (normalized.startsWith('INSERT INTO GROUP_JOIN_REQUESTS')) {
    const [groupId, userId] = params as [string, string];
    // Enforce the partial unique index (group_id, user_id) WHERE status = 'pending'
    const dup = joinRequests.find((r) => r.group_id === groupId && r.user_id === userId && r.status === 'pending');
    if (dup) {
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    const row: InMemoryJoinRequest = {
      id: nextId(),
      group_id: groupId,
      user_id: userId,
      status: 'pending',
      created_at: new Date(),
      resolved_at: null,
      resolved_by: null,
    };
    joinRequests.push(row);
    return { rows: [row], rowCount: 1 };
  }

  // List pending join requests with user info (admin GET)
  if (normalized.startsWith('SELECT R.ID, R.GROUP_ID, R.USER_ID, R.STATUS, R.CREATED_AT, R.RESOLVED_AT, R.RESOLVED_BY')) {
    const [groupId] = params as [string];
    const rows = joinRequests
      .filter((r) => r.group_id === groupId && r.status === 'pending')
      .map((r) => {
        const u = users.get(r.user_id);
        return {
          ...r,
          display_name: u?.display_name ?? '',
          avatar_url: u?.avatar_url ?? null,
          ptt_callsign: u?.ptt_callsign ?? null,
        };
      });
    return { rows, rowCount: rows.length };
  }

  // Reject: update status
  if (normalized.startsWith("UPDATE GROUP_JOIN_REQUESTS") && normalized.includes("STATUS = 'REJECTED'")) {
    const [adminUserId, requestId, groupId] = params as [string, string, string];
    const row = joinRequests.find((r) => r.id === requestId && r.group_id === groupId && r.status === 'pending');
    if (row) {
      row.status = 'rejected';
      row.resolved_at = new Date();
      row.resolved_by = adminUserId;
    }
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

function buildMockPool(): Pool {
  const pool = {
    query: dispatchQuery,
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

          // Lock + fetch join request row (approve handler)
          if (normalized.startsWith('SELECT ID, GROUP_ID, USER_ID, STATUS FROM GROUP_JOIN_REQUESTS') && normalized.includes('FOR UPDATE')) {
            const [requestId, groupId] = params as [string, string];
            const row = joinRequests.find((r) => r.id === requestId && r.group_id === groupId);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          // Insert/upsert membership
          if (normalized.startsWith('INSERT INTO CONVOY_MEMBERS')) {
            const [groupId, userId] = params as [string, string];
            const existing = members.find((m) => m.group_id === groupId && m.user_id === userId);
            if (existing) {
              existing.left_at = null;
            } else {
              members.push({ group_id: groupId, user_id: userId, left_at: null });
            }
            return { rows: [], rowCount: 1 };
          }

          // PTT "All" channel membership — no-op store for these tests
          if (normalized.startsWith('INSERT INTO PTT_CHANNEL_MEMBERS')) {
            const [groupId, userId] = params as [string, string];
            pttChannelMembers.push({ group_id: groupId, user_id: userId });
            return { rows: [], rowCount: 1 };
          }

          // Mark request approved
          if (normalized.startsWith('UPDATE GROUP_JOIN_REQUESTS') && normalized.includes("STATUS = 'APPROVED'")) {
            const [adminUserId, requestId] = params as [string, string];
            const row = joinRequests.find((r) => r.id === requestId);
            if (row) {
              row.status = 'approved';
              row.resolved_at = new Date();
              row.resolved_by = adminUserId;
            }
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          return dispatchQuery(sql, params);
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
  app.register(fp(async (i) => {
    i.decorate('enqueueNotification', async (job: { userId: string; type: string; data?: Record<string, string> }) => {
      notifications.push(job);
    });
  }, { name: 'enqueueNotification' }));
  app.register(joinRequestsRoutes, { prefix: '/api/v1' });

  return app;
}

function bearerFor(app: FastifyInstance, userId: string): Record<string, string> {
  return { Authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

// ---------------------------------------------------------------------------
// Fixtures — IDs must be valid UUIDs
// ---------------------------------------------------------------------------
const ADMIN_ID = '00000000-0000-0000-0000-0000000000a1';
const REQUESTER_ID = '00000000-0000-0000-0000-0000000000b1';
const REQUESTER2_ID = '00000000-0000-0000-0000-0000000000b2';

const INVITE_GROUP: InMemoryGroup = {
  id: '00000000-0000-0000-0000-0000000000c1',
  admin_id: ADMIN_ID,
  access_type: 'invite_only',
  status: 'active',
};
const OPEN_GROUP: InMemoryGroup = {
  id: '00000000-0000-0000-0000-0000000000c2',
  admin_id: ADMIN_ID,
  access_type: 'open',
  status: 'active',
};

const TEST_USERS: InMemoryUser[] = [
  { id: ADMIN_ID, display_name: 'Admin', avatar_url: null, ptt_callsign: null },
  { id: REQUESTER_ID, display_name: 'Requester', avatar_url: null, ptt_callsign: 'R-1' },
  { id: REQUESTER2_ID, display_name: 'Requester Two', avatar_url: null, ptt_callsign: null },
];

// ---------------------------------------------------------------------------
// Join-request lifecycle
// ---------------------------------------------------------------------------
describe('Join requests: invite-only groups get a working join path', () => {
  it('a request against an open group is rejected — use the direct join route instead', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([OPEN_GROUP], TEST_USERS);
        const app = buildTestApp();
        await app.ready();

        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/groups/${OPEN_GROUP.id}/join-request`,
          headers: bearerFor(app, REQUESTER_ID),
        });

        expect(res.statusCode).toBe(400);
        await app.close();
      }),
      { numRuns: 5 },
    );
  });

  it('request -> admin sees it pending -> approve -> requester becomes a member, notified both times', async () => {
    resetStore([INVITE_GROUP], TEST_USERS);
    const app = buildTestApp();
    await app.ready();

    const reqRes = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
      headers: bearerFor(app, REQUESTER_ID),
    });
    expect(reqRes.statusCode).toBe(201);
    const { id: requestId, status } = JSON.parse(reqRes.body) as { id: string; status: string };
    expect(status).toBe('pending');

    // Admin notified of the new request
    expect(notifications.some((n) => n.userId === ADMIN_ID && n.type === 'group_invite')).toBe(true);

    // Non-admin cannot list
    const forbiddenList = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests`,
      headers: bearerFor(app, REQUESTER_ID),
    });
    expect(forbiddenList.statusCode).toBe(403);

    // Admin sees the pending request
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests`,
      headers: bearerFor(app, ADMIN_ID),
    });
    expect(listRes.statusCode).toBe(200);
    const { requests } = JSON.parse(listRes.body) as { requests: Array<{ id: string; displayName: string }> };
    expect(requests).toHaveLength(1);
    expect(requests[0].id).toBe(requestId);
    expect(requests[0].displayName).toBe('Requester');

    // Approve
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests/${requestId}/approve`,
      headers: bearerFor(app, ADMIN_ID),
    });
    expect(approveRes.statusCode).toBe(200);
    expect((JSON.parse(approveRes.body) as { status: string }).status).toBe('approved');

    // Requester is now an active member
    const isMember = members.some(
      (m) => m.group_id === INVITE_GROUP.id && m.user_id === REQUESTER_ID && m.left_at === null,
    );
    expect(isMember).toBe(true);

    // Requester notified of the approval
    expect(
      notifications.some((n) => n.userId === REQUESTER_ID && n.type === 'group_invite'),
    ).toBe(true);

    // Pending list is now empty
    const listAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests`,
      headers: bearerFor(app, ADMIN_ID),
    });
    expect((JSON.parse(listAfter.body) as { requests: unknown[] }).requests).toHaveLength(0);

    // Re-approving an already-resolved request conflicts
    const reApprove = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests/${requestId}/approve`,
      headers: bearerFor(app, ADMIN_ID),
    });
    expect(reApprove.statusCode).toBe(409);

    await app.close();
  });

  it('reject leaves the requester without membership and lets them request again', async () => {
    resetStore([INVITE_GROUP], TEST_USERS);
    const app = buildTestApp();
    await app.ready();

    const reqRes = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
      headers: bearerFor(app, REQUESTER2_ID),
    });
    const { id: requestId } = JSON.parse(reqRes.body) as { id: string };

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-requests/${requestId}/reject`,
      headers: bearerFor(app, ADMIN_ID),
    });
    expect(rejectRes.statusCode).toBe(200);
    expect((JSON.parse(rejectRes.body) as { status: string }).status).toBe('rejected');

    const isMember = members.some(
      (m) => m.group_id === INVITE_GROUP.id && m.user_id === REQUESTER2_ID && m.left_at === null,
    );
    expect(isMember).toBe(false);

    // Requester notified of the rejection
    expect(
      notifications.some((n) => n.userId === REQUESTER2_ID && n.type === 'group_invite'),
    ).toBe(true);

    // Free to request again after a rejection
    const secondReq = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
      headers: bearerFor(app, REQUESTER2_ID),
    });
    expect(secondReq.statusCode).toBe(201);

    await app.close();
  });

  it('a duplicate pending request from the same user is rejected as a conflict', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([INVITE_GROUP], TEST_USERS);
        const app = buildTestApp();
        await app.ready();

        const first = await app.inject({
          method: 'POST',
          url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
          headers: bearerFor(app, REQUESTER_ID),
        });
        expect(first.statusCode).toBe(201);

        const second = await app.inject({
          method: 'POST',
          url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
          headers: bearerFor(app, REQUESTER_ID),
        });
        expect(second.statusCode).toBe(409);

        await app.close();
      }),
      { numRuns: 5 },
    );
  });

  it('an existing member cannot request to join their own group', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetStore([INVITE_GROUP], TEST_USERS);
        const app = buildTestApp();
        await app.ready();

        // Admin is already a member of their own group (see resetStore)
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/groups/${INVITE_GROUP.id}/join-request`,
          headers: bearerFor(app, ADMIN_ID),
        });
        expect(res.statusCode).toBe(409);

        await app.close();
      }),
      { numRuns: 5 },
    );
  });
});
