import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import PushPermissionModal from '../src/components/PushPermissionModal';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import ErrorBoundary from '../src/components/ErrorBoundary';
import type { Router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '../src/stores/authStore';
import { authService } from '../src/services/AuthService';
import { apiClient } from '../src/services/apiClient';
import { useGroupStore } from '../src/stores/groupStore';
import { useSocketStore } from '../src/stores/socketStore';
import OfflineIndicator from '../src/components/OfflineIndicator';
import {
  registerForPushNotificationsAsync,
  setupNotificationHandler,
} from '../src/services/NotificationService';
import { SyncService } from '../src/services/SyncService';
import { SQLiteOfflineDB } from '../src/services/OfflineCacheService';
import type { OfflineHazard, OfflineDrive } from '../src/services/OfflineCacheService';
import { offlineQueue } from '../src/services/OfflineQueueService';
import { analytics } from '../src/services/AnalyticsService';

// Set up foreground notification display behaviour at module load time,
// before any notifications can arrive.
setupNotificationHandler();

export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

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
      if (data?.eventId && data?.groupId) {
        router.push({ pathname: '/event/[id]' as never, params: { id: data.eventId, groupId: data.groupId } });
      } else {
        router.push('/(tabs)/convoy');
      }
      break;
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

/** Route a convoy:// or https://convoy.app/ deep link to the appropriate screen. */
function handleDeepLink(router: Router, url: string): void {
  try {
    const parsed = new URL(url);
    let path = '';
    let code: string | null = null;
    let userId: string | null = null;

    if (parsed.protocol === 'convoy:') {
      // convoy://join?code=XXX  or  convoy://invite?userId=XXX
      path = parsed.hostname;
      code = parsed.searchParams.get('code');
      userId = parsed.searchParams.get('userId');
    } else if (parsed.protocol === 'https:' && parsed.hostname === 'convoy.app') {
      // https://convoy.app/join?code=XXX  or  https://convoy.app/invite/USER_ID
      const segments = parsed.pathname.replace(/^\//, '').split('/');
      path = segments[0] ?? '';
      code = parsed.searchParams.get('code');
      userId = segments[1] ?? null;
    } else {
      return;
    }

    if (path === 'join' && code) {
      router.push({ pathname: '/join', params: { prefillCode: code } });
    } else if (path === 'invite' && userId) {
      router.push(`/group/${encodeURIComponent(userId)}`);
    } else if (path === 'group' && userId) {
      router.push(`/group/${encodeURIComponent(userId)}`);
    }
  } catch {
    // malformed URL — ignore
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
  const { isAuthenticated, isLoading, isFirstLogin, setUser, setLoading, setIsFirstLogin, signOut: storeSignOut } = useAuthStore();
  const setActiveGroupId = useGroupStore((s) => s.setActiveGroupId);
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const socketConnected = useSocketStore((s) => s.isConnected);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const router = useRouter();
  // Track whether socket has ever connected so we don't show offline banner before first connect
  useEffect(() => {
    if (socketConnected) setHasEverConnected(true);
  }, [socketConnected]);

  // Guard: push registration must only run once per session, after auth confirms
  const pushRegisteredRef = useRef(false);
  const [showPushModal, setShowPushModal] = useState(false);

  // Startup: load stored token, refresh it, then fetch /me to hydrate the user
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      void analytics.init();
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
          const onboardingDone = await SecureStore.getItemAsync('onboarding_complete').catch(() => '1');
          if (!onboardingDone) setIsFirstLogin(true);
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

  // Init general-purpose offline request queue on first auth
  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    void offlineQueue.init();
    return () => offlineQueue.destroy();
  }, [isAuthenticated, isLoading]);

  // Push registration: deferred until the user joins their first group.
  // Showing the system permission dialog in context ("convoy is starting")
  // yields significantly higher grant rates than asking at app launch.
  const prevActiveGroupIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    if (!activeGroupId || prevActiveGroupIdRef.current === activeGroupId) return;
    const wasInGroup = prevActiveGroupIdRef.current !== null;
    prevActiveGroupIdRef.current = activeGroupId;
    // Only prompt on the very first group join, not on every subsequent group switch
    if (wasInGroup) return;
    if (pushRegisteredRef.current) return;

    void AsyncStorage.getItem('push_permission_asked').then((asked) => {
      if (asked) return;
      setTimeout(() => setShowPushModal(true), 3000);
    });
  }, [isAuthenticated, isLoading, activeGroupId]);

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

  // OTA update check — silent in dev, prompts user in production
  useEffect(() => {
    async function checkForUpdate() {
      if (__DEV__) return;
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Alert.alert(
            'Update Available',
            'A new version of CONVOY is ready. Restart to get the latest features.',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Restart Now', onPress: () => void Updates.reloadAsync() },
            ],
          );
        }
      } catch {
        // Non-fatal — silently ignore network errors or update check failures
      }
    }
    void checkForUpdate();
  }, []);

  // Cold-start deep link: app was closed and opened via convoy:// URL
  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(router, url);
    }).catch(() => {});
  }, []);

  // Warm-start deep link: app already running, convoy:// URL received
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      handleDeepLink(router, url);
    });
    return () => sub.remove();
  }, []);

  // Navigation guard: redirect unauthenticated users to welcome, first-time users to onboarding
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace('/(auth)/welcome');
    } else if (isFirstLogin) {
      router.replace('/(onboarding)/vehicle');
    }
  }, [isAuthenticated, isLoading, isFirstLogin]);

  if (isLoading) {
    return (
      <SafeAreaProvider>
        <LoadingSplash />
      </SafeAreaProvider>
    );
  }

  const isOffline = isAuthenticated && hasEverConnected && !socketConnected;

  // expo-battery not installed — set to true when package is added and replace with Battery hooks
  const showLowBatteryWarning = false;

  return (
    <SafeAreaProvider>
      {showLowBatteryWarning && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999,
          backgroundColor: '#F59E0B', paddingTop: 44, paddingBottom: 8,
          paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center',
        }}>
          <Text style={{ fontSize: 14, color: '#000', flex: 1 }}>
            ⚡ Low battery — convoy members may lose your signal
          </Text>
        </View>
      )}
      <ErrorBoundary>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            animationDuration: 220,
          }}
        >
          <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(onboarding)" options={{ animation: 'fade' }} />
          <Stack.Screen name="friends" />
          <Stack.Screen name="invite" />
          <Stack.Screen name="group-browse" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="replay" />
          <Stack.Screen name="group/[id]" />
          <Stack.Screen
            name="group-settings"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen
            name="waypoints"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen
            name="join"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen
            name="convoy-end"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen
            name="create-event"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen name="event/[id]" />
          <Stack.Screen name="leaderboard" />
          <Stack.Screen name="group-leaderboard" />
          <Stack.Screen name="group-stats/[id]" />
          <Stack.Screen
            name="create-group"
            options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
          />
          <Stack.Screen name="group-chat" options={{ headerShown: false }} />
          <Stack.Screen name="privacy" />
          <Stack.Screen name="terms" />
          <Stack.Screen name="search" options={{ animation: 'fade' }} />
          <Stack.Screen name="convoy-history/[groupId]" />
          <Stack.Screen name="profile/[userId]" />
          <Stack.Screen name="achievements" />
          <Stack.Screen name="fuel" />
          <Stack.Screen name="group-photos/[groupId]" />
        </Stack>
      </ErrorBoundary>
      <OfflineIndicator isOffline={isOffline} />
      <PushPermissionModal
        visible={showPushModal}
        onEnable={() => {
          setShowPushModal(false);
          void AsyncStorage.setItem('push_permission_asked', '1');
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
        }}
        onSkip={() => {
          setShowPushModal(false);
          void AsyncStorage.setItem('push_permission_asked', '1');
        }}
      />
    </SafeAreaProvider>
  );
}
