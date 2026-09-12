/**
 * Unit tests for syncPushTokenIfGranted — the every-launch push-token refresh
 * app/_layout.tsx runs for any signed-in user.
 *
 * The in-context permission modal registers the token exactly ONCE per install
 * (its `push_permission_asked` AsyncStorage flag deliberately survives
 * sign-out), so without this refresh a user ended up with no `devices` row and
 * no push notifications at all after: signing out and back in (sign-out DELETEs
 * the token), a second account signing in on the same phone, or an Expo/FCM
 * token rotation. Requirements: 15.1–15.3.
 *
 * Key invariant: it must NEVER prompt. It only re-POSTs a token the user has
 * already granted permission for.
 */

// NotificationService imports expo modules at module level; mock them so the
// registration flow can be driven without a device.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  AndroidImportance: { MAX: 5 },
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('./apiClient', () => ({
  apiClient: { post: jest.fn(), get: jest.fn() },
}));
jest.mock('./OfflineQueueService', () => ({
  offlineQueue: { enqueue: jest.fn() },
  // Real classifier semantics: offline = a request error with no HTTP response.
  isOfflineError: (err: unknown) =>
    (err as { response?: unknown } | null)?.response === undefined,
}));

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { syncPushTokenIfGranted } from './NotificationService';
import { apiClient } from './apiClient';
import { offlineQueue } from './OfflineQueueService';

const mockedNotifications = Notifications as unknown as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
};
const mockedDevice = Device as unknown as { isDevice: boolean };
const mockedPost = apiClient.post as jest.Mock;
const mockedEnqueue = offlineQueue.enqueue as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedDevice.isDevice = true;
  mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
  mockedNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
  mockedNotifications.getExpoPushTokenAsync.mockResolvedValue({
    data: 'ExponentPushToken[rotated]',
  });
  mockedPost.mockResolvedValue({});
  mockedEnqueue.mockResolvedValue('queued-id');
});

describe('syncPushTokenIfGranted', () => {
  it('re-registers the current token when permission is already granted', async () => {
    await syncPushTokenIfGranted();

    expect(mockedPost).toHaveBeenCalledWith('/api/v1/devices', {
      pushToken: 'ExponentPushToken[rotated]',
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
  });

  it('never shows the permission dialog — it only reads the existing status', async () => {
    await syncPushTokenIfGranted();

    expect(mockedNotifications.getPermissionsAsync).toHaveBeenCalled();
    expect(mockedNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does nothing when permission has not been granted', async () => {
    mockedNotifications.getPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await syncPushTokenIfGranted();

    expect(mockedNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('does nothing in the simulator, where push tokens do not exist', async () => {
    mockedDevice.isDevice = false;

    await syncPushTokenIfGranted();

    expect(mockedNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('queues the upsert when the app is offline at launch', async () => {
    mockedPost.mockRejectedValue(Object.assign(new Error('Network Error'), {}));

    await syncPushTokenIfGranted();

    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/api/v1/devices',
        dedupeKey: 'device-register',
      }),
    );
  });

  it('does not queue a server rejection — replaying it would fail identically', async () => {
    mockedPost.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { response: { status: 400 } }),
    );

    await syncPushTokenIfGranted();

    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it('never throws, whatever the token provider does', async () => {
    mockedNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('no token'));

    await expect(syncPushTokenIfGranted()).resolves.toBeUndefined();
  });
});
