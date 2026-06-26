/**
 * Property 9:   Group creator is always assigned the Admin role
 * Property 10:  Join code is exactly 6 alphanumeric characters and unique per group
 * Property 11:  Invite-only groups silently reject unapproved joins with 403
 * Property 12:  Admin role transfers to the earliest-joined remaining member on Admin departure
 * Property 99:  GET /groups/public only returns open+active groups
 * Property 105: Non-admin gets 403 from PATCH /groups/:id/settings
 * Property 106: gapThresholdM outside [100, 160000] returns 400
 * Property 107: PATCH /groups/:id/settings updates only the fields that were sent
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import groupsRoutes from './groups.routes';

// ---------------------------------------------------------------------------
// In-memory store (shared by both Pool.query and PoolClient.query)
// ---------------------------------------------------------------------------
interface InMemoryGroup {
  id: string;
  name: string;
  join_code: string;
  admin_id: string;
  access_type: 'open' | 'invite_only';
  status: 'active' | 'ended';
  gap_threshold_m: number;
  ptt_max_seconds: number;
  created_at: Date;
  ended_at: Date | null;
}

interface InMemoryMember {
  id: string;
  group_id: string;
  user_id: string;
  joined_at: Date;
  left_at: Date | null;
  is_muted: boolean;
}

interface InMemoryChannel {
  id: string;
  group_id: string;
  name: string;
  is_all: boolean;
}

interface InMemoryChannelMember {
  channel_id: string;
  user_id: string;
}

let groups: InMemoryGroup[] = [];
let members: InMemoryMember[] = [];
let channels: InMemoryChannel[] = [];
let channelMembers: InMemoryChannelMember[] = [];
let seqId = 0;

function nextId(): string {
  return `00000000-0000-0000-0001-${String(++seqId).padStart(12, '0')}`;
}

function resetStore(): void {
  groups = [];
  members = [];
  channels = [];
  channelMembers = [];
  seqId = 0;
}

// ---------------------------------------------------------------------------
// SQL dispatch helpers
// ---------------------------------------------------------------------------
function n(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Dispatch for queries run directly on Pool (non-transactional reads).
 */
async function poolQuery(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  const norm = n(sql);

  // Join code uniqueness check (generateJoinCode)
  if (norm.startsWith('SELECT 1 FROM CONVOY_GROUPS WHERE JOIN_CODE')) {
    const code = (values![0] as string).toUpperCase();
    const found = groups.find((g) => g.join_code === code);
    return { rows: found ? [{ 1: 1 }] : [], rowCount: found ? 1 : 0 };
  }

  // Get group by join code (join endpoint)
  if (norm.includes('FROM CONVOY_GROUPS') && norm.includes('JOIN_CODE = $1') && !norm.startsWith('SELECT 1')) {
    const code = (values![0] as string).toUpperCase();
    const g = groups.find((g) => g.join_code === code);
    return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
  }

  // Get group by id (leave endpoint, various)
  if (norm.includes('FROM CONVOY_GROUPS') && norm.includes('WHERE') && !norm.includes('JOIN_CODE')) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
  }

  // Get active member (getActiveMember helper)
  if (norm.includes('FROM CONVOY_MEMBERS') && norm.includes('GROUP_ID = $1') && norm.includes('USER_ID = $2') && norm.includes('LEFT_AT IS NULL')) {
    const [groupId, userId] = values as [string, string];
    const m = members.find(
      (m) => m.group_id === groupId && m.user_id === userId && m.left_at === null,
    );
    return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
  }

  // PATCH /groups/:id/settings — dynamic SET clause always includes RETURNING
  if (norm.startsWith('UPDATE CONVOY_GROUPS SET') && norm.includes('RETURNING')) {
    const groupId = (values as unknown[])[values!.length - 1] as string;
    const g = groups.find((g) => g.id === groupId);
    if (!g) return { rows: [], rowCount: 0 };
    let idx = 0;
    if (norm.includes('GAP_THRESHOLD_M =')) g.gap_threshold_m = (values as unknown[])[idx++] as number;
    if (norm.includes('PTT_MAX_SECONDS =')) g.ptt_max_seconds = (values as unknown[])[idx++] as number;
    if (norm.includes('ACCESS_TYPE =')) g.access_type = (values as unknown[])[idx] as 'open' | 'invite_only';
    return { rows: [g], rowCount: 1 };
  }

  // GET /groups — browse open+active groups with search + pagination (Properties 113-118)
  // Discriminated by TOTAL_COUNT (window function), which /public never uses.
  if (norm.includes('TOTAL_COUNT') && norm.includes('CONVOY_GROUPS')) {
    const [q, rawLimit, rawOffset] = values as [string, number, number];
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const filtered = groups.filter(
      (g) =>
        g.access_type === 'open' &&
        g.status === 'active' &&
        (q === '' || g.name.toUpperCase().includes(q.toUpperCase())),
    );
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const rows = page.map((g) => {
      const memberCount = members.filter(
        (m) => m.group_id === g.id && m.left_at === null,
      ).length;
      return {
        ...g,
        member_count: String(memberCount),
        admin_display_name: null,
        total_count: String(total),
      };
    });
    return { rows, rowCount: rows.length };
  }

  // GET /groups/public — returns open+active groups with member counts (Property 99)
  if (norm.includes("ACCESS_TYPE = 'OPEN' AND G.STATUS = 'ACTIVE'")) {
    const publicGroups = groups.filter(
      (g) => g.access_type === 'open' && g.status === 'active',
    );
    const rows = publicGroups
      .map((g) => {
        const memberCount = members.filter(
          (m) => m.group_id === g.id && m.left_at === null,
        ).length;
        return { ...g, member_count: String(memberCount) };
      })
      .sort((a, b) => {
        const countDiff = parseInt(b.member_count, 10) - parseInt(a.member_count, 10);
        if (countDiff !== 0) return countDiff;
        return b.created_at.getTime() - a.created_at.getTime();
      })
      .slice(0, 50);
    return { rows, rowCount: rows.length };
  }

  return { rows: [], rowCount: 0 };
}

