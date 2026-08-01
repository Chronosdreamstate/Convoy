/**
 * Route tests for GET /groups/:id/channels — specifically the memberIds the
 * Admin's assign picker needs (Req 26.3). Without it a client can render the
 * channel list but cannot say WHICH channel a given member currently sits on,
 * so the picker would either show no selection or guess at one.
 *
 * Also covers the membership gate (non-members get 403, not a roster).
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pttRoutes from './ptt.routes';

const USER = 'viewer-user';
const GROUP = 'group-1';

let isMember: boolean;
let channelRows: Array<{
  id: string; name: string; is_all: boolean; member_count: string; member_ids: string[];
}>;

function reset() {
  isMember = true;
  channelRows = [
    { id: 'ch-all', name: 'All', is_all: true, member_count: '2', member_ids: ['u1', 'u2'] },
    // An empty channel: ARRAY_AGG ... FILTER collapses to '{}', which pg
    // surfaces as an empty array rather than [null].
    { id: 'ch-lead', name: 'lead', is_all: false, member_count: '0', member_ids: [] },
  ];
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM convoy_members')) {
        return { rows: isMember ? [{ ok: 1 }] : [], rowCount: isMember ? 1 : 0 };
      }
      if (sql.includes('FROM ptt_channels c')) {
        return { rows: channelRows, rowCount: channelRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(fp(async (i) => { i.decorate('io', { to: () => ({ emit: () => {} }) } as never); }, { name: 'io' }));
  app.register(pttRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  token = app.jwt.sign({ sub: USER });
});

afterAll(async () => { await app.close(); });
beforeEach(() => reset());

function list() {
  return app.inject({
    method: 'GET',
    url: `/api/v1/groups/${GROUP}/channels`,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('GET /groups/:id/channels', () => {
  it('returns each channel with its member ids alongside the count', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      channels: [
        { id: 'ch-all', name: 'All', isAll: true, memberCount: 2, memberIds: ['u1', 'u2'] },
        { id: 'ch-lead', name: 'lead', isAll: false, memberCount: 0, memberIds: [] },
      ],
    });
  });

  it('never returns a null memberIds', async () => {
    channelRows = [
      { id: 'ch-all', name: 'All', is_all: true, member_count: '0', member_ids: null as unknown as string[] },
    ];
    const res = await list();
    expect(JSON.parse(res.body).channels[0].memberIds).toEqual([]);
  });

  it('403s a non-member instead of exposing the roster', async () => {
    isMember = false;
    const res = await list();
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${GROUP}/channels` });
    expect(res.statusCode).toBe(401);
  });
});
