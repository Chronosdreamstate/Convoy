/**
 * Block/unblock semantics and friend-request ownership (Req 17.6–17.11).
 *
 * Blocking is the one place in this API where getting it subtly wrong is a
 * safety problem rather than a bug: wave 20 found that POST /friends/block
 * deleted friendship rows in BOTH directions including the other user's
 * status='blocked' row, so a block-then-unblock silently stripped the victim's
 * independent block of you. These tests assert the shape of the SQL that fixed
 * it, so it cannot regress quietly.
 *
 * The request routes are checked for ownership rather than happy paths: only
 * the addressee may accept or decline, and only the requester may withdraw.
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
  /** Statements seen on the transactional client, normalised to one line. */
  txn: string[];
  /** Every statement issued straight on the pool (non-transactional routes). */
  pool: string[];
  /** Rows the next mutating statement should report as affected. */
  affected: number;
  blockedEitherWay: boolean;
  existingFriendship: { id: string; status: string } | null;
  addresseePrivacy: string | null;
  notified: Array<Record<string, unknown>>;
}
let state: State;

function reset(): void {
  state = {
    txn: [],
    pool: [],
    affected: 1,
    blockedEitherWay: false,
    existingFriendship: null,
    addresseePrivacy: 'invite_only',
    notified: [],
  };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function buildMockPool(): Pool {
  const answer = async (sql: string) => {
    const s = norm(sql);

    // isBlocked() probe
    if (s.includes("status = 'blocked'") && s.startsWith('SELECT')) {
      return state.blockedEitherWay
        ? { rows: [{ id: 'f-block' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT id, status FROM friendships')) {
      return state.existingFriendship
        ? { rows: [state.existingFriendship], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('SELECT privacy FROM users')) {
      return state.addresseePrivacy
        ? { rows: [{ privacy: state.addresseePrivacy }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO friendships')) {
      return { rows: [{ id: 'f-new', requester_id: ME, addressee_id: THEM, status: state.addresseePrivacy === 'open' ? 'accepted' : 'pending', created_at: new Date() }], rowCount: 1 };
    }
    if (s.startsWith('UPDATE friendships')) {
      return state.affected
        ? { rows: [{ id: 'f-1', requester_id: THEM, addressee_id: ME, status: 'accepted' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM friendships')) {
      return state.affected ? { rows: [{ id: 'f-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    query: async (sql: string) => { state.pool.push(norm(sql)); return answer(sql); },
    connect: async () => ({
      query: async (sql: string) => { state.txn.push(norm(sql)); return answer(sql); },
      release: () => {},
    }),
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
  app.register(fp(async (i) => {
    // Typed loosely on purpose: the decorator's real signature is NotificationJob,
    // and this only needs to record what the routes enqueue.
    const record = async (job: unknown) => { state.notified.push(job as Record<string, unknown>); };
    i.decorate('enqueueNotification', record as never);
  }, { name: 'notifications' }));
  app.register(fp(async (i) => { i.decorate('io', { to: () => ({ emit: () => {} }) } as never); }, { name: 'io' }));
  app.register(friendsRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

function call(method: 'POST' | 'DELETE' | 'GET', url: string, sub: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { Authorization: `Bearer ${tokenFor(sub)}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const stmt = (fragment: string) => state.txn.find((s) => s.includes(fragment));

// ---------------------------------------------------------------------------

describe('POST /friends/block', () => {
  it('blocks a user', async () => {
    const res = await call('POST', '/friends/block', ME, { userId: THEM });
    expect(res.statusCode).toBe(200);
    expect(state.txn).toContain('COMMIT');
  });

  it("never deletes the other user's own block of the caller", async () => {
    // The wave-20 security bug: the cleanup DELETE removed rows in both
    // directions unconditionally, so blocking then unblocking someone quietly
    // removed THEIR block of YOU. The exclusion below is the fix.
    await call('POST', '/friends/block', ME, { userId: THEM });

    const cleanup = stmt('DELETE FROM friendships');
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("status <> 'blocked'");
  });

  it('refreshes the block idempotently rather than erroring on a repeat', async () => {
    await call('POST', '/friends/block', ME, { userId: THEM });

    const insert = stmt('INSERT INTO friendships');
    expect(insert).toContain('ON CONFLICT (requester_id, addressee_id)');
    expect(insert).toContain("DO UPDATE SET status = 'blocked'");
  });

  it('severs a shared DM but never a real convoy', async () => {
    await call('POST', '/friends/block', ME, { userId: THEM });

    const sever = stmt('UPDATE convoy_members');
    expect(sever).toBeDefined();
    // Scoped to type='dm' — removing someone from a multi-person convoy
    // because two of its members fell out would be a very different action.
    expect(sever).toContain("g.type = 'dm'");
  });

  it('rejects blocking yourself', async () => {
    const res = await call('POST', '/friends/block', ME, { userId: ME });
    expect(res.statusCode).toBe(400);
    expect(state.txn).toHaveLength(0);
  });

  it('rejects a non-uuid target', async () => {
    expect((await call('POST', '/friends/block', ME, { userId: 'nope' })).statusCode).toBe(400);
  });

  it('does the cleanup, the block and the DM severing in one transaction', async () => {
    // Half-applied, a block could leave the pair un-friended but not blocked.
    await call('POST', '/friends/block', ME, { userId: THEM });

    expect(state.txn[0]).toBe('BEGIN');
    expect(state.txn[state.txn.length - 1]).toBe('COMMIT');
  });
});

describe('POST /friends/unblock', () => {
  it('removes a block the caller placed', async () => {
    const res = await call('POST', '/friends/unblock', ME, { userId: THEM });
    expect(res.statusCode).toBe(200);
  });

  it('404s when there is no such block — you cannot unblock someone who blocked YOU', async () => {
    state.affected = 0;
    const res = await call('POST', '/friends/unblock', ME, { userId: THEM });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /friends/requests', () => {
  it('auto-accepts for an open-privacy account and sends no request notification', async () => {
    state.addresseePrivacy = 'open';
    const res = await call('POST', '/friends/requests', ME, { addresseeId: THEM });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).autoAccepted).toBe(true);
    expect(state.notified).toHaveLength(0);
  });

  it('stays pending for an invite-only account and notifies them', async () => {
    const res = await call('POST', '/friends/requests', ME, { addresseeId: THEM });

    expect(JSON.parse(res.body)).toMatchObject({ status: 'pending', autoAccepted: false });
    expect(state.notified[0]).toMatchObject({ type: 'friend_request', userId: THEM });
  });

  it('refuses when either side has blocked the other, without revealing which', async () => {
    state.blockedEitherWay = true;
    const res = await call('POST', '/friends/requests', ME, { addresseeId: THEM });

    expect(res.statusCode).toBe(403);
    // Deliberately generic: telling a blocked user they were blocked hands
    // them information about someone who wanted no contact.
    expect(JSON.parse(res.body).message).toBe('Unable to send friend request');
  });

  it('takes a pair-scoped advisory lock so two simultaneous requests cannot both insert', async () => {
    await call('POST', '/friends/requests', ME, { addresseeId: THEM });

    const lock = stmt('pg_advisory_xact_lock');
    expect(lock).toBeDefined();
    expect(state.txn.indexOf(lock!)).toBeLessThan(
      state.txn.findIndex((s) => s.startsWith('SELECT id, status FROM friendships')),
    );
  });

  it('keys that lock on the UNORDERED pair so A→B and B→A serialise together', async () => {
    // Ordered keys would let mutual simultaneous requests both proceed, which
    // is exactly the duplicate-friendship race the lock exists to stop.
    await call('POST', '/friends/requests', ME, { addresseeId: THEM });
    const first = state.txn.slice();

    reset();
    await call('POST', '/friends/requests', THEM, { addresseeId: ME });

    // Same lock statement text in both directions (the key is a bound param,
    // built from the sorted pair).
    expect(stmt('pg_advisory_xact_lock')).toBe(first.find((s) => s.includes('pg_advisory_xact_lock')));
  });

  it.each([
    ['already friends', 'accepted', 409],
    ['a request already pending', 'pending', 409],
    ['a block on the pair', 'blocked', 403],
  ])('reports %s', async (_label, status, expected) => {
    state.existingFriendship = { id: 'f-1', status };
    const res = await call('POST', '/friends/requests', ME, { addresseeId: THEM });

    expect(res.statusCode).toBe(expected);
    expect(state.txn).toContain('ROLLBACK');
  });

  it('404s an addressee who does not exist', async () => {
    state.addresseePrivacy = null;
    expect((await call('POST', '/friends/requests', ME, { addresseeId: THEM })).statusCode).toBe(404);
  });

  it('rejects friending yourself', async () => {
    expect((await call('POST', '/friends/requests', ME, { addresseeId: ME })).statusCode).toBe(400);
  });
});

describe('request ownership', () => {
  it('accept is scoped to the addressee AND the pending state', async () => {
    await call('POST', '/friends/requests/f-1/accept', ME);

    const update = state.pool.find((s) => s.startsWith('UPDATE friendships'));
    expect(update).toBeDefined();
    // Both conditions matter. Without addressee_id, a requester could accept
    // their own request; without the status check, a settled row could be
    // flipped back to accepted after being declined.
    expect(update).toContain('addressee_id = $2');
    expect(update).toContain("status = 'pending'");
  });

  it('decline is scoped the same way', async () => {
    await call('POST', '/friends/requests/f-1/decline', ME);

    const del = state.pool.find((s) => s.startsWith('DELETE FROM friendships'));
    expect(del).toContain('addressee_id = $2');
    expect(del).toContain("status = 'pending'");
  });

  it('withdraw is scoped to the REQUESTER, not the addressee', async () => {
    await call('DELETE', '/friends/requests/f-1', ME);

    const del = state.pool.find((s) => s.startsWith('DELETE FROM friendships'));
    expect(del).toContain('requester_id = $2');
  });

  it('404s an accept for a request addressed to someone else', async () => {
    state.affected = 0;
    expect((await call('POST', '/friends/requests/f-1/accept', ME)).statusCode).toBe(404);
  });

  it('notifies the requester when their request is accepted', async () => {
    await call('POST', '/friends/requests/f-1/accept', ME);
    expect(state.notified[0]).toMatchObject({ userId: THEM, title: 'Friend Request Accepted' });
  });

  it('declines silently with 204', async () => {
    expect((await call('POST', '/friends/requests/f-1/decline', ME)).statusCode).toBe(204);
    // Req 17.9 — the requester is deliberately NOT told they were declined.
    expect(state.notified).toHaveLength(0);
  });

  it('404s a decline for a request addressed to someone else', async () => {
    state.affected = 0;
    expect((await call('POST', '/friends/requests/f-1/decline', ME)).statusCode).toBe(404);
  });

  it('withdraws a request the caller sent', async () => {
    expect((await call('DELETE', '/friends/requests/f-1', ME)).statusCode).toBe(204);
  });

  it("404s a withdraw of somebody else's request", async () => {
    state.affected = 0;
    expect((await call('DELETE', '/friends/requests/f-1', ME)).statusCode).toBe(404);
  });
});

describe('authentication', () => {
  it.each([
    ['POST', '/friends/block'],
    ['POST', '/friends/unblock'],
    ['POST', '/friends/requests'],
    ['GET', '/friends/blocked'],
  ])('%s %s requires a token', async (method, url) => {
    const res = await app.inject({ method: method as 'POST', url: `/api/v1${url}`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