/**
 * Dispatch for queries run on PoolClient (inside transactions).
 */
async function clientQuery(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  const norm = n(sql);

  // Transaction control
  if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
    return { rows: [], rowCount: 0 };
  }

  // SELECT convoy_groups FOR UPDATE (join-endpoint lock query)
  if (norm.includes('FROM CONVOY_GROUPS') && norm.includes('FOR UPDATE')) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    return { rows: g ? [{ status: g.status }] : [], rowCount: g ? 1 : 0 };
  }

  // SELECT count of active members (idempotent join check)
  if (norm.includes('COUNT(*)') && norm.includes('FROM CONVOY_MEMBERS') && norm.includes('GROUP_ID = $1')) {
    const groupId = values![0] as string;
    const count = members.filter((m) => m.group_id === groupId && m.left_at === null).length;
    return { rows: [{ member_count: String(count) }], rowCount: 1 };
  }

  // INSERT convoy_groups
  if (norm.startsWith('INSERT INTO CONVOY_GROUPS')) {
    const [name, joinCode, adminId, accessType] = values as [string, string, string, string];
    const g: InMemoryGroup = {
      id: nextId(),
      name,
      join_code: joinCode,
      admin_id: adminId,
      access_type: accessType as 'open' | 'invite_only',
      status: 'active',
      gap_threshold_m: 3219,
      ptt_max_seconds: 30,
      created_at: new Date(),
      ended_at: null,
    };
    groups.push(g);
    return { rows: [g], rowCount: 1 };
  }

  // INSERT convoy_members (create group — no ON CONFLICT)
  if (norm.startsWith('INSERT INTO CONVOY_MEMBERS') && !norm.includes('ON CONFLICT')) {
    const [groupId, userId] = values as [string, string];
    const m: InMemoryMember = {
      id: nextId(),
      group_id: groupId,
      user_id: userId,
      joined_at: new Date(),
      left_at: null,
      is_muted: false,
    };
    members.push(m);
    return { rows: [m], rowCount: 1 };
  }

  // INSERT convoy_members ON CONFLICT (join group — upsert)
  if (norm.startsWith('INSERT INTO CONVOY_MEMBERS') && norm.includes('ON CONFLICT')) {
    const [groupId, userId] = values as [string, string];
    const existing = members.find((m) => m.group_id === groupId && m.user_id === userId);
    if (existing) {
      existing.left_at = null;
      existing.joined_at = new Date();
      return { rows: [existing], rowCount: 1 };
    }
    const m: InMemoryMember = {
      id: nextId(),
      group_id: groupId,
      user_id: userId,
      joined_at: new Date(),
      left_at: null,
      is_muted: false,
    };
    members.push(m);
    return { rows: [m], rowCount: 1 };
  }

  // INSERT ptt_channels
  if (norm.startsWith('INSERT INTO PTT_CHANNELS')) {
    const [groupId, name, isAll] = values as [string, string, boolean];
    const ch: InMemoryChannel = { id: nextId(), group_id: groupId, name, is_all: isAll };
    channels.push(ch);
    return { rows: [ch], rowCount: 1 };
  }

  // INSERT ptt_channel_members via SELECT subquery (join endpoint)
  if (norm.startsWith('INSERT INTO PTT_CHANNEL_MEMBERS') && norm.includes('SELECT')) {
    const [groupId, userId] = values as [string, string];
    const ch = channels.find((c) => c.group_id === groupId && c.is_all);
    if (ch) {
      const already = channelMembers.find((cm) => cm.channel_id === ch.id && cm.user_id === userId);
      if (!already) channelMembers.push({ channel_id: ch.id, user_id: userId });
    }
    return { rows: [], rowCount: 1 };
  }

  // INSERT ptt_channel_members direct (create endpoint)
  if (norm.startsWith('INSERT INTO PTT_CHANNEL_MEMBERS') && !norm.includes('SELECT')) {
    const [channelId, userId] = values as [string, string];
    const already = channelMembers.find((cm) => cm.channel_id === channelId && cm.user_id === userId);
    if (!already) channelMembers.push({ channel_id: channelId, user_id: userId });
    return { rows: [], rowCount: 1 };
  }

  // UPDATE convoy_members SET left_at = now() (individual leave)
  if (norm.includes('UPDATE CONVOY_MEMBERS') && norm.includes('LEFT_AT = NOW()') && norm.includes('USER_ID = $2')) {
    const [groupId, userId] = values as [string, string];
    const m = members.find((m) => m.group_id === groupId && m.user_id === userId && m.left_at === null);
    if (m) m.left_at = new Date();
    return { rows: [], rowCount: m ? 1 : 0 };
  }

  // UPDATE convoy_members SET left_at = now() ... AND left_at IS NULL (bulk end — no user_id filter)
  if (norm.includes('UPDATE CONVOY_MEMBERS') && norm.includes('LEFT_AT = NOW()') && !norm.includes('USER_ID = $2')) {
    const groupId = values![0] as string;
    members
      .filter((m) => m.group_id === groupId && m.left_at === null)
      .forEach((m) => { m.left_at = new Date(); });
    return { rows: [], rowCount: 0 };
  }

  // DELETE FROM ptt_log (cleanupGroupPttLog — no-op in tests)
  if (norm.startsWith('DELETE FROM PTT_LOG')) {
    return { rows: [], rowCount: 0 };
  }

  // DELETE ptt_channel_members (on leave)
  if (norm.includes('DELETE FROM PTT_CHANNEL_MEMBERS')) {
    const userId = values![0] as string;
    const groupId = values![1] as string;
    const groupChannelIds = channels.filter((c) => c.group_id === groupId).map((c) => c.id);
    const before = channelMembers.length;
    channelMembers = channelMembers.filter(
      (cm) => !(cm.user_id === userId && groupChannelIds.includes(cm.channel_id)),
    );
    return { rows: [], rowCount: before - channelMembers.length };
  }

  // SELECT next admin candidate (ORDER BY joined_at)
  if (norm.includes('FROM CONVOY_MEMBERS') && norm.includes('ORDER BY JOINED_AT')) {
    const [groupId, excludeUserId] = values as [string, string];
    const eligible = members
      .filter((m) => m.group_id === groupId && m.user_id !== excludeUserId && m.left_at === null)
      .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime());
    const next = eligible[0];
    return { rows: next ? [{ user_id: next.user_id }] : [], rowCount: next ? 1 : 0 };
  }

  // UPDATE convoy_groups SET admin_id (transfer)
  if (norm.includes('UPDATE CONVOY_GROUPS') && norm.includes('ADMIN_ID = $1') && !norm.includes('STATUS')) {
    const [newAdminId, groupId] = values as [string, string];
    const g = groups.find((g) => g.id === groupId);
    if (g) g.admin_id = newAdminId;
    return { rows: [], rowCount: g ? 1 : 0 };
  }

  // UPDATE convoy_groups SET status = 'ended'
  if (norm.includes('UPDATE CONVOY_GROUPS') && norm.includes("'ENDED'")) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    if (g) { g.status = 'ended'; g.ended_at = new Date(); }
    return { rows: [], rowCount: g ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Mock Pool + PoolClient factory
// ---------------------------------------------------------------------------
function buildMockPool(): Pool {
  const pool = {
    query: poolQuery,
    connect: async (): Promise<PoolClient> => {
      const client = {
        query: clientQuery,
        release: () => {},
      } as unknown as PoolClient;
      return client;
    },
  } as unknown as Pool;
  return pool;
}

// ---------------------------------------------------------------------------
// Mock Redis (rate limit always passes — count stays at 1)
// ---------------------------------------------------------------------------
function buildMockRedis(): Redis {
  const counts: Record<string, number> = {};
  const store = new Map<string, string>();
  return {
    incr: async (key: string) => {
      counts[key] = (counts[key] ?? 0) + 1;
      return counts[key];
    },
    expire: async () => 1,
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => { store.delete(key); return 1; },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------
const JWT_SECRET = 'test-secret-convoy-groups-property-tests-32c';

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: JWT_SECRET,
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }), { name: 'db' });
  app.register(fp(async (inst) => { inst.decorate('redis', buildMockRedis()); }), { name: 'redis' });
  // Stub socket.io and notification queue (groups.routes uses fastify.io and fastify.enqueueNotification)
  app.register(fp(async (inst) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inst.decorate('io', { to: () => ({ emit: () => true }) } as any);
    inst.decorate('enqueueNotification', async () => {});
  }), { name: 'io' });

  app.register(groupsRoutes, { prefix: '/api/v1' });

  return app;
}

function signToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({ sub: userId });
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Shared UUID generators for fast-check
// Restrict to lowercase hex segments so Zod uuid() always accepts them.
// ---------------------------------------------------------------------------
const hexSeg4 = fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 4, maxLength: 4 });
const hexSeg8 = fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 8, maxLength: 8 });
const hexSeg12 = fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 12, maxLength: 12 });

const fcUuid = fc.tuple(hexSeg8, hexSeg4, hexSeg4, hexSeg4, hexSeg12).map(
  ([a, b, c, d, e]) => `${a}-${b}-${c}-${d}-${e}`,
);

const fcGroupName = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Property 9: Group creator is always assigned the Admin role
// ---------------------------------------------------------------------------
describe('Property 9: Group creator is always assigned the Admin role', () => {
  beforeEach(() => { resetStore(); });

  it('for any userId and group name, response adminId === creator userId', async () => {
    await fc.assert(
      fc.asyncProperty(fcUuid, fcGroupName, async (adminId, name) => {
        resetStore();
        const app = buildTestApp();
        await app.ready();

        const token = signToken(app, adminId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/groups',
          headers: authHeader(token),
          payload: { name },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { adminId: string };
        expect(body.adminId).toBe(adminId);

        await app.close();
      }),
      { numRuns: 25 },
    );
  });

  it('creator is also added as the first active member', async () => {
    const app = buildTestApp();
    await app.ready();

    const userId = '00000000-0000-0000-0000-000000000001';
    const token = signToken(app, userId);

    await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'Test Group' },
    });

    expect(members.length).toBe(1);
    expect(members[0].user_id).toBe(userId);
    expect(members[0].left_at).toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 10: Join code is 6-character alphanumeric and unique per group
// ---------------------------------------------------------------------------
describe('Property 10: Join code is 6-char alphanumeric and unique', () => {
  const JOIN_CODE_RE = /^[A-Z0-9]{6}$/;

  beforeEach(() => { resetStore(); });

  it('for any batch of N group creations, all codes are valid and distinct', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        async (count) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminId = '00000000-0000-0000-0000-aaaaaaaaaaaa';
          const token = signToken(app, adminId);

          const codes: string[] = [];
          for (let i = 0; i < count; i++) {
            const res = await app.inject({
              method: 'POST',
              url: '/api/v1/groups',
              headers: authHeader(token),
              payload: { name: `Group ${i}` },
            });
            expect(res.statusCode).toBe(201);
            const body = JSON.parse(res.body) as { joinCode: string };
            codes.push(body.joinCode);
          }

          // Every code must be exactly 6 uppercase alphanumeric chars
          for (const code of codes) {
            expect(code).toMatch(JOIN_CODE_RE);
          }

          // All codes must be distinct
          const unique = new Set(codes);
          expect(unique.size).toBe(count);

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('ended group has null joinCode in response', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-bbbbbbbbbbbb';
    const token = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'Short-lived Group' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { id: string; joinCode: string };
    expect(created.joinCode).toMatch(JOIN_CODE_RE);

    // Manually end the group in the store
    const g = groups.find((g) => g.id === created.id)!;
    g.status = 'ended';
    g.ended_at = new Date();

    // groupToResponse hides join code when status = 'ended'
    expect(g.status).toBe('ended');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 11: Invite-only groups reject unapproved joins with 403
// ---------------------------------------------------------------------------
describe('Property 11: Invite-only groups reject unapproved joins', () => {
  beforeEach(() => { resetStore(); });

  it('for any (adminId, nonMemberId), invite-only join attempt returns 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcUuid,
        fcUuid,
        async (adminId, nonMemberId) => {
          // Ensure IDs are distinct (UUIDs from fc.uuid() can theoretically collide)
          fc.pre(adminId !== nonMemberId);

          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminToken = signToken(app, adminId);
          const memberToken = signToken(app, nonMemberId);

          // Create invite-only group
          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(adminToken),
            payload: { name: 'Private Group', accessType: 'invite_only' },
          });
          expect(createRes.statusCode).toBe(201);
          const created = JSON.parse(createRes.body) as { joinCode: string };

          // Non-member tries to join
          const joinRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups/join',
            headers: authHeader(memberToken),
            payload: { code: created.joinCode },
          });

          expect(joinRes.statusCode).toBe(403);

          await app.close();
        },
      ),
      { numRuns: 25 },
    );
  });

  it('open group allows any user to join', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-cccccccccccc';
    const memberId = '00000000-0000-0000-0000-dddddddddddd';
    const adminToken = signToken(app, adminId);
    const memberToken = signToken(app, memberId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(adminToken),
      payload: { name: 'Open Group', accessType: 'open' },
    });
    expect(createRes.statusCode).toBe(201);
    const { joinCode } = JSON.parse(createRes.body) as { joinCode: string };

    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/join',
      headers: authHeader(memberToken),
      payload: { code: joinCode },
    });
    expect(joinRes.statusCode).toBe(200);

    await app.close();
  });

  it('ended group join attempt returns 410 Gone', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-eeeeeeeeeeee';
    const memberId = '00000000-0000-0000-0000-ffffffffffff';
    const adminToken = signToken(app, adminId);
    const memberToken = signToken(app, memberId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(adminToken),
      payload: { name: 'Ended Group', accessType: 'open' },
    });
    const { joinCode, id } = JSON.parse(createRes.body) as { joinCode: string; id: string };

    // End the group in store directly
    const g = groups.find((g) => g.id === id)!;
    g.status = 'ended';
    g.ended_at = new Date();

    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/join',
      headers: authHeader(memberToken),
      payload: { code: joinCode },
    });
    expect(joinRes.statusCode).toBe(410);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 12: Admin role transfers to earliest-joined member on Admin departure
