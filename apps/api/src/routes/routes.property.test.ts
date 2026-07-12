/**
 * Property 6: Route calculation returns 1 to 3 alternatives
 *   processMapboxRoutes() always caps the result at 3 regardless of how many
 *   Mapbox returns, and never returns more routes than were in the input.
 *   Validates: Requirement 6.1
 */

import fc from 'fast-check';
import {
  processMapboxRoutes,
  formatDistance,
  formatDuration,
  extractSpeedLimitKph,
  extractCongestionSegments,
  CongestionLevel,
} from './routes.routes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mapboxRouteArb = fc.record({
  distance: fc.float({ min: 100, max: 500_000, noNaN: true }),
  duration: fc.float({ min: 60, max: 36_000, noNaN: true }),
  geometry: fc.constant({ type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] as [number, number][] }),
});

// ---------------------------------------------------------------------------
// Property 6: Route count is always bounded to [0, 3]
// ---------------------------------------------------------------------------
describe('Property 6: Route calculation returns 1 to 3 alternatives', () => {
  it('for any number of Mapbox alternatives (0–10), output is at most 3', () => {
    fc.assert(
      fc.property(
        fc.array(mapboxRouteArb, { minLength: 0, maxLength: 10 }),
        (mapboxRoutes) => {
          const result = processMapboxRoutes(mapboxRoutes);
          expect(result.length).toBeLessThanOrEqual(3);
          expect(result.length).toBe(Math.min(mapboxRoutes.length, 3));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('when Mapbox returns exactly 1 route, response has exactly 1', () => {
    const result = processMapboxRoutes([
      { distance: 5000, duration: 300, geometry: { type: 'LineString', coordinates: [[0, 0]] as [number, number][] } },
    ]);
    expect(result).toHaveLength(1);
  });

  it('when Mapbox returns 5 alternatives, only the first 3 are returned', () => {
    const routes = Array.from({ length: 5 }, (_, i) => ({
      distance: (i + 1) * 1000,
      duration: (i + 1) * 60,
      geometry: { type: 'LineString' as const, coordinates: [[i, i]] as [number, number][] },
    }));
    const result = processMapboxRoutes(routes);
    expect(result).toHaveLength(3);
    expect(result[0].distance).toBe(1000);
    expect(result[2].distance).toBe(3000);
  });

  it('each returned route includes distanceText and durationText', () => {
    fc.assert(
      fc.property(
        fc.array(mapboxRouteArb, { minLength: 1, maxLength: 3 }),
        (routes) => {
          const result = processMapboxRoutes(routes);
          for (const r of result) {
            expect(typeof r.distanceText).toBe('string');
            expect(r.distanceText.length).toBeGreaterThan(0);
            expect(typeof r.durationText).toBe('string');
            expect(r.durationText.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('route order is preserved (first Mapbox route is first result)', () => {
    fc.assert(
      fc.property(
        fc.array(mapboxRouteArb, { minLength: 2, maxLength: 6 }),
        (routes) => {
          const result = processMapboxRoutes(routes);
          for (let i = 0; i < result.length; i++) {
            expect(result[i].distance).toBe(routes[i].distance);
            expect(result[i].duration).toBe(routes[i].duration);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6b: extractSpeedLimitKph (Req 23)
// ---------------------------------------------------------------------------
describe('extractSpeedLimitKph', () => {
  it('returns null when legs is undefined', () => {
    expect(extractSpeedLimitKph(undefined)).toBeNull();
  });

  it('returns null when all entries are unknown', () => {
    expect(extractSpeedLimitKph([{ annotation: { maxspeed: [{ unknown: true }, { unknown: true }] } }])).toBeNull();
  });

  it('returns the modal speed limit in kph', () => {
    const legs = [{ annotation: { maxspeed: [
      { speed: 50, unit: 'km/h' },
      { speed: 50, unit: 'km/h' },
      { speed: 80, unit: 'km/h' },
    ] } }];
    expect(extractSpeedLimitKph(legs)).toBe(50);
  });

  it('converts mph to kph', () => {
    const legs = [{ annotation: { maxspeed: [{ speed: 55, unit: 'mph' }] } }];
    const result = extractSpeedLimitKph(legs);
    expect(result).toBeGreaterThan(80);  // 55 mph ≈ 88 kph
    expect(result).toBeLessThan(95);
  });

  it('property: result is always null or a positive number', () => {
    const maxspeedEntryArb = fc.oneof(
      fc.constant({ unknown: true }),
      fc.record({ speed: fc.integer({ min: 10, max: 200 }), unit: fc.constantFrom('km/h', 'mph') }),
    );
    const legsArb = fc.array(
      fc.record({ annotation: fc.record({ maxspeed: fc.array(maxspeedEntryArb, { maxLength: 10 }) }) }),
      { maxLength: 3 },
    );
    fc.assert(
      fc.property(legsArb, (legs) => {
        const result = extractSpeedLimitKph(legs);
        if (result !== null) {
          expect(result).toBeGreaterThan(0);
          expect(Number.isFinite(result)).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Req 6.2: extractCongestionSegments — per-segment traffic congestion
// ---------------------------------------------------------------------------
describe('extractCongestionSegments (Req 6.2)', () => {
  it('returns [] when legs is undefined or empty', () => {
    expect(extractCongestionSegments(undefined)).toEqual([]);
    expect(extractCongestionSegments([])).toEqual([]);
  });

  it('returns [] when the congestion annotation is absent (Mapbox omitted it)', () => {
    expect(extractCongestionSegments([{ annotation: { maxspeed: [{ speed: 50, unit: 'km/h' }] } }])).toEqual([]);
    expect(extractCongestionSegments([{ annotation: {} }, {}])).toEqual([]);
  });

  it('passes through the five Mapbox levels verbatim, in order', () => {
    const legs = [{ annotation: { congestion: ['low', 'moderate', 'heavy', 'severe', 'unknown'] } }];
    expect(extractCongestionSegments(legs)).toEqual(['low', 'moderate', 'heavy', 'severe', 'unknown']);
  });

  it('concatenates congestion across legs in leg order', () => {
    const legs = [
      { annotation: { congestion: ['low', 'low'] } },
      { annotation: { congestion: ['severe'] } },
    ];
    expect(extractCongestionSegments(legs)).toEqual(['low', 'low', 'severe']);
  });

  it('normalises unrecognised values to "unknown"', () => {
    const legs = [{ annotation: { congestion: ['low', 'gridlock', '', 'HEAVY'] } }];
    expect(extractCongestionSegments(legs)).toEqual(['low', 'unknown', 'unknown', 'unknown']);
  });

  it('property: output length equals total annotation entries and every value is a valid level', () => {
    const validLevels: CongestionLevel[] = ['low', 'moderate', 'heavy', 'severe', 'unknown'];
    const congestionArb = fc.array(
      fc.oneof(fc.constantFrom(...validLevels), fc.string({ maxLength: 10 })),
      { maxLength: 20 },
    );
    const legsArb = fc.array(
      fc.record({ annotation: fc.record({ congestion: congestionArb }) }),
      { maxLength: 4 },
    );
    fc.assert(
      fc.property(legsArb, (legs) => {
        const result = extractCongestionSegments(legs);
        const totalEntries = legs.reduce((n, l) => n + l.annotation.congestion.length, 0);
        expect(result).toHaveLength(totalEntries);
        for (const level of result) expect(validLevels).toContain(level);
      }),
      { numRuns: 50 },
    );
  });
});

describe('processMapboxRoutes carries congestionSegments (Req 6.2)', () => {
  it('surfaces congestion aligned with geometry: N coordinates → N-1 segments', () => {
    const coordinates: [number, number][] = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const congestion = ['low', 'heavy', 'severe'];  // one per coordinate pair
    const [route] = processMapboxRoutes([{
      distance: 1000,
      duration: 60,
      geometry: { type: 'LineString', coordinates },
      legs: [{ annotation: { congestion } }],
    }]);
    expect(route.congestionSegments).toEqual(['low', 'heavy', 'severe']);
    expect(route.congestionSegments).toHaveLength(route.geometry.coordinates.length - 1);
  });

  it('routes without any legs/annotation get an empty congestionSegments (backward compatible)', () => {
    const [route] = processMapboxRoutes([{
      distance: 1000,
      duration: 60,
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] as [number, number][] },
    }]);
    expect(route.congestionSegments).toEqual([]);
  });

  it('congestion and speed-limit segments stay index-aligned (same leg concatenation)', () => {
    const legs = [
      { annotation: { maxspeed: [{ speed: 50, unit: 'km/h' }, { unknown: true }], congestion: ['low', 'severe'] } },
      { annotation: { maxspeed: [{ speed: 30, unit: 'km/h' }], congestion: ['moderate'] } },
    ];
    const [route] = processMapboxRoutes([{
      distance: 1000,
      duration: 60,
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2], [3, 3]] as [number, number][] },
      legs,
    }]);
    expect(route.speedLimitSegmentsKph).toEqual([50, null, 30]);
    expect(route.congestionSegments).toEqual(['low', 'severe', 'moderate']);
    expect(route.congestionSegments.length).toBe(route.speedLimitSegmentsKph.length);
  });
});

// ---------------------------------------------------------------------------
// Sanity tests for pure formatting helpers
// ---------------------------------------------------------------------------
describe('formatDistance', () => {
  it('returns metres for < 1000 m', () => {
    expect(formatDistance(500)).toBe('500 m');
  });

  it('returns km for >= 1000 m', () => {
    expect(formatDistance(1500)).toBe('1.5 km');
  });
});

describe('formatDuration', () => {
  it('returns minutes for < 1 h', () => {
    expect(formatDuration(600)).toBe('10 min');
  });

  it('returns hours and minutes for >= 1 h', () => {
    expect(formatDuration(3900)).toBe('1 h 5 min');
  });
});
