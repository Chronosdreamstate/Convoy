/**
 * Property tests for AuthService.
 *
 * Property 113: Any access token returned by the server is stored verbatim in SecureStore
 *   verifyOtp / signInEmail / signUpEmail / signInSocial write exactly the token
 *   string returned by the API — no mutation, no truncation.
 *   Validates: Requirements 38.4, 38.5
 *
 * Property 114: loadStoredToken is the exact inverse of SecureStore.setItemAsync
 *   Whatever was stored is retrieved unchanged for any arbitrary token string.
 *   Validates: Requirements 38.4
 *
 * Property 115: signOut always removes the token and clears the auth store
 *   regardless of whether the logout API call succeeds or fails.
 *   Validates: Requirements 38.5
 *
 * Property 116: refreshToken stores the new token returned by the server
 *   After a successful refresh, SecureStore holds the new token, not the old one.
 *   Validates: Requirements 38.2
 *
 * Property 117: signInSocial forwards provider and idToken to the API body unchanged
 *   For any non-empty idToken and any supported provider, the fetch body contains
 *   exactly those values.
 *   Validates: Requirements 38.1
 */

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mocks — factory functions must not reference out-of-scope variables;
// implementations are injected per-test via mockImplementation.
// ---------------------------------------------------------------------------

const mockSecureStoreSet = jest.fn();
const mockSecureStoreDel = jest.fn();
const mockSecureStoreGet = jest.fn();

jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSecureStoreSet(...args),
  deleteItemAsync: (...args: unknown[]) => mockSecureStoreDel(...args),
  getItemAsync: (...args: unknown[]) => mockSecureStoreGet(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  removeItem: jest.fn(),
  getItem: jest.fn(),
  multiSet: jest.fn(),
  multiRemove: jest.fn(),
  multiGet: jest.fn(),
}), { virtual: true });

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'convoy_access_token';

const MOCK_USER = {
  id: 'user-1',
  displayName: 'Test User',
  phoneNumber: '+15550001234',
  privacy: 'open' as const,
};

function fetchReturning(accessToken: string): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ accessToken, user: MOCK_USER }),
  });
}

function fetchFailing(): jest.Mock {
  return jest.fn().mockRejectedValue(new Error('network error'));
}

function getService() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./AuthService') as { authService: import('./AuthService').AuthService };
  return mod.authService;
}

/** In-memory SecureStore — wired up via mockImplementation in beforeEach. */
function makeInMemoryStore() {
  const store = new Map<string, string>();
  mockSecureStoreSet.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
  });
  mockSecureStoreDel.mockImplementation(async (key: string) => {
    store.delete(key);
  });
  mockSecureStoreGet.mockImplementation(async (key: string) => store.get(key) ?? null);
  return store;
}

// Printable ASCII token strings (non-empty, up to 256 chars — realistic JWT range)
const fcToken = fc.string({ minLength: 1, maxLength: 256 }).filter((s) => s.trim().length > 0);

// Non-empty idToken strings for social sign-in
const fcIdToken = fc.string({ minLength: 10, maxLength: 256 }).filter((s) => s.trim().length > 0);

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Property 113: Any access token is stored verbatim — no mutation
// ---------------------------------------------------------------------------

