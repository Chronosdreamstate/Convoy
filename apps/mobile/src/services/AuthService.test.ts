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
// These resolve rather than returning undefined: production code chains
// `.catch()` straight onto setItem/removeItem (the offline request queue and
// the analytics queue both do), which throws on a bare jest.fn().
const mockAsyncStorageSetItemSpy = jest.fn().mockResolvedValue(undefined);
const mockAsyncStorageRemoveItemSpy = jest.fn().mockResolvedValue(undefined);
const mockAsyncStorageGetItemSpy = jest.fn().mockResolvedValue(null);
// signOut also sweeps the per-account AsyncStorage caches that live outside
// the zustand stores (Notification Center, recent searches, convoy counters).
const mockAsyncStorageMultiRemoveSpy = jest.fn().mockResolvedValue(undefined);
let storedAsyncKeys: string[] = [];
const mockAsyncStorageGetAllKeysSpy = jest.fn(() => Promise.resolve(storedAsyncKeys));

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: (...args: unknown[]) => mockAsyncStorageSetItemSpy(...args),
  removeItem: (...args: unknown[]) => mockAsyncStorageRemoveItemSpy(...args),
  getItem: (...args: unknown[]) => mockAsyncStorageGetItemSpy(...args),
  multiSet: jest.fn(),
  multiRemove: (...args: unknown[]) => mockAsyncStorageMultiRemoveSpy(...args),
  multiGet: jest.fn(),
  getAllKeys: () => mockAsyncStorageGetAllKeysSpy(),
// virtual: module is not installed; jest resolves the factory without hitting the filesystem
}), { virtual: true });

