/**
 * Single-flight guard for access-token refresh.
 *
 * Two independent paths refresh the token: apiClient's 401 interceptor (via
 * AuthService.refreshToken) and authStore.refreshToken (used by raw-fetch
 * screens' handleUnauthorized). The server consumes the refresh-token JTI
 * atomically on use (GETDEL), so if both fire concurrently the first rotates
 * the cookie and the second sends the now-stale one → 401 → spurious sign-out.
 *
 * Both paths funnel their refresh through here, so concurrent callers share one
 * in-flight request and one token rotation. Kept dependency-free (no import of
 * AuthService or the store) so either side can use it without a require cycle.
 */
let inFlight: Promise<string | null> | null = null;

export function singleFlightRefresh(refresh: () => Promise<string | null>): Promise<string | null> {
  if (inFlight) return inFlight;
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test-only: clear any in-flight refresh between cases. */
export function __resetRefreshGuard(): void {
  inFlight = null;
}
