import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { authService } from './AuthService';

const SECURE_STORE_KEY = 'convoy_access_token';

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

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
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else if (token) {
      resolve(token);
    }
  });
  failedQueue = [];
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

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
