/**
 * Unit tests for SpeedAlertService — speed-camera proximity alerts.
 *
 * Covers:
 *  - checkLocation fires the alert callback only within the 500 m radius
 *  - reported distance is rounded to whole meters
 *  - a camera alerts at most once per 60 s (dedupe + timed re-arm)
 *  - loadCamerasNear swallows API failures and keeps the cached camera list
 *  - reportCamera / voteOnCamera post the right payloads and never throw
 *  - offline failures (no HTTP response) are queued in the offline request
 *    queue for replay; server rejections (4xx/5xx) are not
 */

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockEnqueue = jest.fn();

jest.mock('./apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.mock('./OfflineQueueService', () => ({
  offlineQueue: {
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
  },
  // Real classifier semantics: offline = axios error without an HTTP response.
  isOfflineError: (err: unknown) =>
    (err as { response?: unknown } | null)?.response === undefined,
}));

import { speedAlertService, SpeedCamera } from './SpeedAlertService';

function makeCamera(overrides: Partial<SpeedCamera> = {}): SpeedCamera {
  return {
    id: `cam-${Math.random().toString(36).slice(2)}`,
    lat: 37.7749,
    lng: -122.4194,
    type: 'fixed',
    source: 'community',
    ...overrides,
  };
}

/** Loads the given cameras into the singleton via the (mocked) API. */
async function loadCameras(cameras: SpeedCamera[]): Promise<void> {
  mockGet.mockResolvedValueOnce({ data: { cameras } });
  await speedAlertService.loadCamerasNear(0, 0);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGet.mockReset();
  mockPost.mockReset();
  mockEnqueue.mockReset();
});

afterEach(async () => {
  // Re-arm any alerted cameras and clear the singleton's camera list so
  // state cannot leak between tests.
  jest.advanceTimersByTime(60_000);
  jest.useRealTimers();
  mockGet.mockResolvedValueOnce({ data: { cameras: [] } });
  await speedAlertService.loadCamerasNear(0, 0);
});

describe('checkLocation — alert radius', () => {
  it('alerts for a camera within 500 m, with rounded distance', async () => {
    // ~0.003 deg latitude ≈ 333 m
    const camera = makeCamera({ id: 'near', lat: 37.7749 + 0.003, lng: -122.4194 });
    await loadCameras([camera]);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);

    expect(onAlert).toHaveBeenCalledTimes(1);
    const [alertedCamera, distance] = onAlert.mock.calls[0];
    expect(alertedCamera.id).toBe('near');
    expect(Number.isInteger(distance)).toBe(true);
    expect(distance).toBeGreaterThan(300);
    expect(distance).toBeLessThan(400);
  });

  it('does not alert for a camera beyond 500 m', async () => {
    // ~0.006 deg latitude ≈ 667 m
    const camera = makeCamera({ id: 'far', lat: 37.7749 + 0.006, lng: -122.4194 });
    await loadCameras([camera]);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);

    expect(onAlert).not.toHaveBeenCalled();
  });

  it('alerts once per camera while inside the radius (dedupe)', async () => {
    const camera = makeCamera({ id: 'dedupe', lat: 37.7749, lng: -122.4194 });
    await loadCameras([camera]);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);
    speedAlertService.checkLocation(37.7750, -122.4194);
    speedAlertService.checkLocation(37.7751, -122.4194);

    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('re-arms the same camera after 60 seconds', async () => {
    const camera = makeCamera({ id: 'rearm', lat: 37.7749, lng: -122.4194 });
    await loadCameras([camera]);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);

    speedAlertService.checkLocation(37.7749, -122.4194);
    expect(onAlert).toHaveBeenCalledTimes(1);

    // Just before the 60s re-arm: still deduped
    jest.advanceTimersByTime(59_999);
    speedAlertService.checkLocation(37.7749, -122.4194);
    expect(onAlert).toHaveBeenCalledTimes(1);

    // After the re-arm window: alerts again
    jest.advanceTimersByTime(1);
    speedAlertService.checkLocation(37.7749, -122.4194);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it('alerts independently for multiple distinct cameras in range', async () => {
    await loadCameras([
      makeCamera({ id: 'a', lat: 37.7749, lng: -122.4194 }),
      makeCamera({ id: 'b', lat: 37.7752, lng: -122.4194 }),
    ]);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);

    expect(onAlert).toHaveBeenCalledTimes(2);
    const alertedIds = onAlert.mock.calls.map((c) => c[0].id).sort();
    expect(alertedIds).toEqual(['a', 'b']);
  });
});

