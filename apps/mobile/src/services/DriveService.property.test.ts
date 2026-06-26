/**
 * Property tests for DriveService pure helpers.
 *
 * Property 85: haversineDistanceM is always non-negative
 *   Validates: Requirements 19.1
 *
 * Property 86: haversineDistanceM is symmetric
 *   Validates: Requirements 19.1
 *
 * Property 87: computeDriveStats returns null for fewer than 2 points
 *   Validates: Requirements 19.1
 *
 * Property 88: computeDriveStats distanceM equals sum of per-leg haversines
 *   Validates: Requirements 19.1
 *
 * Property 89: computeDriveStats durationS equals (last.ts - first.ts) / 1000
 *   Validates: Requirements 19.1
 *
 * Property 90: computeDriveStats topSpeedKph is null when all speeds are zero
 *   Validates: Requirements 19.1
 */

import fc from 'fast-check';
import {
  haversineDistanceM,
  computeDriveStats,
  TrackPoint,
} from './DriveService';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const latArb = fc.float({ min: Math.fround(-89.999), max: Math.fround(89.999), noNaN: true });
const lngArb = fc.float({ min: Math.fround(-179.999), max: Math.fround(179.999), noNaN: true });
const speedArb = fc.float({ min: 0, max: Math.fround(250), noNaN: true });

function makePoint(lat: number, lng: number, speedKph: number, ts: number): TrackPoint {
  return { lat, lng, speedKph, ts };
}

// ---------------------------------------------------------------------------
// Property 85: haversineDistanceM is always non-negative
// ---------------------------------------------------------------------------
describe('Property 85: haversineDistanceM is always non-negative', () => {
  it('distance between any two points is >= 0', () => {
    fc.assert(
      fc.property(latArb, lngArb, latArb, lngArb, (lat1, lng1, lat2, lng2) => {
        expect(haversineDistanceM(lat1, lng1, lat2, lng2)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('distance from a point to itself is 0', () => {
    fc.assert(
      fc.property(latArb, lngArb, (lat, lng) => {
        expect(haversineDistanceM(lat, lng, lat, lng)).toBe(0);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 86: haversineDistanceM is symmetric
// ---------------------------------------------------------------------------
describe('Property 86: haversineDistanceM is symmetric', () => {
  it('d(A, B) === d(B, A) for any two points', () => {
    fc.assert(
      fc.property(latArb, lngArb, latArb, lngArb, (lat1, lng1, lat2, lng2) => {
        const fwd = haversineDistanceM(lat1, lng1, lat2, lng2);
        const rev = haversineDistanceM(lat2, lng2, lat1, lng1);
        expect(fwd).toBeCloseTo(rev, 6);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 87: computeDriveStats returns null for < 2 points
// ---------------------------------------------------------------------------
describe('Property 87: computeDriveStats returns null for < 2 track points', () => {
  it('returns null for empty array', () => {
    expect(computeDriveStats([])).toBeNull();
  });

  it('returns null for exactly 1 point', () => {
    expect(computeDriveStats([makePoint(0, 0, 0, 0)])).toBeNull();
  });

  it('returns non-null for 2 or more points', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(latArb, lngArb, speedArb, fc.integer({ min: 0, max: 1_000_000 })),
          { minLength: 2, maxLength: 20 },
        ),
        (tuples) => {
          const points: TrackPoint[] = tuples.map(([lat, lng, spd, ts]) =>
            makePoint(lat, lng, spd, ts),
          );
          expect(computeDriveStats(points)).not.toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 88: distanceM equals sum of per-leg haversines
// ---------------------------------------------------------------------------
describe('Property 88: computeDriveStats.distanceM equals sum of consecutive haversines', () => {
  it('distanceM matches manual leg-sum for any point sequence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(latArb, lngArb, speedArb, fc.integer({ min: 0, max: 1_000_000 })),
          { minLength: 2, maxLength: 15 },
        ),
        (tuples) => {
          const points: TrackPoint[] = tuples.map(([lat, lng, spd, ts]) =>
            makePoint(lat, lng, spd, ts),
          );

          let manualDistanceM = 0;
          for (let i = 1; i < points.length; i++) {
            manualDistanceM += haversineDistanceM(
              points[i - 1].lat, points[i - 1].lng,
              points[i].lat, points[i].lng,
            );
          }

          const stats = computeDriveStats(points);
          expect(stats!.distanceM).toBe(Math.round(manualDistanceM));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 89: durationS equals (last.ts - first.ts) / 1000 (rounded)
// ---------------------------------------------------------------------------
describe('Property 89: computeDriveStats.durationS matches timestamp span', () => {
  it('durationS is Math.round((last.ts - first.ts) / 1000)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),    // first ts
        fc.integer({ min: 1, max: 7_200_000 }),         // duration in ms
        fc.integer({ min: 1, max: 5 }),                 // extra middle points
        (firstTs, durationMs, midCount) => {
          const lastTs = firstTs + durationMs;
          const points: TrackPoint[] = [
            makePoint(0, 0, 30, firstTs),
            ...Array.from({ length: midCount }, (_, i) =>
              makePoint(0.001 * (i + 1), 0, 30, firstTs + (durationMs * (i + 1)) / (midCount + 1)),
            ),
            makePoint(0.1, 0, 30, lastTs),
          ];

          const stats = computeDriveStats(points);
          const expected = Math.round(durationMs / 1000);
          expect(stats!.durationS).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 90: topSpeedKph is null when all speeds are zero
// ---------------------------------------------------------------------------
describe('Property 90: computeDriveStats.topSpeedKph is null when all speeds are 0', () => {
  it('topSpeedKph is null when every track point has speedKph = 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(latArb, lngArb, fc.integer({ min: 0, max: 1_000_000 })),
          { minLength: 2, maxLength: 10 },
        ),
        (tuples) => {
          const points: TrackPoint[] = tuples.map(([lat, lng, ts]) =>
            makePoint(lat, lng, 0, ts), // speed is always 0
          );
          const stats = computeDriveStats(points);
          expect(stats!.topSpeedKph).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('topSpeedKph is non-null when at least one speed > 0', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.1), max: Math.fround(250), noNaN: true }),
        (positiveSpeed) => {
          const points: TrackPoint[] = [
            makePoint(0, 0, positiveSpeed, 0),
            makePoint(0.01, 0, 0, 60_000),
          ];
          const stats = computeDriveStats(points);
          expect(stats!.topSpeedKph).not.toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });
});
