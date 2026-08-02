/**
 * Unit tests for the live-convoy socket handlers that had no direct coverage:
 * presence ownership, hazard-proximity alerting, and the friend-location
 * privacy gate.
 *
 * The live smoke suite exercises these end to end against real Redis, but only
 * along the happy path. The cases that matter here are the adversarial ones —
 * a second device taking over presence, a stale socket disconnecting, a user
 * who never opted into location sharing — and those are cheaper and clearer to
 * pin down directly.
 */

import {
  setPresenceOnline,
  refreshPresence,
  setPresenceOffline,
  getPresence,
  getUserDmGroupIds,
  handleFriendLocationUpdate,
  handleHazardProximity,
  PRESENCE_ONLINE_TTL_SECONDS,
  PRESENCE_LASTSEEN_TTL_SECONDS,
} from './socket.handler';
import type { Pool } from 'pg';
import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// A small in-memory Redis covering exactly the commands these handlers use.
// ---------------------------------------------------------------------------

function makeRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();

  const redis = {
    set: async (k: string, v: string, _ex?: string, ttl?: number) => {
      strings.set(k, v);
      if (ttl) ttls.set(k, ttl);
      return 'OK';
    },
    get: async (k: string) => strings.get(k) ?? null,
    del: async (k: string) => { strings.delete(k); return 1; },
    mget: async (...keys: string[]) => keys.map((k) => strings.get(k) ?? null),
    sadd: async (k: string, member: string) => {
      const s = sets.get(k) ?? new Set<string>();
      const had = s.has(member);
      s.add(member);
      sets.set(k, s);
      return had ? 0 : 1; // Redis returns the number of NEW members
    },
    expire: async (k: string, ttl: number) => { ttls.set(k, ttl); return 1; },
    hset: async (k: string, fields: Record<string, string>) => {
      hashes.set(k, { ...(hashes.get(k) ?? {}), ...fields });
      return 1;
    },
  };

  return { redis: redis as unknown as Redis, strings, hashes, ttls };
}

const SOCKET_A = 'socket-a';
const SOCKET_B = 'socket-b';
const USER = 'user-1';

// ---------------------------------------------------------------------------

