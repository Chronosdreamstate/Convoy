/**
 * Tests for POST /groups/:id/messages block enforcement (Task #87).
 *
 * Bug: blocking a user only ever stopped a *new* DM from being started
 * (POST /friends/requests, POST /nearby/dm). Once a DM conversation already
 * existed, blocking did nothing to stop the blocked party from continuing to
 * send messages into it — despite the app's block-confirmation dialog
 * explicitly promising "you won't be able to continue this conversation."
 *
 * Covers:
 *  - A blocked user's message into an existing type='dm' group is rejected,
 *    regardless of which direction of the pair placed the block.
 *  - A block between two members of a normal (non-DM) convoy group does NOT
 *    affect that group's chat — the DM-only scoping must not leak into
 *    multi-person convoy groups.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import chatRoutes from './chat.routes';

// ---------------------------------------------------------------------------
// Configurable in-memory backing state
// ---------------------------------------------------------------------------
interface MemberRow {
  groupId: string;
  userId: string;
  leftAt: boolean; // true => has left (left_at IS NOT NULL)
}

interface MockState {
  groupTypes: Map<string, 'group' | 'dm'>;
  members: MemberRow[];
  blockedPairs: Set<string>;
  insertedMessages: { groupId: string; userId: string; text: string | null }[];
  emits: { room: string; event: string; payload: unknown }[];
}

let state: MockState;

function resetState() {
  state = {
    groupTypes: new Map(),
    members: [],
    blockedPairs: new Set(),
    insertedMessages: [],
    emits: [],
  };
}

function setGroupType(groupId: string, type: 'group' | 'dm') {
  state.groupTypes.set(groupId, type);
}

function addMember(groupId: string, userId: string, leftAt = false) {
  state.members.push({ groupId, userId, leftAt });
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function block(a: string, b: string) {
  state.blockedPairs.add(pairKey(a, b));
}

function isPairBlocked(a: string, b: string): boolean {
  return state.blockedPairs.has(pairKey(a, b));
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // Membership check: SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
      if (
        norm.startsWith('SELECT 1 FROM CONVOY_MEMBERS') &&
        norm.includes('GROUP_ID = $1') &&
        norm.includes('USER_ID = $2') &&
        norm.includes('LEFT_AT IS NULL')
      ) {
        const [groupId, userId] = params as [string, string];
        const found = state.members.some((m) => m.groupId === groupId && m.userId === userId && !m.leftAt);
        return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
      }

      // Group type lookup: SELECT type FROM convoy_groups WHERE id = $1
      if (norm.startsWith('SELECT TYPE FROM CONVOY_GROUPS')) {
        const [groupId] = params as [string];
        const type = state.groupTypes.get(groupId);
        return { rows: type ? [{ type }] : [], rowCount: type ? 1 : 0 };
      }

      // Other DM member lookup: SELECT user_id FROM convoy_members WHERE group_id = $1 AND user_id != $2 AND left_at IS NULL LIMIT 1
      if (
        norm.startsWith('SELECT USER_ID FROM CONVOY_MEMBERS') &&
        norm.includes('USER_ID != $2')
      ) {
        const [groupId, userId] = params as [string, string];
        const other = state.members.find(
          (m) => m.groupId === groupId && m.userId !== userId && !m.leftAt,
        );
        return { rows: other ? [{ user_id: other.userId }] : [], rowCount: other ? 1 : 0 };
      }

      // isBlocked() helper: SELECT 1 FROM friendships WHERE status = 'blocked' ... LIMIT 1
      if (norm.includes("STATUS = 'BLOCKED'") && norm.includes('LIMIT 1')) {
        const [a, b] = params as [string, string];
        const found = isPairBlocked(a, b);
        return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
      }

      // Insert message
      if (norm.startsWith('INSERT INTO GROUP_MESSAGES')) {
        const [groupId, userId, text] = params as [string, string, string | null];
        state.insertedMessages.push({ groupId, userId, text });
        return {
          rows: [{
            id: `msg-${state.insertedMessages.length}`,
            group_id: groupId,
            user_id: userId,
            text,
            type: 'text',
            audio_url: null,
            created_at: new Date(),
          }],
          rowCount: 1,
        };
      }

      // Best-effort last_activity_at bump
      if (norm.startsWith('UPDATE CONVOY_GROUPS SET LAST_ACTIVITY_AT')) {
        return { rows: [], rowCount: 1 };
      }

      // Sender display name lookup
      if (norm.startsWith('SELECT DISPLAY_NAME, AVATAR_URL FROM USERS')) {
        return { rows: [{ display_name: 'Test User', avatar_url: null }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as Pool;
  return pool;
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
  app.register(fp(async (inst) => {
    inst.decorate('io', {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => { state.emits.push({ room, event, payload }); },
      }),
    } as unknown as FastifyInstance['io']);
  }, { name: 'io' }));
  app.register(chatRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// POST /groups/:id/messages — block enforcement (Task #87)
// ---------------------------------------------------------------------------
describe('POST /groups/:id/messages — DM block enforcement', () => {
  it('rejects a message into a DM group when the sender has blocked the other party', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('dm-1', 'dm');
    addMember('dm-1', 'u1');
    addMember('dm-1', 'u2');
    block('u1', 'u2');

    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/dm-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(403);
    expect(state.insertedMessages).toHaveLength(0);
    await app.close();
  });

  it('rejects a message into a DM group when the other party has blocked the sender (reverse direction)', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('dm-1', 'dm');
    addMember('dm-1', 'u1');
    addMember('dm-1', 'u2');
    block('u2', 'u1'); // u2 (the recipient) blocked u1 (the sender)

    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/dm-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(403);
    expect(state.insertedMessages).toHaveLength(0);
    await app.close();
  });

  it('does not reveal block status in the rejection message', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('dm-1', 'dm');
    addMember('dm-1', 'u1');
    addMember('dm-1', 'u2');
    block('u1', 'u2');

    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/dm-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { message: string };
    expect(body.message.toLowerCase()).not.toContain('block');
    await app.close();
  });

  it('allows a message into a DM group when there is no block between the two members', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('dm-1', 'dm');
    addMember('dm-1', 'u1');
    addMember('dm-1', 'u2');

    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/dm-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(201);
    expect(state.insertedMessages).toHaveLength(1);
    await app.close();
  });

  it('does not apply block enforcement to a normal (non-DM) convoy group', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('grp-1', 'group');
    addMember('grp-1', 'u1');
    addMember('grp-1', 'u2');
    addMember('grp-1', 'u3');
    // u1 and u2 are blocked w.r.t. each other, but that must not affect a
    // real multi-person convoy group's chat for anyone, including them.
    block('u1', 'u2');

    const token = await makeToken(app, 'u1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/grp-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello everyone' },
    });

    expect(res.statusCode).toBe(201);
    expect(state.insertedMessages).toHaveLength(1);
    await app.close();
  });

  it('returns 403 (not a member) for a sender who has already been kicked from the DM', async () => {
    const app = buildTestApp();
    resetState();
    setGroupType('dm-1', 'dm');
    addMember('dm-1', 'u1');
    addMember('dm-1', 'u2', /* leftAt */ true); // u2 was proactively removed on block

    const token = await makeToken(app, 'u2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/dm-1/messages',
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(403);
    expect(state.insertedMessages).toHaveLength(0);
    await app.close();
  });
});
