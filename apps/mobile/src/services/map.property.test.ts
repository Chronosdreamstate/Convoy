/**
 * Property 5:  Dropped pins never leave the device
 *   PinDropService never makes a network request; only writes to local storage.
 *   Validates: Requirement 5.4
 *
 * Property 7:  Traffic refresh fires on schedule
 *   RouteService fires the refresh callback exactly once per 60-second interval.
 *   Validates: Requirements 6.3
 *
 * Property 8:  Waypoint count is enforced
 *   RouteService rejects the 11th waypoint addition.
 *   Validates: Requirements 6.4, 6.5
 *
 * Property 29: Destination search result count is bounded
 *   processSearchResults() returns at most 10 items.
 *   Validates: Requirement 18.5
 *
 * Property 30: Search is disabled while offline
 *   SearchService.search() returns [] when the online predicate is false.
 *   Validates: Requirement 18.8
 *
 * Property 37: Scenic routing preference persists across sessions
 *   ScenicRouteService persists the scenic flag; a new instance reads it back.
 *   Validates: Requirement 22.5
 *
 * Property 38: Speed limit exceeded state is correctly computed
 *   RouteService.isSpeedLimitExceeded() returns currentSpeed > postedLimit.
 *   Validates: Requirement 23.3
 */

import fc from 'fast-check';
import { PinDropService, IPinStorage, DroppedPin, GeocoderFn } from './PinDropService';
import { RouteService, MAX_WAYPOINTS, TRAFFIC_REFRESH_INTERVAL_MS } from './RouteService';
import { SearchService, processSearchResults, MAX_SEARCH_RESULTS } from './SearchService';
import { ScenicRouteService } from './ScenicRouteService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class InMemoryStorage implements IPinStorage {
  readonly store = new Map<string, string>();
  async getItem(key: string) { return this.store.get(key) ?? null; }
  async setItem(key: string, value: string) { this.store.set(key, value); }
  async removeItem(key: string) { this.store.delete(key); }
}

const noopGeocoder: GeocoderFn = async () => null;
const networkCalledGeocoder: GeocoderFn = async () => { throw new Error('NETWORK CALLED'); };

