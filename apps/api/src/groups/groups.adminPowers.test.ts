/**
 * Authorization tests for the Admin-only group powers (Req 7, 10.11, 24.3).
 *
 * groups.routes.ts is the largest module in the API and was ~57% covered. The
 * part worth covering first is this one: kick, mute, mute-all, transfer-admin
 * and announcement all gate on `group.admin_id === caller`, and a slip in any
 * of them hands a regular member control of someone else's convoy.
 *
 * Each route is checked for the same four things — the admin can do it, a
 * plain member cannot, the group must exist, and the self-targeting guard
 * holds — plus the side effects that make the action real: the kicked rider is
 * told before their socket is cut, and a muted member's own device is
 * signalled (PTT audio never passes through this backend, so the DB flag alone
 * mutes nobody).
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import groupsRoutes from './groups.routes';

const ADMIN = '00000000-0000-0000-0000-00000000ad11';
const MEMBER = '00000000-0000-0000-0000-00000000b0b1';
const OTHER = '00000000-0000-0000-0000-00000000c0c1';
const GROUP = '00000000-0000-0000-0000-0000000000f1';

interface State {
  group: { admin_id: string; status: string } | null;
  /** Rows affected by the mute/kick UPDATE — 0 means "no such active member". */
  affected: number;
  targetIsActiveMember: boolean;
  emits: Array<{ room: string; event: string; data: unknown }>;
  /** Rooms disconnectRoomSockets() was asked to cut, in order. */
  disconnected: string[];
  order: string[];
}
let state: State;

function reset(): void {
  state = {
    group: { admin_id: ADMIN, status: 'active' },
    affected: 1,
    targetIsActiveMember: true,
    emits: [],
    disconnected: [],
    order: [],
  };
}

