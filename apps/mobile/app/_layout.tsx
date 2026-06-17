import { useEffect, useRef } from 'react';
import { Stack, useRouter } from 'expo-router';
import type { Router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { useAuthStore } from '../src/stores/authStore';
import { authService } from '../src/services/AuthService';
import { apiClient } from '../src/services/apiClient';
import {
  registerForPushNotificationsAsync,
  setupNotificationHandler,
} from '../src/services/NotificationService';

// Set up foreground notification display behaviour at module load time,
// before any notifications can arrive.
setupNotificationHandler();

/** Navigate to the correct screen based on notification data. */
function handleNotificationNavigation(
  router: Router,
  data: Record<string, string> | undefined,
): void {
  const type = data?.type;
  switch (type) {
    case 'sos_alert':
      router.push('/(tabs)/map');
      break;
    case 'friend_request':
      router.push('/friends');
      break;
    case 'group_invite':
    case 'group_event':
    case 'rally_point':
      router.push('/(tabs)/convoy');
      break;
    case 'hazard_alert':
    case 'gap_alert':
    case 'fuel_suggest':
    case 'arriving_destination':
      router.push('/(tabs)/map');
      break;
    default:
      break;
  }
}

export default function RootLayout() {
  const { isAuthenticated, isLoading, setUser, setLoading, signOut: storeSignOut } = useAuthStore();
  const router = useRouter();
  // Guard: push registration must only run once per session, after auth confirms
  const pushRegisteredRef = useRef(false);

  // Startup: load stored token, refresh it, then fetch /me to hydrate the user
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const stored = await authService.loadStoredToken();
        if (!stored) { storeSignOut(); return; }
        const freshToken = await authService.refreshToken();
        if (!freshToken) { await authService.signOut(); return; }
        if (cancelled) return;
        const res = await apiClient.get('/api/v1/users/me');
        if (!cancelled) setUser(res.data);
      } catch {
        if (!cancelled) storeSignOut();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  // Push registration: run once after the user is confirmed authenticated.
  // The useRef guard prevents re-registration on re-renders or StrictMode double-invocations.
  // Wrapped in try/catch so permission denial is always silent.
  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    if (pushRegisteredRef.current) return;
    pushRegisteredRef.current = true;
    registerForPushNotificationsAsync().catch(() => {
      // Non-fatal - silently ignored if push setup fails
    });
  }, [isAuthenticated, isLoading]);

  // Handle notification taps while app is in background (live listener)
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, string>;
      handleNotificationNavigation(router, data);
    });
    return () => sub.remove();
  }, []);

  // Handle the case where the app was killed and launched FROM a notification tap
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as Record<string, string>;
      handleNotificationNavigation(router, data);
    }).catch(() => {
      // Non-fatal — silently ignore if getLastNotificationResponseAsync fails
    });
  }, []);

  // Navigation guard: redirect unauthenticated users to welcome screen
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace('/(auth)/welcome');
    }
  }, [isAuthenticated, isLoading]);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="friends" />
        <Stack.Screen name="invite" />
      </Stack>
    </SafeAreaProvider>
  );
}
