/**
 * Property 13: Location broadcast interval is at most 3 seconds
 *   For any sequence of GPS updates at 1 Hz or faster, the service emits
 *   to the socket at most once per 3-second window.
 *   Validates: Requirements 8.1, 8.2
 *
 * Property 14: Offline cache preserves last-known Member positions
 *   For any sequence of location updates for a given member,
 *   the SQLite store contains the latest position after all updates complete.
 *   Validates: Requirements 8.6, 14.3
 */

import fc from 'fast-check';
import { LocationService, LocationData, ILocationDB } from './LocationService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class InMemoryLocationDB implements ILocationDB {
  readonly store = new Map<string, LocationData>();

  async init(): Promise<void> {}

  async saveLastKnownLocation(userId: string, location: LocationData): Promise<void> {
    this.store.set(userId, location);
  }

  async getAllLastKnownLocations(): Promise<Map<string, LocationData>> {
    return new Map(this.store);
  }
}

function buildMockSocket(emitLog: LocationData[]) {
  return {
    connected: true,
    emit: (_event: string, data: LocationData) => {
      emitLog.push(data);
    },
  };
}

// ---------------------------------------------------------------------------
// Property 13: Location broadcast interval ≤ 3 seconds
// ---------------------------------------------------------------------------
describe('Property 13: Location broadcast interval is at most 3 seconds', () => {
  it('for any GPS event timestamps, emits happen at most once per 3-second window', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 5–20 GPS event timestamps in ms, sorted ascending
        fc
          .array(fc.integer({ min: 1, max: 30_000 }), { minLength: 5, maxLength: 20 })
          .map((offsets) =>
            offsets
              .reduce<number[]>((acc, d) => {
                acc.push((acc[acc.length - 1] ?? 0) + Math.max(d, 1));
                return acc;
              }, [])
          ),
        async (timestamps) => {
          const emitLog: LocationData[] = [];
          const db = new InMemoryLocationDB();
          const service = new LocationService(buildMockSocket(emitLog), db, 'user-1');

          for (const ts of timestamps) {
            await service.handleGPSUpdate({
              lat: 0,
              lng: 0,
              heading: 0,
              speed_kph: 0,
              ts,
            });
          }

          // Consecutive emit timestamps must be at least 3000 ms apart
          for (let i = 1; i < emitLog.length; i++) {
            const gap = emitLog[i].ts - emitLog[i - 1].ts;
            expect(gap).toBeGreaterThanOrEqual(3_000);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('for N GPS events spaced exactly 1s apart over 10s, at most 4 emits occur', async () => {
    const emitLog: LocationData[] = [];
    const db = new InMemoryLocationDB();
    const service = new LocationService(buildMockSocket(emitLog), db, 'user-2');

    // 10 events at t=0, 1000, 2000, ... 9000 ms
    for (let i = 0; i < 10; i++) {
      await service.handleGPSUpdate({ lat: 0, lng: 0, heading: 0, speed_kph: 0, ts: i * 1_000 });
    }

    // With 3s throttle: fires at t=0, t=3000, t=6000, t=9000 → 4 emits maximum
    expect(emitLog.length).toBeLessThanOrEqual(4);
    expect(emitLog.length).toBeGreaterThanOrEqual(1);
  });

  it('shouldThrottle returns false exactly once per 3s window', () => {
    const service = new LocationService(
      { connected: true, emit: () => {} },
      new InMemoryLocationDB(),
      'user-3',
    );

    // t=0: first call — should NOT throttle (first emit)
    expect(service.shouldThrottle(0)).toBe(false);
    // t=1000: < 3s since last — throttle
    expect(service.shouldThrottle(1_000)).toBe(true);
    // t=2999: still < 3s — throttle
    expect(service.shouldThrottle(2_999)).toBe(true);
    // t=3000: exactly 3s — should NOT throttle (new window)
    expect(service.shouldThrottle(3_000)).toBe(false);
    // t=3001: < 3s since last — throttle
    expect(service.shouldThrottle(3_001)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 14: Offline cache preserves last-known positions
// ---------------------------------------------------------------------------
describe('Property 14: Offline cache preserves last-known Member positions', () => {
  it('for any ordered sequence of updates, the cache holds the last one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }), // userId
        // 2–10 updates with strictly increasing timestamps
        fc
          .array(
            fc.record({
              lat: fc.float({ min: -89, max: 89, noNaN: true }),
              lng: fc.float({ min: -179, max: 179, noNaN: true }),
              heading: fc.float({ min: 0, max: 360, noNaN: true }),
              speed_kph: fc.float({ min: 0, max: 200, noNaN: true }),
            }),
            { minLength: 2, maxLength: 10 },
          )
          .map((updates) =>
            updates.map((u, i) => ({ ...u, ts: 1_700_000_000 + i * 1_000 })),
          ),
        async (userId, updates) => {
          const db = new InMemoryLocationDB();
          await db.init();
          const service = new LocationService(
            { connected: false, emit: () => {} },
            db,
            userId,
          );

          for (const update of updates) {
            await service.handleGPSUpdate(update);
          }

          const stored = db.store.get(userId);
          const last = updates[updates.length - 1];

          expect(stored).toBeDefined();
          expect(stored!.lat).toBeCloseTo(last.lat, 5);
          expect(stored!.lng).toBeCloseTo(last.lng, 5);
          expect(stored!.ts).toBe(last.ts);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('cache retains all members independently', async () => {
    const db = new InMemoryLocationDB();
    await db.init();

    const memberA = 'member-a';
    const memberB = 'member-b';

    const serviceA = new LocationService({ connected: false, emit: () => {} }, db, memberA);
    const serviceB = new LocationService({ connected: false, emit: () => {} }, db, memberB);

    await serviceA.handleGPSUpdate({ lat: 10, lng: 20, heading: 90, speed_kph: 50, ts: 1000 });
    await serviceB.handleGPSUpdate({ lat: 30, lng: 40, heading: 180, speed_kph: 70, ts: 2000 });

    // Override A with newer position
    await serviceA.handleGPSUpdate({ lat: 11, lng: 21, heading: 95, speed_kph: 55, ts: 3000 });

    const locA = db.store.get(memberA)!;
    const locB = db.store.get(memberB)!;

    // A has latest position
    expect(locA.lat).toBeCloseTo(11, 5);
    expect(locA.ts).toBe(3000);

    // B's entry is unaffected
    expect(locB.lat).toBeCloseTo(30, 5);
    expect(locB.ts).toBe(2000);
  });
});
