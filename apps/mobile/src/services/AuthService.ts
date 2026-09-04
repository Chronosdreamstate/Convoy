import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { useLocationStore } from '../stores/locationStore';
import { useSocketStore } from '../stores/socketStore';
import { useRecentDestinationsStore } from '../stores/recentDestinationsStore';
import { useSettingsStore } from '../stores/settingsStore';
import { sharedMotionState } from './MotionStateService';
import { pttAnalytics } from './PTTAnalyticsService';
import { SQLiteOfflineDB } from './OfflineCacheService';
import { onboardingState } from '../utils/onboardingState';
import { singleFlightRefresh } from './refreshTokenGuard';
import { API_URL } from '../config/env';

const SECURE_STORE_KEY = 'convoy_access_token';

/**
 * AsyncStorage keys written outside the zustand stores that hold data
 * belonging to ONE account. None of them is namespaced by user id, and every
 * reader loads its key straight into the UI on mount, so leaving them behind
 * shows the previous account's data to whoever signs in next on this device:
 *
 *  - convoy:notifications      Notification Center's local cache — rendered
 *                              immediately on mount (loadCached), so account B
 *                              opened the tab to account A's SOS alerts,
 *                              friend requests and invites.
 *  - convoy:recent_searches    Destination search history.
 *  - convoy:completed_count /  Drive-count, first-convoy achievement and
 *    achievement:first_convoy / store-review prompt state — B inherits A's
 *    convoy:has_reviewed /     counters, so B never gets the first-convoy
 *    convoy:review_prompted    moment and is never asked to review.
 *
 * Device-level keys are deliberately NOT here: `@convoy/anon_id` (anonymous
 * analytics id), `coach_marks_shown` and settingsStore's `themeMode` describe
 * the device, not the person — the same reasoning as settingsStore's
 * account-vs-device split.
 */
const PER_ACCOUNT_STORAGE_KEYS = [
  'convoy:notifications',
  'convoy:recent_searches',
  'convoy:completed_count',
  'achievement:first_convoy',
  'convoy:has_reviewed',
  'convoy:review_prompted',
];

/** Prefix of the per-drive photo caches (`convoy:drive:<driveId>:photos`). */
const DRIVE_PHOTO_KEY_PREFIX = 'convoy:drive:';

/**
 * Own handle on the offline SQLite queue. The tables hold pending hazard
 * reports, drives and cached member positions, none of them keyed by user, so
 * they must be wiped at sign-out or SyncService replays them under the next
 * account's token. Constructing this opens nothing — init() is deferred to the
 * first clearAll().
 */
const offlineDb = new SQLiteOfflineDB();

export interface AuthResult {
  user: User;
  accessToken: string;
}

interface AuthApiResponse {
  user: User;
  accessToken: string;
}

/**
 * Error thrown by auth endpoints, carrying the HTTP status alongside the
 * server-provided message so callers can tell "the server explained why"
 * (show err.message) apart from transport failures (show a generic fallback).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Pull the human-readable message out of an API error body. The API uses two
 * shapes: @fastify/sensible replies put `message` at the top level (400/429),
 * while the custom envelopes nest it as `{ error: { code, message } }`
 * (INVALID_OTP 422, INVALID_CREDENTIALS 401, EMAIL_EXISTS 409,
 * PROVIDER_NOT_CONFIGURED 503). Missing either shape, fall back to a generic
 * message rather than showing the user raw JSON.
 */
function extractErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const topLevel = (body as { message?: unknown }).message;
    if (typeof topLevel === 'string' && topLevel) return topLevel;

    const nested = (body as { error?: { message?: unknown } }).error;
    if (typeof nested === 'object' && nested !== null) {
      const nestedMessage = (nested as { message?: unknown }).message;
      if (typeof nestedMessage === 'string' && nestedMessage) return nestedMessage;
    }
  }
  return 'Request failed';
}

/**
 * Performs a raw fetch against the API without the Axios interceptor chain.
 * Used for auth endpoints that must not trigger the 401 retry loop.
 */
async function rawPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = API_URL;
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include', // send HttpOnly refresh-token cookie
  });

  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    throw new ApiError(extractErrorMessage(errorBody), response.status);
  }

  return response.json() as Promise<T>;
}

/**
 * Deregisters this device's push token so a signed-out account stops
 * receiving push notifications intended for it (mirrors the registration
 * done in NotificationService.registerToken, which POSTs to /api/v1/devices
 * but does not cache the token anywhere accessible to this module).
 *
 * Best-effort only — every failure mode here (no permission, no token,
 * network error, 401 because the access token already expired) is
 * swallowed so it can never block or fail sign-out.
 */
