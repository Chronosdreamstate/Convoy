import { create } from 'zustand';

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
  /** Sign out and clear all auth state (alias: clear) */
  signOut: () => void;
  /** Alias for signOut */
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  token: null,
  isLoading: true,
  isAuthenticated: false,
  isFirstLogin: false,

  setUser: (user) => set({ user, isAuthenticated: user !== null }),

  setAccessToken: (accessToken) => set({ accessToken, token: accessToken }),

  setToken: (token) => set({ accessToken: token, token }),

  setLoading: (isLoading) => set({ isLoading }),

  setIsFirstLogin: (isFirstLogin) => set({ isFirstLogin }),

  signOut: () =>
    set({ user: null, accessToken: null, token: null, isAuthenticated: false, isFirstLogin: false }),

  clear: () =>
    set({ user: null, accessToken: null, token: null, isAuthenticated: false, isFirstLogin: false }),
}));
