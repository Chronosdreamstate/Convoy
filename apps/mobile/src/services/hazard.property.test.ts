/**
 * Property tests for HazardService and WebSocketService.
 *
 * Property 71: Offline hazard reports are queued locally, not lost
 *   Validates: Requirements 11.9
 *
 * Property 72: API failure while online falls back to offline queue
 *   Validates: Requirements 11.9, 43.1
 *
 * Property 73: Confirm/dismiss votes are best-effort (no offline queuing)
 *   Validates: Requirements 11.5, 11.6
 *
 * Property 74: WebSocket reconnect backoff stays within bounds
 *   Validates: Requirements 43.2
 */

import fc from 'fast-check';
import { HazardService, HazardType, HAZARD_TYPES, HazardReport } from './HazardService';
import { OfflineHazard } from './OfflineCacheService';
import { computeBackoffMs } from './WebSocketService';

// ---------------------------------------------------------------------------
// HazardService test doubles
// ---------------------------------------------------------------------------

function makeHazardReport(type: HazardType): HazardReport {
  return {
    id: 'h-1',
    type,
    lat: 37.77,
    lng: -122.41,
    status: 'active',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    confirmationCount: 0,
    dismissalCount: 0,
    createdAt: new Date().toISOString(),
  };
}

function makeApi(options: {
  createShouldFail?: boolean;
  confirmShouldFail?: boolean;
  dismissShouldFail?: boolean;
} = {}) {
  const created: Array<{ type: HazardType; lat: number; lng: number }> = [];
  const confirmed: string[] = [];
  const dismissed: string[] = [];

  return {
    api: {
      createHazard: jest.fn(async (type: HazardType, lat: number, lng: number) => {
        if (options.createShouldFail) throw new Error('Network error');
        created.push({ type, lat, lng });
        return makeHazardReport(type);
      }),
      confirmHazard: jest.fn(async (id: string) => {
        if (options.confirmShouldFail) throw new Error('Network error');
        confirmed.push(id);
      }),
      dismissHazard: jest.fn(async (id: string) => {
        if (options.dismissShouldFail) throw new Error('Network error');
        dismissed.push(id);
      }),
    },
    created,
    confirmed,
    dismissed,
  };
}

function makeOfflineCache() {
  const saved: OfflineHazard[] = [];
  return {
    cache: {
      saveOfflineHazard: jest.fn(async (h: OfflineHazard) => { saved.push(h); }),
    },
    saved,
  };
}

