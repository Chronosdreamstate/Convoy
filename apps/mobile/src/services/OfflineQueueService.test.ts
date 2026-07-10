/**
 * Unit tests for OfflineQueueService — the AsyncStorage-backed write queue
 * for light offline API writes (RSVPs, friend requests, profile updates).
 * Requirements: 19.7 (offline resilience)
 *
 * Covers:
 *  - enqueue: dedupeKey replaces older entries, queue caps at 100 (oldest dropped)
 *  - cancel removes a specific queued item
 *  - processQueue: success removes item; 409 treated as already-applied;
 *    other 4xx dropped as non-retriable; 5xx/network kept with attempts++
 *  - items expire after 24 h or MAX_ATTEMPTS (5) failed attempts
 *  - stored full URLs are replayed as path+query so a fresh token is attached
 *  - relative URLs (the common case for apiClient calls) are replayed as-is
 *    instead of throwing in `new URL()` and burning retry attempts
 *  - clear() empties both the in-memory queue and the persisted copy
 *  - queue persists to AsyncStorage and is restored by init()
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const mockRequest = jest.fn();

jest.mock('./apiClient', () => ({
  apiClient: {
    request: (...args: unknown[]) => mockRequest(...args),
  },
}));

import { offlineQueue } from './OfflineQueueService';

type OfflineQueue = typeof offlineQueue;

/**
 * Resets the singleton's in-memory state (as if the process just started)
 * WITHOUT touching AsyncStorage — persisted state survives, exactly like a
 * real app restart.
 */
function freshQueue(): OfflineQueue {
  const q = offlineQueue as unknown as {
    queue: unknown[];
    processing: boolean;
    initialized: boolean;
    appStateSub: { remove: () => void } | null;
  };
  q.appStateSub?.remove();
  q.appStateSub = null;
  q.queue = [];
  q.processing = false;
  q.initialized = false;
  return offlineQueue;
}

function makeRequestInput(overrides: Partial<{
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body: unknown;
  headers: Record<string, string>;
  dedupeKey: string;
}> = {}) {
  return {
    method: 'POST' as const,
    url: 'https://api.convoy.test/api/v1/things',
    body: { hello: 'world' },
    headers: {},
    ...overrides,
  };
}

beforeEach(async () => {
  mockRequest.mockReset();
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  it('adds items and reports size', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    await queue.enqueue(makeRequestInput());
    expect(queue.size).toBe(2);
  });

  it('replaces an older item with the same dedupeKey (newest wins)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({ dedupeKey: 'rsvp:e1', body: { rsvp: 'yes' } }));
    await queue.enqueue(makeRequestInput({ dedupeKey: 'rsvp:e1', body: { rsvp: 'no' } }));
    expect(queue.size).toBe(1);

    mockRequest.mockResolvedValue({});
    await queue.processQueue();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0].data).toEqual({ rsvp: 'no' });
  });

  it('items with different dedupeKeys are kept separately', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({ dedupeKey: 'rsvp:e1' }));
    await queue.enqueue(makeRequestInput({ dedupeKey: 'rsvp:e2' }));
    expect(queue.size).toBe(2);
  });

  it('caps the queue at 100 items, dropping the oldest first', async () => {
    const queue = freshQueue();
    for (let i = 0; i < 105; i++) {
      await queue.enqueue(makeRequestInput({
        url: `https://api.convoy.test/api/v1/item/${i}`,
      }));
    }
    expect(queue.size).toBe(100);

    // Oldest 5 (0..4) were dropped: replay and check first URL processed is item/5
    mockRequest.mockResolvedValue({});
    await queue.processQueue();
    const urls = mockRequest.mock.calls.map((c) => c[0].url);
    expect(urls[0]).toBe('/api/v1/item/5');
    expect(urls).toHaveLength(100);
    expect(urls).not.toContain('/api/v1/item/4');
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('removes only the targeted item', async () => {
    const queue = freshQueue();
    const id1 = await queue.enqueue(makeRequestInput({ url: 'https://x.test/api/a' }));
    await queue.enqueue(makeRequestInput({ url: 'https://x.test/api/b' }));

    await queue.cancel(id1);
    expect(queue.size).toBe(1);

    mockRequest.mockResolvedValue({});
    await queue.processQueue();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0].url).toBe('/api/b');
  });
});

// ---------------------------------------------------------------------------
// processQueue — status handling
// ---------------------------------------------------------------------------

