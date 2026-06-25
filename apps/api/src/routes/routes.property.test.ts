/**
 * Property 6: Route calculation returns 1 to 3 alternatives
 *   processMapboxRoutes() always caps the result at 3 regardless of how many
 *   Mapbox returns, and never returns more routes than were in the input.
 *   Validates: Requirement 6.1
 */

import fc from 'fast-check';
import { processMapboxRoutes, formatDistance, formatDuration, extractSpeedLimitKph } from './routes.routes';

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
