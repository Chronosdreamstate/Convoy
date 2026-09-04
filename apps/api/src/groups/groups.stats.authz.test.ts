/**
 * Authorization tests for GET /groups/:id/stats.
 *
 * The route lives in its own plugin (registerGroupStatsRoute) and was the one
 * group route that authenticated the caller and then never authorized them:
 * it read `:id` straight out of the path and answered with the convoy's name,
 * roster size, drive totals, monthly activity and its top five members'
 * display names, callsigns and distances. Any signed-in user could therefore
 * enumerate any group id — invite-only clubs they were never let into, groups
 * that had already ended, and the convoy_groups rows that back private 1:1 DM
 * threads (which carry exactly two members and their names).
 *
 * The rule asserted here mirrors GET /groups/:id, the screen this one is
 * reached from: active members always; a non-member only for an open, active
 * convoy, which is the public browse → detail → stats path the mobile
 * GroupDetailScreen relies on.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { registerGroupStatsRoute } from './groups.routes';

const MEMBER = '00000000-0000-0000-0000-00000000aaa1';
const OUTSIDER = '00000000-0000-0000-0000-00000000bbb1';
const GROUP = '00000000-0000-0000-0000-0000000000f1';

interface State {
  group: {
    name: string;
    access_type: 'open' | 'invite_only';
    status: 'active' | 'ended';
    type: 'group' | 'dm' | null;
    member_count: number;
  } | null;
  /** user ids with an active convoy_members row in GROUP. */
  activeMembers: Set<string>;
  /** Every statement the route issued, normalised to one line. */
  queries: string[];
}
let state: State;

function reset(): void {
  state = {
    group: { name: 'Canyon Run', access_type: 'invite_only', status: 'active', type: 'group', member_count: 4 },
    activeMembers: new Set([MEMBER]),
    queries: [],
  };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function buildMockPool(): Pool {
  const run = async (sql: string, params?: unknown[]) => {
    const s = norm(sql);
    state.queries.push(s);
    const up = s.toUpperCase();

    // Group meta + member count
    if (up.includes('FROM CONVOY_GROUPS G')) {
      return state.group ? { rows: [state.group], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // getActiveMember()
    if (up.startsWith('SELECT ID, GROUP_ID, USER_ID') && up.includes('FROM CONVOY_MEMBERS')) {
      const userId = (params as [string, string])[1];
      return state.activeMembers.has(userId)
        ? { rows: [{ id: 'm-1', group_id: GROUP, user_id: userId, joined_at: new Date(), left_at: null, is_muted: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // Drive aggregates
    if (up.includes('TOTAL_DRIVES') && up.includes('FROM DRIVE_HISTORY')) {
      return { rows: [{ total_drives: 3, total_km: 120.5, avg_duration_min: 45, longest_km: 60 }], rowCount: 1 };
    }
    // Top members
    if (up.includes('FROM CONVOY_MEMBERS M') && up.includes('JOIN USERS U')) {
      return { rows: [{ user_id: MEMBER, display_name: 'Ari', ptt_callsign: 'ARI', drives_count: 3, distance_km: 120.5 }], rowCount: 1 };
    }
    // Monthly drives
    if (up.includes("DATE_TRUNC('MONTH'")) {
      return { rows: [{ month: 'Jul 2026', count: 3 }], rowCount: 1 };
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
  app.register(registerGroupStatsRoute, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

const getStats = (sub: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/groups/${GROUP}/stats`,
    headers: { Authorization: `Bearer ${tokenFor(sub)}` },
  });

/** Did the handler go on to read any of the group's actual data? */
const readGroupData = () => state.queries.some((q) => q.toUpperCase().includes('FROM DRIVE_HISTORY'));

describe('GET /groups/:id/stats — authorization', () => {
  it('serves an active member of an invite-only group', async () => {
    const res = await getStats(MEMBER);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ groupName: 'Canyon Run', totalMembers: 4 });
  });

  it('refuses a non-member of an invite-only group and reads none of its data', async () => {
    const res = await getStats(OUTSIDER);
    expect(res.statusCode).toBe(403);
    expect(readGroupData()).toBe(false);
    // Nothing about the roster may leak through the error body either.
    expect(res.body).not.toContain('Canyon Run');
  });

  it('refuses a non-member of an ended group', async () => {
    state.group = { name: 'Old Run', access_type: 'open', status: 'ended', type: 'group', member_count: 2 };
    expect((await getStats(OUTSIDER)).statusCode).toBe(403);
    expect(readGroupData()).toBe(false);
  });

  it('refuses a non-participant of a DM thread', async () => {
    // DM threads are convoy_groups rows with type='dm' and exactly two
    // members — this route would otherwise hand a stranger both their names.
    state.group = { name: 'dm', access_type: 'invite_only', status: 'active', type: 'dm', member_count: 2 };
    expect((await getStats(OUTSIDER)).statusCode).toBe(403);
    expect(readGroupData()).toBe(false);
  });

  it('still serves a non-member browsing an open, active convoy', async () => {
    // GroupDetailScreen shows the stats button to non-members on the public
    // browse path — gating this on strict membership would make it a dead end.
    state.group = { name: 'Sunday Cruise', access_type: 'open', status: 'active', type: 'group', member_count: 9 };
    const res = await getStats(OUTSIDER);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ groupName: 'Sunday Cruise' });
  });

  it('404s an unknown group id', async () => {
    state.group = null;
    expect((await getStats(MEMBER)).statusCode).toBe(404);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${GROUP}/stats` });
    expect(res.statusCode).toBe(401);
  });
});
