import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { SiriShortcutsService } from '../services/SiriShortcutsService';
import { singleFlightRefresh } from '../services/refreshTokenGuard';

const API_BASE_URL = `${process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'}/api/v1`;

// Same key AuthService uses — apiClient reads its Bearer token from SecureStore
// on every request, so a refreshed token MUST be persisted there as well or
// subsequent API calls keep sending the stale token. (AuthService can't be
// imported here — it imports this store, which would create a require cycle.)
const SECURE_STORE_KEY = 'convoy_access_token';

export interface User {
  id: string;
  displayName: string;
  phoneNumber?: string;
  email?: string;
  avatarUrl?: string;
  pttCallsign?: string;
  privacy: 'open' | 'invite_only';
}

interface AuthState {
  user: User | null;
  /** Access token (alias: token) */
  accessToken: string | null;
  /** Alias for accessToken — used by routes that follow the task spec naming. */
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when the user has signed up but not yet completed the onboarding flow. */
  isFirstLogin: boolean;
  setUser: (user: User | null) => void;
  setAccessToken: (token: string | null) => void;
  /** Alias for setAccessToken */
  setToken: (token: string | null) => void;
  setLoading: (loading: boolean) => void;
  setIsFirstLogin: (value: boolean) => void;
  /** Sign out and clear all auth state (alias: clear, logout) */
  signOut: () => void;
  /** Alias for signOut */
  clear: () => void;
  /** Alias for signOut */
  logout: () => void;
  /**
   * Attempt to refresh the access token using the HttpOnly refresh token cookie
   * (set by the API on login). Returns true if a new accessToken was obtained.
   * Calls signOut() and returns false if refresh fails.
   */
  refreshToken: () => Promise<boolean>;
  /**
   * Convenience wrapper: if a fetch response has status 401, attempt one token
   * refresh and return true (caller should retry). Returns false and signs out
   * if refresh fails or the response was not 401.
   */
  handleUnauthorized: (response: Response) => Promise<boolean>;
}

const clearState = {
  user: null as User | null,
  accessToken: null as string | null,
  token: null as string | null,
  isAuthenticated: false,
  isFirstLogin: false,
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  token: null,
  isLoading: true,
  isAuthenticated: false,
  isFirstLogin: false,

  setUser: (user) => {
    set({ user, isAuthenticated: user !== null });
    if (user !== null) void SiriShortcutsService.donateAll();
  },

  setAccessToken: (accessToken) => set({ accessToken, token: accessToken }),

  setToken: (token) => set({ accessToken: token, token }),

  setLoading: (isLoading) => set({ isLoading }),

  setIsFirstLogin: (isFirstLogin) => set({ isFirstLogin }),

  signOut: () => set(clearState),
  clear: () => set(clearState),
  logout: () => set(clearState),

  refreshToken: async () => {
    // Funnel through the shared single-flight guard so this raw-fetch path and
    // apiClient's interceptor (via AuthService.refreshToken) never fire two
    // concurrent /auth/refresh calls — the server rotates the refresh token on
    // use, so the loser of that race would 401 and sign the user out.
    const accessToken = await singleFlightRefresh(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include', // sends the HttpOnly refreshToken cookie
        });
        if (!res.ok) return null;
        const { accessToken } = await res.json() as { accessToken: string };
        // Persist first so apiClient's request interceptor (which reads
        // SecureStore per request) immediately picks up the fresh token.
        await SecureStore.setItemAsync(SECURE_STORE_KEY, accessToken).catch(() => {});
        set({ accessToken, token: accessToken });
        return accessToken;
      } catch {
        return null;
      }
    });
    if (!accessToken) {
      get().signOut();
      return false;
    }
    return true;
  },

  handleUnauthorized: async (response: Response) => {
    if (response.status !== 401) return false;
    return get().refreshToken();
  },
}));
