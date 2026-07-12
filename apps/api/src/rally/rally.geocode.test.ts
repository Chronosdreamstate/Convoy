/**
 * Tests for the rally reverseGeocode helper (Req 20.2 decoration).
 *
 * The Mapbox fetch previously had no timeout: it failed soft to null on
 * errors, but a hung connection stalled POST /groups/:id/rally indefinitely.
 * It now aborts via AbortSignal.timeout and still fails soft to null.
 */

import { reverseGeocode, REVERSE_GEOCODE_TIMEOUT_MS } from './rally.routes';

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function mockFetchResolving(body: unknown): jest.Mock {
  const mock = jest.fn(async () => ({ json: async () => body }));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('reverseGeocode', () => {
  it('caps the Mapbox fetch at 5 seconds (matches places.routes reverse-geocode timeout)', () => {
    expect(REVERSE_GEOCODE_TIMEOUT_MS).toBe(5_000);
  });

  it('resolves the first feature place_name on success', async () => {
    mockFetchResolving({ features: [{ place_name: '221B Baker Street, London' }] });
    await expect(reverseGeocode(-0.158, 51.523)).resolves.toBe('221B Baker Street, London');
  });

  it('passes an abort signal to fetch so a hung connection cannot stall rally creation', async () => {
    const mock = mockFetchResolving({ features: [] });
    await reverseGeocode(-0.158, 51.523);

    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails soft to null when the fetch aborts on timeout', async () => {
    global.fetch = jest.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    await expect(reverseGeocode(-0.158, 51.523)).resolves.toBeNull();
  });

  it('fails soft to null on network errors', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(reverseGeocode(-0.158, 51.523)).resolves.toBeNull();
  });

  it('returns null when Mapbox has no features for the coordinate', async () => {
    mockFetchResolving({ features: [] });
    await expect(reverseGeocode(0, 0)).resolves.toBeNull();
  });
});
