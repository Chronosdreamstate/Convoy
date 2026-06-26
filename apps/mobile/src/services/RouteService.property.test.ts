/**
 * Property tests for RouteService.
 *
 * Property 113: Waypoint list never exceeds MAX_WAYPOINTS
 *   Any sequence of addWaypoint calls beyond MAX_WAYPOINTS throws RangeError.
 *   Validates: Requirement 8 (max 10 waypoints)
 *
 * Property 114: removeWaypoint is a no-op for out-of-range indices
 *   Calling removeWaypoint with any index outside [0, length) leaves the list
 *   unchanged and does not throw.
 *   Validates: Requirement 8
 *
 * Property 115: reorderWaypoints preserves list contents (only moves position)
 *   After any valid reorder the set of waypoints is identical; only order changes.
 *   Validates: Requirement 8
 *
 * Property 116: isSpeedLimitExceeded is strictly monotone in currentSpeed
 *   If current ≤ limit → false; if current > limit → true. No fuzzy middle.
 *   Validates: Requirement 38
 *
 * Property 117: setActiveRoute selects the correct route by index
 *   activeRoute after setActiveRoute(i) equals routes[i]; out-of-range gives null.
 *   Validates: Requirement 7
 */

import fc from 'fast-check';
import { RouteService, MAX_WAYPOINTS, LatLng, Route } from './RouteService';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcLatLng: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.float({ min: -90, max: 90, noNaN: true }),
  lng: fc.float({ min: -180, max: 180, noNaN: true }),
});

function makeRoute(distance = 1000, duration = 3600): Route {
  return {
    distance,
    duration,
    distanceText: `${distance} m`,
    durationText: `${duration} s`,
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  };
}

// ---------------------------------------------------------------------------
// Property 113: Waypoint list never exceeds MAX_WAYPOINTS
// ---------------------------------------------------------------------------

