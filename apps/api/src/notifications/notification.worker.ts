/**
 * Notification Worker — BullMQ queue processor for push notifications.
 * Requirements: 15.1–15.5
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'hazard_alert'
  | 'group_invite'
  | 'arriving_destination'
  | 'group_event'
  | 'rally_point'
  | 'sos_alert'
  | 'gap_alert'
  | 'fuel_suggest'
  | 'friend_request';

export interface NotificationJob {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// FCM/APNs gateway (injectable stub — wire real SDK in production)
// ---------------------------------------------------------------------------

export interface IPushGateway {
  send(token: string, platform: 'ios' | 'android', payload: {
    title: string;
    body: string;
    data?: Record<string, string>;
    priority: 'normal' | 'high';
  }): Promise<void>;
}

export interface IDeviceStore {
  getTokensForUser(userId: string): Promise<Array<{ token: string; platform: 'ios' | 'android' }>>;
}

export interface IPreferenceStore {
  getPreferences(userId: string): Promise<{
    notif_hazard: boolean;
    notif_group_events: boolean;
    notif_friend_requests: boolean;
    notif_navigation: boolean;
  } | null>;
}

type PrefKey = 'notif_hazard' | 'notif_group_events' | 'notif_friend_requests' | 'notif_navigation';

const PREFERENCE_KEY: Record<NotificationType, PrefKey> = {
  hazard_alert:           'notif_hazard',
  gap_alert:              'notif_navigation',
  arriving_destination:   'notif_navigation',
  fuel_suggest:           'notif_navigation',
  group_event:            'notif_group_events',
  group_invite:           'notif_group_events',
  rally_point:            'notif_group_events',
  sos_alert:              'notif_group_events', // always sent — key unused for SOS
  friend_request:         'notif_friend_requests',
} as const;

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

export function createNotificationQueue(connection: IORedis): Queue<NotificationJob> {
  return new Queue<NotificationJob>('notifications', { connection });
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Process one notification job: preference gate → push to all devices →
 * persist to history. Exported so the delivery contract (in particular the
 * data.type stamp the mobile tap router depends on) is unit-testable without
 * a live BullMQ worker.
 */
export async function processNotificationJob(
  jobData: NotificationJob,
  deviceStore: IDeviceStore,
  gateway: IPushGateway,
  preferenceStore: IPreferenceStore,
  db?: Pool,
): Promise<void> {
  const { userId, type, title, body, data } = jobData;

  // SOS alerts always send regardless of user preferences (Req 15.5)
  if (type !== 'sos_alert') {
    const prefs = await preferenceStore.getPreferences(userId);
    if (prefs !== null) {
      const prefKey = PREFERENCE_KEY[type];
      if (!prefs[prefKey]) return; // user opted out of this category
    }
  }

  const devices = await deviceStore.getTokensForUser(userId);
  const priority: 'normal' | 'high' = type === 'sos_alert' ? 'high' : 'normal';

  // The mobile tap handler routes on data.type (see app/_layout.tsx
  // handleNotificationNavigation) — stamp the job type into the push data
  // so tapping a notification actually navigates somewhere.
  const pushData = { ...(data ?? {}), type };

  await Promise.all(
    devices.map((d) =>
      gateway.send(d.token, d.platform, { title, body, data: pushData, priority }),
    ),
  );

  // Persist to notification_history for the in-app notification center
  if (db) {
    try {
      await db.query(
        `INSERT INTO notification_history (user_id, type, title, body, data)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, type, title, body, data ? JSON.stringify(data) : '{}'],
      );
    } catch {
      // non-fatal — don't fail the job if history insert fails
    }
  }
}

export function createNotificationWorker(
  connection: IORedis,
  deviceStore: IDeviceStore,
  gateway: IPushGateway,
  preferenceStore: IPreferenceStore,
  db?: Pool,
): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    'notifications',
    (job: Job<NotificationJob>) =>
      processNotificationJob(job.data, deviceStore, gateway, preferenceStore, db),
    { connection, concurrency: 20 },
  );
}

// ---------------------------------------------------------------------------
// Enqueue helper — SOS bypasses queue and sends inline (Req 15.5)
// ---------------------------------------------------------------------------

export async function enqueueNotification(
  queue: Queue<NotificationJob>,
  job: NotificationJob,
  gateway?: IPushGateway,
  deviceStore?: IDeviceStore,
): Promise<void> {
  if (job.type === 'sos_alert' && gateway && deviceStore) {
    // High-priority SOS: bypass BullMQ queue and deliver directly
    const devices = await deviceStore.getTokensForUser(job.userId);
    await Promise.all(
      devices.map((d) =>
        gateway.send(d.token, d.platform, {
          title: job.title,
          body: job.body,
          // Same contract as the queued path: mobile routes taps on data.type.
          data: { ...(job.data ?? {}), type: job.type },
          priority: 'high',
        }),
      ),
    );
    return;
  }
  await queue.add(job.type, job);
}
