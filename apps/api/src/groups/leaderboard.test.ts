/**
 * Tests for GET /groups/:id/leaderboard, focused on the caller-rank feature:
 *
 *  - response keeps the existing `leaderboard` array shape (additive change)
 *  - `me` mirrors the caller's list row when they are inside the top-N
 *  - `me` is computed via the ranking query when the caller is outside the
 *    top-N page, with rank consistent with the list ordering (metric DESC,
 *    user id ASC tie-break)
 *  - `me` is null when the caller has no drives recorded in the group
 *  - `me` respects the metric parameter (distance km / convoys / time min)
 *  - non-members get 403; unauthenticated requests get 401
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import groupsRoutes from './groups.routes';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface InMemoryMember {
  group_id: string;
  user_id: string;
  left_at: Date | null;
}

interface InMemoryUser {
  id: string;
  display_name: string;
}

interface InMemoryDrive {
  user_id: string;
  group_id: string;
  distance_m: number;
  duration_s: number;
  top_speed_kph: number;
  ended_at: Date;
}

let members: InMemoryMember[] = [];
let users: InMemoryUser[] = [];
let drives: InMemoryDrive[] = [];

function resetStore(): void {
  members = [];
  users = [];
  drives = [];
}

function addMember(groupId: string, userId: string, displayName = `User ${userId}`): void {
  members.push({ group_id: groupId, user_id: userId, left_at: null });
  if (!users.find((u) => u.id === userId)) users.push({ id: userId, display_name: displayName });
}

function addDrive(groupId: string, userId: string, overrides: Partial<InMemoryDrive> = {}): void {
  drives.push({
    user_id: userId,
    group_id: groupId,
    distance_m: 10_000,
    duration_s: 600,
    top_speed_kph: 100,
    ended_at: new Date('2026-01-01T01:00:00Z'),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Mock Pool implementing the three queries the leaderboard route issues
// ---------------------------------------------------------------------------

interface Agg {
  user_id: string;
  total_distance_m: number;
  total_drives: number;
  total_duration_s: number;
  top_speed_kmh: number;
  last_drive_at: Date | null;
}

function aggregate(groupId: string): Agg[] {
  return members
    .filter((m) => m.group_id === groupId && m.left_at === null)
    .map((m) => {
      const ds = drives.filter((d) => d.user_id === m.user_id && d.group_id === groupId);
      return {
        user_id: m.user_id,
        total_distance_m: ds.reduce((s, d) => s + d.distance_m, 0),
        total_drives: ds.length,
        total_duration_s: ds.reduce((s, d) => s + d.duration_s, 0),
        top_speed_kmh: ds.reduce((mx, d) => Math.max(mx, d.top_speed_kph), 0),
        last_drive_at: ds.length
          ? new Date(Math.max(...ds.map((d) => d.ended_at.getTime())))
          : null,
      };
    });
}

type MetricKey = 'total_distance_m' | 'total_drives' | 'total_duration_s';

function sortByMetric(rows: Agg[], key: MetricKey): Agg[] {
  return [...rows].sort((a, b) => {
    if (b[key] !== a[key]) return b[key] - a[key];
    return a.user_id < b.user_id ? -1 : 1; // u.id ASC tie-break
  });
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // getActiveMember (discriminated by IS_MUTED, which the ranking queries never select)
      if (norm.includes('IS_MUTED') && norm.includes('FROM CONVOY_MEMBERS') && norm.includes('LEFT_AT IS NULL') && norm.includes('USER_ID = $2')) {
        const [groupId, userId] = params as [string, string];
        const m = members.find(
          (mm) => mm.group_id === groupId && mm.user_id === userId && mm.left_at === null,
        );
        return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
      }

      // Caller-rank query (WITH ranked ... ROW_NUMBER)
      if (norm.includes('ROW_NUMBER')) {
        const [groupId, userId] = params as [string, string];
        const key: MetricKey =
          norm.includes('ORDER BY COUNT(DH.ID) DESC') ? 'total_drives' :
          norm.includes('ORDER BY COALESCE(SUM(DH.DURATION_S), 0) DESC') ? 'total_duration_s' :
          'total_distance_m';
        const ranked = sortByMetric(aggregate(groupId), key);
        const idx = ranked.findIndex((r) => r.user_id === userId);
        if (idx === -1) return { rows: [], rowCount: 0 };
        const r = ranked[idx];
        return {
          rows: [{
            rank: String(idx + 1),
            total_distance_m: String(r.total_distance_m),
            total_drives: String(r.total_drives),
            total_duration_s: String(r.total_duration_s),
          }],
          rowCount: 1,
        };
      }

      // Main top-N leaderboard query (JOIN users)
      if (norm.includes('JOIN USERS U') && norm.includes('FROM CONVOY_MEMBERS CM')) {
        const [groupId, limit] = params as [string, number];
        const key: MetricKey =
          norm.includes('ORDER BY TOTAL_DRIVES DESC') ? 'total_drives' :
          norm.includes('ORDER BY TOTAL_DURATION_S DESC') ? 'total_duration_s' :
          'total_distance_m';
        const ranked = sortByMetric(aggregate(groupId), key).slice(0, Number(limit));
        return {
          rows: ranked.map((r) => ({
            id: r.user_id,
            display_name: users.find((u) => u.id === r.user_id)?.display_name ?? 'Unknown',
            avatar_url: null,
            ptt_callsign: null,
            total_distance_m: String(r.total_distance_m),
            total_drives: String(r.total_drives),
            total_duration_s: String(r.total_duration_s),
            top_speed_kmh: String(r.top_speed_kmh),
            last_drive_at: r.last_drive_at,
          })),
          rowCount: ranked.length,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-convoy-leaderboard-tests-32chars!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }), { name: 'db' });
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }), { name: 'redis' });
  app.register(fp(async (inst) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inst.decorate('io', { to: () => ({ emit: () => true }) } as any);
    inst.decorate('enqueueNotification', async () => {});
  }), { name: 'io' });
  app.register(groupsRoutes, { prefix: '/api/v1' });
  return app;
}

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
// Lexicographically ordered user ids so tie-breaks are predictable
const ALICE = '00000000-0000-0000-0002-000000000001';
const BOB   = '00000000-0000-0000-0002-000000000002';
const CARA  = '00000000-0000-0000-0002-000000000003';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetStore();
});

function token(userId: string): string {
  return app.jwt.sign({ sub: userId });
}

function get(url: string, userId: string) {
  return app.inject({ method: 'GET', url, headers: { Authorization: `Bearer ${token(userId)}` } });
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  callsign: string | null;
  totalDistanceKm: number;
  driveCount: number;
  totalDurationMin: number;
  topSpeedKmh: number;
  lastDriveAt: string | null;
  value: number;
}

interface LeaderboardBody {
  leaderboard: LeaderboardEntry[];
  me: { rank: number; value: number } | null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /groups/:id/leaderboard — existing shape preserved', () => {
  it('returns the leaderboard array with all pre-existing fields', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addDrive(GROUP_ID, ALICE, { distance_m: 30_000, duration_s: 1_800 });
    addDrive(GROUP_ID, BOB, { distance_m: 10_000, duration_s: 900 });

    const res = await get(`/api/v1/groups/${GROUP_ID}/leaderboard`, ALICE);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as LeaderboardBody;

    expect(body.leaderboard).toHaveLength(2);
    const first = body.leaderboard[0];
    expect(first.rank).toBe(1);
    expect(first.userId).toBe(ALICE);
    expect(first.totalDistanceKm).toBe(30);
    expect(first.driveCount).toBe(1);
    expect(first.totalDurationMin).toBe(30);
    expect(first.value).toBe(30);
    for (const key of [
      'rank', 'userId', 'displayName', 'avatarUrl', 'callsign', 'totalDistanceKm',
      'driveCount', 'totalDurationMin', 'topSpeedKmh', 'lastDriveAt', 'value',
    ]) {
      expect(first).toHaveProperty(key);
    }
  });

  it('returns 403 for non-members and 401 without a token', async () => {
    addMember(GROUP_ID, ALICE);

    const asStranger = await get(`/api/v1/groups/${GROUP_ID}/leaderboard`, BOB);
    expect(asStranger.statusCode).toBe(403);

    const noAuth = await app.inject({ method: 'GET', url: `/api/v1/groups/${GROUP_ID}/leaderboard` });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('GET /groups/:id/leaderboard — me (caller rank)', () => {
  it('mirrors the caller list row when the caller is inside the top-N', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addDrive(GROUP_ID, ALICE, { distance_m: 30_000 });
    addDrive(GROUP_ID, BOB, { distance_m: 50_000 });

    const res = await get(`/api/v1/groups/${GROUP_ID}/leaderboard`, ALICE);
    const body = JSON.parse(res.body) as LeaderboardBody;

    expect(body.me).toEqual({ rank: 2, value: 30 });
    const mine = body.leaderboard.find((r) => r.userId === ALICE)!;
    expect(body.me!.rank).toBe(mine.rank);
    expect(body.me!.value).toBe(mine.value);
  });

  it('computes rank via the ranking query when the caller is outside the top-N', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addMember(GROUP_ID, CARA);
    addDrive(GROUP_ID, ALICE, { distance_m: 50_000 });
    addDrive(GROUP_ID, BOB, { distance_m: 30_000 });
    addDrive(GROUP_ID, CARA, { distance_m: 10_000 });

    const res = await get(`/api/v1/groups/${GROUP_ID}/leaderboard?limit=1`, CARA);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as LeaderboardBody;

    expect(body.leaderboard).toHaveLength(1);
    expect(body.leaderboard[0].userId).toBe(ALICE);
    expect(body.me).toEqual({ rank: 3, value: 10 });
  });

  it('is null when the caller has no drives in the group (in and out of the top-N page)', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addMember(GROUP_ID, CARA);
    addDrive(GROUP_ID, ALICE, { distance_m: 50_000 });
    addDrive(GROUP_ID, BOB, { distance_m: 30_000 });
    // CARA has no drives

    // CARA appears in the full list (top-20 default) but has no entry → null
    const inPage = await get(`/api/v1/groups/${GROUP_ID}/leaderboard`, CARA);
    expect((JSON.parse(inPage.body) as LeaderboardBody).me).toBeNull();

    // CARA outside a limit=1 page → still null
    const outOfPage = await get(`/api/v1/groups/${GROUP_ID}/leaderboard?limit=1`, CARA);
    expect((JSON.parse(outOfPage.body) as LeaderboardBody).me).toBeNull();
  });

  it('respects metric=convoys (value = drive count)', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addDrive(GROUP_ID, ALICE);
    addDrive(GROUP_ID, BOB);
    addDrive(GROUP_ID, BOB);
    addDrive(GROUP_ID, BOB);

    const res = await get(`/api/v1/groups/${GROUP_ID}/leaderboard?metric=convoys&limit=1`, ALICE);
    const body = JSON.parse(res.body) as LeaderboardBody;

    expect(body.leaderboard[0].userId).toBe(BOB);
    expect(body.me).toEqual({ rank: 2, value: 1 });
  });

  it('respects metric=time (value = total minutes)', async () => {
    addMember(GROUP_ID, ALICE);
    addMember(GROUP_ID, BOB);
    addDrive(GROUP_ID, ALICE, { duration_s: 600 });   // 10 min
    addDrive(GROUP_ID, BOB, { duration_s: 7_200 });   // 120 min

    const res = await get(`/api/v1/groups/${GROUP_ID}/leaderboard?metric=time&limit=1`, ALICE);
    const body = JSON.parse(res.body) as LeaderboardBody;

    expect(body.leaderboard[0].userId).toBe(BOB);
    expect(body.me).toEqual({ rank: 2, value: 10 });
  });
});
