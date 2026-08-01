/**
 * Route tests for POST /ptt/token.
 *
 * The headline case is mute: Req 10.10/10.11 stop a muted Member from
 * TRANSMITTING, so the route must still hand them a (subscribe-only) token —
 * refusing it cut them out of the convoy's audio entirely and left the client
 * retrying a 403 for the whole drive.
 *
 * Also covers the membership and sub-channel gates, which are what actually
 * keep a non-member (or an unassigned member) out of a channel's audio, since
 * Agora traffic never passes through this backend.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pttRoutes from './ptt.routes';

const USER = 'listener-user';
const GROUP = '22222222-2222-2222-2222-222222222222';
const CHANNEL = '33333333-3333-3333-3333-333333333333';

let member: { is_muted: boolean } | null;
let channel: { id: string; is_all: boolean } | null;
let assignedToChannel: boolean;

function reset() {
  member = { is_muted: false };
  channel = { id: CHANNEL, is_all: true };
  assignedToChannel = true;
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM convoy_members')) {
        return { rows: member ? [member] : [], rowCount: member ? 1 : 0 };
      }
      if (sql.includes('FROM ptt_channels WHERE id = $1 AND group_id = $2')) {
        return { rows: channel ? [channel] : [], rowCount: channel ? 1 : 0 };
      }
      if (sql.includes('FROM ptt_channel_members')) {
        return { rows: assignedToChannel ? [{ ok: 1 }] : [], rowCount: assignedToChannel ? 1 : 0 };
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

function mint() {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ptt/token',
    headers: { Authorization: `Bearer ${token}` },
    payload: { groupId: GROUP, channelId: CHANNEL },
  });
}

describe('POST /ptt/token', () => {
  it('mints a transmit-capable token for an unmuted member', async () => {
    const res = await mint();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.canTransmit).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.channelName).toBeTruthy();
  });

  it('still mints a token for a MUTED member so they can hear the convoy', async () => {
    member = { is_muted: true };
    const res = await mint();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The token exists (they stay in the audio channel) but is flagged
    // subscribe-only so the client shows the muted PTT button immediately.
    expect(body.token).toBeTruthy();
    expect(body.canTransmit).toBe(false);
  });

  it('issues different Agora roles for muted and unmuted members', async () => {
    const unmuted = JSON.parse((await mint()).body).token;
    member = { is_muted: true };
    const muted = JSON.parse((await mint()).body).token;

    expect(muted).not.toEqual(unmuted);
  });

  it('403s a user who is not an active member of the group', async () => {
    member = null;
    const res = await mint();
    expect(res.statusCode).toBe(403);
  });

  it('404s when the channel does not belong to the group', async () => {
    channel = null;
    const res = await mint();
    expect(res.statusCode).toBe(404);
  });

  it('403s a member not assigned to a sub-channel (Req 26.4, 26.6)', async () => {
    channel = { id: CHANNEL, is_all: false };
    assignedToChannel = false;
    const res = await mint();
    expect(res.statusCode).toBe(403);
  });

  it('lets any active member into the "All" channel without an assignment (Req 26.5)', async () => {
    assignedToChannel = false; // is_all defaults to true — the gate is skipped
    const res = await mint();
    expect(res.statusCode).toBe(200);
  });

  it('400s on non-UUID ids and 401s without a token', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/ptt/token',
      headers: { Authorization: `Bearer ${token}` },
      payload: { groupId: 'nope', channelId: CHANNEL },
    });
    expect(bad.statusCode).toBe(400);

    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/ptt/token',
      payload: { groupId: GROUP, channelId: CHANNEL },
    });
    expect(anon.statusCode).toBe(401);
  });
});
