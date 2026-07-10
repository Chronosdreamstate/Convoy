/**
 * Hardening/regression tests for the drives API.
 *
 * Covers behavior not exercised by drives.property.test.ts:
 *  - routeTrace coordinate cap: exactly 50,000 points is accepted,
 *    50,001 is rejected with 400 (recent hardening, drives.routes.ts
 *    lineStringSchema .max(50_000))
 *  - empty routeTrace (0 points) is rejected
 *  - endedAt < startedAt is rejected
 *  - ownership: user B cannot read, delete, or generate a summary card for
 *    user A's drive (404 in all cases); user A still can
 *  - group membership: posting a drive with a groupId the user is not an
 *    active member of returns 403
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import drivesRoutes from './drives.routes';

// ---------------------------------------------------------------------------
// In-memory drive_history store honoring user_id scoping
// ---------------------------------------------------------------------------

interface InMemoryDrive {
  id: string;
  user_id: string;
  group_id: string | null;
  route_trace: { type: string; coordinates: [number, number][] };
  distance_m: number;
  duration_s: number;
  avg_speed_kph: number | null;
  top_speed_kph: number | null;
  member_count: number;
  started_at: Date;
  ended_at: Date;
  summary_card_url: string | null;
  created_at: Date;
}

let drives: InMemoryDrive[] = [];
let memberships: Array<{ group_id: string; user_id: string }> = [];
let idCounter = 0;

function seedDrive(userId: string, overrides: Partial<InMemoryDrive> = {}): InMemoryDrive {
  const d: InMemoryDrive = {
    id: `drive-${++idCounter}`,
    user_id: userId,
    group_id: null,
    route_trace: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    distance_m: 1000,
    duration_s: 60,
    avg_speed_kph: 60,
    top_speed_kph: 80,
    member_count: 1,
    started_at: new Date('2026-01-01T00:00:00Z'),
    ended_at: new Date('2026-01-01T01:00:00Z'),
    summary_card_url: null,
    created_at: new Date('2026-01-01T01:00:00Z'),
    ...overrides,
  };
  drives.push(d);
  return d;
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.trim().toUpperCase();

      if (sql.includes('FROM convoy_members')) {
        const [groupId, userId] = params as [string, string];
        const rows = memberships
          .filter((m) => m.group_id === groupId && m.user_id === userId)
          .map((m) => ({ id: `member-${m.user_id}` }));
        return { rows, rowCount: rows.length };
      }

      if (s.startsWith('INSERT INTO DRIVE_HISTORY')) {
        const [userId, groupId, routeTrace, distanceM, durationS,
          avgSpeed, topSpeed, memberCount, startedAt, endedAt] = params as [
          string, string | null, string, number, number,
          number | null, number | null, number, string, string,
        ];
        const d = seedDrive(userId, {
          group_id: groupId,
          route_trace: JSON.parse(routeTrace),
          distance_m: distanceM,
          duration_s: durationS,
          avg_speed_kph: avgSpeed,
          top_speed_kph: topSpeed,
          member_count: memberCount,
          started_at: new Date(startedAt),
          ended_at: new Date(endedAt),
          created_at: new Date(),
        });
        return { rows: [{ id: d.id, created_at: d.created_at }], rowCount: 1 };
      }

      if (s.startsWith('DELETE FROM DRIVE_HISTORY')) {
        const [id, userId] = params as [string, string];
        const before = drives.length;
        const target = drives.find((d) => d.id === id && d.user_id === userId);
        drives = drives.filter((d) => !(d.id === id && d.user_id === userId));
        return {
          rows: target ? [{ id: target.id }] : [],
          rowCount: before - drives.length,
        };
      }

      if (s.startsWith('UPDATE DRIVE_HISTORY SET SUMMARY_CARD_URL')) {
        const [url, id] = params as [string, string];
        const d = drives.find((dr) => dr.id === id);
        if (d) d.summary_card_url = url;
        return { rows: [], rowCount: d ? 1 : 0 };
      }

      if (sql.includes('COUNT(*)') && sql.includes('FROM drive_history')) {
        const [userId] = params as [string];
        const total = drives.filter((d) => d.user_id === userId).length;
        return { rows: [{ total: String(total) }], rowCount: 1 };
      }

      // SELECT ... FROM drive_history WHERE id = $1 AND user_id = $2 (get one / summary-card)
      if (sql.includes('FROM drive_history') && sql.includes('id = $1')) {
        const [id, userId] = params as [string, string];
        const rows = drives.filter((d) => d.id === id && d.user_id === userId);
        return { rows, rowCount: rows.length };
      }

      // SELECT list: WHERE user_id = $1 ORDER BY ended_at DESC
      if (sql.includes('FROM drive_history') && sql.includes('user_id = $1')) {
        const [userId, limit, offset] = params as [string, number, number];
        const rows = drives
          .filter((d) => d.user_id === userId)
          .sort((a, b) => b.ended_at.getTime() - a.ended_at.getTime())
          .slice(offset, offset + limit);
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function buildTestApp(): FastifyInstance {
  // Deliberately no app-level bodyLimit override: POST /drives declares its own
  // route-level bodyLimit (DRIVE_BODY_LIMIT_BYTES), and these tests exercise
  // that real route config against Fastify's default 1 MB limit elsewhere.
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(drivesRoutes, { prefix: '/api/v1' });
  return app;
}

const USER_A = 'user-a';
const USER_B = 'user-b';

function makeTrace(points: number): { type: 'LineString'; coordinates: [number, number][] } {
  // Realistic GPS precision (~24 bytes/point serialized) so large traces have
  // realistic body sizes: 50k points is ~1.2 MB of JSON, past Fastify's
  // default 1 MB bodyLimit and within the 8 MB route-level limit.
  return {
    type: 'LineString',
    coordinates: Array.from({ length: points }, (_, i) => [
      -122.419415 + (i % 1000) * 1e-6,
      37.774929 + (i % 1000) * 1e-6,
    ] as [number, number]),
  };
}

function validBody(points = 2) {
  return {
    routeTrace: makeTrace(points),
    distanceM: 1000,
    durationS: 60,
    memberCount: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T01:00:00.000Z',
  };
}

let app: FastifyInstance;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
  tokenA = app.jwt.sign({ sub: USER_A });
  tokenB = app.jwt.sign({ sub: USER_B });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  drives = [];
  memberships = [];
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// routeTrace coordinate cap (50k points)
// ---------------------------------------------------------------------------

describe('POST /drives routeTrace point cap', () => {
  it('accepts a trace with exactly 50,000 points, even past the default 1 MB bodyLimit', async () => {
    const payload = validBody(50_000);
    // Regression guard: a realistic 50k-point body must exceed Fastify's
    // default 1 MB bodyLimit, so a 201 proves the route-level bodyLimit on
    // POST /drives (not the zod cap alone) is what admits long drives.
    expect(JSON.stringify(payload).length).toBeGreaterThan(1024 * 1024);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { routeTrace: { coordinates: unknown[] } };
    expect(body.routeTrace.coordinates).toHaveLength(50_000);
  });

  it('rejects a body larger than the 8 MB route bodyLimit with 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: { ...validBody(), padding: 'x'.repeat(9 * 1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(drives).toHaveLength(0); // nothing persisted
  });

  it('rejects a trace with 50,001 points with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: validBody(50_001),
    });
    expect(res.statusCode).toBe(400);
    expect(drives).toHaveLength(0); // nothing persisted
  });

  it('rejects an empty trace (0 points) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: validBody(0),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects endedAt earlier than startedAt with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: {
        ...validBody(),
        startedAt: '2026-01-01T02:00:00.000Z',
        endedAt: '2026-01-01T01:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/endedAt must be >= startedAt/);
  });
});

// ---------------------------------------------------------------------------
// Ownership: user B must not see or mutate user A's drives
// ---------------------------------------------------------------------------

describe('drive ownership isolation', () => {
  it("GET /drives/:id returns 404 for another user's drive", async () => {
    const drive = seedDrive(USER_A);

    const asOwner = await app.inject({
      method: 'GET',
      url: `/api/v1/drives/${drive.id}`,
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(asOwner.statusCode).toBe(200);

    const asStranger = await app.inject({
      method: 'GET',
      url: `/api/v1/drives/${drive.id}`,
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(asStranger.statusCode).toBe(404);
  });

  it("DELETE /drives/:id returns 404 for another user's drive and does not delete it", async () => {
    const drive = seedDrive(USER_A);

    const asStranger = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drives/${drive.id}`,
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(asStranger.statusCode).toBe(404);
    expect(drives.find((d) => d.id === drive.id)).toBeDefined();

    const asOwner = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drives/${drive.id}`,
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(asOwner.statusCode).toBe(200);
    expect(drives.find((d) => d.id === drive.id)).toBeUndefined();
  });

  it("POST /drives/:id/summary-card returns 404 for another user's drive", async () => {
    const drive = seedDrive(USER_A);

    const asStranger = await app.inject({
      method: 'POST',
      url: `/api/v1/drives/${drive.id}/summary-card`,
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(asStranger.statusCode).toBe(404);
    expect(drives.find((d) => d.id === drive.id)!.summary_card_url).toBeNull();
  });

  it("GET /drives list never contains another user's drives", async () => {
    seedDrive(USER_A);
    seedDrive(USER_A);
    seedDrive(USER_B);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { drives: Array<{ userId: string }>; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
    expect(body.drives.every((d) => d.userId === USER_B)).toBe(true);
  });

  it('all drive routes require authentication', async () => {
    const drive = seedDrive(USER_A);
    const cases = [
      { method: 'GET' as const, url: '/api/v1/drives' },
      { method: 'GET' as const, url: '/api/v1/drives/stats' },
      { method: 'GET' as const, url: `/api/v1/drives/${drive.id}` },
      { method: 'POST' as const, url: '/api/v1/drives', payload: validBody() },
      { method: 'POST' as const, url: `/api/v1/drives/${drive.id}/summary-card` },
      { method: 'DELETE' as const, url: `/api/v1/drives/${drive.id}` },
    ];
    for (const c of cases) {
      const res = await app.inject(c);
      expect(res.statusCode).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Group membership check on POST /drives
// ---------------------------------------------------------------------------

describe('POST /drives group membership', () => {
  const GROUP_ID = '123e4567-e89b-12d3-a456-426614174000';

  it('returns 403 when posting a drive for a group the user is not a member of', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: { ...validBody(), groupId: GROUP_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(drives).toHaveLength(0);
  });

  it('accepts the drive when the user is an active member of the group', async () => {
    memberships.push({ group_id: GROUP_ID, user_id: USER_A });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/drives',
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: { ...validBody(), groupId: GROUP_ID },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).groupId).toBe(GROUP_ID);
  });
});
