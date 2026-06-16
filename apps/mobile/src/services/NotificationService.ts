/**
 * NotificationService — register device push tokens and handle incoming notifications.
 * Requirements: 15.1–15.5
 */

import { apiClient } from './apiClient';

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
// Injectable interfaces
// ---------------------------------------------------------------------------

export interface IExpoPushTokenProvider {
  requestPermissionsAsync(): Promise<{ status: string }>;
  getExpoPushTokenAsync(): Promise<{ data: string }>;
  getPlatform(): 'ios' | 'android';
}

export interface INotificationHandler {
  onForegroundNotification(category: NotificationCategory, data: Record<string, string>): void;
  onNotificationTap(category: NotificationCategory, data: Record<string, string>): void;
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
   * Called on first post-sign-in launch and each subsequent launch.
   * On iOS, Expo requires explicit permission before getExpoPushTokenAsync() works.
   */
  async registerToken(): Promise<void> {
    try {
      const { status } = await this.tokenProvider.requestPermissionsAsync();
      if (status !== 'granted') {
        // Permission denied — notifications won't arrive but app continues (Req 15.2)
        return;
      }
      const { data: pushToken } = await this.tokenProvider.getExpoPushTokenAsync();
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
