/**
 * Route tests for the garage API (Req 29).
 *
 * The module was ~28% covered: the active-vehicle read had its own suite and
 * the ordering helpers had property tests, but the mutating routes — which
 * carry the "exactly one active vehicle" invariant and all the ownership
 * scoping — had almost none.
 *
 * What these pin down:
 *   - every mutation takes the per-user advisory lock BEFORE touching
 *     is_active, which is what stops two concurrent requests leaving a user
 *     with two active vehicles (an INSERT's new row is invisible to a sibling
 *     transaction, so the transaction alone is not enough)
 *   - one vehicle is switched on only after all of the user's are switched off
 *   - a failure rolls back rather than committing half the switch
 *   - a caller can only ever address their own vehicles
 *   - deleting the active vehicle promotes the oldest survivor, and deleting
 *     the last one leaves no active vehicle rather than erroring
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import vehiclesRoutes from './vehicles.routes';

const USER = '00000000-0000-0000-0000-0000000000a1';
const VEHICLE = '00000000-0000-0000-0000-0000000000c1';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: VEHICLE, user_id: USER, name: 'Daily', vehicle_type: 'car',
    year: 2021, make: 'Subaru', model: 'WRX', color: 'Blue',
    photo_url: null, is_active: false, created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

interface State {
  /** Whether a lookup for the addressed vehicle finds it under this user. */
  owned: boolean;
  /** true when the row being deleted was the active one. */
  deletingActive: boolean;
  /** Ordered log of statements issued on the transactional client. */
  txn: string[];
  /** Force the statement containing this fragment to throw. */
  failOn: string | null;
}
let state: State;

function reset(): void {
  state = { owned: true, deletingActive: false, txn: [], failOn: null };
}

function classify(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('BEGIN')) return 'BEGIN';
  if (s.startsWith('COMMIT')) return 'COMMIT';
  if (s.startsWith('ROLLBACK')) return 'ROLLBACK';
  if (s.includes('pg_advisory_xact_lock')) return 'LOCK';
  if (s.startsWith('INSERT INTO vehicles')) return 'INSERT';
  if (s.includes('SET is_active = false')) return 'DEACTIVATE_ALL';
  if (s.includes('SET is_active = true')) return 'ACTIVATE_ONE';
  if (s.startsWith('DELETE FROM vehicles')) return 'DELETE';
  if (s.startsWith('SELECT')) return 'SELECT';
  if (s.startsWith('UPDATE vehicles SET')) return 'UPDATE_FIELDS';
  return s.slice(0, 20);
}