function buildMockPool(): Pool {
  const run = async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('FROM convoy_groups')) {
      return { rows: state.group ? [state.group] : [], rowCount: state.group ? 1 : 0 };
    }
    // getActiveMember() — used by transfer-admin to check the new admin is in the group
    if (s.startsWith('SELECT') && s.includes('FROM convoy_members')) {
      return state.targetIsActiveMember
        ? { rows: [{ id: 'm-1', user_id: MEMBER, is_muted: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE convoy_members')) {
      state.order.push('UPDATE_MEMBERS');
      return state.affected === 0
        ? { rows: [], rowCount: 0 }
        : { rows: Array.from({ length: state.affected }, () => ({ id: 'm-1', user_id: MEMBER })), rowCount: state.affected };
    }
    if (s.startsWith('UPDATE convoy_groups')) {
      state.order.push('UPDATE_GROUP');
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM ptt_channel_members')) {
      state.order.push('CLEAR_PTT_CHANNELS');
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  } as unknown as Pool;
}

function buildIo() {
  return {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => {
        state.emits.push({ room, event, data });
        state.order.push(`EMIT ${event}`);
      },
    }),
    // disconnectRoomSockets uses io.in(room).disconnectSockets(true) — a
    // different broadcaster method from the .to() used for emits.
    in: (room: string) => ({
      disconnectSockets: () => {
        state.disconnected.push(room);
        state.order.push('DISCONNECT');
      },
    }),
  };
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
  app.register(fp(async (i) => { i.decorate('io', buildIo() as never); }, { name: 'io' }));
  app.register(groupsRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

function call(method: 'POST' | 'PATCH' | 'DELETE', url: string, sub: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { Authorization: `Bearer ${tokenFor(sub)}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const emitted = (event: string) => state.emits.filter((e) => e.event === event);

// ---------------------------------------------------------------------------

describe('DELETE /groups/:id/members/:targetUserId — kick', () => {
  it('lets the admin kick a member', async () => {
    const res = await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN);
    expect(res.statusCode).toBe(200);
  });

  it('refuses a plain member', async () => {
    const res = await call('DELETE', `/groups/${GROUP}/members/${ADMIN}`, MEMBER);
    expect(res.statusCode).toBe(403);
    expect(state.order).not.toContain('UPDATE_MEMBERS');
  });

  it('refuses to let the admin kick themselves and orphan the group', async () => {
    const res = await call('DELETE', `/groups/${GROUP}/members/${ADMIN}`, ADMIN);
    expect(res.statusCode).toBe(400);
  });

  it('410s once the convoy has ended', async () => {
    state.group = { admin_id: ADMIN, status: 'ended' };
    expect((await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN)).statusCode).toBe(410);
  });

  it('404s a member who already left', async () => {
    state.affected = 0;
    expect((await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN)).statusCode).toBe(404);
  });

  it('tells the rider they were kicked BEFORE cutting their socket', async () => {
    // Reversed, the force-disconnect lands first and the rider never learns
    // why they dropped out of the convoy.
    await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN);

    expect(state.order.indexOf('EMIT member:kicked')).toBeGreaterThanOrEqual(0);
    expect(state.order.indexOf('EMIT member:kicked'))
      .toBeLessThan(state.order.indexOf('DISCONNECT'));
  });

  it('tells the remaining members the rider is gone', async () => {
    await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN);
    expect(emitted('member:left')[0].room).toBe(`group:${GROUP}`);
  });

  it('drops the kicked rider from the group PTT channels', async () => {
    await call('DELETE', `/groups/${GROUP}/members/${MEMBER}`, ADMIN);
    expect(state.order).toContain('CLEAR_PTT_CHANNELS');
  });
});

describe('POST /groups/:id/members/:targetUserId/mute', () => {
  it('lets the admin mute a member and signals that member\'s device', async () => {
    const res = await call('POST', `/groups/${GROUP}/members/${MEMBER}/mute`, ADMIN, { muted: true });

    expect(res.statusCode).toBe(200);
    // The device signal is what actually stops transmission — Agora audio
    // never reaches this backend, so the DB flag alone mutes nobody.
    expect(emitted('ptt:muted')[0].room).toBe(`user:${MEMBER}`);
    expect(emitted('member:mute_changed')[0].room).toBe(`group:${GROUP}`);
  });

  it('emits ptt:unmuted when unmuting', async () => {
    await call('POST', `/groups/${GROUP}/members/${MEMBER}/mute`, ADMIN, { muted: false });
    expect(emitted('ptt:unmuted')).toHaveLength(1);
    expect(emitted('ptt:muted')).toHaveLength(0);
  });

  it('refuses a plain member', async () => {
    const res = await call('POST', `/groups/${GROUP}/members/${ADMIN}/mute`, MEMBER, { muted: true });
    expect(res.statusCode).toBe(403);
    expect(state.emits).toHaveLength(0);
  });

  it('refuses to let the admin mute themselves', async () => {
    const res = await call('POST', `/groups/${GROUP}/members/${ADMIN}/mute`, ADMIN, { muted: true });
    expect(res.statusCode).toBe(400);
  });

  it('404s a member who is not in the group', async () => {
    state.affected = 0;
    expect((await call('POST', `/groups/${GROUP}/members/${MEMBER}/mute`, ADMIN, { muted: true })).statusCode).toBe(404);
  });

  it('rejects a body without the muted flag', async () => {
    expect((await call('POST', `/groups/${GROUP}/members/${MEMBER}/mute`, ADMIN, {})).statusCode).toBe(400);
  });
});

describe('POST /groups/:id/members/mute-all', () => {
  it('mutes everyone and signals each affected device individually', async () => {
    const res = await call('POST', `/groups/${GROUP}/members/mute-all`, ADMIN, { muted: true });

    expect(res.statusCode).toBe(200);
    expect(emitted('ptt:muted')[0].room).toBe(`user:${MEMBER}`);
    expect(emitted('member:mute_changed')[0].data).toMatchObject({ all: true, muted: true });
  });

  it('never mutes the admin themselves', async () => {
    // The UPDATE excludes the caller; if it did not, the admin would silence
    // themselves and could not call the convoy back.
    await call('POST', `/groups/${GROUP}/members/mute-all`, ADMIN, { muted: true });
    expect(emitted('ptt:muted').some((e) => e.room === `user:${ADMIN}`)).toBe(false);
  });

  it('refuses a plain member', async () => {
    const res = await call('POST', `/groups/${GROUP}/members/mute-all`, MEMBER, { muted: true });
    expect(res.statusCode).toBe(403);
    expect(state.order).not.toContain('UPDATE_MEMBERS');
  });

  it('404s an unknown group', async () => {
    state.group = null;
    expect((await call('POST', `/groups/${GROUP}/members/mute-all`, ADMIN, { muted: true })).statusCode).toBe(404);
  });
});

describe('PATCH /groups/:id/transfer-admin', () => {
  it('hands the convoy to another member and announces it', async () => {
    const res = await call('PATCH', `/groups/${GROUP}/transfer-admin`, ADMIN, { newAdminId: MEMBER });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).newAdminId).toBe(MEMBER);
    expect(emitted('group:admin_transferred')[0].data)
      .toMatchObject({ previousAdminId: ADMIN, newAdminId: MEMBER });
  });

  it('refuses a plain member trying to seize the convoy', async () => {
    // Targeting a third party, not themselves — self-targeting is rejected by
    // the earlier 400 guard, which would mask whether the admin check works.
    const res = await call('PATCH', `/groups/${GROUP}/transfer-admin`, MEMBER, { newAdminId: OTHER });

    expect(res.statusCode).toBe(403);
    expect(state.order).not.toContain('UPDATE_GROUP');
  });

  it('rejects transferring to yourself', async () => {
    const res = await call('PATCH', `/groups/${GROUP}/transfer-admin`, ADMIN, { newAdminId: ADMIN });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the proposed admin is not an active member', async () => {
    state.targetIsActiveMember = false;
    const res = await call('PATCH', `/groups/${GROUP}/transfer-admin`, ADMIN, { newAdminId: MEMBER });

    expect(res.statusCode).toBe(404);
    expect(state.order).not.toContain('UPDATE_GROUP');
  });

  it('410s once the convoy has ended', async () => {
    state.group = { admin_id: ADMIN, status: 'ended' };
    expect((await call('PATCH', `/groups/${GROUP}/transfer-admin`, ADMIN, { newAdminId: MEMBER })).statusCode).toBe(410);
  });

  it('rejects a newAdminId that is not a user id', async () => {
    expect((await call('PATCH', `/groups/${GROUP}/transfer-admin`, ADMIN, { newAdminId: 'nope' })).statusCode).toBe(400);
  });
});

describe('POST /groups/:id/announcement', () => {
  it('broadcasts the admin message to the group', async () => {
    const res = await call('POST', `/groups/${GROUP}/announcement`, ADMIN, { message: '  Fuel stop in 5  ' });

    expect(res.statusCode).toBe(200);
    const ann = emitted('group:announcement')[0];
    expect(ann.room).toBe(`group:${GROUP}`);
    expect(ann.data).toMatchObject({ senderId: ADMIN, message: 'Fuel stop in 5' });
  });

  it('refuses a plain member', async () => {
    const res = await call('POST', `/groups/${GROUP}/announcement`, MEMBER, { message: 'hi' });
    expect(res.statusCode).toBe(403);
    expect(state.emits).toHaveLength(0);
  });

  it('rejects a whitespace-only message', async () => {
    expect((await call('POST', `/groups/${GROUP}/announcement`, ADMIN, { message: '   ' })).statusCode).toBe(400);
  });

  it('rejects an over-long message', async () => {
    const res = await call('POST', `/groups/${GROUP}/announcement`, ADMIN, { message: 'x'.repeat(201) });
    expect(res.statusCode).toBe(400);
  });

  it('410s once the convoy has ended', async () => {
    state.group = { admin_id: ADMIN, status: 'ended' };
    expect((await call('POST', `/groups/${GROUP}/announcement`, ADMIN, { message: 'hi' })).statusCode).toBe(410);
  });
});

describe('authentication', () => {
  it.each([
    ['DELETE', `/groups/${GROUP}/members/${MEMBER}`],
    ['POST', `/groups/${GROUP}/members/${MEMBER}/mute`],
    ['POST', `/groups/${GROUP}/members/mute-all`],
    ['PATCH', `/groups/${GROUP}/transfer-admin`],
    ['POST', `/groups/${GROUP}/announcement`],
  ])('%s %s requires a token', async (method, url) => {
    const res = await app.inject({ method: method as 'POST', url: `/api/v1${url}`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
