import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../stores/authStore';
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

    try {
      await rawPost<void>('/api/v1/auth/logout', {});
    } catch {
      // Best-effort logout — always clear local state regardless of server response
    } finally {
      await SecureStore.deleteItemAsync(SECURE_STORE_KEY);
      // Clear the local onboarding flags too — they aren't scoped to a user id,
      // so leaving them set would cause the *next* account signed into this
      // device (a different person, or a fresh signup) to have onboarding
      // silently skipped because a previous account had already completed it.
      await SecureStore.deleteItemAsync('onboarding_complete').catch(() => {});
      await onboardingState.reset().catch(() => {});
      useAuthStore.getState().signOut();
    }
  }

  async loadStoredToken(): Promise<string | null> {
    return SecureStore.getItemAsync(SECURE_STORE_KEY);
  }
}

export const authService = new AuthService();