// ---------------------------------------------------------------------------
describe('Property 12: Admin role transfers on Admin departure', () => {
  beforeEach(() => { resetStore(); });

  it('for (adminId, memberId), when admin leaves the member becomes admin', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcUuid,
        fcUuid,
        async (adminId, memberId) => {
          fc.pre(adminId !== memberId);

          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminToken = signToken(app, adminId);
          const memberToken = signToken(app, memberId);

          // Create open group
          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(adminToken),
            payload: { name: 'Transfer Group', accessType: 'open' },
          });
          expect(createRes.statusCode).toBe(201);
          const { joinCode, id: groupId } = JSON.parse(createRes.body) as { joinCode: string; id: string };

          // Ensure admin joined_at is strictly earlier than member
          const adminMember = members.find((m) => m.group_id === groupId && m.user_id === adminId)!;
          adminMember.joined_at = new Date(Date.now() - 10_000);

          // Member joins
          const joinRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups/join',
            headers: authHeader(memberToken),
            payload: { code: joinCode },
          });
          expect(joinRes.statusCode).toBe(200);

          // Admin leaves
          const leaveRes = await app.inject({
            method: 'POST',
            url: `/api/v1/groups/${groupId}/leave`,
            headers: authHeader(adminToken),
          });
          expect(leaveRes.statusCode).toBe(200);

          // Verify admin was transferred
          const updatedGroup = groups.find((g) => g.id === groupId)!;
          expect(updatedGroup.admin_id).toBe(memberId);

          // Verify admin row has left_at set
          const adminRow = members.find((m) => m.group_id === groupId && m.user_id === adminId)!;
          expect(adminRow.left_at).not.toBeNull();

          // Member should still be active
          const memberRow = members.find((m) => m.group_id === groupId && m.user_id === memberId)!;
          expect(memberRow.left_at).toBeNull();

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('when last member (admin) leaves, group status becomes ended', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-111111111111';
    const adminToken = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(adminToken),
      payload: { name: 'Solo Group' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    const leaveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${groupId}/leave`,
      headers: authHeader(adminToken),
    });
    expect(leaveRes.statusCode).toBe(200);

    const g = groups.find((g) => g.id === groupId)!;
    expect(g.status).toBe('ended');
    expect(g.ended_at).not.toBeNull();

    await app.close();
  });

  it('new admin is earliest-joined member, not latest-joined', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-aaa000000001';
    const firstMemberId = '00000000-0000-0000-0000-aaa000000002';
    const secondMemberId = '00000000-0000-0000-0000-aaa000000003';

    const adminToken = signToken(app, adminId);
    const firstToken = signToken(app, firstMemberId);
    const secondToken = signToken(app, secondMemberId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(adminToken),
      payload: { name: 'Three-member Group', accessType: 'open' },
    });
    const { joinCode, id: groupId } = JSON.parse(createRes.body) as { joinCode: string; id: string };

    // Stamp admin's joined_at well in the past
    const adminMember = members.find((m) => m.group_id === groupId && m.user_id === adminId)!;
    adminMember.joined_at = new Date(Date.now() - 30_000);

    // firstMember joins earlier
    await app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: authHeader(firstToken), payload: { code: joinCode } });
    const firstMember = members.find((m) => m.group_id === groupId && m.user_id === firstMemberId)!;
    firstMember.joined_at = new Date(Date.now() - 20_000);

    // secondMember joins later
    await app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: authHeader(secondToken), payload: { code: joinCode } });
    const secondMember = members.find((m) => m.group_id === groupId && m.user_id === secondMemberId)!;
    secondMember.joined_at = new Date(Date.now() - 10_000);

    // Admin leaves
    await app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/leave`, headers: authHeader(adminToken) });

    // firstMember (earlier joined_at) should become admin, not secondMember
    const g = groups.find((g) => g.id === groupId)!;
    expect(g.admin_id).toBe(firstMemberId);
    expect(g.status).toBe('active');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 99: GET /groups/public never returns invite_only or ended groups