async function deregisterPushToken(): Promise<void> {
  // Don't force a fresh permission prompt just to sign out, and skip
  // gracefully if the user never enabled notifications on this device.
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  // Expo push tokens are stable per device install + project — calling
  // this again returns the same value obtained at registration time, it
  // does not mint a new one.
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  if (!token) return;

  // Read the access token directly rather than going through apiClient,
  // which imports AuthService and would create a circular dependency.
  const accessToken = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  if (!accessToken) return;

  const baseUrl = API_URL;
  await fetch(`${baseUrl}/api/v1/devices/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  });
}

export class AuthService {
  async requestOtp(phone: string): Promise<{ devOtp?: string }> {
    const res = await rawPost<{ message: string; _dev_otp?: string }>('/api/v1/auth/otp/request', { phone });
    return { devOtp: res._dev_otp };
  }

  async verifyOtp(phone: string, otp: string): Promise<AuthResult> {
    const result = await rawPost<AuthApiResponse>('/api/v1/auth/otp/verify', { phone, otp });
    await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
    return { user: result.user, accessToken: result.accessToken };
  }

  async signInEmail(email: string, password: string): Promise<AuthResult> {
    const result = await rawPost<AuthApiResponse>('/api/v1/auth/email/login', {
      email,
      password,
    });
    await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
    return { user: result.user, accessToken: result.accessToken };
  }

  async signUpEmail(email: string, password: string): Promise<AuthResult> {
    const result = await rawPost<AuthApiResponse>('/api/v1/auth/email/signup', {
      email,
      password,
    });
    await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
    return { user: result.user, accessToken: result.accessToken };
  }

  async signInSocial(provider: 'apple' | 'google', idToken: string): Promise<AuthResult> {
    const result = await rawPost<AuthApiResponse>('/api/v1/auth/social', {
      provider,
      idToken,
    });
    await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
    return { user: result.user, accessToken: result.accessToken };
  }

  /**
   * Exchange a Google ID token (obtained by GoogleSignInButton via
   * expo-auth-session) for the app's own session. Shares the /auth/social
   * exchange and SecureStore behaviour with Apple sign-in.
   */
  async signInWithGoogle(idToken: string): Promise<AuthResult> {
    return this.signInSocial('google', idToken);
  }

  async refreshToken(): Promise<string | null> {
    // Single-flight so a concurrent authStore.refreshToken (raw-fetch screens)
    // doesn't fire a second /auth/refresh that consumes the rotated token and
    // 401s the loser into a sign-out.
    return singleFlightRefresh(async () => {
      try {
        const result = await rawPost<{ accessToken: string }>('/api/v1/auth/refresh', {});
        await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
        useAuthStore.getState().setAccessToken(result.accessToken);
        return result.accessToken;
      } catch {
        return null;
      }
    });
  }

  async signOut(): Promise<void> {
    // Fire-and-forget: deregister this device's push token so it stops
    // receiving notifications for the account being signed out of. Must
    // run before the access token is cleared below (still needed to
    // authenticate the DELETE call), but must never block or fail sign-out.
    deregisterPushToken().catch((err) => {
      console.warn('[AuthService] Failed to deregister push token on sign-out:', err);
    });

    // Best-effort server-side logout — always clear local state regardless of
    // the server response (offline sign-out must still work).
    try {
      await rawPost<void>('/api/v1/auth/logout', {});
    } catch {
      // ignored
    }

    // Local cleanup. Every step below is individually guarded so that no
    // single failure (a flaky keychain, a store reset throwing) can prevent
    // the remaining resets from running. In particular, if the SecureStore
    // token delete rejected here it used to skip ALL per-account store resets
    // and rethrow to every caller (401 interceptor, delete-account flow) —
    // leaving the previous account's group/location/presence state live for
    // the next sign-in.
    //
    // Error contract: signOut() NEVER rejects. There is nothing a caller can
    // usefully do about a local-cleanup failure — every caller treats
    // signOut() as "end the session now", so failures are logged and
    // swallowed instead of propagated.
    await SecureStore.deleteItemAsync(SECURE_STORE_KEY).catch((err) => {
      console.warn('[AuthService] Failed to delete access token from SecureStore:', err);
    });
    // Clear the local onboarding flags too — they aren't scoped to a user id,
    // so leaving them set would cause the *next* account signed into this
    // device (a different person, or a fresh signup) to have onboarding
    // silently skipped because a previous account had already completed it.
    await SecureStore.deleteItemAsync('onboarding_complete').catch(() => {});
    await onboardingState.reset().catch(() => {});
    await this.clearPerAccountStorage();
    try {
      await offlineDb.clearAll();
    } catch (err) {
      console.warn('[AuthService] Failed to clear the offline queue on sign-out:', err);
    }

    // Reset all per-account state so the next sign-in (possibly a different
    // person on this device) doesn't see the previous account's group, member
    // positions, presence, recent destinations, or app preferences. Without
    // this, e.g. groupStore.activeGroupId survives sign-out and the next
    // account briefly renders the old account's convoy — and
    // settingsStore.shareLocationWithFriends (a privacy toggle) would carry
    // over to a stranger's account.
    const resets: Array<[string, () => void]> = [
      ['authStore', () => useAuthStore.getState().signOut()],
      ['groupStore', () => useGroupStore.getState().leaveGroup()],
      ['locationStore', () => useLocationStore.getState().clearGroup()],
      ['socketStore', () => useSocketStore.getState().reset()],
      ['recentDestinationsStore', () => useRecentDestinationsStore.getState().clearDestinations()],
      // Also rewrites the persisted copy via zustand/persist; device-level
      // settings (themeMode) are intentionally kept — see settingsStore.
      ['settingsStore', () => useSettingsStore.getState().resetForSignOut()],
      // Motion_State is derived from a GPS feed that stops at sign-out, so its
      // parked hysteresis can never settle on its own: signing out while
      // driving used to leave `useMotionStore().isInMotion` true for the next
      // account, blocking their profile/garage edits (Req 34) with a
      // "can't do this while driving" guard they had no way to clear.
      ['motionState', () => sharedMotionState.reset()],
      // Per-convoy PTT talk-time stats: getLeaderboard() returns everything
      // ever recorded, so without this the first transmit in the next
      // account's convoy renders the previous account's members.
      ['pttAnalytics', () => pttAnalytics.reset()],
    ];
    for (const [name, reset] of resets) {
      try {
        reset();
      } catch (err) {
        console.warn(`[AuthService] Failed to reset ${name} on sign-out:`, err);
      }
    }
  }

  /**
   * Drop the AsyncStorage caches that belong to the account being signed out.
   * Best-effort and never rejects — see the signOut() error contract.
   *
   * The per-drive photo caches can't be listed statically (their key embeds a
   * drive id), so they are swept by prefix; a getAllKeys() failure degrades to
   * clearing just the fixed list rather than skipping the whole cleanup.
   */
  private async clearPerAccountStorage(): Promise<void> {
    let keys = PER_ACCOUNT_STORAGE_KEYS;
    try {
      const all = await AsyncStorage.getAllKeys();
      keys = [...keys, ...all.filter((k) => k.startsWith(DRIVE_PHOTO_KEY_PREFIX))];
    } catch (err) {
      console.warn('[AuthService] Failed to enumerate storage keys on sign-out:', err);
    }
    try {
      await AsyncStorage.multiRemove(keys);
    } catch (err) {
      console.warn('[AuthService] Failed to clear per-account storage on sign-out:', err);
    }
  }

  async loadStoredToken(): Promise<string | null> {
    return SecureStore.getItemAsync(SECURE_STORE_KEY);
  }

  /**
   * Where to send the user immediately after ANY successful sign-in (phone
   * OTP, email, Apple, Google) — shared so every auth method routes new users
   * through onboarding instead of only the OTP flow doing so (Req 36.7 hangs
   * push-permission timing off onboarding completion, so skipping it breaks
   * more than just the tutorial screens).
   *
   * Returns the route plus whether this counts as a first login so the caller
   * can mirror it into authStore.isFirstLogin (the root layout's navigation
   * guard uses that flag to keep the user inside the onboarding stack).
   */
  async getPostAuthRoute(): Promise<{ route: string; isFirstLogin: boolean }> {
    // A keychain read failure is treated as "onboarding done" so a flaky
    // SecureStore can never trap an existing user back in onboarding.
    const onboardingDone = await SecureStore.getItemAsync('onboarding_complete').catch(() => '1');
    if (onboardingDone) return { route: '/(tabs)/map', isFirstLogin: false };

    // Resume at whichever onboarding step is next, rather than always
    // restarting from the first step for a returning-but-incomplete user.
    const resumeRoute = await onboardingState.getResumeRoute().catch(() => null);
    if (!resumeRoute) return { route: '/(tabs)/map', isFirstLogin: false };
    return { route: resumeRoute, isFirstLogin: true };
  }
}

export const authService = new AuthService();
