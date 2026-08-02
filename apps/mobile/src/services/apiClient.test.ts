/**
 * apiClient interceptor behaviour.
 *
 * Every authenticated request in the app goes through these two interceptors,
 * and they are the only place that decides (a) whether a failed request is
 * re-sent and (b) what happens when the access token expires mid-session.
 * Both decisions are invisible to callers, so they are asserted here rather
 * than through any screen.
 *
 * The tests drive the REAL interceptor chain and only replace the adapter —
 * axios itself builds the errors, so the shapes the interceptors branch on
 * (`error.response`, `error.config`) are the ones production produces.
 */
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => 'stored-token'),
}));

jest.mock('./AuthService', () => ({
  authService: {
    refreshToken: jest.fn(async () => 'new-token'),
    signOut: jest.fn(async () => undefined),
  },
}));

type Adapter = jest.Mock<Promise<AxiosResponse>, [InternalAxiosRequestConfig]>;

interface Harness {
  client: AxiosInstance;
  adapter: Adapter;
  secureStore: { getItemAsync: jest.Mock };
  authService: { refreshToken: jest.Mock; signOut: jest.Mock };
}

/**
 * A fresh module instance per test — the 401 path keeps `isRefreshing` and the
 * queue in module scope, so leaking that between tests would make ordering
 * matter.
 */
function load(): Harness {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiClient } = require('./apiClient') as { apiClient: AxiosInstance };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secureStore = require('expo-secure-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { authService } = require('./AuthService');

  secureStore.getItemAsync.mockReset();
  secureStore.getItemAsync.mockResolvedValue('stored-token');
  authService.refreshToken.mockReset();
  authService.refreshToken.mockResolvedValue('new-token');
  authService.signOut.mockReset();
  authService.signOut.mockResolvedValue(undefined);

  const adapter: Adapter = jest.fn();
  apiClient.defaults.adapter = adapter as never;

  return { client: apiClient, adapter, secureStore, authService };
}

/**
 * Settles like a real adapter: axios applies validateStatus inside the
 * adapter, so a custom one has to reject non-2xx itself or nothing downstream
 * ever sees an error.
 */
function reply(config: InternalAxiosRequestConfig, status: number, data: unknown = {}): AxiosResponse {
  const response = { data, status, statusText: '', headers: {}, config } as AxiosResponse;
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  );
}

/** What the XHR adapter rejects with when the request never got a response. */
function networkError(config: InternalAxiosRequestConfig): Promise<never> {
  return Promise.reject(new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {}));
}

/** Runs `fn` while letting the retry backoff timers fire immediately. */
async function withoutBackoff<T>(fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    const promise = fn();
    // Interleave: each backoff sleep is scheduled only after the previous
    // attempt has rejected, so the timers have to be flushed repeatedly.
    for (let i = 0; i < 10; i++) {
      await jest.advanceTimersByTimeAsync(5000);
    }
    return await promise;
  } finally {
    jest.useRealTimers();
  }
}