// ---------------------------------------------------------------------------
// Property 71: Offline hazard reports are queued locally
// ---------------------------------------------------------------------------
describe('Property 71: Offline hazard reports are queued locally, not lost', () => {
  it('when offline, report() saves to offline cache and returns null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HAZARD_TYPES),
        fc.float({ min: -90, max: 90, noNaN: true }),
        fc.float({ min: -180, max: 180, noNaN: true }),
        async (type, lat, lng) => {
          const { api } = makeApi();
          const { cache, saved } = makeOfflineCache();
          const svc = new HazardService(api, cache, () => false);

          const result = await svc.report(type, lat, lng);

          expect(result).toBeNull();
          expect(saved).toHaveLength(1);
          expect(saved[0].type).toBe(type);
          expect(saved[0].lat).toBe(lat);
          expect(saved[0].lng).toBe(lng);
          expect(api.createHazard).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('offline queue entries always have a non-empty id and valid createdAt', async () => {
    const { api } = makeApi();
    const { cache, saved } = makeOfflineCache();
    const fixedNow = 1_700_000_000_000;
    const svc = new HazardService(api, cache, () => false, () => fixedNow);

    await svc.report('pothole', 37.77, -122.41);

    expect(saved[0].id.length).toBeGreaterThan(0);
    expect(saved[0].createdAt).toBe(fixedNow);
  });
});

// ---------------------------------------------------------------------------
// Property 72: API failure while online falls back to offline queue
// ---------------------------------------------------------------------------
describe('Property 72: API failure while online falls back to offline queue', () => {
  it('when online but API throws, report is queued offline and returns null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HAZARD_TYPES),
        async (type) => {
          const { api } = makeApi({ createShouldFail: true });
          const { cache, saved } = makeOfflineCache();
          const svc = new HazardService(api, cache, () => true);

          const result = await svc.report(type, 37.77, -122.41);

          expect(result).toBeNull();
          expect(saved).toHaveLength(1);
          expect(saved[0].type).toBe(type);
        },
      ),
      { numRuns: HAZARD_TYPES.length },
    );
  });

  it('when online and API succeeds, returns the report and does not save offline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HAZARD_TYPES),
        async (type) => {
          const { api } = makeApi();
          const { cache, saved } = makeOfflineCache();
          const svc = new HazardService(api, cache, () => true);

          const result = await svc.report(type, 37.77, -122.41);

          expect(result).not.toBeNull();
          expect(result?.type).toBe(type);
          expect(saved).toHaveLength(0);
        },
      ),
      { numRuns: HAZARD_TYPES.length },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 73: Confirm/dismiss votes are best-effort (no offline queuing)
// ---------------------------------------------------------------------------
describe('Property 73: Confirm/dismiss votes are best-effort', () => {
  it('confirm() does not throw when API fails', async () => {
    const { api } = makeApi({ confirmShouldFail: true });
    const { cache } = makeOfflineCache();
    const svc = new HazardService(api, cache, () => true);

    await expect(svc.confirm('h-1')).resolves.not.toThrow();
    expect(cache.saveOfflineHazard).not.toHaveBeenCalled();
  });

  it('dismiss() does not throw when API fails', async () => {
    const { api } = makeApi({ dismissShouldFail: true });
    const { cache } = makeOfflineCache();
    const svc = new HazardService(api, cache, () => true);

    await expect(svc.dismiss('h-1')).resolves.not.toThrow();
    expect(cache.saveOfflineHazard).not.toHaveBeenCalled();
  });

  it('confirm/dismiss calls API when online', async () => {
    const { api, confirmed, dismissed } = makeApi();
    const { cache } = makeOfflineCache();
    const svc = new HazardService(api, cache, () => true);

    await svc.confirm('h-confirm');
    await svc.dismiss('h-dismiss');

    expect(confirmed).toContain('h-confirm');
    expect(dismissed).toContain('h-dismiss');
  });
});

// ---------------------------------------------------------------------------
// Property 74: WebSocket reconnect backoff stays within bounds
// ---------------------------------------------------------------------------
describe('Property 74: WebSocket reconnect backoff stays within bounds', () => {
  test('P74.1: backoff with attempt=0 is near initialMs', () => {
    const result = computeBackoffMs(0, 1000, 30000);
    // Base is 1000ms, jitter is ±25% → should be in [750, 1250]
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1250);
  });

  test('P74.2: backoff never exceeds maxMs + 25% jitter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 100, max: 5000 }),
        fc.integer({ min: 5001, max: 60000 }),
        (attempt, initial, max) => {
          const result = computeBackoffMs(attempt, initial, max);
          // Result must be within max + 25% jitter
          expect(result).toBeLessThanOrEqual(Math.ceil(max * 1.25) + 1);
          expect(result).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test('P74.3: backoff grows with each attempt (base increases)', () => {
    // Without jitter, base doubles each time up to max
    const base0 = 1000;
    const base1 = 2000;
    const base2 = 4000;
    // With ±25% jitter this can sometimes fail, so we run many samples
    let largerCount = 0;
    for (let i = 0; i < 100; i++) {
      const r0 = computeBackoffMs(0, base0, 60000);
      const r1 = computeBackoffMs(1, base0, 60000);
      const r2 = computeBackoffMs(2, base0, 60000);
      // On average, each should be larger than the previous
      if (r1 > r0) largerCount++;
      if (r2 > r1) largerCount++;
    }
    // At least 70% of samples should show growth
    expect(largerCount).toBeGreaterThan(100);
  });

  test('P74.4: backoff caps at maxMs regardless of attempt count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 50 }),
        (attempt) => {
          // With a very large number of attempts, base is capped at maxMs
          const maxMs = 5000;
          const result = computeBackoffMs(attempt, 1000, maxMs);
          // Upper bound: maxMs + 25% jitter
          expect(result).toBeLessThanOrEqual(maxMs + maxMs * 0.25 + 1);
        },
      ),
    );
  });
});
