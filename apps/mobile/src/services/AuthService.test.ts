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

import * as SecureStore from 'expo-secure-store';

// ---------------------------------------------------------------
// Mock expo-secure-store
// ---------------------------------------------------------------
const mockSetItemAsync = jest.fn().mockResolvedValue(undefined);
const mockDeleteItemAsync = jest.fn().mockResolvedValue(undefined);
const mockGetItemAsync = jest.fn().mockResolvedValue(null);

jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./AuthService') as { authService: import('./AuthService').AuthService };
  return mod.authService;
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------
describe('AuthService — secure token storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

      expect(mockDeleteItemAsync).toHaveBeenCalledTimes(1);
      expect(mockDeleteItemAsync).toHaveBeenCalledWith('convoy_access_token');
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

  describe('loadStoredToken', () => {
    it('reads the token from SecureStore', async () => {
      mockGetItemAsync.mockResolvedValueOnce('stored_token_abc');

      const service = await getAuthService();
      const token = await service.loadStoredToken();

      expect(mockGetItemAsync).toHaveBeenCalledWith('convoy_access_token');
      expect(token).toBe('stored_token_abc');
    });

    it('returns null when no token is stored', async () => {
      mockGetItemAsync.mockResolvedValueOnce(null);

      const service = await getAuthService();
      const token = await service.loadStoredToken();

      expect(token).toBeNull();
    });

    it('does NOT read from AsyncStorage', async () => {
      mockGetItemAsync.mockResolvedValueOnce(null);

      const service = await getAuthService();
      await service.loadStoredToken();

      expect(mockAsyncStorageGetItemSpy).not.toHaveBeenCalled();
    });
  });
});