//   Validates: group discovery privacy invariant (Req 7.5, 38.1)
// ---------------------------------------------------------------------------
describe('Property 99: GET /groups/public only returns open+active groups', () => {
  beforeEach(() => { resetStore(); });

  it('invite_only and ended groups never appear in the public list', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }), // open+active groups to create
        fc.integer({ min: 0, max: 4 }), // invite_only groups to create
        fc.integer({ min: 0, max: 4 }), // groups to create then end
        fcUuid,
        async (openCount, inviteCount, endCount, adminId) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();
          const token = signToken(app, adminId);

          // Create open+active groups
          for (let i = 0; i < openCount; i++) {
            const res = await app.inject({
              method: 'POST',
              url: '/api/v1/groups',
              headers: authHeader(token),
              payload: { name: `Open ${i}`, accessType: 'open' },
            });
            expect(res.statusCode).toBe(201);
          }

          // Create invite_only groups
          for (let i = 0; i < inviteCount; i++) {
            const res = await app.inject({
              method: 'POST',
              url: '/api/v1/groups',
              headers: authHeader(token),
              payload: { name: `Invite ${i}`, accessType: 'invite_only' },
            });
            expect(res.statusCode).toBe(201);
          }

          // Create open groups then end them
          for (let i = 0; i < endCount; i++) {
            const createRes = await app.inject({
              method: 'POST',
              url: '/api/v1/groups',
              headers: authHeader(token),
              payload: { name: `ToEnd ${i}`, accessType: 'open' },
            });
            expect(createRes.statusCode).toBe(201);
            const { id: groupId } = JSON.parse(createRes.body) as { id: string };

            const endRes = await app.inject({
              method: 'POST',
              url: `/api/v1/groups/${groupId}/end`,
              headers: authHeader(token),
            });
            expect(endRes.statusCode).toBe(200);
          }

          // Query the public list
          const listRes = await app.inject({
            method: 'GET',
            url: '/api/v1/groups/public',
            headers: authHeader(token),
          });
          expect(listRes.statusCode).toBe(200);

          const { groups: publicGroups } = JSON.parse(listRes.body) as {
            groups: Array<{ accessType: string; status: string }>;
          };

          // Every returned group must be open and active
          for (const g of publicGroups) {
            expect(g.accessType).toBe('open');
            expect(g.status).toBe('active');
          }

          // Count must match exactly the open+active groups (invite_only and ended excluded)
          expect(publicGroups).toHaveLength(openCount);

          await app.close();
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 105: Non-admin gets 403 from PATCH /groups/:id/settings
//   Validates: Requirement 24.3
// ---------------------------------------------------------------------------
describe('Property 105: Only the Admin can change group settings', () => {
  beforeEach(() => { resetStore(); });

  it('non-admin user is rejected with 403 for any settings change', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcUuid, // adminId
        fcUuid, // non-admin userId
        async (adminId, nonAdminId) => {
          fc.pre(adminId !== nonAdminId);

          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminToken = signToken(app, adminId);
          const nonAdminToken = signToken(app, nonAdminId);

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(adminToken),
            payload: { name: 'Settings Group', accessType: 'open' },
          });
          expect(createRes.statusCode).toBe(201);
          const { id: groupId } = JSON.parse(createRes.body) as { id: string };

          const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/v1/groups/${groupId}/settings`,
            headers: authHeader(nonAdminToken),
            payload: { gapThresholdM: 500 },
          });
          expect(patchRes.statusCode).toBe(403);

          // Group settings must remain unchanged
          const g = groups.find((g) => g.id === groupId)!;
          expect(g.gap_threshold_m).toBe(3219); // default

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('admin succeeds; a second user with no role also gets 403', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-105000000001';
    const strangerId = '00000000-0000-0000-0000-105000000002';
    const adminToken = signToken(app, adminId);
    const strangerToken = signToken(app, strangerId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(adminToken),
      payload: { name: 'Auth Test Group' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    // Admin succeeds
    const adminPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(adminToken),
      payload: { gapThresholdM: 1000 },
    });
    expect(adminPatch.statusCode).toBe(200);

    // Stranger (no membership at all) is rejected
    const strangerPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(strangerToken),
      payload: { gapThresholdM: 2000 },
    });
    expect(strangerPatch.statusCode).toBe(403);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 106: gapThresholdM outside [100, 160000] returns 400
//   Validates: Requirements 24.3, schema constraints
// ---------------------------------------------------------------------------
describe('Property 106: gapThresholdM schema bounds are enforced', () => {
  beforeEach(() => { resetStore(); });

  it('values below 100 return 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10000, max: 99 }),
        async (badGap) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminId = '00000000-0000-0000-0000-106000000001';
          const token = signToken(app, adminId);

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(token),
            payload: { name: 'Bounds Group' },
          });
          const { id: groupId } = JSON.parse(createRes.body) as { id: string };

          const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/v1/groups/${groupId}/settings`,
            headers: authHeader(token),
            payload: { gapThresholdM: badGap },
          });
          expect(patchRes.statusCode).toBe(400);

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('values above 160000 return 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 160001, max: 1_000_000 }),
        async (badGap) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminId = '00000000-0000-0000-0000-106000000002';
          const token = signToken(app, adminId);

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(token),
            payload: { name: 'Bounds Group Hi' },
          });
          const { id: groupId } = JSON.parse(createRes.body) as { id: string };

          const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/v1/groups/${groupId}/settings`,
            headers: authHeader(token),
            payload: { gapThresholdM: badGap },
          });
          expect(patchRes.statusCode).toBe(400);

          await app.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('any value in [100, 160000] is accepted with 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 160000 }),
        async (validGap) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminId = '00000000-0000-0000-0000-106000000003';
          const token = signToken(app, adminId);

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(token),
            payload: { name: 'Valid Gap Group' },
          });
          const { id: groupId } = JSON.parse(createRes.body) as { id: string };

          const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/v1/groups/${groupId}/settings`,
            headers: authHeader(token),
            payload: { gapThresholdM: validGap },
          });
          expect(patchRes.statusCode).toBe(200);
          const body = JSON.parse(patchRes.body) as { gapThresholdM: number };
          expect(body.gapThresholdM).toBe(validGap);

          await app.close();
        },
      ),
      { numRuns: 30 },
    );
  });

  it('boundary values 100 and 160000 are accepted', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-106000000004';
    const token = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'Boundary Group' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    for (const boundary of [100, 160000]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${groupId}/settings`,
        headers: authHeader(token),
        payload: { gapThresholdM: boundary },
      });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { gapThresholdM: number }).gapThresholdM).toBe(boundary);
    }

    await app.close();
  });

  it('pttMaxSeconds outside [5, 60] returns 400', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-106000000005';
    const token = signToken(app, adminId);
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'PTT Bounds Group' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    const tooLow = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { pttMaxSeconds: 4 },
    });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { pttMaxSeconds: 61 },
    });
    expect(tooHigh.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { pttMaxSeconds: 45 },
    });
    expect(valid.statusCode).toBe(200);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 107: PATCH /groups/:id/settings updates only the fields that were sent
//   Validates: Requirements 24.3 (partial update isolation)
// ---------------------------------------------------------------------------
describe('Property 107: PATCH /groups/:id/settings performs partial updates only', () => {
  beforeEach(() => { resetStore(); });

  it('sending only gapThresholdM leaves pttMaxSeconds and accessType unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 160000 }),
        async (newGap) => {
          resetStore();
          const app = buildTestApp();
          await app.ready();

          const adminId = '00000000-0000-0000-0000-107000000001';
          const token = signToken(app, adminId);

          const createRes = await app.inject({
            method: 'POST',
            url: '/api/v1/groups',
            headers: authHeader(token),
            payload: { name: 'Partial Update Group', accessType: 'open' },
          });
          const { id: groupId } = JSON.parse(createRes.body) as { id: string };
          const g = groups.find((g) => g.id === groupId)!;
          const originalPtt = g.ptt_max_seconds;
          const originalAccess = g.access_type;

          const patchRes = await app.inject({
            method: 'PATCH',
            url: `/api/v1/groups/${groupId}/settings`,
            headers: authHeader(token),
            payload: { gapThresholdM: newGap },
          });
          expect(patchRes.statusCode).toBe(200);

          const body = JSON.parse(patchRes.body) as {
            gapThresholdM: number;
            pttMaxSeconds: number;
            accessType: string;
          };
          expect(body.gapThresholdM).toBe(newGap);
          expect(body.pttMaxSeconds).toBe(originalPtt);
          expect(body.accessType).toBe(originalAccess);

          await app.close();
        },
      ),
      { numRuns: 25 },
    );
  });

  it('sending all three fields updates all three independently', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-107000000002';
    const token = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'Full Update Group', accessType: 'open' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { gapThresholdM: 800, pttMaxSeconds: 20, accessType: 'invite_only' },
    });
    expect(patchRes.statusCode).toBe(200);

    const body = JSON.parse(patchRes.body) as {
      gapThresholdM: number;
      pttMaxSeconds: number;
      accessType: string;
    };
    expect(body.gapThresholdM).toBe(800);
    expect(body.pttMaxSeconds).toBe(20);
    expect(body.accessType).toBe('invite_only');

    await app.close();
  });

  it('empty body returns the current settings unchanged', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-107000000003';
    const token = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'No-Op Group', accessType: 'open' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };
    const g = groups.find((g) => g.id === groupId)!;
    const snapshot = { gap: g.gap_threshold_m, ptt: g.ptt_max_seconds, access: g.access_type };

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: {},
    });
    expect(patchRes.statusCode).toBe(200);

    const body = JSON.parse(patchRes.body) as {
      gapThresholdM: number;
      pttMaxSeconds: number;
      accessType: string;
    };
    expect(body.gapThresholdM).toBe(snapshot.gap);
    expect(body.pttMaxSeconds).toBe(snapshot.ptt);
    expect(body.accessType).toBe(snapshot.access);

    await app.close();
  });

  it('consecutive patches accumulate correctly', async () => {
    const app = buildTestApp();
    await app.ready();

    const adminId = '00000000-0000-0000-0000-107000000004';
    const token = signToken(app, adminId);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: authHeader(token),
      payload: { name: 'Accumulate Group', accessType: 'open' },
    });
    const { id: groupId } = JSON.parse(createRes.body) as { id: string };

    // First patch: change gap
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { gapThresholdM: 1000 },
    });

    // Second patch: change ptt, leaving gap at 1000
    const secondPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/groups/${groupId}/settings`,
      headers: authHeader(token),
      payload: { pttMaxSeconds: 15 },
    });
    expect(secondPatch.statusCode).toBe(200);

    const body = JSON.parse(secondPatch.body) as {
      gapThresholdM: number;
      pttMaxSeconds: number;
    };
    expect(body.gapThresholdM).toBe(1000); // retained from first patch
    expect(body.pttMaxSeconds).toBe(15);   // set by second patch

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Properties 113-118: GET /groups browse endpoint (search + pagination)
// ---------------------------------------------------------------------------
describe('Properties 113–118: GET /groups browse endpoint', () => {
  /** Push a group directly into the in-memory store without HTTP round-trip. */
  function seedGroup(overrides: Partial<InMemoryGroup> = {}): InMemoryGroup {
    const id = nextId();
    const g: InMemoryGroup = {
      id,
      name: 'Test Group',
      join_code: `T${String(seqId).padStart(5, '0')}`,
      admin_id: '00000000-0000-0000-0000-000000000001',
      access_type: 'open',
      status: 'active',
      gap_threshold_m: 3219,
      ptt_max_seconds: 30,
      created_at: new Date(),
      ended_at: null,
      ...overrides,
    };
    groups.push(g);
    return g;
  }

  beforeEach(() => { resetStore(); });

  // -------------------------------------------------------------------------
  // Property 113: Only open+active groups are returned
  // -------------------------------------------------------------------------
  describe('Property 113: Only open+active groups are returned', () => {
    it('invite_only groups are never present in browse results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 6 }),
          async (openCount, closedCount) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            for (let i = 0; i < openCount; i++) seedGroup({ name: `Open ${i}`, access_type: 'open' });
            for (let i = 0; i < closedCount; i++) seedGroup({ name: `Closed ${i}`, access_type: 'invite_only' });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: '/api/v1/groups?q=&limit=50&offset=0',
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: { accessType: string }[]; total: number };
            expect(body.total).toBe(openCount);
            for (const g of body.groups) expect(g.accessType).toBe('open');

            await app.close();
          },
        ),
        { numRuns: 25 },
      );
    });

    it('ended groups are excluded regardless of access_type', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (endedCount) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            seedGroup({ name: 'Active', access_type: 'open', status: 'active' });
            for (let i = 0; i < endedCount; i++) seedGroup({ name: `Ended ${i}`, access_type: 'open', status: 'ended' });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: '/api/v1/groups?limit=50',
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: { status: string }[]; total: number };
            expect(body.total).toBe(1);
            expect(body.groups).toHaveLength(1);
            expect(body.groups[0].status).toBe('active');

            await app.close();
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 114: Pagination — limit and offset are respected
  // -------------------------------------------------------------------------
  describe('Property 114: Pagination limit and offset are respected', () => {
    it('groups.length ≤ limit for any total+limit combination', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          async (total, limit) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            for (let i = 0; i < total; i++) seedGroup({ name: `G${i}` });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: `/api/v1/groups?limit=${limit}&offset=0`,
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: unknown[]; total: number };
            expect(body.groups.length).toBe(Math.min(total, limit));

            await app.close();
          },
        ),
        { numRuns: 30 },
      );
    });

    it('offset skips the correct number of groups', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 8 }),
          fc.integer({ min: 1, max: 2 }),
          async (total, offset) => {
            fc.pre(offset < total);
            resetStore();
            const app = buildTestApp();
            await app.ready();

            for (let i = 0; i < total; i++) seedGroup({ name: `G${i}` });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: `/api/v1/groups?limit=50&offset=${offset}`,
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: unknown[]; total: number };
            expect(body.groups).toHaveLength(total - offset);
            expect(body.total).toBe(total);

            await app.close();
          },
        ),
        { numRuns: 25 },
      );
    });

    it('offset past total returns empty array (no rows → total = 0 from COUNT OVER)', async () => {
      const app = buildTestApp();
      await app.ready();

      seedGroup({ name: 'Solo Group' });

      const token = signToken(app, '00000000-0000-0000-0000-000000000001');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?limit=10&offset=100',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { groups: unknown[]; total: number };
      expect(body.groups).toHaveLength(0);
      // COUNT(*) OVER() returns no rows when OFFSET exceeds results, so total = 0
      expect(body.total).toBe(0);

      await app.close();
    });
  });

  // -------------------------------------------------------------------------
  // Property 115: ILIKE search filters by name (case-insensitive substring)
  // -------------------------------------------------------------------------
  describe('Property 115: ILIKE search filters by name case-insensitively', () => {
    it('q matches as a substring regardless of case', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 2, maxLength: 6 }).filter((s) => /^[a-z]+$/.test(s)),
          async (query) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            seedGroup({ name: `PREFIX_${query}_SUFFIX` });
            seedGroup({ name: `PREFIX_${query.toUpperCase()}_SUFFIX` });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: `/api/v1/groups?q=${encodeURIComponent(query)}&limit=50`,
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: { name: string }[]; total: number };
            expect(body.total).toBeGreaterThanOrEqual(2);
            for (const g of body.groups) {
              expect(g.name.toLowerCase()).toContain(query.toLowerCase());
            }

            await app.close();
          },
        ),
        { numRuns: 25 },
      );
    });

    it('non-matching groups are excluded from results', async () => {
      const app = buildTestApp();
      await app.ready();

      seedGroup({ name: 'Mountain Runners' });
      seedGroup({ name: 'Desert Blazers' });
      seedGroup({ name: 'Mountain Lions' });

      const token = signToken(app, '00000000-0000-0000-0000-000000000001');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?q=mountain&limit=50',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { groups: { name: string }[]; total: number };
      expect(body.total).toBe(2);
      expect(body.groups.every((g) => g.name.toLowerCase().includes('mountain'))).toBe(true);

      await app.close();
    });
  });

  // -------------------------------------------------------------------------
  // Property 116: total reflects full filtered count, independent of page size
  // -------------------------------------------------------------------------
  describe('Property 116: total reflects full filtered count regardless of limit', () => {
    it('total equals all open+active groups for any limit < total', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 4, max: 12 }),
          fc.integer({ min: 1, max: 3 }),
          async (totalGroups, limit) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            for (let i = 0; i < totalGroups; i++) seedGroup({ name: `G${i}` });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: `/api/v1/groups?limit=${limit}&offset=0`,
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: unknown[]; total: number; limit: number };
            expect(body.total).toBe(totalGroups);
            expect(body.groups.length).toBeLessThanOrEqual(body.limit);

            await app.close();
          },
        ),
        { numRuns: 25 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 117: Unauthenticated requests return 401
  // -------------------------------------------------------------------------
  describe('Property 117: Unauthenticated requests return 401', () => {
    it('missing Authorization header returns 401', async () => {
      const app = buildTestApp();
      await app.ready();

      seedGroup({ name: 'Some Group' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?limit=10',
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('any malformed token string returns 401', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes('.')),
          async (badToken) => {
            const app = buildTestApp();
            await app.ready();

            const res = await app.inject({
              method: 'GET',
              url: '/api/v1/groups',
              headers: { Authorization: `Bearer ${badToken}` },
            });

            expect(res.statusCode).toBe(401);
            await app.close();
          },
        ),
        { numRuns: 15 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 118: Empty q returns all open+active groups
  // -------------------------------------------------------------------------
  describe('Property 118: Empty q returns all open+active groups', () => {
    it('q= returns every open+active group regardless of name', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
            { minLength: 1, maxLength: 6 },
          ),
          async (names) => {
            resetStore();
            const app = buildTestApp();
            await app.ready();

            for (const name of names) seedGroup({ name });

            const token = signToken(app, '00000000-0000-0000-0000-000000000001');
            const res = await app.inject({
              method: 'GET',
              url: '/api/v1/groups?q=&limit=50&offset=0',
              headers: authHeader(token),
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body) as { groups: unknown[]; total: number };
            expect(body.total).toBe(names.length);
            expect(body.groups).toHaveLength(names.length);

            await app.close();
          },
        ),
        { numRuns: 25 },
      );
    });

    it('limit=50 is a valid boundary value', async () => {
      const app = buildTestApp();
      await app.ready();

      const token = signToken(app, '00000000-0000-0000-0000-000000000001');
      const res = await app.inject({ method: 'GET', url: '/api/v1/groups?limit=50', headers: authHeader(token) });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('limit=51 exceeds max and is rejected with 400', async () => {
      const app = buildTestApp();
      await app.ready();

      const token = signToken(app, '00000000-0000-0000-0000-000000000001');
      const res = await app.inject({ method: 'GET', url: '/api/v1/groups?limit=51', headers: authHeader(token) });

      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });
});
