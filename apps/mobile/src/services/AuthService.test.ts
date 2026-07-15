/**
 * Unit tests for AuthService — Task 3.3
 *
 * Validates:
 *  - verifyOtp stores the access token in SecureStore (not AsyncStorage)
 *  - signOut deletes the token from SecureStore (not AsyncStorage)
 *  - AsyncStorage is NEVER called for token storage operations
 *
 * Requirements: 38.4, 38.5
 */

// ---------------------------------------------------------------
// Mock expo-secure-store
// ---------------------------------------------------------------
const mockSetItemAsync = jest.fn().mockResolvedValue(undefined);
const mockDeleteItemAsync = jest.fn().mockResolvedValue(undefined);
// Key-aware rather than mockResolvedValueOnce-based: AuthService imports
// persist-backed zustand stores (e.g. recentDestinationsStore) whose hydration
// also calls getItemAsync at module load, which would consume queued
// one-shot values meant for the token key.
let storedAccessToken: string | null = null;
let storedOnboardingFlag: string | null = null;
const mockGetItemAsync = jest.fn((key: string) =>
  Promise.resolve(
    key === 'convoy_access_token'
      ? storedAccessToken
      : key === 'onboarding_complete'
        ? storedOnboardingFlag
        : null,
  ),
);

jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
  getItemAsync: (key: string) => mockGetItemAsync(key),
}));

// ---------------------------------------------------------------
// Spy on AsyncStorage to ensure it is NEVER used for tokens
// ---------------------------------------------------------------
const mockAsyncStorageSetItemSpy = jest.fn();
const mockAsyncStorageRemoveItemSpy = jest.fn();
const mockAsyncStorageGetItemSpy = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: (...args: unknown[]) => mockAsyncStorageSetItemSpy(...args),
  removeItem: (...args: unknown[]) => mockAsyncStorageRemoveItemSpy(...args),
  getItem: (...args: unknown[]) => mockAsyncStorageGetItemSpy(...args),
  multiSet: jest.fn(),
  multiRemove: jest.fn(),
  multiGet: jest.fn(),
// virtual: module is not installed; jest resolves the factory without hitting the filesystem
}), { virtual: true });

// ---------------------------------------------------------------
// Mock zustand auth store (used by signOut and refreshToken)
// ---------------------------------------------------------------
const mockStoreSignOut = jest.fn();
const mockStoreSetAccessToken = jest.fn();

jest.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      signOut: mockStoreSignOut,
      setAccessToken: mockStoreSetAccessToken,
    }),
  },
}));

// ---------------------------------------------------------------
// Mock global fetch for API calls
// ---------------------------------------------------------------
const MOCK_ACCESS_TOKEN = 'test_access_token_xyz';
const MOCK_USER = {
  id: 'user-123',
  displayName: 'Test Driver',
  phoneNumber: '+15550001234',
  privacy: 'open' as const,
};

