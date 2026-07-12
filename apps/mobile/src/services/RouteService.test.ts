/**
 * Unit tests for the fuel-stop → route-waypoint accept path (Req 21.3):
 *
 *  - buildFuelStopRouteRequest threads the station into the recalculation
 *    request as a ROUTE WAYPOINT (origin → …waypoints → station → destination),
 *    falls back to routing TO the station when no destination is active, and
 *    enforces the MAX_WAYPOINTS cap like addWaypoint.
 *  - applyFuelStopWaypoint recalculates via POST /routes/calculate and pushes
 *    the fastest alternative through POST /groups/:id/route (the standard
 *    route:pushed broadcast) — never creating a rally point — and pushes
 *    nothing when no route exists through the station.
 */

import {
  applyFuelStopWaypoint,
  buildFuelStopRouteRequest,
  CalculatedRoute,
  LatLng,
  MAX_WAYPOINTS,
} from './RouteService';
import { apiClient } from './apiClient';

// ---------------------------------------------------------------------------
// Mock apiClient at module level
// ---------------------------------------------------------------------------

jest.mock('./apiClient');

const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN: LatLng = { lat: -33.8, lng: 151.2 };
const STATION: LatLng = { lat: -33.81, lng: 151.21 };
const DESTINATION: LatLng = { lat: -33.9, lng: 151.3 };

const ROUTE: CalculatedRoute = {
  distance: 12_000,
  duration: 900,
  distanceText: '12.0 km',
  durationText: '15 min',
  geometry: { type: 'LineString', coordinates: [[151.2, -33.8], [151.21, -33.81], [151.3, -33.9]] },
  speedLimitKph: 60,
  speedLimitSegmentsKph: [60, 50],
  congestionSegments: ['low', 'moderate'],
};

// ---------------------------------------------------------------------------
// buildFuelStopRouteRequest
// ---------------------------------------------------------------------------

describe('buildFuelStopRouteRequest (Req 21.3)', () => {
  it('appends the station to the existing waypoints, keeping the destination', () => {
    const existing: LatLng[] = [{ lat: -33.85, lng: 151.25 }];
    const body = buildFuelStopRouteRequest({
      origin: ORIGIN,
      station: STATION,
      destination: DESTINATION,
      existingWaypoints: existing,
    });
    expect(body).toEqual({
      origin: ORIGIN,
      destination: DESTINATION,
      waypoints: [...existing, STATION],
    });
  });

  it('routes TO the station when no destination is active (station becomes the destination)', () => {
    const body = buildFuelStopRouteRequest({ origin: ORIGIN, station: STATION });
    expect(body).toEqual({ origin: ORIGIN, destination: STATION, waypoints: [] });
  });

  it('throws RangeError when appending would exceed MAX_WAYPOINTS', () => {
    const full: LatLng[] = Array.from({ length: MAX_WAYPOINTS }, (_, i) => ({ lat: i, lng: i }));
    expect(() =>
      buildFuelStopRouteRequest({
        origin: ORIGIN,
        station: STATION,
        destination: DESTINATION,
        existingWaypoints: full,
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// applyFuelStopWaypoint
// ---------------------------------------------------------------------------

describe('applyFuelStopWaypoint (Req 21.3)', () => {
  it('recalculates through the station and pushes the result as the group route', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { routes: [ROUTE] } })                 // /routes/calculate
      .mockResolvedValueOnce({ data: { message: 'Route pushed to group' } }); // /groups/:id/route

    const applied = await applyFuelStopWaypoint({
      groupId: 'g-1',
      origin: ORIGIN,
      station: STATION,
      destination: DESTINATION,
    });

    expect(applied).toBe(ROUTE);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/v1/routes/calculate', {
      origin: ORIGIN,
      destination: DESTINATION,
      waypoints: [STATION],
    });
    // Pushed through the standard route flow — NOT a rally-point broadcast.
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/v1/groups/g-1/route', {
      route: {
        distance: ROUTE.distance,
        duration: ROUTE.duration,
        distanceText: ROUTE.distanceText,
        durationText: ROUTE.durationText,
        geometry: ROUTE.geometry,
        speedLimitKph: 60,
        speedLimitSegmentsKph: [60, 50],
        congestionSegments: ['low', 'moderate'],
      },
    });
  });

  it('pushes nothing and returns null when no route exists through the station', async () => {
    mockPost.mockResolvedValueOnce({ data: { routes: [] } });

    const applied = await applyFuelStopWaypoint({
      groupId: 'g-1',
      origin: ORIGIN,
      station: STATION,
      destination: DESTINATION,
    });

    expect(applied).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('omits congestionSegments from the push when the server did not supply any', async () => {
    const bare: CalculatedRoute = { ...ROUTE, congestionSegments: undefined, speedLimitKph: undefined, speedLimitSegmentsKph: undefined };
    mockPost
      .mockResolvedValueOnce({ data: { routes: [bare] } })
      .mockResolvedValueOnce({ data: { message: 'Route pushed to group' } });

    await applyFuelStopWaypoint({ groupId: 'g-1', origin: ORIGIN, station: STATION, destination: DESTINATION });

    const pushed = (mockPost.mock.calls[1][1] as { route: Record<string, unknown> }).route;
    expect('congestionSegments' in pushed).toBe(false);
    expect(pushed.speedLimitKph).toBeNull();
    expect(pushed.speedLimitSegmentsKph).toEqual([]);
  });

  it('propagates a push failure so callers can surface the error', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { routes: [ROUTE] } })
      .mockRejectedValueOnce(new Error('500'));

    await expect(
      applyFuelStopWaypoint({ groupId: 'g-1', origin: ORIGIN, station: STATION, destination: DESTINATION }),
    ).rejects.toThrow('500');
  });
});
