/**
 * POST /friends/block must eject the blocked user from the shared DM's socket
 * room, not just from its membership table (Req 17.11).
 *
 * socket.handler.ts joins every DM channel a user belongs to as a `group:<id>`
 * socket room at connect time, and nothing ever leaves those rooms. Blocking
 * soft-removes the blocked user's convoy_members row, which correctly closes
 * every REST read/write path — but their already-open socket stays in the
 * room, so anything still broadcast there (a `group:reaction` from the
 * blocker, say) kept arriving on the live connection of the person who had
 * just been blocked, until they happened to reconnect.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import friendsRoutes from './friends.routes';

const ME = '00000000-0000-0000-0000-0000000000a1';
const THEM = '00000000-0000-0000-0000-0000000000b1';

interface State {
  /** group_ids the block's UPDATE ... RETURNING should report as severed. */
  severedDmGroupIds: string[];
  /** socketsLeave calls recorded as `<room> -> <left room>`. */
  left: Array<{ from: string; room: string }>;
}
let state: State;

function reset(): void {
  state = { severedDmGroupIds: ['dm-1'], left: [] };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function buildMockPool(): Pool {
  const answer = async (sql: string) => {
    const s = norm(sql).toUpperCase();
    // The DM-severing UPDATE — must RETURN the group ids so the caller can
    // empty their rooms.
    if (s.startsWith('UPDATE CONVOY_MEMBERS')) {
      return {
        rows: state.severedDmGroupIds.map((id) => ({ group_id: id })),
        rowCount: state.severedDmGroupIds.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query: answer,
    connect: async () => ({ query: answer, release: () => {} }),
  } as unknown as Pool;
}

function buildIo() {
  return {
    to: () => ({ emit: () => {} }),
    in: (from: string) => ({
      socketsLeave: (room: string) => { state.left.push({ from, room }); },
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
  app.register(friendsRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

const block = (userId: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/friends/block',
    headers: { Authorization: `Bearer ${tokenFor(ME)}` },
    payload: { userId },
  });

describe('POST /friends/block — DM socket room', () => {
  it("pulls the blocked user's sockets out of the severed DM room", async () => {
    const res = await block(THEM);
    expect(res.statusCode).toBe(200);
    expect(state.left).toEqual([{ from: `user:${THEM}`, room: 'group:dm-1' }]);
  });

  it('handles a pair that shares several DM channels', async () => {
    state.severedDmGroupIds = ['dm-1', 'dm-2'];
    await block(THEM);
    expect(state.left.map((l) => l.room)).toEqual(['group:dm-1', 'group:dm-2']);
  });

  it('leaves no rooms when the pair shared no DM', async () => {
    state.severedDmGroupIds = [];
    const res = await block(THEM);
    expect(res.statusCode).toBe(200);
    expect(state.left).toHaveLength(0);
  });

  it("never touches the blocker's own rooms", async () => {
    await block(THEM);
    expect(state.left.some((l) => l.from === `user:${ME}`)).toBe(false);
  });
});