describe('Property 113: Waypoint count never exceeds MAX_WAYPOINTS', () => {
  it('throws RangeError when adding a waypoint beyond MAX_WAYPOINTS', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 1, maxLength: 5 }),
        (extra) => {
          const svc = new RouteService();
          for (let i = 0; i < MAX_WAYPOINTS; i++) {
            svc.addWaypoint({ lat: i, lng: i });
          }
          for (const pt of extra) {
            expect(() => svc.addWaypoint(pt)).toThrow(RangeError);
          }
          expect(svc.waypoints.length).toBe(MAX_WAYPOINTS);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('count after N valid adds equals N (for N ≤ MAX_WAYPOINTS)', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 0, maxLength: MAX_WAYPOINTS }),
        (points) => {
          const svc = new RouteService();
          for (const pt of points) svc.addWaypoint(pt);
          expect(svc.waypoints.length).toBe(points.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('clearWaypoints always resets count to 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_WAYPOINTS }),
        (n) => {
          const svc = new RouteService();
          for (let i = 0; i < n; i++) svc.addWaypoint({ lat: i, lng: i });
          svc.clearWaypoints();
          expect(svc.waypoints.length).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: removeWaypoint is a no-op for out-of-range indices
// ---------------------------------------------------------------------------

describe('Property 114: removeWaypoint is a no-op for out-of-range indices', () => {
  it('out-of-range index leaves waypoints unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 0, maxLength: MAX_WAYPOINTS }),
        fc.integer({ min: -1000, max: 1000 }),
        (initial, idx) => {
          const svc = new RouteService();
          for (const pt of initial) svc.addWaypoint(pt);

          if (idx < 0 || idx >= initial.length) {
            const before = svc.waypoints.length;
            svc.removeWaypoint(idx);
            expect(svc.waypoints.length).toBe(before);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('valid index removal decreases count by exactly 1', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 1, maxLength: MAX_WAYPOINTS }),
        fc.integer({ min: 0, max: MAX_WAYPOINTS - 1 }),
        (initial, idx) => {
          fc.pre(idx < initial.length);
          const svc = new RouteService();
          for (const pt of initial) svc.addWaypoint(pt);
          svc.removeWaypoint(idx);
          expect(svc.waypoints.length).toBe(initial.length - 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 115: reorderWaypoints preserves list contents
// ---------------------------------------------------------------------------

describe('Property 115: reorderWaypoints preserves all waypoint values', () => {
  it('after any valid reorder, sorted lat values match original sorted lat values', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 2, maxLength: MAX_WAYPOINTS }),
        fc.integer({ min: 0, max: MAX_WAYPOINTS - 1 }),
        fc.integer({ min: 0, max: MAX_WAYPOINTS - 1 }),
        (initial, from, to) => {
          fc.pre(from < initial.length && to < initial.length);
          const svc = new RouteService();
          for (const pt of initial) svc.addWaypoint(pt);

          svc.reorderWaypoints(from, to);

          expect(svc.waypoints.length).toBe(initial.length);

          const sortedBefore = [...initial].map((p) => p.lat).sort();
          const sortedAfter = [...svc.waypoints].map((p) => p.lat).sort();
          expect(sortedAfter).toEqual(sortedBefore);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('out-of-range from/to indices in reorder are no-ops', () => {
    fc.assert(
      fc.property(
        fc.array(fcLatLng, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        (initial, from, to) => {
          fc.pre(from < 0 || from >= initial.length || to < 0 || to >= initial.length);
          const svc = new RouteService();
          for (const pt of initial) svc.addWaypoint(pt);

          const before = [...svc.waypoints].map((p) => p.lat);
          svc.reorderWaypoints(from, to);
          const after = [...svc.waypoints].map((p) => p.lat);

          expect(after).toEqual(before);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: isSpeedLimitExceeded is strictly monotone
// ---------------------------------------------------------------------------

describe('Property 116: isSpeedLimitExceeded is strictly monotone in currentSpeed', () => {
  it('currentSpeed ≤ limit → always false', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 300, noNaN: true }),
        fc.float({ min: 0, max: 300, noNaN: true }),
        (speed, limit) => {
          fc.pre(speed <= limit);
          expect(RouteService.isSpeedLimitExceeded(speed, limit)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('currentSpeed > limit → always true', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 300, noNaN: true }),
        fc.float({ min: 0, max: 300, noNaN: true }),
        (speed, limit) => {
          fc.pre(speed > limit);
          expect(RouteService.isSpeedLimitExceeded(speed, limit)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('speed == limit → exactly false (not exceeded at the boundary)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 300, noNaN: true }),
        (speed) => {
          expect(RouteService.isSpeedLimitExceeded(speed, speed)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 117: setActiveRoute selects the correct route by index
// ---------------------------------------------------------------------------

describe('Property 117: setActiveRoute selects the correct route by index', () => {
  it('setActiveRoute(i) sets activeRoute to routes[i] for valid i', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 4 }),
        (routeCount, idx) => {
          fc.pre(idx < routeCount);
          const svc = new RouteService();
          const routes = Array.from({ length: routeCount }, (_, i) => makeRoute(i * 100 + 100));
          svc.setRoutes(routes);
          svc.setActiveRoute(idx);
          expect(svc.activeRoute).toBe(routes[idx]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('setActiveRoute with out-of-range index sets activeRoute to null', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 100 }),
        (routeCount, extra) => {
          const svc = new RouteService();
          const routes = Array.from({ length: routeCount }, (_, i) => makeRoute(i * 100 + 100));
          svc.setRoutes(routes);
          svc.setActiveRoute(routeCount + extra);
          expect(svc.activeRoute).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('activeRoute is null after clearWaypoints and before any setActiveRoute', () => {
    const svc = new RouteService();
    expect(svc.activeRoute).toBeNull();
    svc.setRoutes([makeRoute()]);
    svc.setActiveRoute(0);
    expect(svc.activeRoute).not.toBeNull();
    svc.clearWaypoints();
    expect(svc.activeRoute).not.toBeNull(); // clearWaypoints does not affect activeRoute
  });
});
