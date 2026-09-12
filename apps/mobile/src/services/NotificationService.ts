/**
 * NotificationService — register device push tokens and handle incoming notifications.
 * Requirements: 15.1–15.5
 *
 * Runtime dependencies: expo-notifications, expo-device (must be installed via
 * `npx expo install expo-notifications expo-device` before running on device).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { apiClient } from './apiClient';
import { offlineQueue, isOfflineError } from './OfflineQueueService';

// ---------------------------------------------------------------------------
// Module-level notification handler
// Must be set before any notifications arrive (Expo requirement).
// Wrapped in a function so it can be called once at app startup after
// expo-notifications is available.
// ---------------------------------------------------------------------------

/**
 * Call once at app startup (e.g. in the root layout) to configure how
 * foreground notifications are presented.
 */
export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationCategory =
  | 'hazard'
  | 'group_invite'
  | 'group_event'
  | 'rally_point'
  | 'sos_alert'
  | 'arriving_destination'
  | 'friend_request'
  | 'gap_alert'
  | 'fuel_suggest';

export interface NotificationPreferences {
  notif_hazard: boolean;
  notif_group_events: boolean;
  notif_friend_requests: boolean;
  notif_navigation: boolean;
}

// ---------------------------------------------------------------------------
// Injectable interfaces (kept for unit testing)
// ---------------------------------------------------------------------------

export interface NotificationChannelInput {
  name: string;
  importance: number;
  vibrationPattern?: number[];
  lightColor?: string;
}

export interface IExpoPushTokenProvider {
  requestPermissionsAsync(): Promise<{ status: string }>;
  getPermissionsAsync(): Promise<{ status: string }>;
  getExpoPushTokenAsync(options: { projectId?: string }): Promise<{ data: string }>;
  getPlatform(): 'ios' | 'android';
  isDevice(): boolean;
  setNotificationChannelAsync(
    channelId: string,
    channel: NotificationChannelInput,
  ): Promise<void>;
}