// ---------------------------------------------------------------
// Mock expo-sqlite — signOut wipes the offline hazard/drive/position queue,
// which would otherwise replay under the NEXT account's token.
// ---------------------------------------------------------------
const mockSqlExecAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(() =>
    Promise.resolve({
      execAsync: (...args: unknown[]) => mockSqlExecAsync(...args),
      runAsync: jest.fn().mockResolvedValue(undefined),
      getAllAsync: jest.fn().mockResolvedValue([]),
    }),
  ),
}));

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

    // The point of this test is the TOKEN: it lives in SecureStore and must
    // never be written to, read from, or deleted from AsyncStorage. signOut
    // does legitimately touch AsyncStorage for the per-account caches and
    // queues it has to clear (multiRemove, and removeItem for the two queue
    // keys), so assert on the key rather than on the module.
    it('never routes the access token through AsyncStorage when signing out', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const service = await getAuthService();
      await service.signOut();

      const touchedKeys = [
        ...mockAsyncStorageSetItemSpy.mock.calls,
        ...mockAsyncStorageRemoveItemSpy.mock.calls,
        ...mockAsyncStorageGetItemSpy.mock.calls,
      ].map(([key]) => key);
      expect(touchedKeys).not.toContain('convoy_access_token');
      expect(mockAsyncStorageMultiRemoveSpy.mock.calls.flat(2)).not.toContain(
        'convoy_access_token',
      );
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

// ---------------------------------------------------------------
// Sign-out — per-account state that lives OUTSIDE the zustand stores
// ---------------------------------------------------------------
describe('AuthService.signOut — per-account cleanup beyond the stores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storedAccessToken = null;
    storedOnboardingFlag = null;
    storedAsyncKeys = [];
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  });

  /** Flattened list of every key passed to AsyncStorage.multiRemove. */
  function removedKeys(): string[] {
    return mockAsyncStorageMultiRemoveSpy.mock.calls.flatMap(
      (call) => (call[0] as string[] | undefined) ?? [],
    );
  }

  it('drops the Notification Center cache so the next account never sees the previous one\'s alerts', async () => {
    const service = await getAuthService();
    await service.signOut();

    // NotificationCenterScreen renders this cache immediately on mount
    // (loadCached), so leaving it behind showed account B account A's SOS
    // alerts, friend requests and group invites.
    expect(removedKeys()).toContain('convoy:notifications');
  });

  it('drops the other un-namespaced per-account caches', async () => {
    const service = await getAuthService();
    await service.signOut();

    const removed = removedKeys();
    expect(removed).toContain('convoy:recent_searches');
    // Drive counters / achievement / review-prompt state: without this the next
    // account inherits A's convoy count and never gets the first-convoy moment.
    expect(removed).toContain('convoy:completed_count');
    expect(removed).toContain('achievement:first_convoy');
    expect(removed).toContain('convoy:has_reviewed');
    expect(removed).toContain('convoy:review_prompted');
  });

  it('sweeps the per-drive photo caches by prefix', async () => {
    storedAsyncKeys = [
      'convoy:drive:drive-1:photos',
      'convoy:drive:drive-2:photos',
      '@convoy/anon_id',
    ];

    const service = await getAuthService();
    await service.signOut();

    const removed = removedKeys();
    expect(removed).toContain('convoy:drive:drive-1:photos');
    expect(removed).toContain('convoy:drive:drive-2:photos');
    // Device-level keys (anonymous analytics id) are deliberately preserved.
    expect(removed).not.toContain('@convoy/anon_id');
  });

  it('still clears the fixed key list when getAllKeys fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAsyncStorageGetAllKeysSpy.mockRejectedValueOnce(new Error('storage unavailable'));

    const service = await getAuthService();
    await expect(service.signOut()).resolves.toBeUndefined();

    expect(removedKeys()).toContain('convoy:notifications');
    warnSpy.mockRestore();
  });

  it('wipes the offline SQLite queue so it cannot replay under the next account', async () => {
    const service = await getAuthService();
    await service.signOut();

    // offline_hazards / offline_drives / last_positions are keyed by hazard,
    // drive and group id — never by user — so SyncService would bulk-POST the
    // signed-out account's reports and drives as if they were the new user's.
    const sql = mockSqlExecAsync.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(sql).toContain('DELETE FROM offline_hazards');
    expect(sql).toContain('DELETE FROM offline_drives');
    expect(sql).toContain('DELETE FROM last_positions');
  });

  it('does not reject when the offline queue wipe fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSqlExecAsync.mockRejectedValue(new Error('database locked'));

    const service = await getAuthService();
    await expect(service.signOut()).resolves.toBeUndefined();

    // The store resets after it must still have run.
    expect(mockStoreSignOut).toHaveBeenCalledTimes(1);
    mockSqlExecAsync.mockResolvedValue(undefined);
    warnSpy.mockRestore();
  });

  it('clears the PTT talk-time leaderboard', async () => {
    const service = await getAuthService();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pttAnalytics } = require('./PTTAnalyticsService') as typeof import('./PTTAnalyticsService');
    pttAnalytics.recordTransmit('user-a', 'RED LEADER', 4_000);
    expect(pttAnalytics.getLeaderboard()).toHaveLength(1);

    await service.signOut();

    // getLeaderboard() returns everything ever recorded, so the first transmit
    // in the next account's convoy would otherwise render A's members.
    expect(pttAnalytics.getLeaderboard()).toHaveLength(0);
  });

  it('parks the shared motion state so a sign-out mid-drive does not block the next account', async () => {
    const service = await getAuthService();
    // Same post-resetModules instances AuthService itself imported.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sharedMotionState } = require('./MotionStateService') as typeof import('./MotionStateService');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useMotionStore } = require('../stores/motionStore') as typeof import('../stores/motionStore');

    sharedMotionState.update(30); // driving
    expect(useMotionStore.getState().isInMotion).toBe(true);

    await service.signOut();

    // The GPS feed stops with the session, so the 3-slow-sample hysteresis can
    // never settle — account B would inherit "you can't do this while driving"
    // on their profile/garage edits (Req 34) with no way to clear it.
    expect(useMotionStore.getState().isInMotion).toBe(false);
    expect(sharedMotionState.state).toBe('parked');
  });

  // ---------------------------------------------------------------
  // Cross-account replay: there are THREE queues that outlive sign-out, and
  // only the SQLite one was being cleared. The other two persist to
  // AsyncStorage and carry NO auth header of their own — apiClient injects
  // whatever bearer token is current when they drain — so anything still in
  // them after A signs out is sent as, and recorded against, account B.
  // ---------------------------------------------------------------
  it('clears the offline request queue so queued writes are not replayed as the next account', async () => {
    const service = await getAuthService();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { offlineQueue } = require('./OfflineQueueService') as typeof import('./OfflineQueueService');

    // A reports a speed camera and votes on a hazard while in a dead zone.
    await offlineQueue.enqueue({
      method: 'POST',
      url: '/api/v1/speed-cameras',
      body: { type: 'fixed' },
      headers: {},
    });
    await offlineQueue.enqueue({
      method: 'POST',
      url: '/api/v1/speed-cameras/cam-1/vote',
      body: { vote: 'up' },
      headers: {},
    });
    expect(offlineQueue.size).toBe(2);

    await service.signOut();

    // Both the in-memory queue and its persisted copy must go: B signing in on
    // this phone would otherwise become the reporter of A's speed camera and
    // the author of A's vote.
    expect(offlineQueue.size).toBe(0);
    expect(mockAsyncStorageRemoveItemSpy).toHaveBeenCalledWith('@convoy/offline_request_queue');
  });

  it('clears the analytics queue, in memory as well as on disk', async () => {
    const service = await getAuthService();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { analytics } = require('./AnalyticsService') as typeof import('./AnalyticsService');

    analytics.track({ name: 'group_created', props: {} });
    analytics.track({ name: 'friend_added', props: {} });

    await service.signOut();

    expect(mockAsyncStorageRemoveItemSpy).toHaveBeenCalledWith('@convoy/analytics_queue');

    // Clearing only the storage key is not enough — the singleton outlives
    // sign-out, so A's events would still be in memory for B's next track() to
    // persist straight back. Proven via flush(): with the queue truly empty it
    // is a no-op, so nothing is POSTed under B's token.
    mockAsyncStorageSetItemSpy.mockClear();
    const postSpy = jest.fn().mockResolvedValue({ data: {} });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { apiClient } = require('./apiClient') as { apiClient: { post: unknown } };
    apiClient.post = postSpy;

    await analytics.flush();

    expect(postSpy).not.toHaveBeenCalled();
  });
});
