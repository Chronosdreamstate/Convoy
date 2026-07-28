/**
 * Route tests for POST /groups/:id/channels/:channelId/members — the Admin
 * assigning another Member to a PTT sub-channel (Req 26.3).
 *
 * Covers: admin-only authorization, group/channel/member existence, the
 * exactly-one-channel move (DELETE then INSERT in a transaction), and the
 * ptt:channel_assigned socket emit to the target's personal room.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pttRoutes from './ptt.routes';

const ADMIN = 'admin-user';
const TARGET = '11111111-1111-1111-1111-111111111111';
const GROUP = 'group-1';
const CHANNEL = 'channel-1';

// Mutable fixtures the mock pool reads.
let group: { admin_id: string; status: string } | null;
let channelExists: boolean;
let memberActive: boolean;
let txnQueries: string[];
let ioEmits: Array<{ room: string; event: string; data: unknown }>;

function reset() {
  group = { admin_id: ADMIN, status: 'active' };
  channelExists = true;
  memberActive = true;
  txnQueries = [];
  ioEmits = [];
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM convoy_groups')) {
        return { rows: group ? [group] : [], rowCount: group ? 1 : 0 };
      }
      if (sql.includes('FROM ptt_channels WHERE id = $1 AND group_id = $2')) {
        return { rows: channelExists ? [{ ok: 1 }] : [], rowCount: channelExists ? 1 : 0 };
      }
      if (sql.includes('FROM convoy_members')) {
        return { rows: memberActive ? [{ ok: 1 }] : [], rowCount: memberActive ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string) => {
        txnQueries.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(fp(async (i) => {
    const mockIo = { to: (room: string) => ({ emit: (event: string, data: unknown) => { ioEmits.push({ room, event, data }); } }) };
    i.decorate('io', mockIo as never);
  }, { name: 'io' }));
  app.register(pttRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  adminToken = app.jwt.sign({ sub: ADMIN });
});

afterAll(async () => { await app.close(); });
beforeEach(() => reset());

function assign(body: Record<string, unknown>, token = adminToken, channel = CHANNEL) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/groups/${GROUP}/channels/${channel}/members`,
    headers: { Authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('POST /groups/:id/channels/:channelId/members (Req 26.3)', () => {
  it('admin assigns a member: moves them and notifies their device', async () => {
    const res = await assign({ userId: TARGET });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ channelId: CHANNEL, userId: TARGET });

    // exactly-one-channel move: delete from all group channels, then insert
    expect(txnQueries.some((q) => q.startsWith('BEGIN'))).toBe(true);
    expect(txnQueries.some((q) => q.includes('DELETE FROM ptt_channel_members'))).toBe(true);
    expect(txnQueries.some((q) => q.includes('INSERT INTO ptt_channel_members'))).toBe(true);
    expect(txnQueries.some((q) => q.startsWith('COMMIT'))).toBe(true);

    // target is told to switch, on their personal room only
    expect(ioEmits).toEqual([
      { room: `user:${TARGET}`, event: 'ptt:channel_assigned', data: { groupId: GROUP, channelId: CHANNEL } },
    ]);
  });

  it('rejects a non-admin with 403 and does not move anyone', async () => {
    const res = await assign({ userId: TARGET }, app.jwt.sign({ sub: 'not-admin' }));
    expect(res.statusCode).toBe(403);
    expect(txnQueries).toHaveLength(0);
    expect(ioEmits).toHaveLength(0);
  });

  it('404 when the group does not exist', async () => {
    group = null;
    const res = await assign({ userId: TARGET });
    expect(res.statusCode).toBe(404);
  });

  it('410 when the group has already ended', async () => {
    group = { admin_id: ADMIN, status: 'ended' };
    const res = await assign({ userId: TARGET });
    expect(res.statusCode).toBe(410);
  });

  it('404 when the channel is not in the group', async () => {
    channelExists = false;
    const res = await assign({ userId: TARGET });
    expect(res.statusCode).toBe(404);
    expect(ioEmits).toHaveLength(0);
  });

  it('404 when the target is not an active member', async () => {
    memberActive = false;
    const res = await assign({ userId: TARGET });
    expect(res.statusCode).toBe(404);
    expect(txnQueries).toHaveLength(0);
  });

  it('400 when userId is missing or not a UUID', async () => {
    expect((await assign({})).statusCode).toBe(400);
    expect((await assign({ userId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP}/channels/${CHANNEL}/members`,
      payload: { userId: TARGET },
    });
    expect(res.statusCode).toBe(401);
  });
});