export interface INotificationHandler {
  onForegroundNotification(category: NotificationCategory, data: Record<string, string>): void;
  onNotificationTap(category: NotificationCategory, data: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// Notification tap routing
// ---------------------------------------------------------------------------

/** Minimal structural subset of expo-router's Router used for tap routing. */
export interface INotificationRouter {
  push(route: string | { pathname: string; params?: Record<string, string> }): void;
}

/**
 * Navigate to the correct screen for a tapped push notification.
 * The API worker stamps `type` into the push data (notification.worker.ts),
 * so routing keys off `data.type`.
 *
 * Called from app/_layout.tsx for both warm taps
 * (addNotificationResponseReceivedListener) and cold starts
 * (getLastNotificationResponseAsync).
 */
export function routeNotificationTap(
  router: INotificationRouter,
  data: Record<string, string> | undefined,
): void {
  const type = data?.type;
  switch (type) {
    case 'sos_alert':
      router.push('/(tabs)/map');
      break;
    case 'friend_request':
      router.push({ pathname: '/friends', params: { tab: 'requests' } });
      break;
    case 'group_invite':
      // Join-request lifecycle pushes ("New Join Request" → admin,
      // approved/declined → requester; see api/src/groups/joinRequests.routes.ts)
      // carry groupId — land on the group so the tap is actionable. A payload
      // carrying a joinCode prefills the code-entry screen instead. Only with
      // neither do we fall back to the bare join screen.
      if (data?.joinCode) {
        router.push({ pathname: '/join', params: { prefillCode: data.joinCode } });
      } else if (data?.groupId) {
        router.push(`/group/${encodeURIComponent(data.groupId)}`);
      } else {
        router.push('/join');
      }
      break;
    case 'group_event':
    // A reminder for an event you said you're going to — same destination as
    // the announcement that created it. It only started reaching devices as a
    // real push when the remind endpoint stopped writing history rows instead
    // of sending; before that its tap could never happen, and `default` would
    // have done nothing if it had.
    case 'event_reminder':
      if (data?.eventId && data?.groupId) {
        router.push({ pathname: '/event/[id]', params: { id: data.eventId, groupId: data.groupId } });
      } else {
        router.push('/(tabs)/convoy');
      }
      break;
    case 'rally_point':
      // Rally point pins render on the map (MapScreen), not the convoy hub.
      router.push('/(tabs)/map');
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

// ---------------------------------------------------------------------------
// Standalone helper — canonical Expo push registration flow
// ---------------------------------------------------------------------------

/**
 * Requests push-notification permissions and returns the Expo push token,
 * or null if running in a simulator / permission denied / any error.
 *
 * Correct ordering (per Expo docs):
 *  1. Bail out in simulator — push tokens are unavailable.
 *  2. Create Android notification channel (required for Android 8+).
 *  3. Check existing permission; request only if not yet granted.
 *  4. Obtain push token with projectId from expo-constants.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    // 1. Push tokens are not available in the simulator / emulator
    if (!Device.isDevice) return null;

    // 2. Android 8+ requires a notification channel or notifications are silent
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }

    // 3. Check permissions before calling getExpoPushTokenAsync — on iOS,
    //    calling getExpoPushTokenAsync without permission crashes the app.
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus: string = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      // User denied — notifications won't arrive but app continues (Req 15.2)
      return null;
    }

    // 4. Fetch the Expo push token. Always pass projectId to support EAS-managed
    //    projects and avoid runtime deprecation warnings.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenResponse.data as string;
  } catch {
    // Non-fatal — notifications won't arrive but the app continues
    return null;
  }
}

/**
 * Re-register this device's Expo push token with the API, but only if push
 * permission has ALREADY been granted. Never prompts — it reads the existing
 * permission status — so it is safe to run unconditionally on every
 * authenticated app start.
 *
 * Registration used to happen exactly once per install, from the in-context
 * permission modal in app/_layout.tsx, behind a `push_permission_asked`
 * AsyncStorage flag that sign-out deliberately does not clear. Three real ways
 * a user ended up with zero `devices` rows and no push notifications at all,
 * permanently:
 *
 *  • Sign out, sign back in. Sign-out DELETEs the token
 *    (AuthService.deregisterPushToken → DELETE /api/v1/devices/:token) and
 *    nothing ever re-created it, because the modal had already been answered.
 *  • A second account signing in on the same phone — never registered at all,
 *    so that account got no pushes even though the phone has permission.
 *  • An Expo/FCM token rotation (restore from backup, app-data clear, a new
 *    APNs token). The server kept pushing to the old token until Expo answered
 *    DeviceNotRegistered, at which point the gateway deleted it — and the new
 *    token was never registered.
 *
 * Idempotent: POST /devices upserts on push_token and reassigns user_id, so
 * running this on every launch just keeps the row fresh.
 */
export async function syncPushTokenIfGranted(): Promise<void> {
  try {
    // Push tokens are unavailable in the simulator / emulator
    if (!Device.isDevice) return;

    // Permission-status read only: never surface the system dialog here, the
    // in-context modal owns the ask.
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!pushToken) return;

    const body = {
      pushToken,
      platform: Platform.OS === 'ios' ? ('ios' as const) : ('android' as const),
    };
    try {
      await apiClient.post('/api/v1/devices', body);
    } catch (err) {
      // Offline at launch: queue the upsert rather than waiting for the next
      // app start. Same idempotent endpoint and same dedupeKey registerToken
      // uses, so a replay can only ever write the newest token once.
      if (isOfflineError(err)) {
        await offlineQueue.enqueue({
          method: 'POST',
          url: '/api/v1/devices',
          body,
          headers: {},
          dedupeKey: 'device-register',
        });
      }
    }
  } catch {
    // Non-fatal — notifications won't arrive but the app continues
  }
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
  private registered = false;

  constructor(
    private readonly tokenProvider: IExpoPushTokenProvider,
    private readonly handler: INotificationHandler,
  ) {}

  /**
   * Register (or refresh) the FCM/APNs push token.
   * Must be called AFTER the user is authenticated so the POST /devices
   * request can be authorised. Call once per session — use a ref guard
   * at the call site to prevent repeated invocations.
   *
   * Correct ordering:
   *  1. Bail out in simulator.
   *  2. Create Android notification channel.
   *  3. Check existing permission; request only if needed.
   *  4. Fetch token with projectId.
   *  5. POST token to backend.
   */
  async registerToken(): Promise<void> {
    try {
      // 1. Push tokens are unavailable in the simulator
      if (!this.tokenProvider.isDevice()) return;

      // 2. Android 8+ requires a channel or notifications are silent
      if (this.tokenProvider.getPlatform() === 'android') {
        // AndroidImportance.MAX === 5
        await this.tokenProvider.setNotificationChannelAsync('default', {
          name: 'Default',
          importance: 5,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF231F7C',
        });
      }

      // 3. Check permissions before getExpoPushTokenAsync (iOS crashes without it)
      const { status: existingStatus } = await this.tokenProvider.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await this.tokenProvider.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') {
        // Permission denied — notifications won't arrive but app continues
        return;
      }

      // 4. Pass projectId to avoid deprecation warnings and support EAS projects
      const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
      const { data: pushToken } = await this.tokenProvider.getExpoPushTokenAsync({ projectId });

      const platform = this.tokenProvider.getPlatform();
      const body = { pushToken, platform };
      try {
        await apiClient.post('/api/v1/devices', body);
        this.registered = true;
      } catch (err) {
        // Offline (no HTTP response): queue the registration for replay so the
        // device still receives pushes without waiting for the next app start.
        // Registration is an idempotent upsert keyed by pushToken and the
        // queue is cleared on sign-out, so replay can never surprise the user.
        // dedupeKey keeps only the newest token if this races a token refresh.
        // Server rejections stay fire-and-forget (replay wouldn't change them).
        if (isOfflineError(err)) {
          await offlineQueue.enqueue({
            method: 'POST',
            url: '/api/v1/devices',
            body,
            headers: {},
            dedupeKey: 'device-register',
          });
        }
      }
    } catch {
      // Non-fatal — notifications won't arrive but app continues
    }
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /** Dispatch a received foreground notification to the handler. */
  handleForeground(category: NotificationCategory, data: Record<string, string>): void {
    this.handler.onForegroundNotification(category, data);
  }

  /** Dispatch a tapped notification to the handler for navigation. */
  handleTap(category: NotificationCategory, data: Record<string, string>): void {
    this.handler.onNotificationTap(category, data);
  }
}