describe('loadCamerasNear', () => {
  it('requests the expected endpoint with lat/lng/radius', async () => {
    mockGet.mockResolvedValueOnce({ data: { cameras: [] } });
    await speedAlertService.loadCamerasNear(51.5, -0.12, 25);
    expect(mockGet).toHaveBeenCalledWith('/api/v1/speed-cameras?lat=51.5&lng=-0.12&radius=25');
  });

  it('keeps previously cached cameras when the API call fails', async () => {
    const camera = makeCamera({ id: 'cached', lat: 37.7749, lng: -122.4194 });
    await loadCameras([camera]);

    mockGet.mockRejectedValueOnce(new Error('offline'));
    await expect(speedAlertService.loadCamerasNear(0, 0)).resolves.toBeUndefined();

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0].id).toBe('cached');
  });

  it('treats a missing cameras field as an empty list', async () => {
    // First load something so we can observe it being replaced
    await loadCameras([makeCamera({ id: 'stale', lat: 37.7749, lng: -122.4194 })]);

    mockGet.mockResolvedValueOnce({ data: {} });
    await speedAlertService.loadCamerasNear(0, 0);

    const onAlert = jest.fn();
    speedAlertService.setAlertCallback(onAlert);
    speedAlertService.checkLocation(37.7749, -122.4194);
    expect(onAlert).not.toHaveBeenCalled();
  });
});

describe('reportCamera / voteOnCamera', () => {
  it('reportCamera posts a community report', async () => {
    mockPost.mockResolvedValueOnce({});
    await speedAlertService.reportCamera(1.5, 2.5, 'mobile');
    expect(mockPost).toHaveBeenCalledWith('/api/v1/speed-cameras', {
      lat: 1.5, lng: 2.5, type: 'mobile', source: 'community',
    });
  });

  it('voteOnCamera posts to the camera vote endpoint', async () => {
    mockPost.mockResolvedValueOnce({});
    await speedAlertService.voteOnCamera('cam-9', 'deny');
    expect(mockPost).toHaveBeenCalledWith('/api/v1/speed-cameras/cam-9/vote', { vote: 'deny' });
  });

  it('both swallow API errors (fire-and-forget)', async () => {
    mockPost.mockRejectedValue(new Error('network'));
    await expect(speedAlertService.reportCamera(0, 0, 'fixed')).resolves.toBeUndefined();
    await expect(speedAlertService.voteOnCamera('cam-1', 'confirm')).resolves.toBeUndefined();
  });

  it('reportCamera queues the report when offline (no HTTP response)', async () => {
    mockPost.mockRejectedValue(new Error('Network Error')); // axios network error: no .response
    await speedAlertService.reportCamera(1.5, 2.5, 'mobile');
    expect(mockEnqueue).toHaveBeenCalledWith({
      method: 'POST',
      url: '/api/v1/speed-cameras',
      body: { lat: 1.5, lng: 2.5, type: 'mobile', source: 'community' },
      headers: {},
    });
  });

  it('voteOnCamera queues the vote with a per-camera dedupeKey when offline', async () => {
    mockPost.mockRejectedValue(new Error('Network Error'));
    await speedAlertService.voteOnCamera('cam-9', 'deny');
    expect(mockEnqueue).toHaveBeenCalledWith({
      method: 'POST',
      url: '/api/v1/speed-cameras/cam-9/vote',
      body: { vote: 'deny' },
      headers: {},
      dedupeKey: 'camera-vote:cam-9',
    });
  });

  it('does NOT queue when the server responded with an error (4xx/5xx)', async () => {
    mockPost.mockRejectedValue({ response: { status: 422 } });
    await speedAlertService.reportCamera(0, 0, 'fixed');
    await speedAlertService.voteOnCamera('cam-1', 'confirm');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does NOT queue on success', async () => {
    mockPost.mockResolvedValue({});
    await speedAlertService.reportCamera(0, 0, 'fixed');
    await speedAlertService.voteOnCamera('cam-1', 'confirm');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