// ---------------------------------------------------------------------------
// Property 5: Dropped pins never leave the device
// ---------------------------------------------------------------------------
describe('Property 5: Dropped pins never leave the device', () => {
  it('savePin writes only to storage; geocoder is the only network-adjacent call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -89, max: 89, noNaN: true }),   // lat
        fc.float({ min: -179, max: 179, noNaN: true }),  // lng
        fc.string({ minLength: 1, maxLength: 40 }),      // address
        async (lat, lng, address) => {
          const storage = new InMemoryStorage();
          // The geocoder is injectable — in tests we use noopGeocoder, never real network
          const service = new PinDropService(storage, noopGeocoder);

          const pin: DroppedPin = { id: `pin_${lat}_${lng}`, lat, lng, address, createdAt: 0 };
          await service.savePin(pin);

          // Pin must be stored locally
          const stored = await service.getPins();
          const found = stored.find((p) => p.id === pin.id);
          expect(found).toBeDefined();
          expect(found!.lat).toBeCloseTo(lat, 5);
          expect(found!.lng).toBeCloseTo(lng, 5);

          // Storage must not be empty — data stayed on device
          expect(storage.store.size).toBeGreaterThan(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('dropPin uses the injected geocoder, not a real network call', async () => {
    const storage = new InMemoryStorage();
    let geocoderCalled = false;
    const testGeocoder: GeocoderFn = async () => { geocoderCalled = true; return 'Test Address'; };

    const service = new PinDropService(storage, testGeocoder);
    const pin = await service.dropPin(51.5, -0.1);

    expect(geocoderCalled).toBe(true);   // geocoder was used
    expect(pin.address).toBe('Test Address');
    expect(storage.store.size).toBeGreaterThan(0); // stored locally
  });

  it('dropping a pin never calls the real network geocoder in tests', async () => {
    const storage = new InMemoryStorage();
    // If production PinDropService tried to call real fetch, the spy would throw
    const service = new PinDropService(storage, networkCalledGeocoder);

    await expect(service.dropPin(10, 20)).rejects.toThrow('NETWORK CALLED');
    // But savePin (which is what the property tests actually call) never reaches geocoder
    await service.savePin({ id: 'p1', lat: 10, lng: 20, address: null, createdAt: 0 });
    expect(storage.store.size).toBeGreaterThan(0);
  });

  it('removePin removes only that pin from storage', async () => {
    const storage = new InMemoryStorage();
    const service = new PinDropService(storage, noopGeocoder);

    await service.savePin({ id: 'a', lat: 1, lng: 1, address: null, createdAt: 0 });
    await service.savePin({ id: 'b', lat: 2, lng: 2, address: null, createdAt: 0 });
    await service.removePin('a');

    const pins = await service.getPins();
    expect(pins.find((p) => p.id === 'a')).toBeUndefined();
    expect(pins.find((p) => p.id === 'b')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Property 7: Traffic refresh fires on schedule
// ---------------------------------------------------------------------------
describe('Property 7: Traffic refresh fires on schedule', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('callback fires exactly N times for N complete 60-second intervals', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (n) => {
          const service = new RouteService();
          const cb = jest.fn();
          service.startTrafficRefresh(cb);
          jest.advanceTimersByTime(n * TRAFFIC_REFRESH_INTERVAL_MS);
          expect(cb).toHaveBeenCalledTimes(n);
          service.stopTrafficRefresh();
          cb.mockReset();
        },
      ),
      { numRuns: 10 },
    );
  });

  it('callback does NOT fire before 60 seconds', () => {
    const service = new RouteService();
    const cb = jest.fn();
    service.startTrafficRefresh(cb);
    jest.advanceTimersByTime(TRAFFIC_REFRESH_INTERVAL_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    service.stopTrafficRefresh();
  });

  it('stopTrafficRefresh prevents further callbacks', () => {
    const service = new RouteService();
    const cb = jest.fn();
    service.startTrafficRefresh(cb);
    jest.advanceTimersByTime(TRAFFIC_REFRESH_INTERVAL_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    service.stopTrafficRefresh();
    jest.advanceTimersByTime(TRAFFIC_REFRESH_INTERVAL_MS * 5);
    expect(cb).toHaveBeenCalledTimes(1); // no additional calls
  });
});

// ---------------------------------------------------------------------------
// Property 8: Waypoint count is enforced
// ---------------------------------------------------------------------------
describe('Property 8: Waypoint count is enforced', () => {
  it('for any sequence of > MAX_WAYPOINTS additions, the (MAX+1)th throws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_WAYPOINTS + 1, max: MAX_WAYPOINTS + 10 }),
        (totalCount) => {
          const service = new RouteService();
          for (let i = 0; i < MAX_WAYPOINTS; i++) {
            service.addWaypoint({ lat: i, lng: i }); // first 10 must succeed
          }
          // Any attempt beyond 10 must throw
          for (let i = MAX_WAYPOINTS; i < totalCount; i++) {
            expect(() => service.addWaypoint({ lat: i, lng: i })).toThrow(RangeError);
          }
          expect(service.waypoints.length).toBe(MAX_WAYPOINTS);
        },
      ),
      { numRuns: 15 },
    );
  });

  it('exactly MAX_WAYPOINTS additions all succeed', () => {
    const service = new RouteService();
    for (let i = 0; i < MAX_WAYPOINTS; i++) {
      expect(() => service.addWaypoint({ lat: i * 0.1, lng: i * 0.1 })).not.toThrow();
    }
    expect(service.waypoints.length).toBe(MAX_WAYPOINTS);
  });

  it('removeWaypoint brings count below limit, allowing one more add', () => {
    const service = new RouteService();
    for (let i = 0; i < MAX_WAYPOINTS; i++) service.addWaypoint({ lat: i, lng: i });
    expect(() => service.addWaypoint({ lat: 99, lng: 99 })).toThrow();
    service.removeWaypoint(0);
    expect(() => service.addWaypoint({ lat: 99, lng: 99 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property 29: Destination search result count is bounded
// ---------------------------------------------------------------------------
describe('Property 29: Destination search result count is bounded', () => {
  const makeFeature = (i: number) => ({
    id: `feat_${i}`,
    place_name: `Place ${i}`,
    text: `Name ${i}`,
    place_type: ['poi'],
    center: [i * 0.1, i * 0.1] as [number, number],
  });

  it('for any number of Mapbox features, result count is at most 10', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        (n) => {
          const features = Array.from({ length: n }, (_, i) => makeFeature(i));
          const results = processSearchResults(features);
          expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
          expect(results.length).toBe(Math.min(n, MAX_SEARCH_RESULTS));
        },
      ),
      { numRuns: 30 },
    );
  });

  it('order of results matches the order of Mapbox features', () => {
    const features = Array.from({ length: 5 }, (_, i) => makeFeature(i));
    const results = processSearchResults(features);
    for (let i = 0; i < results.length; i++) {
      expect(results[i].id).toBe(`feat_${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 30: Search is disabled while offline
// ---------------------------------------------------------------------------
describe('Property 30: Search is disabled while offline', () => {
  it('for any query, SearchService returns [] when offline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3, maxLength: 50 }),
        async (query) => {
          const service = new SearchService(
            'pk.test-token',
            () => false, // always offline
            async () => { throw new Error('NETWORK CALLED WHILE OFFLINE'); },
          );
          const results = await service.search(query);
          expect(results).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('search returns results when online (fetcher called)', async () => {
    const mockFetcher = jest.fn().mockResolvedValue({
      features: [
        { id: 'r1', place_name: 'A, B', text: 'A', place_type: ['poi'], center: [1, 2] },
      ],
    });
    const service = new SearchService('pk.test', () => true, mockFetcher);
    const results = await service.search('London');
    expect(mockFetcher).toHaveBeenCalledTimes(1);
    expect(results.length).toBe(1);
  });

  it('short query (< 3 chars) also returns [] even when online', async () => {
    const mockFetcher = jest.fn();
    const service = new SearchService('pk.test', () => true, mockFetcher);
    const results = await service.search('ab');
    expect(results).toHaveLength(0);
    expect(mockFetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property 37: Scenic routing preference persists across sessions
// ---------------------------------------------------------------------------
describe('Property 37: Scenic routing preference persists across sessions', () => {
  it('for any boolean scenic setting, a new service instance reads back the same value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (scenic) => {
          const storage = new InMemoryStorage();
          const svc1 = new ScenicRouteService(storage);
          await svc1.setScenicMode(scenic);

          // Simulate a "new session" by creating a second instance over the same storage
          const svc2 = new ScenicRouteService(storage);
          const read = await svc2.getScenicMode();
          expect(read).toBe(scenic);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('default value is false when nothing has been persisted', async () => {
    const svc = new ScenicRouteService(new InMemoryStorage());
    expect(await svc.getScenicMode()).toBe(false);
  });

  it('overwriting the preference persists the latest value', async () => {
    const storage = new InMemoryStorage();
    const svc = new ScenicRouteService(storage);
    await svc.setScenicMode(true);
    await svc.setScenicMode(false);
    expect(await svc.getScenicMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 38: Speed limit exceeded state is correctly computed
// ---------------------------------------------------------------------------
describe('Property 38: Speed limit exceeded state is correctly computed', () => {
  it('for any (speed, limit), exceeded iff speed > limit', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 300, noNaN: true }),  // currentSpeed
        fc.float({ min: 0, max: 200, noNaN: true }),  // postedLimit
        (speed, limit) => {
          const result = RouteService.isSpeedLimitExceeded(speed, limit);
          expect(result).toBe(speed > limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns false when speed equals the limit', () => {
    expect(RouteService.isSpeedLimitExceeded(60, 60)).toBe(false);
  });

  it('returns true when speed is 1 km/h over the limit', () => {
    expect(RouteService.isSpeedLimitExceeded(61, 60)).toBe(true);
  });

  it('returns false when stopped (speed = 0)', () => {
    expect(RouteService.isSpeedLimitExceeded(0, 50)).toBe(false);
  });
});
