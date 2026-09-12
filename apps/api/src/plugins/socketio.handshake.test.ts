/**
 * Handshake authorization for the WebSocket.
 *
 * This is the ONLY authorization the socket performs against the group a client
 * claims in `auth.groupId`, so there is no second line of defence behind it.
 *
 * The hole it closes: DM threads are convoy_groups rows with real
 * convoy_members entries, so the original membership-only check accepted a DM
 * id as a valid "active convoy". socket.handler.ts then fanned the user's live
 * GPS into `group:<dmId>` — a room both participants join on connect — turning
 * a text conversation into a continuous position feed for the other person,
 * with no convoy involved and without the share_location_with_friends opt-in.
 */

import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { env } from '../config/env';
import {
  TOKEN_REFRESH_LEAD_MS,
  attachConnectionHandlers,
  authorizeHandshake,
  enforceTokenExpiry,
} from './socketio';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVOY_ID = '22222222-2222-4222-8222-222222222222';
const DM_ID = '33333333-3333-4333-8333-333333333333';

function signToken(sub: string = USER_ID): string {
  return jwt.sign({ sub }, env.JWT_SECRET, { expiresIn: '15m' });
}

/**
 * Stands in for the real membership query. `rows` is non-empty only when the
 * group is one the real SQL would match — an active membership in a non-DM
 * group — which is exactly the behaviour under test.
 */