describe('processQueue', () => {
  it('replays the stored full URL as path+query (fresh token attached upstream)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({
      method: 'PATCH',
      url: 'https://api.convoy.test/api/v1/users/me?force=1',
      body: { displayName: 'Ada' },
    }));

    mockRequest.mockResolvedValue({});
    await queue.processQueue();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PATCH',
      url: '/api/v1/users/me?force=1',
      data: { displayName: 'Ada' },
    });
    expect(queue.size).toBe(0);
  });

  it('replays a relative URL as-is (regression: new URL() threw and burned all attempts)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({
      url: '/api/v1/speed-cameras/cam-1/vote?src=map',
      body: { vote: 'confirm' },
    }));

    mockRequest.mockResolvedValue({});
    await queue.processQueue();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      url: '/api/v1/speed-cameras/cam-1/vote?src=map',
      data: { vote: 'confirm' },
    });
    expect(queue.size).toBe(0);
  });

  it('a relative URL is not misclassified as a network error (single attempt, success drains it)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({ url: '/api/v1/things' }));

    mockRequest.mockResolvedValue({});
    // One pass must be enough — previously this took 0 API calls and 5 passes
    // to silently drop the item because URL parsing itself threw.
    await queue.processQueue();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
  });

  it('removes items on success', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockResolvedValue({});
    await queue.processQueue();
    expect(queue.size).toBe(0);
  });

  it('treats 409 Conflict as already-applied and drops the item', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockRejectedValue({ response: { status: 409 } });
    await queue.processQueue();
    expect(queue.size).toBe(0);
  });

  it('drops non-retriable 4xx client errors', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockRejectedValue({ response: { status: 422 } });
    await queue.processQueue();
    expect(queue.size).toBe(0);
  });

  it('keeps items on 5xx server errors and increments attempts', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockRejectedValue({ response: { status: 503 } });
    await queue.processQueue();
    expect(queue.size).toBe(1);
  });

  it('keeps items on network errors (no response)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockRejectedValue(new Error('Network Error'));
    await queue.processQueue();
    expect(queue.size).toBe(1);
  });

  it('drops an item after MAX_ATTEMPTS (5) failed attempts without retrying it again', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());
    mockRequest.mockRejectedValue({ response: { status: 500 } });

    // 5 failing runs -> attempts reaches 5, item still queued
    for (let i = 0; i < 5; i++) {
      await queue.processQueue();
    }
    expect(mockRequest).toHaveBeenCalledTimes(5);
    expect(queue.size).toBe(1);

    // 6th run: item is expired by attempt count — dropped without an API call
    await queue.processQueue();
    expect(mockRequest).toHaveBeenCalledTimes(5);
    expect(queue.size).toBe(0);
  });

  it('drops items older than 24 h without calling the API', async () => {
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    const queue = freshQueue();
    await queue.enqueue(makeRequestInput());

    // Advance the clock 24h + 1ms
    nowSpy.mockReturnValue(realNow + 24 * 60 * 60 * 1000 + 1);

    mockRequest.mockResolvedValue({});
    await queue.processQueue();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it('a failing item does not block later items from being processed', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({ url: 'https://x.test/api/fail' }));
    await queue.enqueue(makeRequestInput({ url: 'https://x.test/api/ok' }));

    mockRequest.mockImplementation(async (cfg: { url: string }) => {
      if (cfg.url === '/api/fail') throw { response: { status: 500 } };
      return {};
    });

    await queue.processQueue();

    const urls = mockRequest.mock.calls.map((c) => c[0].url);
    expect(urls).toEqual(['/api/fail', '/api/ok']);
    expect(queue.size).toBe(1); // only the failing item remains
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('empties the queue and the persisted copy (sign-out semantics)', async () => {
    const queue = freshQueue();
    await queue.enqueue(makeRequestInput({ url: '/api/v1/a' }));
    await queue.enqueue(makeRequestInput({ url: '/api/v1/b' }));
    expect(queue.size).toBe(2);

    await queue.clear();
    expect(queue.size).toBe(0);
    expect(await AsyncStorage.getItem('@convoy/offline_request_queue')).toBeNull();

    // A "restarted" instance must not resurrect the cleared items
    mockRequest.mockResolvedValue({});
    const second = freshQueue();
    await second.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRequest).not.toHaveBeenCalled();
    expect(second.size).toBe(0);
    second.destroy();
  });
});

// ---------------------------------------------------------------------------
// persistence across restarts
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('a queued item survives a "restart" (new instance + init) and is replayed', async () => {
    const first = freshQueue();
    await first.enqueue(makeRequestInput({ url: 'https://x.test/api/persisted' }));

    // Simulate app restart: brand-new module instance reads AsyncStorage.
    // init() drains the queue immediately, so resolve the replay.
    mockRequest.mockResolvedValue({});
    const second = freshQueue();
    await second.init();

    // init fires processQueue asynchronously (void) — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0].url).toBe('/api/persisted');
    expect(second.size).toBe(0);
    second.destroy();
  });

  it('corrupted persisted JSON results in an empty queue, not a crash', async () => {
    await AsyncStorage.setItem('@convoy/offline_request_queue', '{not json');
    const queue = freshQueue();
    await expect(queue.init()).resolves.toBeUndefined();
    expect(queue.size).toBe(0);
    queue.destroy();
  });
});
