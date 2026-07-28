/**
 * Hardening/regression tests for GET /friends/search.
 *
 * Covers the recently committed query-length cap not exercised by
 * friends.property.test.ts:
 *  - queries shorter than 2 chars (after trim) are rejected with 400
 *  - queries longer than 100 chars (after trim) are rejected with 400
 *    before any DB query runs
 *  - exactly 100 chars is accepted
 *  - result rows are serialized to camelCase with friendshipStatus defaulting
 *    to null
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import friendsRoutes from './friends.routes';

// ---------------------------------------------------------------------------
// Mock db: records every query; returns canned user rows for the search SELECT
// ---------------------------------------------------------------------------

let queryLog: string[] = [];
let searchRows: Array<{
  id: string;
  display_name: string;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: string;
  friendship_status: string | null;
}> = [];

function buildMockPool(): Pool {
  return {
    query: async (sql: string, _params?: unknown[]) => {
      queryLog.push(sql);
      if (sql.includes('ILIKE')) {
        return { rows: searchRows, rowCount: searchRows.length };
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
  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(friendsRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
  token = app.jwt.sign({ sub: 'user-searcher' });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  queryLog = [];
  searchRows = [];
});

async function search(q?: string) {
  const qs = q === undefined ? '' : `?q=${encodeURIComponent(q)}`;
  return app.inject({
    method: 'GET',
    url: `/api/v1/friends/search${qs}`,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('GET /friends/search query length bounds', () => {
  it('rejects a missing query with 400', async () => {
    const res = await search();
    expect(res.statusCode).toBe(400);
    expect(queryLog).toHaveLength(0);
  });

  it('rejects a 1-character query with 400', async () => {
    const res = await search('a');
    expect(res.statusCode).toBe(400);
    expect(queryLog).toHaveLength(0);
  });

  it('rejects a query that trims below 2 characters with 400', async () => {
    const res = await search('  a  ');
    expect(res.statusCode).toBe(400);
    expect(queryLog).toHaveLength(0);
  });

  it('accepts a 2-character query (lower boundary)', async () => {
    const res = await search('ab');
    expect(res.statusCode).toBe(200);
    expect(queryLog).toHaveLength(1);
  });

  it('accepts a query of exactly 100 characters (upper boundary)', async () => {
    const res = await search('a'.repeat(100));
    expect(res.statusCode).toBe(200);
    expect(queryLog).toHaveLength(1);
  });

  it('rejects a 101-character query with 400 before any DB query runs', async () => {
    const res = await search('a'.repeat(101));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/too long/i);
    expect(queryLog).toHaveLength(0);
  });

  it('length cap applies to the trimmed query (100 chars padded with spaces is OK)', async () => {
    const res = await search(`  ${'a'.repeat(100)}  `);
    expect(res.statusCode).toBe(200);
    expect(queryLog).toHaveLength(1);
  });

  it('property: any over-long query is rejected and the DB is never queried', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 101, max: 500 }),
        async (len) => {
          queryLog = [];
          const res = await search('x'.repeat(len));
          expect(res.statusCode).toBe(400);
          expect(queryLog).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('property: any trimmed query in [2, 100] chars is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 100 }),
        async (len) => {
          queryLog = [];
          const res = await search('n'.repeat(len));
          expect(res.statusCode).toBe(200);
          expect(queryLog).toHaveLength(1);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('GET /friends/search serialization', () => {
  it('maps snake_case rows to camelCase and defaults friendshipStatus to null', async () => {
    searchRows = [
      {
        id: 'u-2',
        display_name: 'Night Rider',
        avatar_url: 'https://cdn.example/a.png',
        ptt_callsign: 'NIGHTRIDER',
        privacy: 'open',
        friendship_status: null,
      },
      {
        id: 'u-3',
        display_name: 'Drift Queen',
        avatar_url: null,
        ptt_callsign: null,
        privacy: 'invite_only',
        friendship_status: 'pending',
      },
    ];

    const res = await search('ri');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: Array<Record<string, unknown>> };
    expect(body.users).toEqual([
      {
        id: 'u-2',
        displayName: 'Night Rider',
        avatarUrl: 'https://cdn.example/a.png',
        pttCallsign: 'NIGHTRIDER',
        friendshipStatus: null,
      },
      {
        id: 'u-3',
        displayName: 'Drift Queen',
        avatarUrl: null,
        pttCallsign: null,
        friendshipStatus: 'pending',
      },
    ]);
    // privacy is intentionally NOT exposed in search results
    expect(body.users[0]).not.toHaveProperty('privacy');
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/search?q=ab' });
    expect(res.statusCode).toBe(401);
  });

  it('returns each user at most once even if the row set contains a duplicate', async () => {
    // A pair can have friendship rows in both directions, which previously made
    // the join emit the same user twice. The route must collapse those to one.
    searchRows = [
      { id: 'u-dup', display_name: 'Two Ways', avatar_url: null, ptt_callsign: null, privacy: 'open', friendship_status: 'pending' },
      { id: 'u-dup', display_name: 'Two Ways', avatar_url: null, ptt_callsign: null, privacy: 'open', friendship_status: 'accepted' },
      { id: 'u-other', display_name: 'Two Wheels', avatar_url: null, ptt_callsign: null, privacy: 'open', friendship_status: null },
    ];

    const res = await search('two');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: Array<{ id: string; friendshipStatus: string | null }> };
    expect(body.users.map((u) => u.id)).toEqual(['u-dup', 'u-other']);
    expect(body.users.filter((u) => u.id === 'u-dup')).toHaveLength(1);
  });
});
