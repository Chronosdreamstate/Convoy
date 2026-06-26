/**
 * Property tests for RallyService.
 *
 * RallyService is a thin API-client wrapper with no local computation, so the
 * properties focus on the observable contract between the service and apiClient:
 *
 * Property 113: broadcastRally always POSTs to /api/v1/groups/:groupId/rally
 *   with the exact lat/lng passed in, for any valid coordinate pair.
 *   Validates: Requirement 20.1
 *
 * Property 114: broadcastGroupSos always POSTs to /api/v1/groups/:groupId/sos
 *   with the exact lat/lng passed in, for any valid coordinate pair.
 *   Validates: Requirements 25.1–25.3
 *
 * Property 115: broadcastStandaloneSos always POSTs to /api/v1/sos
 *   with the exact lat/lng for any valid coordinate pair.
 *   Validates: Requirement 25.7
 *
 * Property 116: cancelRally always issues DELETE to the correct URL for any
 *   groupId/rallyId pair, with no request body.
 *   Validates: Requirement 20.5
 *
 * Property 117: cancelSos / cancelStandaloneSos always issue DELETE to the
 *   correct URL — never swapping group vs. standalone endpoints.
 *   Validates: Requirement 25.6
 *
 * Property 118: Service methods return exactly what apiClient gives back — no
 *   mutation, no re-wrapping.
 *   Validates: data fidelity (Requirements 20.1, 25.1)
 */

import fc from 'fast-check';
import { rallyService, RallyPoint, SosPin } from './RallyService';
import { apiClient } from './apiClient';

// ---------------------------------------------------------------------------
// Mock apiClient at module level
// ---------------------------------------------------------------------------

jest.mock('./apiClient');

const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;
const mockDelete = apiClient.delete as jest.MockedFunction<typeof apiClient.delete>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcLat = fc.float({ min: -90, max: 90, noNaN: true });
const fcLng = fc.float({ min: -180, max: 180, noNaN: true });
const fcId = fc.string({ minLength: 1, maxLength: 36 }).filter((s) => s.trim().length > 0 && !s.includes('/'));

function rallyPointFor(lat: number, lng: number): RallyPoint {
  return { id: 'r1', broadcasterId: 'u1', lat, lng, address: null, isActive: true, type: 'waypoint', createdAt: '2024-01-01T00:00:00Z' };
}

function sosPinFor(lat: number, lng: number): SosPin {
  return { id: 's1', userId: 'u1', groupId: 'g1', lat, lng, type: 'general', createdAt: '2024-01-01T00:00:00Z' };
}

// ---------------------------------------------------------------------------
// Property 113: broadcastRally — correct URL + payload
// ---------------------------------------------------------------------------

