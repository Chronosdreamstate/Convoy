/**
 * Property + example tests for the shared haversine helper.
 *
 * Covers:
 *  - distance is always finite and non-negative
 *  - distance is symmetric in its endpoints
 *  - identical points are 0 m apart
 *  - 1 degree of latitude is ~111.2 km
 *  - known city-pair distance (SF -> LA) within 1% of the reference value
 *  - antipodal points never exceed half the Earth's circumference
 */

import fc from 'fast-check';
import { haversineDistanceM } from './geo';

const latArb = fc.double({ min: -90, max: 90, noNaN: true });
const lngArb = fc.double({ min: -180, max: 180, noNaN: true });
const pointArb = fc.tuple(latArb, lngArb);

const EARTH_HALF_CIRCUMFERENCE_M = Math.PI * 6_371_000;

describe('haversineDistanceM — invariants', () => {
  it('is always finite and non-negative', () => {
    fc.assert(
      fc.property(pointArb, pointArb, ([lat1, lng1], [lat2, lng2]) => {
        const d = haversineDistanceM(lat1, lng1, lat2, lng2);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('is symmetric: d(a, b) === d(b, a)', () => {
    fc.assert(
      fc.property(pointArb, pointArb, ([lat1, lng1], [lat2, lng2]) => {
        const ab = haversineDistanceM(lat1, lng1, lat2, lng2);
        const ba = haversineDistanceM(lat2, lng2, lat1, lng1);
        expect(ab).toBeCloseTo(ba, 6);
      }),
      { numRuns: 200 },
    );
  });

  it('returns 0 for identical points', () => {
    fc.assert(
      fc.property(pointArb, ([lat, lng]) => {
        expect(haversineDistanceM(lat, lng, lat, lng)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('never exceeds half the Earth\'s circumference', () => {
    fc.assert(
      fc.property(pointArb, pointArb, ([lat1, lng1], [lat2, lng2]) => {
        const d = haversineDistanceM(lat1, lng1, lat2, lng2);
        expect(d).toBeLessThanOrEqual(EARTH_HALF_CIRCUMFERENCE_M + 1);
      }),
      { numRuns: 200 },
    );
  });
});

describe('haversineDistanceM — known distances', () => {
  it('1 degree of latitude is ~111.2 km', () => {
    const d = haversineDistanceM(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_500);
  });

  it('San Francisco -> Los Angeles is ~559 km (within 1%)', () => {
    // Reference great-circle distance: ~559 km
    const d = haversineDistanceM(37.7749, -122.4194, 34.0522, -118.2437);
    expect(d).toBeGreaterThan(559_000 * 0.99);
    expect(d).toBeLessThan(559_000 * 1.01);
  });

  it('antipodal points on the equator are half the circumference apart', () => {
    const d = haversineDistanceM(0, 0, 0, 180);
    expect(d).toBeCloseTo(EARTH_HALF_CIRCUMFERENCE_M, -3); // within ~1 km
  });
});
