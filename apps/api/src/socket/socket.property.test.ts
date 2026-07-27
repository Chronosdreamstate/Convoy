/**
 * Property 39: Gap alerts are delivered only to the Admin
 *   For any group, when a Member's location is > gap_threshold_m from the Admin,
 *   the gap:alert event is emitted to user:{adminId} and NEVER to the group room.
 *   Validates: Requirements 24.2, 24.5
 *
 * Property 40: Stale location is excluded from gap calculations
 *   When the Admin's cached location timestamp is > 30 seconds old,
 *   no gap:alert is emitted even if the Member is far away.
 *   Validates: Requirement 24.6
 */

import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Server as SocketIO, Socket } from 'socket.io';
import {
  getPresence,
  getUserDmGroupIds,
  handleLocationUpdate,
  handleSosAcknowledge,
  haversineMeters,
  IoBroadcaster,
  LocationPayload,
  PRESENCE_ONLINE_TTL_SECONDS,
  refreshPresence,
  registerSocketHandlers,
  setPresenceOffline,
  setPresenceOnline,
} from './socket.handler';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface Emission {
  room: string;
  event: string;
  data: unknown;
}

function buildMockIO(log: Emission[]): IoBroadcaster {
  return {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => {
        log.push({ room, event, data });
      },
    }),
  };
}

function buildMockRedis(
  store: Record<string, Record<string, string>>,
  stringStore: Record<string, string> = {},
): Redis {
  return {
    hset: async (key: string, fields: Record<string, string>) => {
      store[key] = { ...(store[key] ?? {}), ...fields };
      return Object.keys(fields).length;
    },
    expire: async () => 1,
    hgetall: async (key: string) => store[key] ?? null,
    incrbyfloat: async (key: string, delta: number) => {
      const prev = parseFloat(stringStore[key] ?? '0');
      const next = prev + delta;
      stringStore[key] = String(next);
      return next;
    },
    set: async (key: string, _value: string, ..._args: unknown[]) => {
      // Simulate NX: only set if key doesn't already exist
      if (stringStore[key] !== undefined) return null;
      stringStore[key] = '1';
      return 'OK';
    },
  } as unknown as Redis;
}

function buildMockDB(adminId: string, gapThresholdM: number): Pool {
  return {
    query: async () => ({
      rows: [{ admin_id: adminId, gap_threshold_m: gapThresholdM }],
      rowCount: 1,
    }),
  } as unknown as Pool;
}

/** Helper: set admin location in the redis store */
function setAdminLocation(
  store: Record<string, Record<string, string>>,
  groupId: string,
  adminId: string,
  lat: number,
  lng: number,
  ts: number,
) {
  store[`loc:${groupId}:${adminId}`] = {
    lat: String(lat),
    lng: String(lng),
    heading: '0',
    speed_kph: '0',
    ts: String(ts),
  };
}

