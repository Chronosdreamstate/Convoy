import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { authService } from '../services/AuthService';

/**
 * Hook that exposes core auth state and handles token hydration on mount.
 *
 * On mount:
 *  1. Reads the stored access token from SecureStore.
 *  2. If a token exists, calls refreshToken() to exchange it for a fresh one.
 *  3. If the refresh succeeds, the new token is stored and the store is hydrated
 *     (authService.refreshToken already calls setAccessToken internally).
 *  4. If the refresh fails, clears all auth state.
 *
 * Note: user hydration (fetching /users/me) is intentionally left to the
 * calling screen or layout so this hook stays minimal.
 */
export function useAuth() {
  const user = useAuthStore((state) => state.user);
  const isLoading = useAuthStore((state) => state.isLoading);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const storeSignOut = useAuthStore((state) => state.signOut);
  const setLoading = useAuthStore((state) => state.setLoading);

  useEffect(() => {
    let cancelled = false;

    const hydrateAuth = async () => {
      setLoading(true);
      try {
        const storedToken = await authService.loadStoredToken();

        if (!storedToken) {
          // No token on device — user needs to sign in
          storeSignOut();
          return;
        }

        // Attempt a silent refresh to get a fresh access token
        const freshToken = await authService.refreshToken();

        if (cancelled) return;

        if (!freshToken) {
          // Refresh failed (token expired, revoked, etc.) — clear state
          await authService.signOut();
        }
        // If refresh succeeded, authService.refreshToken() already updated
        // the store via setAccessToken — nothing else to do here
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    hydrateAuth();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    await authService.signOut();
  };

  return {
    user,
    isLoading,
    isAuthenticated,
    signOut,
  };
}