function buildDb(opts: { memberOf?: string[]; dmGroups?: string[] } = {}): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const memberOf = new Set(opts.memberOf ?? []);
  const dmGroups = new Set(opts.dmGroups ?? []);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const [groupId, userId] = params as [string, string];
      const active = userId === USER_ID && memberOf.has(groupId);
      const isDm = dmGroups.has(groupId);
      // The `g.type <> 'dm'` clause is what the real query adds; mirror it.
      const matches = active && !isDm && /g\.type <> 'dm'/.test(sql);
      return { rows: matches ? [{ id: 'member-row' }] : [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('authorizeHandshake', () => {
  it('rejects a missing or malformed token', async () => {
    const db = buildDb();
    expect(await authorizeHandshake(db.pool, undefined, '')).toBeNull();
    expect(await authorizeHandshake(db.pool, 'not-a-jwt', '')).toBeNull();
    // A token signed with the wrong secret must not be trusted either.
    const forged = jwt.sign({ sub: USER_ID }, 'some-other-secret-that-is-long-enough!!');
    expect(await authorizeHandshake(db.pool, forged, '')).toBeNull();
  });

  it('admits a valid token with no claimed group', async () => {
    // IdleMapScreen connects exactly like this — no groupId at all — so that it
    // still receives a friend's standalone SOS in its personal room.
    const db = buildDb();
    expect(await authorizeHandshake(db.pool, signToken(), undefined)).toEqual({
      userId: USER_ID,
      groupId: '',
      expMs: expect.any(Number),
    });
    expect(db.calls).toHaveLength(0); // nothing to check
  });

  it('admits a convoy the user is an active member of', async () => {
    const db = buildDb({ memberOf: [CONVOY_ID] });
    expect(await authorizeHandshake(db.pool, signToken(), CONVOY_ID)).toEqual({
      userId: USER_ID,
      groupId: CONVOY_ID,
      expMs: expect.any(Number),
    });
  });

  it('rejects a group the user is not a member of', async () => {
    const db = buildDb({ memberOf: [CONVOY_ID] });
    expect(await authorizeHandshake(db.pool, signToken(), 'a-group-i-am-not-in')).toBeNull();
  });

  it('rejects a DM thread the user IS a member of', async () => {
    // The heart of it: membership alone is TRUE here — both participants are
    // real convoy_members of the DM's convoy_groups row. Accepting it is what
    // turned the DM room into a live GPS feed for the other participant.
    const db = buildDb({ memberOf: [CONVOY_ID, DM_ID], dmGroups: [DM_ID] });

    expect(await authorizeHandshake(db.pool, signToken(), DM_ID)).toBeNull();

    // ...while the user's real convoy is unaffected.
    expect(await authorizeHandshake(db.pool, signToken(), CONVOY_ID)).toEqual({
      userId: USER_ID,
      groupId: CONVOY_ID,
      expMs: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Expiry enforcement
//
// The handshake verifies the JWT once and nothing afterwards re-checks it, so
// before this a socket opened with a 15-minute access token kept emitting
// location, PTT and chat for as long as it stayed open — days — and a
// sign-out, password change or account deletion never reached it.
// ---------------------------------------------------------------------------

interface FakeSocket {
  data: { userId?: string; tokenExpMs?: number | null };
  emitted: Array<{ event: string; args: unknown[] }>;
  listeners: Record<string, (...args: never[]) => void>;
  disconnected: boolean;
  emit: (event: string, ...args: unknown[]) => unknown;
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  disconnect: (close?: boolean) => unknown;
}

function buildSocket(tokenExpMs: number | null | undefined, userId = USER_ID): FakeSocket {
  const socket: FakeSocket = {
    data: { userId, tokenExpMs },
    emitted: [],
    listeners: {},
    disconnected: false,
    emit: (event, ...args) => socket.emitted.push({ event, args }),
    on: (event, listener) => (socket.listeners[event] = listener),
    disconnect: () => (socket.disconnected = true),
  };
  return socket;
}

const silentLog = { log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } } as never;

describe('enforceTokenExpiry', () => {
  const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
  const FIFTEEN_MIN = 15 * 60_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('closes a socket when the token that opened it expires', () => {
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    enforceTokenExpiry(silentLog, socket, () => ({}), () => NOW);

    // Just before expiry the socket is still live — only warned.
    jest.advanceTimersByTime(FIFTEEN_MIN - 1);
    expect(socket.disconnected).toBe(false);
    expect(socket.emitted.map((e) => e.event)).toContain('auth:expiring');

    jest.advanceTimersByTime(1);
    expect(socket.emitted.map((e) => e.event)).toContain('auth:expired');
    expect(socket.disconnected).toBe(true);
  });

  it('warns a minute ahead so a healthy client can refresh without a drop', () => {
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    enforceTokenExpiry(silentLog, socket, () => ({}), () => NOW);

    jest.advanceTimersByTime(FIFTEEN_MIN - TOKEN_REFRESH_LEAD_MS - 1);
    expect(socket.emitted).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(socket.emitted[0].event).toBe('auth:expiring');
    expect(socket.disconnected).toBe(false);
  });

  it('re-arms in place when the client presents a fresh token', () => {
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    const newExpSec = (NOW + 2 * FIFTEEN_MIN) / 1000;
    enforceTokenExpiry(
      silentLog,
      socket,
      () => ({ sub: USER_ID, exp: newExpSec }),
      () => NOW,
    );

    socket.listeners['auth:refresh']({ token: 'a-fresh-token' } as never);

    // The original deadline passes with the socket untouched — this is what
    // keeps a driver connected across the token's 15-minute life.
    jest.advanceTimersByTime(FIFTEEN_MIN + 1);
    expect(socket.disconnected).toBe(false);
    expect(socket.data.tokenExpMs).toBe(newExpSec * 1000);

    jest.advanceTimersByTime(FIFTEEN_MIN);
    expect(socket.disconnected).toBe(true);
  });

  it('refuses a token belonging to somebody else', () => {
    // Presenting another user's valid token must never move an established
    // socket onto their identity, or extend this one's life.
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    enforceTokenExpiry(
      silentLog,
      socket,
      () => ({ sub: 'a-different-user', exp: (NOW + 10 * FIFTEEN_MIN) / 1000 }),
      () => NOW,
    );

    socket.listeners['auth:refresh']({ token: 'someone-elses-token' } as never);

    expect(socket.data.userId).toBe(USER_ID);
    jest.advanceTimersByTime(FIFTEEN_MIN);
    expect(socket.disconnected).toBe(true);
  });

  it('ignores an unverifiable token and still closes on schedule', () => {
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    enforceTokenExpiry(
      silentLog,
      socket,
      () => { throw new Error('invalid signature'); },
      () => NOW,
    );

    socket.listeners['auth:refresh']({ token: 'forged' } as never);

    jest.advanceTimersByTime(FIFTEEN_MIN);
    expect(socket.disconnected).toBe(true);
  });

  it('stops its timers when the socket disconnects', () => {
    const socket = buildSocket(NOW + FIFTEEN_MIN);
    enforceTokenExpiry(silentLog, socket, () => ({}), () => NOW);

    socket.listeners['disconnect']();
    jest.advanceTimersByTime(FIFTEEN_MIN * 2);

    // Nothing emitted at all: a closed socket must not be warned or re-closed.
    expect(socket.emitted).toHaveLength(0);
  });

  it('warns immediately for a token already inside the lead window', () => {
    // Reconnecting with a token that has 10s left must not schedule a timer
    // into the past.
    const socket = buildSocket(NOW + 10_000);
    enforceTokenExpiry(silentLog, socket, () => ({}), () => NOW);

    jest.advanceTimersByTime(0);
    expect(socket.emitted[0].event).toBe('auth:expiring');
    jest.advanceTimersByTime(10_000);
    expect(socket.disconnected).toBe(true);
  });
});

describe('attachConnectionHandlers', () => {
  const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('arms expiry on every new connection', () => {
    // Registration, not just the function: expiry enforcement is a security
    // control with no fallback, so "attached at all" has to be under test.
    const connectionHandlers: Array<(socket: unknown) => void> = [];
    const io = {
      on: (event: string, handler: (socket: unknown) => void) => {
        if (event === 'connection') connectionHandlers.push(handler);
      },
    };
    const fastify = {
      log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
      db: { query: jest.fn() },
      redis: {},
    } as never;

    attachConnectionHandlers(io as never, fastify);

    const socket = buildSocket(NOW + 15 * 60_000);
    jest.setSystemTime(NOW);
    // Only the expiry handler is driven here; registerSocketHandlers needs a
    // far larger fixture and is covered by its own suites.
    connectionHandlers[0](socket);

    jest.advanceTimersByTime(15 * 60_000);
    expect(socket.disconnected).toBe(true);
  });
});