describe('Property 113: broadcastRally posts to the correct URL with exact coordinates', () => {
  it('URL contains groupId and payload matches lat/lng for any valid coordinate', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, async (groupId, lat, lng) => {
        const point = rallyPointFor(lat, lng);
        mockPost.mockResolvedValueOnce({ data: point });

        await rallyService.broadcastRally(groupId, lat, lng);

        const [url, body] = mockPost.mock.calls[mockPost.mock.calls.length - 1];
        expect(url).toBe(`/api/v1/groups/${groupId}/rally`);
        expect((body as { lat: number; lng: number }).lat).toBe(lat);
        expect((body as { lat: number; lng: number }).lng).toBe(lng);
      }),
      { numRuns: 50 },
    );
  });

  it('URL is never /api/v1/sos (does not use standalone endpoint)', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, async (groupId, lat, lng) => {
        mockPost.mockResolvedValueOnce({ data: rallyPointFor(lat, lng) });
        await rallyService.broadcastRally(groupId, lat, lng);
        const [url] = mockPost.mock.calls[mockPost.mock.calls.length - 1];
        expect(url).not.toBe('/api/v1/sos');
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: broadcastGroupSos — correct URL + payload
// ---------------------------------------------------------------------------

describe('Property 114: broadcastGroupSos posts to the group SOS endpoint with exact coordinates', () => {
  it('URL contains groupId and payload matches lat/lng for any valid coordinate', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, async (groupId, lat, lng) => {
        const pin = sosPinFor(lat, lng);
        mockPost.mockResolvedValueOnce({ data: pin });

        await rallyService.broadcastGroupSos(groupId, lat, lng);

        const [url, body] = mockPost.mock.calls[mockPost.mock.calls.length - 1];
        expect(url).toBe(`/api/v1/groups/${groupId}/sos`);
        expect((body as { lat: number; lng: number }).lat).toBe(lat);
        expect((body as { lat: number; lng: number }).lng).toBe(lng);
      }),
      { numRuns: 50 },
    );
  });

  it('group SOS URL always differs from standalone /api/v1/sos', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, async (groupId, lat, lng) => {
        mockPost.mockResolvedValueOnce({ data: sosPinFor(lat, lng) });
        await rallyService.broadcastGroupSos(groupId, lat, lng);
        const [url] = mockPost.mock.calls[mockPost.mock.calls.length - 1];
        expect(url).not.toBe('/api/v1/sos');
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 115: broadcastStandaloneSos — always uses /api/v1/sos
// ---------------------------------------------------------------------------

describe('Property 115: broadcastStandaloneSos always uses the standalone /api/v1/sos endpoint', () => {
  it('URL is exactly /api/v1/sos and payload matches lat/lng for any valid coordinate', async () => {
    await fc.assert(
      fc.asyncProperty(fcLat, fcLng, async (lat, lng) => {
        const pin = sosPinFor(lat, lng);
        mockPost.mockResolvedValueOnce({ data: pin });

        await rallyService.broadcastStandaloneSos(lat, lng);

        const [url, body] = mockPost.mock.calls[mockPost.mock.calls.length - 1];
        expect(url).toBe('/api/v1/sos');
        expect((body as { lat: number; lng: number }).lat).toBe(lat);
        expect((body as { lat: number; lng: number }).lng).toBe(lng);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: cancelRally — correct DELETE URL for any groupId/rallyId
// ---------------------------------------------------------------------------

describe('Property 116: cancelRally issues DELETE to the correct URL for any ID pair', () => {
  it('DELETE URL is /api/v1/groups/:groupId/rally/:rallyId for any non-empty IDs', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcId, async (groupId, rallyId) => {
        mockDelete.mockResolvedValueOnce({ data: undefined });

        await rallyService.cancelRally(groupId, rallyId);

        const [url] = mockDelete.mock.calls[mockDelete.mock.calls.length - 1];
        expect(url).toBe(`/api/v1/groups/${groupId}/rally/${rallyId}`);
      }),
      { numRuns: 50 },
    );
  });

  it('cancelRally never touches the SOS endpoint', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcId, async (groupId, rallyId) => {
        mockDelete.mockResolvedValueOnce({ data: undefined });
        await rallyService.cancelRally(groupId, rallyId);
        const [url] = mockDelete.mock.calls[mockDelete.mock.calls.length - 1];
        expect(url).not.toContain('/sos');
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 117: cancelSos vs cancelStandaloneSos — correct endpoint separation
// ---------------------------------------------------------------------------

describe('Property 117: cancelSos and cancelStandaloneSos never swap endpoints', () => {
  it('cancelSos DELETE URL contains /groups/:groupId/sos/:sosId', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcId, async (groupId, sosId) => {
        mockDelete.mockResolvedValueOnce({ data: undefined });
        await rallyService.cancelSos(groupId, sosId);
        const [url] = mockDelete.mock.calls[mockDelete.mock.calls.length - 1];
        expect(url).toBe(`/api/v1/groups/${groupId}/sos/${sosId}`);
      }),
      { numRuns: 40 },
    );
  });

  it('cancelStandaloneSos DELETE URL is /api/v1/sos/:sosId', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, async (sosId) => {
        mockDelete.mockResolvedValueOnce({ data: undefined });
        await rallyService.cancelStandaloneSos(sosId);
        const [url] = mockDelete.mock.calls[mockDelete.mock.calls.length - 1];
        expect(url).toBe(`/api/v1/sos/${sosId}`);
      }),
      { numRuns: 40 },
    );
  });

  it('cancelSos and cancelStandaloneSos URLs are always distinct for the same sosId', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcId, async (groupId, sosId) => {
        mockDelete.mockResolvedValue({ data: undefined });
        await rallyService.cancelSos(groupId, sosId);
        const groupUrl = mockDelete.mock.calls[mockDelete.mock.calls.length - 1][0];
        jest.clearAllMocks();
        mockDelete.mockResolvedValue({ data: undefined });
        await rallyService.cancelStandaloneSos(sosId);
        const standaloneUrl = mockDelete.mock.calls[mockDelete.mock.calls.length - 1][0];
        expect(groupUrl).not.toBe(standaloneUrl);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 118: Service methods return exactly what apiClient gives back
// ---------------------------------------------------------------------------

describe('Property 118: Service returns exactly what apiClient gives back — no mutation', () => {
  it('broadcastRally returns the exact RallyPoint object from apiClient', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, fc.string({ minLength: 1, maxLength: 10 }), async (groupId, lat, lng, id) => {
        const point: RallyPoint = { id, broadcasterId: 'u1', lat, lng, address: null, isActive: true, type: 'waypoint', createdAt: '2024-01-01T00:00:00Z' };
        mockPost.mockResolvedValueOnce({ data: point });
        const result = await rallyService.broadcastRally(groupId, lat, lng);
        expect(result).toBe(point); // same reference — not a copy
      }),
      { numRuns: 30 },
    );
  });

  it('broadcastGroupSos returns the exact SosPin object from apiClient', async () => {
    await fc.assert(
      fc.asyncProperty(fcId, fcLat, fcLng, fc.string({ minLength: 1, maxLength: 10 }), async (groupId, lat, lng, id) => {
        const pin: SosPin = { id, userId: 'u1', groupId, lat, lng, type: 'general', createdAt: '2024-01-01T00:00:00Z' };
        mockPost.mockResolvedValueOnce({ data: pin });
        const result = await rallyService.broadcastGroupSos(groupId, lat, lng);
        expect(result).toBe(pin);
      }),
      { numRuns: 30 },
    );
  });

  it('broadcastStandaloneSos returns the exact SosPin object from apiClient', async () => {
    await fc.assert(
      fc.asyncProperty(fcLat, fcLng, fc.string({ minLength: 1, maxLength: 10 }), async (lat, lng, id) => {
        const pin: SosPin = { id, userId: 'u1', groupId: null, lat, lng, type: 'general', createdAt: '2024-01-01T00:00:00Z' };
        mockPost.mockResolvedValueOnce({ data: pin });
        const result = await rallyService.broadcastStandaloneSos(lat, lng);
        expect(result).toBe(pin);
      }),
      { numRuns: 30 },
    );
  });
});