describe('apiClient request interceptor', () => {
  it('attaches the stored access token as a Bearer header', async () => {
    const { client, adapter } = load();
    adapter.mockImplementation(async (config) => reply(config, 200));

    await client.get('/api/v1/groups');

    expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer stored-token');
  });

  it('sends no Authorization header when nothing is stored', async () => {
    const { client, adapter, secureStore } = load();
    secureStore.getItemAsync.mockResolvedValue(null);
    adapter.mockImplementation(async (config) => reply(config, 200));

    await client.get('/api/v1/groups');

    expect(adapter.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('surfaces a keychain failure as itself, not as a crash inside the retry path', async () => {
    // A rejected request interceptor skips the adapter entirely, so the error
    // reaching the response interceptor has neither a response NOR a config.
    // Anything that dereferences error.config there turns a readable keychain
    // error into "Cannot read properties of undefined" at every call site.
    const { client, adapter, secureStore } = load();
    const keychainFailure = new Error('User interaction is not allowed.');
    secureStore.getItemAsync.mockRejectedValue(keychainFailure);

    await expect(client.get('/api/v1/groups')).rejects.toBe(keychainFailure);
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe('apiClient retry policy', () => {
  it('retries a GET three times after network errors, then rejects', async () => {
    const { client, adapter } = load();
    adapter.mockImplementation((config) => networkError(config));

    await withoutBackoff(async () => {
      await expect(client.get('/api/v1/groups')).rejects.toMatchObject({ code: AxiosError.ERR_NETWORK });
    });

    expect(adapter).toHaveBeenCalledTimes(4); // original + 3 retries
  });

  it('retries a GET on 500 and returns the eventual success', async () => {
    const { client, adapter } = load();
    let calls = 0;
    adapter.mockImplementation(async (config) => reply(config, ++calls < 3 ? 500 : 200, { ok: true }));

    const res = await withoutBackoff(() => client.get('/api/v1/groups'));

    expect(res.data).toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx', async () => {
    const { client, adapter } = load();
    adapter.mockImplementation(async (config) => reply(config, 404));

    await expect(client.get('/api/v1/groups/missing')).rejects.toMatchObject({ response: { status: 404 } });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('never re-sends a POST, because a lost response is not proof of a lost write', async () => {
    // The request that times out in a dead zone may already have been
    // committed — the app just never saw the 201. Re-sending it creates a
    // second convoy / chat message / fuel log, and none of these routes is
    // idempotent server-side.
    const { client, adapter } = load();
    adapter.mockImplementation((config) => networkError(config));

    await withoutBackoff(async () => {
      await expect(client.post('/api/v1/groups', { name: 'Sunday Run' })).rejects.toMatchObject({
        code: AxiosError.ERR_NETWORK,
      });
    });

    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('never re-sends a POST on 5xx either', async () => {
    const { client, adapter } = load();
    adapter.mockImplementation(async (config) => reply(config, 502));

    await expect(client.post('/api/v1/groups/g1/messages', { text: 'hi' })).rejects.toMatchObject({
      response: { status: 502 },
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it.each(['put', 'patch', 'delete'] as const)('still retries %s, which is idempotent', async (method) => {
    const { client, adapter } = load();
    let calls = 0;
    adapter.mockImplementation(async (config) => reply(config, ++calls < 2 ? 500 : 200));

    await withoutBackoff(() => client[method]('/api/v1/settings', {}));

    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe('apiClient 401 handling', () => {
  it('refreshes once and replays the original request with the new token', async () => {
    const { client, adapter, secureStore, authService } = load();
    let calls = 0;
    adapter.mockImplementation(async (config) => {
      calls++;
      if (calls === 1) return reply(config, 401);
      secureStore.getItemAsync.mockResolvedValue('new-token');
      return reply(config, 200, { ok: true });
    });
    // The refresh writes the new token to the keychain; the replayed request
    // re-reads it there.
    authService.refreshToken.mockImplementation(async () => {
      secureStore.getItemAsync.mockResolvedValue('new-token');
      return 'new-token';
    });

    const res = await client.get('/api/v1/users/me');

    expect(res.data).toEqual({ ok: true });
    expect(authService.refreshToken).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[1][0].headers.Authorization).toBe('Bearer new-token');
    expect(authService.signOut).not.toHaveBeenCalled();
  });

  it('refreshes once for a burst of concurrent 401s and replays them all', async () => {
    const { client, adapter, authService } = load();
    const seen = new Set<string>();
    adapter.mockImplementation(async (config) => {
      const url = config.url as string;
      if (!seen.has(url)) {
        seen.add(url);
        return reply(config, 401);
      }
      return reply(config, 200, { url });
    });

    const results = await Promise.all([
      client.get('/api/v1/a'),
      client.get('/api/v1/b'),
      client.get('/api/v1/c'),
    ]);

    expect(results.map((r) => r.data)).toEqual([{ url: '/api/v1/a' }, { url: '/api/v1/b' }, { url: '/api/v1/c' }]);
    expect(authService.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('signs out when the refresh yields no token, and rejects the queued requests too', async () => {
    const { client, adapter, authService } = load();
    authService.refreshToken.mockResolvedValue(null);
    adapter.mockImplementation(async (config) => reply(config, 401));

    const first = client.get('/api/v1/a');
    const queued = client.get('/api/v1/b');

    await expect(first).rejects.toMatchObject({ response: { status: 401 } });
    await expect(queued).rejects.toThrow(/refresh failed/i);
    expect(authService.signOut).toHaveBeenCalled();
  });

  it('signs out when the refresh itself throws', async () => {
    const { client, adapter, authService } = load();
    const boom = new Error('refresh exploded');
    authService.refreshToken.mockRejectedValue(boom);
    adapter.mockImplementation(async (config) => reply(config, 401));

    await expect(client.get('/api/v1/a')).rejects.toBe(boom);
    expect(authService.signOut).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than looping when the replayed request 401s again', async () => {
    const { client, adapter, authService } = load();
    adapter.mockImplementation(async (config) => reply(config, 401));

    await expect(client.get('/api/v1/a')).rejects.toMatchObject({ response: { status: 401 } });

    expect(authService.refreshToken).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('recovers on the next request after a refresh failure signed the user out', async () => {
    const { client, adapter, authService } = load();
    authService.refreshToken.mockResolvedValueOnce(null);
    adapter.mockImplementation(async (config) => reply(config, config.url === '/api/v1/a' ? 401 : 200));

    await expect(client.get('/api/v1/a')).rejects.toBeDefined();
    // isRefreshing must have been released — otherwise every later request in
    // the session hangs forever on a queue nothing will ever drain.
    await expect(client.get('/api/v1/b')).resolves.toMatchObject({ status: 200 });
  });
});
