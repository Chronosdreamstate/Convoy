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
import { handleLocationUpdate, haversineMeters, IoBroadcaster, LocationPayload } from './socket.handler';

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

function buildMockRedis(store: Record<string, Record<string, string>>): Redis {
  return {
    hset: async (key: string, fields: Record<string, string>) => {
      store[key] = { ...(store[key] ?? {}), ...fields };
      return Object.keys(fields).length;
    },
    expire: async () => 1,
    hgetall: async (key: string) => store[key] ?? null,
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
