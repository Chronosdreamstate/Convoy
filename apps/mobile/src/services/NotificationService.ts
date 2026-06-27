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
      await apiClient.post('/api/v1/devices', { pushToken, platform });
      this.registered = true;
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