describe('presence ownership', () => {
  it('marks a user online with a heartbeat TTL and a last-seen stamp', async () => {
    const { redis, strings, ttls } = makeRedis();
    await setPresenceOnline(redis, USER, SOCKET_A, Date.parse('2026-08-01T10:00:00Z'));

    expect(strings.get(`presence:online:${USER}`)).toBe(SOCKET_A);
    expect(ttls.get(`presence:online:${USER}`)).toBe(PRESENCE_ONLINE_TTL_SECONDS);
    expect(strings.get(`presence:lastseen:${USER}`)).toBe('2026-08-01T10:00:00.000Z');
    expect(ttls.get(`presence:lastseen:${USER}`)).toBe(PRESENCE_LASTSEEN_TTL_SECONDS);
  });

  it('lets a heartbeat from the owning socket re-arm the TTL', async () => {
    const { redis, strings } = makeRedis();
    await setPresenceOnline(redis, USER, SOCKET_A);

    await refreshPresence(redis, USER, SOCKET_A);
    expect(strings.get(`presence:online:${USER}`)).toBe(SOCKET_A);
  });

  it('ignores a heartbeat from a socket a newer device has superseded', async () => {
    // Second phone connects and takes ownership; the first one's heartbeat is
    // still in flight and must not steal the key back.
    const { redis, strings } = makeRedis();
    await setPresenceOnline(redis, USER, SOCKET_A);
    await setPresenceOnline(redis, USER, SOCKET_B);

    await refreshPresence(redis, USER, SOCKET_A);

    expect(strings.get(`presence:online:${USER}`)).toBe(SOCKET_B);
  });

  it('re-establishes presence when the key expired but the socket is alive', async () => {
    const { redis, strings } = makeRedis();
    // No key at all — e.g. the node was unreachable long enough for the TTL to lapse.
    await refreshPresence(redis, USER, SOCKET_A);

    expect(strings.get(`presence:online:${USER}`)).toBe(SOCKET_A);
  });

  it('flips a user offline when the owning socket disconnects', async () => {
    const { redis, strings } = makeRedis();
    await setPresenceOnline(redis, USER, SOCKET_A);

    const transitioned = await setPresenceOffline(redis, USER, SOCKET_A, Date.parse('2026-08-01T11:00:00Z'));

    expect(transitioned).toBe(true);
    expect(strings.get(`presence:online:${USER}`)).toBeUndefined();
    expect(strings.get(`presence:lastseen:${USER}`)).toBe('2026-08-01T11:00:00.000Z');
  });

  it('does NOT flip a multi-device user offline when their old socket drops', async () => {
    // The regression this guard exists for: closing a tab, or a phone
    // reconnecting, previously showed the driver as offline to their convoy
    // while they were still connected on the newer socket.
    const { redis, strings } = makeRedis();
    await setPresenceOnline(redis, USER, SOCKET_A);
    await setPresenceOnline(redis, USER, SOCKET_B);

    const transitioned = await setPresenceOffline(redis, USER, SOCKET_A);

    expect(transitioned).toBe(false);
    expect(strings.get(`presence:online:${USER}`)).toBe(SOCKET_B);
  });

  it('reports online state and last-seen for a batch', async () => {
    const { redis } = makeRedis();
    await setPresenceOnline(redis, 'u1', SOCKET_A, Date.parse('2026-08-01T09:00:00Z'));
    await setPresenceOffline(redis, 'u2', 'nobody'); // never online: no-op

    expect(await getPresence(redis, ['u1', 'u2'])).toEqual([
      { id: 'u1', isOnline: true, lastSeen: '2026-08-01T09:00:00.000Z' },
      { id: 'u2', isOnline: false, lastSeen: null },
    ]);
  });

  it('returns nothing for an empty batch without calling Redis', async () => {
    const { redis } = makeRedis();
    const spy = jest.spyOn(redis, 'mget');
    expect(await getPresence(redis, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('caps a batch at 100 ids so one client cannot ask for the world', async () => {
    const { redis } = makeRedis();
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    expect(await getPresence(redis, ids)).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------

describe('friend location sharing is opt-in', () => {
  function makeDb(shareRow: { share_location_with_friends: boolean } | null): Pool {
    return { query: async () => ({ rows: shareRow ? [shareRow] : [], rowCount: shareRow ? 1 : 0 }) } as unknown as Pool;
  }

  const location = { lat: 51.5, lng: -0.12, heading: 90, speed_kph: 40, ts: 1_700_000_000_000 };

  it('caches the location when the user opted in', async () => {
    const { redis, hashes, ttls } = makeRedis();
    await handleFriendLocationUpdate({ userId: USER, location, redis, db: makeDb({ share_location_with_friends: true }) });

    expect(hashes.get(`loc:friend:${USER}`)).toMatchObject({ lat: '51.5', lng: '-0.12' });
    expect(ttls.get(`loc:friend:${USER}`)).toBeGreaterThan(0);
  });

  it('caches nothing when the user has not opted in', async () => {
    const { redis, hashes } = makeRedis();
    await handleFriendLocationUpdate({ userId: USER, location, redis, db: makeDb({ share_location_with_friends: false }) });

    expect(hashes.size).toBe(0);
  });

  it('defaults to off when the user has no settings row at all', async () => {
    // Never writing a location for a user we know nothing about is the whole
    // point — the absence of a row must not read as consent.
    const { redis, hashes } = makeRedis();
    await handleFriendLocationUpdate({ userId: USER, location, redis, db: makeDb(null) });

    expect(hashes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('hazard proximity alerts', () => {
  interface Emitted { room: string; event: string; payload: unknown }

  function harness(opts: {
    hazards: Array<{ id: string; hazard_type: string; lat: number; lng: number }>;
    alertDistanceM?: number | null;
  }) {
    const emitted: Emitted[] = [];
    const queued: Array<Record<string, unknown>> = [];
    const queries: unknown[][] = [];

    const db = {
      query: async (sql: string, params: unknown[]) => {
        queries.push(params);
        if (sql.includes('user_settings')) {
          return opts.alertDistanceM == null
            ? { rows: [], rowCount: 0 }
            : { rows: [{ hazard_alert_distance_m: opts.alertDistanceM }], rowCount: 1 };
        }
        return { rows: opts.hazards, rowCount: opts.hazards.length };
      },
    } as unknown as Pool;

    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); },
      }),
    };

    return { db, io, emitted, queued, queries,
      enqueueNotification: async (job: Record<string, unknown>) => { queued.push(job); } };
  }

  const HAZARD = { id: 'h1', hazard_type: 'speed_trap', lat: 51.5, lng: -0.12 };

  it('alerts the user in-app and by push for a nearby hazard', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: 805 });

    await handleHazardProximity({
      userId: USER, location: { lat: 51.5, lng: -0.12 },
      db: h.db, redis, io: h.io, enqueueNotification: h.enqueueNotification,
    });

    expect(h.emitted).toEqual([
      { room: `user:${USER}`, event: 'hazard:nearby', payload: { id: 'h1', type: 'speed_trap', lat: 51.5, lng: -0.12 } },
    ]);
    // The push title/body is user-facing: the type is de-underscored and
    // sentence-cased rather than shown raw as "speed_trap".
    expect(h.queued[0]).toMatchObject({ type: 'hazard_alert', body: 'Speed trap reported nearby' });
  });

  it('alerts only once per hazard per user, however often the driver moves', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: 805 });
    const call = () => handleHazardProximity({
      userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io,
    });

    await call();
    await call();
    await call();

    expect(h.emitted).toHaveLength(1);
  });

  it('alerts each distinct hazard separately', async () => {
    const { redis } = makeRedis();
    const h = harness({
      hazards: [HAZARD, { id: 'h2', hazard_type: 'pothole', lat: 51.51, lng: -0.13 }],
      alertDistanceM: 805,
    });

    await handleHazardProximity({ userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io });

    expect(h.emitted.map((e) => (e.payload as { id: string }).id)).toEqual(['h1', 'h2']);
  });

  it('does nothing when no hazard is in range', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [], alertDistanceM: 805 });

    await handleHazardProximity({ userId: USER, location: { lat: 0, lng: 0 }, db: h.db, redis, io: h.io });

    expect(h.emitted).toHaveLength(0);
  });

  it("uses the user's configured alert distance", async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: 3000 });

    await handleHazardProximity({ userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io });

    // Second query is the hazard lookup: [lng, lat, radius]
    expect(h.queries[1][2]).toBe(3000);
  });

  it('falls back to the default radius when the user has no settings row', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: null });

    await handleHazardProximity({ userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io });

    expect(h.queries[1][2]).toBe(805);
  });

  it('still shows the in-app banner when the push enqueue fails', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: 805 });

    await handleHazardProximity({
      userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io,
      enqueueNotification: async () => { throw new Error('queue down'); },
    });

    expect(h.emitted).toHaveLength(1);
  });

  it('works without a notification queue wired at all', async () => {
    const { redis } = makeRedis();
    const h = harness({ hazards: [HAZARD], alertDistanceM: 805 });

    await handleHazardProximity({ userId: USER, location: { lat: 51.5, lng: -0.12 }, db: h.db, redis, io: h.io });

    expect(h.emitted).toHaveLength(1);
    expect(h.queued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('getUserDmGroupIds', () => {
  it('returns the ids of DM channels the user has not left', async () => {
    const db = { query: async () => ({ rows: [{ id: 'dm-1' }, { id: 'dm-2' }], rowCount: 2 }) } as unknown as Pool;
    expect(await getUserDmGroupIds(db, USER)).toEqual(['dm-1', 'dm-2']);
  });

  it('returns an empty list for a user with no DMs', async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    expect(await getUserDmGroupIds(db, USER)).toEqual([]);
  });
});
