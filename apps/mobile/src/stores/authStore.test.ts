/**
 * Unit tests for the auth store.
 *
 * Covers:
 *  - setUser toggles isAuthenticated and donates Siri shortcuts on sign-in
 *  - setAccessToken / setToken keep both alias fields in sync
 *  - signOut / clear / logout reset auth state (but not isLoading)
 *  - refreshToken success: persists the new token to SecureStore under
 *    'convoy_access_token' (the key apiClient reads) BEFORE resolving,
 *    and updates both token fields
 *  - refreshToken failure paths (non-OK response, network error) sign out
 *  - refreshToken still succeeds when SecureStore persistence fails
 *  - handleUnauthorized only refreshes on 401 responses
 */

const mockSetItemAsync = jest.fn().mockResolvedValue(undefined);
const mockGetItemAsync = jest.fn().mockResolvedValue(null);
const mockDeleteItemAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}));

const mockDonateAll = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/SiriShortcutsService', () => ({
  SiriShortcutsService: {
    donateAll: (...args: unknown[]) => mockDonateAll(...args),
  },
}));

import { useAuthStore, User } from './authStore';

const TEST_USER: User = {
  id: 'u-1',
  displayName: 'Test Driver',
  privacy: 'open',
};

function resetStore() {
  useAuthStore.setState({
    user: null,
    accessToken: null,
    token: null,
    isLoading: true,
    isAuthenticated: false,
    isFirstLogin: false,
  });
}

let mockFetch: jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

describe('setUser', () => {
  it('sets the user and isAuthenticated, and donates Siri shortcuts', () => {
    useAuthStore.getState().setUser(TEST_USER);

    const s = useAuthStore.getState();
    expect(s.user).toEqual(TEST_USER);
    expect(s.isAuthenticated).toBe(true);
    expect(mockDonateAll).toHaveBeenCalledTimes(1);
  });

  it('setUser(null) clears authentication and does not donate shortcuts', () => {
    useAuthStore.getState().setUser(TEST_USER);
    mockDonateAll.mockClear();

    useAuthStore.getState().setUser(null);

    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(mockDonateAll).not.toHaveBeenCalled();
  });
});

describe('token aliases', () => {
  it('setAccessToken updates both accessToken and token', () => {
    useAuthStore.getState().setAccessToken('tok-1');
    expect(useAuthStore.getState().accessToken).toBe('tok-1');
    expect(useAuthStore.getState().token).toBe('tok-1');
  });

  it('setToken updates both accessToken and token', () => {
    useAuthStore.getState().setToken('tok-2');
    expect(useAuthStore.getState().accessToken).toBe('tok-2');
    expect(useAuthStore.getState().token).toBe('tok-2');
  });

  it('clearing via setAccessToken(null) clears both fields', () => {
    useAuthStore.getState().setAccessToken('tok-3');
    useAuthStore.getState().setAccessToken(null);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });
});

describe.each(['signOut', 'clear', 'logout'] as const)('%s', (method) => {
  it('resets user, tokens, isAuthenticated and isFirstLogin', () => {
    useAuthStore.setState({
      user: TEST_USER,
      accessToken: 'tok',
      token: 'tok',
      isAuthenticated: true,
      isFirstLogin: true,
      isLoading: false,
    });

    useAuthStore.getState()[method]();

    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.accessToken).toBeNull();
    expect(s.token).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(s.isFirstLogin).toBe(false);
    // isLoading is intentionally untouched by sign-out
    expect(s.isLoading).toBe(false);
  });
});

describe('refreshToken', () => {
  it('on success: updates both token fields, persists to SecureStore, returns true', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'fresh-token' }), { status: 200 }),
    );

    const ok = await useAuthStore.getState().refreshToken();

    expect(ok).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
    expect(useAuthStore.getState().token).toBe('fresh-token');
    // Persisted under the exact key apiClient reads on every request
    expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', 'fresh-token');

    // Sends the HttpOnly refresh cookie
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/auth\/refresh$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('on non-OK response: signs out and returns false', async () => {
    useAuthStore.setState({ user: TEST_USER, accessToken: 'old', token: 'old', isAuthenticated: true });
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }));

    const ok = await useAuthStore.getState().refreshToken();

    expect(ok).toBe(false);
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.accessToken).toBeNull();
    expect(s.isAuthenticated).toBe(false);
  });

  it('on network error: signs out and returns false', async () => {
    useAuthStore.setState({ accessToken: 'old', token: 'old', isAuthenticated: true });
    mockFetch.mockRejectedValue(new Error('offline'));

    const ok = await useAuthStore.getState().refreshToken();

    expect(ok).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('still succeeds when SecureStore persistence fails (best-effort persist)', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'fresh-token' }), { status: 200 }),
    );
    mockSetItemAsync.mockRejectedValueOnce(new Error('keychain locked'));

    const ok = await useAuthStore.getState().refreshToken();

    expect(ok).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
  });
});

describe('handleUnauthorized', () => {
  it('returns false without refreshing for non-401 responses', async () => {
    const result = await useAuthStore.getState().handleUnauthorized(
      new Response('server error', { status: 500 }),
    );
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('attempts a refresh for 401 responses and returns its outcome', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'renewed' }), { status: 200 }),
    );

    const result = await useAuthStore.getState().handleUnauthorized(
      new Response('unauthorized', { status: 401 }),
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe('renewed');
  });

  it('signs out when the 401-triggered refresh fails', async () => {
    useAuthStore.setState({ user: TEST_USER, accessToken: 'stale', token: 'stale', isAuthenticated: true });
    mockFetch.mockResolvedValue(new Response('nope', { status: 403 }));

    const result = await useAuthStore.getState().handleUnauthorized(
      new Response('unauthorized', { status: 401 }),
    );

    expect(result).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
