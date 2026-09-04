/**
 * Block enforcement for GET /users/search (Req 17.11).
 *
 * /users/search is the search the shipped app actually uses — FriendsScreen's
 * "Find People" field and SearchScreen both call it; GET /friends/search,
 * which did carry a block filter, is called from nowhere in apps/mobile. The
 * name/callsign branch only excluded 'blocked' rows from the friendship-status
 * LEFT JOIN, which changes the reported status but does not filter the user
 * out — so blocking someone left them sitting in your search results with an
 * "Add Friend" button that then died on the 403 from POST /friends/requests,
 * and left you visible to the person who blocked you. The phone branch had no
 * block check at all.
 *
 * Both branches are asserted here: the list query must carry the pair-wise
 * block exclusion (so it also keeps the COUNT(*) OVER() total honest and
 * pagination consistent), and the phone lookup must answer "no such user".
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import usersRoutes from './users.routes';

const ME = '00000000-0000-0000-0000-0000000000a1';
const THEM = '00000000-0000-0000-0000-0000000000b1';

interface State {
  /** Every statement issued, normalised to one line. */
  queries: string[];
  /** Whether a block exists in either direction between the two users. */
  blocked: boolean;
  /** Row the phone lookup should find. */
  phoneUser: { id: string; display_name: string; avatar_url: string | null; ptt_callsign: string | null; privacy: string } | null;
}
let state: State;

function reset(): void {
  state = {
    queries: [],
    blocked: false,
    phoneUser: { id: THEM, display_name: 'Blocked Rider', avatar_url: null, ptt_callsign: 'BR', privacy: 'open' },
  };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function buildMockPool(): Pool {
  const run = async (sql: string) => {
    const s = norm(sql);
    state.queries.push(s);
    const up = s.toUpperCase();

    // isBlocked() probe — `SELECT 1 FROM friendships WHERE status = 'blocked'`
    if (up.startsWith('SELECT 1 FROM FRIENDSHIPS') && up.includes("STATUS = 'BLOCKED'")) {
      return state.blocked ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Phone lookup
    if (up.includes('PHONE_NUMBER = $1')) {
      return state.phoneUser ? { rows: [state.phoneUser], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  app.register(usersRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

const search = (query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/users/search?${query}`,
    headers: { Authorization: `Bearer ${tokenFor(ME)}` },
  });

describe('GET /users/search?q= — block enforcement', () => {
  it('excludes blocked pairs in the query itself, not just from the status column', async () => {
    const res = await search('q=rider');
    expect(res.statusCode).toBe(200);

    const listQuery = state.queries.find((q) => q.toUpperCase().includes('DISPLAY_NAME ILIKE'));
    expect(listQuery).toBeDefined();
    const flat = listQuery!.replace(/\s+/g, ' ').toUpperCase();

    // A pair-wise NOT EXISTS over blocked friendships, in BOTH directions —
    // the LEFT JOIN's `f.status != 'blocked'` alone never removed the row.
    expect(flat).toContain('NOT EXISTS');
    expect(flat).toContain('B.REQUESTER_ID = $1 AND B.ADDRESSEE_ID = U.ID');
    expect(flat).toContain('B.REQUESTER_ID = U.ID AND B.ADDRESSEE_ID = $1');
    // It must be a WHERE-clause filter so COUNT(*) OVER() and paging agree.
    expect(flat.indexOf('NOT EXISTS')).toBeGreaterThan(flat.indexOf('WHERE U.ID != $1'));
  });
});

describe('GET /users/search?phone= — block enforcement', () => {
  it('hides a user who is blocked in either direction', async () => {
    state.blocked = true;
    const res = await search('phone=%2B15551234567');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ user: null });
    // Not a word of the hidden profile may appear in the response.
    expect(res.body).not.toContain('Blocked Rider');
  });

  it('still returns an unblocked user found by phone', async () => {
    state.blocked = false;
    const res = await search('phone=%2B15551234567');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ user: { id: THEM, displayName: 'Blocked Rider' } });
  });

  it('answers identically for a blocked user and a nonexistent number', async () => {
    // The lookup must not become a block oracle.
    state.blocked = true;
    const blockedBody = (await search('phone=%2B15551234567')).body;
    state.blocked = false;
    state.phoneUser = null;
    const missingBody = (await search('phone=%2B15559999999')).body;
    expect(blockedBody).toBe(missingBody);
  });
});