// ---------------------------------------------------------------------------
// Property 39: gap:alert sent to user:{adminId} only
// ---------------------------------------------------------------------------
describe('Property 39: Gap alerts are delivered only to the Admin', () => {
  it('gap:alert is emitted to user:{adminId} and not to the group room', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),      // groupId
        fc.uuid(),      // adminId
        fc.uuid(),      // memberId
        fc.integer({ min: 100, max: 5_000 }), // gap threshold in metres
        async (groupId, adminId, memberId, gapThresholdM) => {
          fc.pre(adminId !== memberId);

          const log: Emission[] = [];
          const store: Record<string, Record<string, string>> = {};

          const NOW = 1_700_000_000_000; // fixed reference time

          // Admin is at (0, 0), member is ~5560 m north — always > any threshold ≤ 5000m
          setAdminLocation(store, groupId, adminId, 0, 0, NOW - 1_000);

          const memberLocation: LocationPayload = {
            lat: 0.05,  // ~5560 m north
            lng: 0,
            heading: 0,
            speed_kph: 60,
            ts: NOW,
          };

          await handleLocationUpdate({
            groupId,
            userId: memberId,
            location: memberLocation,
            redis: buildMockRedis(store),
            db: buildMockDB(adminId, gapThresholdM),
            io: buildMockIO(log),
            now: NOW,
          });

          const gapAlerts = log.filter((e) => e.event === 'gap:alert');

          // At least one gap:alert must have been emitted (member is far away)
          expect(gapAlerts.length).toBeGreaterThan(0);

          // Every gap:alert must go to user:{adminId} — NEVER to the group room
          for (const alert of gapAlerts) {
            expect(alert.room).toBe(`user:${adminId}`);
            expect(alert.room).not.toBe(`group:${groupId}`);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('gap-alert PUSH is deduplicated — repeated over-threshold ticks enqueue at most one push per cooldown', async () => {
    const groupId = '44444444-4444-4444-4444-444444444444';
    const adminId = '55555555-5555-5555-5555-555555555555';
    const memberId = '66666666-6666-6666-6666-666666666666';
    const store: Record<string, Record<string, string>> = {};
    const stringStore: Record<string, string> = {};
    const redis = buildMockRedis(store, stringStore);
    const NOW = 1_700_000_000_000;
    setAdminLocation(store, groupId, adminId, 0, 0, NOW - 1_000);

    const enqueueNotification = jest.fn().mockResolvedValue(undefined);
    const farNorth = { lat: 0.05, lng: 0, heading: 0, speed_kph: 60 };

    // Member sits beyond the gap threshold across three consecutive ~3s ticks.
    for (let i = 0; i < 3; i++) {
      const t = NOW + i * 3_000;
      await handleLocationUpdate({
        groupId,
        userId: memberId,
        location: { ...farNorth, ts: t },
        redis,
        db: buildMockDB(adminId, 1_000),
        io: buildMockIO([]),
        now: t,
        enqueueNotification,
      });
    }

    // The live gap:alert socket emit fires every tick (an in-app indicator),
    // but the background push is gated to once per cooldown window.
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification.mock.calls[0][0]).toMatchObject({ type: 'gap_alert', userId: adminId });
  });

  it('admin sending their own location update never triggers a gap:alert', async () => {
    const groupId = '11111111-1111-1111-1111-111111111111';
    const adminId = '22222222-2222-2222-2222-222222222222';
    const store: Record<string, Record<string, string>> = {};
    const log: Emission[] = [];
    const NOW = 1_700_000_000_000;

    setAdminLocation(store, groupId, adminId, 0, 0, NOW - 1_000);

    // Admin sends their own location update
    await handleLocationUpdate({
      groupId,
      userId: adminId, // same as admin
      location: { lat: 10, lng: 10, heading: 90, speed_kph: 80, ts: NOW },
      redis: buildMockRedis(store),
      db: buildMockDB(adminId, 100), // tiny threshold — would fire if it were a member
      io: buildMockIO(log),
      now: NOW,
    });

    expect(log.filter((e) => e.event === 'gap:alert')).toHaveLength(0);
  });

  it('member within threshold does not trigger gap:alert', async () => {
    const groupId = '33333333-3333-3333-3333-333333333333';
    const adminId = '44444444-4444-4444-4444-444444444444';
    const memberId = '55555555-5555-5555-5555-555555555555';
    const store: Record<string, Record<string, string>> = {};
    const log: Emission[] = [];
    const NOW = 1_700_000_000_000;

    // Admin at (0, 0)
    setAdminLocation(store, groupId, adminId, 0, 0, NOW - 1_000);

    // Member at ~111 m north — well within 5000 m threshold
    await handleLocationUpdate({
      groupId,
      userId: memberId,
      location: { lat: 0.001, lng: 0, heading: 0, speed_kph: 30, ts: NOW },
      redis: buildMockRedis(store),
      db: buildMockDB(adminId, 5_000),
      io: buildMockIO(log),
      now: NOW,
    });

    expect(log.filter((e) => e.event === 'gap:alert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 40: Stale location excluded from gap calculations
// ---------------------------------------------------------------------------
describe('Property 40: Stale location excluded from gap calculations', () => {
  it('no gap:alert when admin location is > 30 seconds old', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // groupId
        fc.uuid(), // adminId
        fc.uuid(), // memberId
        // Stale offset: 30001 ms to 60000 ms
        fc.integer({ min: 30_001, max: 60_000 }),
        async (groupId, adminId, memberId, staleOffsetMs) => {
          fc.pre(adminId !== memberId);

          const log: Emission[] = [];
          const store: Record<string, Record<string, string>> = {};
          const NOW = 1_700_000_000_000;

          // Admin's location timestamp is in the past by staleOffsetMs
          setAdminLocation(store, groupId, adminId, 0, 0, NOW - staleOffsetMs);

          // Member is very far away (would normally trigger gap:alert)
          await handleLocationUpdate({
            groupId,
            userId: memberId,
            location: { lat: 10, lng: 10, heading: 45, speed_kph: 100, ts: NOW },
            redis: buildMockRedis(store),
            db: buildMockDB(adminId, 100), // tiny threshold
            io: buildMockIO(log),
            now: NOW,
          });

          // Stale admin location → no gap:alert regardless of distance
          expect(log.filter((e) => e.event === 'gap:alert')).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('fresh admin location (< 30s) does trigger gap:alert when far away', async () => {
    const groupId = '66666666-6666-6666-6666-666666666666';
    const adminId = '77777777-7777-7777-7777-777777777777';
    const memberId = '88888888-8888-8888-8888-888888888888';
    const store: Record<string, Record<string, string>> = {};
    const log: Emission[] = [];
    const NOW = 1_700_000_000_000;

    // Admin location is 29 seconds old — still fresh
    setAdminLocation(store, groupId, adminId, 0, 0, NOW - 29_000);

    await handleLocationUpdate({
      groupId,
      userId: memberId,
      location: { lat: 0.05, lng: 0, heading: 0, speed_kph: 60, ts: NOW },
      redis: buildMockRedis(store),
      db: buildMockDB(adminId, 100),
      io: buildMockIO(log),
      now: NOW,
    });

    expect(log.filter((e) => e.event === 'gap:alert')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sanity tests for haversineMeters (regression guards)
// ---------------------------------------------------------------------------
describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.1 })).toBe(0);
  });

  it('approximates 1 degree latitude ≈ 111km', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('is symmetric', () => {
    const a = { lat: 34.05, lng: -118.24 };
    const b = { lat: 51.51, lng: -0.12 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 0);
  });
});

// ---------------------------------------------------------------------------
// Property 95: haversineMeters identity — distance from a point to itself is 0
//   Validates: correctness invariant for gap-alert and distance accumulation
// ---------------------------------------------------------------------------
describe('Property 95: haversineMeters(A, A) === 0 for any coordinate', () => {
  it('returns exactly 0 for arbitrary identical point pairs', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        (lat, lng) => {
          const point = { lat, lng };
          expect(haversineMeters(point, point)).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 96: haversineMeters symmetry — d(A, B) === d(B, A)
//   Validates: distance accumulation is order-independent
// ---------------------------------------------------------------------------
describe('Property 96: haversineMeters(A, B) === haversineMeters(B, A) for any coordinate pair', () => {
  it('is symmetric for arbitrary coordinate pairs', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        (lat1, lng1, lat2, lng2) => {
          const a = { lat: lat1, lng: lng1 };
          const b = { lat: lat2, lng: lng2 };
          // Allow a tiny floating-point epsilon (< 1 metre)
          expect(Math.abs(haversineMeters(a, b) - haversineMeters(b, a))).toBeLessThan(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 97: haversineMeters non-negativity — distance is always ≥ 0
//   Validates: no negative distances can corrupt Redis incrbyfloat accumulation
// ---------------------------------------------------------------------------
describe('Property 97: haversineMeters(A, B) >= 0 for any coordinate pair', () => {
  it('is non-negative for arbitrary coordinate pairs', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        (lat1, lng1, lat2, lng2) => {
          const d = haversineMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
          expect(d).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Redis-backed presence (replaces the old in-memory per-process Map, which
// gave wrong answers across multiple nodes behind the socket.io Redis
// adapter). FakeRedis simulates the string commands + EX TTLs the presence
// helpers use, with a manually advanced clock so expiry is deterministic.
// ---------------------------------------------------------------------------

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  now = 1_700_000_000_000;

  advanceMs(ms: number): void {
    this.now += ms;
  }

  private live(key: string): { value: string; expiresAt: number | null } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    let expiresAt: number | null = null;
    const exIdx = args.findIndex((a) => a === 'EX');
    if (exIdx >= 0) expiresAt = this.now + Number(args[exIdx + 1]) * 1000;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    const had = this.live(key) ? 1 : 0;
    this.store.delete(key);
    return had;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k)?.value ?? null);
  }
}

function fakeRedis(): { redis: Redis; fake: FakeRedis } {
  const fake = new FakeRedis();
  return { redis: fake as unknown as Redis, fake };
}

describe('Redis-backed presence', () => {
  it('Property: a connected user is online with the connect-time lastSeen; unknown users are offline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.hexaString({ minLength: 4, maxLength: 20 }), // socketId
        async (userId, strangerId, socketId) => {
          fc.pre(userId !== strangerId);
          const { redis, fake } = fakeRedis();
          await setPresenceOnline(redis, userId, socketId, fake.now);

          const result = await getPresence(redis, [userId, strangerId]);
          expect(result).toEqual([
            { id: userId, isOnline: true, lastSeen: new Date(fake.now).toISOString() },
            { id: strangerId, isOnline: false, lastSeen: null },
          ]);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('Property (multi-tab guard): the old socket disconnecting never flips a reconnected user offline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.hexaString({ minLength: 4, maxLength: 20 }),
        fc.hexaString({ minLength: 4, maxLength: 20 }),
        async (userId, socketA, socketB) => {
          fc.pre(socketA !== socketB);
          const { redis, fake } = fakeRedis();

          // Socket A connects, then socket B connects (reconnect / second tab)
          await setPresenceOnline(redis, userId, socketA, fake.now);
          fake.advanceMs(1000);
          await setPresenceOnline(redis, userId, socketB, fake.now);

          // A's disconnect: no longer the owner → no transition, still online
          const transitionedA = await setPresenceOffline(redis, userId, socketA, fake.now);
          expect(transitionedA).toBe(false);
          expect((await getPresence(redis, [userId]))[0].isOnline).toBe(true);

          // B's disconnect: owner → transitions offline, lastSeen updated
          fake.advanceMs(1000);
          const transitionedB = await setPresenceOffline(redis, userId, socketB, fake.now);
          expect(transitionedB).toBe(true);
          expect((await getPresence(redis, [userId]))[0]).toEqual({
            id: userId,
            isOnline: false,
            lastSeen: new Date(fake.now).toISOString(),
          });
        },
      ),
      { numRuns: 30 },
    );
  });

  it('Property (TTL heartbeat): presence expires without refresh, survives with it, and lastSeen outlives the online flag', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.hexaString({ minLength: 4, maxLength: 20 }),
        fc.integer({ min: 1, max: 20 }), // heartbeat count
        async (userId, socketId, beats) => {
          const { redis, fake } = fakeRedis();
          const connectedAt = fake.now;
          await setPresenceOnline(redis, userId, socketId, fake.now);

          // Heartbeats every 25s keep the user online well past the raw TTL
          for (let i = 0; i < beats; i++) {
            fake.advanceMs(25_000);
            await refreshPresence(redis, userId, socketId, fake.now);
            expect((await getPresence(redis, [userId]))[0].isOnline).toBe(true);
          }

          // No more heartbeats → online flag expires after the TTL…
          fake.advanceMs(PRESENCE_ONLINE_TTL_SECONDS * 1000 + 1);
          const afterExpiry = (await getPresence(redis, [userId]))[0];
          expect(afterExpiry.isOnline).toBe(false);
          // …but lastSeen (24h TTL) survives — never earlier than connect time
          expect(afterExpiry.lastSeen).not.toBeNull();
          expect(new Date(afterExpiry.lastSeen as string).getTime()).toBeGreaterThanOrEqual(connectedAt);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('a stale socket heartbeat never steals presence ownership from a newer socket', async () => {
    const { redis, fake } = fakeRedis();
    const userId = '99999999-9999-9999-9999-999999999999';
    await setPresenceOnline(redis, userId, 'old-socket', fake.now);
    fake.advanceMs(1000);
    await setPresenceOnline(redis, userId, 'new-socket', fake.now);

    fake.advanceMs(1000);
    await refreshPresence(redis, userId, 'old-socket', fake.now);

    // Ownership still with new-socket: its disconnect transitions offline
    expect(await setPresenceOffline(redis, userId, 'new-socket', fake.now)).toBe(true);
  });

  it('getPresence caps the lookup at 100 user ids', async () => {
    const { redis } = fakeRedis();
    const ids = Array.from({ length: 150 }, (_, i) => `user-${i}`);
    const result = await getPresence(redis, ids);
    expect(result).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// DM room membership lookup — connect-time `group:<dmId>` room joins are fed
// by this query, which must return exactly the user's active DM channels.
// ---------------------------------------------------------------------------
describe('getUserDmGroupIds', () => {
  it('Property: returns exactly the ids the membership query yields, in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.array(fc.uuid(), { minLength: 0, maxLength: 10 }),
        async (userId, dmIds) => {
          const seenParams: unknown[][] = [];
          const db = {
            query: async (_sql: string, params: unknown[]) => {
              seenParams.push(params);
              return { rows: dmIds.map((id) => ({ id })), rowCount: dmIds.length };
            },
          } as unknown as Pool;

          const result = await getUserDmGroupIds(db, userId);
          expect(result).toEqual(dmIds);
          expect(seenParams).toEqual([[userId]]);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Socket connect race — the connection handler must register EVERY event
// listener synchronously; the async connect-time setup (active-group lookup,
// membership check, presence write, room joins) is captured in an internal
// `ready` promise that setup-dependent handlers await. A client emitting
// immediately after 'connect' must never lose the event or its ack.
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain all pending microtasks (mock redis/db calls never touch real timers). */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

type QueryResult = { rows: unknown[]; rowCount: number };
type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

class MockSocket {
  connected = true;
  rooms = new Set<string>();
  conn = { on: (): void => undefined };
  /** socket.to(room).emit(...) relays land here */
  emissions: Emission[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(
    public id: string,
    public data: Record<string, unknown>,
  ) {}

  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }

  registeredEvents(): string[] {
    return [...this.listeners.keys()];
  }

  /** Simulates a client emit arriving at the server. */
  trigger(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  async join(room: string): Promise<void> {
    this.rooms.add(room);
  }

  to(room: string): { emit(event: string, payload: unknown): void } {
    return {
      emit: (event: string, payload: unknown) =>
        this.emissions.push({ room, event, data: payload }),
    };
  }

  disconnect(): this {
    this.connected = false;
    this.trigger('disconnect');
    return this;
  }
}

function connMockRedis(): Redis {
  return {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    mget: async (...keys: string[]) => keys.map(() => null),
    hgetall: async () => ({}),
    hset: async () => 1,
    expire: async () => 1,
    incrbyfloat: async () => 0,
    sadd: async () => 1,
  } as unknown as Redis;
}

function connMockFastify(query: QueryFn): FastifyInstance {
  return {
    db: { query } as unknown as Pool,
    redis: connMockRedis(),
    log: { error: () => undefined, info: () => undefined },
  } as unknown as FastifyInstance;
}

describe('registerSocketHandlers — connect race (synchronous listener registration)', () => {
  const EXPECTED_EVENTS = [
    'ping',
    'presence:get',
    'dm:join',
    'location:update',
    'ptt:start',
    'ptt:end',
    'convoy:alert',
    'ptt:replay_request',
    'ptt:admin_mute',
    'chat:typing',
    'hazard:vote',
    'convoy:member_ready',
    'convoy:start',
    'sos:acknowledge',
    'waypoint:reached',
    'disconnect',
  ];

  it('registers every event listener synchronously, before any connect-time DB call resolves', () => {
    // Every DB call hangs forever — if listener registration awaited any of
    // the connect-time queries, no listener would exist yet.
    const never = deferred<QueryResult>();
    const handler = registerSocketHandlers(
      connMockFastify(() => never.promise),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('sync-1', { userId: 'u-sync', groupId: '' });

    handler(socket as unknown as Socket);

    for (const event of EXPECTED_EVENTS) {
      expect(socket.registeredEvents()).toContain(event);
    }
  });

  it('presence:get emitted before setup completes is queued, not dropped — acked once ready', async () => {
    const groupLookup = deferred<QueryResult>();
    const handler = registerSocketHandlers(
      connMockFastify((sql) =>
        sql.includes('SELECT group_id') ? groupLookup.promise : Promise.resolve({ rows: [], rowCount: 0 }),
      ),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('race-presence', { userId: 'u-p', groupId: '' });
    handler(socket as unknown as Socket);

    // First emit, immediately after connect — the old code lost this event
    // because the listener was only registered after the awaited lookups.
    const ack = jest.fn();
    socket.trigger('presence:get', { userIds: [] }, ack);
    await flush();
    expect(ack).not.toHaveBeenCalled(); // gated on setup, never dropped

    groupLookup.resolve({ rows: [], rowCount: 0 });
    await flush();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith([]);
  });

  it('location:update emitted before the membership check resolves still fans out to the group room', async () => {
    const memberCheck = deferred<QueryResult>();
    const ioLog: Emission[] = [];
    const handler = registerSocketHandlers(
      connMockFastify((sql) =>
        sql.includes('SELECT id FROM convoy_members')
          ? memberCheck.promise
          : Promise.resolve({ rows: [], rowCount: 0 }),
      ),
      buildMockIO(ioLog) as unknown as SocketIO,
    );
    const socket = new MockSocket('race-loc', { userId: 'u-loc', groupId: 'g-loc' });
    handler(socket as unknown as Socket);

    socket.trigger('location:update', {
      lat: 1,
      lng: 2,
      heading: 0,
      speed_kph: 10,
      ts: Date.now(),
    });
    await flush();
    expect(ioLog.filter((e) => e.event === 'location:update')).toHaveLength(0); // still gated

    memberCheck.resolve({ rows: [{ id: 'm1' }], rowCount: 1 });
    await flush();
    const fanned = ioLog.filter((e) => e.event === 'location:update');
    expect(fanned).toHaveLength(1);
    expect(fanned[0].room).toBe('group:g-loc');
    expect(socket.rooms.has('group:g-loc')).toBe(true); // room joined before fan-out
  });

  it('a socket that fails the membership check is disconnected and its early emits are dropped without acks', async () => {
    const memberCheck = deferred<QueryResult>();
    const handler = registerSocketHandlers(
      connMockFastify((sql) =>
        sql.includes('SELECT id FROM convoy_members')
          ? memberCheck.promise
          : Promise.resolve({ rows: [], rowCount: 0 }),
      ),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('race-unauth', { userId: 'u-bad', groupId: 'g-not-mine' });
    handler(socket as unknown as Socket);

    const ack = jest.fn();
    socket.trigger('presence:get', { userIds: [] }, ack);

    memberCheck.resolve({ rows: [], rowCount: 0 }); // not a member
    await flush();
    expect(socket.connected).toBe(false); // disconnected by setup
    expect(ack).not.toHaveBeenCalled(); // gated handlers drop everything
    expect(socket.rooms.size).toBe(0); // no rooms were joined
  });

  // convoy:start must persist a convoy_started row per other member, so the
  // "Convoy started" entry the mobile client synthesizes from the live socket
  // event survives a Notification Center refresh (which reconciles against
  // GET /notifications and drops any row the server doesn't return).
  it('convoy:start persists a convoy_started notification for every other member', async () => {
    const admin = 'u-admin';
    const inserts: Array<unknown[]> = [];
    const query: QueryFn = async (sql, params = []) => {
      if (sql.includes('SELECT id FROM convoy_members')) {
        return { rows: [{ id: 'm-self' }], rowCount: 1 }; // connect-time membership → member
      }
      if (sql.includes('FROM convoy_groups')) {
        return { rows: [{ admin_id: admin, name: 'Sunday Cruise' }], rowCount: 1 };
      }
      if (sql.includes('SELECT user_id FROM convoy_members')) {
        return { rows: [{ user_id: 'm2' }, { user_id: 'm3' }], rowCount: 2 };
      }
      if (sql.includes('INSERT INTO notification_history')) {
        inserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const handler = registerSocketHandlers(
      connMockFastify(query),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('cs-1', { userId: admin, groupId: 'g1' });
    handler(socket as unknown as Socket);
    await flush(); // connect-time membership check resolves → whenReady true

    socket.trigger('convoy:start', { groupId: 'g1' });
    await flush();
    await flush();
    await flush();

    // one row per OTHER member (m2, m3); the starting admin is excluded
    expect(inserts.map((p) => p[0])).toEqual(['m2', 'm3']);
    for (const params of inserts) {
      expect(params[1]).toBe('convoy_started');
      expect(params[2]).toBe('Convoy started');
      expect(params[3]).toBe('Sunday Cruise is on the move');
      expect(JSON.parse(params[4] as string)).toEqual({ groupId: 'g1' });
    }
  });

  it('convoy:start from a non-admin persists nothing', async () => {
    const inserts: Array<unknown[]> = [];
    const query: QueryFn = async (sql) => {
      if (sql.includes('SELECT id FROM convoy_members')) {
        return { rows: [{ id: 'm-self' }], rowCount: 1 };
      }
      if (sql.includes('FROM convoy_groups')) {
        return { rows: [{ admin_id: 'someone-else', name: 'Sunday Cruise' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO notification_history')) {
        inserts.push([]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const handler = registerSocketHandlers(
      connMockFastify(query),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('cs-2', { userId: 'u-not-admin', groupId: 'g1' });
    handler(socket as unknown as Socket);
    await flush();

    socket.trigger('convoy:start', { groupId: 'g1' });
    await flush();
    await flush();

    expect(inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 98: haversineMeters bounded — never exceeds Earth's half-circumference
//   Earth's mean radius ≈ 6 371 km → half-circumference ≈ 20 037 km
//   Validates: no astronomically wrong distance can slip through
// ---------------------------------------------------------------------------
describe('Property 98: haversineMeters(A, B) <= 20_037_508 for any coordinate pair', () => {
  it('never exceeds Earth half-circumference', () => {
    const HALF_CIRCUMFERENCE_M = 20_037_508;
    fc.assert(
      fc.property(
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        (lat1, lng1, lat2, lng2) => {
          const d = haversineMeters({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
          expect(d).toBeLessThanOrEqual(HALF_CIRCUMFERENCE_M);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// SOS acknowledgment routing (Req 25.5, 25.7)
//   The relay targets the SOS pin's own group (or its owner's personal room
//   for a standalone SOS) — NOT the acknowledger's convoy. Expired pins fall
//   back to the acknowledger's group room; with no group either, nothing is
//   emitted (never the bogus room `group:`).
// ---------------------------------------------------------------------------
describe('SOS acknowledgment routing', () => {
  function buildSosRedis(pins: Record<string, string>): Redis {
    return { get: async (key: string) => pins[key] ?? null } as unknown as Redis;
  }

  function buildStatDb(): Pool {
    return { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pool;
  }

  it('group SOS: ack is broadcast to the PINs group room, not the acknowledgers', async () => {
    const log: Emission[] = [];
    await handleSosAcknowledge({
      sosId: 'sos-1',
      memberName: 'Alice',
      ackUserId: 'acker-1',
      groupId: 'acker-group',
      redis: buildSosRedis({
        'sos:sos-1': JSON.stringify({ userId: 'owner-1', groupId: 'pin-group' }),
      }),
      db: buildStatDb(),
      io: buildMockIO(log),
    });

    expect(log).toEqual([
      {
        room: 'group:pin-group',
        event: 'sos:acknowledged',
        data: { sosId: 'sos-1', memberName: 'Alice', acknowledgedBy: 'acker-1' },
      },
    ]);
  });

  it('standalone SOS: ack reaches the owners personal room even when the acknowledger has no group', async () => {
    const log: Emission[] = [];
    await handleSosAcknowledge({
      sosId: 'sos-2',
      ackUserId: 'friend-1',
      groupId: '',
      redis: buildSosRedis({
        'sos:sos-2': JSON.stringify({ userId: 'owner-2', groupId: null }),
      }),
      db: buildStatDb(),
      io: buildMockIO(log),
    });

    expect(log).toHaveLength(1);
    expect(log[0].room).toBe('user:owner-2');
    expect(log[0].event).toBe('sos:acknowledged');
  });

  it('expired pin: falls back to the acknowledgers group room', async () => {
    const log: Emission[] = [];
    await handleSosAcknowledge({
      sosId: 'gone',
      ackUserId: 'acker-1',
      groupId: 'acker-group',
      redis: buildSosRedis({}),
      db: buildStatDb(),
      io: buildMockIO(log),
    });

    expect(log).toHaveLength(1);
    expect(log[0].room).toBe('group:acker-group');
  });

  it('expired pin + groupless acknowledger: emits nothing (never the bogus room `group:`)', async () => {
    const log: Emission[] = [];
    await handleSosAcknowledge({
      sosId: 'gone',
      ackUserId: 'acker-1',
      groupId: '',
      redis: buildSosRedis({}),
      db: buildStatDb(),
      io: buildMockIO(log),
    });

    expect(log).toHaveLength(0);
  });

  it('credits the sos_hero stat counter for the acknowledging member', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
    } as unknown as Pool;
    await handleSosAcknowledge({
      sosId: 'sos-1',
      ackUserId: 'acker-1',
      groupId: 'g',
      redis: buildSosRedis({ 'sos:sos-1': JSON.stringify({ userId: 'o', groupId: 'g' }) }),
      db,
      io: buildMockIO([]),
    });

    expect(calls.some((c) => c.sql.includes('user_stat_counters') && c.params.includes('sos_hero') && c.params.includes('acker-1'))).toBe(true);
  });
});