function createFetchMock(overrides: Partial<{ accessToken: string; user: object }> = {}) {
  const accessToken = overrides.accessToken ?? MOCK_ACCESS_TOKEN;
  const user = overrides.user ?? MOCK_USER;

  return jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ accessToken, user }),
  });
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function getAuthService() {
  // Use require() so jest.resetModules() takes effect; dynamic import() requires
  // --experimental-vm-modules which is unavailable in this jest setup.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./AuthService') as { authService: import('./AuthService').AuthService };
  return mod.authService;
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------
describe('AuthService — secure token storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storedAccessToken = null;
    storedOnboardingFlag = null;
  });

  describe('verifyOtp', () => {
    it('stores the access token in SecureStore with key "convoy_access_token"', async () => {
      const globalFetch = createFetchMock();
      global.fetch = globalFetch;

      const service = await getAuthService();
      const result = await service.verifyOtp('+15550001234', '123456');

      // Token should be in SecureStore
      expect(mockSetItemAsync).toHaveBeenCalledTimes(1);
      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);

      // Returned result should contain the token and user
      expect(result.accessToken).toBe(MOCK_ACCESS_TOKEN);
      expect(result.user).toEqual(MOCK_USER);
    });

    it('does NOT store the token in AsyncStorage', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.verifyOtp('+15550001234', '654321');

      expect(mockAsyncStorageSetItemSpy).not.toHaveBeenCalled();
      expect(mockAsyncStorageRemoveItemSpy).not.toHaveBeenCalled();
      expect(mockAsyncStorageGetItemSpy).not.toHaveBeenCalled();
    });
  });

  describe('signOut', () => {
    it('deletes the token from SecureStore', async () => {
      // Simulate a logout API response
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const service = await getAuthService();
      await service.signOut();

      // Also clears the device-global 'onboarding_complete' flag so the next
      // account signed into this device doesn't inherit a prior user's
      // completed-onboarding state.
      expect(mockDeleteItemAsync).toHaveBeenCalledTimes(2);
      expect(mockDeleteItemAsync).toHaveBeenCalledWith('convoy_access_token');
      expect(mockDeleteItemAsync).toHaveBeenCalledWith('onboarding_complete');
    });

    it('deletes token from SecureStore even when the logout API call fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const service = await getAuthService();
      await service.signOut();

      // Token should still be cleaned up locally
      expect(mockDeleteItemAsync).toHaveBeenCalledWith('convoy_access_token');
    });

    it('does NOT touch AsyncStorage when signing out', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const service = await getAuthService();
      await service.signOut();

      expect(mockAsyncStorageSetItemSpy).not.toHaveBeenCalled();
      expect(mockAsyncStorageRemoveItemSpy).not.toHaveBeenCalled();
      expect(mockAsyncStorageGetItemSpy).not.toHaveBeenCalled();
    });

    it('clears the auth store after signing out', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const service = await getAuthService();
      await service.signOut();

      expect(mockStoreSignOut).toHaveBeenCalledTimes(1);
    });

    it('does not reject and still resets stores when the SecureStore token delete fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // Every keychain delete (token AND onboarding flag) rejects.
      mockDeleteItemAsync.mockRejectedValue(new Error('keychain unavailable'));

      const service = await getAuthService();
      // Error contract: signOut() never rejects — local-cleanup failures are
      // logged and swallowed because no caller can act on them.
      await expect(service.signOut()).resolves.toBeUndefined();

      // The per-account store resets must still have run.
      expect(mockStoreSignOut).toHaveBeenCalledTimes(1);
      // Restore the default resolved behavior for subsequent tests.
      mockDeleteItemAsync.mockResolvedValue(undefined);
      warnSpy.mockRestore();
    });

    it('resets account-level settings (but keeps device-level themeMode) on sign-out', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const service = await getAuthService();
      // Grab the same (post-resetModules) settingsStore instance AuthService uses.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useSettingsStore } = require('../stores/settingsStore') as typeof import('../stores/settingsStore');
      useSettingsStore.setState({
        mapStyle: 'satellite',
        hazardAlertDistanceM: 1609,
        scenicRouting: true,
        shareLocationWithFriends: true, // privacy toggle — must never leak across accounts
        distanceUnit: 'km',
        themeMode: 'dark', // device-level — must survive sign-out
      });

      await service.signOut();

      const s = useSettingsStore.getState();
      expect(s.mapStyle).toBe('standard');
      expect(s.hazardAlertDistanceM).toBe(805);
      expect(s.scenicRouting).toBe(false);
      expect(s.shareLocationWithFriends).toBe(false);
      expect(s.distanceUnit).toBe('miles');
      expect(s.themeMode).toBe('dark');
    });

    it('runs the remaining store resets even if one reset throws', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // authStore reset (first in the list) blows up…
      mockStoreSignOut.mockImplementationOnce(() => {
        throw new Error('authStore reset failed');
      });

      const service = await getAuthService();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useSettingsStore } = require('../stores/settingsStore') as typeof import('../stores/settingsStore');
      useSettingsStore.setState({ shareLocationWithFriends: true });

      // …but signOut still resolves and the later resets (settingsStore is
      // last in the list) still run.
      await expect(service.signOut()).resolves.toBeUndefined();
      expect(useSettingsStore.getState().shareLocationWithFriends).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('signInEmail', () => {
    it('stores the access token in SecureStore', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signInEmail('test@example.com', 'password123');

      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);
    });

    it('does NOT use AsyncStorage for token storage', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signInEmail('test@example.com', 'password123');

      expect(mockAsyncStorageSetItemSpy).not.toHaveBeenCalled();
    });
  });

  describe('signUpEmail', () => {
    it('stores the access token in SecureStore', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signUpEmail('new@example.com', 'newpassword123');

      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);
    });

    it('does NOT use AsyncStorage for token storage', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signUpEmail('new@example.com', 'newpassword123');

      expect(mockAsyncStorageSetItemSpy).not.toHaveBeenCalled();
    });
  });

  describe('signInSocial', () => {
    it('stores the access token in SecureStore for Apple sign-in', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signInSocial('apple', 'apple_id_token_abc');

      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);
    });

    it('stores the access token in SecureStore for Google sign-in', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signInSocial('google', 'google_id_token_xyz');

      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);
    });

    it('does NOT use AsyncStorage for token storage on social sign-in', async () => {
      global.fetch = createFetchMock();

      const service = await getAuthService();
      await service.signInSocial('google', 'google_id_token_xyz');

      expect(mockAsyncStorageSetItemSpy).not.toHaveBeenCalled();
    });
  });

  describe('signInWithGoogle', () => {
    it('exchanges the ID token via /auth/social and stores the token in SecureStore', async () => {
      const globalFetch = createFetchMock();
      global.fetch = globalFetch;

      const service = await getAuthService();
      const result = await service.signInWithGoogle('google_id_token_xyz');

      // Same exchange endpoint and provider tag as the rest of social auth.
      const [url, init] = globalFetch.mock.calls[0] as [string, { body: string }];
      expect(url).toContain('/api/v1/auth/social');
      expect(JSON.parse(init.body)).toEqual({ provider: 'google', idToken: 'google_id_token_xyz' });

      expect(mockSetItemAsync).toHaveBeenCalledWith('convoy_access_token', MOCK_ACCESS_TOKEN);
      expect(result.accessToken).toBe(MOCK_ACCESS_TOKEN);
      expect(result.user).toEqual(MOCK_USER);
    });
  });

  describe('loadStoredToken', () => {
    it('reads the token from SecureStore', async () => {
      storedAccessToken = 'stored_token_abc';

      const service = await getAuthService();
      const token = await service.loadStoredToken();

      expect(mockGetItemAsync).toHaveBeenCalledWith('convoy_access_token');
      expect(token).toBe('stored_token_abc');
    });

    it('returns null when no token is stored', async () => {
      storedAccessToken = null;

      const service = await getAuthService();
      const token = await service.loadStoredToken();

      expect(token).toBeNull();
    });

    it('does NOT read from AsyncStorage', async () => {
      storedAccessToken = null;

      const service = await getAuthService();
      await service.loadStoredToken();

      expect(mockAsyncStorageGetItemSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------
  // API error surfacing (Req 2.7 / 2.8) — the server's explanation must reach
  // the user, whichever of the API's two error envelopes carried it.
  // -------------------------------------------------------------
  describe('API error message extraction', () => {
    function createErrorFetchMock(status: number, body: unknown) {
      return jest.fn().mockResolvedValue({
        ok: false,
        status,
        json: () => Promise.resolve(body),
      });
    }

    it('surfaces the nested { error: { message } } envelope (wrong/expired OTP, 422)', async () => {
      global.fetch = createErrorFetchMock(422, {
        error: { code: 'INVALID_OTP', message: 'Invalid or expired OTP. Please request a new one.', retryable: true },
      });

      const service = await getAuthService();
      await expect(service.verifyOtp('+15550001234', '000000')).rejects.toThrow(
        'Invalid or expired OTP. Please request a new one.',
      );
    });

    it('surfaces the nested envelope for invalid email credentials (401)', async () => {
      global.fetch = createErrorFetchMock(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });

      const service = await getAuthService();
      await expect(service.signInEmail('a@b.com', 'wrong-password')).rejects.toThrow('Invalid credentials');
    });

    it('surfaces the nested envelope for duplicate email signup (409)', async () => {
      global.fetch = createErrorFetchMock(409, {
        error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' },
      });

      const service = await getAuthService();
      await expect(service.signUpEmail('a@b.com', 'password123')).rejects.toThrow(
        'An account with this email already exists.',
      );
    });

    it('surfaces top-level messages from @fastify/sensible replies (429 rate limit)', async () => {
      global.fetch = createErrorFetchMock(429, {
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many OTP requests. Please try again later.',
      });

      const service = await getAuthService();
      await expect(service.requestOtp('+15550001234')).rejects.toThrow(
        'Too many OTP requests. Please try again later.',
      );
    });

    it('attaches the HTTP status to the thrown error (ApiError shape)', async () => {
      global.fetch = createErrorFetchMock(503, {
        error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Google sign-in is not available on this server.' },
      });

      const service = await getAuthService();
      await expect(service.signInSocial('google', 'tok')).rejects.toMatchObject({
        message: 'Google sign-in is not available on this server.',
        status: 503,
      });
    });

    it('falls back to a generic message when the error body is unparseable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      });

      const service = await getAuthService();
      await expect(service.requestOtp('+15550001234')).rejects.toThrow('Request failed');
    });
  });

  // -------------------------------------------------------------
  // Post-auth routing (Req 36.7) — shared across OTP, email, and social
  // sign-in so onboarding is never skipped for a first-time user.
  // -------------------------------------------------------------
  describe('getPostAuthRoute', () => {
    afterEach(() => {
      // Restore the key-aware defaults — jest.clearAllMocks() clears calls but
      // not implementations swapped in by individual tests below.
      mockGetItemAsync.mockImplementation((key: string) =>
        Promise.resolve(
          key === 'convoy_access_token'
            ? storedAccessToken
            : key === 'onboarding_complete'
              ? storedOnboardingFlag
              : null,
        ),
      );
      mockAsyncStorageGetItemSpy.mockReset();
    });

    it('routes to the map without first-login when onboarding is already complete', async () => {
      storedOnboardingFlag = '1';

      const service = await getAuthService();
      await expect(service.getPostAuthRoute()).resolves.toEqual({
        route: '/(tabs)/map',
        isFirstLogin: false,
      });
    });

    it('routes a brand-new user into onboarding at the vehicle step', async () => {
      storedOnboardingFlag = null;
      // No onboarding steps recorded — onboardingState resumes from the start.
      mockAsyncStorageGetItemSpy.mockResolvedValue(null);

      const service = await getAuthService();
      await expect(service.getPostAuthRoute()).resolves.toEqual({
        route: '/(onboarding)/vehicle',
        isFirstLogin: true,
      });
    });

    it('resumes a returning-but-incomplete user at the next unfinished step', async () => {
      storedOnboardingFlag = null;
      mockAsyncStorageGetItemSpy.mockImplementation((key: string) =>
        Promise.resolve(key === '@convoy/onboarding_completed' ? JSON.stringify(['vehicle']) : null),
      );

      const service = await getAuthService();
      await expect(service.getPostAuthRoute()).resolves.toEqual({
        route: '/(onboarding)/ptt-tutorial',
        isFirstLogin: true,
      });
    });

    it('treats a keychain read failure as onboarding-complete (never traps existing users)', async () => {
      mockGetItemAsync.mockImplementation((key: string) =>
        key === 'onboarding_complete'
          ? Promise.reject(new Error('keychain unavailable'))
          : Promise.resolve(null),
      );

      const service = await getAuthService();
      await expect(service.getPostAuthRoute()).resolves.toEqual({
        route: '/(tabs)/map',
        isFirstLogin: false,
      });
    });
  });
});
