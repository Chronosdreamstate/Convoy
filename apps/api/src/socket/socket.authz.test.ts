/**
 * Per-event authorization on the WebSocket.
 *
 * REST authorization is re-checked on every request; socket authorization was
 * resolved once at connect and every later event trusted the result (and, in a
 * couple of places, the payload). These tests pin the holes that opened up:
 *
 *   - a DM channel being mistaken for the socket's active convoy, which turned
 *     the DM room into a live GPS feed and silently disabled the opt-in-gated
 *     friend-location cache;
 *   - `presence:get` answering for arbitrary user ids;
 *   - `convoy:alert` relaying and persisting an unvalidated, unbounded payload.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Server as SocketIO, Socket } from 'socket.io';
import {
  CONVOY_ALERT_MAX_MESSAGE_CHARS,
  filterVisiblePresenceIds,
  registerSocketHandlers,
  IoBroadcaster,
} from './socket.handler';

// ---------------------------------------------------------------------------
// Test doubles (mirrors the harness in socket.property.test.ts)
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

type QueryResult = { rows: unknown[]; rowCount: number };
type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** Drain all pending microtasks (the mocks never touch real timers). */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

class MockSocket {
  connected = true;
  rooms = new Set<string>();
  conn = { on: (): void => undefined };
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

function mockRedis(hashes: Record<string, Record<string, string>> = {}): Redis {
  return {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    mget: async (...keys: string[]) => keys.map(() => null),
    hgetall: async (key: string) => hashes[key] ?? {},
    hset: async (key: string, fields: Record<string, string>) => {
      hashes[key] = { ...(hashes[key] ?? {}), ...fields };
      return 1;
    },
    expire: async () => 1,
    incrbyfloat: async () => 0,
    sadd: async () => 1,
  } as unknown as Redis;
}

function mockFastify(query: QueryFn, redis: Redis): FastifyInstance {
  return {
    db: { query } as unknown as Pool,
    redis,
    log: { error: () => undefined, info: () => undefined },
  } as unknown as FastifyInstance;
}

const FIX = { lat: 51.5, lng: -0.12, heading: 90, speed_kph: 40, ts: Date.now() };

// ---------------------------------------------------------------------------
// A DM channel is not a convoy
//
// DM threads are convoy_groups rows (type='dm') with convoy_members entries, so
// the connect-time "what is this user's active group?" lookup happily returned
// one. Everything downstream then treated it as a convoy room.
// ---------------------------------------------------------------------------

describe('socket connect — DM channels must never resolve as the active convoy', () => {
  /**
   * DB double for a user whose ONLY convoy_members rows belong to a DM thread.
   * The pre-fix lookup (`SELECT group_id FROM convoy_members WHERE user_id=$1
   * AND left_at IS NULL LIMIT 1`) has no join, so it matches regardless of the
   * type filter — the fixture returns the DM row for the unfiltered form and
   * nothing for the joined form.
   */
  function dmOnlyMemberDb(shareWithFriends: boolean, log: { friendCacheWrites: number }): QueryFn {
    return async (sql) => {
      if (sql.includes('SELECT group_id')) {
        // Only the convoy-filtered query (which JOINs convoy_groups) finds nothing.
        return sql.includes('JOIN convoy_groups')
          ? { rows: [], rowCount: 0 }
          : { rows: [{ group_id: 'dm-group-1' }], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm-dm' }], rowCount: 1 };
      if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'dm' }], rowCount: 1 };
      if (sql.includes('share_location_with_friends')) {
        log.friendCacheWrites += 1;
        return { rows: [{ share_location_with_friends: shareWithFriends }], rowCount: 1 };
      }
      if (sql.includes('FROM convoy_groups g')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
  }

  it('does not broadcast a groupless user\'s location into their DM thread', async () => {
    const ioLog: Emission[] = [];
    const log = { friendCacheWrites: 0 };
    const handler = registerSocketHandlers(
      mockFastify(dmOnlyMemberDb(false, log), mockRedis()),
      buildMockIO(ioLog) as unknown as SocketIO,
    );
    // IdleMapScreen connects with a token and no groupId.
    const socket = new MockSocket('sock-dm', { userId: 'u-idle', groupId: '' });
    handler(socket as unknown as Socket);
    await flush();

    socket.trigger('location:update', FIX);
    await flush();
    await flush();

    expect(ioLog.filter((e) => e.event === 'location:update')).toHaveLength(0);
    expect(socket.rooms.has('group:dm-group-1')).toBe(false);
    // …and the convoy-only join broadcasts never went to the DM thread either.
    expect(ioLog.filter((e) => e.room === 'group:dm-group-1')).toHaveLength(0);
  });

  it('falls back to the opt-in-gated friend-location cache instead of the DM room', async () => {
    const log = { friendCacheWrites: 0 };
    const hashes: Record<string, Record<string, string>> = {};
    const handler = registerSocketHandlers(
      mockFastify(dmOnlyMemberDb(true, log), mockRedis(hashes)),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-dm-2', { userId: 'u-idle', groupId: '' });
    handler(socket as unknown as Socket);
    await flush();

    socket.trigger('location:update', FIX);
    await flush();
    await flush();

    // Pre-fix this branch was unreachable for anyone who had ever opened a DM,
    // so share_location_with_friends silently did nothing.
    expect(log.friendCacheWrites).toBe(1);
    expect(hashes['loc:friend:u-idle']).toMatchObject({ lat: '51.5', lng: '-0.12' });
  });

  it('degrades a handshake that names a DM channel to a groupless connection', async () => {
    const ioLog: Emission[] = [];
    const hashes: Record<string, Record<string, string>> = {};
    const query: QueryFn = async (sql) => {
      // Membership in the DM is genuine — the client just must not be allowed
      // to use it as a convoy room.
      if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm-dm' }], rowCount: 1 };
      if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'dm' }], rowCount: 1 };
      if (sql.includes('share_location_with_friends')) {
        return { rows: [{ share_location_with_friends: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const handler = registerSocketHandlers(
      mockFastify(query, mockRedis(hashes)),
      buildMockIO(ioLog) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-dm-3', { userId: 'u-spoof', groupId: 'dm-group-1' });
    handler(socket as unknown as Socket);
    await flush();

    socket.trigger('location:update', FIX);
    await flush();
    await flush();

    expect(socket.connected).toBe(true); // still a valid authenticated socket
    expect(socket.rooms.has('group:dm-group-1')).toBe(false);
    expect(ioLog.filter((e) => e.event === 'location:update')).toHaveLength(0);
    expect(hashes['loc:friend:u-spoof']).toBeDefined();
  });

  it('still resolves a real convoy for a user who also has DM threads', async () => {
    const ioLog: Emission[] = [];
    const query: QueryFn = async (sql) => {
      if (sql.includes('SELECT group_id')) return { rows: [{ group_id: 'g-real' }], rowCount: 1 };
      if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'group' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const handler = registerSocketHandlers(
      mockFastify(query, mockRedis()),
      buildMockIO(ioLog) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-real', { userId: 'u-driver', groupId: '' });
    handler(socket as unknown as Socket);
    await flush();

    socket.trigger('location:update', FIX);
    await flush();
    await flush();

    expect(socket.rooms.has('group:g-real')).toBe(true);
    const fanned = ioLog.filter((e) => e.event === 'location:update');
    expect(fanned).toHaveLength(1);
    expect(fanned[0].room).toBe('group:g-real');
  });
});

// ---------------------------------------------------------------------------
// presence:get — per-id authorization
// ---------------------------------------------------------------------------

describe('presence:get — only answers for users the viewer shares a context with', () => {
  const VIEWER = '11111111-1111-4111-8111-111111111111';
  const FRIEND = '22222222-2222-4222-8222-222222222222';
  const STRANGER = '33333333-3333-4333-8333-333333333333';

  /** DB double: VIEWER is friends with FRIEND and shares no group with anyone. */
  const relationshipDb: QueryFn = async (sql, params = []) => {
    if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm1' }], rowCount: 1 };
    if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'group' }], rowCount: 1 };
    if (sql.includes('unnest(')) {
      const candidates = (params[1] as string[]) ?? [];
      const visible = candidates.filter((id) => id === VIEWER || id === FRIEND);
      return { rows: visible.map((id) => ({ id })), rowCount: visible.length };
    }
    return { rows: [], rowCount: 0 };
  };

  it('filterVisiblePresenceIds drops non-uuid ids without querying', async () => {
    const query = jest.fn<Promise<QueryResult>, [string, unknown[]?]>();
    const visible = await filterVisiblePresenceIds(
      { query } as unknown as Pool,
      VIEWER,
      ['not-a-uuid', ''],
    );
    expect(visible.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a neutral offline entry for a stranger while still answering for a friend', async () => {
    // BOTH users are genuinely online in Redis — the stranger's real state is
    // exactly what must not come back.
    const redis = {
      ...(mockRedis() as unknown as Record<string, unknown>),
      mget: async (...keys: string[]) =>
        keys.map((k) =>
          k.startsWith('presence:online:')
            ? `sock-${k.slice('presence:online:'.length)}`
            : '2026-09-01T00:00:00.000Z',
        ),
    } as unknown as Redis;
    const handler = registerSocketHandlers(
      mockFastify(relationshipDb, redis),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-presence', { userId: VIEWER, groupId: 'g1' });
    handler(socket as unknown as Socket);
    await flush();

    const ack = jest.fn();
    socket.trigger('presence:get', { userIds: [FRIEND, STRANGER] }, ack);
    await flush();
    await flush();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual([
      { id: FRIEND, isOnline: true, lastSeen: '2026-09-01T00:00:00.000Z' },
      // Pre-fix the stranger's real online flag and last-seen timestamp came
      // straight back to any signed-in caller.
      { id: STRANGER, isOnline: false, lastSeen: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// chat:typing — the relayed name is the socket's identity, not the payload's
// ---------------------------------------------------------------------------

describe('chat:typing — the typing name comes from the DB, not the payload', () => {
  function typingHarness() {
    const userLookups: unknown[][] = [];
    const query: QueryFn = async (sql, params = []) => {
      if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'group' }], rowCount: 1 };
      if (sql.includes('SELECT display_name FROM users')) {
        userLookups.push(params);
        return { rows: [{ display_name: 'Real Rider' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const handler = registerSocketHandlers(
      mockFastify(query, mockRedis()),
      buildMockIO([]) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-typing', { userId: 'u-typer', groupId: 'g1' });
    handler(socket as unknown as Socket);
    return { socket, userLookups };
  }

  it('ignores a spoofed displayName and relays the sender\'s real name', async () => {
    const { socket } = typingHarness();
    await flush();

    socket.trigger('chat:typing', { groupId: 'g1', displayName: 'Admin' });
    await flush();
    await flush();

    const relays = socket.emissions.filter((e) => e.event === 'chat:typing');
    expect(relays).toHaveLength(1);
    expect(relays[0].room).toBe('group:g1');
    expect(relays[0].data).toEqual({
      userId: 'u-typer',
      displayName: 'Real Rider',
      groupId: 'g1',
    });
  });

  it('resolves the name once per socket rather than on every keystroke event', async () => {
    const { socket, userLookups } = typingHarness();
    await flush();

    for (let i = 0; i < 3; i++) {
      socket.trigger('chat:typing', { groupId: 'g1' });
      await flush();
      await flush();
    }

    expect(socket.emissions.filter((e) => e.event === 'chat:typing')).toHaveLength(3);
    expect(userLookups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// convoy:alert — payload validation
// ---------------------------------------------------------------------------

describe('convoy:alert — rejects payloads the shipped client never sends', () => {
  function alertFastify(captured: { relayed: Emission[]; inserts: unknown[][] }, ioLog: Emission[]) {
    const query: QueryFn = async (sql, params = []) => {
      if (sql.includes('SELECT id FROM convoy_members')) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (sql.includes('SELECT type FROM convoy_groups')) return { rows: [{ type: 'group' }], rowCount: 1 };
      if (sql.includes('SELECT ptt_callsign')) {
        return { rows: [{ ptt_callsign: 'Ghost', display_name: 'Ghost' }], rowCount: 1 };
      }
      if (sql.includes('SELECT user_id FROM convoy_members')) {
        return { rows: [{ user_id: 'victim-1' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO notification_history')) {
        captured.inserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    captured.relayed = ioLog;
    return mockFastify(query, mockRedis());
  }

  async function emitAlert(payload: unknown) {
    const ioLog: Emission[] = [];
    const captured = { relayed: ioLog, inserts: [] as unknown[][] };
    const handler = registerSocketHandlers(
      alertFastify(captured, ioLog),
      buildMockIO(ioLog) as unknown as SocketIO,
    );
    const socket = new MockSocket('sock-alert', { userId: 'u-alert', groupId: 'g1' });
    handler(socket as unknown as Socket);
    await flush();
    socket.trigger('convoy:alert', payload);
    await flush();
    await flush();
    await flush();
    return { alerts: ioLog.filter((e) => e.event === 'convoy:alert'), inserts: captured.inserts };
  }

  it('relays the alert types the client actually emits', async () => {
    for (const type of ['stopping', 'regroup', 'incident', 'sos', 'breakdown']) {
      const { alerts } = await emitAlert({ type, message: '🚦 Stopping', groupId: 'g1' });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].data).toMatchObject({ type, senderCallsign: 'Ghost' });
    }
  });

  it('drops an arbitrary alert type instead of writing it into every member\'s history', async () => {
    const { alerts, inserts } = await emitAlert({
      type: 'ADMIN: your account is suspended, tap to verify',
      message: 'https://evil.example',
      groupId: 'g1',
    });
    expect(alerts).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('drops an oversized message', async () => {
    const { alerts, inserts } = await emitAlert({
      type: 'incident',
      message: 'x'.repeat(CONVOY_ALERT_MAX_MESSAGE_CHARS + 1),
      groupId: 'g1',
    });
    expect(alerts).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
