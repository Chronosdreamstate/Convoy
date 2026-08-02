import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { authService } from './AuthService';
import { API_URL } from '../config/env';

const SECURE_STORE_KEY = 'convoy_access_token';

const baseURL = API_URL;

// Retry policy: up to 3 attempts with exponential backoff (Req 43.1).
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/**
 * Whether re-sending this request can only ever repeat its effect, never add
 * to it. A retry fires when the app has NO idea whether the server acted:
 * either no response came back at all (dead zone, the normal case here) or the
 * response was a 5xx, which a proxy also returns for a request the API is
 * still processing.
 *
 * POST is therefore excluded. None of the ~90 POST routes this client calls is
 * idempotent — a lost 201 from `POST /groups` re-sent means two convoys, and
 * the same goes for chat messages, fuel logs, vehicles and friend requests.
 * Everything else the app sends is a full-value write (PATCH /settings,
 * PATCH /users/me) or a delete, both of which land on the same state whether
 * applied once or four times.
 */
function isRetryable(error: AxiosError, method: string | undefined): boolean {
  if ((method ?? 'get').toLowerCase() === 'post') return false;
  if (!error.response) return true; // network timeout / no response
  return error.response.status >= 500;
}

function retryDelay(attempt: number): Promise<void> {
  const ms = RETRY_BASE_MS * Math.pow(2, attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const apiClient = axios.create({
  baseURL,
  withCredentials: true, // send HttpOnly refresh-token cookie on every request
  headers: {
    'Content-Type': 'application/json',
  },
});

// ------------------------------------------------------------------
// Request interceptor — attach Bearer token from SecureStore
// ------------------------------------------------------------------
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const token = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ------------------------------------------------------------------
// Response interceptor — handle 401 with a single token refresh retry
// ------------------------------------------------------------------
let isRefreshing = false;
type FailedRequest = {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
};
let failedQueue: FailedRequest[] = [];

function processQueue(error: unknown, token: string | null): void {
  const queue = failedQueue;
  failedQueue = [];
  queue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else if (token) {
      resolve(token);
    } else {
      reject(new Error('Token refresh produced no token'));
    }
  });
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as
      | (InternalAxiosRequestConfig & { _retry?: boolean; _retryCount?: number })
      | undefined;

    // No config means the failure happened before a request was ever built —
    // a rejected request interceptor (a locked keychain makes
    // SecureStore.getItemAsync throw) lands here too. There is nothing to
    // re-send, and touching originalRequest would replace the error the caller
    // needs to see with a TypeError.
    if (!originalRequest) {
      return Promise.reject(error);
    }

    // 5xx / network-timeout retry with exponential backoff (Req 43.1)
    if (isRetryable(error, originalRequest.method) && error.response?.status !== 401) {
      const attempt = originalRequest._retryCount ?? 0;
      if (attempt < MAX_RETRIES) {
        originalRequest._retryCount = attempt + 1;
        await retryDelay(attempt);
        return apiClient(originalRequest);
      }
      return Promise.reject(error);
    }

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Queue subsequent 401s while a refresh is already in flight
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((token) => {
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return apiClient(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const newToken = await authService.refreshToken();

      if (!newToken) {
        processQueue(new Error('Token refresh failed'), null);
        await authService.signOut();
        return Promise.reject(error);
      }

      processQueue(null, newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await authService.signOut();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
