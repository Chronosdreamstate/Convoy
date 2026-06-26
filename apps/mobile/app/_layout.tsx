import { useEffect, useRef } from 'react';
import { Animated, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { useAuthStore } from '../src/stores/authStore';
import { authService } from '../src/services/AuthService';
import { apiClient } from '../src/services/apiClient';
import { useGroupStore } from '../src/stores/groupStore';
import {
  registerForPushNotificationsAsync,
  setupNotificationHandler,
} from '../src/services/NotificationService';
import { SyncService } from '../src/services/SyncService';
import { SQLiteOfflineDB } from '../src/services/OfflineCacheService';
import type { OfflineHazard, OfflineDrive } from '../src/services/OfflineCacheService';

// Set up foreground notification display behaviour at module load time,
// before any notifications can arrive.
setupNotificationHandler();

// ---------------------------------------------------------------------------
// Offline sync — drains SQLite queue when the app comes to foreground
// ---------------------------------------------------------------------------

const syncDB = new SQLiteOfflineDB();
void syncDB.init();

const syncService = new SyncService(
  syncDB,
  {
    postBulkHazards: async (hazards: OfflineHazard[]) => {
      await apiClient.post('/api/v1/hazards/bulk', {
        hazards: hazards.map((h) => ({ type: h.type, lat: h.lat, lng: h.lng, createdAt: h.createdAt })),
      });
    },
    postDrive: async (drive: OfflineDrive) => {
      await apiClient.post('/api/v1/drives', {
        groupId: drive.groupId || null,
        routeTrace: JSON.parse(drive.routeTrace) as unknown,
        distanceM: drive.distanceMeters,
        durationS: drive.durationSeconds,
        avgSpeedKph: drive.avgSpeedKph,
        topSpeedKph: drive.topSpeedKph,
        memberCount: drive.memberCount,
        startedAt: new Date(drive.startedAt).toISOString(),
        endedAt: new Date(drive.endedAt).toISOString(),
      });
    },
  },
  {
    subscribe(callback: (online: boolean) => void): () => void {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') callback(true);
      });
      callback(true);
      return () => sub.remove();
    },
  },
);

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
      router.push('/join');
      break;
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

function LoadingSplash() {
  const pulse = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulse]);
  return (
    <View style={splashStyles.container}>
      <Text style={splashStyles.logo}>CONVOY</Text>
      <Animated.View style={[splashStyles.bar, { opacity: pulse }]} />
    </View>
  );
}

const splashStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  logo: {
    fontSize: 48,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 8,
  },
  bar: {
    width: 80,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#DC143C',
  },
});

export default function RootLayout() {
  const { isAuthenticated, isLoading, setUser, setLoading, signOut: storeSignOut } = useAuthStore();
  const setActiveGroupId = useGroupStore((s) => s.setActiveGroupId);
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
        const [meRes, activeRes] = await Promise.all([
          apiClient.get('/api/v1/users/me'),
          apiClient.get<{ group: { id: string } | null }>('/api/v1/groups/active'),
        ]);
        if (!cancelled) {
          setUser(meRes.data);
          setActiveGroupId(activeRes.data.group?.id ?? null);
        }
      } catch {
        if (!cancelled) storeSignOut();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, []);

  // Start syncing offline queue once authenticated; stop on sign-out
  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    syncService.start();
    return () => syncService.stop();
  }, [isAuthenticated, isLoading]);

  // Push registration: run once after the user is confirmed authenticated.
  // The useRef guard prevents re-registration on re-renders or StrictMode double-invocations.
  // Wrapped in try/catch so permission denial is always silent.
  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    if (pushRegisteredRef.current) return;
    pushRegisteredRef.current = true;
    registerForPushNotificationsAsync()
      .then((pushToken) => {
        if (pushToken) {
          return apiClient.post('/api/v1/devices', {
            pushToken,
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
          });
        }
      })
      .catch(() => {});
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

  if (isLoading) {
    return (
      <SafeAreaProvider>
        <LoadingSplash />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="friends" />
        <Stack.Screen name="invite" />
        <Stack.Screen name="group-browse" />
        <Stack.Screen name="group-settings" />
        <Stack.Screen name="waypoints" />
        <Stack.Screen name="join" />
        <Stack.Screen name="convoy-end" />
      </Stack>
    </SafeAreaProvider>
  );
}