describe('Property 113: Access token returned by server is stored verbatim in SecureStore', () => {
  it('verifyOtp stores the exact token string for any token value', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        global.fetch = fetchReturning(token);
        const svc = getService();
        const result = await svc.verifyOtp('+15550001234', '123456');
        expect(store.get(TOKEN_KEY)).toBe(token);
        expect(result.accessToken).toBe(token);
      }),
      { numRuns: 50 },
    );
  });

  it('signInEmail stores the exact token string for any token value', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        global.fetch = fetchReturning(token);
        const svc = getService();
        const result = await svc.signInEmail('user@example.com', 'pass');
        expect(store.get(TOKEN_KEY)).toBe(token);
        expect(result.accessToken).toBe(token);
      }),
      { numRuns: 50 },
    );
  });

  it('signUpEmail stores the exact token string for any token value', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        global.fetch = fetchReturning(token);
        const svc = getService();
        const result = await svc.signUpEmail('new@example.com', 'pass');
        expect(store.get(TOKEN_KEY)).toBe(token);
        expect(result.accessToken).toBe(token);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: loadStoredToken is the exact inverse of SecureStore
// ---------------------------------------------------------------------------

describe('Property 114: loadStoredToken returns whatever SecureStore holds — exact round-trip', () => {
  it('returns null when nothing is stored', async () => {
    makeInMemoryStore();
    const svc = getService();
    expect(await svc.loadStoredToken()).toBeNull();
  });

  it('returns the exact string that was pre-stored for any token value', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        store.set(TOKEN_KEY, token); // pre-populate
        const svc = getService();
        expect(await svc.loadStoredToken()).toBe(token);
      }),
      { numRuns: 100 },
    );
  });

  it('returns null after the token has been deleted', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        store.set(TOKEN_KEY, token);
        store.delete(TOKEN_KEY);
        const svc = getService();
        expect(await svc.loadStoredToken()).toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 115: signOut always removes the token and clears the auth store
// ---------------------------------------------------------------------------

describe('Property 115: signOut always clears SecureStore and auth store regardless of API outcome', () => {
  it('removes token when logout API succeeds — for any pre-stored token', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        store.set(TOKEN_KEY, token);
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        const svc = getService();
        await svc.signOut();
        expect(store.has(TOKEN_KEY)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('removes token even when logout API throws a network error', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (token) => {
        const store = makeInMemoryStore();
        store.set(TOKEN_KEY, token);
        global.fetch = fetchFailing();
        const svc = getService();
        await svc.signOut();
        expect(store.has(TOKEN_KEY)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('always calls storeSignOut() regardless of API success or failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcToken,
        fc.boolean(),
        async (token, apiSucceeds) => {
          mockStoreSignOut.mockClear();
          const store = makeInMemoryStore();
          store.set(TOKEN_KEY, token);
          global.fetch = apiSucceeds
            ? jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
            : fetchFailing();
          const svc = getService();
          await svc.signOut();
          expect(mockStoreSignOut).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: refreshToken stores the new token returned by the server
// ---------------------------------------------------------------------------

describe('Property 116: refreshToken stores the new server-returned token in SecureStore', () => {
  it('stores the new token for any (old → new) token pair', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcToken,
        fcToken,
        async (oldToken, newToken) => {
          fc.pre(oldToken !== newToken);
          const store = makeInMemoryStore();
          store.set(TOKEN_KEY, oldToken);
          global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ accessToken: newToken }),
          });
          const svc = getService();
          const returned = await svc.refreshToken();
          expect(returned).toBe(newToken);
          expect(store.get(TOKEN_KEY)).toBe(newToken);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns null and leaves SecureStore unchanged when refresh API fails', async () => {
    await fc.assert(
      fc.asyncProperty(fcToken, async (oldToken) => {
        const store = makeInMemoryStore();
        store.set(TOKEN_KEY, oldToken);
        global.fetch = fetchFailing();
        const svc = getService();
        const result = await svc.refreshToken();
        expect(result).toBeNull();
        expect(store.get(TOKEN_KEY)).toBe(oldToken);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 117: signInSocial forwards provider and idToken to the API unchanged
// ---------------------------------------------------------------------------

describe('Property 117: signInSocial forwards provider and idToken to fetch body unchanged', () => {
  it('request body contains the exact idToken for any non-empty token string and provider', async () => {
    await fc.assert(
      fc.asyncProperty(
        fcIdToken,
        fc.constantFrom('apple' as const, 'google' as const),
        async (idToken, provider) => {
          makeInMemoryStore();
          const capturedBodies: unknown[] = [];
          global.fetch = jest.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
            capturedBodies.push(JSON.parse(init.body as string));
            return { ok: true, json: () => Promise.resolve({ accessToken: 'tok', user: MOCK_USER }) };
          });
          const svc = getService();
          await svc.signInSocial(provider, idToken);
          expect(capturedBodies).toHaveLength(1);
          const body = capturedBodies[0] as { provider: string; idToken: string };
          expect(body.provider).toBe(provider);
          expect(body.idToken).toBe(idToken);
        },
      ),
      { numRuns: 50 },
    );
  });
});
