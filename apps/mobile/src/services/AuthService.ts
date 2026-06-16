import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../stores/authStore';

const SECURE_STORE_KEY = 'convoy_access_token';

export interface AuthResult {
  user: User;
  accessToken: string;
}

interface ApiResponse<T> {
  data: T;
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

export class AuthService {
  async requestOtp(phone: string): Promise<void> {
    await rawPost<void>('/api/v1/auth/otp/request', { phone });
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
    try {
      await rawPost<void>('/api/v1/auth/logout', {});
    } catch {
      // Best-effort logout — always clear local state regardless of server response
    } finally {
      await SecureStore.deleteItemAsync(SECURE_STORE_KEY);
      useAuthStore.getState().signOut();
    }
  }

  async loadStoredToken(): Promise<string | null> {
    return SecureStore.getItemAsync(SECURE_STORE_KEY);
  }
}

export const authService = new AuthService();