function answer(sql: string) {
  const kind = classify(sql);
  if (kind === 'INSERT') return { rows: [row()], rowCount: 1 };
  if (kind === 'SELECT') {
    return state.owned
      ? { rows: [row({ is_active: state.deletingActive })], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (kind === 'UPDATE_FIELDS' || kind === 'ACTIVATE_ONE') {
    return state.owned ? { rows: [row()], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}

function buildMockPool(): Pool {
  return {
    query: async (sql: string) => answer(sql),
    connect: async () => ({
      query: async (sql: string) => {
        const kind = classify(sql);
        state.txn.push(kind);
        if (state.failOn && sql.includes(state.failOn)) throw new Error('boom');
        return answer(sql);
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => {
    i.decorate('redis', {
      incr: async () => 1, expire: async () => {}, ttl: async () => 3600,
      get: async () => null, set: async () => {},
    } as unknown as Redis);
  }, { name: 'redis' }));
  app.register(vehiclesRoutes, { prefix: '/api/v1' });
  await app.ready();
  token = app.jwt.sign({ sub: USER });
});

afterAll(async () => { await app.close(); });
beforeEach(reset);

function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { Authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/** Index of the first occurrence of a statement kind in the transaction log. */
const at = (kind: string) => state.txn.indexOf(kind);

// ---------------------------------------------------------------------------

describe('POST /vehicles', () => {
  it('creates a non-primary vehicle without opening a transaction', async () => {
    const res = await inject('POST', '/vehicles', { name: 'Weekend', type: 'car' });
    expect(res.statusCode).toBe(201);
    expect(state.txn).toEqual([]); // straight through the pool
  });

  it('serializes a create-as-primary behind the per-user lock', async () => {
    const res = await inject('POST', '/vehicles', { name: 'Daily', primary: true });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).isActive).toBe(true);
    // The lock must come before any is_active work, or a concurrent create
    // could interleave: its new row is invisible to this transaction, so
    // nothing else would make them block on each other.
    expect(at('LOCK')).toBeGreaterThan(at('BEGIN'));
    expect(at('LOCK')).toBeLessThan(at('DEACTIVATE_ALL'));
    expect(at('DEACTIVATE_ALL')).toBeLessThan(at('ACTIVATE_ONE'));
    expect(state.txn).toContain('COMMIT');
  });

  it('rolls back if a statement fails midway through the primary switch', async () => {
    state.failOn = 'SET is_active = true';
    const res = await inject('POST', '/vehicles', { name: 'Daily', primary: true });

    expect(res.statusCode).toBe(500);
    expect(state.txn).toContain('ROLLBACK');
    expect(state.txn).not.toContain('COMMIT');
  });

  it.each([
    ['a year before the first motor car', { year: 1800 }],
    ['a far-future year', { year: 3000 }],
    ['a non-integer year', { year: 2021.5 }],
    ['an over-long name', { name: 'x'.repeat(101) }],
    ['a photoUrl that is not a URL', { photoUrl: 'not-a-url' }],
    ['a non-boolean primary', { primary: 'yes' }],
  ])('rejects %s', async (_label, body) => {
    expect((await inject('POST', '/vehicles', body)).statusCode).toBe(400);
  });

  it('accepts an empty body — every field is optional', async () => {
    expect((await inject('POST', '/vehicles', {})).statusCode).toBe(201);
  });
});

describe('PATCH /vehicles/:id', () => {
  it('updates fields without touching is_active when primary is not set', async () => {
    const res = await inject('PATCH', `/vehicles/${VEHICLE}`, { color: 'Red' });
    expect(res.statusCode).toBe(200);
    expect(state.txn).toEqual([]);
  });

  it('404s a vehicle belonging to someone else', async () => {
    state.owned = false;
    expect((await inject('PATCH', `/vehicles/${VEHICLE}`, { color: 'Red' })).statusCode).toBe(404);
  });

  it('takes the lock before switching primary', async () => {
    const res = await inject('PATCH', `/vehicles/${VEHICLE}`, { color: 'Red', primary: true });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).isActive).toBe(true);
    expect(at('LOCK')).toBeLessThan(at('DEACTIVATE_ALL'));
    expect(at('DEACTIVATE_ALL')).toBeLessThan(at('ACTIVATE_ONE'));
  });

  it('handles primary-only with no other field changes', async () => {
    // setClauses is empty here, so the handler SELECTs the row instead of
    // building an UPDATE — a path that would otherwise emit invalid SQL.
    const res = await inject('PATCH', `/vehicles/${VEHICLE}`, { primary: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).isActive).toBe(true);
  });

  it('rolls back and 404s when a primary-only patch addresses a foreign vehicle', async () => {
    state.owned = false;
    const res = await inject('PATCH', `/vehicles/${VEHICLE}`, { primary: true });

    expect(res.statusCode).toBe(404);
    expect(state.txn).toContain('ROLLBACK');
    expect(state.txn).not.toContain('DEACTIVATE_ALL');
  });
});

describe('DELETE /vehicles/:id', () => {
  it('deletes a non-active vehicle and leaves the active one alone', async () => {
    const res = await inject('DELETE', `/vehicles/${VEHICLE}`);

    expect(res.statusCode).toBe(204);
    expect(state.txn).toContain('DELETE');
    expect(state.txn).not.toContain('ACTIVATE_ONE');
    expect(state.txn).toContain('COMMIT');
  });

  it('promotes the oldest survivor when the active vehicle is deleted', async () => {
    state.deletingActive = true;
    const res = await inject('DELETE', `/vehicles/${VEHICLE}`);

    expect(res.statusCode).toBe(204);
    expect(at('DELETE')).toBeLessThan(at('ACTIVATE_ONE'));
  });

  it('takes the lock so a concurrent add cannot leave two vehicles active', async () => {
    state.deletingActive = true;
    await inject('DELETE', `/vehicles/${VEHICLE}`);
    expect(at('LOCK')).toBeLessThan(at('DELETE'));
  });

  it('404s and rolls back for a vehicle the caller does not own', async () => {
    state.owned = false;
    const res = await inject('DELETE', `/vehicles/${VEHICLE}`);

    expect(res.statusCode).toBe(404);
    expect(state.txn).toContain('ROLLBACK');
    expect(state.txn).not.toContain('DELETE');
  });
});

describe('POST /vehicles/:id/activate', () => {
  it('clears every other vehicle before activating the target', async () => {
    const res = await inject('POST', `/vehicles/${VEHICLE}/activate`);

    expect(res.statusCode).toBe(200);
    expect(at('LOCK')).toBeLessThan(at('DEACTIVATE_ALL'));
    expect(at('DEACTIVATE_ALL')).toBeLessThan(at('ACTIVATE_ONE'));
    expect(state.txn).toContain('COMMIT');
  });

  it('404s without deactivating anything when the vehicle is not the caller\'s', async () => {
    state.owned = false;
    const res = await inject('POST', `/vehicles/${VEHICLE}/activate`);

    expect(res.statusCode).toBe(404);
    // The critical part: a failed ownership check must not have already
    // switched off the caller's real active vehicle.
    expect(state.txn).not.toContain('DEACTIVATE_ALL');
    expect(state.txn).toContain('ROLLBACK');
  });

  it('rolls back when the activation statement fails', async () => {
    state.failOn = 'SET is_active = true';
    const res = await inject('POST', `/vehicles/${VEHICLE}/activate`);

    expect(res.statusCode).toBe(500);
    expect(state.txn).toContain('ROLLBACK');
    expect(state.txn).not.toContain('COMMIT');
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/vehicles/${VEHICLE}/activate` });
    expect(res.statusCode).toBe(401);
  });
});
