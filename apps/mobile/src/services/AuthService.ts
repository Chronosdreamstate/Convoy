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
import { onboardingState } from '../utils/onboardingState';

const SECURE_STORE_KEY = 'convoy_access_token';

export interface AuthResult {
  user: User;
  accessToken: string;
}

interface AuthApiResponse {
  user: User;
  accessToken: string;
}

/**
 * Performs a raw fetch against the API without the Axios interceptor chain.
 * Used for auth endpoints that must not trigger the 401 retry loop.
 */
async function rawPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include', // send HttpOnly refresh-token cookie
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Request failed' }));
    const message =
      typeof errorBody === 'object' && errorBody !== null && 'message' in errorBody
        ? String((errorBody as { message: unknown }).message)
        : 'Request failed';
    throw new Error(message);
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

  const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
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

  async refreshToken(): Promise<string | null> {
    try {
      const result = await rawPost<{ accessToken: string }>('/api/v1/auth/refresh', {});
      await SecureStore.setItemAsync(SECURE_STORE_KEY, result.accessToken);
      useAuthStore.getState().setAccessToken(result.accessToken);
      return result.accessToken;
    } catch {
      return null;
    }
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
    ];
    for (const [name, reset] of resets) {
      try {
        reset();
      } catch (err) {
        console.warn(`[AuthService] Failed to reset ${name} on sign-out:`, err);
      }
    }
  }

  async loadStoredToken(): Promise<string | null> {
    return SecureStore.getItemAsync(SECURE_STORE_KEY);
  }
}

export const authService = new AuthService();
